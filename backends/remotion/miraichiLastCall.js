import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

const h = React.createElement;
const FONT = '"Hiragino Sans", "Yu Gothic", "Noto Sans JP", sans-serif';
const COLORS = {
  charcoal: "#171b18",
  ink: "#25241f",
  cream: "#f4ead7",
  paper: "#e8d5b2",
  brass: "#d7ad5d",
  vermilion: "#b73d30",
  teal: "#4bd8c8"
};

export function MiraichiLastCall({ manifest }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const second = frame / fps;
  const captions = manifest.captions ?? [];
  const active = captions.find((caption) => second >= caption.start && second < caption.end) ?? captions.at(-1);
  const background = (manifest.images ?? []).find((image) => image.id === "workflow-background");
  const shiba = (manifest.images ?? []).find((image) => image.id === "shiba");
  const neru = (manifest.images ?? []).find((image) => image.id === "neru");
  const total = manifest.meta.target_duration_seconds;
  const localFrame = Math.max(0, frame - Math.round((active?.start ?? 0) * fps));
  const localDuration = Math.max(1, Math.round(((active?.end ?? total) - (active?.start ?? 0)) * fps));
  const entrance = interpolate(localFrame, [0, Math.round(0.45 * fps)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic)
  });
  const exit = interpolate(localFrame, [localDuration - Math.round(0.3 * fps), localDuration], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic)
  });
  const sceneOpacity = Math.min(entrance, exit);

  return h(
    AbsoluteFill,
    {
      style: {
        overflow: "hidden",
        backgroundColor: "transparent",
        color: COLORS.cream,
        fontFamily: FONT,
        pointerEvents: "none"
      }
    },
    background
      ? h(Img, {
          src: staticFile(background.src),
          alt: background.alt ?? "MIRAICHI background",
          style: {
            position: "absolute",
            inset: -80,
            width: 1240,
            height: 2080,
            objectFit: "cover",
            filter: "saturate(0.72) contrast(1.08)",
            opacity: 0.42,
            scale: interpolate(frame, [0, total * fps], [1.04, 1.12], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.inOut(Easing.cubic)
            })
          }
        })
      : null,
    h("div", {
      style: {
        position: "absolute",
        inset: 0,
        background:
          "radial-gradient(circle at 50% 18%, rgba(215,173,93,0.20), transparent 33%), linear-gradient(180deg, rgba(18,22,19,0.48) 0%, rgba(17,20,18,0.84) 62%, #141714 100%)"
      }
    }),
    h("div", {
      style: {
        position: "absolute",
        inset: 0,
        opacity: 0.22,
        backgroundImage:
          "linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px)",
        backgroundSize: "72px 72px"
      }
    }),
    h(Header, { presentation: manifest.presentation }),
    h(JoineryMark, { frame, fps }),
    h(CharacterPair, { shiba, neru, active, frame, fps }),
    h(
      "div",
      {
        style: {
          position: "absolute",
          inset: "220px 72px 210px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: sceneOpacity,
          translate: `0 ${interpolate(entrance, [0, 1], [56, 0])}px`,
          scale: interpolate(entrance, [0, 1], [0.96, 1])
        }
      },
      h(Scene, { caption: active, localFrame, fps })
    ),
    h(Footer, { presentation: manifest.presentation, frame, fps, total })
  );
}

function Header({ presentation }) {
  return h(
    "div",
    {
      style: {
        position: "absolute",
        top: 76,
        left: 72,
        right: 72,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 24,
        zIndex: 8
      }
    },
    h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: 5 } },
      h("div", { style: { fontSize: 38, fontWeight: 900, letterSpacing: "0.12em" } }, "MIRAICHI"),
      h(
        "div",
        { style: { color: COLORS.brass, fontSize: 22, fontWeight: 800, letterSpacing: "0.08em" } },
        presentation?.event_label ?? "AI VIDEO PRODUCTION SEMINAR"
      )
    ),
    h(
      "div",
      {
        style: {
          border: `2px solid ${COLORS.brass}`,
          borderRadius: 999,
          color: COLORS.brass,
          fontSize: 22,
          fontWeight: 900,
          padding: "10px 18px",
          letterSpacing: "0.08em",
          whiteSpace: "nowrap"
        }
      },
      "本日開催"
    )
  );
}

