import crossSpawn from "cross-spawn";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";

const spawnSync = crossSpawn.sync;

const EXIT_MISSING_DEPENDENCY = 30;
const EXIT_INVALID_REQUEST = 40;

try {
  const payload = JSON.parse(await readStdin());
  const request = requiredObject(payload.request, "request");
  const source = requiredObject(payload.source, "source");
  if (!["cut_points", "scene_observations"].includes(request.output)) {
    fail("local-media-analysis supports outputs: cut_points, scene_observations", EXIT_INVALID_REQUEST);
  }
  if (typeof source.path !== "string" || source.path.length === 0) {
    fail("source.path is required", EXIT_INVALID_REQUEST);
  }
  assertDirectMediaSource(source.path);

  const analysisStart = Number(source.analysis_start_seconds);
  const analysisEnd = Number(source.analysis_end_seconds);
  const duration = Number(source.duration_seconds);
  if (
    !Number.isFinite(analysisStart) ||
    !Number.isFinite(analysisEnd) ||
    !Number.isFinite(duration) ||
    analysisStart < 0 ||
    analysisEnd <= analysisStart ||
    duration <= 0
  ) {
    fail("source analysis range is invalid", EXIT_INVALID_REQUEST);
  }

  if (request.output === "scene_observations") {
    const runDir = requiredString(payload.run_dir, "run_dir");
    const requestId = requiredSafeId(request.id, "request.id");
    const threshold = boundedNumber(request.params?.scene_threshold, 0.3, 0.01, 0.99, "scene_threshold");
    const maxObservations = boundedInteger(
      request.params?.max_scene_observations,
      200,
      1,
      500,
      "max_scene_observations"
    );
    const boundaries = detectSceneBoundaries(source.path, threshold, analysisStart, analysisEnd);
    const intervals = sceneIntervals(boundaries, analysisStart, analysisEnd);
    if (intervals.length > maxObservations) {
      fail(
        `scene analysis found ${intervals.length} intervals, exceeding max_scene_observations=${maxObservations}`,
        EXIT_INVALID_REQUEST
      );
    }
    const frameDirectory = await prepareFrameDirectory(runDir);

    const observations = intervals.map((interval, index) => {
      const suffix = String(index + 1).padStart(4, "0");
      const timestamp = (interval.start + interval.end) / 2;
      const representativeFrame = `analysis/representative-frames/${requestId}-scene-${suffix}.jpg`;
      const frameBytes = extractRepresentativeFrame(source.path, timestamp);
      writeFrameAtomically(resolve(frameDirectory, `${requestId}-scene-${suffix}.jpg`), frameBytes);
      return {
        id: `${requestId}-scene-${suffix}`,
        source_start: interval.start,
        source_end: interval.end,
        description: `FFmpeg detected scene interval ${index + 1}.`,
        technical_notes: ["Local scene-change detection only; visual semantics were not inferred."],
        selection_reasons: ["Scene boundary and representative frame are available for human review."],
        confidence: 0.5,
        evidence: {
          representative_frame: representativeFrame,
          timestamp_seconds: timestamp
        }
      };
    });

    writeOutput({
      request,
      source,
      analysisStart,
      analysisEnd,
      duration,
      output: "scene_observations",
      data: { scene_observations: observations },
      engine: "ffmpeg-scenedetect",
      settings: { scene_threshold: threshold, max_scene_observations: maxObservations }
    });
    process.exit(0);
  }

  const noiseDb = boundedNumber(request.params?.silence_noise_db, -35, -80, -10, "silence_noise_db");
  const minimumDuration = boundedNumber(
    request.params?.silence_min_duration_seconds,
    0.5,
    0.1,
    10,
    "silence_min_duration_seconds"
  );
  const detected = detectSilence(source.path, noiseDb, minimumDuration, analysisStart, analysisEnd);
  const cutPoints = detected
    .map((range, index) => ({
      id: `silence-${String(index + 1).padStart(4, "0")}`,
      kind: "silence",
      source_start: clamp(range.start + analysisStart, analysisStart, analysisEnd),
      source_end: clamp(range.end + analysisStart, analysisStart, analysisEnd),
      action: "review",
      confidence: 1,
      reason: `FFmpeg silencedetect: noise=${noiseDb}dB, duration>=${minimumDuration}s`
    }))
    .filter((range) => range.source_end > range.source_start);

  writeOutput({
    request,
    source,
    analysisStart,
    analysisEnd,
    duration,
    output: "cut_points",
    data: { cut_points: cutPoints },
    engine: "ffmpeg-silencedetect",
    settings: { silence_noise_db: noiseDb, silence_min_duration_seconds: minimumDuration }
  });
} catch (error) {
  if (error?.handled) process.exit(error.exitCode);
  console.error("local media analysis failed");
  process.exit(EXIT_INVALID_REQUEST);
}

