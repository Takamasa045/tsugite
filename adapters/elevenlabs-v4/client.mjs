import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
// A literal '*' in this repository path breaks the SDK's wildcard package exports.
import { StreamableHTTPClientTransport } from "../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
import { ElevenOAuthError, OAUTH, keychainAccessToken, elevenCredentialBinding } from "./oauth.mjs";
import { actualNarrationBilling, assertNarrationQuote, billingDigest, makeNarrationQuote, narrationRequestDigest, quoteBilling } from "../billing-contract.mjs";
import { authorizeRunSubmission, readBoundedRunJson, readRunBillingContext } from "../billing-store.mjs";
import { ProcessLockError, withProcessLock } from "../process-lock.mjs";
import { RECEIPT_LIMITS, sealReceipt, validateNarrationReceipt } from "../receipt-protocol.mjs";
import { durableReceiptWrite, initialGeneratedReceipt, loadReceiptHistory, openReceiptJournal, receiptWriter } from "./receipts.mjs";
import { claimProjectSubmission, existingProjectIndex, updateProjectSubmission } from "./submission-index.mjs";
import { SubmissionDurabilityError, assertSubmissionDurabilitySupported, createDurableSubmissionJournal, syncDurableDirectory } from "./durability.mjs";

const MCP_ENDPOINT = "https://api.us.elevenlabs.io/v1/mcp";
const MODELS = new Set(["eleven_v4", "eleven_v4_turbo"]);
const MAX_TEXT_CHARACTERS = 2_000;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_VOICE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SPEECH_TOOLS = ["text_to_speech", "generate_speech", "create_speech"];

export class ElevenV4Error extends Error {
  constructor(code, exitCode) {
    super(code);
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function validateElevenV4Request(request) {
  if (!request || typeof request !== "object" || !SAFE_ID.test(request.id ?? "") || request.id.length > 128) {
    throw new ElevenV4Error("invalid_request_id", 40);
  }
  if (request.operation !== "voice" || !MODELS.has(request.model)) {
    throw new ElevenV4Error("unsupported_operation_or_model", 40);
  }
  if (request.output_kind !== undefined && request.output_kind !== "audio") {
    throw new ElevenV4Error("unsupported_output_kind", 40);
  }
  if (request.audio_role !== undefined && request.audio_role !== "narration") {
    throw new ElevenV4Error("unsupported_audio_role", 40);
  }
  if (typeof request.prompt !== "string" || !request.prompt.trim()
    || Array.from(request.prompt).length > MAX_TEXT_CHARACTERS) {
    throw new ElevenV4Error("invalid_text_length", 40);
  }
  const params = request.params ?? {};
  if (!params || typeof params !== "object" || Array.isArray(params)
    || Object.keys(params).some((name) => name !== "voice_id")
    || typeof params.voice_id !== "string" || !SAFE_VOICE_ID.test(params.voice_id)) {
    throw new ElevenV4Error("voice_id_required_or_unsupported_params", 40);
  }
  for (const field of ["duration", "aspect", "seed", "mode", "input_mode", "first_frame", "last_frame",
    "reference_images", "input_images", "input_video", "input_videos", "input_audios"]) {
    if (request[field] !== undefined) throw new ElevenV4Error("unsupported_input_field", 40);
  }
  return { id: request.id, text: request.prompt, voiceId: params.voice_id, model: request.model };
}

function selectLegacySpeechTool(tools, model) {
  for (const name of SPEECH_TOOLS) {
    const tool = tools?.find((candidate) => candidate.name === name);
    const schema = tool?.inputSchema;
    const properties = schema?.properties;
    if (!properties || schema.type !== "object") continue;
    if (!["text", "voice_id", "model_id"].every((field) => properties[field]?.type === "string")) continue;
    if ((schema.required ?? []).some((field) => !["text", "voice_id", "model_id"].includes(field))) continue;
    const modelSchema = properties.model_id;
    if (Array.isArray(modelSchema.enum)) {
      if (!modelSchema.enum.includes(model)) continue;
    } else if (modelSchema.const !== model) {
      continue;
    }
    if (modelSchema.const !== undefined && modelSchema.const !== model) continue;
    return name;
  }
  throw new ElevenV4Error("mcp_v4_speech_tool_unavailable", 20);
}

function accepts(schema, value) {
  return schema && (schema.const === undefined || schema.const === value)
    && (!Array.isArray(schema.enum) || schema.enum.includes(value))
    && (typeof value !== "number" || (
      (schema.minimum === undefined || value >= schema.minimum)
      && (schema.maximum === undefined || value <= schema.maximum)
      && (schema.exclusiveMinimum === undefined || value > schema.exclusiveMinimum)
      && (schema.exclusiveMaximum === undefined || value < schema.exclusiveMaximum)
    ));
}

function matchesTool(tool, fields) {
  const schema = tool?.inputSchema;
  return schema?.type === "object"
    && Object.entries(fields).every(([name, type]) => schema.properties?.[name]?.type === type
      || (type === "number" && schema.properties?.[name]?.type === "integer"))
    && (schema.required ?? []).every((name) => name in fields);
}

function selectSpeechRoute(tools, model) {
  const speech = tools?.find((tool) => tool.name === "creative_generate_speech");
  const status = tools?.find((tool) => tool.name === "creative_get_flow_run_status");
  const modelSchema = speech?.inputSchema?.properties?.model_id;
  if (matchesTool(speech, { context: "string", prompt: "string", voice_id: "string", model_id: "string",
    generations_count: "number", estimate_only: "boolean" })
    && (Array.isArray(modelSchema.enum) || modelSchema.const !== undefined)
    && accepts(modelSchema, model)
    && accepts(speech.inputSchema.properties.generations_count, 1)
    && accepts(speech.inputSchema.properties.estimate_only, false)
    && matchesTool(status, { context: "string", flow_id: "string", session_ids: "array" })
    && status.inputSchema.properties.session_ids.items?.type === "string") {
    return { name: speech.name, kind: "creative", statusTool: status.name };
  }
  return { name: selectLegacySpeechTool(tools, model), kind: "legacy" };
}
function speechRouteDigest(tools, route) {
  return billingDigest({ speech: tools.find((tool) => tool.name === route.name)?.inputSchema,
    status: tools.find((tool) => tool.name === route.statusTool)?.inputSchema, tool: route.name });
}

export function selectElevenV4SpeechTool(tools, model) {
  return selectSpeechRoute(tools, model).name;
}

// Discovery is read-only: do not call a generation/estimate tool from this path.
export function inspectElevenV4Capabilities(tools, model) {
  if (!MODELS.has(model)) throw new ElevenV4Error("unsupported_operation_or_model", 40);
  const speechTools = (tools ?? []).filter((tool) =>
    [...SPEECH_TOOLS, "creative_generate_speech"].includes(tool.name)
  ).map((tool) => {
    const modelSchema = tool.inputSchema?.properties?.model_id;
    const models = Array.isArray(modelSchema?.enum)
      ? modelSchema.enum.filter((value) => typeof value === "string")
      : typeof modelSchema?.const === "string" ? [modelSchema.const] : [];
    return {
      name: tool.name,
      text_parameter: tool.inputSchema?.properties?.text ? "text"
        : tool.inputSchema?.properties?.prompt ? "prompt" : null,
      models
    };
  });
  let selected;
  try { selected = selectElevenV4SpeechTool(tools, model); }
  catch (error) { if (!(error instanceof ElevenV4Error)) throw error; }
  return {
    requested_model: model,
    requested_model_declared: speechTools.some((tool) => tool.models.includes(model)),
    adapter_compatible: Boolean(selected),
    selected_tool: selected ?? null,
    speech_tools: speechTools,
    generated: false
  };
}

async function listSpeechTools(client) {
  const tools = [];
  const cursors = new Set();
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 20_000 });
    if (!Array.isArray(page?.tools)) throw new ElevenV4Error("mcp_discovery_failed", 20);
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor !== undefined && (typeof cursor !== "string" || !cursor
      || cursors.has(cursor) || cursors.size >= 100)) {
      throw new ElevenV4Error("mcp_discovery_failed", 20);
    }
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return tools;
}

