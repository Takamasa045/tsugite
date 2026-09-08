import crossSpawn from "cross-spawn";
import { resolve } from "node:path";

const spawnSync = crossSpawn.sync;

const TRANSIENT = 20;
const RATE_LIMITED = 21;
const INVALID_REQUEST = 40;
const MAX_OUTPUT = 1024 * 1024 * 20;

export const pixverseOperationContract = Object.freeze({
  video: { assetType: "video" },
  image: { assetType: "image" },
  transition: { assetType: "video" },
  voice: { assetType: "audio", audioRole: "narration" },
  music: { assetType: "audio", audioRole: "music" },
  extend: { assetType: "video" },
  modify: { assetType: "video" },
  upscale: { assetType: "video" },
  reference: { assetType: "video" },
  "motion-control": { assetType: "video" },
  template: { assetType: "video" }
});

export function runPixverseMedia(input, options = {}) {
  const payload = parsePayload(input);
  const request = {
    ...payload.request,
    model: payload.request.model || options.defaultModel
  };
  const runDir = resolve(payload.run_dir);
  const outputDir = resolve(runDir, "generated", request.id);
  const pixverse = process.env.PIXVERSE_CLI || "pixverse";
  const operation = request.operation || "video";
  const contract = pixverseOperationContract[operation];
  if (!contract) throw new AdapterError(`unsupported PixVerse create operation '${operation}'`, INVALID_REQUEST);
  const assetType = operation === "template" ? (request.output_kind || "video") : contract.assetType;

  const createArgs = buildPixverseCreateArgs(request, payload.run_id);

  const create = runJsonCommand(pixverse, createArgs);
  const taskIds = findTaskIds(create);
  const taskId = taskIds[0];
  if (!taskId) {
    throw new AdapterError("PixVerse CLI did not return a task id", TRANSIENT);
  }

  const globalArgs = buildPixverseGlobalArgs(request);
  const waits = [];
  const downloadedPaths = [];
  for (const [index, id] of taskIds.entries()) {
    const destination = taskIds.length === 1 ? outputDir : resolve(outputDir, String(index + 1));
    waits.push(runJsonCommand(pixverse, ["task", "wait", id, "--type", assetType, "--timeout", waitTimeout(request), "--json", ...globalArgs]));
    const download = runJsonCommand(pixverse, ["asset", "download", id, "--type", assetType, "--dest", destination, "--json", ...globalArgs]);
    downloadedPaths.push(...findDownloadPaths(download, destination, assetType));
  }
  const wait = waits.length === 1 ? waits[0] : waits;
  const creditKeys = ["credits", "credit", "cost", "cost_credits", "costCredits"];
  const taskCredits = waits.map((result) => findNumberByKeys(result, creditKeys));

  return {
    request_id: request.id,
    credits: taskCredits.every((credit) => credit !== undefined)
      ? taskCredits.reduce((sum, credit) => sum + credit, 0)
      : findNumberByKeys(create, creditKeys) ?? 0,
    clips: assetType === "video" ? downloadedPaths.map((src, index) => {
      const media = probeMedia(src, request);
      return {
        id: `${request.id}-clip-${index + 1}`,
        src,
        duration: media.duration,
        fps: media.fps,
        resolution: {
          width: media.width,
          height: media.height
        },
        audio: request.params?.audio === true
      };
    }) : [],
    images: assetType === "image" ? downloadedPaths.map((src, index) => ({ id: `${request.id}-image-${index + 1}`, src })) : [],
    audio: assetType === "audio" ? downloadedPaths.map((src, index) => ({
      id: `${request.id}-audio-${index + 1}`,
      src,
      role: request.audio_role || contract.audioRole || "sfx",
      start: numberParam(request.params?.start, 0),
      ...(typeof request.params?.end === "number" ? { end: request.params.end } : {}),
      ...(typeof request.params?.volume === "number" ? { volume: request.params.volume } : {})
    })) : [],
    metadata: {
      adapter: options.adapterName ?? "pixverse",
      task_id: taskId,
      task_ids: taskIds,
      route: options.route,
      create,
      wait
    }
  };
}

