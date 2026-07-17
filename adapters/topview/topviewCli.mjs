import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import crossSpawn from "cross-spawn";

const spawnSync = crossSpawn.sync;

const TRANSIENT = 20;
const RATE_LIMITED = 21;
const INVALID_REQUEST = 40;
const MAX_OUTPUT = 1024 * 1024 * 20;

export function runTopviewVideo(input) {
  const payload = parsePayload(input);
  const request = payload.request;
  const runDir = resolve(payload.run_dir);
  const outputDir = resolve(runDir, "generated", request.id);
  const args = buildTopviewVideoArgs(request, outputDir);
  const result = runTopviewCommand(args);
  const provider = parseJson(result.stdout, "Topview CLI returned non-JSON output");
  const files = generatedVideos(outputDir);
  if (files.length === 0) {
    throw new AdapterError("Topview CLI did not download a video", TRANSIENT);
  }

  return {
    request_id: request.id,
    credits: finiteNumber(provider.costCredit) ?? finiteNumber(provider.credits) ?? 0,
    clips: files.map((path, index) => {
      const media = probeMedia(path, request);
      return {
        id: files.length === 1 ? `${request.id}-clip` : `${request.id}-clip-${index + 1}`,
        src: path,
        duration: media.duration,
        fps: media.fps,
        resolution: { width: media.width, height: media.height },
        audio: soundEnabled(request.params?.sound)
      };
    }),
    metadata: {
      adapter: "topview",
      task_id: stringValue(provider.taskId ?? provider.task_id),
      board_id: stringValue(provider.boardId ?? provider.board_id),
      status: stringValue(provider.status)
    }
  };
}

export function buildTopviewVideoArgs(request, outputDir) {
  const mode = request.mode ?? request.input_mode ?? "text-to-video";
  if (mode !== "text-to-video" && mode !== "image-to-video") {
    throw new AdapterError("unsupported request mode", INVALID_REQUEST);
  }
  if (mode === "image-to-video" && !nonEmptyString(request.first_frame)) {
    throw new AdapterError("image-to-video requires first_frame", INVALID_REQUEST);
  }
  if (!nonEmptyString(request.model) || !nonEmptyString(request.prompt)) {
    throw new AdapterError("request.model and request.prompt are required", INVALID_REQUEST);
  }

  const args = [
    "run",
    "--type", mode === "image-to-video" ? "i2v" : "t2v",
    "--model", request.model,
    "--prompt", request.prompt,
    "--duration", String(request.duration),
    "--count", String(numberParam(request.params?.count, 1)),
    "--output-dir", outputDir,
    "--json",
    "--quiet"
  ];
  if (mode === "image-to-video") args.push("--first-frame", request.first_frame);
  if (nonEmptyString(request.aspect)) args.push("--aspect-ratio", request.aspect);
  args.push("--resolution", String(numberParam(request.params?.resolution, 720)));
  if (request.params?.sound !== undefined) {
    args.push("--sound", soundEnabled(request.params.sound) ? "on" : "off");
  }
  if (nonEmptyString(request.params?.board_id)) args.push("--board-id", request.params.board_id);
  if (Number.isFinite(request.params?.timeout)) args.push("--timeout", String(request.params.timeout));
  return args;
}

export function runTopviewCommand(args, options = {}) {
  const command = options.command ?? resolveTopviewVideoCommand();
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT
  });
  if (result.error) throw new AdapterError(result.error.message, TRANSIENT);
  if (result.status !== 0) {
    const message = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    throw new AdapterError("Topview CLI failed", classifyFailure(result.status, message));
  }
  return result;
}

export function resolveTopviewVideoCommand(environment = process.env, platform = process.platform) {
  if (environment.TSUGITE_TOPVIEW_VIDEO_COMMAND) {
    try {
      const parsed = JSON.parse(environment.TSUGITE_TOPVIEW_VIDEO_COMMAND);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(nonEmptyString)) return parsed;
    } catch {
      // Report the same safe invalid-request error below.
    }
    throw new AdapterError("TSUGITE_TOPVIEW_VIDEO_COMMAND must be a JSON command array", INVALID_REQUEST);
  }

  const script = discoverVideoScript();
  if (!script) {
    throw new AdapterError("Topview video_gen.py was not found", INVALID_REQUEST);
  }
  return [environment.TSUGITE_TOPVIEW_PYTHON || defaultTopviewPython(platform), script];
}

export function defaultTopviewPython(platform = process.platform) {
  return platform === "win32" ? "python" : "python3";
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

function discoverVideoScript() {
  const home = homedir();
  const direct = join(home, ".agents", "skills", "topview-skill", "scripts", "video_gen.py");
  if (existsSync(direct)) return direct;

  const cacheRoot = join(home, ".codex", "plugins", "cache", "local", "topview-ai");
  try {
    const versions = readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const version of versions) {
      const candidate = join(cacheRoot, version, "skills", "topview-skill", "scripts", "video_gen.py");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parsePayload(input) {
  if (!input || typeof input !== "object" || !input.request || typeof input.request !== "object") {
    throw new AdapterError("payload.request is required", INVALID_REQUEST);
  }
  if (!nonEmptyString(input.run_id) || !nonEmptyString(input.run_dir)) {
    throw new AdapterError("payload run identifiers are required", INVALID_REQUEST);
  }
  return input;
}

function generatedVideos(outputDir) {
  try {
    return readdirSync(outputDir)
      .filter((name) => /\.(mp4|mov|webm)$/i.test(name))
      .map((name) => resolve(outputDir, name))
      .filter((path) => statSync(path).isFile())
      .sort();
  } catch {
    return [];
  }
}

function probeMedia(path, request) {
  const fallback = fallbackResolution(request.aspect);
  const result = spawnSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate:format=duration",
    "-of", "json", path
  ], { encoding: "utf8", maxBuffer: MAX_OUTPUT });
  if (result.status !== 0) return { duration: request.duration, fps: 30, ...fallback };
  try {
    const parsed = JSON.parse(result.stdout);
    const stream = parsed.streams?.[0] ?? {};
    return {
      duration: Number(parsed.format?.duration) || request.duration,
      fps: parseRate(stream.r_frame_rate) || 30,
      width: Number(stream.width) || fallback.width,
      height: Number(stream.height) || fallback.height
    };
  } catch {
    return { duration: request.duration, fps: 30, ...fallback };
  }
}

function parseRate(value) {
  if (!nonEmptyString(value)) return undefined;
  const [numerator, denominator = "1"] = value.split("/").map(Number);
  const result = numerator / denominator;
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function fallbackResolution(aspect) {
  return aspect === "9:16" ? { width: 720, height: 1280 } : { width: 1280, height: 720 };
}

function parseJson(value, message) {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Normalize below.
  }
  throw new AdapterError(message, TRANSIENT);
}

function classifyFailure(status, message) {
  if (/rate.?limit|too many requests|429/i.test(message)) return RATE_LIMITED;
  if (/timeout|timed out/i.test(message)) return TRANSIENT;
  if (status === 2 || /invalid|argument|required|not found/i.test(message)) return INVALID_REQUEST;
  return TRANSIENT;
}

function numberParam(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function finiteNumber(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function soundEnabled(value) {
  return value === true || value === "on";
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stringValue(value) {
  return value === undefined || value === null ? undefined : String(value);
}

export class AdapterError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}
