import { spawnSync } from "node:child_process";

export const AUDIO_REACTIVE_SAMPLE_RATE_HZ = 48_000;
export const MAX_AUDIO_REACTIVE_KEYFRAMES = 240;
export const MAX_AUDIO_REACTIVE_ANALYSIS_SECONDS = 120;
export const MAX_AUDIO_REACTIVE_SHAKE_DISPLACEMENT_PX = 24;
export const MIN_AUDIO_REACTIVE_OPACITY_PERCENT = 20;
const MAX_PCM_BYTES = AUDIO_REACTIVE_SAMPLE_RATE_HZ * 2 * MAX_AUDIO_REACTIVE_ANALYSIS_SECONDS;
const MAX_PCM_OUTPUT = MAX_PCM_BYTES + AUDIO_REACTIVE_SAMPLE_RATE_HZ * 2;

export function buildTesseractAudioReactiveKeyframeActions(input) {
  const {
    compositionId,
    layerId,
    pcm,
    durationMs,
    measurementWindowMs,
    strength,
    mode = "pulse",
    baselinePosition = [0, 0],
    sampleRateHz = AUDIO_REACTIVE_SAMPLE_RATE_HZ
  } = input;
  if (typeof compositionId !== "string" || !compositionId) throw new Error("compositionId is required for audio-reactive motion");
  if (!Number.isInteger(layerId) || layerId < 0) throw new Error("audio-reactive target layerId must be a non-negative integer");
  if (!Number.isInteger(durationMs) || durationMs <= 0 || durationMs > MAX_AUDIO_REACTIVE_ANALYSIS_SECONDS * 1000) {
    throw new Error(`audio-reactive target duration must be between 1 ms and ${MAX_AUDIO_REACTIVE_ANALYSIS_SECONDS} seconds`);
  }
  if (!Number.isInteger(measurementWindowMs) || measurementWindowMs < 20 || measurementWindowMs > 2_000) {
    throw new Error("audio-reactive measurement_window_ms must be an integer from 20 to 2000");
  }
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error("audio-reactive strength must be between 0 and 1");
  if (!["pulse", "shake", "flicker"].includes(mode)) throw new Error(`audio-reactive mode '${mode}' is unsupported`);
  if (!Array.isArray(baselinePosition) || baselinePosition.length !== 2 || !baselinePosition.every(Number.isFinite)) {
    throw new Error("audio-reactive baselinePosition must contain two finite coordinates");
  }
  if (!Number.isInteger(sampleRateHz) || sampleRateHz <= 0 || sampleRateHz % 1000 !== 0) {
    throw new Error("audio-reactive sample rate must be a positive integer divisible by 1000");
  }
  if (!(Buffer.isBuffer(pcm) || pcm instanceof Uint8Array) || pcm.byteLength % 2 !== 0) {
    throw new Error("audio-reactive analysis requires even-length mono PCM16 samples");
  }

  const samplesPerWindow = sampleRateHz * measurementWindowMs / 1000;
  const expectedSamples = sampleRateHz * durationMs / 1000;
  if (!Number.isInteger(samplesPerWindow) || !Number.isInteger(expectedSamples)) {
    throw new Error("audio-reactive duration and measurement window must align to the decoded sample rate");
  }
  const sampleCount = pcm.byteLength / 2;
  if (sampleCount < expectedSamples) throw new Error("audio-reactive PCM data is shorter than the target timeline interval");
  const neutralTime = durationMs - 1;
  const measurementCount = Math.ceil(neutralTime / measurementWindowMs);
  if (measurementCount < 2) throw new Error("audio-reactive motion needs at least two measurement windows to create visible movement");
  if (measurementCount + 1 > MAX_AUDIO_REACTIVE_KEYFRAMES) {
    throw new Error(`audio-reactive motion exceeds the ${MAX_AUDIO_REACTIVE_KEYFRAMES}-keyframe limit; increase measurement_window_ms or shorten the target`);
  }

  const buffer = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const envelope = [];
  for (let index = 0; index < measurementCount; index += 1) {
    const startSample = index * samplesPerWindow;
    const endSample = Math.min(expectedSamples, startSample + samplesPerWindow);
    let squaredSum = 0;
    for (let sampleIndex = startSample; sampleIndex < endSample; sampleIndex += 1) {
      const normalized = buffer.readInt16LE(sampleIndex * 2) / 32768;
      squaredSum += normalized * normalized;
    }
    envelope.push({ layerTime: index * measurementWindowMs, rms: Math.sqrt(squaredSum / (endSample - startSample)) });
  }

  const peakRms = Math.max(0, ...envelope.map((entry) => entry.rms));
  const keyframesFor = (property) => {
    const keyframes = envelope
      .filter((entry) => entry.layerTime < neutralTime)
      .map((entry, index) => {
        const normalized = peakRms > 0 ? entry.rms / peakRms : 0;
        const alternatingSign = index % 2 === 0 ? 1 : -1;
        let value;
        if (mode === "pulse") value = Math.min(160, 100 + (120 * strength * entry.rms));
        else if (mode === "flicker") value = Math.max(MIN_AUDIO_REACTIVE_OPACITY_PERCENT, 100 - (80 * strength * normalized));
        else {
          const baseline = property === "positionX" ? baselinePosition[0] : baselinePosition[1];
          const sign = property === "positionX" ? alternatingSign : -alternatingSign;
          value = baseline + sign * MAX_AUDIO_REACTIVE_SHAKE_DISPLACEMENT_PX * strength * normalized;
        }
        return {
          id: `tsugite-audio-${mode}-${property}-${layerId}-${index + 1}`,
          layerTime: entry.layerTime,
          value: { type: "float", value: Number(value.toFixed(6)) },
          easing: { type: "linear" }
        };
      });
    const neutralValue = mode === "pulse" ? 100
      : mode === "flicker" ? 100
      : property === "positionX" ? baselinePosition[0] : baselinePosition[1];
    const neutralKeyframe = {
      id: `tsugite-audio-${mode}-${property}-${layerId}-neutral`,
      layerTime: neutralTime,
      value: { type: "float", value: Number(neutralValue.toFixed(6)) },
      easing: { type: "linear" }
    };
    const last = keyframes.at(-1);
    if (last?.layerTime === neutralTime) keyframes[keyframes.length - 1] = neutralKeyframe;
    else keyframes.push(neutralKeyframe);
    return keyframes;
  };

  if (mode === "shake") {
    return [{
      type: "setFxPositionKeyframes",
      compositionId,
      layerId,
      positionX: { keyframes: keyframesFor("positionX") },
      positionY: { keyframes: keyframesFor("positionY") }
    }];
  }
  if (mode === "flicker") {
    return [{
      type: "setFxPropertyKeyframes",
      compositionId,
      property: { layerId, propertyType: "opacity" },
      keyframes: keyframesFor("opacity")
    }];
  }
  return ["scaleX", "scaleY"].map((propertyType) => ({
    type: "setFxPropertyKeyframes",
    compositionId,
    property: { layerId, propertyType },
    keyframes: keyframesFor(propertyType)
  }));
}