function detectSilence(sourcePath, noiseDb, minimumDuration, analysisStart, analysisEnd) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      sourcePath,
      "-vn",
      "-af",
      `atrim=start=${analysisStart}:end=${analysisEnd},asetpts=PTS-STARTPTS,silencedetect=noise=${noiseDb}dB:d=${minimumDuration}`,
      "-f",
      "null",
      "-"
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024 * 20 }
  );
  if (result.error?.code === "ENOENT") fail("ffmpeg is unavailable", EXIT_MISSING_DEPENDENCY);
  if (result.status !== 0) fail("ffmpeg silence analysis failed", EXIT_INVALID_REQUEST);
  return parseSilenceRanges(result.stderr);
}

function detectSceneBoundaries(sourcePath, threshold, analysisStart, analysisEnd) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      sourcePath,
      "-an",
      "-vf",
      `trim=start=${analysisStart}:end=${analysisEnd},setpts=PTS-STARTPTS,select=gt(scene\\,${threshold}),showinfo`,
      "-f",
      "null",
      "-"
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024 * 20 }
  );
  if (result.error?.code === "ENOENT") fail("ffmpeg is unavailable", EXIT_MISSING_DEPENDENCY);
  if (result.status !== 0) fail("ffmpeg scene analysis failed", EXIT_INVALID_REQUEST);
  return parseSceneBoundaries(result.stderr);
}

function parseSceneBoundaries(stderr) {
  const boundaries = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.includes("showinfo")) continue;
    const match = line.match(/\bpts_time:\s*([0-9]+(?:\.[0-9]+)?)/);
    if (match) boundaries.push(Number(match[1]));
  }
  return [...new Set(boundaries.filter(Number.isFinite))].sort((left, right) => left - right);
}

function sceneIntervals(relativeBoundaries, analysisStart, analysisEnd) {
  const boundaries = [
    analysisStart,
    ...relativeBoundaries
      .map((timestamp) => clamp(timestamp + analysisStart, analysisStart, analysisEnd))
      .filter((timestamp) => timestamp > analysisStart + 0.001 && timestamp < analysisEnd - 0.001),
    analysisEnd
  ];
  const unique = boundaries.filter((timestamp, index) => index === 0 || timestamp - boundaries[index - 1] > 0.001);
  return unique.slice(0, -1).map((start, index) => ({ start, end: unique[index + 1] }));
}

function extractRepresentativeFrame(sourcePath, timestamp) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-protocol_whitelist",
      "file,pipe",
      "-ss",
      String(timestamp),
      "-i",
      sourcePath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "pipe:1"
    ],
    { maxBuffer: 1024 * 1024 * 20 }
  );
  if (result.error?.code === "ENOENT") fail("ffmpeg is unavailable", EXIT_MISSING_DEPENDENCY);
  if (result.status !== 0) fail("ffmpeg representative frame extraction failed", EXIT_INVALID_REQUEST);
  if (!Buffer.isBuffer(result.stdout) || result.stdout.length === 0) {
    fail("ffmpeg returned an empty representative frame", EXIT_INVALID_REQUEST);
  }
  return result.stdout;
}

