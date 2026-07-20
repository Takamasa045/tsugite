import crossSpawn from "cross-spawn";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const spawnSync = crossSpawn.sync;
const TRANSIENT = 20;
const RATE_LIMITED = 21;
const INVALID_REQUEST = 40;
const MAX_OUTPUT = 1024 * 1024 * 20;

export const klingOperationContract = Object.freeze({
  "text-to-image": "text_to_image",
  "image-to-image": "image_to_image",
  "text-to-video": "text_to_video",
  "image-to-video": "image_to_video"
});

export function buildKlingCreateArgs(request) {
  const images = [request.first_frame, ...(request.input_images || request.reference_images || [])].filter(Boolean);
  const output = request.output_kind || (request.operation === "image" ? "image" : "video");
  const capability = output === "image"
    ? (images.length > 0 ? "image-to-image" : "text-to-image")
    : (images.length > 0 ? "image-to-video" : "text-to-video");
  const tool = klingOperationContract[capability];
  if (!tool) throw new AdapterError(`unsupported Kling capability '${capability}'`, INVALID_REQUEST);
  if (!request.model) throw new AdapterError("request.model is required for Kling CLI", INVALID_REQUEST);

  const args = [tool, "--model", String(request.model)];
  for (const image of images) args.push("--image", String(image));
  const params = {
    ...(request.duration !== undefined ? { duration: request.duration } : {}),
    ...(request.aspect ? { aspectRatio: request.aspect } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.params || {})
  };
  for (const [name, value] of Object.entries(params)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name) || value === undefined || value === null) continue;
    if (!["string", "number", "boolean"].includes(typeof value)) continue;
    args.push(`--${name}`, String(value));
  }
  args.push("--poll", String(timeoutSeconds(request)), "--quiet", request.prompt || "");
  return args;
}

export async function runKlingMedia(input) {
  const payload = parsePayload(input);
  const request = payload.request;
  const executable = process.env.KLING_CLI || "kling";
  const result = spawnSync(executable, buildKlingCreateArgs(request), {
    cwd: process.cwd(), encoding: "utf8", maxBuffer: MAX_OUTPUT
  });
  if (result.error) throw new AdapterError(result.error.message, TRANSIENT);
  if (result.status !== 0) throw new AdapterError(commandOutput(result), classifyExit(result));
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch (error) {
    throw new AdapterError(`Kling CLI returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`, TRANSIENT);
  }

  const outputKind = request.output_kind || (request.operation === "image" ? "image" : "video");
  const urls = findHttpsMediaUrls(response, outputKind);
  if (urls.length === 0) throw new AdapterError("Kling CLI completed without downloadable media URLs", TRANSIENT);
  const outputDir = resolve(payload.run_dir, "generated", request.id);
  await mkdir(outputDir, { recursive: true });
  const paths = [];
  for (const [index, url] of urls.entries()) {
    const suffix = safeExtension(url, outputKind);
    const target = join(outputDir, `${String(index + 1).padStart(3, "0")}${suffix}`);
    await downloadHttps(url, target);
    paths.push(target);
  }
  return {
    request_id: request.id,
    credits: findNumber(response, ["credits", "credit", "cost", "cost_credits"]) ?? 0,
    clips: outputKind === "video" ? paths.map((src, index) => ({
      id: `${request.id}-clip-${index + 1}`,
      src,
      duration: request.duration || 5,
      fps: Number(request.params?.fps) || 30,
      resolution: fallbackResolution(request.aspect),
      audio: request.params?.sound === true || request.params?.audio === true
    })) : [],
    images: outputKind === "image" ? paths.map((src, index) => ({ id: `${request.id}-image-${index + 1}`, src })) : [],
    audio: [],
    metadata: { adapter: "kling", route: "kling-cli", response }
  };
}

export function normalizeError(error) {
  if (error instanceof AdapterError) return error;
  return new AdapterError(error instanceof Error ? error.message : String(error), TRANSIENT);
}

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function parsePayload(input) {
  if (!input || typeof input !== "object" || !input.request || typeof input.request !== "object") {
    throw new AdapterError("payload.request is required", INVALID_REQUEST);
  }
  if (typeof input.run_id !== "string" || typeof input.run_dir !== "string") {
    throw new AdapterError("payload.run_id and payload.run_dir are required", INVALID_REQUEST);
  }
  return input;
}

function timeoutSeconds(request) {
  const value = Number(request.params?.timeout_seconds ?? 900);
  return Number.isFinite(value) ? Math.max(1, Math.min(3600, Math.round(value))) : 900;
}

function findHttpsMediaUrls(value, kind, found = new Set()) {
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && mediaExtension(url.pathname, kind)) found.add(url.toString());
    } catch { /* not a URL */ }
    return [...found];
  }
  if (Array.isArray(value)) for (const item of value) findHttpsMediaUrls(item, kind, found);
  else if (value && typeof value === "object") for (const item of Object.values(value)) findHttpsMediaUrls(item, kind, found);
  return [...found];
}

function mediaExtension(path, kind) {
  return kind === "image" ? /\.(png|jpe?g|webp|gif|avif)$/i.test(path) : /\.(mp4|mov|webm)$/i.test(path);
}

async function downloadHttps(source, target) {
  const url = new URL(source);
  if (url.protocol !== "https:" || isPrivateHost(url.hostname)) {
    throw new AdapterError("Kling media URL must use public HTTPS", INVALID_REQUEST);
  }
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new AdapterError(`Kling media download failed (${response.status})`, TRANSIENT);
  const contentLength = Number(response.headers.get("content-length") || 0);
  const maxBytes = MAX_OUTPUT * 25;
  if (contentLength > maxBytes) throw new AdapterError("Kling media download exceeds the size limit", INVALID_REQUEST);
  if (!response.body) throw new AdapterError("Kling media download returned an empty body", TRANSIENT);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new AdapterError("Kling media download exceeds the size limit", INVALID_REQUEST);
    }
    chunks.push(Buffer.from(value));
  }
  await writeFile(target, Buffer.concat(chunks));
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "::1" || /^127\./.test(host) || /^10\./.test(host)
    || /^192\.168\./.test(host) || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

function safeExtension(source, kind) {
  try {
    const suffix = extname(new URL(source).pathname).toLowerCase();
    if (mediaExtension(`file${suffix}`, kind)) return suffix;
  } catch { /* use fallback */ }
  return kind === "image" ? ".png" : ".mp4";
}

function findNumber(value, keys) {
  if (Array.isArray(value)) {
    for (const item of value) { const found = findNumber(item, keys); if (found !== undefined) return found; }
  } else if (value && typeof value === "object") {
    for (const key of keys) if (typeof value[key] === "number") return value[key];
    for (const item of Object.values(value)) { const found = findNumber(item, keys); if (found !== undefined) return found; }
  }
  return undefined;
}

function fallbackResolution(aspect) {
  return aspect === "9:16" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}

function classifyExit(result) {
  const text = commandOutput(result).toLowerCase();
  if (text.includes("rate") || text.includes("429")) return RATE_LIMITED;
  if (text.includes("unknown parameter") || text.includes("not available") || text.includes("required")) return INVALID_REQUEST;
  return TRANSIENT;
}

function commandOutput(result) {
  return `${result.stderr}\n${result.stdout}`.trim().slice(0, 2000) || "Kling CLI command failed";
}

class AdapterError extends Error {
  constructor(message, exitCode) { super(message); this.exitCode = exitCode; }
}