async function accessToken(options) {
  const token = (options.environment ?? process.env).ELEVENLABS_MCP_ACCESS_TOKEN;
  if (!options.client && (typeof token !== "string" || !token.trim())) {
    throw new ElevenV4Error("credential_missing", 30);
  }
  if (!options.client && token === OAUTH.selector) {
    try { return await keychainAccessToken(options.authOptions); }
    catch (error) {
      if (error instanceof ElevenOAuthError) throw new ElevenV4Error(error.code, error.exitCode);
      throw new ElevenV4Error("oauth_credential_unavailable", 30);
    }
  }
  return token;
}

export async function probeElevenV4(model, options = {}) {
  if (!MODELS.has(model)) throw new ElevenV4Error("unsupported_operation_or_model", 40);
  const token = await accessToken(options);
  let client;
  try {
    client = options.client ?? await (options.connectMcp ?? connectMcp)(token);
    return inspectElevenV4Capabilities(await listSpeechTools(client), model);
  } catch (error) {
    if (error instanceof ElevenV4Error) throw error;
    throw new ElevenV4Error("mcp_discovery_failed", 20);
  } finally {
    if (!options.client) await client?.close().catch(() => undefined);
  }
}

// Explicit transfer operation only. Ordinary discovery/planning never calls it.
export async function quoteElevenV4(payload, options = {}) {
  const request = validateElevenV4Request(payload?.request);
  if (payload?.approve_transfer !== true) throw new ElevenV4Error("billing_transfer_approval_required", 40);
  const token = await accessToken(options);
  const binding = await (options.connectionBinding ?? (() => elevenCredentialBinding({ ...options.authOptions, environment: options.environment })))();
  const client = options.client ?? await (options.connectMcp ?? connectMcp)(token);
  try {
    const tools = await listSpeechTools(client), route = selectSpeechRoute(tools, request.model);
    const tool = tools.find((entry) => entry.name === route.name);
    if (route.kind !== "creative" || !accepts(tool.inputSchema.properties.estimate_only, true)) throw new ElevenV4Error("billing_quote_unsupported", 20);
    const response = await client.callTool({ name: route.name, arguments: {
      context: "Estimate only one Tsugite narration after explicit transfer approval. Do not generate.",
      prompt: request.text, voice_id: request.voiceId, model_id: request.model, generations_count: 1, estimate_only: true
    } }, undefined, { timeout: 60_000 });
    const body = resultBody(response);
    if (body.session_ids?.length || body.generations?.length || body.summary?.generations_started) throw new ElevenV4Error("billing_quote_invalid", 20);
    try { return makeNarrationQuote(payload.request, binding, body.estimate, (options.now ?? Date.now)(), speechRouteDigest(tools, route)); }
    catch { throw new ElevenV4Error("billing_quote_invalid", 20); }
  } finally { if (!options.client) await client.close().catch(() => undefined); }
}

