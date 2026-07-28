import { describe, expect, it } from "vitest";

// @ts-expect-error backend modules are plain ESM without type declarations
import { resolveRemotionPreset } from "../backends/remotion/presetRegistry.mjs";
// @ts-expect-error backend modules are plain ESM without type declarations
import {
  resolveAudioVisualizationFrame,
  resolveFinalFadeOpacity,
  resolveReggaeGlyphStyle,
  resolveReggaeLyricStyle,
  resolveLyricScrim,
  resolveVisualizerDuration
} from "../backends/remotion/natureVibeVisualizer.js";

describe("Nature Vibe Coding visualizer preset", () => {
  it("is available as the dedicated vertical music-visualizer preset", () => {
    const preset = resolveRemotionPreset("nature-vibe-visualizer-9x16");

    expect(preset?.id).toBe("nature-vibe-visualizer-9x16");
    expect(typeof preset?.handler).toBe("function");
  });

  it("keeps the spectrum silent until a delayed BGM starts and offsets its analysis frame", () => {
    expect(resolveAudioVisualizationFrame({ frame: 23, fps: 24, start: 1, end: 3 })).toBeUndefined();
    expect(resolveAudioVisualizationFrame({ frame: 24, fps: 24, start: 1, end: 3 })).toBe(0);
    expect(resolveAudioVisualizationFrame({ frame: 36, fps: 24, start: 1, end: 3 })).toBe(12);
    expect(resolveAudioVisualizationFrame({ frame: 72, fps: 24, start: 1, end: 3 })).toBeUndefined();
  });

  it("uses the audio sequence duration rounding for fractional start and end times", () => {
    expect(resolveAudioVisualizationFrame({ frame: 2, fps: 24, start: 0.1, end: 0.2 })).toBe(0);
    expect(resolveAudioVisualizationFrame({ frame: 3, fps: 24, start: 0.1, end: 0.2 })).toBe(1);
    expect(resolveAudioVisualizationFrame({ frame: 4, fps: 24, start: 0.1, end: 0.2 })).toBeUndefined();
  });

  it("fades every overlay layer during the final three seconds", () => {
    expect(resolveFinalFadeOpacity({ second: 101.9, duration: 105, fadeSeconds: 3 })).toBe(1);
    expect(resolveFinalFadeOpacity({ second: 103.5, duration: 105, fadeSeconds: 3 })).toBeCloseTo(0.5);
    expect(resolveFinalFadeOpacity({ second: 105, duration: 105, fadeSeconds: 3 })).toBe(0);
  });

  it("uses the shared composition duration when clips extend beyond the target", () => {
    expect(resolveVisualizerDuration({ meta: { target_duration_seconds: 105 }, clips: [{ duration: 108 }] })).toBe(108);
  });

  it("uses a borderless feathered scrim to quiet background lettering behind lyrics", () => {
    expect(resolveLyricScrim()).toEqual({
      top: 760,
      bottom: 300,
      background: "linear-gradient(180deg, rgba(5,9,16,0) 0%, rgba(5,9,16,0.18) 16%, rgba(5,9,16,0.78) 42%, rgba(5,9,16,0.88) 70%, rgba(5,9,16,0) 100%)"
    });
  });

  it("uses the bundled Japanese Reggae One face for hand-painted dancehall lettering", () => {
    expect(resolveReggaeLyricStyle({ text: "この場所まるごと\n最高のグラウンド" })).toMatchObject({
      fontFamily: '"NatureVibeReggae", "Hiragino Maru Gothic ProN", "Yu Gothic", sans-serif',
      fontWeight: 400,
      color: "#fff1c8",
      letterSpacing: "0.01em"
    });
  });

  it("gives each glyph an offbeat bounce and hand-printed outline", () => {
    expect(resolveReggaeGlyphStyle({ index: 0, lineIndex: 0 })).toMatchObject({
      display: "inline-block",
      transform: "translateY(-4px) rotate(-2.4deg)",
      WebkitTextStroke: "2.4px #efb134",
      paintOrder: "stroke fill"
    });
  });
});
