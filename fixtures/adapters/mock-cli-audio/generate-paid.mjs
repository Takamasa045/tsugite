import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Mirrors generate.mjs but reports a non-zero credit cost so tests can cover the
// "run consumed credits" branch of the Gate 2 auto-pass conditions.
const payload = JSON.parse(await readStdin());
const audioDir = join(payload.run_dir, "generated-audio");
await mkdir(audioDir, { recursive: true });

const bgm = payload.request.bgm
  ? await createTrack(payload.request.bgm, "bgm", audioDir, payload.target_duration_seconds)
  : undefined;
const sfx = [];
for (const request of payload.request.sfx ?? []) {
  sfx.push(await createTrack(request, "sfx", audioDir, 1));
}

console.log(JSON.stringify({
  credits: 0.5,
  ...(bgm ? { bgm } : {}),
  sfx,
  metadata: {
    fixture: true,
    elevenlabs_used: false
  }
}));

async function createTrack(request, track, directory, defaultDuration) {
  const duration = request.end && request.end > request.start
    ? request.end - request.start
    : defaultDuration;
  const path = join(directory, `${request.id}.wav`);
  await writeFile(path, silentWav(Math.max(0.1, duration)));
  return {
    id: request.id,
    src: path,
    start: request.start ?? 0,
    end: request.end ?? (request.start ?? 0) + duration,
    volume: request.volume ?? (track === "bgm" ? 0.2 : 0.35)
  };
}

function silentWav(durationSeconds) {
  const sampleRate = 8000;
  const samples = Math.ceil(sampleRate * durationSeconds);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
