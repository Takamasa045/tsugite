import { describe, expect, it, vi } from "vitest";
import { loadBackendCapabilities, validateBackendCapabilities } from "../src/backends/capabilities.js";
import { manifestSchema } from "../src/manifest/schema.js";
import { buildTesseractAudioReactiveActions, buildTesseractAudioReactiveKeyframeActions } from "../backends/tesseract/audioEnvelope.mjs";
import { assertSupportedManifest, buildTesseractDocumentLayers } from "../backends/tesseract/manifest.mjs";

function pcmWithTone(durationMs = 2_000, toneStartMs = 500, toneEndMs = 1_000) {
  const sampleRate = 48_000;
  const sampleCount = sampleRate * durationMs / 1_000;
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let index = Math.floor(sampleRate * toneStartMs / 1_000); index < Math.floor(sampleRate * toneEndMs / 1_000); index += 1) {
    pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRate) * 16_384), index * 2);
  }
  return pcm;
}

function audioReactiveManifest() {
  return {
    meta: { aspect: "16:9", fps: 30, target_duration_seconds: 2, slug: "audio-reactive" },
    clips: [{
      id: "clip-1",
      src: "media/clip.mp4",
      in: 0,
      out: 2,
      duration: 2,
      fps: 30,
      resolution: { width: 1920, height: 1080 },
      audio: false,
      motion: {
        audio_reactive: {
          source_track_id: "music-main",
          mode: "pulse",
          strength: 0.7,
          measurement_window_ms: 100
        }
      }
    }],
    audio: { bgm: [{ id: "music-main", src: "media/music.wav", start: 0, end: 2 }], narration: [], sfx: [] },
    captions: []
  };
}

describe("audio-reactive motion intent", () => {
  it("accepts a typed cue that references one active local audio track", () => {
    const parsed = manifestSchema.safeParse(audioReactiveManifest());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.clips[0]?.motion?.audio_reactive).toEqual({
      source_track_id: "music-main",
      mode: "pulse",
      strength: 0.7,
      measurement_window_ms: 100
    });
  });

  it("accepts only the three bounded, typed audio response modes", () => {
    for (const mode of ["pulse", "shake", "flicker"] as const) {
      const manifest = audioReactiveManifest();
      manifest.clips[0]!.motion!.audio_reactive!.mode = mode;
      expect(manifestSchema.safeParse(manifest).success).toBe(true);
    }
  });

  it("accepts a caption visual cue and rejects missing, duplicated, or out-of-range source tracks", () => {
    const captionCue = audioReactiveManifest();
    captionCue.clips[0]!.motion = undefined;
    captionCue.captions = [{
        id: "caption-1",
        text: "Beat",
        start: 0.5,
        end: 1.5,
        visual: {
          headline: "Beat",
          motion: {
            audio_reactive: {
              source_track_id: "music-main",
              mode: "pulse",
              strength: 0.4,
              measurement_window_ms: 200
            }
          }
        }
      }];
    expect(manifestSchema.safeParse(captionCue).success).toBe(true);

    const missing = audioReactiveManifest();
    missing.audio.bgm = [];
    expect(manifestSchema.safeParse(missing).success).toBe(false);

    const duplicated = audioReactiveManifest();
    duplicated.audio.narration.push({ id: "music-main", src: "media/voice.wav", start: 0, end: 2 });
    expect(manifestSchema.safeParse(duplicated).success).toBe(false);

    const shortTrack = audioReactiveManifest();
    shortTrack.audio.bgm[0]!.end = 1;
    expect(manifestSchema.safeParse(shortTrack).success).toBe(false);
  });

  it("rejects arbitrary expressions and values outside the bounded cue contract", () => {
    for (const changes of [
      { strength: 1.01 },
      { strength: -0.01 },
      { measurement_window_ms: 19 },
      { mode: "strobe" },
      { expression: "process.exit(1)" }
    ]) {
      const manifest = audioReactiveManifest();
      const cue = manifest.clips[0]!.motion.audio_reactive;
      Object.assign(cue, changes);
      expect(manifestSchema.safeParse(manifest).success).toBe(false);
    }
  });

  it("fails capability validation when the selected backend does not implement the cue", async () => {
    const manifest = manifestSchema.parse(audioReactiveManifest());
    const backend = await loadBackendCapabilities("remotion");
    expect(backend).toBeDefined();
    if (!backend) return;
    backend.capabilities.audio_reactive = false;
    const result = validateBackendCapabilities(manifest, backend);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("backend.capability.audio_reactive");
  });

  it("treats a typed clip transition cue as a backend capability requirement", async () => {
    const manifest = audioReactiveManifest();
    manifest.clips[0]!.motion = { transition_to_next: { preset: "slide-left", description: "Slide the next clip in", duration_seconds: 0.4 } };
    const parsed = manifestSchema.parse(manifest);
    const backend = await loadBackendCapabilities("tesseract");
    expect(backend).toBeDefined();
    if (!backend) return;
    backend.capabilities.transitions = false;
    const result = validateBackendCapabilities(parsed, backend);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("backend.capability.transitions");
  });

  it("accepts motion capabilities implemented by the Tesseract backend", async () => {
    const manifest = audioReactiveManifest();
    Object.assign(manifest.clips[0]!, { out: 1, duration: 1 });
    manifest.clips.push({
      ...manifest.clips[0]!, id: "clip-2", src: "media/clip-2.mp4", in: 0, out: 1, duration: 1, motion: undefined
    } as typeof manifest.clips[number]);
    Object.assign(manifest.clips[0]!.motion!, {
      transition_to_next: { preset: "zoom-in", description: "Zoom the next clip in", duration_seconds: 0.4 }
    });
    const parsed = manifestSchema.parse(manifest);
    expect(() => assertSupportedManifest(parsed)).not.toThrow();
    const backend = await loadBackendCapabilities("tesseract");
    expect(backend?.capabilities.transitions).toBe(true);
    expect(backend?.capabilities.audio_reactive).toBe(true);
    expect(backend?.capabilities.captions).toBe(true);
    if (!backend) return;
    expect(validateBackendCapabilities(parsed, backend).ok).toBe(true);
    const topLevelTransitions = validateBackendCapabilities({ ...parsed, transitions: [] }, backend);
    expect(topLevelTransitions.ok).toBe(false);
    expect(topLevelTransitions.issues.map((issue) => issue.code)).toContain("backend.capability.transitions");
  });

  it("keeps unknown passthrough audio groups from throwing during cue validation", () => {
    const manifest = audioReactiveManifest();
    (manifest.audio as Record<string, unknown>).experimental = "not-an-array";
    expect(() => manifestSchema.safeParse(manifest)).not.toThrow();
    const parsed = manifestSchema.parse(manifest);
    expect(() => assertSupportedManifest(parsed)).toThrow("audio.experimental is not supported");
  });

  it("requires a caption visual headline to exactly match the rendered caption text", () => {
    const manifest = audioReactiveManifest();
    manifest.clips[0]!.motion = undefined;
    manifest.captions = [{
      id: "caption-1",
      text: "Beat",
      start: 0.5,
      end: 1.5,
      visual: {
        headline: "Different text",
        motion: { audio_reactive: { source_track_id: "music-main", mode: "pulse", strength: 0.4, measurement_window_ms: 200 } }
      }
    }];
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    expect(() => assertSupportedManifest(manifestSchema.parse(manifest))).toThrow("headline must exactly match");
  });
});

