import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { locateMediaUseSkill } from "./mediaUse.mjs";

const EXIT_TRANSIENT_EXTERNAL_FAILURE = 20;
const EXIT_MISSING_DEPENDENCY = 30;
const EXIT_INVALID_REQUEST = 40;
const MAX_OUTPUT = 1024 * 1024 * 20;

class AdapterError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

try {
  const payload = parsePayload(JSON.parse(await readStdin()));
  const skill = locateMediaUseSkill();
  if (!skill) fail("HyperFrames media-use skill is unavailable", EXIT_MISSING_DEPENDENCY);

  const workDir = join(payload.runDir, ".hyperframes-media");
  const requestPath = join(workDir, "audio-request.json");
  const metaPath = join(workDir, "audio-meta.json");
  const statusPath = join(workDir, "bgm-status.json");
  await mkdir(workDir, { recursive: true });

  const engineRequest = {
    provider: "auto",
    lines: payload.request.sfx.map((request) => ({
      id: request.id,
      text: "",
      sfx: [request.prompt]
    })),
    ...(payload.request.bgm ? {
      bgm: {
        mode: payload.request.bgm.mode,
        query: payload.request.bgm.query ?? payload.request.bgm.prompt,
        prompt: payload.request.bgm.prompt
      }
    } : { bgm: { mode: "none" } })
  };
  await writeFile(requestPath, `${JSON.stringify(engineRequest, null, 2)}\n`);
  await writeFile(metaPath, `${JSON.stringify(durationHint(payload.targetDurationSeconds), null, 2)}\n`);

  const environment = audioEnvironment(payload.request.params);
  const audioResult = spawnSync(process.execPath, [
    skill.audioScript,
    "--request", requestPath,
    "--hyperframes", payload.runDir,
    "--out", metaPath,
    "--only", "bgm,sfx"
  ], {
    cwd: payload.runDir,
    env: environment,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT
  });
  if (audioResult.error || audioResult.status !== 0) {
    fail("HyperFrames media-use audio engine failed", EXIT_TRANSIENT_EXTERNAL_FAILURE);
  }

  let meta = await readJson(metaPath, "audio metadata");
  if (meta.bgm_pending) {
    const timeoutMs = boundedTimeout(payload.request.params.bgm_timeout_ms);
    const waitResult = spawnSync(process.execPath, [
      skill.waitScript,
      "--audio-meta", metaPath,
      "--hyperframes", payload.runDir,
      "--out", statusPath,
      "--timeout-ms", String(timeoutMs)
    ], {
      cwd: payload.runDir,
      env: environment,
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT
    });
    if (waitResult.error || waitResult.status !== 0) {
      fail("HyperFrames BGM wait step failed", EXIT_TRANSIENT_EXTERNAL_FAILURE);
    }
    const status = existsSync(statusPath) ? await readJson(statusPath, "BGM status") : undefined;
    if (status && status.status !== "ready") {
      fail(`HyperFrames BGM was not ready (${status.status})`, EXIT_TRANSIENT_EXTERNAL_FAILURE);
    }
    meta = await readJson(metaPath, "audio metadata");
  }

  const bgm = payload.request.bgm ? await mapBgm(payload, meta) : undefined;
  const sfx = await mapSfx(payload, meta);
  process.stdout.write(`${JSON.stringify({
    credits: 0,
    ...(bgm ? { bgm } : {}),
    sfx,
    metadata: {
      provider: String(meta.bgm_provider ?? (sfx[0] ? "hyperframes-media-use" : "unknown")),
      bgm_mode: meta.bgm_mode ? String(meta.bgm_mode) : undefined,
      elevenlabs_used: false,
      fallback_used: false
    }
  })}\n`);
} catch (error) {
  if (error instanceof AdapterError) {
    console.error(error.message);
    process.exit(error.exitCode);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_INVALID_REQUEST);
}

function fail(message, exitCode) {
  throw new AdapterError(message, exitCode);
}

function parsePayload(input) {
  if (!input || typeof input !== "object") fail("audio payload must be an object", EXIT_INVALID_REQUEST);
  const runDir = requiredAbsolutePath(input.run_dir, "run_dir");
  const targetDurationSeconds = Number(input.target_duration_seconds);
  if (!Number.isFinite(targetDurationSeconds) || targetDurationSeconds <= 0) {
    fail("target_duration_seconds must be positive", EXIT_INVALID_REQUEST);
  }
  const request = input.request;
  if (!request || typeof request !== "object") fail("request must be an object", EXIT_INVALID_REQUEST);
  const bgm = request.bgm ? parseBgm(request.bgm) : undefined;
  const sfx = Array.isArray(request.sfx) ? request.sfx.map(parseSfx) : [];
  if (!bgm && sfx.length === 0) fail("request requires BGM or SFX", EXIT_INVALID_REQUEST);
  const params = request.params && typeof request.params === "object" && !Array.isArray(request.params)
    ? request.params
    : {};
  return { runDir, targetDurationSeconds, request: { bgm, sfx, params } };
}