async function connectMcp(token) {
  const client = new Client({ name: "tsugite-elevenlabs-v4", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_ENDPOINT), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  await client.connect(transport);
  return client;
}

function decodeAudio(data) {
  if (typeof data !== "string" || data.length > Math.ceil(MAX_AUDIO_BYTES * 4 / 3) + 8
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw new ElevenV4Error("mcp_audio_invalid", 20);
  }
  return Buffer.from(data, "base64");
}

function parseDownloadUrl(text) {
  if (typeof text !== "string" || text.length > 8192) return undefined;
  let value = text;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      value = parsed.audio_url ?? parsed.download_url ?? parsed.url;
    }
  } catch { /* Plain text result. */ }
  if (typeof value !== "string") return undefined;
  return value.match(/https:\/\/[^\s"<>]+/)?.[0];
}

async function readMcpAudio(result, fetchImpl) {
  if (result?.isError) throw new ElevenV4Error("mcp_generation_failed", 20);
  const content = [
    ...(result?.content ?? []),
    ...(result?.structuredContent ? [{ type: "text", text: JSON.stringify(result.structuredContent) }] : [])
  ];
  for (const item of content) {
    if (item?.type === "audio" && item.mimeType === "audio/mpeg") return decodeAudio(item.data);
    if (item?.type === "resource" && item.resource?.mimeType === "audio/mpeg") {
      return decodeAudio(item.resource.blob);
    }
    if (item?.type !== "text") continue;
    const link = parseDownloadUrl(item.text);
    if (!link) continue;
    let url;
    try { url = new URL(link); } catch { throw new ElevenV4Error("mcp_audio_url_invalid", 20); }
    const providerStorage = url.hostname === "storage.googleapis.com"
      && /^\/xi-backend\/database\/workspace\/[A-Za-z0-9_-]+\/content_generation\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/content\.mp3$/.test(url.pathname);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
      || !(providerStorage || url.hostname === "elevenlabs.io" || url.hostname.endsWith(".elevenlabs.io"))) {
      throw new ElevenV4Error("mcp_audio_url_untrusted", 20);
    }
    let response;
    try {
      response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    } catch { throw new ElevenV4Error("mcp_audio_download_failed", 20); }
    if (!response.ok || !["audio/mpeg", "application/octet-stream"].includes(
      response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    )) throw new ElevenV4Error("mcp_audio_download_failed", 20);
    if (Number(response.headers.get("content-length")) > MAX_AUDIO_BYTES) {
      throw new ElevenV4Error("mcp_audio_too_large", 20);
    }
    if (!response.body) throw new ElevenV4Error("mcp_audio_invalid", 20);
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > MAX_AUDIO_BYTES) throw new ElevenV4Error("mcp_audio_too_large", 20);
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) {
      if (error instanceof ElevenV4Error) throw error;
      throw new ElevenV4Error("mcp_audio_download_failed", 20);
    }
    return Buffer.concat(chunks);
  }
  throw new ElevenV4Error("mcp_audio_missing", 20);
}

async function prepareDestination(runDir, request, options = {}) {
  if (typeof runDir !== "string" || !isAbsolute(runDir)) {
    throw new ElevenV4Error("invalid_run_directory", 40);
  }
  const root = await realpath(runDir).catch(() => {
    throw new ElevenV4Error("invalid_run_directory", 40);
  });
  const outputDir = join(root, "assets", "elevenlabs-v4");
  for (const path of [join(root, "assets"), outputDir]) {
    try { await (options.filesystem?.mkdir ?? mkdir)(path, { mode: 0o700 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new ElevenV4Error("unsafe_output_directory", 40);
  }
  const realOutputDir = await realpath(outputDir);
  const fromRoot = relative(root, realOutputDir);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new ElevenV4Error("unsafe_output_directory", 40);
  }
  const destination = join(realOutputDir, `${request.id}.mp3`);
  if (await lstat(destination).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false;
    throw new ElevenV4Error("output_inspection_failed", 20);
  })) {
    if (!options.allowExistingOutput) throw new ElevenV4Error("output_already_exists", 40);
  }

  return { destination, realOutputDir };
}

