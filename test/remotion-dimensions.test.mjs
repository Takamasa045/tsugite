import { describe, expect, it } from "vitest";
import { resolveRenderDimensions } from "../backends/remotion/dimensions.mjs";

function manifest(aspect, resolution) {
  return {
    meta: { aspect },
    clips: resolution ? [{ resolution }] : []
  };
}

describe("resolveRenderDimensions", () => {
  it("preserves an exact native 16:9 resolution", () => {
    expect(resolveRenderDimensions(manifest("16:9", { width: 1280, height: 720 }))).toEqual({
      width: 1280,
      height: 720
    });
  });

  it("corrects a near-16:9 provider height while preserving width", () => {
    expect(resolveRenderDimensions(manifest("16:9", { width: 1920, height: 1072 }))).toEqual({
      width: 1920,
      height: 1080
    });
  });

  it("corrects a near-9:16 provider width while preserving height", () => {
    expect(resolveRenderDimensions(manifest("9:16", { width: 1072, height: 1920 }))).toEqual({
      width: 1080,
      height: 1920
    });
  });

  it("uses canonical dimensions when no clip resolution exists", () => {
    expect(resolveRenderDimensions(manifest("16:9"))).toEqual({ width: 1920, height: 1080 });
    expect(resolveRenderDimensions(manifest("9:16"))).toEqual({ width: 1080, height: 1920 });
  });
});
