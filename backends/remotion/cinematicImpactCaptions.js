import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { captionMotionState, captionSegments } from "./captionMotion.mjs";

const GOLD = "#ffcc57";
const RED = "#ff2b18";
const INK = "rgba(2, 2, 5, 0.9)";

export function CinematicImpactCaptions({ captions, fps }) {
  const frame = useCurrentFrame();
  const second = frame / fps;
  const active = captions.find((caption) => second >= caption.start && second < caption.end);
  if (!active) return null;

  const state = captionMotionState(active, second, fps);
  const index = captions.indexOf(active);
  const enter = interpolate(state.enter, [0, 1], [0, 1], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const exit = interpolate(state.exit, [0, 1], [0, 1], {
    easing: Easing.in(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const visible = Math.min(1, enter * 1.8) * (1 - exit);
  const impact = interpolate(state.localFrame, [0, 2, 8, 14], [0, 1, 0.24, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const tremor = (1 - Math.min(1, state.localFrame / 12)) * Math.sin(state.localFrame * 3.7) * 24;
  const accent = index === 1 ? RED : GOLD;
  const kicker = active.visual?.kicker ?? `怪異記録・零${index + 1}`;
  const segments = captionSegments(active.text, active.emphasis);
  const long = active.text.length > 13;

  return React.createElement(
    AbsoluteFill,
    { style: { pointerEvents: "none", overflow: "hidden" } },
    React.createElement("div", {
      style: {
        position: "absolute",
        inset: 0,
        opacity: visible,
        background: `linear-gradient(180deg, transparent 48%, rgba(0,0,0,${0.46 + impact * 0.2}) 100%)`
      }
    }),
    React.createElement("div", {
      style: {
        position: "absolute",
        left: "50%",
        bottom: 285,
        width: 1220,
        height: 410,
        border: `8px solid ${accent}`,
        borderRadius: "50%",
        opacity: impact * 0.75,
        scale: 0.22 + enter * 1.25,
        translate: "-50% 50%",
        filter: "blur(3px)",
        boxShadow: `0 0 70px ${accent}`
      }
    }),
    ...impactFragments(state.localFrame, enter, exit, accent),
    React.createElement(
      "div",
      {
        style: {
          position: "absolute",
          left: 74,
          right: 74,
          bottom: 165,
          minHeight: 300,
          opacity: visible,
          translate: `${tremor - exit * 170}px ${interpolate(enter, [0, 1], [155, 0]) + exit * 35}px`,
          rotate: `${interpolate(enter, [0, 1], [-7, -1.2]) + exit * 3}deg`,
          scale: `${interpolate(enter, [0, 1], [1.9, 1])} ${interpolate(enter, [0, 1], [0.45, 1])}`,
          filter: `blur(${(1 - enter) * 18}px)`,
          transformOrigin: "center bottom"
        }
      },
      React.createElement("div", {
        style: {
          position: "absolute",
          inset: "26px -54px 10px -54px",
          background: `linear-gradient(102deg, transparent 0%, ${INK} 8%, rgba(3,3,7,.96) 52%, ${INK} 91%, transparent 100%)`,
          clipPath: "polygon(2% 20%, 100% 0, 96% 78%, 4% 100%)",
          scale: `${Math.max(0.01, enter)} 1`,
          boxShadow: `0 18px 70px rgba(0,0,0,.72), inset 0 -3px 0 ${accent}`
        }
      }),
      React.createElement("div", {
        style: {
          position: "absolute",
          left: 0,
          right: 0,
          top: 7,
          height: 8,
          background: `linear-gradient(90deg, transparent, ${accent} 22%, #fff 50%, ${accent} 78%, transparent)`,
          scale: `${interpolate(enter, [0, 1], [0, 1])} 1`,
          boxShadow: `0 0 24px ${accent}`
        }
      }),
      React.createElement(
        "div",
        {
          style: {
            position: "relative",
            zIndex: 2,
            minHeight: 286,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            padding: "28px 56px 26px",
            gap: 12
          }
        },
        React.createElement(
          "div",
          {
            style: {
              color: accent,
              fontFamily: "Arial Black, Hiragino Kaku Gothic ProN, sans-serif",
              fontSize: 28,
              fontWeight: 900,
              letterSpacing: 12,
              opacity: interpolate(state.localFrame, [4, 12], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp"
              }),
              translate: `${interpolate(state.localFrame, [4, 12], [-150, 0], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp"
              })}px 0`,
              textShadow: `0 0 18px ${accent}`
            }
          },
          kicker
        ),
        React.createElement(
          "div",
          {
            style: {
              position: "relative",
              color: "white",
              fontFamily: "Hiragino Kaku Gothic ProN, Yu Gothic, sans-serif",
              fontSize: long ? 70 : 108,
              fontWeight: 950,
              lineHeight: 1.02,
              letterSpacing: `${interpolate(enter, [0, 1], [22, 1])}px`,
              textAlign: "center",
              maxWidth: 930,
              textWrap: "balance",
              WebkitTextStroke: "2px rgba(255,255,255,.92)",
              paintOrder: "stroke fill",
              textShadow: `5px 7px 0 #000, -3px -2px 0 #000, 0 0 22px rgba(255,255,255,.45), 0 0 ${10 + impact * 36}px ${accent}`
            }
          },
          React.createElement(
            "div",
            {
              style: {
                position: "absolute",
                inset: 0,
                color: RED,
                opacity: impact * 0.85,
                translate: `${-18 * impact}px ${5 * impact}px`,
                mixBlendMode: "screen"
              }
            },
            active.text
          ),
          React.createElement(
            "div",
            {
              style: {
                position: "absolute",
                inset: 0,
                color: "#39d9ff",
                opacity: impact * 0.55,
                translate: `${18 * impact}px ${-4 * impact}px`,
                mixBlendMode: "screen"
              }
            },
            active.text
          ),
          React.createElement(
            "span",
            null,
            ...segments.map((segment, segmentIndex) =>
              React.createElement(
                "span",
                {
                  key: `${segment.text}-${segmentIndex}`,
                  style: segment.emphasized
                    ? {
                        color: accent,
                        WebkitTextStroke: "2px #fff4c4",
                        textShadow: `4px 6px 0 #000, 0 0 28px ${accent}, 0 0 8px ${RED}`
                      }
                    : undefined
                },
                segment.text
              )
            )
          )
        ),
        React.createElement("div", {
          style: {
            width: `${interpolate(state.localFrame, [8, 22], [0, 100], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp"
            })}%`,
            height: 6,
            background: `linear-gradient(90deg, transparent, ${accent}, white, ${accent}, transparent)`,
            boxShadow: `0 0 22px ${accent}`,
            translate: `${interpolate(state.localFrame, [8, 22], [-180, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp"
            })}px 0`
          }
        })
      )
    ),
    React.createElement("div", {
      style: {
        position: "absolute",
        inset: 0,
        opacity: impact * 0.24,
        background: "white",
        mixBlendMode: "screen"
      }
    })
  );
}

function impactFragments(localFrame, enter, exit, accent) {
  return Array.from({ length: 18 }, (_, index) => {
    const angle = (index / 18) * Math.PI * 2 + 0.35;
    const distance = interpolate(enter, [0, 1], [0, 380 + (index % 4) * 44]);
    const size = 8 + (index % 5) * 5;
    return React.createElement("div", {
      key: `impact-fragment-${index}`,
      style: {
        position: "absolute",
        left: "50%",
        bottom: 330,
        width: size * 3.2,
        height: size,
        background: index % 3 === 0 ? accent : "rgba(255,255,255,.88)",
        opacity: Math.max(0, (1 - enter * 0.82) * (1 - exit)),
        translate: `${Math.cos(angle) * distance}px ${Math.sin(angle) * distance}px`,
        rotate: `${(localFrame * (index % 2 ? 11 : -9) + index * 23) % 360}deg`,
        boxShadow: `0 0 ${size * 2}px ${accent}`,
        clipPath: "polygon(0 30%, 100% 0, 78% 100%, 8% 75%)"
      }
    });
  });
}
