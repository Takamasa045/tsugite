import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { resolve, relative, sep, isAbsolute, join } from "node:path";

// Apply the shared color contract to source pixels before native compositing.
// HyperFrames' extracted video compositor does not preserve CSS filter. Captions
// and cards retain their palette. The canonical manifest and media stay intact.
export async function prepareFastEditMedia(manifest, runDir) {
  if (!manifest.fast_edit || manifest.fast_edit.global.color === "source")
    return manifest;
  const root = await realpath(runDir),
    result = structuredClone(manifest);
  const color = manifest.fast_edit.global.color;
  const filters = {
    warm: "colorbalance=rs=.08:bs=-.06,eq=saturation=1.15",
    cool: "colorbalance=rs=-.06:bs=.08,eq=saturation=.85",
    mono: "hue=s=0",
  };
  if (!filters[color]) throw new Error("Unknown Fast Edit color");
  const prepared = new Set();
  for (const clip of result.clips) {
    if (isAbsolute(clip.src) || /^[a-z]+:/i.test(clip.src))
      throw new Error("Fast Edit source must be local");
    const input = await realpath(resolve(root, clip.src)),
      rel = relative(root, input);
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
      throw new Error("Fast Edit source escapes run");
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(input)) hash.update(bytes);
    const name = `fast-edit-${hash.digest("hex")}-${color}.mp4`,
      output = join(root, name);
    // Rebuild once per invocation from the verified source; never trust a stale
    // derivative merely because its source-derived filename exists.
    if (!prepared.has(name)) {
      try {
        await access(output);
        if ((await realpath(output)) !== output)
          throw new Error("Fast Edit derivative must not be a symlink");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const work = await mkdtemp(join(root, "fast-edit-color-"));
      try {
        const temporary = join(work, "source.mp4");
        const rendered = spawnSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
            input,
            "-map",
            "0:v:0",
            "-vf",
            filters[color],
            "-an",
            "-c:v",
            "libx264",
            "-crf",
            "16",
            "-pix_fmt",
            "yuv420p",
            temporary,
          ],
          { encoding: "utf8", timeout: 300000, maxBuffer: 4e6 },
        );
        if (rendered.error || rendered.status !== 0)
          throw new Error(
            `Fast Edit color preparation failed: ${rendered.error?.message ?? rendered.stderr}`,
          );
        await rename(temporary, output);
        prepared.add(name);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    }
    clip.src = name;
    clip.audio = false;
  }
  result.fast_edit.global.color = "source";
  return result;
}