function resultBody(result) {
  if (result?.isError) throw new ElevenV4Error("mcp_generation_failed", 20);
  let body = result?.structuredContent;
  if (!body) {
    for (const item of result?.content ?? []) {
      if (item?.type !== "text" || typeof item.text !== "string" || item.text.length > 1_000_000) continue;
      try { body = JSON.parse(item.text); break; } catch { /* Not a structured result. */ }
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ElevenV4Error("mcp_generation_result_invalid", 20);
  }
  if (body.error || body.error_message || body.has_failures
    || body.results?.some((item) => item.success === false)) {
    throw new ElevenV4Error("mcp_generation_failed", 20);
  }
  return body;
}

function creativeIdentity(body) {
  if (typeof body.flow_id !== "string" || !SAFE_VOICE_ID.test(body.flow_id) || !Array.isArray(body.session_ids)
    || body.session_ids.length !== 1 || !body.session_ids.every((id) => typeof id === "string" && SAFE_VOICE_ID.test(id))) {
    throw new ElevenV4Error("mcp_generation_identity_invalid", 20);
  }
  return { flow_id: body.flow_id, session_ids: body.session_ids };
}

async function awaitCreativeResult(initial, client, route, options, writer) {
  let body = resultBody(initial);
  const identity = creativeIdentity(body);
  if (writer.current.job === null) await writer.publish({ state: "accepted", job: identity });
  else if (billingDigest(writer.current.job) !== billingDigest(identity)) throw new ElevenV4Error("mcp_generation_identity_invalid", 20);
  for (;;) {
    if ((body.flow_id !== undefined && body.flow_id !== identity.flow_id)
      || (body.session_ids !== undefined && JSON.stringify(body.session_ids) !== JSON.stringify(identity.session_ids))) {
      throw new ElevenV4Error("mcp_generation_identity_invalid", 20);
    }
    if (body.all_completed === true) return { ...body, ...identity };
    const seconds = Number.isFinite(body.poll_after_seconds) ? body.poll_after_seconds : 3;
    const ms = Math.min(10, Math.max(1, seconds)) * 1000;
    const budget = writer.current.budgets;
    if (budget.polls_used >= RECEIPT_LIMITS.polls || budget.wait_ms_used + ms > RECEIPT_LIMITS.wait_ms) throw new ElevenV4Error("receipt_poll_budget_exhausted", 20);
    await writer.publish({ budgets: { ...budget, polls_used: budget.polls_used + 1, wait_ms_used: budget.wait_ms_used + ms } });
    await (options.sleep ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay))))(ms);
    let status;
    try {
      status = await client.callTool({
        name: route.statusTool,
        arguments: { context: "Wait for the approved Tsugite narration without starting another generation.", ...identity }
      }, undefined, { timeout: 20_000 });
    } catch { throw new ElevenV4Error("mcp_status_failed", 20); }
    body = resultBody(status);
  }
}

function creativeAudio(body, request) {
  if (body.all_completed !== true || !Array.isArray(body.generations) || body.generations.length !== 1) {
    throw new ElevenV4Error("mcp_generation_result_invalid", 20);
  }
  const generation = body.generations[0];
  const media = body.media?.find((item) => item.generation_id === generation.id && item.kind === "audio");
  if (typeof generation.id !== "string" || !SAFE_VOICE_ID.test(generation.id)
    || generation.status !== "completed" || generation.model_id !== request.model
    || generation.prompt !== request.text || media?.voice?.voice_id !== request.voiceId
    || typeof generation.content_url !== "string") {
    throw new ElevenV4Error("mcp_generation_request_mismatch", 20);
  }
  const price = generation.price;
  const billing = actualNarrationBilling(price, { flow_id: body.flow_id, session_ids: body.session_ids, generation_id: generation.id }, 1);
  const measured = billing.actual.status === "measured";
  return {
    result: { structuredContent: { audio_url: generation.content_url } },
    credits: measured ? Number(billing.actual.credits) : 0,
    metadata: {
      provider_billing: measured ? "measured" : "unmeasured",
      flow_id: body.flow_id, session_ids: body.session_ids, generation_id: generation.id,
      ...(billing.actual.money ? { price_cents: price.price_cents, currency: billing.actual.money.currency } : {})
    },
    billing
  };
}

