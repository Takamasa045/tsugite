import { describe, expect, it } from "vitest";
import { inspectGate2Manifest, type Gate2QcProbe } from "../src/orchestrator/gate2Qc.js";
import type { Manifest } from "../src/manifest/schema.js";

describe("gate 2 qc", () => {
  it("passes when probed media matches the manifest", () => {
    const report = inspectGate2Manifest(manifest(), "/runs/demo", {
      probe: (): Gate2QcProbe => ({
        ok: true,
        duration_seconds: 3,
        width: 1920,
        height: 1080,
        fps: 30,
        has_video: true,
        has_audio: true,
        codec: "h264"
      })
    });

    expect(report.ok).toBe(true);
    expect(report.asset_count).toBe(2);
    expect(report.issues).toEqual([]);
  });

  it("reports target, probe, stream, duration, resolution, and fps issues", () => {
    const input = manifest({
      target_duration_seconds: 5
    });
    const report = inspectGate2Manifest(input, "/runs/demo", {
      probe: (path): Gate2QcProbe =>
        path.endsWith("clip-001.mp4")
          ? {
              ok: true,
              duration_seconds: 2,
              width: 1280,
              height: 720,
              fps: 24,
              has_video: false,
              has_audio: false,
              codec: "h264"
            }
          : {
              ok: false,
              error: "invalid media"
            }
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "gate2.duration.target_mismatch",
        "gate2.asset.video_missing",
        "gate2.asset.audio_missing",
        "gate2.asset.duration_mismatch",
        "gate2.asset.resolution_mismatch",
        "gate2.asset.fps_mismatch",
        "gate2.asset.probe_failed"
      ])
    );
  });
});

function manifest(overrides: Partial<Manifest["meta"]> = {}): Manifest {
  return {
    meta: {
      aspect: "16:9",
      fps: 30,
      target_duration_seconds: 6,
      slug: "gate2-qc",
      ...overrides
    },
    clips: [
      {
        id: "clip-001",
        src: "assets/clips/clip-001.mp4",
        in: 0,
        out: 3,
        duration: 3,
        fps: 30,
        resolution: {
          width: 1920,
          height: 1080
        },
        audio: true
      },
      {
        id: "clip-002",
        src: "assets/clips/clip-002.mp4",
        in: 0,
        out: 3,
        duration: 3,
        fps: 30,
        resolution: {
          width: 1920,
          height: 1080
        },
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
