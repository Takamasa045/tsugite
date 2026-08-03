import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { loadBackendCapabilities } from "../src/backends/capabilities.js";
// @ts-expect-error backend modules are plain ESM without type declarations
import {
  REMOTION_PRESET_REGISTRY,
  resolveRemotionPreset
} from "../backends/remotion/presetRegistry.mjs";
// @ts-expect-error backend modules are plain ESM without type declarations
import {
  UMESHU_CAPTION_LAYOUT,
  UMESHU_LYRIC_STYLE
} from "../backends/remotion/umeshuRomanceSummerEdit.js";

describe("remotion preset contract", () => {
  it("keeps the data-only capability declaration aligned with the executable registry", async () => {
    const backend = await loadBackendCapabilities("remotion");
    const registryIds = REMOTION_PRESET_REGISTRY.map((entry: { id: string }) => entry.id);
    const source = await readFile("backends/remotion/capabilities.yaml", "utf8");

    expect(backend?.capabilities.presets).toEqual(registryIds);
    expect(source).toContain(
      "presets: [article-dialogue-16x9, street-dialogue-16x9, tsugite-summer-camp-generated-16x9, miraichi-lastcall-9x16, orbital-showreel-16x9, skate-cam-16x9, umeshu-romance-summer-edit-16x9]"
    );
  });

  it("resolves every registered preset to an executable handler", () => {
    for (const entry of REMOTION_PRESET_REGISTRY) {
      expect(entry.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(typeof entry.handler).toBe("function");
      expect(resolveRemotionPreset(entry.id)).toBe(entry);
    }
    expect(resolveRemotionPreset("unregistered-preset")).toBeUndefined();
  });

  it("bundles the shared root and renders the first frame of every registered preset", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-preset-render-"));
    const bundleDir = join(root, "bundle");
    const publicDir = join(root, "public");

    try {
      await mkdir(publicDir);
      await copyFile(resolve("examples/local-fixture/media/clip-001.mp4"), join(publicDir, "preset-smoke.mp4"));
      const serveUrl = await bundle({
        entryPoint: resolve("backends/remotion/root.js"),
        outDir: bundleDir,
        publicDir,
        rootDir: process.cwd(),
        onProgress: () => undefined
      });

      for (const entry of REMOTION_PRESET_REGISTRY) {
        const portrait = entry.id.endsWith("-9x16");
        const manifest = minimalManifest(entry.id, portrait ? "9:16" : "16:9");
        const inputProps = { manifest };
        const composition = await selectComposition({
          serveUrl,
          id: "tsugite-render",
          inputProps,
          logLevel: "error",
          timeoutInMilliseconds: 120_000
        });
        if (entry.id === "tsugite-summer-camp-generated-16x9") {
          expect(composition.width).toBe(1280);
          expect(composition.height).toBe(720);
        }
        const skateCam = entry.id === "skate-cam-16x9";
        const frames = entry.id === "tsugite-summer-camp-generated-16x9"
          ? [0, 15, 45]
          : skateCam
            ? [0, 24]
            : [0];
        const renderedFrames = new Map<number, Buffer>();
        for (const frame of frames) {
          const output = join(root, `${entry.id}-${frame}.png`);
          await renderStill({
            serveUrl,
            composition,
            frame,
            imageFormat: "png",
            inputProps,
            output,
            overwrite: true,
            logLevel: "error",
            timeoutInMilliseconds: 120_000
          });
          expect((await stat(output)).size).toBeGreaterThan(0);
          renderedFrames.set(frame, await readFile(output));
        }
        if (entry.id === "tsugite-summer-camp-generated-16x9") {
          const baselineProps = {
            manifest: {
              ...manifest,
              captions: [],
              presentation: { ...manifest.presentation, preset: "unregistered-preset" }
            }
          };
          const baselineComposition = await selectComposition({
            serveUrl,
            id: "tsugite-render",
            inputProps: baselineProps,
            logLevel: "error",
            timeoutInMilliseconds: 120_000
          });
          for (const frame of [15, 45]) {
            const baselineOutput = join(root, `${entry.id}-${frame}-baseline.png`);
            await renderStill({
              serveUrl,
              composition: baselineComposition,
              frame,
              imageFormat: "png",
              inputProps: baselineProps,
              output: baselineOutput,
              overwrite: true,
              logLevel: "error",
              timeoutInMilliseconds: 120_000
            });
            const overlayFrame = renderedFrames.get(frame);
            expect(overlayFrame).toBeDefined();
            expect(overlayFrame!.equals(await readFile(baselineOutput))).toBe(false);
          }
        }
        if (skateCam) {
          const effectBaselineProps = {
            manifest: {
              ...manifest,
              presentation: { ...manifest.presentation, afterimage_effects: [], doodle_effects: [] }
            }
          };
          const effectBaselineComposition = await selectComposition({
            serveUrl,
            id: "tsugite-render",
            inputProps: effectBaselineProps,
            logLevel: "error",
            timeoutInMilliseconds: 120_000
          });
          const effectBaselineOutput = join(root, `${entry.id}-24-effect-baseline.png`);
          await renderStill({
            serveUrl,
            composition: effectBaselineComposition,
            frame: 24,
            imageFormat: "png",
            inputProps: effectBaselineProps,
            output: effectBaselineOutput,
            overwrite: true,
            logLevel: "error",
            timeoutInMilliseconds: 120_000
          });
          expect(renderedFrames.get(24)!.equals(await readFile(effectBaselineOutput))).toBe(false);

          const baselineProps = {
            manifest: {
              ...manifest,
              presentation: { ...manifest.presentation, preset: "unregistered-preset" }
            }
          };
          const baselineComposition = await selectComposition({
            serveUrl,
            id: "tsugite-render",
            inputProps: baselineProps,
            logLevel: "error",
            timeoutInMilliseconds: 120_000
          });
          const baselineOutput = join(root, `${entry.id}-24-baseline.png`);
          await renderStill({
            serveUrl,
            composition: baselineComposition,
            frame: 24,
            imageFormat: "png",
            inputProps: baselineProps,
            output: baselineOutput,
            overwrite: true,
            logLevel: "error",
            timeoutInMilliseconds: 120_000
          });
          expect(renderedFrames.get(24)!.equals(await readFile(baselineOutput))).toBe(false);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("keeps umeshu-romance-summer-edit R26 reggae lyrics-only and raw-source empty frames", async () => {
    // Layout contract: constraints.md 80/100 safe area for 1280x720 (x=80..1200 / y=100..620).
    expect(UMESHU_CAPTION_LAYOUT).toEqual({
      left: "6%",
      right: "6%",
      bottom: 100,
      height: 64,
      padding: "6px 18px",
      zIndex: 10
    });
    expect(UMESHU_LYRIC_STYLE.color).toBe("#F6C844");
    expect(UMESHU_LYRIC_STYLE.outline).toBe("#173F2B");
    expect(UMESHU_LYRIC_STYLE.shortShadow).toBe("#D8573C");
    expect(UMESHU_LYRIC_STYLE.fontFamily).toContain("Hiragino Maru Gothic ProN");
    expect(UMESHU_LYRIC_STYLE.webkitTextStroke).toMatch(/^3px\s+#173F2B$/);

    const fps = 24;
    const width = 1280;
    const height = 720;
    const captionStart = 90.44;
    const captionEnd = 91.56;
    const firstActiveFrame = Math.ceil(captionStart * fps); // 2171 → 90.4583s
    const lastActiveFrame = Math.floor((captionEnd * fps) - 1e-9); // 2197 → 91.5417s
    const afterEndFrame = lastActiveFrame + 1;
    expect(firstActiveFrame / fps).toBeCloseTo(90.4583, 3);
    expect(lastActiveFrame / fps).toBeCloseTo(91.5417, 3);

    // Empty-overlay samples: title-card time, chapter boundary, no-lyric gap.
    const emptyFrames = [
      Math.round(0.5 * fps), // 12 → title-card window (0.35-1.12), must not draw title
      Math.round(18 * fps), // 432 → chapter boundary 夏の光→夢の香り
      Math.round(3 * fps) // 72 → gap between R01 end (2.32) and R02 start (4.10)
    ] as const;

    const root = await mkdtemp(join(tmpdir(), "tsugite-umeshu-caption-"));
    const bundleDir = join(root, "bundle");
    const publicDir = join(root, "public");

    try {
      await mkdir(publicDir);
      await copyFile(resolve("examples/local-fixture/media/clip-001.mp4"), join(publicDir, "preset-smoke.mp4"));
      const serveUrl = await bundle({
        entryPoint: resolve("backends/remotion/root.js"),
        outDir: bundleDir,
        publicDir,
        rootDir: process.cwd(),
        onProgress: () => undefined
      });

      const captionText = "縁側に";
      const withCaptions = umeshuR26Manifest({
        caption: { id: "R26", text: captionText, start: captionStart, end: captionEnd },
        includeCaption: true,
        includeDecorations: true
      });
      const withoutCaptions = umeshuR26Manifest({
        caption: { id: "R26", text: captionText, start: captionStart, end: captionEnd },
        includeCaption: false,
        includeDecorations: true
      });
      // Unknown preset + no captions = pure raw-source baseline (no overlay at all).
      const rawBaseline = umeshuR26Manifest({
        caption: { id: "R26", text: captionText, start: captionStart, end: captionEnd },
        includeCaption: false,
        includeDecorations: false,
        preset: "unregistered-preset"
      });

      const withComposition = await selectComposition({
        serveUrl,
        id: "tsugite-render",
        inputProps: { manifest: withCaptions },
        logLevel: "error",
        timeoutInMilliseconds: 120_000
      });
      const withoutComposition = await selectComposition({
        serveUrl,
        id: "tsugite-render",
        inputProps: { manifest: withoutCaptions },
        logLevel: "error",
        timeoutInMilliseconds: 120_000
      });
      const rawComposition = await selectComposition({
        serveUrl,
        id: "tsugite-render",
        inputProps: { manifest: rawBaseline },
        logLevel: "error",
        timeoutInMilliseconds: 120_000
      });
      expect(withComposition.width).toBe(width);
      expect(withComposition.height).toBe(height);

      const framesToCheck = [firstActiveFrame, lastActiveFrame, afterEndFrame, ...emptyFrames] as const;
      const rendered = new Map<number, { withCaption: Buffer; noCaptionPreset: Buffer; raw: Buffer }>();

      for (const frame of framesToCheck) {
        const withPath = join(root, `umeshu-r26-${frame}-with.png`);
        const noCapPath = join(root, `umeshu-r26-${frame}-nocap.png`);
        const rawPath = join(root, `umeshu-r26-${frame}-raw.png`);
        await renderStill({
          serveUrl,
          composition: withComposition,
          frame,
          imageFormat: "png",
          inputProps: { manifest: withCaptions },
          output: withPath,
          overwrite: true,
          logLevel: "error",
          timeoutInMilliseconds: 120_000
        });
        await renderStill({
          serveUrl,
          composition: withoutComposition,
          frame,
          imageFormat: "png",
          inputProps: { manifest: withoutCaptions },
          output: noCapPath,
          overwrite: true,
          logLevel: "error",
          timeoutInMilliseconds: 120_000
        });
        await renderStill({
          serveUrl,
          composition: rawComposition,
          frame,
          imageFormat: "png",
          inputProps: { manifest: rawBaseline },
          output: rawPath,
          overwrite: true,
          logLevel: "error",
          timeoutInMilliseconds: 120_000
        });
        rendered.set(frame, {
          withCaption: await readFile(withPath),
          noCaptionPreset: await readFile(noCapPath),
          raw: await readFile(rawPath)
        });
      }

      const safe = { xMin: 80, xMax: 1200, yMin: 100, yMax: 620 };
      // Caption band at bottom:100 / height:64 → y=556..620 on 720p.
      // overflow:hidden on container keeps stroke/shadow inside y<=620.
      const captionBand = {
        yMin: height - UMESHU_CAPTION_LAYOUT.bottom - UMESHU_CAPTION_LAYOUT.height,
        yMax: height - UMESHU_CAPTION_LAYOUT.bottom
      };
      expect(captionBand.yMin).toBe(556);
      expect(captionBand.yMax).toBe(620);

      for (const frame of [firstActiveFrame, lastActiveFrame] as const) {
        const pair = rendered.get(frame)!;
        // No letterbox/title/chapter/wash: no-caption preset matches raw source exactly.
        expect(
          pair.noCaptionPreset.equals(pair.raw),
          `frame ${frame} no-caption preset must match raw baseline`
        ).toBe(true);

        const analysis = await analyzeReggaeCaptionOverlay(pair.withCaption, pair.raw, {
          width,
          height,
          safe,
          captionBand
        });
        expect(analysis.diffPixelCount, `frame ${frame} should paint caption pixels`).toBeGreaterThan(40);
        expect(analysis.bbox, `frame ${frame} caption bbox`).not.toBeNull();
        expect(analysis.bbox!.xMin).toBeGreaterThanOrEqual(safe.xMin);
        expect(analysis.bbox!.xMax).toBeLessThanOrEqual(safe.xMax);
        expect(analysis.bbox!.yMin).toBeGreaterThanOrEqual(safe.yMin);
        expect(analysis.bbox!.yMax).toBeLessThanOrEqual(safe.yMax);
        // Container bottom edge is y=620; text must not spill into the lower letterbox zone.
        expect(analysis.bbox!.yMax).toBeLessThanOrEqual(captionBand.yMax);
        expect(analysis.bbox!.yMin).toBeGreaterThanOrEqual(captionBand.yMin - 4);
        // Warm yellow fill is visibly present. Its exact pixel area relative to
        // the outline varies with platform font rasterization.
        expect(analysis.yellowPixelCount, `frame ${frame} yellow fill must be present`).toBeGreaterThan(40);
        expect(analysis.maxYellowLuma, `frame ${frame} yellow fill must stay bright`).toBeGreaterThan(140);
        expect(analysis.maxYellowLuma).toBeGreaterThan(analysis.maxBaselineLumaInBand + 40);
        expect(analysis.hasGreenOutline, `frame ${frame} deep green outline`).toBe(true);
        expect(analysis.hasRedOrangeShadow, `frame ${frame} red-orange short shadow`).toBe(true);
      }

      const after = rendered.get(afterEndFrame)!;
      const afterAnalysis = await analyzeReggaeCaptionOverlay(after.withCaption, after.raw, {
        width,
        height,
        safe,
        captionBand
      });
      expect(afterAnalysis.diffPixelCount, "caption must hide after active end").toBeLessThan(8);
      expect(after.withCaption.equals(after.raw)).toBe(true);
      expect(after.noCaptionPreset.equals(after.raw)).toBe(true);

      // title-card / chapter / gap: preset with decorations still matches raw baseline
      // (proves title, chapter labels, letterbox, wash, vignette, grain, flash, fades are gone).
      for (const frame of emptyFrames) {
        const pair = rendered.get(frame)!;
        expect(
          pair.withCaption.equals(pair.raw),
          `empty frame ${frame} with title/chapter manifest must match raw baseline`
        ).toBe(true);
        expect(
          pair.noCaptionPreset.equals(pair.raw),
          `empty frame ${frame} no-caption preset must match raw baseline`
        ).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 240_000);

});

function umeshuR26Manifest(options: {
  caption: { id: string; text: string; start: number; end: number };
  includeCaption: boolean;
  includeDecorations?: boolean;
  preset?: string;
}) {
  const includeDecorations = options.includeDecorations !== false;
  return {
    meta: {
      aspect: "16:9" as const,
      fps: 24,
      target_duration_seconds: 92,
      slug: "umeshu-romance-summer-edit-r26-regression",
      width: 1280,
      height: 720
    },
    // Short 1280x720 clip pins render size; remaining timeline stays black under the source.
    clips: [
      {
        id: "size-anchor",
        src: "preset-smoke.mp4",
        in: 0,
        out: 1,
        duration: 1,
        fps: 24,
        resolution: { width: 1280, height: 720 },
        audio: false
      }
    ],
    audio: { bgm: [], narration: [], sfx: [] },
    captions: options.includeCaption
      ? [
          ...(includeDecorations
            ? [{ id: "title-card", text: "梅酒ロマンス", start: 0.35, end: 1.12, emphasis: [] as string[] }]
            : []),
          { ...options.caption, emphasis: [] as string[] }
        ]
      : includeDecorations
        ? [{ id: "title-card", text: "梅酒ロマンス", start: 0.35, end: 1.12, emphasis: [] as string[] }]
        : [],
    images: [],
    speakers: [],
    chapters: includeDecorations
      ? [
          { title: "夏の光", start: 0, end: 18 },
          { title: "夢の香り", start: 18, end: 40 },
          { title: "近づく距離", start: 40, end: 64 },
          { title: "夜のグラス", start: 64, end: 82 },
          { title: "朝までの余韻", start: 82, end: 92 }
        ]
      : [],
    presentation: {
      preset: options.preset ?? "umeshu-romance-summer-edit-16x9",
      title: "umeshu-r26-regression",
      draft: true
    }
  };
}

async function analyzeReggaeCaptionOverlay(
  withCaptionPng: Buffer,
  baselinePng: Buffer,
  options: {
    width: number;
    height: number;
    safe: { xMin: number; xMax: number; yMin: number; yMax: number };
    captionBand: { yMin: number; yMax: number };
  }
) {
  const withRaw = await sharp(withCaptionPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const baseRaw = await sharp(baselinePng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(withRaw.info.width).toBe(options.width);
  expect(withRaw.info.height).toBe(options.height);
  expect(baseRaw.info.width).toBe(options.width);
  expect(baseRaw.info.height).toBe(options.height);

  const withPixels = withRaw.data;
  const basePixels = baseRaw.data;
  let diffPixelCount = 0;
  let maxYellowLuma = 0;
  let maxBaselineLumaInBand = 0;
  let yellowPixelCount = 0;
  let greenOutlineCount = 0;
  let redOrangeShadowCount = 0;
  let xMin = options.width;
  let xMax = 0;
  let yMin = options.height;
  let yMax = 0;

  for (let y = 0; y < options.height; y += 1) {
    for (let x = 0; x < options.width; x += 1) {
      const idx = (y * options.width + x) * 4;
      const wr = withPixels[idx]!;
      const wg = withPixels[idx + 1]!;
      const wb = withPixels[idx + 2]!;
      const br = basePixels[idx]!;
      const bg = basePixels[idx + 1]!;
      const bb = basePixels[idx + 2]!;
      const delta = Math.abs(wr - br) + Math.abs(wg - bg) + Math.abs(wb - bb);
      // Warm yellow fill #F6C844 (approx high R/G, lower B) — primary face of the glyph.
      const yellowish = wr > 160 && wg > 120 && wr >= wb + 30 && wg >= wb + 20;
      // Deep green outline #173F2B.
      const greenish = wg > wr + 10 && wg > wb && wr < 90 && wg < 140 && wb < 90;
      // Red-orange short shadow #D8573C.
      const redOrange = wr > 140 && wr > wg + 20 && wr > wb + 40 && wg > 40 && wb < 120;
      const luma = 0.299 * wr + 0.587 * wg + 0.114 * wb;
      const baseLuma = 0.299 * br + 0.587 * bg + 0.114 * bb;

      if (
        y >= options.captionBand.yMin
        && y < options.captionBand.yMax
        && x >= options.safe.xMin
        && x < options.safe.xMax
      ) {
        maxBaselineLumaInBand = Math.max(maxBaselineLumaInBand, baseLuma);
      }

      if (delta < 40) continue;
      if (yellowish || greenish || redOrange) {
        diffPixelCount += 1;
        if (yellowish) {
          yellowPixelCount += 1;
          maxYellowLuma = Math.max(maxYellowLuma, luma);
        }
        if (greenish) greenOutlineCount += 1;
        if (redOrange) redOrangeShadowCount += 1;
        xMin = Math.min(xMin, x);
        xMax = Math.max(xMax, x);
        yMin = Math.min(yMin, y);
        yMax = Math.max(yMax, y);
      }
    }
  }

  return {
    diffPixelCount,
    yellowPixelCount,
    maxYellowLuma,
    maxBaselineLumaInBand,
    greenOutlineCount,
    redOrangeShadowCount,
    hasGreenOutline: greenOutlineCount > 5,
    hasRedOrangeShadow: redOrangeShadowCount > 5,
    bbox: diffPixelCount === 0
      ? null
      : { xMin, xMax, yMin, yMax }
  };
}

function minimalManifest(preset: string, aspect: "16:9" | "9:16") {
  const orbitalClips = ["story", "character", "explainer"].map((id) => ({
    id,
    src: "preset-smoke.mp4",
    in: 0,
    out: 1,
    duration: 1,
    fps: 30,
    resolution: { width: 320, height: 180 },
    audio: false
  }));
  const orbital = preset === "orbital-showreel-16x9";
  const skateCam = preset === "skate-cam-16x9";
  const generatedSummerCamp = preset === "tsugite-summer-camp-generated-16x9";
  const generatedClip = {
    ...orbitalClips[0],
    out: 2,
    duration: 2,
    resolution: { width: 1280, height: 720 }
  };
  return {
    meta: {
      aspect,
      fps: 30,
      target_duration_seconds: orbital ? 30 : generatedSummerCamp || skateCam ? 2 : 1,
      slug: `preset-smoke-${preset}`
    },
    clips: orbital ? orbitalClips : generatedSummerCamp ? [generatedClip] : [],
    audio: { bgm: [], narration: [], sfx: [] },
    captions: generatedSummerCamp ? [
      { id: "summer-story", text: "第3回、追加決定。", start: 0, end: 1, emphasis: [], visual: { kind: "hook", sale_label: "全3回｜申込受付開始", headline: "第3回、追加決定。", detail: "一本を完成させる。", points: ["8月11日"] } },
      { id: "summer-price", text: "全3回を、いま。", start: 1, end: 2, emphasis: [], visual: { kind: "price", headline: "全3回を、いま。", today_label: "ウェビナー期間中", today_price: "6,980円", after_label: "終了後", after_price: "9,800円" } }
    ] : [],
    images: skateCam
      ? [{ id: "preset-smoke-alpha", src: "preset-smoke.mp4", alt: "afterimage smoke fixture" }]
      : [],
    speakers: [],
    presentation: {
      preset,
      title: preset,
      draft: true,
      ...(skateCam
        ? {
            afterimage_effects: [
              {
                id: "preset-smoke-trick",
                asset_id: "preset-smoke-alpha",
                start: 0.5,
                end: 1.5,
                timing_fps: 30,
                delays_frames: [3, 6],
                opacities: [0.34, 0.18]
              }
            ],
            doodle_effects: [
              {
                id: "preset-smoke-doodle",
                kind: "jump",
                start: 0.25,
                end: 1.75
              }
            ]
          }
        : {}),
      ...(orbital
        ? {
            featured: orbitalClips.map((clip, index) => ({
              clip_id: clip.id,
              label: clip.id,
              counter: `0${index + 1} / 03`
            }))
          }
        : {})
    }
  };
}
