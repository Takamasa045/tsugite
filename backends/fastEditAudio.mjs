import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, relative, sep, isAbsolute } from "node:path";

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
export async function mixFastEditAudio(manifest, runDir, outputPath) {
  if (!manifest.fast_edit) return;
  const root = await realpath(runDir);
  const asset = async (p) => {
    if (typeof p !== "string" || isAbsolute(p) || /^[a-z]+:/i.test(p))
      throw new Error("Fast Edit audio needs local run assets");
    const absolute = await realpath(resolve(root, p)),
      rel = relative(root, absolute);
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
      throw new Error("audio asset escapes run");
    return absolute;
  };
  const work = await mkdtemp(join(root, "fast-edit-audio-"));
  try {
    const args = ["-y", "-v", "error", "-i", outputPath],
      filters = [],
      sources = [];
    let input = 1,
      cursor = 0;
    for (const clip of manifest.clips) {
      if (clip.audio) {
        args.push(
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          await asset(clip.src),
        );
        filters.push(
          `[${input}:a]atrim=start=${clip.in}:duration=${clip.duration},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(cursor * 1000)}|${Math.round(cursor * 1000)}[a${input}]`,
        );
        sources.push(`[a${input}]`);
        input++;
      }
      cursor += clip.duration;
    }
    for (const group of ["bgm", "narration", "sfx"])
      for (const track of manifest.audio[group]) {
        if (!track.src) throw new Error("Fast Edit audio track needs src");
        const start = track.start ?? 0,
          end = track.end ?? cursor;
        if (
          !(end > start) ||
          start >= cursor ||
          !Number.isFinite(start) ||
          !Number.isFinite(end)
        )
          throw new Error("invalid audio track timing");
        args.push(
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          await asset(track.src),
        );
        filters.push(
          `[${input}:a]atrim=duration=${end - start},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${track.volume ?? 1},adelay=${Math.round(start * 1000)}|${Math.round(start * 1000)}[a${input}]`,
        );
        sources.push(`[a${input}]`);
        input++;
      }
    for (const beat of manifest.fast_edit.beats)
      if (beat.edit.sfx !== "none") {
        const path = join(work, `${beat.id}.wav`);
        await writeFile(path, synthesizeSfx(beat.edit.sfx));
        args.push("-i", path);
        filters.push(
          `[${input}:a]aformat=channel_layouts=stereo,adelay=${Math.round(beat.start * 1000)}|${Math.round(beat.start * 1000)}[a${input}]`,
        );
        sources.push(`[a${input}]`);
        input++;
      }
    if (sources.length)
      filters.push(
        `${sources.join("")}amix=inputs=${sources.length}:normalize=0,alimiter=limit=.95:latency=1,apad,atrim=duration=${cursor}[mix]`,
      );
    else
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${cursor}[mix]`);
    const out = join(work, "mixed.mp4");
    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      "0:v:0",
      "-map",
      "[mix]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-t",
      String(cursor),
      "-movflags",
      "+faststart",
      out,
    );
    const r = spawnSync("ffmpeg", args, {
      encoding: "utf8",
      timeout: 300000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (r.error || r.status !== 0)
      throw new Error(
        `Fast Edit audio mix failed: ${r.error?.message ?? r.stderr}`,
      );
    await rename(out, outputPath);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
