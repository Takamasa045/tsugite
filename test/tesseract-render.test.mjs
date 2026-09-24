import { link, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBackendCapabilities } from "../src/backends/capabilities.js";
import { projectSchema } from "../src/project/schema.js";
import { applyTesseractDocument } from "../backends/tesseract/document.mjs";
import { assertNoConflictingKeyframeActions, assertSupportedManifest, assertTesseractInputDimensions, buildTesseractCaptionLayerTargets, buildTesseractDocumentLayers, buildTesseractMotionActions, buildTesseractTextActions, describeTesseractMotion, resolveTesseractNativeOutputs } from "../backends/tesseract/manifest.mjs";
import { buildTesseractCaptionMotionActions } from "../backends/tesseract/textMotion.mjs";
import { assertPng, expectedExportDimensions, parsePayload, renderTesseract, validateProresSidecar, validateRenderedOutput } from "../backends/tesseract/render.mjs";

const temporaryDirectories = [];
const validTinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=", "base64");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Tesseract backend capabilities and project configuration", () => {
  it("declares only verified basic capabilities and omits Fast Edit", async () => {
    const backend = await loadBackendCapabilities("tesseract");
    expect(backend?.capabilities).toMatchObject({
      captions: true,
      transitions: true,
      audio_reactive: true,
      audio_mix: true,
      vertical: true,
      fps: [30],
      presets: ["tesseract-basic"]
    });
    expect(backend?.capabilities.fast_edit).toBeUndefined();
  });

  it("accepts backend-scoped local settings but rejects secret-looking option keys", () => {
    const base = { slug: "tesseract-test", name: "Tesseract test", manifest: "manifest.json" };
    const accepted = projectSchema.safeParse({
      ...base,
      edit: { backend: "tesseract", backend_options: { tesseract: { font_path: "assets/fonts/JP.ttf" } } }
    });
    expect(accepted.success).toBe(true);
    if (!accepted.success) return;
    expect(accepted.data.edit.backend_options?.tesseract).toEqual({ font_path: "assets/fonts/JP.ttf" });

    const rejected = projectSchema.safeParse({
      ...base,
      edit: { backend: "tesseract", backend_options: { tesseract: { access_token: "secret" } } }
    });
    expect(rejected.success).toBe(false);
    if (!rejected.success) expect(rejected.error.issues[0]?.message).toContain("must not contain credentials");
  });
});

