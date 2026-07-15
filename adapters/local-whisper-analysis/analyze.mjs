import { createHash } from "node:crypto";
import {
  createReadStream,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const EXIT_DEPENDENCY_MISSING = 30;
const EXIT_INVALID_REQUEST = 40;
const EXIT_EXECUTION_FAILED = 50;
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_WHISPER_BUFFER = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const SUPPORTED_OUTPUTS = new Set(["transcript", "cut_points", "chapters", "summary", "subtitle_track"]);
const DEFAULT_FILLERS = ["えー", "えっと", "あの", "その", "まあ", "なんか"];

try {
  const payload = JSON.parse(await readStdin());
  const request = requireRecord(payload.request, "request is required");
  const source = normalizeSource(payload.source);
  const requestId = requireText(request.id, "request.id is required");
  const output = requireText(request.output, "request.output is required");
  const params = isRecord(request.params) ? request.params : {};

  if (!SUPPORTED_OUTPUTS.has(output)) fail("unsupported local Whisper analysis output", EXIT_INVALID_REQUEST);

  const base = {
    schema_version: 1,
    request_id: requestId,
    output,
    source: publicSource(source)
  };

  if (output === "transcript" || output === "subtitle_track") {
    const result = await createWhisperOutput(output, params, source, payload.inputs);
    writeResult({ ...base, data: result.data, metadata: result.metadata });
  } else {
    const transcript = transcriptDependency(payload.inputs);
    if (!transcript) fail(`${output} requires a transcript dependency`, EXIT_INVALID_REQUEST);
    const data = createDeterministicOutput(output, params, source, transcript);
    const dependencyMetadata = transcriptDependencyMetadata(payload.inputs);
    writeResult({
      ...base,
      data,
      metadata: {
        engine: "local-transcript-rules",
        api_used: false,
        network_used: false,
        deterministic: true,
        ...(dependencyMetadata?.model_sha256 ? { model_sha256: dependencyMetadata.model_sha256 } : {})
      }
    });
  }
} catch (error) {
  if (isHandledError(error)) {
    process.stderr.write(`${error.message}\n`);
    process.exit(error.exitCode);
  }
  process.stderr.write("local Whisper analysis failed\n");
  process.exit(EXIT_EXECUTION_FAILED);
}

async function createWhisperOutput(output, params, source, inputs) {
  const modelPath = localModelPath(params.model_path);
  const expectedSha = requiredSha256(params.model_sha256);
  const modelSha256 = await sha256File(modelPath);
  if (expectedSha !== modelSha256) fail("model SHA-256 does not match model_sha256", EXIT_INVALID_REQUEST);

  const language = languageCode(params.language ?? "ja", "language");
  const targetLanguage = output === "subtitle_track"
    ? languageCode(params.target_language ?? "en", "target_language")
    : undefined;
  if (targetLanguage && targetLanguage !== "en") {
    fail("local Whisper translation supports target_language: en only", EXIT_INVALID_REQUEST);
  }
  const sourceTranscript = output === "subtitle_track" ? transcriptDependency(inputs) : undefined;
  if (output === "subtitle_track" && !sourceTranscript) {
    fail("subtitle_track requires a transcript dependency", EXIT_INVALID_REQUEST);
  }
  if (sourceTranscript && languageCode(sourceTranscript.language, "transcript language") !== language) {
    fail("subtitle source language must match its transcript dependency", EXIT_INVALID_REQUEST);
  }

  const noSpeechThreshold = boundedNumber(params.no_speech_threshold, 0.8, 0, 1, "no_speech_threshold");
  const timeoutMs = boundedNumber(params.timeout_ms, DEFAULT_TIMEOUT_MS, 1_000, DEFAULT_TIMEOUT_MS, "timeout_ms");
  const device = whisperDevice(params.device);
  const whisper = runWhisper({
    source,
    modelPath,
    language,
    task: output === "subtitle_track" ? "translate" : "transcribe",
    timeoutMs,
    device
  });
  const normalized = normalizeWhisperSegments(whisper.segments, source, noSpeechThreshold);
  const resultLanguage = typeof whisper.language === "string" && whisper.language.trim()
    ? whisper.language.trim()
    : language;

  const metadata = {
    engine: "local-whisper-cli",
    api_used: false,
    network_used: false,
    model_sha256: modelSha256,
    filtered_no_speech_segments: normalized.filtered,
    source_language: resultLanguage,
    task: output === "subtitle_track" ? "translate" : "transcribe"
  };

  if (output === "subtitle_track") {
    const transcriptSegments = normalizeDependencySegments(sourceTranscript.segments, source);
    return {
      data: {
        source_language: sourceTranscript.language,
        target_language: "en",
        captions: translatedCaptions(normalized.segments, transcriptSegments)
      },
      metadata
    };
  }

  return {
    data: {
      language: resultLanguage,
      segments: normalized.segments.map((segment, index) => ({
        id: numberedId("segment", index),
        source_start: segment.source_start,
        source_end: segment.source_end,
        text: segment.text,
        ...(segment.confidence === undefined ? {} : { confidence: segment.confidence }),
        words: segment.words
      }))
    },
    metadata
  };
}

function translatedCaptions(translatedSegments, transcriptSegments) {
  const captions = [];
  for (const translated of translatedSegments) {
    const sourceSegment = transcriptSegments
      .map((segment) => ({
        segment,
        overlap: Math.max(0, Math.min(segment.source_end, translated.source_end) - Math.max(segment.source_start, translated.source_start))
      }))
      .sort((left, right) => right.overlap - left.overlap)[0];
    if (!sourceSegment || sourceSegment.overlap <= 0) continue;
    const sourceStart = Math.max(translated.source_start, sourceSegment.segment.source_start);
    const sourceEnd = Math.min(translated.source_end, sourceSegment.segment.source_end);
    if (sourceEnd <= sourceStart) continue;
    captions.push({
      id: numberedId("caption", captions.length),
      source_segment_id: sourceSegment.segment.id,
      source_start: sourceStart,
      source_end: sourceEnd,
      text: translated.text
    });
  }
  return captions;
}

function runWhisper({ source, modelPath, language, task, timeoutMs, device }) {
  const workDir = mkdtempSync(join(tmpdir(), "tsugite-local-whisper-"));
  try {
    const audioPath = join(workDir, "source.wav");
    extractLocalAudio(source, audioPath, timeoutMs);
    const args = [
      audioPath,
      "--model", modelPath,
      "--language", language,
      "--task", task,
      "--word_timestamps", "True",
      "--output_format", "json",
      "--output_dir", workDir,
      "--verbose", "False",
      "--fp16", "False",
      "--device", device
    ];
    const execution = spawnSync("whisper", args, {
      cwd: workDir,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: MAX_WHISPER_BUFFER,
      env: offlineEnvironment(process.env),
      shell: false
    });
    if (execution.error?.code === "ENOENT") fail("local Whisper CLI is not installed", EXIT_DEPENDENCY_MISSING);
    if (execution.error?.code === "ETIMEDOUT") fail("local Whisper CLI timed out", EXIT_EXECUTION_FAILED);
    if (execution.error) fail("local Whisper CLI could not be started", EXIT_EXECUTION_FAILED);
    if (execution.status !== 0) fail("local Whisper CLI failed", EXIT_EXECUTION_FAILED);

    const outputs = readdirSync(workDir).filter((name) => extname(name).toLowerCase() === ".json");
    if (outputs.length !== 1) fail("local Whisper CLI did not produce one JSON result", EXIT_EXECUTION_FAILED);
    const parsed = JSON.parse(readFileSync(join(workDir, outputs[0]), "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.segments)) {
      fail("local Whisper CLI returned invalid JSON", EXIT_EXECUTION_FAILED);
    }
    return parsed;
  } catch (error) {
    if (isHandledError(error)) throw error;
    fail("local Whisper CLI returned invalid JSON", EXIT_EXECUTION_FAILED);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function extractLocalAudio(source, audioPath, timeoutMs) {
  const args = [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    "-protocol_whitelist", "file,pipe",
    "-i", source.path,
    "-ss", String(source.analysis_start_seconds),
    "-t", String(source.analysis_end_seconds - source.analysis_start_seconds),
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "pcm_s16le",
    "-y",
    audioPath
  ];
  const execution = spawnSync("ffmpeg", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_WHISPER_BUFFER,
    env: offlineEnvironment(process.env),
    shell: false
  });
  if (execution.error?.code === "ENOENT") fail("FFmpeg is not installed", EXIT_DEPENDENCY_MISSING);
  if (execution.error?.code === "ETIMEDOUT") fail("FFmpeg audio extraction timed out", EXIT_EXECUTION_FAILED);
  if (execution.error || execution.status !== 0) fail("FFmpeg audio extraction failed", EXIT_EXECUTION_FAILED);
  try {
    if (!statSync(audioPath).isFile()) throw new Error("not a file");
  } catch {
    fail("FFmpeg did not produce local audio", EXIT_EXECUTION_FAILED);
  }
}

function normalizeWhisperSegments(segments, source, noSpeechThreshold) {
  const kept = [];
  let filtered = 0;
  for (const segment of segments) {
    if (!isRecord(segment)) continue;
    const noSpeech = finiteNumber(segment.no_speech_prob);
    if (noSpeech !== undefined && noSpeech >= noSpeechThreshold) {
      filtered += 1;
      continue;
    }
    const text = typeof segment.text === "string" ? segment.text.trim() : "";
    const start = clampedWhisperTimestamp(segment.start, source);
    const end = clampedWhisperTimestamp(segment.end, source);
    if (!text || start === undefined || end === undefined || end <= start) continue;
    const words = Array.isArray(segment.words)
      ? segment.words.flatMap((word) => normalizeWhisperWord(word, source))
      : [];
    kept.push({
      source_start: start,
      source_end: end,
      text,
      words,
      confidence: logProbabilityConfidence(segment.avg_logprob)
    });
  }
  return { segments: kept, filtered };
}

function normalizeWhisperWord(word, source) {
  if (!isRecord(word)) return [];
  const text = typeof word.word === "string" ? word.word.trim() : "";
  const start = clampedWhisperTimestamp(word.start, source);
  const end = clampedWhisperTimestamp(word.end, source);
  if (!text || start === undefined || end === undefined || end <= start) return [];
  const confidence = finiteNumber(word.probability);
  return [{
    text,
    source_start: start,
    source_end: end,
    ...(confidence === undefined ? {} : { confidence: clamp(confidence, 0, 1) })
  }];
}

function createDeterministicOutput(output, params, source, transcript) {
  const segments = normalizeDependencySegments(transcript.segments, source);
  if (output === "cut_points") return { cut_points: fillerCutPoints(segments, params) };
  if (output === "chapters") return { chapters: transcriptChapters(segments, params, source) };
  return {
    language: languageCode(transcript.language ?? "und", "transcript language"),
    summaries: transcriptSummaries(segments, params, source)
  };
}

function fillerCutPoints(segments, params) {
  const requested = Array.isArray(params.filler_words) ? params.filler_words : DEFAULT_FILLERS;
  const fillers = new Set(requested.filter((word) => typeof word === "string").map(normalizeFiller).filter(Boolean));
  const cutPoints = [];
  for (const segment of segments) {
    for (const word of segment.words) {
      if (!fillers.has(normalizeFiller(word.text))) continue;
      cutPoints.push({
        id: numberedId("filler", cutPoints.length),
        kind: "filler",
        source_start: word.source_start,
        source_end: word.source_end,
        action: "review",
        ...(word.confidence === undefined ? {} : { confidence: word.confidence }),
        evidence: { transcript_segment_id: segment.id, matched_text: word.text }
      });
    }
  }
  return cutPoints;
}

function transcriptChapters(segments, params, source) {
  const seconds = boundedNumber(params.chapter_seconds, 300, 30, 3600, "chapter_seconds");
  return groupSegments(segments, seconds, source).map((group, index) => ({
    id: numberedId("chapter", index),
    source_start: group[0].source_start,
    source_end: group.at(-1).source_end,
    title: titleFromText(group[0].text)
  }));
}

function transcriptSummaries(segments, params, source) {
  const seconds = boundedNumber(params.summary_seconds, 300, 30, 3600, "summary_seconds");
  return groupSegments(segments, seconds, source).map((group, index) => ({
    id: numberedId("summary", index),
    source_start: group[0].source_start,
    source_end: group.at(-1).source_end,
    text: group.map((segment) => segment.text).join("")
  }));
}

function groupSegments(segments, seconds, source) {
  const groups = new Map();
  for (const segment of segments) {
    const index = Math.floor((segment.source_start - source.analysis_start_seconds) / seconds);
    const group = groups.get(index) ?? [];
    group.push(segment);
    groups.set(index, group);
  }
  return [...groups.entries()].sort(([left], [right]) => left - right).map(([, group]) => group);
}

function normalizeDependencySegments(value, source) {
  if (!Array.isArray(value)) fail("transcript dependency has invalid segments", EXIT_INVALID_REQUEST);
  const normalized = [];
  for (const [index, segment] of value.entries()) {
    if (!isRecord(segment)) fail("transcript dependency has invalid segments", EXIT_INVALID_REQUEST);
    const id = requireText(segment.id, "transcript segment id is required");
    const text = requireText(segment.text, "transcript segment text is required");
    const sourceStart = dependencyTimestamp(segment.source_start, source);
    const sourceEnd = dependencyTimestamp(segment.source_end, source);
    if (sourceEnd <= sourceStart) fail("transcript dependency has invalid timestamps", EXIT_INVALID_REQUEST);
    const words = Array.isArray(segment.words)
      ? segment.words.map((word) => normalizeDependencyWord(word, source))
      : [];
    normalized.push({ id: id || `segment-${index}`, text, source_start: sourceStart, source_end: sourceEnd, words });
  }
  return normalized.sort((left, right) => left.source_start - right.source_start);
}

function normalizeDependencyWord(value, source) {
  if (!isRecord(value)) fail("transcript dependency has an invalid word", EXIT_INVALID_REQUEST);
  const text = requireText(value.text, "transcript word text is required");
  const sourceStart = dependencyTimestamp(value.source_start, source);
  const sourceEnd = dependencyTimestamp(value.source_end, source);
  if (sourceEnd <= sourceStart) fail("transcript dependency has invalid word timestamps", EXIT_INVALID_REQUEST);
  const confidence = finiteNumber(value.confidence);
  return {
    text,
    source_start: sourceStart,
    source_end: sourceEnd,
    ...(confidence === undefined ? {} : { confidence: clamp(confidence, 0, 1) })
  };
}

function transcriptDependency(inputs) {
  const candidate = transcriptCandidate(inputs);
  return isRecord(candidate) && Array.isArray(candidate.segments) ? candidate : undefined;
}

function transcriptDependencyMetadata(inputs) {
  if (!isRecord(inputs)) return undefined;
  const input = inputs.transcript;
  return isRecord(input) && isRecord(input.metadata) ? input.metadata : undefined;
}

function transcriptCandidate(inputs) {
  if (Array.isArray(inputs)) {
    const entry = inputs.find((item) => isRecord(item) && item.output === "transcript");
    return isRecord(entry) && isRecord(entry.data) ? entry.data : undefined;
  }
  if (!isRecord(inputs)) return undefined;
  const input = inputs.transcript;
  if (!isRecord(input)) return undefined;
  if (input.output === "transcript" && isRecord(input.data)) return input.data;
  if (isRecord(input.data) && isRecord(input.data.transcript)) return input.data.transcript;
  if (isRecord(input.transcript)) return input.transcript;
  return input;
}

function normalizeSource(value) {
  const source = requireRecord(value, "source is required");
  const clipId = requireText(source.clip_id, "source.clip_id is required");
  const sourcePath = requireText(source.path, "source.path is required");
  let realPath;
  try {
    realPath = realpathSync(isAbsolute(sourcePath) ? sourcePath : resolve(sourcePath));
    if (!statSync(realPath).isFile()) throw new Error("not a file");
  } catch {
    fail("source.path must point to an existing regular local file", EXIT_INVALID_REQUEST);
  }
  const start = finiteNumber(source.analysis_start_seconds);
  const end = finiteNumber(source.analysis_end_seconds);
  const duration = finiteNumber(source.duration_seconds);
  if (start === undefined || start < 0 || end === undefined || end <= start || duration === undefined || duration <= 0) {
    fail("source timestamps are invalid", EXIT_INVALID_REQUEST);
  }
  const sha256 = typeof source.sha256 === "string" && /^[a-f0-9]{64}$/.test(source.sha256)
    ? source.sha256
    : fail("source.sha256 is invalid", EXIT_INVALID_REQUEST);
  return {
    clip_id: clipId,
    path: realPath,
    analysis_start_seconds: start,
    analysis_end_seconds: end,
    duration_seconds: duration,
    sha256
  };
}

function publicSource(source) {
  return {
    clip_id: source.clip_id,
    analysis_start_seconds: source.analysis_start_seconds,
    analysis_end_seconds: source.analysis_end_seconds,
    duration_seconds: source.duration_seconds,
    sha256: source.sha256
  };
}

function localModelPath(value) {
  if (typeof value !== "string" || !value.trim()) {
    fail("model_path must point to an existing local .pt file", EXIT_INVALID_REQUEST);
  }
  try {
    const path = realpathSync(isAbsolute(value) ? value : resolve(value));
    if (extname(path).toLowerCase() !== ".pt" || !statSync(path).isFile()) throw new Error("invalid model");
    return path;
  } catch {
    fail("model_path must point to an existing local .pt file", EXIT_INVALID_REQUEST);
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function requiredSha256(value) {
  if (value === undefined) {
    fail("model_sha256 is required for local .pt models", EXIT_INVALID_REQUEST);
  }
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("model_sha256 must be a lowercase SHA-256 digest", EXIT_INVALID_REQUEST);
  }
  return value;
}

function whisperDevice(value) {
  if (value === undefined) return "cpu";
  if (typeof value === "string" && /^(cpu|mps|cuda(?::[0-9]+)?)$/.test(value)) return value;
  fail("device must be cpu, mps, cuda, or cuda:<index>", EXIT_INVALID_REQUEST);
}

function languageCode(value, field) {
  if (typeof value === "string" && /^(und|[a-z]{2,3}(?:-[A-Z]{2})?)$/.test(value)) return value;
  fail(`${field} must be a language code`, EXIT_INVALID_REQUEST);
}

function dependencyTimestamp(value, source) {
  const timestamp = finiteNumber(value);
  if (timestamp === undefined || timestamp < source.analysis_start_seconds || timestamp > source.analysis_end_seconds) {
    fail("transcript dependency timestamp is outside the source range", EXIT_INVALID_REQUEST);
  }
  return timestamp;
}

function clampedWhisperTimestamp(value, source) {
  const timestamp = finiteNumber(value);
  return timestamp === undefined
    ? undefined
    : clamp(timestamp + source.analysis_start_seconds, source.analysis_start_seconds, source.analysis_end_seconds);
}

function logProbabilityConfidence(value) {
  const averageLogProbability = finiteNumber(value);
  return averageLogProbability === undefined ? undefined : clamp(Math.exp(averageLogProbability), 0, 1);
}

function titleFromText(value) {
  const title = value.trim().replace(/[。．.!！?？]+$/u, "");
  return [...title].slice(0, 40).join("") || "Untitled chapter";
}

function normalizeFiller(value) {
  return typeof value === "string" ? value.trim().replace(/[\s、。，,.!！?？]+/gu, "") : "";
}

function boundedNumber(value, fallback, minimum, maximum, field) {
  if (value === undefined) return fallback;
  const number = finiteNumber(value);
  if (number === undefined || number < minimum || number > maximum) {
    fail(`${field} must be between ${minimum} and ${maximum}`, EXIT_INVALID_REQUEST);
  }
  return number;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberedId(prefix, index) {
  return `${prefix}-${String(index + 1).padStart(4, "0")}`;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function requireRecord(value, message) {
  if (!isRecord(value)) fail(message, EXIT_INVALID_REQUEST);
  return value;
}

function requireText(value, message) {
  if (typeof value !== "string" || !value.trim()) fail(message, EXIT_INVALID_REQUEST);
  return value.trim();
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function offlineEnvironment(environment) {
  const allowed = new Set([
    "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
    "LANG", "LC_ALL", "LC_CTYPE", "TZ"
  ]);
  return Object.fromEntries(Object.entries(environment).filter(([key]) => allowed.has(key.toUpperCase())));
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > MAX_INPUT_BYTES) fail("analysis input is too large", EXIT_INVALID_REQUEST);
  }
  return input;
}

function writeResult(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message, exitCode) {
  throw { handled: true, message, exitCode };
}

function isHandledError(value) {
  return isRecord(value) && value.handled === true && typeof value.message === "string" && Number.isInteger(value.exitCode);
}
