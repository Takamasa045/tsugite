import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Manifest } from "../manifest/schema.js";
import type { Issue } from "../types.js";

export type Gate2QcProbe = {
  ok: boolean;
  duration_seconds?: number;
  width?: number;
  height?: number;
  fps?: number;
  has_video?: boolean;
  has_audio?: boolean;
  codec?: string;
  pixel_format?: string;
  error?: string;
};

export type Gate2QcAsset = {
  id: string;
  kind: "clip" | "audio" | "image";
  src: string;
  path: string;
  probe: Gate2QcProbe;
  sha256?: string;
};

export type Gate2QcReport = {
  ok: boolean;
  target_duration_seconds: number;
  total_clip_duration_seconds: number;
  duration_delta_seconds: number;
  asset_count: number;
  assets: Gate2QcAsset[];
  issues: Issue[];
};

export type Gate2QcOptions = {
  probe?: (path: string) => Gate2QcProbe;
  durationToleranceSeconds?: number;
};

export async function writeGate2QcReport(
  manifest: Manifest,
  manifestPath: string,
  outputPath: string,
  options: Gate2QcOptions = {}
): Promise<Gate2QcReport> {
  const report = await inspectGate2ManifestWithFingerprints(manifest, dirname(manifestPath), options);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export async function inspectGate2ManifestWithFingerprints(
  manifest: Manifest,
  manifestDir: string,
  options: Gate2QcOptions = {}
): Promise<Gate2QcReport> {
  const report = inspectGate2Manifest(manifest, manifestDir, options);
  const hashes = new Map<string, Promise<string | undefined>>();

  const fingerprints = await Promise.all(report.assets.map(async (asset) => {
    if (asset.kind === "image") return asset.sha256;
    let pending = hashes.get(asset.path);
    if (!pending) {
      pending = fileSha256Stream(asset.path);
      hashes.set(asset.path, pending);
    }
    return pending;
  }));

  for (const [index, asset] of report.assets.entries()) {
    if (asset.kind === "image") continue;
    const sha256 = fingerprints[index];
    if (sha256) {
      asset.sha256 = sha256;
      continue;
    }
    report.issues.push({
      code: asset.kind === "audio" ? "gate2.audio.hash_failed" : "gate2.asset.hash_failed",
      message: `${asset.kind} asset '${asset.id}' could not be fingerprinted`,
      path: asset.path
    });
  }

  report.ok = report.issues.length === 0;
  return report;
}

export function inspectGate2Manifest(
  manifest: Manifest,
  manifestDir: string,
  options: Gate2QcOptions = {}
): Gate2QcReport {
  const probe = options.probe ?? probeAsset;
  const tolerance = options.durationToleranceSeconds ?? 0.5;
  const issues: Issue[] = [];
  const assets: Gate2QcAsset[] = [];
  const totalClipDuration = manifest.clips.reduce((sum, clip) => sum + clip.duration, 0);
  const targetDelta = roundSeconds(totalClipDuration - manifest.meta.target_duration_seconds);

  if (Math.abs(targetDelta) > tolerance) {
    issues.push({
      code: "gate2.duration.target_mismatch",
      message: `clip duration differs from target by ${targetDelta} seconds`
    });
  }

  for (const clip of manifest.clips) {
    const path = resolveAssetPath(manifestDir, clip.src);
    const assetProbe = probe(path);
    assets.push({
      id: clip.id,
      kind: "clip",
      src: clip.src,
      path,
      probe: assetProbe
    });

    if (!assetProbe.ok) {
      issues.push({
        code: "gate2.asset.probe_failed",
        message: assetProbe.error ?? "asset probe failed",
        path
      });
      continue;
    }

    if (!assetProbe.has_video) {
      issues.push({
        code: "gate2.asset.video_missing",
        message: `clip '${clip.id}' has no video stream`,
        path
      });
    }

    if (clip.audio && assetProbe.has_audio === false) {
      issues.push({
        code: "gate2.asset.audio_missing",
        message: `clip '${clip.id}' declares audio but no audio stream was found`,
        path
      });
    }

    if (assetProbe.duration_seconds !== undefined) {
      const shortage = clip.out - assetProbe.duration_seconds;
      if (shortage > tolerance) {
        issues.push({
          code: "gate2.asset.range_out_of_bounds",
          message: `clip '${clip.id}' source ends ${roundSeconds(shortage)} seconds before manifest out point`,
          path
        });
      }
    }

    if (
      assetProbe.width !== undefined &&
      assetProbe.height !== undefined &&
      (assetProbe.width !== clip.resolution.width || assetProbe.height !== clip.resolution.height)
    ) {
      issues.push({
        code: "gate2.asset.resolution_mismatch",
        message: `clip '${clip.id}' resolution differs from manifest`,
        path
      });
    }

    if (assetProbe.fps !== undefined && Math.abs(assetProbe.fps - clip.fps) > 0.1) {
      issues.push({
        code: "gate2.asset.fps_mismatch",
        message: `clip '${clip.id}' fps differs from manifest`,
        path
      });
    }
  }

  for (const image of manifest.images ?? []) {
    const path = resolveAssetPath(manifestDir, image.src);
    const assetProbe = probe(path);
    const sha256 = fileSha256(path);
    assets.push({
      id: image.id,
      kind: "image",
      src: image.src,
      path,
      probe: assetProbe,
      ...(sha256 ? { sha256 } : {})
    });

    if (!assetProbe.ok) {
      issues.push({
        code: "gate2.image.probe_failed",
        message: assetProbe.error ?? "image probe failed",
        path
      });
    } else if (!assetProbe.has_video || assetProbe.width === undefined || assetProbe.height === undefined) {
      issues.push({
        code: "gate2.image.stream_missing",
        message: `image '${image.id}' could not be decoded as a visual asset`,
        path
      });
    } else if (!sha256) {
      issues.push({
        code: "gate2.image.hash_failed",
        message: `image '${image.id}' could not be fingerprinted`,
        path
      });
    } else if (image.alpha_required && !hasAlphaChannel(assetProbe.pixel_format)) {
      issues.push({
        code: "gate2.image.alpha_missing",
        message: `image '${image.id}' requires an alpha channel`,
        path
      });
    }
  }

  for (const entry of audioEntries(manifest)) {
    if (!entry.src) continue;
    const path = resolveAssetPath(manifestDir, entry.src);
    const assetProbe = probe(path);
    assets.push({
      id: entry.id,
      kind: "audio",
      src: entry.src,
      path,
      probe: assetProbe
    });

    if (!assetProbe.ok) {
      issues.push({
        code: "gate2.audio.probe_failed",
        message: assetProbe.error ?? "audio probe failed",
        path
      });
    } else if (assetProbe.has_audio === false) {
      issues.push({
        code: "gate2.audio.stream_missing",
        message: `audio asset '${entry.id}' has no audio stream`,
        path
      });
    }
  }

  return {
    ok: issues.length === 0,
    target_duration_seconds: manifest.meta.target_duration_seconds,
    total_clip_duration_seconds: totalClipDuration,
    duration_delta_seconds: targetDelta,
    asset_count: assets.length,
    assets,
    issues
  };
}

function probeAsset(path: string): Gate2QcProbe {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 5
    }
  );

  if (result.error) {
    return {
      ok: false,
      error: result.error.message
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      error: probeErrorMessage(result.stderr, result.stdout)
    };
  }

  return parseProbeOutput(result.stdout);
}

