import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import {
  captionMotionState,
  captionSegments,
  lyricChunkReveal,
  lyricChunks
} from "./captionMotion.mjs";
import { beatEnergy, beatVideoScale, LYRIC_IMPACTS } from "./lyricBeatGrid.mjs";

const ACCENT = "#7dffd4";
const WHITE = "#f7fbff";

export function LyricKineticCaptions({ captions, fps }) {
  const frame = useCurrentFrame();
  const second = frame / fps;
  const impact = beatEnergy(second, LYRIC_IMPACTS, 0.16);
  const active = (captions ?? []).find((caption) => second >= caption.start && second < caption.end);

  return React.createElement(
    AbsoluteFill,
    { style: { pointerEvents: "none", overflow: "hidden" } },
    React.createElement("div", {
      style: {
        position: "absolute",
        inset: 0,
        opacity: impact * 0.5,
        background: "radial-gradient(circle at 50% 42%, rgba(255,255,255,0.38), rgba(125,255,212,0.1) 42%, transparent 70%)"
      }
    }),
    React.createElement("div", {
      style: {
        position: "absolute",
        inset: 0,
        boxShadow: `inset 0 0 ${40 + impact * 110}px rgba(0,0,0,${0.22 + impact * 0.35})`,
        border: `${Math.max(0, impact * 8)}px solid rgba(125,255,212,${impact * 0.5})`
      }
    }),
    React.createElement("div", {
      style: {
        position: "absolute",
        left: 0,
        right: 0,
        top: `${interpolate(impact, [0, 1], [46, 16])}%`,
        height: 2,
        opacity: impact * 0.7,
        background: "linear-gradient(90deg, transparent, #7dffd4, transparent)"
      }
    }),
    active ? renderLyric(active, second, fps, impact) : null
  );
}

function renderLyric(active, second, fps, impact) {
  const state = captionMotionState(active, second, fps);
  const exit = interpolate(state.exit, [0, 1], [0, 1], {
    easing: Easing.in(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const chunks = lyricChunks(active.text);
  const revealed = lyricChunkReveal(chunks.length, state.localFrame, state.durationInFrames);
  const long = active.text.length > 16;
  const visible = 1 - exit;
  const punch = 1 + impact * 0.1;

  return React.createElement(
    React.Fragment,
    null,
    React.createElement("div", {
      style: {
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: 420,
        opacity: visible * 0.92,
        background: "linear-gradient(180deg, transparent 0%, rgba(4,8,16,0.72) 58%, rgba(4,8,16,0.88) 100%)"
      }
    }),
    React.createElement(
      "div",
      {
        style: {
          position: "absolute",
          left: 80,
          right: 80,
          bottom: 88,
          opacity: visible,
          transform: `translateY(${exit * 24}px) scale(${punch})`,
          transformOrigin: "center bottom",
          textAlign: "center"
        }
      },
      React.createElement(
        "div",
        {
          style: {
            color: WHITE,
            fontFamily: "Hiragino Sans, Arial Black, sans-serif",
            fontSize: long ? 60 : 74,
            fontWeight: 800,
            lineHeight: 1.22,
            letterSpacing: "0.04em",
            textShadow: `0 0 ${22 + impact * 40}px rgba(125,255,212,${0.28 + impact * 0.35}), 0 8px 24px rgba(0,0,0,0.85)`,
            WebkitTextStroke: "1px rgba(0,0,0,0.35)"
          }
        },
        chunks.map((chunk, index) => {
          if (!revealed[index]) return null;
          const appearFrame = state.localFrame - index * Math.max(3, Math.min(5, state.durationInFrames / Math.max(1, chunks.length)));
          const pop = index === 0
            ? 1
            : interpolate(appearFrame, [0, 4], [1.22, 1], {
                easing: Easing.bezier(0.16, 1, 0.3, 1),
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp"
              });
          const fade = index === 0
            ? 1
            : interpolate(appearFrame, [0, 2], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp"
              });
          const segments = captionSegments(chunk, active.emphasis);
          return React.createElement(
            "span",
            {
              key: `${active.id ?? active.start}-${index}`,
              style: {
                display: "inline-block",
                marginRight: 18,
                opacity: fade,
                transform: `scale(${pop})`,
                transformOrigin: "center bottom"
              }
            },
            segments.map((segment, segmentIndex) =>
              React.createElement(
                "span",
                {
                  key: `${index}-${segmentIndex}`,
                  style: segment.emphasized
                    ? { color: ACCENT, textShadow: `0 0 ${28 + impact * 24}px ${ACCENT}` }
                    : undefined
                },
                segment.text
              )
            )
          );
        })
      )
    )
  );
}

export { beatVideoScale };
