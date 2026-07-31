import { describe, expect, it } from "vitest";
import { createClipVolume } from "../backends/remotion/clipAudio.mjs";

describe("Remotion clip audio treatment", () => {
  it("keeps untreated clip audio at the Remotion default", () => {
    expect(createClipVolume({ audio: true }, 240, 24)).toBeUndefined();
  });

  it("applies bounded fade handles around a normalized base volume", () => {
    const volume = createClipVolume(
      {
        audio: true,
        audio_mix: {
          volume: 0.62,
          fade_in_seconds: 0.125,
          fade_out_seconds: 0.125
        }
      },
      240,
      24
    );

    expect(volume).toBeTypeOf("function");
    expect(volume(0)).toBe(0);
    expect(volume(3)).toBeCloseTo(0.62);
    expect(volume(120)).toBeCloseTo(0.62);
    expect(volume(239)).toBe(0);
  });
});
