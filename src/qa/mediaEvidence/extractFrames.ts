/**
 * Frame extraction planning with fixed argv arrays and hard media limits.
 * Tests inject mocks; production callers may spawn fixed argv only (no shell concat).
 * Does not download or fetch network media.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Issue, Result } from "../../types.js";
import { MEDIA_EVIDENCE_LIMITS } from "./schema.js";
import type { MediaFramePlanEntry } from "./framePlan.js";

export type FrameExtractionPlan = {
  source_relative_path: string;
  output_dir_relative: string;
  frames: Array<MediaFramePlanEntry & { output_relative_path: string }>;
  /** Fixed argv templates per frame (tool name separate). */
  extract_argv_per_frame: string[][];
  extractor_tool: "ffmpeg";
  max_parallelism: number;
};

/**
 * Fixed ffmpeg argv for a single frame extract. Never builds a shell string.
 */
export function buildFixedFfmpegExtractArgv(options: {
  sourcePath: string;
  timestampMs: number;
  outputPath: string;
}): string[] {
  const seconds = (options.timestampMs / 1000).toFixed(3);
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    seconds,
    "-i",
    options.sourcePath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    options.outputPath
  ];
}

export function planMediaFrameExtraction(options: {
  sourceRelativePath: string;
  sourceBytes: number;
  durationMs: number;
  framePlan: readonly MediaFramePlanEntry[];
  outputDirRelative: string;
  maxParallelism?: number;
}): Result<{ plan: FrameExtractionPlan }> {
  const issues: Issue[] = [];

  if (
    !options.sourceRelativePath
    || options.sourceRelativePath.startsWith("/")
    || options.sourceRelativePath.includes("..")
    || options.sourceRelativePath.includes("\\")
  ) {
    issues.push({
      code: "media_evidence.path_escape",
      message: "source video path must be a safe relative path",
      path: options.sourceRelativePath
    });
  }

  if (
    !options.outputDirRelative
    || options.outputDirRelative.startsWith("/")
    || options.outputDirRelative.includes("..")
    || options.outputDirRelative.includes("\\")
  ) {
    issues.push({
      code: "media_evidence.path_escape",
      message: "output directory must be a safe relative path",
      path: options.outputDirRelative
    });
  }

  if (options.sourceBytes > MEDIA_EVIDENCE_LIMITS.max_video_bytes) {
    issues.push({
      code: "media_evidence.size_limit",
      message: `source video exceeds max_video_bytes limit (${MEDIA_EVIDENCE_LIMITS.max_video_bytes})`,
      path: options.sourceRelativePath
    });
  }

  if (options.durationMs > MEDIA_EVIDENCE_LIMITS.max_duration_ms) {
    issues.push({
      code: "media_evidence.duration_limit",
      message: `source duration exceeds max_duration_ms limit (${MEDIA_EVIDENCE_LIMITS.max_duration_ms})`,
      path: options.sourceRelativePath
    });
  }

  if (options.framePlan.length > MEDIA_EVIDENCE_LIMITS.max_total_frames) {
    issues.push({
      code: "media_evidence.frame_limit",
      message: `frame plan exceeds max_total_frames (${MEDIA_EVIDENCE_LIMITS.max_total_frames})`
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const parallelism = Math.min(
    options.maxParallelism ?? MEDIA_EVIDENCE_LIMITS.max_parallelism,
    MEDIA_EVIDENCE_LIMITS.max_parallelism
  );

  const frames = options.framePlan.map((frame, index) => {
    const output_relative_path = `${options.outputDirRelative.replace(/\/$/, "")}/f${String(index).padStart(3, "0")}.png`;
    return {
      ...frame,
      output_relative_path
    };
  });

  const extract_argv_per_frame = frames.map((frame) =>
    buildFixedFfmpegExtractArgv({
      sourcePath: options.sourceRelativePath,
      timestampMs: frame.timestamp_ms,
      outputPath: frame.output_relative_path
    })
  );

  return {
    ok: true,
    issues: [],
    plan: {
      source_relative_path: options.sourceRelativePath,
      output_dir_relative: options.outputDirRelative,
      frames,
      extract_argv_per_frame,
      extractor_tool: "ffmpeg",
      max_parallelism: parallelism
    }
  };
}

/**
 * Streaming SHA-256 — never loads the whole file into memory.
 */
export async function sha256FileStreaming(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
