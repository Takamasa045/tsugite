import { createHash } from "node:crypto";
import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODELS = new Set(["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"]);
const MAX_PROMPT_BYTES = 16_000;
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_VOICE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SAFE_SPEAKER = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export class GeminiTtsError extends Error {
  constructor(message, exitCode = 40) {
    super(message);
    this.name = "GeminiTtsError";
    this.exitCode = exitCode;
  }
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function plainString(value, label, maxLength = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new GeminiTtsError(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
}

function prebuiltVoice(value) {
  const voice = plainString(value, "voice", 64);
  if (!SAFE_VOICE.test(voice) || voice.startsWith("voice_") || voice.startsWith("voicekey_")) {
    throw new GeminiTtsError("voice must be a prebuilt Gemini voice name");
  }
  return voice;
}

export function buildGeminiTtsRequest(request) {
  if (!object(request) || !SAFE_ID.test(request.id ?? "") || request.operation !== "voice") {
    throw new GeminiTtsError("a safe voice generation request is required");
  }
  if (!MODELS.has(request.model)) throw new GeminiTtsError("unsupported Gemini TTS model");
  if (typeof request.prompt !== "string" || !request.prompt.trim()
    || Buffer.byteLength(request.prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new GeminiTtsError("prompt must contain the exact spoken text within 16000 UTF-8 bytes");
  }
  if (request.input_audios?.length || request.input_images?.length || request.input_videos?.length
    || request.first_frame || request.last_frame || request.reference_images?.length) {
    throw new GeminiTtsError("Gemini TTS accepts text only");
  }
  const params = request.params ?? {};
  if (!object(params)) throw new GeminiTtsError("params must be an object");
  const permitted = new Set(["voice_id", "style", "speakers", "turn_styles", "start", "end", "volume"]);
  for (const key of Object.keys(params)) {
    if (!permitted.has(key)) throw new GeminiTtsError(`unsupported Gemini TTS parameter '${key}'`);
  }

  let content;
  let speechConfig;
  if (params.speakers !== undefined) {
    if (!Array.isArray(params.speakers) || params.speakers.length !== 2 || params.voice_id !== undefined
      || params.style !== undefined) {
      throw new GeminiTtsError("two-speaker TTS requires exactly two speakers and no single-speaker voice/style");
    }
    const speakers = params.speakers.map((entry) => {
      if (!object(entry) || Object.keys(entry).some((key) => !["speaker", "voice"].includes(key))) {
        throw new GeminiTtsError("each speaker requires only speaker and voice");
      }
      const speaker = plainString(entry.speaker, "speaker", 32);
      if (!SAFE_SPEAKER.test(speaker)) throw new GeminiTtsError("speaker must be a simple name");
      return { speaker, voice: prebuiltVoice(entry.voice) };
    });
    if (speakers[0].speaker === speakers[1].speaker) throw new GeminiTtsError("speaker names must differ");
    const turns = request.prompt.trim().split(/\r?\n/).map((line) => {
      const match = /^([A-Za-z][A-Za-z0-9_-]{0,31}):\s*(\S.*)$/.exec(line.trim());
      if (!match || !speakers.some((speaker) => speaker.speaker === match[1])) {
        throw new GeminiTtsError("each dialogue line must start with a declared Speaker: name");
      }
      return { speaker: match[1], text: match[2] };
    });
    if (turns.length < 2 || !speakers.every((speaker) => turns.some((turn) => turn.speaker === speaker.speaker))) {
      throw new GeminiTtsError("dialogue must contain a turn for each speaker");
    }
    if (turns.length > 80) throw new GeminiTtsError("dialogue exceeds 80 turns");
    if (params.turn_styles !== undefined && (!Array.isArray(params.turn_styles)
      || params.turn_styles.length !== turns.length)) {
      throw new GeminiTtsError("turn_styles must have one entry per dialogue line");
    }
    content = turns.map((turn, index) => ({
      type: "text",
      text: turn.text,
      annotations: [{
        type: "speech_metadata",
        speaker: turn.speaker,
        ...(params.turn_styles ? { style: plainString(params.turn_styles[index], "turn style") } : {})
      }]
    }));
    speechConfig = { mode: "conversational", speakers };
  } else {
    if (params.turn_styles !== undefined) throw new GeminiTtsError("turn_styles requires two speakers");
    const voice = prebuiltVoice(params.voice_id);
    content = [{
      type: "text",
      text: request.prompt.trim(),
      ...(params.style ? { annotations: [{ type: "speech_metadata", style: plainString(params.style, "style") }] } : {})
    }];
    speechConfig = [{ voice }];
  }

  for (const key of ["start", "end", "volume"]) {
    if (params[key] !== undefined && (typeof params[key] !== "number" || !Number.isFinite(params[key]))) {
      throw new GeminiTtsError(`${key} must be a finite number`);
    }
  }
  if (params.start !== undefined && params.start < 0) throw new GeminiTtsError("start must be nonnegative");
  if (params.end !== undefined && (params.end <= (params.start ?? 0))) throw new GeminiTtsError("end must exceed start");
  if (params.volume !== undefined && (params.volume < 0 || params.volume > 1)) {
    throw new GeminiTtsError("volume must be between 0 and 1");
  }

  return {
    model: request.model,
    input: [{ type: "user_input", content }],
    response_format: { type: "audio", mime_type: "audio/wav", delivery: "inline" },
    generation_config: { speech_config: speechConfig },
    store: false
  };
}

async function boundedResponse(response) {
  const claimed = Number(response.headers.get("content-length"));
  if (Number.isFinite(claimed) && claimed > MAX_RESPONSE_BYTES) {
    throw new GeminiTtsError("Gemini TTS response exceeds the size limit", 50);
  }
  if (!response.body) throw new GeminiTtsError("Gemini TTS response has no body", 50);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new GeminiTtsError("Gemini TTS response exceeds the size limit", 50);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GeminiTtsError("Gemini TTS returned invalid JSON", 50);
  }
}

function wavFromInteraction(interaction) {
  if (!object(interaction) || interaction.status !== "completed") {
    throw new GeminiTtsError("Gemini TTS did not complete", 50);
  }
  const audioBlocks = (interaction.steps ?? [])
    .filter((step) => step?.type === "model_output")
    .flatMap((step) => Array.isArray(step.content) ? step.content : [])
    .filter((content) => content?.type === "audio");
  if (audioBlocks.length === 0 && object(interaction.output_audio)) audioBlocks.push(interaction.output_audio);
  if (audioBlocks.length !== 1 || (audioBlocks[0].mime_type && audioBlocks[0].mime_type !== "audio/wav")
    || typeof audioBlocks[0].data !== "string") {
    throw new GeminiTtsError("Gemini TTS did not return one inline WAV audio block", 50);
  }
  const data = audioBlocks[0].data;
  if (data.length > Math.ceil(MAX_AUDIO_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new GeminiTtsError("Gemini TTS audio encoding is invalid or too large", 50);
  }
  const wav = Buffer.from(data, "base64");
  if (wav.length <= 44 || wav.length > MAX_AUDIO_BYTES || wav.toString("ascii", 0, 4) !== "RIFF"
    || wav.toString("ascii", 8, 12) !== "WAVE" || wav.readUInt32LE(4) + 8 > wav.length) {
    throw new GeminiTtsError("Gemini TTS returned invalid WAV audio", 50);
  }
  return wav;
}

export async function runGeminiTts(payload, options = {}) {
  const request = payload?.request;
  const body = buildGeminiTtsRequest(request);
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new GeminiTtsError("GEMINI_API_KEY is not configured");
  if (typeof payload.run_dir !== "string" || !payload.run_dir || !SAFE_ID.test(payload.run_id ?? "")) {
    throw new GeminiTtsError("run directory and run id are required");
  }
  const directory = resolve(payload.run_dir, "generated", request.id);
  const output = resolve(directory, "speech.wav");
  const digestPath = resolve(directory, "request.sha256");
  const submissionPath = resolve(directory, "submission.sha256");
  const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const previous = await Promise.allSettled([readFile(digestPath, "utf8"), stat(output), readFile(submissionPath, "utf8")]);
  const hasDigest = previous[0].status === "fulfilled";
  const hasAudio = previous[1].status === "fulfilled";
  if (hasDigest || hasAudio) {
    if (!hasDigest || !hasAudio || !previous[1].value.isFile()
      || previous[0].value.trim() !== digest || previous[1].value.size < 44
      || previous[2].status !== "fulfilled" || previous[2].value.trim() !== digest) {
      throw new GeminiTtsError("existing Gemini TTS output is incomplete or belongs to a different request");
    }
    return result(request, output, true);
  }
  if (previous[2].status === "fulfilled") {
    throw new GeminiTtsError("previous Gemini TTS submission outcome is unknown; inspect provider usage before retrying", 50);
  }
  if (previous.some((item) => item.status === "rejected" && item.reason?.code !== "ENOENT")) {
    throw new GeminiTtsError("existing Gemini TTS output could not be inspected", 50);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  let response;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(submissionPath, `${digest}\n`, { flag: "wx", mode: 0o600 });
  } catch {
    throw new GeminiTtsError("Gemini TTS submission record could not be created; inspect the run before retrying", 50);
  }
  try {
    response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch {
    throw new GeminiTtsError("Gemini TTS submission outcome is unknown; inspect provider usage before retrying", 50);
  }
  if (!response.ok) throw new GeminiTtsError(`Gemini TTS request failed with HTTP ${response.status}`, 50);
  const wav = wavFromInteraction(await boundedResponse(response));
  const temporary = resolve(directory, `speech-${process.pid}.tmp`);
  try {
    await writeFile(temporary, wav, { flag: "wx", mode: 0o600 });
    await link(temporary, output);
    await unlink(temporary);
    await writeFile(digestPath, `${digest}\n`, { flag: "wx", mode: 0o600 });
  } catch {
    throw new GeminiTtsError("Gemini TTS audio could not be saved; inspect the run before retrying", 50);
  }
  return result(request, output, false);
}

function result(request, output, reused) {
  return {
    request_id: request.id,
    credits: 0,
    clips: [],
    images: [],
    audio: [{
      id: `${request.id}-audio-1`,
      src: output,
      role: "narration",
      start: request.params?.start ?? 0,
      ...(request.params?.end !== undefined ? { end: request.params.end } : {}),
      ...(request.params?.volume !== undefined ? { volume: request.params.volume } : {})
    }],
    metadata: { adapter: "google-gemini-tts", model: request.model, billing_unknown: true, reused }
  };
}