export function buildPixverseCreateArgs(request, runId) {
  const operation = request.operation || "video";
  if (!pixverseOperationContract[operation]) {
    throw new AdapterError(`unsupported PixVerse create operation '${operation}'`, INVALID_REQUEST);
  }
  const args = [
    "create",
    operation
  ];
  const params = request.params || {};
  const listedImages = [...new Set([
    ...(request.input_images || []),
    ...(request.reference_images || [])
  ].filter(Boolean))];
  const singleImages = [...new Set([
    request.first_frame,
    params.image
  ].filter(Boolean))];
  const firstImage = singleImages[0];
  const allowed = PIXVERSE_ALLOWED_OPTIONS[operation];
  const has = (name) => allowed.has(name);
  const listImages = has("image")
    ? [...new Set([...singleImages.slice(1), ...listedImages])].filter((image) => image !== firstImage)
    : [...new Set([...singleImages, ...listedImages])];

  if (operation === "voice") pushValue(args, "--text", request.prompt || params.text);
  else if (has("prompt")) pushValue(args, "--prompt", request.prompt);
  if (has("model")) pushValue(args, "--model", normalizePixverseCliModel(request.model));
  if (has("duration")) pushValue(args, "--duration", durationFlag(request, params));
  if (has("aspect") && !(operation === "video" && request.input_mode === "image-to-video")) {
    pushValue(args, "--aspect-ratio", request.aspect);
  }
  if (has("seed")) pushValue(args, "--seed", request.seed);
  if (has("quality")) pushValue(args, "--quality", params.quality);
  if (has("count")) pushValue(args, "--count", params.count ?? 1);
  if (has("detail")) pushValue(args, "--detail-level", params.detail_level);
  if (has("voice")) {
    pushValue(args, "--voice-id", params.voice_id); pushValue(args, "--provider-voice-id", params.provider_voice_id);
    pushValue(args, "--language", params.language); pushValue(args, "--stability", params.stability);
    pushValue(args, "--similarity-boost", params.similarity_boost); pushValue(args, "--style", params.style);
    pushValue(args, "--speed", params.speed); pushValue(args, "--volume", params.volume);
    pushValue(args, "--pitch", params.pitch); pushValue(args, "--emotion", params.emotion);
    pushBoolean(args, "--use-speaker-boost", params.use_speaker_boost);
  }
  if (has("music")) {
    pushValue(args, "--lyrics", params.lyrics);
    pushBoolean(args, "--instrumental", params.instrumental, false);
    pushBoolean(args, "--auto-lyrics", params.auto_lyrics, false);
    // Project duration stays editorial; only an explicit music param is forwarded.
    pushValue(args, "--duration-seconds", params.duration_seconds);
  }
  if (has("task-type")) pushValue(args, "--task-type", params.task_type);
  if (has("keyframe")) pushValue(args, "--keyframe-time", params.keyframe_time);
  if (has("template")) pushValue(args, "--template-id", params.template_id);
  if (has("video-input")) pushValue(args, "--video", request.input_video || params.video);
  if (has("images")) pushMany(args, ["template", "music"].includes(operation) ? "--image" : "--images", listImages);
  if (has("image") && firstImage) pushValue(args, "--image", firstImage);
  if (has("videos")) pushMany(args, "--videos", request.input_videos);
  if (has("audios")) pushMany(args, "--audios", request.input_audios);
  if (has("audio")) pushBoolean(args, "--audio", params.audio);
  if (has("multi-shot")) pushBoolean(args, "--multi-shot", params.multi_shot);
  if (has("off-peak")) pushBoolean(args, "--off-peak", params.off_peak, false);
  if (!["voice", "music"].includes(operation)) {
    args.push("--idempotency-key", safeIdempotencyKey(runId, request.id));
  }
  args.push("--no-wait", "--json", ...buildPixverseGlobalArgs(request));
  return args;
}

export function preflightPixverseRequest(request, options = {}) {
  const operation = request.operation || "video";
  const createArgs = buildPixverseCreateArgs(request, "model-preflight");
  const runCommand = options.runCommand ?? ((executable, args) => spawnSync(executable, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT
  }));
  const pixverse = process.env.PIXVERSE_CLI || "pixverse";
  const version = runCommand(pixverse, ["--version"]);
  if (version.error || version.status !== 0) {
    throw new AdapterError("PixVerse CLI version check failed", TRANSIENT);
  }
  const checkedParameters = [...new Set(createArgs
    .filter((value) => value.startsWith("--"))
    .map((value) => value.slice(2))
    .filter((value) => value !== "json"))]
    .sort();
  return {
    request_id: request.id,
    status: "provider-validation-required",
    source: "pixverse-cli-runtime",
    ...(request.model ? { model: normalizePixverseCliModel(request.model) } : {}),
    operation,
    runtime_version: String(version.stdout || "").trim(),
    checked_parameters: checkedParameters
  };
}