function mp3Header(audio) {
  return audio.length >= 3 && audio.length <= MAX_AUDIO_BYTES && (audio.subarray(0, 3).toString("ascii") === "ID3" || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0));
}
async function inspectAudioFile(path, options) {
  let duration;
  if (options.inspectAudio) duration = (await options.inspectAudio(path))?.duration_seconds;
  else {
    const result = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name:format=duration", "-of", "json", path],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 100_000 });
    try {
      if (result.error || result.status !== 0) throw new Error();
      const body = JSON.parse(result.stdout);
      if (body.streams?.[0]?.codec_name !== "mp3") throw new Error();
      duration = Number(body.format?.duration);
    } catch { throw new ElevenV4Error("output_inspection_failed", 20); }
  }
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new ElevenV4Error("output_inspection_failed", 20);
  return duration;
}
async function verifyReceiptAsset(path, asset, options) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error?.code === "ENOENT") return false; throw new ElevenV4Error("receipt_asset_invalid", 20); }
  if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.byte_size || info.size > MAX_AUDIO_BYTES) throw new ElevenV4Error("receipt_asset_mismatch", 20);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let audio;
  try {
    const actual = await handle.stat();
    if (actual.ino !== info.ino || actual.dev !== info.dev || actual.size !== info.size) throw new ElevenV4Error("receipt_asset_mismatch", 20);
    audio = await handle.readFile();
  } finally { await handle.close(); }
  if (audio.length !== asset.byte_size || !mp3Header(audio) || createHash("sha256").update(audio).digest("hex") !== asset.sha256) throw new ElevenV4Error("receipt_asset_mismatch", 20);
  await inspectAudioFile(path, options);
  return true;
}
function narrationOutput(request, paths, billing, resumed = false, receipt) {
  const evidence = structuredClone(billing.billing);
  if (resumed) evidence.operation.submission_count = 0;
  return {
    request_id: request.id, credits: billing.credits, clips: [], images: [],
    audio: [{ id: request.id, src: paths.destination, role: "narration", start: 0 }], billing: evidence,
    metadata: { provider: "elevenlabs", model: request.model, transport: "mcp", ...billing.metadata,
      ...(resumed ? { source: "resumed-existing-generation" } : {}), ...(receipt ? { receipt_digest: receipt.digest } : {}) }
  };
}
async function pinResult(request, paths, result, options, billing = { credits: 0, metadata: { provider_billing: "unmeasured" }, billing: actualNarrationBilling(undefined, null, 1) }, writer) {
  const audio = await readMcpAudio(result, options.fetchImpl ?? fetch);
  if (!mp3Header(audio)) throw new ElevenV4Error("mcp_audio_invalid", 20);
  const temporaryName = `.${request.id}.${randomUUID()}.tmp`, temporary = join(paths.realOutputDir, temporaryName);
  const filesystem = { open, link, unlink, ...options.filesystem };
  try {
    const handle = await filesystem.open(temporary, "wx", 0o600);
    try { await handle.writeFile(audio); await handle.sync(); } finally { await handle.close(); }
    const duration = await inspectAudioFile(temporary, options);
    const candidate = { relative_path: `${request.id}.mp3`, temporary_name: temporaryName,
      sha256: createHash("sha256").update(audio).digest("hex"), byte_size: audio.length, duration_seconds: duration };
    if (writer) {
      const saved = writer.current.asset;
      if (saved && (saved.sha256 !== candidate.sha256 || saved.byte_size !== candidate.byte_size)) throw new ElevenV4Error("receipt_asset_mismatch", 20);
      if (!saved) await writer.publish({ asset: candidate });
      await options.onPinStage?.("candidate");
    }
    try { await filesystem.link(temporary, paths.destination); }
    catch (error) {
      if (error?.code !== "EEXIST" || !writer?.current.asset || !await verifyReceiptAsset(paths.destination, writer.current.asset, options)) throw new ElevenV4Error("output_write_failed", 20);
    }
    await syncDurableDirectory(paths.realOutputDir, options);
    await options.onPinStage?.("linked");
    if (writer) await writer.publish({ state: "pinned" });
    return narrationOutput(request, paths, billing, false, writer?.current);
  } catch (error) {
    if (error instanceof ElevenV4Error) throw error;
    throw new ElevenV4Error("output_write_failed", 20);
  } finally { await filesystem.unlink(temporary).catch(() => undefined); }
}
async function downloadAndPin(request, paths, result, options, billing, writer) {
  const budget = writer.current.budgets;
  if (budget.downloads_used >= RECEIPT_LIMITS.downloads) throw new ElevenV4Error("receipt_download_budget_exhausted", 20);
  await writer.publish({ budgets: { ...budget, downloads_used: budget.downloads_used + 1 } });
  return pinResult(request, paths, result, options, billing, writer);
}

