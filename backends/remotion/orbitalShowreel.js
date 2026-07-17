import React from "react";
import {
  AbsoluteFill,
  Easing,
  OffthreadVideo,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig
} from "remotion";
import { resolveOrbitalShowreel } from "./orbitalPresentation.mjs";

const h = React.createElement;
const FONT = '"Hiragino Sans", "Yu Gothic", sans-serif';
const MONO = 'SFMono-Regular, Consolas, monospace';
const INK = "#f4efe4";
const GOLD = "#e5a64b";
const BACKGROUND = "#07090d";

export function OrbitalShowreel({ manifest }) {
  const { fps } = useVideoConfig();
  const { clips, featured } = resolveOrbitalShowreel(manifest);
  const scenes = [
    h(SceneSequence, { key: "hook", from: 0, duration: 3, fps }, h(GridBurst, { clips, headline: "これ、全部。" })),
    h(SceneSequence, { key: "orbit", from: 3, duration: 3, fps }, h(OrbitalGallery, { clips, headline: "ひとつの流れから。" })),
    ...featured.map((entry, index) =>
      h(SceneSequence, { key: entry.clip.id, from: 6 + index * 5, duration: 5, fps },
        h(FeatureScene, { ...entry, index }))
    ),
    h(SceneSequence, { key: "proof", from: 21, duration: 5, fps },
      h(OrbitalGallery, { clips, headline: "人が選んで、仕上げる。", proof: true })),
    h(SceneSequence, { key: "outro", from: 26, duration: 4, fps }, h(EndCard))
  ];

  return h(
    AbsoluteFill,
    { style: { backgroundColor: BACKGROUND, color: INK, fontFamily: FONT, overflow: "hidden" } },
    h(Atmosphere),
    ...scenes
  );
}

function SceneSequence({ from, duration, fps, children }) {
  return h(Sequence, {
    from: Math.round(from * fps),
    durationInFrames: Math.round(duration * fps),
    premountFor: fps,
    children
  });
}

function Atmosphere() {
  return h(
    AbsoluteFill,
    { style: { pointerEvents: "none" } },
    h("div", {
      style: {
        position: "absolute",
        inset: 0,
        backgroundImage: "linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.025) 1px, transparent 1px)",
        backgroundSize: "72px 72px"
      }
    }),
    h("div", {
      style: {
        position: "absolute",
        width: 900,
        height: 900,
        left: -360,
        top: -420,
        borderRadius: "50%",
        background: "radial-gradient(circle, rgba(229,166,75,.18), transparent 68%)"
      }
    }),
    h("div", {
      style: {
        position: "absolute",
        width: 1000,
        height: 1000,
        right: -480,
        bottom: -560,
        borderRadius: "50%",
        background: "radial-gradient(circle, rgba(67,162,173,.15), transparent 68%)"
      }
    })
  );
}

