// Deterministic WAV helper adapted from Tsugite v1 (MIT).
export function synthesizeSfx(kind, seconds = 0.32, sampleRate = 48000) {
  if (!["whoosh", "pop", "chime"].includes(kind))
    throw new Error(`Unknown SFX: ${kind}`);
  const n = Math.ceil(seconds * sampleRate),
    wav = Buffer.alloc(44 + n * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(n * 2, 40);
  let seed = 42;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate,
      u = i / n;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const x =
      kind === "whoosh"
        ? (seed / 2147483648 - 1) * Math.sin(Math.PI * u) ** 2
        : kind === "pop"
          ? Math.sin(2 * Math.PI * (700 * t - 700 * t * t)) * Math.exp(-24 * t)
          : (0.6 * Math.sin(2 * Math.PI * 880 * t) +
              0.4 * Math.sin(2 * Math.PI * 1320 * t)) *
            Math.exp(-8 * t);
    wav.writeInt16LE(
      Math.round(x * 0.18 * 32767 * Math.min(1, t * 300)),
      44 + i * 2,
    );
  }
  return wav;
}
