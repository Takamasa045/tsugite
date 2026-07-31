import { describe, expect, it } from "vitest";
// @ts-expect-error backend modules are plain ESM without type declarations
import {
  captionContainerLayout,
  captionTextLayout,
  mediaLayout,
  resolveCaptionLayout
} from "../backends/remotion/captionLayout.mjs";

describe("remotion caption layout", () => {
  it("preserves the historical overlay layout by default", () => {
    expect(resolveCaptionLayout({ meta: {} })).toBe("overlay");
    expect(resolveCaptionLayout({})).toBe("overlay");
    expect(mediaLayout("overlay")).toEqual({
      width: "100%",
      height: "100%",
      objectFit: "cover"
    });
    expect(captionContainerLayout("overlay")).toMatchObject({
      padding: "6%"
    });
  });

  it("reserves a bottom band without cropping the source video", () => {
    expect(resolveCaptionLayout({ meta: { caption_layout: "bottom-band" } })).toBe("bottom-band");
    expect(mediaLayout("bottom-band")).toEqual({
      width: "100%",
      height: "88%",
      objectFit: "contain",
      objectPosition: "center top"
    });
    expect(captionContainerLayout("bottom-band")).toMatchObject({
      padding: "0 5% 20px"
    });
    expect(captionTextLayout("bottom-band")).toMatchObject({
      maxWidth: "90%",
      fontSize: 40,
      lineHeight: 1.25,
      backgroundColor: "transparent",
      whiteSpace: "pre-line"
    });
  });

  it("does not opt into an unknown caption layout", () => {
    expect(resolveCaptionLayout({ meta: { caption_layout: "side-panel" } })).toBe("overlay");
  });
});