describe("Tesseract manifest conversion", () => {
  it("preflights both declared ProRes sidecars and validates their independent output metadata", () => {
    const nativeEdit = {
      mode: "replace",
      payload: {
        document: {
          dimensions: { width: 1920, height: 1080 }, duration: 2,
          composition: { id: "main", layers: [{ type: "image", id: 3, source: { assetId: "logo" }, activeRange: { start: 0, duration: 1250 } }] }
        },
        export: { resolution: "4k", fps: 60, prores_sidecar: true, prores_alpha_solo: "main:3" }
      },
      primary_output: { width: 3840, height: 2160, fps: 60, audio_required: true },
      outputs: [
        { kind: "prores_mov", path: "final-prores.mov", duration_seconds: 2, width: 3840, height: 2160, fps: 60, video_codec: "prores", alpha_required: false, audio_required: true },
        { kind: "alpha_solo_prores_mov", path: "final-prores-alpha.mov", duration_seconds: 1.25, width: 3840, height: 2160, fps: 60, video_codec: "prores", alpha_required: true, audio_required: false }
      ]
    };
    const outputs = resolveTesseractNativeOutputs(nativeEdit, "darwin", 2);
    expect(outputs).toEqual([
      { kind: "prores_mov", path: "final-prores.mov", duration_seconds: 2, width: 3840, height: 2160, fps: 60, video_codec: "prores", alpha_required: false, audio_required: true },
      { kind: "alpha_solo_prores_mov", path: "final-prores-alpha.mov", duration_seconds: 1.25, width: 3840, height: 2160, fps: 60, video_codec: "prores", alpha_required: true, audio_required: false }
    ]);
    expect(() => resolveTesseractNativeOutputs(nativeEdit, "linux", 2)).toThrow(/only on macOS/);

    validateProresSidecar({ hasVideo: true, hasAudio: true, durationSeconds: 2, videoDurationSeconds: 2, width: 3840, height: 2160, fps: 60, videoCodec: "prores", pixelFormat: "yuv422p10le", sizeBytes: 100 }, outputs[0]);
    validateProresSidecar({ hasVideo: true, hasAudio: false, durationSeconds: 1.25, videoDurationSeconds: 1.25, width: 3840, height: 2160, fps: 60, videoCodec: "prores", pixelFormat: "yuva444p10le", sizeBytes: 100 }, outputs[1]);

    expect(() => validateProresSidecar({ hasVideo: true, hasAudio: false, durationSeconds: 1.75, videoDurationSeconds: 1.75, width: 3840, height: 2160, fps: 60, videoCodec: "prores", pixelFormat: "yuva444p10le", sizeBytes: 100 }, outputs[1])).toThrow(/duration/);
    expect(() => validateProresSidecar({ hasVideo: true, hasAudio: false, durationSeconds: 1.25, videoDurationSeconds: 1.25, width: 3840, height: 2160, fps: 60, videoCodec: "h264", pixelFormat: "yuva444p10le", sizeBytes: 100 }, outputs[1])).toThrow(/video codec/);
    expect(() => validateProresSidecar({ hasVideo: true, hasAudio: false, durationSeconds: 1.25, videoDurationSeconds: 1.25, width: 3840, height: 2160, fps: 60, videoCodec: "prores", pixelFormat: "yuv422p10le", sizeBytes: 100 }, outputs[1])).toThrow(/preserve alpha/);
    expect(() => validateProresSidecar({ hasVideo: true, hasAudio: true, durationSeconds: 1.25, videoDurationSeconds: 1.25, width: 3840, height: 2160, fps: 60, videoCodec: "prores", pixelFormat: "yuva444p10le", sizeBytes: 100 }, outputs[1])).toThrow(/audio presence/);
  });

  it("maps caption ids to the exact text layer id, timeline interval, and generated baseline position", () => {
    const manifest = basicManifest({
      captions: [{ id: "caption-a", text: "日本語字幕", start: 0.5, end: 1.5, visual: {
        headline: "日本語字幕",
        motion: { audio_reactive: { source_track_id: "music", mode: "shake", strength: 0.5, measurement_window_ms: 100 } }
      } }]
    });
    const textActions = buildTesseractTextActions(manifest, {
      compositionId: "main", firstLayerId: 3, fontFamily: "Noto Sans JP Thin", fontStyle: "Regular",
      width: 1920, height: 1080, durationSeconds: 2
    });
    const targets = buildTesseractCaptionLayerTargets(manifest, textActions);
    expect(targets).toEqual([{ captionId: "caption-a", layerId: 3, timelineStartMs: 500, durationMs: 1000, baselinePosition: [960.5, 929] }]);
  });

  it("rejects a caption headline that differs from the actual rendered caption text", () => {
    const manifest = basicManifest({ captions: [{ id: "caption-a", text: "Actual", start: 0, end: 1, visual: { headline: "Different" } }] });
    expect(() => assertSupportedManifest(manifest)).toThrow("headline must exactly match");
  });

  it("creates editable text position, scale, and opacity tracks from reviewed caption phase cues", () => {
    const manifest = basicManifest({
      captions: [{ id: "caption-a", text: "日本語字幕", start: 0.5, end: 1.5, visual: {
        headline: "日本語字幕",
        motion: {
          entrance: { preset: "slide-left", target: "text", duration_seconds: 0.5 },
          emphasis: { preset: "pulse", target: "text", duration_seconds: 0.4 },
          exit: { preset: "fade", target: "text", duration_seconds: 0.4 }
        }
      } }]
    });
    assertSupportedManifest(manifest);
    const textActions = buildTesseractTextActions(manifest, {
      compositionId: "main", firstLayerId: 3, fontFamily: "Noto Sans JP Thin", fontStyle: "Regular",
      width: 1920, height: 1080, durationSeconds: 2
    });
    const actions = buildTesseractCaptionMotionActions(manifest, {
      compositionId: "main", textActions, width: 1920, height: 1080, fps: 30
    });
    expect(actions.map((action) => action.type)).toEqual(["setFxPositionKeyframes", "setFxPropertyKeyframes", "setFxPropertyKeyframes", "setFxPropertyKeyframes"]);
    expect(actions[0].positionX.keyframes).toHaveLength(10);
    expect(actions[0].positionY.keyframes).toHaveLength(10);
    expect(actions[0].positionX.keyframes[0]).toMatchObject({ layerTime: 0, value: { value: 2726.5 } });
    expect(actions[0].positionX.keyframes.at(-1)).toMatchObject({ layerTime: 500, value: { value: 960.5 } });
    expect(actions.filter((action) => action.property?.propertyType.startsWith("scale")).map((action) => action.property.propertyType)).toEqual(["scaleX", "scaleY"]);
    expect(actions.find((action) => action.property?.propertyType === "opacity").keyframes.at(-1)).toMatchObject({ layerTime: 1_000, value: { value: 0 } });
  });

  it("rejects text motion cues whose target is not the approved caption text layer", () => {
    const manifest = basicManifest({ captions: [{ id: "caption-a", text: "Text", start: 0, end: 1, visual: {
      headline: "Text", motion: { entrance: { preset: "slide-left", target: "frame", duration_seconds: 0.4 } }
    } }] });
    expect(() => assertSupportedManifest(manifest)).toThrow("target must be 'text'");
  });

  it("generates the documented 2-clip Tesseract transition tracks and preserves the approved duration", () => {
    const presets = ["fade", "slide-left", "slide-right", "zoom-in", "zoom-out"];
    for (const preset of presets) {
      const manifest = basicManifest({ clips: [
        { ...basicManifest().clips[0], id: "clip-a", duration: 1, out: 1, motion: { transition_to_next: { preset, duration_seconds: 0.5, target: "frame" } } },
        { ...basicManifest().clips[0], id: "clip-b", duration: 1, out: 1 }
      ] });
      const layers = [
        { clipId: "clip-a", layerId: 1, timelineStartMs: 0, durationMs: 1_000, sourceStartMs: 0 },
        { clipId: "clip-b", layerId: 2, timelineStartMs: 1_000, durationMs: 1_000, sourceStartMs: 0 }
      ];
      const actions = buildTesseractMotionActions(manifest, { compositionId: "main", clipLayers: layers });
      expect(actions[0]).toMatchObject({ type: "setFxLayerTimeRemap", layerId: 1, timeRemap: { after: "hold" } });
      expect(actions[0].timeRemap.keyframes.at(-1)).toMatchObject({ time: 1_500, value: 999 });
      if (preset === "fade") expect(actions.some((action) => action.property?.layerId === 2 && action.property.propertyType === "opacity")).toBe(true);
      if (preset.startsWith("slide")) {
        const position = actions.find((action) => action.type === "setFxPositionKeyframes");
        expect(position.layerId).toBe(2);
        expect(position.positionX.keyframes).toHaveLength(10);
        expect(position.positionX.keyframes[0].value.value).toBe(preset === "slide-left" ? 2880 : -960);
        expect(position.positionX.keyframes.at(-1).value.value).toBe(960);
        expect(position.positionY.keyframes[0].value.value).toBe(540);
      }
      if (preset.startsWith("zoom")) {
        const scale = actions.find((action) => action.property?.layerId === 2 && action.property.propertyType === "scaleX");
        expect(scale.keyframes[0].value.value).toBe(preset === "zoom-in" ? 80 : 120);
        expect(scale.keyframes.at(-1).value.value).toBe(100);
      }
    }
  });

  it("fails closed when ordinary motion and audio reaction would replace the same native property track", () => {
    const motionAction = { type: "setFxPropertyKeyframes", property: { layerId: 7, propertyType: "scaleX" } };
    const pulseAction = { type: "setFxPropertyKeyframes", property: { layerId: 7, propertyType: "scaleX" } };
    expect(() => assertNoConflictingKeyframeActions([motionAction], [pulseAction])).toThrow("same keyframe property");
    expect(() => assertNoConflictingKeyframeActions([motionAction], [{ type: "setFxPropertyKeyframes", property: { layerId: 7, propertyType: "opacity" } }])).not.toThrow();
  });

  it("maps seconds to millisecond ranges and keeps audio source and placement clocks separate", () => {
    const manifest = basicManifest({
      meta: { aspect: "16:9", fps: 30, target_duration_seconds: 4, slug: "tesseract-fixture" },
      clips: [
        { id: "clip-1", src: "assets/clips/source.mp4", in: 1, out: 3, duration: 2, fps: 30, resolution: { width: 1920, height: 1080 }, audio: true },
        { id: "clip-2", src: "assets/clips/source.mp4", in: 3, out: 4, duration: 1, fps: 30, resolution: { width: 1920, height: 1080 }, audio: false }
      ],
      audio: { bgm: [{ id: "music", src: "assets/audio/music.wav", start: 0.5, end: 2.5, volume: 0.25 }], narration: [], sfx: [] }
    });
    const result = buildTesseractDocumentLayers(manifest, {
      assetIds: new Map([["assets/clips/source.mp4", "video-source"], ["assets/audio/music.wav", "audio-source"]]),
      sourceInfo: new Map([
        ["assets/clips/source.mp4", { hasVideo: true, hasAudio: true, durationSeconds: 5, width: 1920, height: 1080 }],
        ["assets/audio/music.wav", { hasVideo: false, hasAudio: true, durationSeconds: 8 }]
      ]),
      durationSeconds: 4
    });

    expect(result.layers[1]).toMatchObject({
      type: "Video",
      activeRange: { start: 0, duration: 2000 },
      sourceRange: { start: 1000, duration: 2000 },
      volume: 1
    });
    expect(result.layers[0]).toMatchObject({
      type: "Video",
      activeRange: { start: 2000, duration: 1000 },
      sourceRange: { start: 3000, duration: 1000 }
    });
    expect(result.layers[0]).not.toHaveProperty("volume");
    expect(result.layers[2]).toMatchObject({
      type: "Audio",
      activeRange: { start: 500, duration: 2000 },
      sourceRange: { start: 0, duration: 2000 },
      sourceIntrinsicDuration: 8000,
      volume: 0.25,
      captionsEnabled: false
    });
  });

  it("builds a duration-preserving hold-and-fade transition and video zoom keyframes", () => {
    const manifest = basicManifest({
      meta: { aspect: "16:9", fps: 30, target_duration_seconds: 2, slug: "motion-fixture" },
      clips: [
        { id: "clip-red", src: "assets/clips/red.mp4", in: 0, out: 1, duration: 1, fps: 30, resolution: { width: 1920, height: 1080 }, audio: false,
          motion: { transition_to_next: { preset: "fade", description: "Fade through black at the cut", target: "frame", duration_seconds: 0.4, easing: "linear" } } },
        { id: "clip-blue", src: "assets/clips/blue.mp4", in: 0, out: 1, duration: 1, fps: 30, resolution: { width: 1920, height: 1080 }, audio: false,
          motion: { entrance: { preset: "zoom-in", description: "Slowly zoom into the frame", target: "frame", duration_seconds: 0.6, easing: "linear" } } }
      ]
    });
    const layers = buildTesseractDocumentLayers(manifest, {
      assetIds: new Map([["assets/clips/red.mp4", "red"], ["assets/clips/blue.mp4", "blue"]]),
      sourceInfo: new Map([
        ["assets/clips/red.mp4", { hasVideo: true, hasAudio: false, durationSeconds: 1, width: 1920, height: 1080 }],
        ["assets/clips/blue.mp4", { hasVideo: true, hasAudio: false, durationSeconds: 1, width: 1920, height: 1080 }]
      ]),
      durationSeconds: 2
    });
    const actions = buildTesseractMotionActions(manifest, { compositionId: "main", clipLayers: layers.clipLayers });

    expect(layers.durationSeconds).toBe(2);
    expect(layers.layers[0]).toMatchObject({ type: "Video", id: 2, activeRange: { start: 1000, duration: 1000 } });
    expect(layers.layers[1]).toMatchObject({ type: "Video", id: 1, activeRange: { start: 0, duration: 1400 }, sourceRange: { start: 0, duration: 1000 } });
    expect(layers.layers[1].transform).toEqual({
      anchorPoint: [960, 540], position: [960, 540], scale: [100, 100], rotation: 0, opacity: 100
    });
    expect(layers.clipLayers).toEqual([
      { clipId: "clip-red", layerId: 1, timelineStartMs: 0, durationMs: 1000, sourceStartMs: 0, transitionOutMs: 400, baselinePosition: [960, 540] },
      { clipId: "clip-blue", layerId: 2, timelineStartMs: 1000, durationMs: 1000, sourceStartMs: 0, transitionOutMs: 0, baselinePosition: [960, 540] }
    ]);
    expect(actions).toHaveLength(4);
    expect(actions[0]).toMatchObject({
      type: "setFxLayerTimeRemap",
      compositionId: "main",
      layerId: 1,
      timeRemap: {
        keyframes: [
          { time: 0, value: 0 },
          { time: 1000, value: 999 },
          { time: 1400, value: 999 }
        ],
        before: "inactive",
        after: "hold"
      }
    });
    expect(actions[1]).toMatchObject({
      type: "setFxPropertyKeyframes",
      property: { layerId: 2, propertyType: "opacity" },
      keyframes: [
        { layerTime: 0, value: { type: "float", value: 0 } },
        { layerTime: 400, value: { type: "float", value: 100 } }
      ]
    });
    expect(actions.slice(2)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        property: { layerId: 2, propertyType: "scaleX" },
        keyframes: [
          expect.objectContaining({ layerTime: 0, value: { type: "float", value: 100 } }),
          expect.objectContaining({ layerTime: 600, value: { type: "float", value: 110 } })
        ]
      }),
      expect.objectContaining({
        property: { layerId: 2, propertyType: "scaleY" },
        keyframes: [
          expect.objectContaining({ layerTime: 0, value: { type: "float", value: 100 } }),
          expect.objectContaining({ layerTime: 600, value: { type: "float", value: 110 } })
        ]
      })
    ]));
    expect(describeTesseractMotion(manifest)).toMatchObject({
      applied_cues: [
        { target_type: "clip", target_id: "clip-red", phase: "transition_to_next", preset: "fade", duration_seconds: 0.4 },
        { target_type: "clip", target_id: "clip-blue", phase: "entrance", preset: "zoom-in", duration_seconds: 0.6 }
      ]
    });
  });

  it("uses the trimmed source start in a motion time-remap action", () => {
    const manifest = basicManifest({
      meta: { aspect: "16:9", fps: 30, target_duration_seconds: 2, slug: "trimmed-motion-fixture" },
      clips: [
        { id: "clip-red", src: "assets/clips/red.mp4", in: 1, out: 2, duration: 1, fps: 30, resolution: { width: 1920, height: 1080 }, audio: true,
          motion: { transition_to_next: { preset: "fade", description: "Fade into the next clip", target: "frame", duration_seconds: 0.4 } } },
        { id: "clip-blue", src: "assets/clips/blue.mp4", in: 0, out: 1, duration: 1, fps: 30, resolution: { width: 1920, height: 1080 }, audio: false }
      ]
    });
    const layers = buildTesseractDocumentLayers(manifest, {
      assetIds: new Map([["assets/clips/red.mp4", "red"], ["assets/clips/blue.mp4", "blue"]]),
      sourceInfo: new Map([
        ["assets/clips/red.mp4", { hasVideo: true, hasAudio: true, durationSeconds: 2, width: 1920, height: 1080 }],
        ["assets/clips/blue.mp4", { hasVideo: true, hasAudio: false, durationSeconds: 1, width: 1920, height: 1080 }]
      ]),
      durationSeconds: 2
    });
    const actions = buildTesseractMotionActions(manifest, { compositionId: "main", clipLayers: layers.clipLayers });
    expect(layers.layers.find((layer) => layer.id === 1)).toMatchObject({ volume: 1, sourceRange: { start: 1000, duration: 1000 } });
    expect(actions[0].timeRemap.keyframes).toMatchObject([
      { time: 0, value: 1000 },
      { time: 1000, value: 1999 },
      { time: 1400, value: 1999 }
    ]);
  });

  it("holds shared-property motion neutral across cue gaps and rejects drifting gaps", () => {
    const manifest = basicManifest({
      meta: { aspect: "16:9", fps: 30, target_duration_seconds: 3, slug: "motion-gap-fixture" },
      clips: [{
        ...basicManifest().clips[0], out: 3, duration: 3,
        motion: {
          entrance: { preset: "fade", description: "Fade in", duration_seconds: 0.5 },
          exit: { preset: "fade", description: "Fade out", duration_seconds: 0.5 }
        }
      }]
    });
    const layer = { clipId: "clip-1", layerId: 1, timelineStartMs: 0, durationMs: 3000, sourceStartMs: 0 };
    const actions = buildTesseractMotionActions(manifest, { compositionId: "main", clipLayers: [layer] });
    expect(actions).toHaveLength(1);
    expect(actions[0].keyframes.map(({ layerTime, value }) => [layerTime, value.value])).toEqual([
      [0, 0], [500, 100], [2433, 100], [2467, 100], [2967, 0]
    ]);

    const drifting = basicManifest({
      meta: { aspect: "16:9", fps: 30, target_duration_seconds: 3, slug: "motion-drift-fixture" },
      clips: [{
        ...basicManifest().clips[0], out: 3, duration: 3,
        motion: {
          emphasis: { preset: "pulse", description: "Pulse once", duration_seconds: 0.5 },
          exit: { preset: "zoom-out", description: "Pull away", duration_seconds: 0.5 }
        }
      }]
    });
    expect(() => assertSupportedManifest(drifting)).toThrow(/boundary values differ|linear interpolation/);
  });

  it("rejects duplicate clip ids before motion actions can target the wrong layer", () => {
    const duplicateIds = basicManifest({
      meta: { aspect: "16:9", fps: 30, target_duration_seconds: 2, slug: "duplicate-motion-fixture" },
      clips: [
        { ...basicManifest().clips[0], id: "same-clip", out: 1, duration: 1 },
        { ...basicManifest().clips[0], id: "same-clip", src: "assets/clips/other.mp4", in: 0, out: 1, duration: 1 }
      ]
    });
    expect(() => assertSupportedManifest(duplicateIds)).toThrow(/unique clip ids; duplicate 'same-clip'/);
  });

  it("rejects unsupported display-affecting caption fields and Fast Edit", () => {
    expect(() => assertSupportedManifest(basicManifest({ captions: [{ text: "x", start: 0, end: 1, visual: { headline: "Styled" } }] })))
      .toThrow(/visual styling/);
    expect(() => assertSupportedManifest(basicManifest({ fast_edit: { beats: [] } })))
      .toThrow(/does not support Fast Edit/);
    expect(() => assertSupportedManifest(basicManifest({ extra_layer: true })))
      .toThrow(/manifest.extra_layer is not supported/);
  });

  it("rejects unsupported transition and motion instructions instead of approximating them", () => {
    expect(() => assertSupportedManifest(basicManifest({ transitions: [{ type: "fade" }] }))).toThrow(/top-level manifest.transitions/);
    expect(() => assertSupportedManifest(basicManifest({
      clips: [{ ...basicManifest().clips[0], motion: { entrance: { preset: "wipe", description: "Wipe the image" } } }]
    }))).toThrow(/not supported by Tesseract/);
    expect(() => assertSupportedManifest(basicManifest({
      clips: [{ ...basicManifest().clips[0], motion: { entrance: { preset: "zoom-in", description: "Zoom in", target: "face" } } }]
    }))).toThrow(/target 'face'/);
    expect(() => assertSupportedManifest(basicManifest({
      presentation: { preset: "tesseract-basic", motion_design: { summary: "Keep the scene dynamic" } }
    }))).toThrow(/summary alone|descriptive only/);
    expect(() => assertSupportedManifest(basicManifest({
      clips: [{ ...basicManifest().clips[0], id: "clip-1", motion: { transition_to_next: { preset: "fade", description: "Fade to next" } } }]
    }))).toThrow(/no following clip/);
  });

  it("creates text actions only from imported font metadata", () => {
    const manifest = basicManifest({
      presentation: { preset: "tesseract-basic", title: "English title" },
      captions: [{ id: "en-1", text: "English caption", start: 0.5, end: 1.5 }]
    });
    expect(() => buildTesseractTextActions(manifest, { compositionId: "main", firstLayerId: 2, width: 1920, height: 1080, durationSeconds: 2 }))
      .toThrow(/require a local font/);
    const actions = buildTesseractTextActions(manifest, {
      compositionId: "main", firstLayerId: 2, width: 1920, height: 1080, durationSeconds: 2,
      fontFamily: "Inter", fontStyle: "Regular"
    });
    expect(actions).toHaveLength(2);
    expect(actions[1]).toMatchObject({
      type: "createFxTextLayer",
      compositionId: "main",
      activeRange: { start: 500, duration: 1000 },
      sourceText: { text: "English caption", fontFamily: "Inter", fontStyle: "Regular" }
    });
    expect(actions[1].transform).toMatchObject({ anchorPoint: [806.5, 65], position: [960.5, 929] });
    expect(actions[1].transform.position.map((coordinate, index) => coordinate - actions[1].transform.anchorPoint[index]))
      .toEqual([154, 864]);
  });

  it("uses only fields identified by the installed document schema", () => {
    const schema = {
      type: "object",
      properties: {
        duration: { type: "number" },
        compositions: { type: "array", items: { $ref: "#/$defs/Composition" } }
      },
      $defs: {
        Composition: {
          type: "object",
          properties: {
            id: { type: "string" }, width: { type: "number" }, height: { type: "number" },
            layers: { type: "array", items: { type: "object" } }
          }
        }
      }
    };
    const document = { duration: 1, compositions: [{ id: "main", width: 1280, height: 720, layers: [] }] };
    const applied = applyTesseractDocument(document, schema, {
      width: 1920, height: 1080, durationSeconds: 3, layers: [{ type: "Video", id: 1 }]
    });
    expect(applied.compositionId).toBe("main");
    expect(applied.document).toEqual({ duration: 3, compositions: [{ id: "main", width: 1920, height: 1080, layers: [{ type: "Video", id: 1 }] }] });
    expect(() => applyTesseractDocument(document, { type: "object", properties: { length: { type: "number" } } }, {
      width: 1920, height: 1080, durationSeconds: 3, layers: []
    })).toThrow(/does not expose document.duration/);
  });

  it("writes root dimensions from the official document schema shape", () => {
    const schema = {
      type: "object",
      required: ["$schema", "formatVersion", "dimensions", "duration", "composition"],
      properties: {
        $schema: { type: "string" },
        formatVersion: { type: "integer" },
        dimensions: {
          type: "object",
          required: ["width", "height"],
          properties: { width: { type: "integer" }, height: { type: "integer" } }
        },
        duration: { type: "number" },
        composition: {
          type: "object",
          required: ["id", "layers", "name"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            layers: { type: "array", items: { type: "object" } }
          }
        }
      }
    };
    const document = {
      $schema: "test-schema",
      formatVersion: 1,
      dimensions: { width: 1080, height: 1920 },
      duration: 3,
      composition: { id: "main", layers: [], name: "Main" }
    };
    const applied = applyTesseractDocument(document, schema, {
      width: 1920, height: 1080, durationSeconds: 5, layers: [{ type: "Video", id: 1 }]
    });
    expect(applied.document.dimensions).toEqual({ width: 1920, height: 1080 });
    expect(applied.document.duration).toBe(5);
    expect(applied.document.composition.layers).toEqual([{ type: "Video", id: 1 }]);
  });
});

