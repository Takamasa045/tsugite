import crossSpawn from "cross-spawn";
import { resolve } from "node:path";

const spawnSync = crossSpawn.sync;

const TRANSIENT = 20;
const RATE_LIMITED = 21;
const INVALID_REQUEST = 40;
const MAX_OUTPUT = 1024 * 1024 * 20;

export function runPixverseVideo(input, options = {}) {
  const payload = parsePayload(input);
  const request = {
    ...payload.request,
    model: payload.request.model || options.defaultModel
  };
  const runDir = resolve(payload.run_dir);
  const outputDir = resolve(runDir, "generated", request.id);
  const pixverse = process.env.PIXVERSE_CLI || "pixverse";
  const model = String(request.model || "").trim();
  if (!model) {
    throw new AdapterError("request.model is required", INVALID_REQUEST);
  }

  const createArgs = buildPixverseCreateArgs(request, payload.run_id);

  const create = runJsonCommand(pixverse, createArgs);
  const taskId = findTaskId(create);
  if (!taskId) {
    throw new AdapterError("PixVerse CLI did not return a task id", TRANSIENT);
  }

  const wait = runJsonCommand(pixverse, ["task", "wait", taskId, "--type", "video", "--timeout", waitTimeout(request), "--json"]);
  const download = runJsonCommand(pixverse, ["asset", "download", taskId, "--type", "video", "--dest", outputDir, "--json"]);
  const downloadedPath = findDownloadPath(download, outputDir);
  const media = probeMedia(downloadedPath, request);

  return {
    request_id: request.id,
    credits: findNumberByKeys(wait, ["credits", "credit", "cost", "cost_credits", "costCredits"])
      ?? findNumberByKeys(create, ["credits", "credit", "cost", "cost_credits", "costCredits"])
      ?? 0,
    clips: [
      {
        id: `${request.id}-clip`,
        src: downloadedPath,
        duration: media.duration,
        fps: media.fps,
        resolution: {
          width: media.width,
          height: media.height
        },
        audio: request.params?.audio === true
      }
    ],
    metadata: {
      adapter: options.adapterName ?? "pixverse",
      task_id: taskId,
      route: options.route,
      create,
      wait
    }
  };
}

export function buildPixverseCreateArgs(request, runId) {
  const model = String(request.model || "").trim();
  const args = [
    "create",
    "video",
    "--prompt",
    request.prompt,
    "--model",
    model,
    "--duration",
    String(request.duration),
    "--count",
    String(numberParam(request.params?.count, 1)),
    "--idempotency-key",
    safeIdempotencyKey(runId, request.id),
    "--no-wait",
    "--json"
  ];

  if (request.input_mode !== "image-to-video") {
    args.push("--aspect-ratio", request.aspect);
  }
  if (typeof request.seed === "number") {
    args.push("--seed", String(request.seed));
  }
  if (typeof request.params?.quality === "string") {
    args.push("--quality", request.params.quality);
  }
  if (typeof request.params?.image === "string") {
    args.push("--image", request.params.image);
  }
  if (request.params?.audio === true) {
    args.push("--audio");
  } else {
    args.push("--no-audio");
  }
  return args;
}

export function normalizeError(error) {
  if (error instanceof AdapterError) return error;
  return new AdapterError(error instanceof Error ? error.message : String(error), TRANSIENT);
}

export function findTaskId(value) {
  const found = findTaskIdValue(value);
  return found === undefined ? undefined : String(found);
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
    return { duration: request.duration, fps: numberParam(request.params?.fps, 30), ...fallback };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const stream = parsed.streams?.[0] ?? {};
    return {
      duration: Number(parsed.format?.duration) || request.duration,
      fps: parseFrameRate(stream.r_frame_rate) || numberParam(request.params?.fps, 30),
      width: Number(stream.width) || fallback.width,
      height: Number(stream.height) || fallback.height
    };
  } catch {
    return { duration: request.duration, fps: numberParam(request.params?.fps, 30), ...fallback };
  }
}

function findDownloadPath(output, outputDir) {
  const candidate = findFirstString(output, ["path", "file", "file_path", "output", "output_path", "downloaded_path"]);
  if (candidate) return resolve(candidate);
  return findDownloadedVideo(outputDir);
}

function findDownloadedVideo(outputDir) {
  const script = `
    const { readdirSync, statSync } = require("node:fs");
    const { join } = require("node:path");
    const root = process.argv[1];
    const files = [];
    function walk(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\\.(mp4|mov|webm)$/i.test(entry.name)) files.push({ path, mtime: statSync(path).mtimeMs });
      }
    }
    walk(root);
    files.sort((a, b) => b.mtime - a.mtime);
    if (!files[0]) process.exit(2);
    process.stdout.write(files[0].path);
  `;
  const result = spawnSync(process.execPath, ["-e", script, outputDir], {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new AdapterError("PixVerse CLI did not produce a downloadable video file", TRANSIENT);
  }
  return resolve(result.stdout.trim());
}

function findFirstString(value, keys) {
  const found = findFirst(value, keys, (candidate) => typeof candidate === "string" && candidate.length > 0);
  return typeof found === "string" ? found : undefined;
}

function findTaskIdValue(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTaskIdValue(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  for (const key of ["video_id", "videoId", "task_id", "taskId", "id"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0) return candidate;
  }

  for (const item of Object.values(value)) {
    const found = findTaskIdValue(item);
    if (found !== undefined) return found;
  }
  return undefined;
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

function classifyExit(result) {
  const text = commandOutput(result).toLowerCase();
  if (text.includes("rate") || text.includes("429")) return RATE_LIMITED;
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
