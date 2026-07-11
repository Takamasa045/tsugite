import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

  it("rejects an image without alpha when the manifest requires transparency", () => {
    const input = manifest();
    input.images = [
      {
        id: "character",
        src: resolve("fixtures/media/character.svg"),
        alpha_required: true
      }
    ];
    const report = inspectGate2Manifest(input, "/runs/demo", {
      probe: (path): Gate2QcProbe =>
        path.endsWith("character.png")
          ? {
              ok: true,
              width: 1200,
              height: 1200,
              has_video: true,
              has_audio: false,
              codec: "png",
              pixel_format: "rgb24"
            }
          : {
              ok: true,
              duration_seconds: 3,
              width: 1920,
              height: 1080,
              fps: 30,
              has_video: true,
              has_audio: true,
              codec: "h264"
            }
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("gate2.image.alpha_missing");
  });

  it("fingerprints image contents so same-size replacements invalidate Gate 2", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tsugite-image-hash-"));
    const path = join(directory, "character.png");
    const input = manifest();
    input.images = [{ id: "character", src: "character.png" }];
    const probe = (candidate: string): Gate2QcProbe =>
      candidate.endsWith("character.png")
        ? { ok: true, width: 1200, height: 1200, has_video: true, codec: "png", pixel_format: "rgba" }
        : {
            ok: true,
            duration_seconds: 3,
            width: 1920,
            height: 1080,
            fps: 30,
            has_video: true,
            has_audio: true,
            codec: "h264"
          };

    await writeFile(path, "first-image");
    const first = inspectGate2Manifest(input, directory, { probe });
    await writeFile(path, "other-image");
    const second = inspectGate2Manifest(input, directory, { probe });

    expect(first.assets.find((asset) => asset.kind === "image")?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.assets.find((asset) => asset.kind === "image")?.sha256).not.toBe(
      first.assets.find((asset) => asset.kind === "image")?.sha256
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