export const buildTesseractAudioPulseActions = buildTesseractAudioReactiveKeyframeActions;

export function readAudioPcm16Mono(path, input) {
  const sourceStartMs = input.sourceStartMs ?? 0;
  const durationMs = input.durationMs;
  if (typeof path !== "string" || !path) throw new Error("audio-reactive source path is required");
  if (!Number.isInteger(sourceStartMs) || sourceStartMs < 0) throw new Error("audio-reactive sourceStartMs must be a non-negative integer");
  if (!Number.isInteger(durationMs) || durationMs <= 0 || durationMs > MAX_AUDIO_REACTIVE_ANALYSIS_SECONDS * 1000) {
    throw new Error(`audio-reactive analysis duration cannot exceed ${MAX_AUDIO_REACTIVE_ANALYSIS_SECONDS} seconds`);
  }
  const expectedBytes = Math.ceil(durationMs * AUDIO_REACTIVE_SAMPLE_RATE_HZ / 1000) * 2;
  if (expectedBytes > MAX_PCM_BYTES) throw new Error("audio-reactive PCM request exceeds the bounded analysis size");
  const result = spawnSync("ffmpeg", [
    "-v", "error",
    "-i", path,
    "-ss", secondsArgument(sourceStartMs),
    "-t", secondsArgument(durationMs),
    "-map", "0:a:0",
    "-vn",
    "-ac", "1",
    "-ar", String(AUDIO_REACTIVE_SAMPLE_RATE_HZ),
    "-acodec", "pcm_s16le",
    "-f", "s16le",
    "pipe:1"
  ], {
    encoding: "buffer",
    timeout: 120_000,
    maxBuffer: Math.min(MAX_PCM_OUTPUT, expectedBytes + (AUDIO_REACTIVE_SAMPLE_RATE_HZ * 2)),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
    env: safeFfmpegEnvironment()
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? (String(result.stderr ?? "").slice(0, 2_000).trim() || `exit code ${result.status}`);
    throw new Error(`ffmpeg could not decode audio-reactive source: ${detail}`);
  }
  if (!Buffer.isBuffer(result.stdout) || result.stdout.length % 2 !== 0) throw new Error("ffmpeg returned malformed PCM16 audio");
  return result.stdout;
}

export async function buildTesseractAudioReactiveActions(manifest, input) {
  const { compositionId, clipLayers, captionLayers = [], canonicalBySource, sourceInfo } = input;
  const readPcm = input.readPcm ?? readAudioPcm16Mono;
  const tracks = ["bgm", "narration", "sfx"].flatMap((group) => Array.isArray(manifest.audio?.[group]) ? manifest.audio[group] : []);
  const actions = [];
  const targets = [];
  for (const [index, clip] of manifest.clips.entries()) {
    const cue = clip.motion?.audio_reactive;
    if (!cue) continue;
    const target = clipLayers[index];
    if (!target || target.clipId !== clip.id) throw new Error(`clips.${index} has no matching layer for audio-reactive motion`);
    const dimensions = manifest.meta.aspect === "16:9" ? [1920, 1080] : [1080, 1920];
    targets.push({
      cue,
      target: { ...target, baselinePosition: target.baselinePosition ?? [dimensions[0] / 2, dimensions[1] / 2] },
      path: `clips.${index}.motion.audio_reactive`
    });
  }
  for (const [index, caption] of (manifest.captions ?? []).entries()) {
    const cue = caption.visual?.motion?.audio_reactive;
    if (!cue) continue;
    const target = captionLayers[index];
    if (!target || target.captionId !== (caption.id ?? String(index + 1))) {
      throw new Error(`captions.${index} has no matching Tesseract text layer for audio-reactive motion`);
    }
    targets.push({ cue, target, path: `captions.${index}.visual.motion.audio_reactive` });
  }
  for (const { cue, target, path } of targets) {
    const matches = tracks.filter((track) => track.id === cue.source_track_id);
    if (matches.length !== 1) throw new Error(`${path} source_track_id '${cue.source_track_id}' must identify exactly one audio track`);
    const track = matches[0];
    if (!track?.src) throw new Error(`${path} source track '${cue.source_track_id}' has no local asset path`);
    const sourcePath = canonicalBySource.get(track.src);
    if (typeof sourcePath !== "string" || !sourcePath) throw new Error(`${path} source track '${cue.source_track_id}' was not resolved from the owned run assets`);
    const media = sourceInfo.get(track.src);
    if (!media?.hasAudio) throw new Error(`${path} source track '${cue.source_track_id}' has no audio stream`);
    const trackTimelineStartMs = Math.round((track.start ?? 0) * 1000);
    const sourceStartMs = target.timelineStartMs - trackTimelineStartMs;
    if (sourceStartMs < 0) throw new Error(`${path} source track '${cue.source_track_id}' starts after its target`);
    const targetEndMs = target.timelineStartMs + target.durationMs;
    if (track.end !== undefined && Math.round(track.end * 1000) < targetEndMs) {
      throw new Error(`${path} source track '${cue.source_track_id}' does not cover its target timeline range`);
    }
    const trackDurationSeconds = track.end !== undefined
      ? track.end - (track.start ?? 0)
      : media.audioDurationSeconds ?? media.durationSeconds;
    const sourceDurationMs = Math.round(trackDurationSeconds * 1000);
    if (sourceStartMs + target.durationMs > sourceDurationMs + 20) {
      throw new Error(`${path} source track '${cue.source_track_id}' is shorter than the requested sample interval`);
    }
    const pcm = await readPcm(sourcePath, { sourceStartMs, durationMs: target.durationMs });
    actions.push(...buildTesseractAudioReactiveKeyframeActions({
      compositionId,
      layerId: target.layerId,
      pcm,
      durationMs: target.durationMs,
      measurementWindowMs: cue.measurement_window_ms,
      strength: cue.strength,
      mode: cue.mode,
      baselinePosition: target.baselinePosition ?? [0, 0]
    }));
  }
  return actions;
}

function secondsArgument(milliseconds) {
  return (milliseconds / 1000).toFixed(3);
}

function safeFfmpegEnvironment() {
  const env = { PATH: process.env.PATH ?? "", LANG: "C", LC_ALL: "C" };
  for (const key of ["TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
