const CAPTION_LAYOUT_BOTTOM_BAND = "bottom-band";

export function resolveCaptionLayout(manifest) {
  return manifest?.meta?.caption_layout === CAPTION_LAYOUT_BOTTOM_BAND
    ? CAPTION_LAYOUT_BOTTOM_BAND
    : "overlay";
}

export function mediaLayout(layout) {
  if (layout === CAPTION_LAYOUT_BOTTOM_BAND) {
    return {
      width: "100%",
      height: "88%",
      objectFit: "contain",
      objectPosition: "center top"
    };
  }
  return {
    width: "100%",
    height: "100%",
    objectFit: "cover"
  };
}

export function captionContainerLayout(layout) {
  return {
    padding: layout === CAPTION_LAYOUT_BOTTOM_BAND ? "0 5% 20px" : "6%"
  };
}

export function captionTextLayout(layout) {
  if (layout === CAPTION_LAYOUT_BOTTOM_BAND) {
    return {
      maxWidth: "90%",
      backgroundColor: "transparent",
      color: "white",
      fontFamily: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif',
      fontSize: 40,
      lineHeight: 1.25,
      padding: "0",
      textAlign: "center",
      textShadow: "0 2px 4px rgba(0, 0, 0, 0.95)",
      whiteSpace: "pre-line"
    };
  }
  return {
    maxWidth: "84%",
    backgroundColor: "rgba(0, 0, 0, 0.68)",
    color: "white",
    fontFamily: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif',
    fontSize: 34,
    lineHeight: 1.25,
    padding: "14px 20px",
    textAlign: "center",
    whiteSpace: "pre-line"
  };
}
