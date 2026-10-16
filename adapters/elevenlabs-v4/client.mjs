import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, realpath, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
// A literal '*' in this repository path breaks the SDK's wildcard package exports.
import { StreamableHTTPClientTransport } from "../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
import { ElevenOAuthError, OAUTH, keychainAccessToken, elevenCredentialBinding } from "./oauth.mjs";
import { actualNarrationBilling, assertNarrationQuote, billingDigest, makeNarrationQuote, narrationRequestDigest, quoteBilling } from "../billing-contract.mjs";
import { authorizeRunSubmission } from "../billing-store.mjs";
import { SubmissionDurabilityError, assertSubmissionDurabilitySupported, createDurableSubmissionJournal } from "./durability.mjs";

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
  if (!request || typeof request !== "object" || !SAFE_ID.test(request.id ?? "")) {
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
    throw new ElevenV4Error("output_already_exists", 40);
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

async function awaitCreativeResult(initial, client, route, options, journal) {
  let body = resultBody(initial);
  const identity = creativeIdentity(body);
  await journal.writeFile(`${JSON.stringify({ phase: "accepted", ...identity })}\n`);
  const deadline = Date.now() + 120_000;
  for (let poll = 0; poll <= 30; poll += 1) {
    if ((body.flow_id !== undefined && body.flow_id !== identity.flow_id)
      || (body.session_ids !== undefined && JSON.stringify(body.session_ids) !== JSON.stringify(identity.session_ids))) {
      throw new ElevenV4Error("mcp_generation_identity_invalid", 20);
    }
    if (body.all_completed === true) return { ...body, ...identity };
    if (poll === 30 || Date.now() >= deadline) throw new ElevenV4Error("mcp_generation_pending", 20);
    const seconds = Number.isFinite(body.poll_after_seconds) ? body.poll_after_seconds : 3;
    const ms = Math.min(10, Math.max(1, seconds)) * 1000;
    await (options.sleep ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay))))(ms);
    let status;
    try {
      status = await client.callTool({
        name: route.statusTool,
        arguments: { context: "Wait for the approved Tsugite narration without starting another generation.", ...identity }
      }, undefined, { timeout: Math.min(20_000, Math.max(1, deadline - Date.now())) });
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

async function pinResult(request, paths, result, options, billing = { credits: 0, metadata: { provider_billing: "unmeasured" }, billing: actualNarrationBilling(undefined, null, 1) }) {
  const audio = await readMcpAudio(result, options.fetchImpl ?? fetch);
  if (audio.length < 3 || audio.length > MAX_AUDIO_BYTES || !(
    audio.subarray(0, 3).toString("ascii") === "ID3"
    || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0)
  )) throw new ElevenV4Error("mcp_audio_invalid", 20);
  const temporary = join(paths.realOutputDir, `.${request.id}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, audio, { flag: "wx" });
    await link(temporary, paths.destination);
  } catch { throw new ElevenV4Error("output_write_failed", 20); }
  finally { await unlink(temporary).catch(() => undefined); }
  return {
    request_id: request.id, credits: billing.credits, clips: [], images: [],
    audio: [{ id: request.id, src: paths.destination, role: "narration", start: 0 }],
    billing: billing.billing,
    metadata: { provider: "elevenlabs", model: request.model, transport: "mcp", ...billing.metadata }
  };
}

// Reuse a completed result; this entry point cannot call MCP or generate again.
export async function importElevenV4Result(payload, options = {}) {
  const request = validateElevenV4Request(payload?.request);
  const paths = await prepareDestination(payload?.run_dir, request);
  const body = resultBody(payload?.result);
  creativeIdentity(body);
  const billing = creativeAudio(body, request);
  billing.metadata.source = "imported-existing-generation";
  billing.billing.operation.submission_count = 0;
  return pinResult(request, paths, billing.result, options, billing);
}

export async function generateElevenV4(payload, options = {}) {
  const request = validateElevenV4Request(payload?.request);
  try { assertSubmissionDurabilitySupported(options.platform); }
  catch (error) { throw new ElevenV4Error(error.code, 20); }
  let paths;
  try { paths = await prepareDestination(payload?.run_dir, request, options); }
  catch (error) {
    if (error instanceof ElevenV4Error) throw error;
    throw new ElevenV4Error("submission_not_durable", 20);
  }
  const token = await accessToken(options);
  let client;
  let journal;
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
    try {
      journal = await createDurableSubmissionJournal(paths.realOutputDir, request.id,
        { phase: "submitting", model: request.model, tool: route.name,
          schema_version: 1, request_digest: narrationRequestDigest(payload.request),
          operation: { submission_count: 1 }, liability_state: "unresolved",
          billing_approval_digest: permit.billing_approval_digest, gate_approval_digest: permit.gate_approval_digest,
          quote_id: permit.quote.quote_id, quote: permit.quote }, options);
    } catch (error) {
      if (error instanceof SubmissionDurabilityError) {
        throw new ElevenV4Error(error.code, error.code === "submission_already_exists_or_unwritable" ? 40 : 20);
      }
      throw new ElevenV4Error("submission_not_durable", 20);
    }
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
      const body = await awaitCreativeResult(result, client, route, options, journal);
      const billing = creativeAudio(body, request);
      if (permit?.quote) billing.billing.estimate = quoteBilling([permit.quote]).estimate;
      return await pinResult(request, paths, billing.result, options, billing);
    }
    return await pinResult(request, paths, result, options);
  } catch (error) {
    if (error instanceof ElevenV4Error) throw error;
    throw new ElevenV4Error(submitted ? "mcp_outcome_unknown" : "mcp_discovery_failed", 20);
  } finally {
    await journal?.close().catch(() => undefined);
    if (ownsClient) await client?.close().catch(() => undefined);
  }
}
