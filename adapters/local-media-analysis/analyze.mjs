import { spawnSync } from "node:child_process";

const EXIT_MISSING_DEPENDENCY = 30;
const EXIT_INVALID_REQUEST = 40;

try {
  const payload = JSON.parse(await readStdin());
  const request = requiredObject(payload.request, "request");
  const source = requiredObject(payload.source, "source");
  if (request.output !== "cut_points") {
    fail("local-media-analysis currently supports output: cut_points only", EXIT_INVALID_REQUEST);
  }
  if (typeof source.path !== "string" || source.path.length === 0) {
    fail("source.path is required", EXIT_INVALID_REQUEST);
  }

  const noiseDb = boundedNumber(request.params?.silence_noise_db, -35, -80, -10, "silence_noise_db");
  const minimumDuration = boundedNumber(
    request.params?.silence_min_duration_seconds,
    0.5,
    0.1,
    10,
    "silence_min_duration_seconds"
  );
  const analysisStart = Number(source.analysis_start_seconds);
  const analysisEnd = Number(source.analysis_end_seconds);
  const detected = detectSilence(source.path, noiseDb, minimumDuration, analysisStart, analysisEnd);
  const duration = Number(source.duration_seconds);
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

  process.stdout.write(
    `${JSON.stringify({
      schema_version: 1,
      request_id: request.id,
      output: "cut_points",
      source: {
        clip_id: source.clip_id,
        analysis_start_seconds: analysisStart,
        analysis_end_seconds: analysisEnd,
        duration_seconds: duration,
        sha256: source.sha256
      },
      data: { cut_points: cutPoints },
      metadata: {
        engine: "ffmpeg-silencedetect",
        api_used: false,
        network_used: false,
        settings: { silence_noise_db: noiseDb, silence_min_duration_seconds: minimumDuration }
      }
    })}\n`
  );
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

function boundedNumber(value, fallback, minimum, maximum, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    fail(`${name} must be between ${minimum} and ${maximum}`, EXIT_INVALID_REQUEST);
  }
  return number;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function fail(message, exitCode) {
  console.error(message);
  throw { handled: true, exitCode };
}