function parseSilenceRanges(stderr) {
  const ranges = [];
  let start;
  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch) start = Number(startMatch[1]);
    const endMatch = line.match(/silence_end:\s*([0-9.]+)/);
    if (endMatch && start !== undefined) {
      ranges.push({ start, end: Number(endMatch[1]) });
      start = undefined;
    }
  }
  return ranges;
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function requiredObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`, EXIT_INVALID_REQUEST);
  }
  return value;
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${name} is required`, EXIT_INVALID_REQUEST);
  }
  return value;
}

function requiredSafeId(value, name) {
  const id = requiredString(value, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    fail(`${name} must be a safe id`, EXIT_INVALID_REQUEST);
  }
  return id;
}

function boundedNumber(value, fallback, minimum, maximum, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    fail(`${name} must be between ${minimum} and ${maximum}`, EXIT_INVALID_REQUEST);
  }
  return number;
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const number = boundedNumber(value, fallback, minimum, maximum, name);
  if (!Number.isInteger(number)) {
    fail(`${name} must be an integer`, EXIT_INVALID_REQUEST);
  }
  return number;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function assertDirectMediaSource(path) {
  if (/\.(?:m3u8?|mpd|ffconcat|sdp|pls|ismc?)$/i.test(path)) {
    fail("playlist and indirect media sources are not allowed", EXIT_INVALID_REQUEST);
  }
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(descriptor).isFile()) {
      fail("source.path must be a regular file", EXIT_INVALID_REQUEST);
    }
    const prefix = Buffer.alloc(64 * 1024);
    const length = readSync(descriptor, prefix, 0, prefix.length, 0);
    const text = prefix.subarray(0, length).toString("utf8").trimStart();
    if (
      /^#EXTM3U(?:\r?\n|$)/i.test(text) ||
      /^ffconcat version(?:\s|$)/i.test(text) ||
      /^<\?xml[^>]*>\s*<MPD(?:\s|>)/i.test(text) ||
      /^<MPD(?:\s|>)/i.test(text) ||
      /^v=0\r?\n[\s\S]*^m=/m.test(text)
    ) {
      fail("playlist and indirect media sources are not allowed", EXIT_INVALID_REQUEST);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function prepareFrameDirectory(runDir) {
  const root = resolve(runDir);
  await mkdir(root, { recursive: true });
  const canonicalRoot = realpathSync(root);
  if (!statSync(canonicalRoot).isDirectory()) {
    fail("run_dir must be a directory", EXIT_INVALID_REQUEST);
  }
  const analysisDirectory = await ensureContainedDirectory(canonicalRoot, resolve(canonicalRoot, "analysis"));
  return ensureContainedDirectory(canonicalRoot, resolve(analysisDirectory, "representative-frames"));
}

async function ensureContainedDirectory(canonicalRoot, path) {
  try {
    const entry = lstatSync(path);
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      fail("representative frame directory must be a directory", EXIT_INVALID_REQUEST);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    try {
      await mkdir(path);
    } catch (mkdirError) {
      if (mkdirError?.code !== "EEXIST") throw mkdirError;
    }
  }
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory() || !canonical.startsWith(`${canonicalRoot}${sep}`)) {
    fail("representative frame directory must stay inside run_dir", EXIT_INVALID_REQUEST);
  }
  return canonical;
}

function writeFrameAtomically(destination, content) {
  const temporary = resolve(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    let offset = 0;
    while (offset < content.length) {
      offset += writeSync(descriptor, content, offset, content.length - offset);
    }
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created or may already have been renamed.
    }
    fail("representative frame could not be written safely", EXIT_INVALID_REQUEST);
  }
}

function writeOutput({ request, source, analysisStart, analysisEnd, duration, output, data, engine, settings }) {
  process.stdout.write(
    `${JSON.stringify({
      schema_version: 1,
      request_id: request.id,
      output,
      source: {
        clip_id: source.clip_id,
        analysis_start_seconds: analysisStart,
        analysis_end_seconds: analysisEnd,
        duration_seconds: duration,
        sha256: source.sha256
      },
      data,
      metadata: {
        engine,
        api_used: false,
        network_used: false,
        settings
      }
    })}\n`
  );
}

function fail(message, exitCode) {
  console.error(message);
  throw { handled: true, exitCode };
}