// Reuse a completed result; this entry point cannot call MCP or generate again.
export async function importElevenV4Result(payload, options = {}) {
  const request = validateElevenV4Request(payload?.request);
  const paths = await prepareDestination(payload?.run_dir, request, { ...options, allowExistingOutput: true });
  return withProcessLock(paths.realOutputDir, `${request.id}.recovery.lock`, async () => {
    const prior = await loadReceiptHistory(paths.realOutputDir, request);
    if (prior) {
      if (prior.source !== "imported") throw new ElevenV4Error("receipt_approval_mismatch", 40);
      // Import never uses MCP. Reuse is limited to a locally proven pinned asset.
      const journal = await openReceiptJournal(paths.realOutputDir, request.id);
      const writer = receiptWriter(paths.realOutputDir, request, journal, prior, options);
      try {
        if (!await reuseCandidate(paths, writer, options)) throw new ElevenV4Error("receipt_asset_missing", 20);
        if (writer.current.state !== "pinned") await writer.publish({ state: "pinned" });
        return outputFromReceipt(request, paths, writer.current);
      } finally { await journal.close(); }
    }
    const body = resultBody(payload?.result), job = creativeIdentity(body), billing = creativeAudio(body, request);
    billing.metadata.source = "imported-existing-generation"; billing.billing.operation.submission_count = 0;
    const initial = sealReceipt({ schema_version: 1, kind: "tsugite.narration-receipt", source: "imported", transport_kind: "creative",
      request_id: request.id, request_digest: narrationRequestDigest(payload.request), run_id: payload.run_id ?? "imported",
      gate_approval_digest: null, billing_approval_digest: null, quote: null, state: "succeeded", job,
      budgets: { polls_used: 0, wait_ms_used: 0, refreshes_used: 0, downloads_used: 0 }, billing: billing.billing,
      asset: null, result: { generation_id: body.generations[0].id, model: request.model, voice_id: request.voiceId },
      sequence: 0, previous_digest: null, updated_at: new Date().toISOString() });
    validateNarrationReceipt(initial, payload.request);
    const journal = await createDurableSubmissionJournal(paths.realOutputDir, request.id, { schema_version: 2, phase: "imported", receipt: initial }, options);
    try {
      await durableReceiptWrite(paths.realOutputDir, request.id, initial, options);
      const writer = receiptWriter(paths.realOutputDir, request, journal, initial, options);
      return await downloadAndPin(request, paths, billing.result, options, billing, writer);
    } finally { await journal.close(); }
  }, options.lockOptions);
}

export async function generateElevenV4(payload, options = {}) {
  return processNarrationRun(payload, options);
}

export async function resumeElevenV4(payload, options = {}) {
  return processNarrationRun(payload, { ...options, resumeOnly: true });
}