function JoineryMark({ frame, fps }) {
  const shift = interpolate(frame, [0, Math.round(0.8 * fps)], [48, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic)
  });
  return h(
    "div",
    {
      style: {
        position: "absolute",
        top: 174,
        left: "50%",
        width: 118,
        height: 42,
        translate: "-50% 0",
        opacity: 0.78
      }
    },
    h("div", {
      style: {
        position: "absolute",
        left: -shift,
        top: 0,
        width: 74,
        height: 18,
        backgroundColor: COLORS.paper,
        clipPath: "polygon(0 0,100% 0,100% 52%,68% 52%,68% 100%,0 100%)"
      }
    }),
    h("div", {
      style: {
        position: "absolute",
        right: -shift,
        bottom: 0,
        width: 74,
        height: 18,
        backgroundColor: COLORS.paper,
        clipPath: "polygon(32% 0,100% 0,100% 100%,0 100%,0 48%,32% 48%)"
      }
    }),
    h("div", {
      style: { position: "absolute", left: 50, top: 12, width: 18, height: 18, backgroundColor: COLORS.vermilion }
    })
  );
}

function Scene({ caption, localFrame, fps }) {
  const visual = caption?.visual ?? {};
  switch (visual.kind) {
    case "proof":
      return h(ProofScene, { visual, localFrame, fps });
    case "release":
      return h(ReleaseScene, { visual, localFrame, fps });
    case "time":
      return h(TimeScene, { visual, localFrame, fps });
    case "cta":
      return h(CtaScene, { visual, localFrame, fps });
    default:
      return h(HookScene, { visual, localFrame, fps });
  }
}

function HookScene({ visual, localFrame, fps }) {
  const pulse = 1 + Math.sin((localFrame / fps) * Math.PI * 2.1) * 0.018;
  return h(
    Stack,
    null,
    h(Label, null, visual.kicker ?? "MIRAICHI SEMINAR"),
    h(
      "div",
      {
        style: {
          color: COLORS.cream,
          fontSize: 126,
          fontWeight: 950,
          lineHeight: 1.04,
          letterSpacing: "-0.055em",
          textAlign: "center",
          scale: pulse,
          textShadow: "0 18px 50px rgba(0,0,0,0.42)"
        }
      },
      visual.headline ?? "まもなく開催"
    ),
    h("div", { style: { width: 108, height: 8, backgroundColor: COLORS.vermilion } }),
    h(Supporting, null, visual.detail ?? "本日23:30スタート")
  );
}

function ProofScene({ visual, localFrame, fps }) {
  const numberScale = interpolate(localFrame, [0, Math.round(0.5 * fps), Math.round(0.72 * fps)], [0.78, 1.08, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic)
  });
  return h(
    Stack,
    null,
    h(Label, null, visual.kicker ?? "THANK YOU"),
    h(Supporting, null, visual.headline ?? "参加者"),
    h(
      "div",
      { style: { display: "flex", alignItems: "baseline", justifyContent: "center", color: COLORS.brass, scale: numberScale } },
      h("span", { style: { fontSize: 238, fontWeight: 950, lineHeight: 0.92, letterSpacing: "-0.08em" } }, visual.count ?? "270"),
      h("span", { style: { fontSize: 74, fontWeight: 900, marginLeft: 24 } }, "名超")
    ),
    h(
      "div",
      {
        style: {
          border: `4px solid ${COLORS.vermilion}`,
          color: COLORS.cream,
          fontSize: 76,
          fontWeight: 950,
          padding: "14px 34px",
          rotate: "-2deg",
          letterSpacing: "0.12em"
        }
      },
      visual.detail ?? "参加予定"
    )
  );
}

function ReleaseScene({ visual }) {
  return h(
    Stack,
    null,
    h(Label, null, visual.kicker ?? "SPECIAL ANNOUNCEMENT"),
    h(Supporting, null, visual.headline ?? "AI動画制作ツール"),
    h(
      "div",
      {
        style: {
          color: COLORS.cream,
          fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
          fontSize: 188,
          fontWeight: 700,
          lineHeight: 1,
          letterSpacing: "0.05em",
          textShadow: `9px 9px 0 ${COLORS.vermilion}`
        }
      },
      visual.release_name ?? "継手"
    ),
    h("div", { style: { color: COLORS.brass, fontSize: 42, fontWeight: 900, letterSpacing: "0.18em" } }, "TSUGITE"),
    h(
      "div",
      {
        style: {
          marginTop: 12,
          backgroundColor: COLORS.cream,
          color: COLORS.ink,
          fontSize: 54,
          fontWeight: 950,
          padding: "14px 38px",
          borderRadius: 10
        }
      },
      visual.detail ?? "本日公開"
    )
  );
}

function TimeScene({ visual, localFrame, fps }) {
  const glow = 0.26 + 0.12 * Math.sin((localFrame / fps) * Math.PI * 2);
  return h(
    Stack,
    null,
    h(Label, null, visual.kicker ?? "START TIME"),
    h("div", { style: { fontSize: 70, fontWeight: 900, letterSpacing: "0.16em" } }, visual.headline ?? "本日"),
    h(
      "div",
      {
        style: {
          width: "100%",
          borderTop: `3px solid ${COLORS.brass}`,
          borderBottom: `3px solid ${COLORS.brass}`,
          padding: "34px 0 40px",
          textAlign: "center",
          boxShadow: `0 0 80px rgba(215,173,93,${glow})`
        }
      },
      h("div", { style: { color: COLORS.brass, fontSize: 194, fontWeight: 950, lineHeight: 0.95, letterSpacing: "-0.055em" } }, "23:30"),
      h("div", { style: { marginTop: 18, fontSize: 48, fontWeight: 900, letterSpacing: "0.24em" } }, "START")
    ),
    h(Supporting, null, visual.detail ?? "まもなく始まります")
  );
}