describe("Tesseract offline audio envelope actions", () => {
  const common = {
    compositionId: "main",
    layerId: 9,
    pcm: pcmWithTone(),
    durationMs: 2_000,
    measurementWindowMs: 100,
    strength: 1
  };

  it("builds bounded editable scale keyframes and returns to neutral at the target end", () => {
    const actions = buildTesseractAudioReactiveKeyframeActions({ ...common, mode: "pulse" });
    expect(actions).toHaveLength(2);
    for (const action of actions) {
      expect(action.type).toBe("setFxPropertyKeyframes");
      expect(action.keyframes).toHaveLength(21);
      expect(action.keyframes.at(-1)).toMatchObject({ layerTime: 1_999, value: { type: "float", value: 100 } });
      expect(Math.max(...action.keyframes.map((keyframe) => keyframe.value.value))).toBeLessThanOrEqual(160);
    }
  });

  it("rejects a duration whose only second measurement window is an invisible 1 ms tail", () => {
    const durationMs = 1_001;
    const pcm = pcmWithTone(durationMs, 1_000, durationMs);
    expect(() => buildTesseractAudioReactiveKeyframeActions({
      ...common,
      pcm,
      durationMs,
      measurementWindowMs: 1_000
    })).toThrow("at least two measurement windows");
  });

  it("builds paired position keyframes for bounded shake and returns to the imported text position", () => {
    const actions = buildTesseractAudioReactiveKeyframeActions({ ...common, mode: "shake", baselinePosition: [1536, 864] });
    expect(actions).toHaveLength(1);
    const action = actions[0];
    expect(action.type).toBe("setFxPositionKeyframes");
    expect(action.positionX.keyframes).toHaveLength(21);
    expect(action.positionY.keyframes).toHaveLength(21);
    for (const property of [action.positionX, action.positionY]) {
      const values = property.keyframes.map((keyframe) => keyframe.value.value);
      const baseline = property === action.positionX ? 1_536 : 864;
      expect(Math.max(...values)).toBeLessThanOrEqual(baseline + 24);
      expect(Math.min(...values)).toBeGreaterThanOrEqual(baseline - 24);
      expect(property.keyframes.at(-1).value.value).toBe(baseline);
    }
  });

  it("flickers down from fully visible and recovers to 100 percent opacity after the source returns to silence", () => {
    const actions = buildTesseractAudioReactiveKeyframeActions({ ...common, mode: "flicker" });
    expect(actions).toHaveLength(1);
    const action = actions[0];
    expect(action.property.propertyType).toBe("opacity");
    const values = action.keyframes.map((keyframe) => keyframe.value.value);
    expect(values[0]).toBe(100);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(20);
    expect(Math.min(...values)).toBeLessThan(100);
    expect(action.keyframes.at(-1)).toMatchObject({ layerTime: 1_999, value: { type: "float", value: 100 } });
  });

  it("keeps all modes at their neutral value for silence and refuses envelopes over the keyframe cap", () => {
    const silence = Buffer.alloc(48_000 * 2 * 2);
    for (const mode of ["pulse", "shake", "flicker"] as const) {
      const actions = buildTesseractAudioReactiveKeyframeActions({ ...common, pcm: silence, mode, baselinePosition: [154, 864] });
      const values = actions.flatMap((action) => action.type === "setFxPositionKeyframes"
        ? [...action.positionX.keyframes, ...action.positionY.keyframes].map((keyframe) => keyframe.value.value)
        : action.keyframes.map((keyframe) => keyframe.value.value));
      const neutralValues = mode === "pulse" ? [100] : mode === "shake" ? [154, 864] : [100];
      expect(new Set(values)).toEqual(new Set(neutralValues));
    }
    expect(() => buildTesseractAudioReactiveKeyframeActions({
      ...common,
      durationMs: 24_000,
      measurementWindowMs: 100,
      pcm: Buffer.alloc(48_000 * 2 * 24)
    })).toThrow("keyframe limit");
  });

  it("maps a caption cue to its imported text layer and samples the corresponding source-timeline window", async () => {
    const manifest = audioReactiveManifest();
    manifest.clips[0]!.motion = undefined;
    manifest.captions = [{
      id: "caption-1", text: "日本語字幕", start: 0.5, end: 1.5,
      visual: { headline: "日本語字幕", motion: { audio_reactive: { source_track_id: "music-main", mode: "pulse", strength: 0.5, measurement_window_ms: 100 } } }
    }];
    const sourceInfo = new Map([["media/music.wav", { hasAudio: true, durationSeconds: 2, audioDurationSeconds: 2 }]]);
    const canonicalBySource = new Map([["media/music.wav", "/run/media/music.wav"]]);
    const readPcm = vi.fn((_path: string, request: { durationMs: number }) => pcmWithTone(request.durationMs, 200, 600));
    const actions = await buildTesseractAudioReactiveActions(manifest, {
      compositionId: "main", clipLayers: [],
      captionLayers: [{ captionId: "caption-1", layerId: 7, timelineStartMs: 500, durationMs: 1_000, baselinePosition: [154, 864] }],
      sourceInfo, canonicalBySource, readPcm
    });
    expect(readPcm).toHaveBeenCalledWith("/run/media/music.wav", { sourceStartMs: 500, durationMs: 1_000 });
    expect(actions).toHaveLength(2);
    expect(actions.every((action) => action.property.layerId === 7)).toBe(true);
  });

  it("propagates the centered video transform baseline into clip shake keyframes", async () => {
    const manifest = audioReactiveManifest();
    manifest.clips[0]!.motion!.audio_reactive!.mode = "shake";
    const sourceInfo = new Map([
      ["media/clip.mp4", { hasVideo: true, hasAudio: false, durationSeconds: 2, width: 1920, height: 1080 }],
      ["media/music.wav", { hasVideo: false, hasAudio: true, durationSeconds: 2, audioDurationSeconds: 2 }]
    ]);
    const layers = buildTesseractDocumentLayers(manifest, {
      assetIds: new Map([["media/clip.mp4", "video-asset"], ["media/music.wav", "audio-asset"]]), sourceInfo, durationSeconds: 2
    });
    const actions = await buildTesseractAudioReactiveActions(manifest, {
      compositionId: "main",
      clipLayers: layers.clipLayers,
      sourceInfo,
      canonicalBySource: new Map([["media/music.wav", "/run/media/music.wav"]]),
      readPcm: vi.fn((_path: string, request: { durationMs: number }) => pcmWithTone(request.durationMs))
    });
    const action = actions[0];

    expect(layers.layers[0]?.transform).toMatchObject({ anchorPoint: [960, 540], position: [960, 540] });
    expect(action?.type).toBe("setFxPositionKeyframes");
    if (action?.type !== "setFxPositionKeyframes") return;
    expect(action.positionX.keyframes[0]?.value.value).toBe(960);
    expect(action.positionY.keyframes[0]?.value.value).toBe(540);
    expect(action.positionX.keyframes.at(-1)?.value.value).toBe(960);
    expect(action.positionY.keyframes.at(-1)?.value.value).toBe(540);
  });
});
