/**
 * Local MP4 intake. URL fetch is optional and never uses signed playback URLs
 * from sidecar metadata as an auth bypass.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

export function inspectLocalMedia(path) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`reference file missing: ${path}`);
  }
  const probe = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size,format_name",
    "-show_entries", "stream=codec_type,codec_name,width,height",
    "-of", "json",
    path
  ], { encoding: "utf8" });
  if (probe.status !== 0) {
    throw new Error(`ffprobe failed for ${basename(path)}: ${probe.stderr}`);
  }
  const info = JSON.parse(probe.stdout);
  const video = (info.streams ?? []).find((stream) => stream.codec_type === "video");
  return {
    path,
    bytes: Number(info.format?.size ?? statSync(path).size),
    duration_s: Number(info.format?.duration ?? 0),
    format_name: info.format?.format_name ?? "",
    width: video?.width ?? null,
    height: video?.height ?? null,
    video_codec: video?.codec_name ?? null,
    analysis: "intake-only"
  };
}

export function intakeLocalReference(sourcePath, workspace) {
  if (extname(sourcePath).toLowerCase() !== ".mp4") {
    throw new Error("Phase intake accepts a local .mp4 file only");
  }
  const facts = inspectLocalMedia(sourcePath);
  const destDir = join(workspace, "assets", "reference");
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, "reference.mp4");
  copyFileSync(sourcePath, dest);
  return { ...facts, workspace_path: dest };
}
