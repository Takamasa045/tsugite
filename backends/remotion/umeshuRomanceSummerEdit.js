import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export const UMESHU_ROMANCE_SUMMER_EDIT_PRESET = "umeshu-romance-summer-edit-16x9";

/** Caption layout fixed to constraints.md safe area (1280x720: x=80..1200 / y=100..620). */
export const UMESHU_CAPTION_LAYOUT = {
  left: "6%",
  right: "6%",
  bottom: 100,
  height: 64,
  padding: "6px 18px",
  zIndex: 10
};

/** Reggae lyric palette: warm yellow fill, deep green outline, red-orange short shadow. */
export const UMESHU_LYRIC_STYLE = {
  color: "#F6C844",
  fontFamily: '"Hiragino Maru Gothic ProN", "Arial Rounded MT Bold", sans-serif',
  outline: "#173F2B",
  shortShadow: "#D8573C",
  // Outline layer only: green stroke (~3px) + red-orange/black shadows under yellow face.
  webkitTextStroke: "3px #173F2B",
  outlineTextShadow:
    "2px 2px 0 #D8573C, 0 2px 6px rgba(0,0,0,.88), 0 0 2px rgba(0,0,0,.75)"
};

/**
 * Lyrics-only overlay for the Reggae summer edit.
 * Renders only active R01-R26 captions. title-card, chapters, letterbox, wash,
 * vignette, grain, transition flash, and preset fades are intentionally omitted.
 */
export function UmeshuRomanceSummerEdit({ manifest }) {
  const fps = manifest?.meta?.fps ?? 24;
  const second = useCurrentFrame() / fps;
  const captions = manifest?.captions ?? [];
  const activeCaption = captions.find(
    (caption) => caption.id !== "title-card" && second >= caption.start && second < caption.end
  );

  if (!activeCaption) {
    return null;
  }

  const fontSize = lyricFontSize(activeCaption.text);
  const letterSpacing = activeCaption.text.length > 14 ? 1 : 2;
  const sharedTextStyle = {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    padding: UMESHU_CAPTION_LAYOUT.padding,
    fontFamily: UMESHU_LYRIC_STYLE.fontFamily,
    fontSize,
    fontWeight: 700,
    letterSpacing,
    lineHeight: 1.15,
    textAlign: "center",
    whiteSpace: "nowrap",
    overflow: "hidden"
  };

  return React.createElement(
    AbsoluteFill,
    { style: { pointerEvents: "none", overflow: "hidden" } },
    // Container: bottom:100 / height:64. overflow:hidden clips stroke/shadow so y<=620.
    // Opacity stays 1 for the whole half-open active window; no lyric fade/motion.
    // Layer 1 (zIndex 1): transparent fill + green stroke + red-orange/black shadows.
    // Layer 2 (zIndex 2): explicit yellow fill, no stroke — yellow face is the primary surface.
    React.createElement("div", {
      style: {
        position: "absolute",
        left: UMESHU_CAPTION_LAYOUT.left,
        right: UMESHU_CAPTION_LAYOUT.right,
        bottom: UMESHU_CAPTION_LAYOUT.bottom,
        height: UMESHU_CAPTION_LAYOUT.height,
        zIndex: UMESHU_CAPTION_LAYOUT.zIndex,
        opacity: 1,
        overflow: "hidden"
      }
    },
    React.createElement("div", {
      style: {
        ...sharedTextStyle,
        zIndex: 1,
        color: "transparent",
        WebkitTextFillColor: "transparent",
        WebkitTextStroke: UMESHU_LYRIC_STYLE.webkitTextStroke,
        textShadow: UMESHU_LYRIC_STYLE.outlineTextShadow
      },
      "aria-hidden": true
    }, activeCaption.text),
    React.createElement("div", {
      style: {
        ...sharedTextStyle,
        zIndex: 2,
        color: UMESHU_LYRIC_STYLE.color,
        WebkitTextFillColor: UMESHU_LYRIC_STYLE.color,
        WebkitTextStroke: "0px transparent",
        textShadow: "none"
      }
    }, activeCaption.text))
  );
}

function lyricFontSize(text) {
  const length = String(text ?? "").length;
  if (length > 16) return 36;
  if (length > 13) return 38;
  if (length > 10) return 40;
  return 44;
}
