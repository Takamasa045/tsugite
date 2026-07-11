import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activeCaptionAt,
  designScale,
  mouthFrameIndex,
  resolveSpeakerImage
} from "../backends/remotion/presentation.mjs";
import { audioTrackTiming } from "../backends/remotion/timing.mjs";
import {
  captionMotionState,
  captionSegments,
  resolveCaptionStyle
} from "../backends/remotion/captionMotion.mjs";

describe("remotion backend helpers", () => {
  it("opts into cinematic impact captions without changing the default style", () => {
    expect(resolveCaptionStyle({ meta: {} })).toBe("standard");
    expect(resolveCaptionStyle({ meta: { caption_style: "cinematic-impact" } })).toBe("cinematic-impact");
  });

  it("calculates bounded entrance and exit progress for impact captions", () => {
    const caption = { start: 1, end: 4 };

    expect(captionMotionState(caption, 0.9, 30).active).toBe(false);
    expect(captionMotionState(caption, 1, 30)).toMatchObject({ active: true, enter: 0, exit: 0 });
    expect(captionMotionState(caption, 1.5, 30)).toMatchObject({ active: true, enter: 1, exit: 0 });
    expect(captionMotionState(caption, 3.9, 30)).toMatchObject({ active: true, enter: 1 });
    expect(captionMotionState(caption, 3.9, 30).exit).toBeGreaterThan(0);
    expect(captionMotionState(caption, 4, 30).active).toBe(false);
  });

  it("splits emphasized phrases into renderable caption segments", () => {
    expect(captionSegments("その夜、川から提灯が噴き上がった。", ["提灯", "噴き上がった"])).toEqual([
      { text: "その夜、川から", emphasized: false },
      { text: "提灯", emphasized: true },
      { text: "が", emphasized: false },
      { text: "噴き上がった", emphasized: true },
      { text: "。", emphasized: false }
    ]);
  });

  it("places audio tracks on the timeline and honors end timing", () => {
    const manifest = {
      meta: { target_duration_seconds: 3 },
      clips: [{ duration: 3 }]
    };

    expect(audioTrackTiming({ start: 1, end: 2 }, manifest, 30)).toEqual({
      from: 30,
      durationInFrames: 30
    });
    expect(audioTrackTiming({}, manifest, 30)).toEqual({
      from: 0,
      durationInFrames: 90
    });
  });

  it("selects the active dialogue caption and resolves pose images with a neutral fallback", () => {
    const captions = [
      { id: "s01", speaker: "left", text: "one", start: 0, end: 0.5, pose: "curious" },
      { id: "s02", speaker: "right", text: "two", start: 0.5, end: 1 }
    ];
    const speaker = {
      id: "left",
      poses: { neutral: "left-neutral", curious: "left-curious" }
    };
    const images = [
      { id: "left-neutral", src: "neutral.png" },
      { id: "left-curious", src: "curious.png" }
    ];

    expect(activeCaptionAt(captions, 0.25)?.id).toBe("s01");
    expect(activeCaptionAt(captions, 0.75)?.id).toBe("s02");
    expect(resolveSpeakerImage(speaker, captions[0], images)?.src).toBe("curious.png");
    expect(resolveSpeakerImage(speaker, { ...captions[0], pose: "missing" }, images)?.src).toBe("neutral.png");
  });

  it("cycles real closed, half-open, and open mouth images only for the active speaker", () => {
    const caption = { id: "s01", speaker: "left", text: "one", start: 1, end: 2, pose: "neutral" };
    const speaker = {
      id: "left",
      poses: { neutral: "left-closed" },
      mouth_frames: ["left-closed", "left-half", "left-open"]
    };
    const listener = {
      id: "right",
      poses: { neutral: "right-closed" },
      mouth_frames: ["right-closed", "right-half", "right-open"]
    };
    const images = [
      { id: "left-closed", src: "left-closed.png" },
      { id: "left-half", src: "left-half.png" },
      { id: "left-open", src: "left-open.png" },
      { id: "right-closed", src: "right-closed.png" },
      { id: "right-half", src: "right-half.png" },
      { id: "right-open", src: "right-open.png" }
    ];

    expect(mouthFrameIndex(0, 30, 8)).toBe(0);
    expect(mouthFrameIndex(4, 30, 8)).toBe(1);
    expect(mouthFrameIndex(8, 30, 8)).toBe(2);
    expect(mouthFrameIndex(12, 30, 8)).toBe(1);
    expect(resolveSpeakerImage(speaker, caption, images, 30, 30)?.src).toBe("left-closed.png");
    expect(resolveSpeakerImage(speaker, caption, images, 34, 30)?.src).toBe("left-half.png");
    expect(resolveSpeakerImage(speaker, caption, images, 38, 30)?.src).toBe("left-open.png");
    expect(resolveSpeakerImage(listener, caption, images, 38, 30)?.src).toBe("right-closed.png");
  });

  it("scales the fixed 1920x1080 dialogue canvas to any 16:9 composition", () => {
    expect(designScale(1920, 1080)).toBe(1);
    expect(designScale(320, 180)).toBeCloseTo(1 / 6);
  });

  it("rejects backend payload paths outside the run directory contract", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-remotion-payload-"));
    const script = resolve("backends/remotion/render.mjs");
    const result = spawnSync(process.execPath, [script], {
      cwd: process.cwd(),
      input: JSON.stringify({
        runDir,
        manifestPath: join(runDir, "manifest.json"),
        outputPath: join(runDir, "..", "escaped.mp4"),
        reportPath: join(runDir, "render-report.json")
      }),
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outputPath must equal");
  });
});
