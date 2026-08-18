import React from "react";
import { AbsoluteFill, Easing, Interactive, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

const h = React.createElement;
const JP = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif';
const EN = "Avenir Next, Helvetica Neue, Arial, sans-serif";
const CREAM = "#fff2d0";
const MOSS = "#9dcf63";
const ENGINE = "#e94d2f";
const INK = "#14130f";

export const KUSAKARI_TITLE_CARD_PRESET = "kusakari-title-card";

export function KusakariTitleCard({ manifest }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const second = frame / fps;
  const end = Number(manifest?.presentation?.title_end_seconds ?? 8);
  const onTitle = second < end;
  const onGrass = second >= 14 && second < 17.1;
  const onBreak = second >= 60 && second < 65;

  let title = null;
  if (onTitle) {
    const fadeIn = interpolate(second, [0.05, 0.35], [0, 1], {
      easing: Easing.out(Easing.cubic),
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp"
    });
    const hold = interpolate(second, [end - 0.12, end], [1, 0], {
      easing: Easing.in(Easing.quad),
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp"
    });
    const visible = fadeIn * hold;
    const stampHold = interpolate(second, [6.35, 6.7], [1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp"
    });
    title = [
      h(SpeedLines, { key: "lines", opacity: visible * 0.5, second }),
      h(Halftone, { key: "tone", opacity: visible * 0.2 }),
      h("div", {
        key: "veil",
        style: {
          position: "absolute",
          inset: 0,
          opacity: visible * 0.5,
          background:
            "linear-gradient(180deg, rgba(10,12,7,.34) 0%, transparent 30%, transparent 56%, rgba(8,9,5,.78) 100%)"
        }
      }),
      h(ComicBurst, { key: "burst", opacity: visible * 0.88 }),
      h(AppearBanner, { key: "banner", amount: pop(second, 0.28, 0.72) * visible }),
      h(HeroStack, {
        key: "hero",
        title: pop(second, 1.05, 1.55) * visible,
        english: pop(second, 1.35, 1.85) * visible
      }),
      h(EntryStamp, { key: "stamp", amount: pop(second, 4.7, 5.15) * visible * stampHold })
    ];
  }

  return h(
    AbsoluteFill,
    { style: { pointerEvents: "none", overflow: "hidden" } },
    title,
    onGrass && h(GrassLyric, { second }),
    onBreak && h(BreakLyric, { second })
  );
}

function GrassLyric({ second }) {
  const lines = [
    { start: 14.0, end: 14.65, jp: "朝　朝　朝", en: "MORNING. MORNING. MORNING.", banner: false },
    { start: 14.65, end: 15.9, jp: "伸びてる", en: "It's already growing.", banner: true },
    { start: 15.9, end: 17.1, jp: "名前も 知らん草", en: "Weeds I can't even name.", banner: false }
  ];
  const line = lines.find((item) => second >= item.start && second < item.end);
  if (!line) return null;
  return h(
    AbsoluteFill,
    null,
    line.banner &&
      h(
        "div",
        {
          style: {
            position: "absolute",
            left: 72,
            top: 96,
            right: 220
          }
        },
        h("div", {
          style: {
            color: MOSS,
            fontFamily: EN,
            fontSize: 18,
            fontWeight: 800,
            letterSpacing: ".18em",
            marginBottom: 8
          },
          children: "ORDINARY WORLD"
        }),
        h("div", {
          style: {
            display: "inline-block",
            background: "rgba(20,19,15,.72)",
            color: CREAM,
            fontFamily: EN,
            fontSize: 42,
            fontWeight: 900,
            letterSpacing: ".02em",
            padding: "10px 22px",
            borderLeft: `6px solid ${MOSS}`
          },
          children: "EVERY MORNING, THE WILD RETURNS."
        })
      ),
    h(
      Interactive.Div,
      {
        name: "Caption",
        style: {
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 72,
          textAlign: "center"
        }
      },
      h("div", {
        style: {
          color: CREAM,
          fontFamily: JP,
          fontSize: 56,
          fontWeight: 950,
          textShadow: "0 4px 18px rgba(0,0,0,.7)"
        },
        children: line.jp
      }),
      h("div", {
        style: {
          marginTop: 6,
          color: ENGINE,
          fontFamily: EN,
          fontSize: 20,
          fontWeight: 800,
          letterSpacing: ".14em"
        },
        children: line.en
      })
    )
  );
}

function BreakLyric({ second }) {
  const line = second < 63
    ? { jp: "休憩ついでに", en: "Taking a break." }
    : { jp: "お、思ったより ちゃんと進行", en: "It's moving." };
  return h(
    Interactive.Div,
    {
      name: "Caption",
      style: {
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 72,
        textAlign: "center"
      }
    },
    h("div", {
      style: {
        color: CREAM,
        fontFamily: JP,
        fontSize: 56,
        fontWeight: 950,
        textShadow: "0 4px 18px rgba(0,0,0,.7)"
      },
      children: line.jp
    }),
    h("div", {
      style: {
        marginTop: 6,
        color: ENGINE,
        fontFamily: EN,
        fontSize: 20,
        fontWeight: 800,
        letterSpacing: ".14em"
      },
      children: line.en
    })
  );
}

function pop(second, start, peak) {
  return interpolate(second, [start, peak], [0, 1], {
    easing: Easing.out(Easing.back(2.2)),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
}

function pulse(second, at, width = 0.08) {
  return interpolate(second, [at - width, at, at + width], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
}

function AppearBanner({ amount }) {
  if (amount <= 0) return null;
  return h(
    Interactive.Div,
    {
      name: "Title",
      style: {
        position: "absolute",
        top: 44,
        left: 40,
        transform: `rotate(-4deg) translateX(${(1 - amount) * -36}px) scale(${0.82 + amount * 0.18})`,
        transformOrigin: "left center",
        opacity: amount,
        background: ENGINE,
        color: CREAM,
        fontFamily: JP,
        fontSize: 36,
        fontWeight: 950,
        letterSpacing: ".14em",
        padding: "12px 30px 13px",
        boxShadow: "8px 8px 0 rgba(0,0,0,.55)",
        border: `4px solid ${INK}`,
        whiteSpace: "nowrap"
      }
    },
    "ヒーロー登場 !!"
  );
}

function HeroStack({ title, english }) {
  if (title <= 0 && english <= 0) return null;
  return h(
    Interactive.Div,
    {
      name: "Title",
      style: {
        position: "absolute",
        left: "50%",
        top: "28%",
        width: 1560,
        marginLeft: -780,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center"
      }
    },
    title > 0 &&
      h("div", {
        style: {
          color: CREAM,
          fontFamily: EN,
          fontSize: 26,
          fontWeight: 900,
          letterSpacing: ".28em",
          marginBottom: 12,
          opacity: title,
          textShadow: `0 2px 0 ${INK}, 3px 3px 0 ${MOSS}`
        },
        children: "RURAL VIBE-CODING HERO"
      }),
    title > 0 &&
      h("div", {
        style: {
          display: "inline-block",
          color: CREAM,
          fontFamily: JP,
          fontSize: 64,
          lineHeight: 1.05,
          fontWeight: 950,
          letterSpacing: "-.04em",
          padding: "14px 32px 18px",
          background: INK,
          border: `6px solid ${CREAM}`,
          boxShadow: `10px 10px 0 ${ENGINE}`,
          clipPath: "polygon(2% 0, 100% 3%, 98% 100%, 0 96%)",
          opacity: title,
          transform: `rotate(${-2.4 + (1 - title) * -8}deg) scale(${0.62 + title * 0.38})`
        },
        children: "田舎のバイブコーディングヒーロー"
      }),
    english > 0 &&
      h("div", {
        style: {
          marginTop: 22,
          display: "inline-block",
          color: INK,
          fontFamily: EN,
          fontSize: 92,
          lineHeight: 0.92,
          fontWeight: 950,
          letterSpacing: "-.045em",
          padding: "10px 34px 14px",
          background: CREAM,
          border: `7px solid ${ENGINE}`,
          boxShadow: `0 0 0 5px ${INK}, 12px 12px 0 ${ENGINE}`,
          transform: `rotate(${1.6 + (1 - english) * 10}deg) scale(${0.45 + english * 0.55})`,
          opacity: english,
          WebkitTextStroke: `2px ${INK}`
        },
        children: "THE FIELD CODER"
      })
  );
}

function EntryStamp({ amount }) {
  if (amount <= 0) return null;
  return h(
    "div",
    {
      style: {
        position: "absolute",
        right: 64,
        bottom: 52,
        opacity: amount,
        transform: `rotate(12deg) scale(${0.2 + amount * 0.8})`,
        border: `8px solid ${ENGINE}`,
        color: ENGINE,
        fontFamily: JP,
        fontSize: 42,
        fontWeight: 950,
        letterSpacing: ".2em",
        padding: "10px 18px 8px",
        background: "rgba(255,242,208,.14)",
        boxShadow: "0 0 0 6px rgba(20,19,15,.65)"
      }
    },
    "登場"
  );
}

function SpeedLines({ opacity, second }) {
  const lines = [];
  for (let i = 0; i < 18; i += 1) {
    const deg = i * 20 + second * 8;
    lines.push(
      h("div", {
        key: i,
        style: {
          position: "absolute",
          left: "50%",
          top: "50%",
          width: 14 + (i % 3) * 6,
          height: 980,
          marginLeft: -7,
          marginTop: -490,
          background: `linear-gradient(180deg, transparent 8%, ${CREAM} 48%, transparent 92%)`,
          opacity: 0.12 + (i % 4) * 0.04,
          transform: `rotate(${deg}deg)`
        }
      })
    );
  }
  return h(AbsoluteFill, { style: { opacity } }, ...lines);
}

function Halftone({ opacity }) {
  return h("div", {
    style: {
      position: "absolute",
      inset: 0,
      opacity,
      backgroundImage: "radial-gradient(rgba(255,242,208,.55) 1.1px, transparent 1.3px)",
      backgroundSize: "11px 11px",
      mixBlendMode: "overlay"
    }
  });
}

function ComicBurst({ opacity }) {
  return h("div", {
    style: {
      position: "absolute",
      left: "50%",
      top: "42%",
      width: 980,
      height: 520,
      marginLeft: -490,
      marginTop: -260,
      opacity,
      background:
        "conic-gradient(from 90deg, transparent 0 8deg, rgba(233,77,47,.28) 8deg 14deg, transparent 14deg 28deg, rgba(157,207,99,.2) 28deg 34deg, transparent 34deg)",
      clipPath: "polygon(50% 0, 62% 28%, 100% 35%, 70% 58%, 78% 100%, 50% 74%, 22% 100%, 30% 58%, 0 35%, 38% 28%)",
      filter: "blur(0.4px)"
    }
  });
}

function PunchFlash({ amount }) {
  return h("div", {
    style: {
      position: "absolute",
      inset: 0,
      background: CREAM,
      opacity: amount * 0.28,
      mixBlendMode: "screen"
    }
  });
}

function HalfwayOverlay({ second }) {
  const lines = [
    { start: 106.3, end: 107.15, jp: "終わった", en: "done." },
    { start: 107.15, end: 108.2, jp: "草刈りが？", en: "The mowing?" },
    { start: 108.2, end: 109.6, jp: "いや、 タスクのほう", en: "No—the task." },
    { start: 109.6, end: 110.5, jp: "草は まだ", en: "The field is still" },
    { start: 110.5, end: 111.95, jp: "半分", en: "HALFWAY." }
  ];
  const active = lines.find((line) => second >= line.start && second < line.end);
  const enter = active
    ? interpolate(second, [active.start, active.start + 0.18], [0, 1], {
        easing: Easing.out(Easing.back(1.8)),
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp"
      })
    : 0;

  return h(
    AbsoluteFill,
    null,
    h("div", {
      style: {
        position: "absolute",
        left: 48,
        top: 36,
        color: ENGINE,
        fontFamily: EN,
        fontSize: 18,
        fontWeight: 900,
        letterSpacing: ".22em"
      },
      children: "HALFWAY HERO"
    }),
    h("div", {
      style: {
        position: "absolute",
        left: 48,
        top: 64,
        background: "rgba(20,19,15,.72)",
        color: CREAM,
        fontFamily: EN,
        fontSize: 28,
        fontWeight: 900,
        letterSpacing: ".04em",
        padding: "8px 16px"
      },
      children: "TASK: COMPLETE  •  FIELD: 50%"
    }),
    active &&
      h(
        "div",
        {
          style: {
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 78,
            textAlign: "center",
            opacity: enter,
            transform: `translateY(${(1 - enter) * 18}px)`
          }
        },
        h("div", {
          style: {
            color: CREAM,
            fontFamily: JP,
            fontSize: active.jp === "半分" ? 92 : 64,
            fontWeight: 950,
            textShadow: "0 4px 18px rgba(0,0,0,.7)"
          },
          children: active.jp
        }),
        h("div", {
          style: {
            marginTop: 6,
            color: ENGINE,
            fontFamily: EN,
            fontSize: 22,
            fontWeight: 800,
            letterSpacing: ".16em"
          },
          children: active.en
        })
      )
  );
}