function CtaScene({ visual, localFrame, fps }) {
  const buttonScale = 1 + Math.sin((localFrame / fps) * Math.PI * 2.2) * 0.025;
  return h(
    Stack,
    { gap: 30 },
    h(Label, null, visual.kicker ?? "JOIN US"),
    h("div", { style: { color: COLORS.brass, fontSize: 58, fontWeight: 900 } }, visual.headline ?? "まだ間に合います"),
    h(
      "div",
      {
        style: {
          fontSize: 104,
          fontWeight: 950,
          lineHeight: 1.12,
          letterSpacing: "-0.04em",
          textAlign: "center",
          textShadow: "0 16px 45px rgba(0,0,0,0.4)"
        }
      },
      visual.detail ?? "ぜひ\nご参加ください"
    ),
    h(
      "div",
      {
        style: {
          marginTop: 18,
          backgroundColor: COLORS.vermilion,
          color: "white",
          border: `3px solid ${COLORS.paper}`,
          borderRadius: 999,
          boxShadow: "0 18px 45px rgba(0,0,0,0.34)",
          fontSize: 44,
          fontWeight: 950,
          padding: "22px 54px",
          scale: buttonScale,
          letterSpacing: "0.08em"
        }
      },
      "今すぐ参加する"
    )
  );
}

function CharacterPair({ shiba, neru, active, frame, fps }) {
  if (!shiba || !neru) return null;
  const kind = active?.visual?.kind;
  const visible = kind === "hook" || kind === "proof" || kind === "cta";
  const opacity = visible ? (kind === "cta" ? 0.9 : 0.34) : 0.14;
  const bob = Math.sin((frame / fps) * Math.PI * 1.3) * 7;
  return h(
    React.Fragment,
    null,
    h(Img, {
      src: staticFile(shiba.src),
      alt: shiba.alt ?? "シバ",
      style: {
        position: "absolute",
        left: -38,
        bottom: 94 + bob,
        width: 420,
        height: 560,
        objectFit: "contain",
        objectPosition: "bottom left",
        opacity,
        filter: "drop-shadow(0 18px 25px rgba(0,0,0,0.35))"
      }
    }),
    h(Img, {
      src: staticFile(neru.src),
      alt: neru.alt ?? "ネル",
      style: {
        position: "absolute",
        right: -28,
        bottom: 86 - bob,
        width: 390,
        height: 610,
        objectFit: "contain",
        objectPosition: "bottom right",
        opacity,
        filter: "drop-shadow(0 18px 25px rgba(0,0,0,0.35))"
      }
    })
  );
}

function Footer({ presentation, frame, fps, total }) {
  const progress = Math.min(1, frame / Math.max(1, total * fps - 1));
  return h(
    "div",
    {
      style: {
        position: "absolute",
        left: 72,
        right: 72,
        bottom: 72,
        display: "flex",
        flexDirection: "column",
        gap: 20,
        zIndex: 8
      }
    },
    h(
      "div",
      { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 22 } },
      h("div", { style: { color: "rgba(244,234,215,0.72)", fontSize: 25, fontWeight: 800 } }, presentation?.source_url_label ?? "miraichi0717.peatix.com"),
      h("div", { style: { color: COLORS.brass, fontSize: 23, fontWeight: 900, letterSpacing: "0.10em" } }, "07.17 / 23:30")
    ),
    h(
      "div",
      { style: { height: 7, backgroundColor: "rgba(244,234,215,0.16)", overflow: "hidden" } },
      h("div", { style: { width: `${progress * 100}%`, height: "100%", backgroundColor: COLORS.vermilion } })
    )
  );
}

function Stack({ children, gap = 34 }) {
  return h(
    "div",
    {
      style: {
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap,
        whiteSpace: "pre-line",
        textAlign: "center"
      }
    },
    children
  );
}

function Label({ children }) {
  return h(
    "div",
    {
      style: {
        color: COLORS.brass,
        fontSize: 27,
        fontWeight: 900,
        letterSpacing: "0.18em",
        textTransform: "uppercase"
      }
    },
    children
  );
}

function Supporting({ children }) {
  return h(
    "div",
    { style: { color: "rgba(244,234,215,0.86)", fontSize: 48, fontWeight: 850, lineHeight: 1.35 } },
    children
  );
}
