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
import {
  audioTrackTiming,
  clipSequenceTimings,
  secondsToFrames,
  totalDuration
} from "../backends/remotion/timing.mjs";
import {
  captionMotionState,
  captionSegments,
  lyricChunks,
  lyricChunkReveal,
  resolveCaptionStyle
} from "../backends/remotion/captionMotion.mjs";
import { beatEnergy, beatVideoScale, LYRIC_IMPACTS } from "../backends/remotion/lyricBeatGrid.mjs";
import {
  OFFTHREAD_VIDEO_FETCH_GUARD,
  resolveRenderMediaSettings
} from "../backends/remotion/renderSettings.mjs";

describe("remotion backend helpers", () => {
  it("retries transient local frame fetches during video rendering", () => {
    expect(OFFTHREAD_VIDEO_FETCH_GUARD).toEqual({
      delayRenderRetries: 10,
      delayRenderTimeoutInMilliseconds: 180_000
    });
  });

  it("reduces temporary storage for high pixel-budget renders", () => {
    expect(resolveRenderMediaSettings({
      width: 1920,
      height: 1080,
      durationInFrames: 299
    })).toEqual({
      concurrency: 1
    });
    expect(resolveRenderMediaSettings({
      width: 1920,
      height: 1080,
      durationInFrames: 300
    })).toEqual({
      concurrency: 1,
      imageFormat: "jpeg",
      jpegQuality: 90
    });
    expect(resolveRenderMediaSettings({
      width: 2560,
      height: 1440,
      durationInFrames: 724
    })).toEqual({
      concurrency: 1,
      imageFormat: "jpeg",
      jpegQuality: 90
    });
  });

  it("opts into cinematic impact captions without changing the default style", () => {
    expect(resolveCaptionStyle({ meta: {} })).toBe("standard");
    expect(resolveCaptionStyle({ meta: { caption_style: "cinematic-impact" } })).toBe("cinematic-impact");
    expect(resolveCaptionStyle({ meta: { caption_style: "lyric-kinetic" } })).toBe("lyric-kinetic");
  });

  it("splits lyric lines into pop-in chunks", () => {
    expect(lyricChunks("構造　想像　そこから創造")).toEqual(["構造", "想像", "そこから創造"]);
    expect(lyricChunks("ChatGPT Voice")).toEqual(["ChatGPT", "Voice"]);
    expect(lyricChunks("「なんか作って」じゃ届かぬ頂上")).toEqual(["「なんか作って」", "じゃ届かぬ頂上"]);
    expect(lyricChunks("手はいらない")).toEqual(["手はいらない"]);
  });

  it("peaks beat energy on kick times and impact hits", () => {
    expect(beatEnergy(7.2, LYRIC_IMPACTS, 0.12)).toBeGreaterThan(0.9);
    expect(beatEnergy(7.26, LYRIC_IMPACTS, 0.12)).toBeGreaterThan(0.4);
    expect(beatEnergy(9, LYRIC_IMPACTS, 0.12)).toBe(0);
    expect(beatVideoScale(9)).toBe(1);
    expect(beatVideoScale(7.2)).toBeGreaterThan(1.05);
  });

  it("reveals lyric chunks in sequence inside a caption window", () => {
    expect(lyricChunkReveal(3, 0, 24)).toEqual([1, 0, 0]);
    expect(lyricChunkReveal(3, 6, 24)).toEqual([1, 1, 0]);
    expect(lyricChunkReveal(3, 18, 24)).toEqual([1, 1, 1]);
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

  it("derives fractional clip sequences from cumulative frame boundaries", () => {
    const manifest = {
      meta: { target_duration_seconds: 0.06 },
      clips: [
        { in: 1, duration: 0.02 },
        { in: 2, duration: 0.02 },
        { in: 3, duration: 0.02 }
      ]
    };

    const timings = clipSequenceTimings(manifest.clips, 30);

    expect(timings).toEqual([
      { from: 0, durationInFrames: 1, trimBefore: 30 },
      { from: 1, durationInFrames: 0, trimBefore: 60 },
      { from: 1, durationInFrames: 1, trimBefore: 90 }
    ]);
    expect(timings.reduce((sum, timing) => sum + timing.durationInFrames, 0)).toBe(
      secondsToFrames(totalDuration(manifest), 30)
    );
    expect(timings.at(-1)!.from + timings.at(-1)!.durationInFrames).toBe(2);
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
