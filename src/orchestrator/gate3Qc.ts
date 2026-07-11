import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import type { Manifest } from "../manifest/schema.js";
import type { Issue, Result } from "../types.js";

export type Gate3QcProbe = {
  ok: boolean;
  duration_seconds?: number;
  width?: number;
  height?: number;
  fps?: number;
  has_video?: boolean;
  has_audio?: boolean;
  codec?: string;
  error?: string;
};

export type Gate3ContentProbe = {
  ok: boolean;
  longest_black_seconds?: number;
  longest_silence_seconds?: number;
  error?: string;
};

export type Gate3QcExpected = {
  duration_seconds: number;
  width: number;
  height: number;
  fps: number;
  audio_required: boolean;
};

export type Gate3QcReport = {
  ok: boolean;
  output_path: string;
  expected: Gate3QcExpected;
  actual: Gate3QcProbe;
  content: Gate3ContentProbe;
  issues: Issue[];
};

export type Gate3QcOptions = {
  probe?: (path: string) => Gate3QcProbe;
  contentProbe?: (path: string, audioRequired: boolean) => Gate3ContentProbe;
  durationToleranceSeconds?: number;
  fpsTolerance?: number;
  maxBlackSeconds?: number;
  maxSilenceSeconds?: number;
};

export type Gate3QcCommandResult = {
  error?: Error;
  status: number | null;
  stderr: string;
  stdout: string;
};

export type Gate3QcCommand = (path: string) => Gate3QcCommandResult;

const gate3QcProbeSchema = z
  .object({
    ok: z.boolean(),
    duration_seconds: z.number().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    fps: z.number().positive().optional(),
    has_video: z.boolean().optional(),
    has_audio: z.boolean().optional(),
    codec: z.string().optional(),
    error: z.string().optional()
  })
  .passthrough();

const gate3ContentProbeSchema = z
  .object({
    ok: z.boolean(),
    longest_black_seconds: z.number().nonnegative().optional(),
    longest_silence_seconds: z.number().nonnegative().optional(),
    error: z.string().optional()
  })
  .passthrough();