function GridBurst({ clips, headline }) {
  const frame = useCurrentFrame();
  const tiles = Array.from({ length: 12 }, (_, index) => clips[index % clips.length]);
  return h(
    AbsoluteFill,
    { style: { alignItems: "center", justifyContent: "center" } },
    h("div", {
      style: {
        display: "grid",
        gridTemplateColumns: "repeat(4, 390px)",
        gap: 24,
        scale: interpolate(frame, [0, 88], [1.16, 0.98], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
      }
    }, ...tiles.map((clip, index) => {
      const delay = index * 2;
      return h(TileFrame, {
        key: `${clip.id}-${index}`,
        clip,
        style: {
          width: 390,
          height: 220,
          opacity: interpolate(frame, [delay, delay + 14], [0, 0.82], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          translate: `${interpolate(frame, [delay, delay + 18], [index % 2 === 0 ? -120 : 120, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}px 0px`,
          scale: interpolate(frame, [delay, delay + 18], [0.72, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
        }
      });
    })),
    h(HeadlinePlate, { text: headline, eyebrow: "MADE WITH TSUGITE" })
  );
}

function OrbitalGallery({ clips, headline, proof = false }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tiles = Array.from({ length: 12 }, (_, index) => clips[index % clips.length]);
  const rotation = interpolate(frame, [0, proof ? 5 * fps : 3 * fps], [proof ? -80 : 24, proof ? 220 : -118], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const enter = interpolate(frame, [0, 20], [0, 1], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });

  return h(
    AbsoluteFill,
    { style: { perspective: 1500, alignItems: "center", justifyContent: "center" } },
    h("div", {
      style: {
        position: "absolute",
        inset: 0,
        transformStyle: "preserve-3d",
        transform: `rotateX(-7deg) rotateY(${rotation}deg) scale(${0.72 + enter * 0.28})`
      }
    }, ...tiles.map((clip, index) => {
      const column = index % 6;
      const row = index < 6 ? -1 : 1;
      return h(TileFrame, {
        key: `${clip.id}-orbit-${index}`,
        clip,
        style: {
          position: "absolute",
          left: 750,
          top: 422 + row * 145,
          width: 420,
          height: 236,
          opacity: 0.9,
          transform: `rotateY(${column * 60}deg) translateZ(690px) rotateZ(${row * 1.5}deg)`,
          boxShadow: "0 28px 70px rgba(0,0,0,.42)"
        }
      });
    })),
    h(HeadlinePlate, {
      text: headline,
      eyebrow: proof ? "HUMAN IN THE LOOP" : "ORBITAL GALLERY",
      bottom: proof ? 108 : 96
    })
  );
}

function FeatureScene({ clip, label, counter, accent, index }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = interpolate(frame, [0, 18], [0, 1], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const exit = interpolate(frame, [4.25 * fps, 5 * fps], [0, 1], {
    easing: Easing.in(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const focus = enter - exit;
  const video = h(OffthreadVideo, {
    src: staticFile(clip.src),
    startFrom: Math.round(clip.in * fps),
    muted: true,
    style: { width: "100%", height: "100%", objectFit: "cover" }
  });

  return h(
    AbsoluteFill,
    { style: { alignItems: "center", justifyContent: "center" } },
    h("div", {
      style: {
        position: "absolute",
        inset: -45,
        opacity: 0.34 * focus,
        filter: "blur(26px) saturate(.8)",
        scale: 1.13
      }
    }, h(OffthreadVideo, {
      src: staticFile(clip.src),
      startFrom: Math.round(clip.in * fps),
      muted: true,
      style: { width: "100%", height: "100%", objectFit: "cover" }
    })),
    h("div", {
      style: {
        position: "relative",
        width: 1510,
        height: 850,
        overflow: "hidden",
        border: `3px solid ${accent}`,
        borderRadius: 18,
        background: "#000",
        boxShadow: `0 0 0 1px rgba(255,255,255,.18), 0 36px 100px rgba(0,0,0,.62), 0 0 70px ${accent}30`,
        opacity: focus,
        transform: `perspective(1200px) rotateY(${(1 - enter) * (index % 2 === 0 ? 10 : -10) + exit * 8}deg) scale(${0.84 + focus * 0.16})`
      }
    },
    video,
    h("div", {
      style: {
        position: "absolute",
        inset: 0,
        background: "linear-gradient(180deg, rgba(0,0,0,.08) 45%, rgba(0,0,0,.88) 100%)"
      }
    }),
    h("div", {
      style: {
        position: "absolute",
        left: 62,
        right: 62,
        bottom: 50,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: 50
      }
    },
    h("div", null,
      h("div", { style: { color: accent, fontFamily: MONO, fontSize: 24, fontWeight: 800, letterSpacing: ".16em", marginBottom: 12 } }, "PICKED FROM THE GALLERY"),
      h("div", { style: { fontSize: 112, fontWeight: 900, lineHeight: 1, letterSpacing: "-.05em" } }, label)
    ),
    h("div", { style: { fontFamily: MONO, fontSize: 34, fontWeight: 800, color: "rgba(255,255,255,.78)" } }, counter)
    )));
}

function TileFrame({ clip, style }) {
  const { fps } = useVideoConfig();
  return h(
    "div",
    {
      style: {
        overflow: "hidden",
        borderRadius: 10,
        border: "1px solid rgba(255,255,255,.22)",
        background: "#111",
        ...style
      }
    },
    h(OffthreadVideo, {
      src: staticFile(clip.src),
      startFrom: Math.round(clip.in * fps),
      muted: true,
      style: { width: "100%", height: "100%", objectFit: "cover" }
    })
  );
}

function HeadlinePlate({ text, eyebrow, bottom = 100 }) {
  return h("div", {
    style: {
      position: "absolute",
      left: 80,
      right: 80,
      bottom,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 15,
      textAlign: "center",
      textShadow: "0 8px 36px rgba(0,0,0,.9)"
    }
  },
  h("div", { style: { color: GOLD, fontFamily: MONO, fontSize: 24, fontWeight: 800, letterSpacing: ".18em" } }, eyebrow),
  h("div", { style: { fontSize: 108, fontWeight: 900, lineHeight: 1.03, letterSpacing: "-.055em" } }, text)
  );
}

function EndCard() {
  const frame = useCurrentFrame();
  const enter = interpolate(frame, [0, 22], [0, 1], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  return h(
    AbsoluteFill,
    { style: { alignItems: "center", justifyContent: "center", textAlign: "center" } },
    h("div", { style: { opacity: enter, translate: `0px ${interpolate(enter, [0, 1], [44, 0])}px` } },
      h("div", {
        style: {
          display: "inline-grid",
          gridTemplateColumns: "70px 70px",
          gap: 0,
          marginBottom: 34,
          rotate: "-3deg"
        }
      },
      h("div", { style: { width: 78, height: 32, background: GOLD, clipPath: "polygon(0 0,100% 0,100% 45%,68% 45%,68% 100%,0 100%)" } }),
      h("div", { style: { width: 78, height: 32, marginTop: 20, marginLeft: -10, background: "#f3ead8", clipPath: "polygon(32% 0,100% 0,100% 100%,0 100%,0 55%,32% 55%)" } })
      ),
      h("div", { style: { color: GOLD, fontFamily: MONO, fontSize: 24, fontWeight: 800, letterSpacing: ".22em", marginBottom: 16 } }, "AI VIDEO WORKFLOW"),
      h("div", { style: { fontFamily: MONO, fontSize: 132, fontWeight: 900, letterSpacing: "-.07em", lineHeight: .92 } }, "Tsugite"),
      h("div", { style: { fontSize: 58, fontWeight: 800, marginTop: 28, letterSpacing: "-.03em" } }, "AI映像制作を、ひとつの流れに。"),
      h("div", { style: { color: "rgba(244,239,228,.68)", fontSize: 30, marginTop: 22 } }, "人が確認して、次へ進む。")
    )
  );
}
