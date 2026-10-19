import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { captionMotionState } from "./captionMotion.mjs";
import { YOMOGI_FONT_FACE } from "./hutBrushFont.js";

export const HUT_BRUSH_STYLE = "hut-brush";

const PAPER = "#f7f1e4";
const EDGE = "#24180f";
const STROKE = [
  "-1.5px -1.5px 0 " + EDGE,
  "1.5px -1.5px 0 " + EDGE,
  "-1.5px 1.5px 0 " + EDGE,
  "1.5px 1.5px 0 " + EDGE,
  "0 2px 0 " + EDGE,
  "0 0 6px rgba(20,12,6,0.55)"
].join(", ");
const FONT = 'Yomogi, "Hiragino Maru Gothic ProN", "Yu Gothic", sans-serif';

function tiltOf(id) {
  let n = 0;
  for (const ch of String(id)) n = (n + ch.charCodeAt(0)) % 7;
  return (n - 3) * 0.28;
}

function englishLine(text, width, size) {
  if (!text) return null;
  return React.createElement(
    "div",
    { style: { marginTop: 6, fontSize: Math.round(width * size), lineHeight: 1.25 } },
    String(text).split("\n").map((line, index) => React.createElement("div", { key: "en-" + index }, line))
  );
}

export function HutBrushCaptions({ captions, fps }) {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const second = frame / fps;
  const active = (captions ?? []).find((caption) => second >= caption.start && second < caption.end);
  const fontStyle = React.createElement("style", null, YOMOGI_FONT_FACE);
  if (!active) return fontStyle;

  const state = captionMotionState(active, second, fps);
  const fade = interpolate(state.enter, [0, 1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const visible = Math.min(1, fade) * (1 - state.exit);
  const lines = String(active.text ?? "").split("\n");
  const isTitle = String(active.id ?? "").startsWith("t-");

  if (isTitle) {
    const draw = interpolate(state.localFrame, [2, 18], [0, 1], {
      easing: Easing.out(Easing.cubic),
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp"
    });
    return React.createElement(
      AbsoluteFill,
      { style: { pointerEvents: "none" } },
      fontStyle,
      React.createElement(
        "div",
        {
          style: {
            position: "absolute",
            left: "8%",
            right: "8%",
            bottom: "13%",
            textAlign: "center",
            color: PAPER,
            WebkitTextStroke: `1px ${EDGE}`,
            fontFamily: FONT,
            fontSize: Math.round(width * 0.058),
            lineHeight: 1.2,
            opacity: visible,
            textShadow: STROKE
          }
        },
        lines.map((line, index) => React.createElement("div", { key: index }, line)),
        englishLine(active.en, width, 0.026),
        React.createElement("div", {
          style: {
            margin: "8px auto 0",
            width: "22%",
            height: 2,
            background: PAPER,
            opacity: 0.75,
            transform: `scaleX(${draw})`,
            transformOrigin: "center center"
          }
        })
      )
    );
  }

  const rise = interpolate(state.localFrame, [0, 14], [12, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  return React.createElement(
    AbsoluteFill,
    { style: { pointerEvents: "none" } },
    fontStyle,
    React.createElement(
      "div",
      {
        style: {
          position: "absolute",
          left: "7%",
          right: "18%",
          bottom: "11%",
          color: PAPER,
            WebkitTextStroke: `1px ${EDGE}`,
          fontFamily: FONT,
          opacity: visible,
          transform: `translateY(${rise}px) rotate(${tiltOf(active.id)}deg)`,
          transformOrigin: "left bottom",
          textShadow: STROKE,
          WebkitTextStroke: `1px ${EDGE}`
        }
      },
      active.speaker
        ? React.createElement(
            "div",
            {
              style: {
                fontSize: Math.round(width * 0.02),
                letterSpacing: "0.14em",
                opacity: 0.92,
                marginBottom: 2
              }
            },
            active.speaker
          )
        : null,
      React.createElement(
        "div",
        { style: { fontSize: Math.round(width * 0.038), lineHeight: 1.35 } },
        lines.map((line, index) => React.createElement("div", { key: index }, line)),
        englishLine(active.en, width, 0.022)
      )
    )
  );
}
