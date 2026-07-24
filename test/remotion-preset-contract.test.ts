import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBackendCapabilities } from "../src/backends/capabilities.js";
// @ts-expect-error backend modules are plain ESM without type declarations
import {
  REMOTION_PRESET_REGISTRY,
  resolveRemotionPreset
} from "../backends/remotion/presetRegistry.mjs";

describe("remotion preset contract", () => {
  it("keeps the data-only capability declaration aligned with the executable registry", async () => {
    const backend = await loadBackendCapabilities("remotion");
    const registryIds = REMOTION_PRESET_REGISTRY.map((entry: { id: string }) => entry.id);
    const source = await readFile("backends/remotion/capabilities.yaml", "utf8");

    expect(backend?.capabilities.presets).toEqual(registryIds);
    expect(source).toContain(
      "presets: [article-dialogue-16x9, street-dialogue-16x9, tsugite-summer-camp-generated-16x9, miraichi-lastcall-9x16, orbital-showreel-16x9]"
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
        const frames = entry.id === "tsugite-summer-camp-generated-16x9" ? [0, 15, 45] : [0];
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
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

});

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
      target_duration_seconds: orbital ? 30 : generatedSummerCamp ? 2 : 1,
      slug: `preset-smoke-${preset}`
    },
    clips: orbital ? orbitalClips : generatedSummerCamp ? [generatedClip] : [],
    audio: { bgm: [], narration: [], sfx: [] },
    captions: generatedSummerCamp ? [
      { id: "summer-story", text: "第3回、追加決定。", start: 0, end: 1, emphasis: [], visual: { kind: "hook", sale_label: "全3回｜申込受付開始", headline: "第3回、追加決定。", detail: "一本を完成させる。", points: ["8月11日"] } },
      { id: "summer-price", text: "全3回を、いま。", start: 1, end: 2, emphasis: [], visual: { kind: "price", headline: "全3回を、いま。", today_label: "ウェビナー期間中", today_price: "6,980円", after_label: "終了後", after_price: "9,800円" } }
    ] : [],
    images: [],
    speakers: [],
    presentation: {
      preset,
      title: preset,
      draft: true,
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