function parseProbeOutput(stdout: string): Gate2QcProbe {
  try {
    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        avg_frame_rate?: string;
        pix_fmt?: string;
      }>;
    };
    const streams = parsed.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");

    return {
      ok: true,
      duration_seconds: numberOrUndefined(parsed.format?.duration),
      width: video?.width,
      height: video?.height,
      fps: frameRate(video?.avg_frame_rate),
      has_video: Boolean(video),
      has_audio: Boolean(audio),
      codec: video?.codec_name ?? audio?.codec_name,
      pixel_format: video?.pix_fmt
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function hasAlphaChannel(pixelFormat: string | undefined): boolean {
  return pixelFormat !== undefined && /^(?:rgba|bgra|argb|abgr|ya|yuva|gbrap)/.test(pixelFormat);
}

function fileSha256(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

async function fileSha256Stream(path: string): Promise<string | undefined> {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

function audioEntries(manifest: Manifest): Array<{ id: string; src?: string }> {
  return [
    ...manifest.audio.bgm.map((entry, index) => ({ id: entry.id ?? `bgm-${index + 1}`, src: entry.src })),
    ...manifest.audio.narration.map((entry, index) => ({
      id: entry.id ?? `narration-${index + 1}`,
      src: entry.src
    })),
    ...manifest.audio.sfx.map((entry, index) => ({ id: entry.id ?? `sfx-${index + 1}`, src: entry.src }))
  ];
}

function resolveAssetPath(baseDir: string, src: string): string {
  return isAbsolute(src) ? src : resolve(baseDir, src);
}

function frameRate(value: string | undefined): number | undefined {
  if (!value || value === "0/0") return undefined;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined;
  return numerator / denominator;
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function probeErrorMessage(stderr: string, stdout: string): string {
  const text = `${stderr}\n${stdout}`.trim().replace(/0x[0-9a-f]+/gi, "0xADDR");
  return text.length > 0 ? text.slice(0, 1000) : "asset probe failed";
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