const gate3QcReportSchema = z
  .object({
    ok: z.boolean(),
    output_path: z.string().min(1),
    expected: z.object({
      duration_seconds: z.number().positive(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      fps: z.number().positive(),
      audio_required: z.boolean()
    }),
    actual: gate3QcProbeSchema,
    content: gate3ContentProbeSchema,
    issues: z.array(
      z.object({
        code: z.string().min(1),
        message: z.string(),
        path: z.string().optional()
      })
    )
  })
  .passthrough();

export function validateGate3QcReport(
  input: unknown,
  expectedOutputPath: string
): Result<{ report: Gate3QcReport }> {
  const parsed = gate3QcReportSchema.safeParse(input);
  if (!parsed.success || parsed.data.output_path !== expectedOutputPath) {
    return {
      ok: false,
      issues: [
        {
          code: "render.gate3_qc_invalid",
          message: parsed.success
            ? "Gate 3 QC report output path does not match the final output"
            : parsed.error.issues[0]?.message ?? "invalid Gate 3 QC report"
        }
      ]
    };
  }
  return { ok: true, issues: [], report: parsed.data };
}

export async function writeGate3QcReport(
  manifest: Manifest,
  outputPath: string,
  reportPath: string,
  options: Gate3QcOptions = {}
): Promise<Gate3QcReport> {
  const report = inspectGate3Output(manifest, outputPath, options);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export function inspectGate3Output(
  manifest: Manifest,
  outputPath: string,
  options: Gate3QcOptions = {}
): Gate3QcReport {
  const firstClip = manifest.clips[0];
  const expected: Gate3QcExpected = {
    duration_seconds: manifest.meta.target_duration_seconds,
    width: even(firstClip.resolution.width),
    height: even(firstClip.resolution.height),
    fps: manifest.meta.fps,
    audio_required: hasRequiredAudio(manifest)
  };
  const actual = runProbe(options.probe ?? probeGate3Output, outputPath);
  const contentProbe = options.contentProbe ?? (options.probe ? (() => ({ ok: true })) : probeGate3Content);
  const content = runContentProbe(contentProbe, outputPath, expected.audio_required);
  const issues = [
    ...inspectProbe(actual, expected, outputPath, options),
    ...inspectContent(content, outputPath, options)
  ];

  return {
    ok: issues.length === 0,
    output_path: outputPath,
    expected,
    actual,
    content,
    issues
  };
}

function inspectContent(content: Gate3ContentProbe, outputPath: string, options: Gate3QcOptions): Issue[] {
  if (!content.ok) {
    return [{
      code: "gate3.output.content_probe_failed",
      message: content.error ?? "final output content analysis failed",
      path: outputPath
    }];
  }

  const issues: Issue[] = [];
  const maxBlackSeconds = options.maxBlackSeconds ?? 1;
  const maxSilenceSeconds = options.maxSilenceSeconds ?? 3;
  if ((content.longest_black_seconds ?? 0) >= maxBlackSeconds) {
    issues.push({
      code: "gate3.output.black_frame",
      message: `final output contains a black segment of at least ${maxBlackSeconds} seconds`,
      path: outputPath
    });
  }
  if ((content.longest_silence_seconds ?? 0) >= maxSilenceSeconds) {
    issues.push({
      code: "gate3.output.long_silence",
      message: `final output contains a silent segment of at least ${maxSilenceSeconds} seconds`,
      path: outputPath
    });
  }
  return issues;
}

function inspectProbe(
  actual: Gate3QcProbe,
  expected: Gate3QcExpected,
  outputPath: string,
  options: Gate3QcOptions
): Issue[] {
  if (!actual.ok) {
    return [
      {
        code: "gate3.output.probe_failed",
        message: actual.error ?? "final output probe failed",
        path: outputPath
      }
    ];
  }

  const issues: Issue[] = [];
  const durationTolerance = options.durationToleranceSeconds ?? 0.5;
  const fpsTolerance = options.fpsTolerance ?? 0.1;

  if (!actual.has_video) {
    issues.push({
      code: "gate3.output.video_missing",
      message: "final output has no video stream",
      path: outputPath
    });
  }

  if (
    actual.duration_seconds === undefined ||
    Math.abs(actual.duration_seconds - expected.duration_seconds) > durationTolerance
  ) {
    issues.push({
      code: "gate3.output.duration_mismatch",
      message: `final duration must be within ${durationTolerance} seconds of ${expected.duration_seconds}`,
      path: outputPath
    });
  }

  if (actual.width !== expected.width || actual.height !== expected.height) {
    issues.push({
      code: "gate3.output.resolution_mismatch",
      message: `final resolution must be ${expected.width}x${expected.height}`,
      path: outputPath
    });
  }

  if (actual.fps === undefined || Math.abs(actual.fps - expected.fps) > fpsTolerance) {
    issues.push({
      code: "gate3.output.fps_mismatch",
      message: `final fps must be within ${fpsTolerance} of ${expected.fps}`,
      path: outputPath
    });
  }

  if (expected.audio_required && !actual.has_audio) {
    issues.push({
      code: "gate3.output.audio_missing",
      message: "manifest requires audio but final output has no audio stream",
      path: outputPath
    });
  }

  return issues;
}

function runProbe(probe: (path: string) => Gate3QcProbe, outputPath: string): Gate3QcProbe {
  try {
    return probe(outputPath);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function runContentProbe(
  probe: (path: string, audioRequired: boolean) => Gate3ContentProbe,
  outputPath: string,
  audioRequired: boolean
): Gate3ContentProbe {
  try {
    return probe(outputPath, audioRequired);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function probeGate3Content(path: string, audioRequired: boolean): Gate3ContentProbe {
  const args = ["-hide_banner", "-nostats", "-i", path, "-vf", "blackdetect=d=0.1:pix_th=0.10"];
  if (audioRequired) args.push("-af", "silencedetect=n=-50dB:d=0.1");
  args.push("-f", "null", "-");
  const result = spawnSync("ffmpeg", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 10 });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) return { ok: false, error: probeErrorMessage(result.stderr, result.stdout) };

  return {
    ok: true,
    longest_black_seconds: longestDuration(result.stderr, /black_duration:([0-9.]+)/g),
    longest_silence_seconds: audioRequired ? longestDuration(result.stderr, /silence_duration:\s*([0-9.]+)/g) : undefined
  };
}

function longestDuration(text: string, pattern: RegExp): number {
  let longest = 0;
  for (const match of text.matchAll(pattern)) {
    const duration = Number(match[1]);
    if (Number.isFinite(duration)) longest = Math.max(longest, duration);
  }
  return longest;
}

export function probeGate3Output(path: string, command: Gate3QcCommand = runFfprobe): Gate3QcProbe {
  const result = command(path);

  if (result.error) {
    return { ok: false, error: result.error.message };
  }

  if (result.status !== 0) {
    return { ok: false, error: probeErrorMessage(result.stderr, result.stdout) };
  }

  return parseProbeOutput(result.stdout);
}

function runFfprobe(path: string): Gate3QcCommandResult {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 5
    }
  );

  return {
    error: result.error,
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout
  };
}

function parseProbeOutput(stdout: string): Gate3QcProbe {
  try {
    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        duration?: string;
        width?: number;
        height?: number;
        avg_frame_rate?: string;
        r_frame_rate?: string;
      }>;
    };
    const streams = parsed.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");

    return {
      ok: true,
      duration_seconds: numberOrUndefined(parsed.format?.duration ?? video?.duration ?? audio?.duration),
      width: video?.width,
      height: video?.height,
      fps: frameRate(video?.avg_frame_rate ?? video?.r_frame_rate),
      has_video: Boolean(video),
      has_audio: Boolean(audio),
      codec: video?.codec_name ?? audio?.codec_name
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function hasRequiredAudio(manifest: Manifest): boolean {
  if (manifest.clips.some((clip) => clip.audio)) return true;
  return [manifest.audio.bgm, manifest.audio.narration, manifest.audio.sfx].some((entries) =>
    entries.some((entry) => Boolean(entry.src))
  );
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
  return text.length > 0 ? text.slice(0, 1000) : "final output probe failed";
}

function even(value: number): number {
  return value % 2 === 0 ? value : value + 1;
}