function parseBgm(value) {
  const track = parseTrack(value, "bgm");
  if (value.mode !== "generate" && value.mode !== "retrieve") {
    fail("bgm.mode must be generate or retrieve", EXIT_INVALID_REQUEST);
  }
  return { ...track, mode: value.mode, query: optionalString(value.query) };
}

function parseSfx(value, index) {
  return parseTrack(value, `sfx[${index}]`);
}

function parseTrack(value, label) {
  if (!value || typeof value !== "object") fail(`${label} must be an object`, EXIT_INVALID_REQUEST);
  const id = requiredString(value.id, `${label}.id`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) fail(`${label}.id must be a safe id`, EXIT_INVALID_REQUEST);
  const prompt = requiredString(value.prompt, `${label}.prompt`);
  const start = value.start === undefined ? 0 : Number(value.start);
  const end = value.end === undefined ? undefined : Number(value.end);
  const volume = value.volume === undefined ? undefined : Number(value.volume);
  if (!Number.isFinite(start) || start < 0) fail(`${label}.start must be nonnegative`, EXIT_INVALID_REQUEST);
  if (end !== undefined && (!Number.isFinite(end) || end <= start)) fail(`${label}.end must be greater than start`, EXIT_INVALID_REQUEST);
  if (volume !== undefined && (!Number.isFinite(volume) || volume < 0 || volume > 1)) fail(`${label}.volume must be between 0 and 1`, EXIT_INVALID_REQUEST);
  return { id, prompt, start, end, volume };
}

function durationHint(durationSeconds) {
  return {
    voices: [{ id: "tsugite-duration-hint", path: "", duration_s: durationSeconds, words: [] }],
    sfx: [],
    bgm: null,
    bgm_pending: false
  };
}

function audioEnvironment(params) {
  const environment = { ...process.env };
  delete environment.ELEVENLABS_API_KEY;
  if (params.allow_cloud_bgm !== true) {
    delete environment.GEMINI_API_KEY;
    delete environment.GOOGLE_API_KEY;
  }
  return environment;
}

async function mapBgm(payload, meta) {
  const request = payload.request.bgm;
  const path = optionalString(meta.bgm?.path);
  if (!path) fail("requested BGM was not resolved", EXIT_TRANSIENT_EXTERNAL_FAILURE);
  const src = await guardedRunFile(payload.runDir, path, "BGM");
  const start = request.start;
  const availableDuration = positiveNumber(meta.bgm?.duration_s);
  const end = request.end ?? Math.min(payload.targetDurationSeconds, start + (availableDuration ?? payload.targetDurationSeconds));
  return {
    id: request.id,
    src,
    start,
    end,
    volume: request.volume ?? boundedVolume(meta.bgm?.volume, 0.2)
  };
}

async function mapSfx(payload, meta) {
  const available = new Map(
    (Array.isArray(meta.sfx) ? meta.sfx : []).map((entry) => [String(entry.id), entry])
  );
  const tracks = [];
  for (const request of payload.request.sfx) {
    const entry = available.get(request.id);
    if (!entry?.file) fail(`requested SFX was not resolved: ${request.id}`, EXIT_TRANSIENT_EXTERNAL_FAILURE);
    const src = await guardedRunFile(payload.runDir, String(entry.file), `SFX ${request.id}`);
    const start = request.start + (Number.isFinite(Number(entry.offset_s)) ? Number(entry.offset_s) : 0);
    const duration = positiveNumber(entry.duration_s);
    tracks.push({
      id: request.id,
      src,
      start,
      ...(request.end !== undefined ? { end: request.end } : duration ? { end: start + duration } : {}),
      volume: request.volume ?? boundedVolume(entry.volume, 0.35)
    });
  }
  return tracks;
}

async function guardedRunFile(runDir, path, label) {
  const candidate = isAbsolute(path) ? path : resolve(runDir, path);
  try {
    const [realRunDir, realCandidate] = await Promise.all([realpath(runDir), realpath(candidate)]);
    const fromRun = relative(realRunDir, realCandidate);
    if (fromRun.length === 0 || fromRun === ".." || fromRun.startsWith(`..${sep}`) || isAbsolute(fromRun)) {
      fail(`${label} must stay inside run_dir`, EXIT_INVALID_REQUEST);
    }
    return realCandidate;
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    fail(`${label} output is missing`, EXIT_TRANSIENT_EXTERNAL_FAILURE);
  }
}

function boundedTimeout(value) {
  const number = Number(value ?? 3_600_000);
  return Number.isFinite(number) ? Math.min(3_600_000, Math.max(1_000, Math.round(number))) : 3_600_000;
}

function boundedVolume(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : fallback;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function requiredAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) fail(`${label} must be an absolute path`, EXIT_INVALID_REQUEST);
  return resolve(value);
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`, EXIT_INVALID_REQUEST);
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`${label} is invalid`, EXIT_TRANSIENT_EXTERNAL_FAILURE);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
