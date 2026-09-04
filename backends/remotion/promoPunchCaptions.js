import React from "react";
import { AbsoluteFill, Easing, Interactive, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { captionMotionState, lyricChunks } from "./captionMotion.mjs";

export const PROMO_PUNCH_STYLE = "promo-punch";

const VERMILION = "#C44A2A";
const PAPER = "#F5F1E4";
const INK = "#1A1814";

export function PromoPunchCaptions({ captions, fps }) {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const second = frame / fps;
  const active = (captions ?? []).find((caption) => second >= caption.start && second < caption.end);
  if (!active) return null;

  const state = captionMotionState(active, second, fps);
  const enter = spring({
    frame: state.localFrame,
    fps,
    config: { damping: 12, mass: 0.55, stiffness: 220 }
  });
  const exit = interpolate(state.exit, [0, 1], [0, 1], {
    easing: Easing.in(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const visible = Math.min(1, enter) * (1 - exit);
  const punch = interpolate(state.localFrame, [0, 3, 10], [1.35, 0.92, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const flash = interpolate(state.localFrame, [0, 4, 14], [0.9, 0.35, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const bar = interpolate(state.localFrame, [2, 12], [0, 1], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const chunks = lyricChunks(active.text);
  const long = active.text.length > 14;
  const fontSize = long ? Math.round(width * 0.038) : Math.round(width * 0.052);

  return React.createElement(
    AbsoluteFill,
    { style: { pointerEvents: "none", overflow: "hidden" } },
    React.createElement("div", {
      style: {
        position: "absolute",
        inset: 0,
        opacity: flash * 0.45,
        background: `radial-gradient(circle at 50% 72%, ${VERMILION}, transparent 58%)`
      }
    }),
    React.createElement(
      Interactive.Div,
      {
        name: "Caption",
        style: {
          position: "absolute",
          left: "7%",
          right: "7%",
          bottom: "11%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 14,
          opacity: visible,
          transform: `translateY(${(1 - enter) * 56 + exit * 24}px) scale(${punch})`,
          transformOrigin: "center bottom"
        }
      },
      React.createElement("div", {
        style: {
          width: `${18 + bar * 62}%`,
          height: 6,
          borderRadius: 99,
          background: VERMILION,
          boxShadow: `0 0 18px ${VERMILION}`
        }
      }),
      React.createElement(
        "div",
        {
          style: {
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: long ? "0.18em 0.42em" : "0.22em 0.5em",
            maxWidth: "100%",
            padding: "18px 34px 20px",
            color: PAPER,
            background: `linear-gradient(180deg, rgba(23,27,24,0.92), ${INK})`,
            border: `3px solid ${VERMILION}`,
            borderRadius: 18,
            boxShadow: `0 18px 40px rgba(0,0,0,0.28), 0 0 ${12 + flash * 40}px rgba(196,74,42,${0.25 + flash * 0.4})`,
            fontFamily: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif',
            fontSize,
            fontWeight: 900,
            letterSpacing: long ? "0.04em" : "0.08em",
            lineHeight: 1.15,
            textAlign: "center"
          }
        },
        chunks.map((chunk, index) => {
          const delay = Math.min(8, index * 3);
          const chunkEnter = interpolate(state.localFrame, [delay, delay + 7], [0, 1], {
            easing: Easing.bezier(0.16, 1.4, 0.3, 1),
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp"
          });
          return React.createElement(
            "span",
            {
              key: `${chunk}-${index}`,
              style: {
                display: "inline-block",
                opacity: chunkEnter,
                transform: `translateY(${(1 - chunkEnter) * 28}px) rotate(${(1 - chunkEnter) * -6}deg) scale(${0.6 + chunkEnter * 0.4})`,
                color: index === chunks.length - 1 ? PAPER : PAPER
              }
            },
            chunk
          );
        })
      )
    )
  );
}