const PIXVERSE_ALLOWED_OPTIONS = Object.freeze({
  video: new Set(["prompt", "model", "duration", "aspect", "seed", "quality", "count", "image", "audio", "multi-shot", "off-peak"]),
  image: new Set(["prompt", "model", "aspect", "seed", "quality", "count", "detail", "image", "images"]),
  transition: new Set(["prompt", "model", "duration", "seed", "quality", "count", "images", "audio", "off-peak"]),
  voice: new Set(["model", "voice"]),
  music: new Set(["prompt", "model", "music", "image", "images"]),
  extend: new Set(["prompt", "model", "duration", "seed", "quality", "count", "video-input", "audio", "off-peak"]),
  modify: new Set(["prompt", "model", "seed", "quality", "count", "video-input", "images", "keyframe", "off-peak"]),
  upscale: new Set(["quality", "video-input"]),
  reference: new Set(["prompt", "model", "duration", "aspect", "seed", "quality", "count", "images", "videos", "audios", "audio", "off-peak", "task-type"]),
  "motion-control": new Set(["model", "quality", "count", "image", "video-input", "off-peak"]),
  template: new Set(["prompt", "duration", "aspect", "seed", "quality", "count", "images", "video-input", "template", "off-peak"])
});

function normalizePixverseCliModel(value) {
  const model = String(value || "").trim();
  return model === "c1" ? "pixverse-c1" : model;
}

function pushValue(args, flag, value) {
  if (value === undefined || value === null || value === "") return;
  args.push(flag, String(value));
}

function pushMany(args, flag, values) {
  if (!Array.isArray(values) || values.length === 0) return;
  args.push(flag, ...values.map(String));
}

function pushBoolean(args, flag, value, includeNegative = true) {
  if (value === true) args.push(flag);
  else if (value === false && includeNegative) args.push(`--no-${flag.slice(2)}`);
}

export function normalizeError(error) {
  if (error instanceof AdapterError) return error;
  return new AdapterError(error instanceof Error ? error.message : String(error), TRANSIENT);
}

export function findTaskId(value) {
  return findTaskIds(value)[0];
}

export function findTaskIds(value) {
  const ids = new Set();
  const add = (candidate) => {
    if (typeof candidate === "string" && candidate.length > 0) ids.add(candidate);
    else if (Number.isSafeInteger(candidate) && candidate > 0) ids.add(String(candidate));
  };
  const visit = (item) => {
    if (Array.isArray(item)) { item.forEach(visit); return; }
    if (!item || typeof item !== "object") return;
    // A typed ID takes precedence over generic metadata IDs on the same record.
    for (const key of ["video_id", "image_id", "audio_id", "videoId", "imageId", "audioId", "task_id", "taskId", "id"]) {
      if (typeof item[key] === "string" && item[key].length > 0 || Number.isSafeInteger(item[key]) && item[key] > 0) {
        add(item[key]);
        return;
      }
    }
    for (const [key, child] of Object.entries(item)) {
      if (["video_ids", "image_ids", "audio_ids", "task_ids"].includes(key) && Array.isArray(child)) child.forEach(add);
      else if (["data", "result", "results", "tasks", "videos", "images", "audios"].includes(key)) visit(child);
    }
  };
  visit(value);
  return [...ids];
}

export function buildPixverseGlobalArgs(request) {
  const args = [];
  const params = request.params || {};
  if (params.workspace_id !== undefined) {
    if (!/^\d+$/.test(String(params.workspace_id)) || !Number.isSafeInteger(Number(params.workspace_id))) {
      throw new AdapterError("PixVerse workspace_id must be a non-negative safe integer", INVALID_REQUEST);
    }
    pushValue(args, "--workspace-id", params.workspace_id);
  }
  if (params.trace_id !== undefined) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(params.trace_id)) {
      throw new AdapterError("PixVerse trace_id must be UUIDv4", INVALID_REQUEST);
    }
    pushValue(args, "--trace-id", params.trace_id);
  }
  return args;
}

export function findNumberByKeys(value, keys) {
  const found = findKeyedValue(value, keys, (candidate) => typeof candidate === "number" && Number.isFinite(candidate));
  return typeof found === "number" ? found : undefined;
}

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parsePayload(input) {
  if (!input || typeof input !== "object") {
    throw new AdapterError("payload must be an object", INVALID_REQUEST);
  }
  if (!input.request || typeof input.request !== "object") {
    throw new AdapterError("payload.request is required", INVALID_REQUEST);
  }
  if (typeof input.run_id !== "string" || input.run_id.length === 0) {
    throw new AdapterError("payload.run_id is required", INVALID_REQUEST);
  }
  if (typeof input.run_dir !== "string" || input.run_dir.length === 0) {
    throw new AdapterError("payload.run_dir is required", INVALID_REQUEST);
  }
  return input;
}

