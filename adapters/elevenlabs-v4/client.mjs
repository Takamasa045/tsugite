import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, realpath, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
// A literal '*' in this repository path breaks the SDK's wildcard package exports.
import { StreamableHTTPClientTransport } from "../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";

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

export function selectElevenV4SpeechTool(tools, model) {
  for (const name of SPEECH_TOOLS) {
    const tool = tools?.find((candidate) => candidate.name === name);
    const schema = tool?.inputSchema;
    const properties = schema?.properties;
    if (!properties || schema.type !== "object") continue;
    if (!["text", "voice_id", "model_id"].every((field) => properties[field]?.type === "string")) continue;
    if ((schema.required ?? []).some((field) => !["text", "voice_id", "model_id"].includes(field))) continue;
    if (Array.isArray(properties.model_id.enum) && !properties.model_id.enum.includes(model)) continue;
    return name;
  }
  throw new ElevenV4Error("mcp_v4_speech_tool_unavailable", 20);
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
    if (url.protocol !== "https:" || url.username || url.password
      || !(url.hostname === "elevenlabs.io" || url.hostname.endsWith(".elevenlabs.io"))) {
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
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_AUDIO_BYTES) throw new ElevenV4Error("mcp_audio_too_large", 20);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new ElevenV4Error("mcp_audio_missing", 20);
}

export async function generateElevenV4(payload, options = {}) {
  const request = validateElevenV4Request(payload?.request);
  const runDir = payload?.run_dir;
  if (typeof runDir !== "string" || !isAbsolute(runDir)) {
    throw new ElevenV4Error("invalid_run_directory", 40);
  }
  const root = await realpath(runDir).catch(() => {
    throw new ElevenV4Error("invalid_run_directory", 40);
  });
  const outputDir = join(root, "assets", "elevenlabs-v4");
  await mkdir(outputDir, { recursive: true });
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

  const token = options.environment?.ELEVENLABS_MCP_ACCESS_TOKEN ?? process.env.ELEVENLABS_MCP_ACCESS_TOKEN;
  if (!options.client && (typeof token !== "string" || !token.trim())) {
    throw new ElevenV4Error("credential_missing", 30);
  }
  let client;
  const ownsClient = !options.client;
  try {
    client = options.client ?? await (options.connectMcp ?? connectMcp)(token);
    const listed = await client.listTools(undefined, { timeout: 20_000 });
    const tool = selectElevenV4SpeechTool(listed.tools, request.model);
    // A charged submission is never retried after an uncertain result.
    const result = await client.callTool({
      name: tool,
      arguments: { text: request.text, voice_id: request.voiceId, model_id: request.model }
    }, undefined, { timeout: 120_000 });
    const audio = await readMcpAudio(result, options.fetchImpl ?? fetch);
    if (audio.length < 3 || audio.length > MAX_AUDIO_BYTES || !(
      audio.subarray(0, 3).toString("ascii") === "ID3"
      || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0)
    )) throw new ElevenV4Error("mcp_audio_invalid", 20);
    const temporary = join(realOutputDir, `.${request.id}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, audio, { flag: "wx" });
      await link(temporary, destination);
    } catch { throw new ElevenV4Error("output_write_failed", 20); }
    finally { await unlink(temporary).catch(() => undefined); }
  } catch (error) {
    if (error instanceof ElevenV4Error) throw error;
    throw new ElevenV4Error("mcp_outcome_unknown", 20);
  } finally {
    if (ownsClient) await client?.close().catch(() => undefined);
  }
  return {
    request_id: request.id,
    credits: 0,
    clips: [],
    images: [],
    audio: [{ id: request.id, src: destination, role: "narration", start: 0 }],
    metadata: { provider: "elevenlabs", model: request.model, transport: "mcp", provider_billing: "unmeasured" }
  };
}