async function processNarrationRun(payload, options) {
  const request = validateElevenV4Request(payload?.request);
  try { assertSubmissionDurabilitySupported(options.platform); }
  catch (error) { throw new ElevenV4Error(error.code, 20); }
  let paths;
  try { paths = await prepareDestination(payload?.run_dir, request, { ...options, allowExistingOutput: true }); }
  catch (error) {
    if (error instanceof ElevenV4Error) throw error;
    throw new ElevenV4Error("submission_not_durable", 20);
  }
  try {
    return await withProcessLock(paths.realOutputDir, `${request.id}.recovery.lock`, async () => {
      const receipt = await loadReceiptHistory(paths.realOutputDir, request, options);
      if (receipt) return resumeRecordedElevenV4(payload, request, paths, receipt, options);
      if (options.resumeOnly) throw new ElevenV4Error("resume_no_submission", 40);
      try { await lstat(paths.destination); throw new ElevenV4Error("output_already_exists", 40); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      try { await lstat(join(paths.realOutputDir, `${request.id}.receipt.json`)); throw new ElevenV4Error("receipt_unknown", 20); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      return submitNewElevenV4(payload, request, paths, options);
    }, options.lockOptions);
  } catch (error) {
    if (error instanceof ElevenV4Error) throw error;
    if (error instanceof ProcessLockError) throw new ElevenV4Error("submission_busy", 20);
    throw new ElevenV4Error(/^(receipt|project|billing)_[a-z_]+$/.test(error?.message ?? "") ? error.message : "receipt_unknown", 20);
  }
}

async function reuseCandidate(paths, writer, options) {
  const asset = writer.current.asset;
  if (!asset) return false;
  if (await verifyReceiptAsset(paths.destination, asset, options)) return true;
  const temporary = join(paths.realOutputDir, asset.temporary_name);
  if (!await verifyReceiptAsset(temporary, asset, options)) return false;
  try { await link(temporary, paths.destination); }
  catch (error) { if (error?.code !== "EEXIST" || !await verifyReceiptAsset(paths.destination, asset, options)) throw new ElevenV4Error("receipt_asset_mismatch", 20); }
  await syncDurableDirectory(paths.realOutputDir, options);
  await unlink(temporary).catch(() => undefined);
  return true;
}
function outputFromReceipt(request, paths, receipt) {
  const billing = { credits: receipt.billing.actual.credits === null ? 0 : Number(receipt.billing.actual.credits), billing: receipt.billing,
    metadata: { provider_billing: receipt.billing.actual.status, ...(receipt.job ?? {}), ...(receipt.result ? { generation_id: receipt.result.generation_id } : {}) } };
  return narrationOutput(request, paths, billing, true, receipt);
}
async function resumeRecordedElevenV4(payload, request, paths, receipt, options) {
  validateNarrationReceipt(receipt, request);
  if (receipt.run_id !== payload.run_id) throw new ElevenV4Error("receipt_approval_mismatch", 40);
  if (options.authorizeRecovery) await options.authorizeRecovery(receipt);
  else if (receipt.source === "generated") {
    const state = await readBoundedRunJson(payload.run_dir, "state.json"), gate = state.gates?.gate_1;
    if (state.run_id !== payload.run_id || gate?.status !== "approved" || gate.approved_input_digest !== receipt.gate_approval_digest
      || gate.billing_approval_digest !== receipt.billing_approval_digest) throw new ElevenV4Error("receipt_approval_mismatch", 40);
  }
  if (receipt.state === "submitting") throw new ElevenV4Error("receipt_unknown", 20);
  if (receipt.state === "failed") throw new ElevenV4Error("mcp_generation_failed", 20);
  let index;
  if (receipt.project_context_digest) {
    const context = await readRunBillingContext(payload.run_dir);
    if (context.digest !== receipt.project_context_digest) throw new ElevenV4Error("receipt_approval_mismatch", 40);
    index = await existingProjectIndex(payload, receipt, context.context, options);
  }
  const journal = await openReceiptJournal(paths.realOutputDir, request.id);
  let client;
  const ownsClient = !options.client;
  const writer = receiptWriter(paths.realOutputDir, request, journal, receipt, {
    ...options, afterReceiptPersist: (next) => updateProjectSubmission(index, next, options)
  });
  try {
    // An orphan is adopted only after matching the durable candidate proof.
    if (await reuseCandidate(paths, writer, options)) {
      if (writer.current.state !== "pinned") await writer.publish({ state: "pinned" });
      else await updateProjectSubmission(index, writer.current, options);
      return outputFromReceipt(request, paths, writer.current);
    }
    if (writer.current.transport_kind !== "creative" || !writer.current.job) throw new ElevenV4Error("receipt_asset_missing", 20);
    if (writer.current.budgets.downloads_used >= RECEIPT_LIMITS.downloads) throw new ElevenV4Error("receipt_download_budget_exhausted", 20);
    const token = await accessToken(options);
    client = options.client ?? await (options.connectMcp ?? connectMcp)(token);
    const tools = await listSpeechTools(client), status = tools.find((tool) => tool.name === "creative_get_flow_run_status");
    if (!matchesTool(status, { context: "string", flow_id: "string", session_ids: "array" })
      || status.inputSchema.properties.session_ids.items?.type !== "string") throw new ElevenV4Error("mcp_status_tool_unavailable", 20);
    let body;
    if (writer.current.state === "accepted") {
      body = await awaitCreativeResult({ structuredContent: { ...writer.current.job, all_completed: false, poll_after_seconds: 1 } },
        client, { statusTool: status.name }, options, writer);
    } else {
      const budget = writer.current.budgets;
      if (budget.refreshes_used >= RECEIPT_LIMITS.refreshes) throw new ElevenV4Error("receipt_refresh_budget_exhausted", 20);
      await writer.publish({ budgets: { ...budget, refreshes_used: budget.refreshes_used + 1 } });
      let response;
      try { response = await client.callTool({ name: status.name, arguments: {
        context: "Refresh the download for the same accepted narration. Do not generate.", ...writer.current.job
      } }, undefined, { timeout: 20_000 }); }
      catch { throw new ElevenV4Error("mcp_status_failed", 20); }
      body = resultBody(response);
      if (billingDigest(creativeIdentity(body)) !== billingDigest(writer.current.job)) throw new ElevenV4Error("mcp_generation_identity_invalid", 20);
    }
    const billing = creativeAudio(body, request);
    if (writer.current.result && billing.metadata.generation_id !== writer.current.result.generation_id) throw new ElevenV4Error("mcp_generation_identity_invalid", 20);
    billing.billing.estimate = writer.current.billing.estimate;
    billing.billing.operation.submission_count = writer.current.billing.operation.submission_count;
    const previous = writer.current.billing.actual, next = billing.billing.actual;
    if ((previous.credits !== null && previous.credits !== next.credits)
      || (previous.money !== null && billingDigest(previous.money) !== billingDigest(next.money))
      || (previous.source_generation_ref !== null && previous.source_generation_ref !== next.source_generation_ref)) throw new ElevenV4Error("receipt_billing_mismatch", 20);
    await writer.publish({ state: writer.current.state === "pinned" ? "pinned" : "succeeded", billing: billing.billing,
      result: { generation_id: body.generations[0].id, model: request.model, voice_id: request.voiceId } });
    await downloadAndPin(request, paths, billing.result, options, billing, writer);
    return outputFromReceipt(request, paths, writer.current);
  } catch (error) {
    if (error?.code === "mcp_generation_failed" && writer.current.state === "accepted") await writer.publish({ state: "failed" });
    if (error instanceof ElevenV4Error) throw error;
    throw new ElevenV4Error(/^receipt_[a-z_]+$/.test(error?.message ?? "") ? error.message : "receipt_unknown", 20);
  } finally {
    await journal.close().catch(() => undefined);
    if (ownsClient) await client?.close().catch(() => undefined);
  }
}

async function submitNewElevenV4(payload, request, paths, options) {
  const token = await accessToken(options);
  let client;
  let journal;
  let writer;
  let index;
  let submitted = false;
  const ownsClient = !options.client;
  try {
    client = options.client ?? await (options.connectMcp ?? connectMcp)(token);
    const tools = await listSpeechTools(client), route = selectSpeechRoute(tools, request.model);
    let permit;
    try {
      permit = await (options.authorizeSubmission ?? (async () => {
        const binding = await elevenCredentialBinding({ ...options.authOptions, environment: options.environment });
        return authorizeRunSubmission(payload, binding, (options.now ?? Date.now)());
      }))();
      if (!permit?.quote || !/^[a-f0-9]{64}$/.test(permit.billing_approval_digest ?? "")
        || !/^[a-f0-9]{64}$/.test(permit.gate_approval_digest ?? "")) throw new Error("billing_gate_required");
      if (!options.authorizeSubmission && permit.quote.tool_contract_digest !== speechRouteDigest(tools, route)) throw new Error("billing_connection_changed");
    } catch (error) {
      throw new ElevenV4Error(/^billing_[a-z_]+$/.test(error?.message ?? "") ? error.message : "billing_quote_required", 40);
    }
    if (!options.authorizeSubmission) index = await claimProjectSubmission(payload, permit, options);
    const initial = initialGeneratedReceipt(payload, permit, route);
    validateNarrationReceipt(initial, request);
    try {
      journal = await createDurableSubmissionJournal(paths.realOutputDir, request.id,
        { phase: "submitting", model: request.model, tool: route.name,
          schema_version: 2, receipt: initial, request_digest: narrationRequestDigest(payload.request),
          operation: { submission_count: 1 }, liability_state: "unresolved",
          billing_approval_digest: permit.billing_approval_digest, gate_approval_digest: permit.gate_approval_digest,
          quote_id: permit.quote.quote_id, quote: permit.quote }, options);
    } catch (error) {
      if (error instanceof SubmissionDurabilityError) {
        throw new ElevenV4Error(error.code, error.code === "submission_already_exists_or_unwritable" ? 40 : 20);
      }
      throw new ElevenV4Error("submission_not_durable", 20);
    }
    await durableReceiptWrite(paths.realOutputDir, request.id, initial, options);
    writer = receiptWriter(paths.realOutputDir, request, journal, initial, {
      ...options, afterReceiptPersist: (receipt) => updateProjectSubmission(index, receipt, options)
    });
    // Directory sync may have taken time. Recheck the exact expiry at submit.
    try { assertNarrationQuote(permit.quote, payload.request, undefined, (options.now ?? Date.now)()); }
    catch (error) { throw new ElevenV4Error(error.message, 40); }
    // A charged submission is never retried after an uncertain result.
    submitted = true;
    const result = await client.callTool({
      name: route.name,
      arguments: route.kind === "creative" ? {
        context: "Generate exactly one Gate 1 approved Tsugite narration.",
        prompt: request.text, voice_id: request.voiceId, model_id: request.model,
        generations_count: 1, estimate_only: false
      } : { text: request.text, voice_id: request.voiceId, model_id: request.model }
    }, undefined, { timeout: 120_000 });
    if (route.kind === "creative") {
      const body = await awaitCreativeResult(result, client, route, options, writer);
      const billing = creativeAudio(body, request);
      if (permit?.quote) billing.billing.estimate = quoteBilling([permit.quote]).estimate;
      await writer.publish({ state: "succeeded", billing: billing.billing,
        result: { generation_id: body.generations[0].id, model: request.model, voice_id: request.voiceId } });
      return await downloadAndPin(request, paths, billing.result, options, billing, writer);
    }
    const billing = { credits: 0, metadata: { provider_billing: "unmeasured" }, billing: actualNarrationBilling(undefined, null, 1) };
    billing.billing.estimate = quoteBilling([permit.quote]).estimate;
    await writer.publish({ state: "succeeded", billing: billing.billing });
    return await downloadAndPin(request, paths, result, options, billing, writer);
  } catch (error) {
    if (submitted && writer?.current.state === "submitting" && error?.code === "mcp_generation_failed") throw new ElevenV4Error("mcp_outcome_unknown", 20);
    if (error?.code === "mcp_generation_failed" && writer?.current.state === "accepted") {
      try { await writer.publish({ state: "failed" }); } catch { throw new ElevenV4Error("mcp_outcome_unknown", 20); }
    }
    if (error instanceof ElevenV4Error) throw error;
    if (/^(receipt|project|billing)_[a-z_]+$/.test(error?.message ?? "")) throw new ElevenV4Error(error.message, 20);
    throw new ElevenV4Error(submitted ? "mcp_outcome_unknown" : "mcp_discovery_failed", 20);
  } finally {
    await journal?.close().catch(() => undefined);
    if (ownsClient) await client?.close().catch(() => undefined);
  }
}