describe("Tesseract render validation", () => {
  it("requires a complete, CRC-valid, decodable PNG artifact", async () => {
    const directory = await tempDirectory("tsugite-png-validation-");
    const path = join(directory, "preview.png");
    await writeFile(path, validTinyPng);
    await expect(assertPng(path, "preview", directory)).resolves.toBeUndefined();

    await writeFile(path, validTinyPng.subarray(0, 8));
    await expect(assertPng(path, "preview", directory)).rejects.toThrow(/PNG/);

    const badCrcPng = Buffer.from(validTinyPng);
    badCrcPng[badCrcPng.length - 5] ^= 0x01;
    await writeFile(path, badCrcPng);
    await expect(assertPng(path, "preview", directory)).rejects.toThrow(/CRC/);
  });

  it("fails closed when export fps differs from the manifest", () => {
    expect(() => validateRenderedOutput({
      hasVideo: true, hasAudio: false, durationSeconds: 2, width: 1920, height: 1080, fps: 29.97, sizeBytes: 100
    }, basicManifest(), { width: 1920, height: 1080 }, 2)).toThrow(/refusing a mismatched render/);
    expect(() => validateRenderedOutput({
      hasVideo: true, hasAudio: false, durationSeconds: 2, width: 1280, height: 720, fps: 30, sizeBytes: 100
    }, basicManifest(), { width: 1920, height: 1080 }, 2)).toThrow(/do not match the reviewed 1080p export 1920x1080/);
  });

  it("treats native primary audio_required as an exact Gate 1 expectation", () => {
    const manifest = basicManifest({
      native_edit: {
        mode: "replace",
        payload: { document: { dimensions: { width: 1920, height: 1080 }, duration: 2, composition: { id: "main", layers: [] } } },
        primary_output: { width: 1920, height: 1080, fps: 30, audio_required: false }
      }
    });
    expect(() => validateRenderedOutput({
      hasVideo: true, hasAudio: true, durationSeconds: 2, width: 1920, height: 1080, fps: 30, sizeBytes: 100
    }, manifest, { width: 1920, height: 1080 }, 2)).toThrow(/audio presence does not match/);
  });

  it("rejects source dimensions that the pinned exporter will preserve before starting the CLI", async () => {
    const runDir = await tempDirectory("tsugite-tesseract-source-dimensions-");
    const projectRoot = await tempDirectory("tsugite-tesseract-project-");
    await mkdir(join(runDir, "assets", "clips"), { recursive: true });
    await writeFile(join(runDir, "assets", "clips", "source.mp4"), "video fixture");
    const manifestPath = join(runDir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(basicManifest()));
    const resolveCli = vi.fn();

    await expect(renderTesseract({
      runDir,
      manifestPath,
      outputPath: join(runDir, "final.mp4"),
      reportPath: join(runDir, "render-report.json"),
      projectRoot,
      backendOptions: {}
    }, {
      resolveCli,
      probeMedia: async () => ({
        hasVideo: true, hasAudio: false, durationSeconds: 2, videoDurationSeconds: 2,
        width: 640, height: 360, fps: 30, sizeBytes: 10
      })
    })).rejects.toThrow(/640x360; Tesseract export preserves source dimensions and requires 1920x1080/);
    expect(resolveCli).not.toHaveBeenCalled();
  });

  it("renders an isolated fixture through the adapter contract without starting a real CLI", async () => {
    const runDir = await tempDirectory("tsugite-tesseract-run-");
    const projectRoot = await tempDirectory("tsugite-tesseract-project-");
    const assetsRoot = join(runDir, "assets");
    const videoPath = join(assetsRoot, "clips", "source.mp4");
    const audioPath = join(assetsRoot, "audio", "music.wav");
    const fontPath = join(projectRoot, "assets", "fonts", "Inter.ttf");
    await mkdir(join(assetsRoot, "clips"), { recursive: true });
    await mkdir(join(assetsRoot, "audio"), { recursive: true });
    await mkdir(join(projectRoot, "assets", "fonts"), { recursive: true });
    await writeFile(videoPath, "fixture video placeholder");
    await writeFile(audioPath, "fixture audio placeholder");
    await writeFile(fontPath, "fixture font placeholder");

    const manifestPath = join(runDir, "manifest.json");
    const outputPath = join(runDir, "final.mp4");
    const reportPath = join(runDir, "render-report.json");
    const projectPath = join(runDir, "final.tsrct");
    const manifest = basicManifest({
      meta: { aspect: "16:9", fps: 30, target_duration_seconds: 2, slug: "tesseract-fixture" },
      clips: [{ id: "clip-1", src: "assets/clips/source.mp4", in: 1, out: 3, duration: 2, fps: 30, resolution: { width: 1920, height: 1080 }, audio: true }],
      audio: { bgm: [{ id: "music", src: "assets/audio/music.wav", start: 0.25, end: 1.25, volume: 0.2 }], narration: [], sfx: [] },
      presentation: { preset: "tesseract-basic", title: "English title" },
      captions: [{ id: "en-1", text: "English caption", start: 0.5, end: 1.5 }]
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const documentSchema = {
      type: "object",
      properties: { duration: { type: "number" }, composition: { $ref: "#/$defs/Composition" } },
      $defs: { Composition: { type: "object", properties: {
        id: { type: "string" }, width: { type: "number" }, height: { type: "number" }, layers: { type: "array", items: { type: "object" } }
      } } }
    };
    const emptyDocument = { duration: 1, composition: { id: "main", width: 1920, height: 1080, layers: [] } };
    const cliCalls = [];
    let appliedActions;
    const result = await renderTesseract({
      runDir, manifestPath, outputPath, reportPath, projectRoot,
      backendOptions: { font_path: "assets/fonts/Inter.ttf" }
    }, {
      platform: "darwin",
      resolveCli: async () => ({ ok: true, cliPath: "/fake/tsrct", version: "0.2.0" }),
      runCli: async (_cliPath, args) => {
        cliCalls.push([...args]);
        const command = args.slice(0, 2).join(" ");
        if (command === "project schema") return { status: 0, stdout: JSON.stringify(documentSchema), stderr: "" };
        if (command === "project create") {
          await writeFile(args[args.indexOf("--project") + 1], "editable-tsrct");
          return { status: 0, stdout: "", stderr: "" };
        }
        if (command === "project import-video" || command === "project import-asset") {
          const assetIdIndex = args.indexOf("--asset-id");
          if (assetIdIndex < 0 || !args[assetIdIndex + 1]) throw new Error(`${command} requires --asset-id`);
          return { status: 0, stdout: JSON.stringify({ assetId: args[assetIdIndex + 1], durationMs: 1000 }), stderr: "" };
        }
        if (command === "project import-font") return { status: 0, stdout: JSON.stringify({ fontFamily: "Inter", fontStyle: "Regular" }), stderr: "" };
        if (command === "project checkout") {
          await writeFile(args[args.indexOf("--output") + 1], JSON.stringify(emptyDocument));
          return { status: 0, stdout: "", stderr: "" };
        }
        if (command === "project apply") {
          appliedActions = JSON.parse(await readFile(args[args.indexOf("--actions") + 1], "utf8"));
          return { status: 0, stdout: "", stderr: "" };
        }
        if (command === "export --project") {
          await writeFile(args[args.indexOf("--output") + 1], "fixture-mp4");
          return { status: 0, stdout: "", stderr: "" };
        }
        if (command === "project commit") return { status: 0, stdout: "", stderr: "" };
        throw new Error(`unexpected fake CLI invocation: ${args.join(" ")}`);
      },
      probeMedia: async (path) => path.endsWith("/final.mp4")
        ? { hasVideo: true, hasAudio: true, durationSeconds: 2, width: 1920, height: 1080, fps: 30, sizeBytes: 10 }
        : path.endsWith(".wav")
          ? { hasVideo: false, hasAudio: true, durationSeconds: 8, width: undefined, height: undefined, fps: undefined, sizeBytes: 10 }
          : { hasVideo: true, hasAudio: true, durationSeconds: 5, width: 1920, height: 1080, fps: 30, sizeBytes: 10 },
      decodeVideo: async () => undefined
    });

    expect(result).toMatchObject({ backend: "tesseract", output_path: outputPath, manifest_path: manifestPath, editable_project_path: projectPath, fps: 30 });
    expect(cliCalls.map((args) => args.slice(0, 2))).toEqual([
      ["project", "schema"], ["project", "create"], ["project", "import-video"], ["project", "import-asset"],
      ["project", "import-font"], ["project", "checkout"], ["project", "commit"], ["project", "apply"], ["export", "--project"]
    ]);
    expect(appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "createFxTextLayer", sourceText: expect.objectContaining({ text: "English caption", fontFamily: "Inter" }) })
    ]));
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({ backend: "tesseract", output_path: outputPath, manifest_path: manifestPath, duration_seconds: 2, width: 1920, height: 1080, fps: 30 });
    expect(await readdir(runDir)).toEqual(expect.arrayContaining(["final.tsrct", "final.mp4", "render-report.json"]));
    expect((await readdir(runDir)).some((entry) => entry.startsWith(".tesseract-work-"))).toBe(false);
  });

  it("imports native assets and fonts, applies a schema-listed FX effect, reviews 4K/60, and validates preview artifacts", async () => {
    const runDir = await tempDirectory("tsugite-tesseract-native-");
    const projectRoot = await tempDirectory("tsugite-tesseract-project-");
    await mkdir(join(runDir, "assets", "clips"), { recursive: true });
    await mkdir(join(runDir, "assets", "images"), { recursive: true });
    await mkdir(join(runDir, "assets", "fonts"), { recursive: true });
    await writeFile(join(runDir, "assets", "clips", "source.mp4"), "video fixture");
    await writeFile(join(runDir, "assets", "images", "logo.png"), "image fixture");
    await writeFile(join(runDir, "assets", "fonts", "Inter.ttf"), "font fixture");

    const manifestPath = join(runDir, "manifest.json");
    const outputPath = join(runDir, "final.mp4");
    const reportPath = join(runDir, "render-report.json");
    const projectPath = join(runDir, "final.tsrct");
    const nativeDocument = {
      $schema: "https://jerboa.dev/schemas/fx-composition/editable/v1/document.schema.json",
      formatVersion: 1,
      dimensions: { width: 1920, height: 1080 },
      duration: 2,
      backgroundColor: null,
      composition: {
        id: "main",
        name: "Native fixture",
        layers: [
          { type: "video", id: 1, name: "source", source: { assetId: "clip-native-1" }, volume: 1 },
          { type: "image", id: 2, name: "logo", source: { assetId: "logo" } },
          { type: "image", id: 3, name: "alpha overlay", source: { assetId: "logo" }, activeRange: { start: 0, duration: 1250 } }
        ]
      }
    };
    const manifest = basicManifest({
      meta: { aspect: "16:9", fps: 60, target_duration_seconds: 2, slug: "native-fixture" },
      clips: [{ id: "clip-native-1", src: "assets/clips/source.mp4", in: 0, out: 2, duration: 2, fps: 30, resolution: { width: 1920, height: 1080 }, audio: false }],
      native_edit: {
        mode: "replace",
        payload: {
          document: nativeDocument,
          actions: [{ type: "addFxLayerEffect", compositionId: "main", layerId: 1, effectId: 4, effect: { type: "brightnessContrast", brightness: 5, contrast: 12 } }],
          export: { resolution: "4k", fps: 60, prores_sidecar: true, prores_alpha_solo: "main:3" }
        },
        primary_output: { width: 3840, height: 2160, fps: 60, audio_required: true },
        outputs: [
          { kind: "prores_mov", path: "final-prores.mov", duration_seconds: 2, width: 3840, height: 2160, fps: 60, video_codec: "prores", alpha_required: false, audio_required: true },
          { kind: "alpha_solo_prores_mov", path: "final-prores-alpha.mov", duration_seconds: 1.25, width: 3840, height: 2160, fps: 60, video_codec: "prores", alpha_required: true, audio_required: false }
        ],
        assets: [{ asset_id: "logo", src: "assets/images/logo.png", kind: "image" }],
        fonts: [{ src: "assets/fonts/Inter.ttf" }]
      }
    });
    await writeFile(manifestPath, JSON.stringify(manifest));

    const documentSchema = {
      type: "object",
      required: ["$schema", "formatVersion", "dimensions", "duration", "composition"],
      properties: {
        $schema: { type: "string" }, formatVersion: { type: "integer" },
        dimensions: { type: "object", properties: { width: { type: "integer" }, height: { type: "integer" } } },
        duration: { type: "number" }, composition: { $ref: "#/$defs/Composition" }
      },
      $defs: { Composition: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, layers: { type: "array", items: { type: "object" } } } } }
    };
    const effectAction = {
      type: "addFxLayerEffect", compositionId: "main", layerId: 1, effectId: 4,
      effect: { type: "brightnessContrast", brightness: 5, contrast: 12 }
    };
    const effectActionSchema = {
      discriminator: { propertyName: "type", mapping: { addFxLayerEffect: "#/$defs/AddEffect" } },
      oneOf: [{ $ref: "#/$defs/AddEffect" }],
      $defs: { AddEffect: { type: "object", properties: { type: { const: "addFxLayerEffect" }, compositionId: { type: "string" }, layerId: { type: "integer" }, effectId: { type: "integer" }, effect: { type: "object" } }, required: ["type", "compositionId", "layerId", "effectId", "effect"] } }
    };
    const emptyDocument = { ...nativeDocument, composition: { ...nativeDocument.composition, layers: [] } };
    const cliCalls = [];
    let committedDocument;
    let appliedActions;
    const result = await renderTesseract({
      runDir, manifestPath, outputPath, reportPath, projectRoot, backendOptions: {}
    }, {
      platform: "darwin",
      resolveCli: async () => ({ ok: true, cliPath: "/fake/tsrct", version: "0.2.0" }),
      runCli: async (_cliPath, args) => {
        cliCalls.push([...args]);
        const command = args.slice(0, 2).join(" ");
        if (command === "project schema") {
          return { status: 0, stdout: JSON.stringify(args.includes("--document") ? documentSchema : effectActionSchema), stderr: "" };
        }
        if (command === "project create") {
          await writeFile(args[args.indexOf("--project") + 1], "editable-tsrct");
          return { status: 0, stdout: "", stderr: "" };
        }
        if (command === "project import-video" || command === "project import-asset") {
          const id = args[args.indexOf("--asset-id") + 1];
          return { status: 0, stdout: JSON.stringify({ assetId: id }), stderr: "" };
        }
        if (command === "project import-font") {
          return { status: 0, stdout: JSON.stringify({ faces: [{ fontFamily: "Inter", fontStyle: "Regular" }, { fontFamily: "Inter", fontStyle: "Bold" }] }), stderr: "" };
        }
        if (command === "project checkout") {
          await writeFile(args[args.indexOf("--output") + 1], JSON.stringify(committedDocument ?? emptyDocument));
          return { status: 0, stdout: "", stderr: "" };
        }
        if (command === "project commit") {
          committedDocument = JSON.parse(await readFile(args[args.indexOf("--file") + 1], "utf8"));
          return { status: 0, stdout: "", stderr: "" };
        }
        if (command === "project apply") {
          appliedActions = JSON.parse(await readFile(args[args.indexOf("--actions") + 1], "utf8"));
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "preview" || args[0] === "filmstrip") {
          await writeFile(args[args.indexOf("--output") + 1], validTinyPng);
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "export") {
          const output = args[args.indexOf("--output") + 1];
          const alphaSolo = args.includes("--fx-solo");
          if (alphaSolo) {
            const [compositionId, layerId] = args[args.indexOf("--fx-solo") + 1].split(":");
            const composition = committedDocument?.composition;
            const selectedLayerExists = composition?.id === compositionId
              && composition.layers?.some((layer) => String(layer.id) === layerId);
            if (!selectedLayerExists) return { status: 1, stdout: "", stderr: "fx-solo target does not exist" };
          }
          const prores = args.includes("--format") && args[args.indexOf("--format") + 1] === "prores";
          await writeFile(output, alphaSolo ? "fixture alpha prores" : prores ? "fixture prores" : "fixture mp4");
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected fake CLI invocation: ${args.join(" ")}`);
      },
      probeMedia: async (path) => path.endsWith("final-prores-alpha.mov")
        ? { hasVideo: true, hasAudio: false, durationSeconds: 1.25, videoDurationSeconds: 1.25, width: 3840, height: 2160, fps: 60, videoCodec: "prores", pixelFormat: "yuva444p10le", sizeBytes: 100 }
        : path.endsWith("final-prores.mov")
          ? { hasVideo: true, hasAudio: true, durationSeconds: 2, videoDurationSeconds: 2, width: 3840, height: 2160, fps: 60, videoCodec: "prores", pixelFormat: "yuv422p10le", sizeBytes: 100 }
          : path.endsWith("/final.mp4")
            ? { hasVideo: true, hasAudio: true, durationSeconds: 2, width: 3840, height: 2160, fps: 60, sizeBytes: 100 }
        : { hasVideo: true, hasAudio: false, durationSeconds: 2, width: 1920, height: 1080, fps: 30, sizeBytes: 10 },
      decodeVideo: async () => undefined
    });

    const exportCall = cliCalls.find((args) => args[0] === "export");
    expect(exportCall).toEqual(expect.arrayContaining(["--resolution", "4k", "--fps", "60"]));
    expect(cliCalls.findIndex((args) => args[0] === "preview")).toBeLessThan(cliCalls.findIndex((args) => args[0] === "export"));
    expect(cliCalls.findIndex((args) => args[0] === "filmstrip")).toBeLessThan(cliCalls.findIndex((args) => args[0] === "export"));
    expect(cliCalls.find((args) => args[0] === "project" && args[1] === "import-video")).toEqual(expect.arrayContaining(["--asset-id", "clip-native-1"]));
    expect(cliCalls.find((args) => args[0] === "project" && args[1] === "import-asset")).toEqual(expect.arrayContaining(["--asset-id", "logo", "--kind", "image"]));
    const proresCalls = cliCalls.filter((args) => args[0] === "export" && args.includes("--format"));
    expect(proresCalls).toHaveLength(2);
    expect(proresCalls[0]).toEqual(expect.arrayContaining(["--format", "prores", "--resolution", "4k", "--fps", "60"]));
    expect(proresCalls[1]).toEqual(expect.arrayContaining(["--format", "prores", "--fx-solo", "main:3"]));
    expect(appliedActions).toEqual([effectAction]);
    expect(result).toMatchObject({ width: 3840, height: 2160, fps: 60, native_document_layer_count: 3, native_video_layer_count: 1, native_embedded_audio_layer_count: 1, native_font_imports: [{ src: "assets/fonts/Inter.ttf", faces: [{ fontFamily: "Inter", fontStyle: "Regular" }, { fontFamily: "Inter", fontStyle: "Bold" }] }] });
    expect(result.preview_path).toBe(join(runDir, "preview.png"));
    expect(result.filmstrip_path).toBe(join(runDir, "filmstrip.png"));
    expect(result.sidecars).toEqual([
      { kind: "prores_mov", path: "final-prores.mov" },
      { kind: "alpha_solo_prores_mov", path: "final-prores-alpha.mov" }
    ]);
    expect(JSON.parse(await readFile(reportPath, "utf8")).sidecars).toEqual(result.sidecars);
    expect(await readdir(runDir)).toEqual(expect.arrayContaining(["final.tsrct", "final.mp4", "final-prores.mov", "final-prores-alpha.mov", "render-report.json", "preview.png", "filmstrip.png"]));
    expect(expectedExportDimensions({ width: 1080, height: 1080 }, nativeDocument, "4k")).toEqual({ width: 2160, height: 2160 });
    expect(expectedExportDimensions({ width: 1080, height: 1350 }, nativeDocument, "720p")).toEqual({ width: 720, height: 900 });
  });

  it("rejects an existing report, escaping paths, and symlinked media before invoking the CLI", async () => {
    const runDir = await tempDirectory("tsugite-tesseract-confine-");
    const projectRoot = await tempDirectory("tsugite-tesseract-project-");
    await mkdir(join(runDir, "assets", "clips"), { recursive: true });
    const external = join(projectRoot, "external.mp4");
    await writeFile(external, "media");
    await symlink(external, join(runDir, "assets", "clips", "linked.mp4"));
    const manifestPath = join(runDir, "manifest.json");
    const outputPath = join(runDir, "final.mp4");
    const reportPath = join(runDir, "render-report.json");
    const input = { runDir, manifestPath, outputPath, reportPath, projectRoot, backendOptions: {} };
    expect(() => parsePayload({ ...input, outputPath: join(runDir, "..", "escape.mp4") })).toThrow(/outputPath must be/);
    await writeFile(manifestPath, JSON.stringify(basicManifest({
      clips: [{ id: "clip-1", src: "assets/clips/linked.mp4", in: 0, out: 1, duration: 1, fps: 30, resolution: { width: 1920, height: 1080 }, audio: false }]
    })));
    await writeFile(reportPath, "existing-report");
    const runCli = vi.fn(async () => ({ status: 0, stdout: "", stderr: "" }));
    await expect(renderTesseract(input, { resolveCli: vi.fn(), runCli })).rejects.toThrow(/render report already exists/);
    expect(runCli).not.toHaveBeenCalled();
    await rm(reportPath);
    await expect(renderTesseract(input, { resolveCli: vi.fn(), runCli })).rejects.toThrow(/must not use a symlink path/);
    expect(runCli).not.toHaveBeenCalled();
  });

  it("rejects overlapping audio layers that resolve to the same source before CLI preflight", async () => {
    const runDir = await tempDirectory("tsugite-tesseract-audio-duplicate-");
    const projectRoot = await tempDirectory("tsugite-tesseract-project-");
    await mkdir(join(runDir, "assets", "clips"), { recursive: true });
    await mkdir(join(runDir, "assets", "audio"), { recursive: true });
    await writeFile(join(runDir, "assets", "clips", "source.mp4"), "video");
    await writeFile(join(runDir, "assets", "audio", "music.wav"), "audio");
    const manifestPath = join(runDir, "manifest.json");
    const input = {
      runDir,
      manifestPath,
      outputPath: join(runDir, "final.mp4"),
      reportPath: join(runDir, "render-report.json"),
      projectRoot,
      backendOptions: {}
    };
    await writeFile(manifestPath, JSON.stringify(basicManifest({
      audio: {
        bgm: [{ src: "assets/audio/music.wav", start: 0, end: 1 }],
        narration: [{ src: "assets/audio/./music.wav", start: 0.5, end: 1.5 }],
        sfx: []
      }
    })));
    const resolveCli = vi.fn();
    await expect(renderTesseract(input, {
      resolveCli,
      probeMedia: async (path) => path.endsWith(".mp4")
        ? { hasVideo: true, hasAudio: false, durationSeconds: 2, videoDurationSeconds: 2, sizeBytes: 10 }
        : { hasVideo: false, hasAudio: true, durationSeconds: 2, audioDurationSeconds: 2, sizeBytes: 10 }
    })).rejects.toThrow(/same resolved source/);
    expect(resolveCli).not.toHaveBeenCalled();
  });

  it("rejects a hard-linked file used in both Video and Audio roles", async () => {
    const runDir = await tempDirectory("tsugite-tesseract-cross-role-");
    const projectRoot = await tempDirectory("tsugite-tesseract-project-");
    await mkdir(join(runDir, "assets", "clips"), { recursive: true });
    await mkdir(join(runDir, "assets", "audio"), { recursive: true });
    const videoPath = join(runDir, "assets", "clips", "source.mp4");
    const audioPath = join(runDir, "assets", "audio", "source.wav");
    await writeFile(videoPath, "same fixture bytes");
    await link(videoPath, audioPath);
    const manifestPath = join(runDir, "manifest.json");
    const input = {
      runDir,
      manifestPath,
      outputPath: join(runDir, "final.mp4"),
      reportPath: join(runDir, "render-report.json"),
      projectRoot,
      backendOptions: {}
    };
    await writeFile(manifestPath, JSON.stringify(basicManifest({
      audio: { bgm: [{ src: "assets/audio/source.wav", start: 0, end: 1 }], narration: [], sfx: [] }
    })));
    const resolveCli = vi.fn();
    await expect(renderTesseract(input, {
      resolveCli,
      probeMedia: async (path) => path.endsWith(".mp4")
        ? { hasVideo: true, hasAudio: false, durationSeconds: 2, videoDurationSeconds: 2, sizeBytes: 10 }
        : { hasVideo: false, hasAudio: true, durationSeconds: 2, audioDurationSeconds: 2, sizeBytes: 10 }
    })).rejects.toThrow(/same file as both video and audio/);
    expect(resolveCli).not.toHaveBeenCalled();
  });

  it("cleans only staged partial outputs after an export failure", async () => {
    const runDir = await tempDirectory("tsugite-tesseract-partial-");
    const projectRoot = await tempDirectory("tsugite-tesseract-project-");
    await mkdir(join(runDir, "assets", "clips"), { recursive: true });
    await writeFile(join(runDir, "assets", "clips", "source.mp4"), "video");
    const manifestPath = join(runDir, "manifest.json");
    const outputPath = join(runDir, "final.mp4");
    const reportPath = join(runDir, "render-report.json");
    const projectPath = join(runDir, "final.tsrct");
    await writeFile(manifestPath, JSON.stringify(basicManifest()));
    const documentSchema = {
      type: "object",
      properties: { duration: { type: "number" }, composition: { $ref: "#/$defs/Composition" } },
      $defs: { Composition: { type: "object", properties: {
        id: { type: "string" }, width: { type: "number" }, height: { type: "number" }, layers: { type: "array", items: { type: "object" } }
      } } }
    };
    const emptyDocument = { duration: 1, composition: { id: "main", width: 1920, height: 1080, layers: [] } };
    await expect(renderTesseract({ runDir, manifestPath, outputPath, reportPath, projectRoot, backendOptions: {} }, {
      platform: "darwin",
      resolveCli: async () => ({ ok: true, cliPath: "/fake/tsrct", version: "0.2.0" }),
      runCli: async (_cliPath, args) => {
        const command = args.slice(0, 2).join(" ");
        if (command === "project schema") return { status: 0, stdout: JSON.stringify(documentSchema), stderr: "" };
        if (command === "project create") {
          await writeFile(args[args.indexOf("--project") + 1], "partial editable project");
          return { status: 0, stdout: "", stderr: "" };
        }
        if (command === "project import-video") {
          const assetIdIndex = args.indexOf("--asset-id");
          if (assetIdIndex < 0 || !args[assetIdIndex + 1]) throw new Error("project import-video requires --asset-id");
          return { status: 0, stdout: JSON.stringify({ assetId: args[assetIdIndex + 1], durationMs: 1000 }), stderr: "" };
        }
        if (command === "project checkout") {
          await writeFile(args[args.indexOf("--output") + 1], JSON.stringify(emptyDocument));
          return { status: 0, stdout: "", stderr: "" };
        }
        if (command === "project commit") return { status: 0, stdout: "", stderr: "" };
        if (command === "export --project") {
          await writeFile(args[args.indexOf("--output") + 1], "partial mp4");
          return { status: 1, stdout: "", stderr: "fixture export failure" };
        }
        throw new Error(`unexpected fake CLI invocation: ${args.join(" ")}`);
      },
      probeMedia: async () => ({ hasVideo: true, hasAudio: false, durationSeconds: 2, videoDurationSeconds: 2, fps: 30, width: 1920, height: 1080, sizeBytes: 10 }),
      decodeVideo: async () => undefined
    })).rejects.toThrow(/fixture export failure/);
    const entries = await readdir(runDir);
    expect(entries).not.toContain("final.tsrct");
    expect(entries).not.toContain("final.mp4");
    expect(entries).not.toContain("render-report.json");
    expect(entries.some((entry) => entry.startsWith(".tesseract-work-"))).toBe(false);
  });
});

function basicManifest(overrides = {}) {
  return {
    meta: { aspect: "16:9", fps: 30, target_duration_seconds: 2, slug: "tesseract-fixture" },
    clips: [{ id: "clip-1", src: "assets/clips/source.mp4", in: 0, out: 2, duration: 2, fps: 30, resolution: { width: 1920, height: 1080 }, audio: false }],
    images: [], speakers: [], audio: { bgm: [], narration: [], sfx: [] },
    captions: [], chapters: [], provenance: [], ...overrides
  };
}

async function tempDirectory(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}