function runJsonCommand(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT
  });
  if (result.error) {
    throw new AdapterError(result.error.message, TRANSIENT);
  }
  if (result.status !== 0) {
    throw new AdapterError(commandOutput(result), classifyExit(result));
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new AdapterError(`PixVerse CLI returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`, TRANSIENT);
  }
}

function probeMedia(path, request) {
  const fallback = fallbackResolution(request.aspect);
  const fallbackDuration = numberParam(request.duration, 5);
  const result = spawnSync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,r_frame_rate:format=duration",
    "-of",
    "json",
    path
  ], {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT
  });

  if (result.status !== 0) {
    return { duration: fallbackDuration, fps: numberParam(request.params?.fps, 30), ...fallback };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const stream = parsed.streams?.[0] ?? {};
    return {
      duration: Number(parsed.format?.duration) || fallbackDuration,
      fps: parseFrameRate(stream.r_frame_rate) || numberParam(request.params?.fps, 30),
      width: Number(stream.width) || fallback.width,
      height: Number(stream.height) || fallback.height
    };
  } catch {
    return { duration: fallbackDuration, fps: numberParam(request.params?.fps, 30), ...fallback };
  }
}

function findDownloadPaths(output, outputDir, assetType) {
  const downloaded = findDownloadedAssets(outputDir, assetType);
  if (downloaded.length > 0) return downloaded;
  const candidate = findFirstString(output, ["path", "file", "file_path", "output", "output_path", "downloaded_path"]);
  if (candidate) return [resolve(candidate)];
  throw new AdapterError(`PixVerse CLI did not produce a downloadable ${assetType} file`, TRANSIENT);
}

function findDownloadedAssets(outputDir, assetType) {
  const pattern = assetType === "image"
    ? "\\.(png|jpe?g|webp|gif|avif)$"
    : assetType === "audio"
      ? "\\.(mp3|wav|m4a|aac|ogg|flac)$"
      : "\\.(mp4|mov|webm)$";
  const script = `
    const { readdirSync, statSync } = require("node:fs");
    const { join } = require("node:path");
    const root = process.argv[1];
    const files = [];
    function walk(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (new RegExp(process.argv[2], "i").test(entry.name)) files.push({ path, mtime: statSync(path).mtimeMs });
      }
    }
    walk(root);
    files.sort((a, b) => a.path.localeCompare(b.path));
    process.stdout.write(JSON.stringify(files.map((entry) => entry.path)));
  `;
  const result = spawnSync(process.execPath, ["-e", script, outputDir, pattern], {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT
  });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  try {
    const paths = JSON.parse(result.stdout);
    return Array.isArray(paths) ? paths.map((path) => resolve(path)) : [];
  } catch {
    return [];
  }
}

function findFirstString(value, keys) {
  const found = findFirst(value, keys, (candidate) => typeof candidate === "string" && candidate.length > 0);
  return typeof found === "string" ? found : undefined;
}

function findKeyedValue(value, keys, predicate) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findKeyedValue(item, keys, predicate);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  for (const key of keys) {
    if (predicate(value[key])) return value[key];
  }

  for (const item of Object.values(value)) {
    const found = findKeyedValue(item, keys, predicate);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findFirst(value, keys, predicate) {
  if (predicate(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirst(item, keys, predicate);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const key of keys) {
      if (predicate(value[key])) return value[key];
    }
    for (const item of Object.values(value)) {
      const found = findFirst(item, keys, predicate);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function waitTimeout(request) {
  return String(numberParam(request.params?.timeout_seconds, 900));
}

function numberParam(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safeIdempotencyKey(runId, requestId) {
  return `tsugite-${runId}-${requestId}`.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
}

function fallbackResolution(aspect) {
  return aspect === "9:16" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}

function parseFrameRate(value) {
  if (typeof value !== "string") return undefined;
  const [num, den] = value.split("/").map(Number);
  if (!num || !den) return Number(value) || undefined;
  return num / den;
}

function durationFlag(request, params) {
  const candidate = params.duration ?? request.duration;
  if (candidate === "auto") return "auto";
  return request.duration;
}

function classifyExit(result) {
  // PixVerse CLI 1.2.10+: 7 = CONCURRENCY_LIMIT (retry separately from credit errors).
  if (result.status === 7) return RATE_LIMITED;
  const text = commandOutput(result).toLowerCase();
  if (text.includes("rate") || text.includes("429") || text.includes("concurrency")) return RATE_LIMITED;
  if (text.includes("invalid") || text.includes("bad request") || text.includes("400")) return INVALID_REQUEST;
  return TRANSIENT;
}

function commandOutput(result) {
  return `${result.stderr}\n${result.stdout}`.trim().slice(0, 2000) || "PixVerse CLI command failed";
}

class AdapterError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}
