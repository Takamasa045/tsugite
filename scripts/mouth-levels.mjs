#!/usr/bin/env node
// Adds amplitude-driven mouth envelopes to a dialogue manifest.
//
// For every caption with a matching narration track (`<caption id>-voice`),
// the narration audio is decoded to mono PCM, reduced to an RMS envelope at
// MOUTH_LEVEL_RATE Hz, normalized, and quantized into closed/half/open
// levels stored as `caption.mouth_levels` (+ `mouth_rate`). The
// street-dialogue backend prefers this envelope over timed mouth cycling,
// which keeps the flap in sync with the actual voice.
//
// Usage: node scripts/mouth-levels.mjs <path/to/manifest.json>
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  MOUTH_LEVEL_RATE,
  quantizeMouthLevels
} from "../backends/remotion/streetPresentation.mjs";

const SAMPLE_RATE = 8000;
const NORMALIZATION_PERCENTILE = 0.95;

function decodePcm(path) {
  const result = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", path, "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(SAMPLE_RATE), "-"],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg decode failed for ${path}: ${result.stderr?.toString().slice(0, 400)}`);
  }
  return result.stdout;
}

function rmsEnvelope(pcm) {
  const windowSize = Math.round(SAMPLE_RATE / MOUTH_LEVEL_RATE);
  const sampleCount = Math.floor(pcm.length / 2);
  const envelope = [];
  for (let start = 0; start < sampleCount; start += windowSize) {
    const end = Math.min(sampleCount, start + windowSize);
    let sum = 0;
    for (let index = start; index < end; index += 1) {
      const sample = pcm.readInt16LE(index * 2) / 32768;
      sum += sample * sample;
    }
    envelope.push(Math.sqrt(sum / Math.max(1, end - start)));
  }
  return envelope;
}

function normalize(envelope) {
  const sorted = [...envelope].sort((left, right) => left - right);
  const reference = sorted[Math.floor(sorted.length * NORMALIZATION_PERCENTILE)] || 1;
  return envelope.map((value) => Math.min(1, value / reference));
}

const manifestPath = process.argv[2];
if (!manifestPath) {
  throw new Error("usage: node scripts/mouth-levels.mjs <manifest.json>");
}
const manifestDir = dirname(resolve(manifestPath));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const narrationById = new Map(
  (manifest.audio?.narration ?? []).map((track) => [track.id, track])
);

let updatedCount = 0;
const captions = manifest.captions.map((caption) => {
  const track = narrationById.get(`${caption.id}-voice`);
  if (!track?.src) return caption;
  const pcm = decodePcm(resolve(manifestDir, track.src));
  const levels = quantizeMouthLevels(normalize(rmsEnvelope(pcm)));
  updatedCount += 1;
  return { ...caption, mouth_levels: levels, mouth_rate: MOUTH_LEVEL_RATE };
});

writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, captions }, null, 2)}\n`);
const openRatio =
  captions.flatMap((caption) => caption.mouth_levels ?? []).filter((level) => level > 0).length /
  Math.max(1, captions.flatMap((caption) => caption.mouth_levels ?? []).length);
process.stdout.write(
  `${JSON.stringify({ captions_updated: updatedCount, open_ratio: Math.round(openRatio * 100) / 100 })}\n`
);
