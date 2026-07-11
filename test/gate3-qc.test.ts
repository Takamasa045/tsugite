import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectGate3Output,
  probeGate3Output,
  writeGate3QcReport,
  type Gate3QcProbe
} from "../src/orchestrator/gate3Qc.js";
import type { Manifest } from "../src/manifest/schema.js";

describe("gate 3 qc", () => {
  it("records expected and actual values when the final output matches", () => {
    const report = inspectGate3Output(manifest(), "/runs/demo/final.mp4", {
      probe: (): Gate3QcProbe => ({
        ok: true,
        duration_seconds: 6,
        width: 1920,
        height: 1080,
        fps: 30,
        has_video: true,
        has_audio: true,
        codec: "h264"
      })
    });

    expect(report).toMatchObject({
      ok: true,
      expected: {
        duration_seconds: 6,
        width: 1920,
        height: 1080,
        fps: 30,
        audio_required: true
      },
      actual: {
        duration_seconds: 6,
        width: 1920,
        height: 1080,
        fps: 30,
        has_video: true,
        has_audio: true
      },
      issues: []
    });
  });

  it("reports probe failure without throwing", () => {
    const report = inspectGate3Output(manifest(), "/runs/demo/final.mp4", {
      probe: (): Gate3QcProbe => ({ ok: false, error: "ffprobe unavailable" })
    });

    expect(report.ok).toBe(false);
    expect(report.actual).toEqual({ ok: false, error: "ffprobe unavailable" });
    expect(report.issues).toEqual([
      expect.objectContaining({
        code: "gate3.output.probe_failed",
        path: "/runs/demo/final.mp4"
      })
    ]);
  });

  it("normalizes ffprobe JSON without running an external command", () => {
    const probe = probeGate3Output("/runs/demo/final.mp4", () => ({
      status: 0,
      stderr: "",
      stdout: JSON.stringify({
        format: { duration: "6.25" },
        streams: [
          {
            codec_type: "video",
            codec_name: "h264",
            width: 1920,
            height: 1080,
            avg_frame_rate: "30000/1001"
          },
          { codec_type: "audio", codec_name: "aac" }
        ]
      })
    }));

    expect(probe).toMatchObject({
      ok: true,
      duration_seconds: 6.25,
      width: 1920,
      height: 1080,
      has_video: true,
      has_audio: true,
      codec: "h264"
    });
    expect(probe.fps).toBeCloseTo(29.97, 2);
  });

  it("normalizes ffprobe launch, exit, and parse failures", () => {
    const launchFailure = probeGate3Output("/runs/demo/final.mp4", () => ({
      error: new Error("ffprobe missing"),
      status: null,
      stderr: "",
      stdout: ""
    }));
    const exitFailure = probeGate3Output("/runs/demo/final.mp4", () => ({
      status: 1,
      stderr: "invalid media",
      stdout: ""
    }));
    const parseFailure = probeGate3Output("/runs/demo/final.mp4", () => ({
      status: 0,
      stderr: "",
      stdout: "not-json"
    }));

    expect(launchFailure).toMatchObject({ ok: false, error: "ffprobe missing" });
    expect(exitFailure).toMatchObject({ ok: false, error: "invalid media" });
    expect(parseFailure.ok).toBe(false);
  });

  it("normalizes audio-only and empty ffprobe output", () => {
    const audioOnly = probeGate3Output("/runs/demo/final.mp4", () => ({
      status: 0,
      stderr: "",
      stdout: JSON.stringify({
        streams: [{ codec_type: "audio", codec_name: "aac", duration: "4" }]
      })
    }));
    const empty = probeGate3Output("/runs/demo/final.mp4", () => ({
      status: 0,
      stderr: "",
      stdout: "{}"
    }));
    const emptyFailure = probeGate3Output("/runs/demo/final.mp4", () => ({
      status: 1,
      stderr: "",
      stdout: ""
    }));

    expect(audioOnly).toMatchObject({
      ok: true,
      duration_seconds: 4,
      has_video: false,
      has_audio: true,
      codec: "aac"
    });
    expect(empty).toMatchObject({ ok: true, has_video: false, has_audio: false });
    expect(emptyFailure).toEqual({ ok: false, error: "final output probe failed" });
  });

  it("converts a thrown injected probe into a report issue", () => {
    const report = inspectGate3Output(manifest(), "/runs/demo/final.mp4", {
      probe: () => {
        throw new Error("probe crashed");
      }
    });

    expect(report.actual).toEqual({ ok: false, error: "probe crashed" });
    expect(report.issues[0]?.code).toBe("gate3.output.probe_failed");
  });

  it("uses the generic probe error when no detail is available", () => {
    const report = inspectGate3Output(manifest(), "/runs/demo/final.mp4", {
      probe: () => ({ ok: false })
    });

    expect(report.issues[0]?.message).toBe("final output probe failed");
  });

  it("reports missing streams and duration, resolution, and fps mismatches", () => {
    const report = inspectGate3Output(manifest(), "/runs/demo/final.mp4", {
      probe: (): Gate3QcProbe => ({
        ok: true,
        duration_seconds: 8,
        width: 1280,
        height: 720,
        fps: 24,
        has_video: false,
        has_audio: false
      })
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "gate3.output.video_missing",
        "gate3.output.duration_mismatch",
        "gate3.output.resolution_mismatch",
        "gate3.output.fps_mismatch",
        "gate3.output.audio_missing"
      ])
    );
  });

  it("does not require an audio stream when the manifest has no audible source", () => {
    const input = manifest();
    input.clips = input.clips.map((clip) => ({ ...clip, audio: false }));
    input.audio = { bgm: [], narration: [], sfx: [] };

    const report = inspectGate3Output(input, "/runs/demo/final.mp4", {
      probe: (): Gate3QcProbe => ({
        ok: true,
        duration_seconds: 6,
        width: 1920,
        height: 1080,
        fps: 30,
        has_video: true,
        has_audio: false
      })
    });

    expect(report.ok).toBe(true);
    expect(report.expected.audio_required).toBe(false);
  });

  it("rejects sustained black frames and long silence in the final output", () => {
    const report = inspectGate3Output(manifest(), "/runs/demo/final.mp4", {
      probe: (): Gate3QcProbe => ({
        ok: true,
        duration_seconds: 6,
        width: 1920,
        height: 1080,
        fps: 30,
        has_video: true,
        has_audio: true
      }),
      contentProbe: () => ({
        ok: true,
        longest_black_seconds: 1.25,
        longest_silence_seconds: 3.5
      })
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["gate3.output.black_frame", "gate3.output.long_silence"])
    );
  });

  it("fails closed when final content analysis cannot run", () => {
    const report = inspectGate3Output(manifest(), "/runs/demo/final.mp4", {
      probe: (): Gate3QcProbe => ({
        ok: true,
        duration_seconds: 6,
        width: 1920,
        height: 1080,
        fps: 30,
        has_video: true,
        has_audio: true
      }),
      contentProbe: () => ({ ok: false, error: "ffmpeg unavailable" })
    });

    expect(report.ok).toBe(false);
    expect(report.issues[0]?.code).toBe("gate3.output.content_probe_failed");
  });

  it("writes the report as JSON", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "tsugite-gate3-qc-"));
    const reportPath = join(outputDir, "gate3-qc.json");

    await writeGate3QcReport(manifest(), "/runs/demo/final.mp4", reportPath, {
      probe: (): Gate3QcProbe => ({ ok: false, error: "invalid media" })
    });

    const written = JSON.parse(await readFile(reportPath, "utf8"));
    expect(written.ok).toBe(false);
    expect(written.issues[0].code).toBe("gate3.output.probe_failed");
  });
});

function manifest(): Manifest {
  return {
    meta: {
      aspect: "16:9",
      fps: 30,
      target_duration_seconds: 6,
      slug: "gate3-qc"
    },
    clips: [
      {
        id: "clip-001",
        src: "assets/clips/clip-001.mp4",
        in: 0,
        out: 6,
        duration: 6,
        fps: 30,
        resolution: { width: 1920, height: 1080 },
        audio: true
      }
    ],
    audio: {
      bgm: [],
      narration: [],
      sfx: []
    },
    captions: [],
    chapters: [],
    provenance: []
  };
}
