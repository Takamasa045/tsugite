import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { activeCaptionAt, emphasizedTextParts, resolveSpeakerImage } from "./presentation.mjs";
import {
  STREET_THEME,
  activeBounce,
  chapterAt,
  envelopeSpeakerImage,
  idleBob,
  popIn,
  stickyVisualAt,
  swapPhase
} from "./streetPresentation.mjs";

const h = React.createElement;
const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif';

function resolveStreetLayout(manifest) {
  const portrait = manifest?.meta?.aspect === "9:16" || manifest?.presentation?.preset?.endsWith("-9x16");
  if (portrait) {
    return {
      portrait: true,
      designW: 1080,
      designH: 1920,
      characterWidth: 500,
      characterBottom: 210,
      characterSidePad: 24,
      titleTop: 56,
      titleLeft: 40,
      titleMaxWidth: 760,
      titleFontSize: 40,
      chapterTop: 250,
      chapterLeft: 48,
      topicTop: 300,
      topicRight: 40,
      topicWidth: 700,
      watermarkFontSize: 120,
      watermarkTop: 820
    };
  }
  return {
    portrait: false,
    designW: 1920,
    designH: 1080,
    characterWidth: 620,
    characterBottom: -26,
    characterSidePad: 30,
    titleTop: 52,
    titleLeft: 52,
    titleMaxWidth: 920,
    titleFontSize: 42,
    chapterTop: 226,
    chapterLeft: 64,
    topicTop: 56,
    topicRight: 56,
    topicWidth: 620,
    watermarkFontSize: 226,
    watermarkTop: 330
  };
}

export function StreetDialogue({ manifest }) {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const layout = resolveStreetLayout(manifest);
  const second = frame / fps;
  const scale = Math.min(width / layout.designW, height / layout.designH);
  const captions = manifest.captions ?? [];
  const caption = activeCaptionAt(captions, second);
  const visual = stickyVisualAt(captions, second);
  const chapter = chapterAt(manifest.chapters, second);
  const speakers = manifest.speakers ?? [];
  const activeSpeaker = speakers.find((speaker) => speaker.id === caption?.speaker);
  const captionLocalFrame = caption ? Math.max(0, frame - Math.round(caption.start * fps)) : 0;
  const progress = Math.min(1, second / manifest.meta.target_duration_seconds);

  return h(
    AbsoluteFill,
    { style: { pointerEvents: "none" } },
    h(
      "div",
      {
        style: {
          position: "absolute",
          width: layout.designW,
          height: layout.designH,
          left: (width - layout.designW * scale) / 2,
          top: (height - layout.designH * scale) / 2,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          fontFamily: FONT,
          color: STREET_THEME.ink
        }
      },
      h(PaperWash),
      h(Watermark, { presentation: manifest.presentation, layout }),
      h(Doodles, { frame, fps, layout }),
      h(TitleTag, { presentation: manifest.presentation, layout, frame, fps }),
      h(ChapterChip, { chapter, layout }),
      h(TopicCard, { visual, second, captions, fps, frame, layout }),
      h(CenterStage, { caption, frame, fps }),
      speakers.map((speaker) =>
        h(Character, {
          key: speaker.id,
          speaker,
          images: manifest.images,
          caption,
          frame,
          fps,
          captionLocalFrame,
          isActive: speaker.id === activeSpeaker?.id,
          mouthFps: resolveMouthFps(manifest),
          layout
        })
      ),
      h(CaptionBar, { caption, speaker: activeSpeaker, localFrame: captionLocalFrame, fps, layout }),
      h(SourceLine, { presentation: manifest.presentation, layout }),
      h(ProgressBar, { progress, layout }),
      manifest.presentation?.draft ? h(DraftChip) : null
    )
  );
}

function PaperWash() {
  return h(
    "div",
    {
      style: {
        position: "absolute",
        inset: 0,
        backgroundColor: "rgba(246, 239, 227, 0.35)",
        backgroundImage: "radial-gradient(rgba(38, 34, 43, 0.09) 2.4px, transparent 2.4px)",
        backgroundSize: "36px 36px"
      }
    }
  );
}

function TitleTag({ presentation, layout, frame, fps }) {
  const lines = Array.isArray(presentation?.title_lines) && presentation.title_lines.length > 0
    ? presentation.title_lines
    : presentation?.title
      ? [presentation.title]
      : null;
  if (!lines) return null;
  const popup = presentation.title_popup ?? presentation.titlePopup;
  const pulse = 1 + 0.05 * Math.sin((frame / fps) * Math.PI * 1.6);
  const bob = idleBob(frame, fps, 1.2);

  return h(
    "div",
    {
      style: {
        position: "absolute",
        top: layout.titleTop,
        left: layout.titleLeft,
        maxWidth: layout.titleMaxWidth,
        transform: "rotate(-3deg)",
        backgroundColor: STREET_THEME.lemon,
        border: `5px solid ${STREET_THEME.ink}`,
        borderRadius: 22,
        boxShadow: `10px 10px 0 ${STREET_THEME.ink}`,
        padding: layout.portrait ? "16px 22px 18px" : "16px 28px 18px",
        zIndex: 8
      }
    },
    h(
      "div",
      { style: { fontSize: layout.portrait ? 18 : 20, fontWeight: 800, letterSpacing: 5 } },
      presentation.label ?? "SEMINAR TALK"
    ),
    h(
      "div",
      {
        style: {
          position: "relative",
          marginTop: 6,
          paddingRight: popup ? 118 : 0
        }
      },
      h(
        "div",
        {
          style: {
            fontSize: layout.titleFontSize,
            fontWeight: 900,
            lineHeight: 1.2,
            whiteSpace: "normal",
            wordBreak: "keep-all",
            overflowWrap: "anywhere"
          }
        },
        lines.map((line, index) =>
          h("div", { key: `${line}-${index}` }, line)
        )
      ),
      popup
        ? h(
            "div",
            {
              style: {
                position: "absolute",
                right: layout.portrait ? -8 : -18,
                top: layout.portrait ? -18 : -22,
                transform: `rotate(8deg) translateY(${bob}px) scale(${pulse})`,
                transformOrigin: "center center",
                backgroundColor: STREET_THEME.accentRight,
                color: STREET_THEME.cream,
                border: `4px solid ${STREET_THEME.ink}`,
                borderRadius: 999,
                boxShadow: `6px 6px 0 ${STREET_THEME.ink}`,
                padding: layout.portrait ? "8px 16px" : "10px 18px",
                fontSize: layout.portrait ? 24 : 28,
                fontWeight: 900,
                whiteSpace: "nowrap",
                zIndex: 9
              }
            },
            popup
          )
        : null
    )
  );
}

function Watermark({ presentation, layout }) {
  return h(
    "div",
    {
      style: {
        position: "absolute",
        top: layout.watermarkTop,
        left: 0,
        width: "100%",
        textAlign: "center",
        fontSize: layout.watermarkFontSize,
        fontWeight: 900,
        letterSpacing: 12,
        color: "rgba(38, 34, 43, 0.045)",
        transform: "rotate(-3deg)",
        whiteSpace: "nowrap"
      }
    },
    presentation?.watermark ?? "PAKU PAKU"
  );
}

function Doodles({ frame, fps, layout }) {
  const doodles = layout.portrait
    ? [
        { key: "sparkle", x: 120, y: 560, phase: 0.8, child: sparklePath(STREET_THEME.accentLeft, 48) },
        { key: "ring", x: 860, y: 620, phase: 2.1, child: ringShape(STREET_THEME.accentRight, 40) },
        { key: "plus", x: 180, y: 700, phase: 4.2, child: plusShape(STREET_THEME.lilac, 34) }
      ]
    : [
        { key: "sparkle", x: 590, y: 330, phase: 0.8, child: sparklePath(STREET_THEME.accentLeft, 54) },
        { key: "ring", x: 1296, y: 316, phase: 2.1, child: ringShape(STREET_THEME.accentRight, 44) },
        { key: "plus", x: 664, y: 244, phase: 4.2, child: plusShape(STREET_THEME.lilac, 36) }
      ];
  return doodles.map((doodle) =>
    h(
      "div",
      {
        key: doodle.key,
        style: {
          position: "absolute",
          left: doodle.x,
          top: doodle.y,
          transform: `translateY(${idleBob(frame, fps, doodle.phase)}px)`,
          opacity: 0.55
        }
      },
      doodle.child
    )
  );
}

function CenterStage({ caption, frame, fps }) {
  const center = caption?.center;
  if (!center) return null;
  const localFrame = Math.max(0, frame - Math.round(caption.start * fps));
  const span = Math.max(0.01, caption.end - caption.start);
  const progress = Math.min(1, Math.max(0, (frame / fps - caption.start) / span));
  if (center.type === "desk") {
    return h(DeskScene, { center, localFrame, fps, frame, progress });
  }
  if (center.type === "telop") {
    return h(Telop, { center, localFrame, fps, frame });
  }
  return null;
}

function centerAccent(center) {
  return STREET_THEME[center.accent] ?? center.accent ?? STREET_THEME.lemon;
}

function Telop({ center, localFrame, fps, frame }) {
  const pop = popIn(localFrame, fps, 0.4);
  return h(
    "div",
    {
      style: {
        position: "absolute",
        top: 452,
        left: "50%",
        transform: `translateX(-50%) translateY(${idleBob(frame, fps, 2.6)}px) scale(${pop}) rotate(-2deg)`,
        transformOrigin: "center",
        textAlign: "center"
      }
    },
    center.sub
      ? h(
          "div",
          {
            style: {
              display: "inline-block",
              backgroundColor: STREET_THEME.ink,
              color: STREET_THEME.cream,
              borderRadius: 999,
              padding: "6px 24px",
              fontSize: 27,
              fontWeight: 800,
              marginBottom: 14
            }
          },
          center.sub
        )
      : null,
    h(
      "div",
      {
        style: {
          backgroundColor: STREET_THEME.cream,
          border: `6px solid ${STREET_THEME.ink}`,
          borderRadius: 24,
          boxShadow: `12px 12px 0 ${centerAccent(center)}`,
          padding: "20px 40px",
          fontSize: 56,
          fontWeight: 900,
          whiteSpace: "nowrap"
        }
      },
      center.text
    )
  );
}

function DeskScene({ center, localFrame, fps, frame, progress }) {
  const items = center.items ?? [];
  return h(
    "div",
    {
      style: {
        position: "absolute",
        top: 380,
        left: "50%",
        transform: "translateX(-50%)",
        width: 660,
        height: 430
      }
    },
    center.note
      ? h(
          "div",
          {
            style: {
              position: "absolute",
              top: 0,
              left: "50%",
              transform: `translateX(-50%) rotate(2deg) scale(${popIn(localFrame, fps, 0.4)})`,
              backgroundColor: STREET_THEME.lemon,
              border: `4px solid ${STREET_THEME.ink}`,
              borderRadius: 999,
              padding: "8px 28px",
              fontSize: 30,
              fontWeight: 900,
              whiteSpace: "nowrap"
            }
          },
          center.note
        )
      : null,
    h(
      "div",
      {
        style: {
          position: "absolute",
          bottom: 124,
          width: "100%",
          display: "flex",
          justifyContent: "center",
          gap: 18,
          alignItems: "flex-end"
        }
      },
      items.map((label, index) =>
        h(DeskCard, {
          key: `${label}-${index}`,
          label,
          index,
          localFrame,
          fps,
          frame,
          progress,
          swap: index === 0 ? center.swap : undefined,
          tone: center.tone
        })
      )
    ),
    h("div", {
      style: {
        position: "absolute",
        bottom: 88,
        left: 24,
        right: 24,
        height: 36,
        backgroundColor: "#dfa86a",
        border: `5px solid ${STREET_THEME.ink}`,
        borderRadius: 12,
        boxShadow: "8px 8px 0 rgba(38, 34, 43, 0.75)"
      }
    }),
    h("div", {
      style: {
        position: "absolute",
        bottom: 18,
        left: 96,
        width: 20,
        height: 74,
        backgroundColor: "#b9854e",
        border: `4px solid ${STREET_THEME.ink}`,
        borderRadius: 6
      }
    }),
    h("div", {
      style: {
        position: "absolute",
        bottom: 18,
        right: 96,
        width: 20,
        height: 74,
        backgroundColor: "#b9854e",
        border: `4px solid ${STREET_THEME.ink}`,
        borderRadius: 6
      }
    })
  );
}

function DeskCard({ label, index, localFrame, fps, frame, progress, swap, tone }) {
  const pop = popIn(Math.max(0, localFrame - index * 5), fps, 0.4);
  let text = label;
  let flipScale = 1;
  if (swap) {
    const phase = swapPhase(progress, swap.from, swap.to);
    text = phase.label;
    flipScale = Math.max(0.06, phase.scaleX);
  }
  const alert = tone === "alert" || text.startsWith("⚠");
  return h(
    "div",
    {
      style: {
        backgroundColor: alert ? "#ffe3df" : STREET_THEME.cream,
        border: `5px solid ${STREET_THEME.ink}`,
        borderRadius: 16,
        boxShadow: `7px 7px 0 ${alert ? STREET_THEME.alert : STREET_THEME.lilac}`,
        padding: "12px 26px",
        fontSize: 40,
        fontWeight: 900,
        whiteSpace: "nowrap",
        transform: [
          `translateY(${idleBob(frame, fps, index * 1.7) * 0.6}px)`,
          `rotate(${index % 2 === 0 ? -2.5 : 2.5}deg)`,
          `scale(${pop})`,
          `scaleX(${flipScale})`
        ].join(" ")
      }
    },
    text
  );
}

function sparklePath(color, size) {
  return h(
    "svg",
    { width: size, height: size, viewBox: "0 0 100 100" },
    h("path", {
      d: "M50 0 C56 32 68 44 100 50 C68 56 56 68 50 100 C44 68 32 56 0 50 C32 44 44 32 50 0 Z",
      fill: color
    })
  );
}

function ringShape(color, size) {
  return h(
    "svg",
    { width: size, height: size, viewBox: "0 0 100 100" },
    h("circle", { cx: 50, cy: 50, r: 36, fill: "none", stroke: color, strokeWidth: 18 })
  );
}

function plusShape(color, size) {
  return h(
    "svg",
    { width: size, height: size, viewBox: "0 0 100 100" },
    h("path", { d: "M40 8 h20 v32 h32 v20 h-32 v32 h-20 v-32 H8 v-20 h32 Z", fill: color })
  );
}

function ChapterChip({ chapter, layout }) {
  if (!chapter) return null;
  return h(
    "div",
    {
      style: {
        position: "absolute",
        top: layout.chapterTop,
        left: layout.chapterLeft,
        transform: "rotate(-2deg)",
        backgroundColor: STREET_THEME.ink,
        color: STREET_THEME.cream,
        borderRadius: 999,
        padding: "10px 26px",
        fontSize: layout.portrait ? 24 : 26,
        fontWeight: 800
      }
    },
    `▶ ${chapter.title}`
  );
}

function TopicCard({ visual, second, captions, fps, frame, layout }) {
  if (!visual) return null;
  const carrier = captions.find((caption) => caption.visual === visual);
  const localFrame = carrier ? Math.max(0, frame - Math.round(carrier.start * fps)) : fps;
  const scale = 0.85 + 0.15 * popIn(localFrame, fps);
  return h(
    "div",
    {
      style: {
        position: "absolute",
        top: layout.topicTop,
        right: layout.topicRight,
        width: layout.topicWidth,
        transform: `rotate(2deg) scale(${scale})`,
        transformOrigin: "top right",
        backgroundColor: STREET_THEME.cream,
        border: `5px solid ${STREET_THEME.ink}`,
        borderRadius: 18,
        boxShadow: `10px 10px 0 rgba(38, 34, 43, 0.85)`,
        padding: layout.portrait ? "18px 22px" : "22px 28px"
      }
    },
    h(Tape, { left: -18, rotate: -32 }),
    h(Tape, { right: -18, rotate: 28 }),
    visual.kicker
      ? h(
          "div",
          {
            style: {
              display: "inline-block",
              backgroundColor: STREET_THEME.lilac,
              border: `3px solid ${STREET_THEME.ink}`,
              borderRadius: 999,
              padding: "4px 16px",
              fontSize: 20,
              fontWeight: 900,
              letterSpacing: 3,
              marginBottom: 12
            }
          },
          visual.kicker
        )
      : null,
    h("div", { style: { fontSize: 44, fontWeight: 900, lineHeight: 1.3 } }, visual.headline),
    visual.detail
      ? h(
          "div",
          { style: { fontSize: 27, lineHeight: 1.45, marginTop: 10, color: "rgba(38, 34, 43, 0.78)" } },
          visual.detail
        )
      : null,
    (visual.badges ?? []).length > 0
      ? h(
          "div",
          { style: { display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" } },
          visual.badges.map((badge) =>
            h(
              "span",
              {
                key: badge,
                style: {
                  border: `3px solid ${STREET_THEME.ink}`,
                  borderRadius: 999,
                  padding: "3px 14px",
                  fontSize: 19,
                  fontWeight: 800,
                  backgroundColor: STREET_THEME.paper
                }
              },
              `#${badge}`
            )
          )
        )
      : null
  );
}

function Tape({ left, right, rotate }) {
  return h("div", {
    style: {
      position: "absolute",
      top: -16,
      left,
      right,
      width: 96,
      height: 30,
      transform: `rotate(${rotate}deg)`,
      backgroundColor: "rgba(201, 184, 244, 0.85)",
      border: "2px solid rgba(38, 34, 43, 0.25)"
    }
  });
}

function resolveMouthFps(manifest) {
  const raw = manifest?.presentation?.mouth_fps ?? manifest?.presentation?.mouthFps;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 8;
  // Keep flips calm enough for full-body gesture plates.
  return Math.min(12, Math.max(1, value));
}

function Character({ speaker, images, caption, frame, fps, captionLocalFrame, isActive, mouthFps = 8, layout }) {
  const image =
    envelopeSpeakerImage(speaker, caption, images, frame, fps, isActive) ??
    resolveSpeakerImage(speaker, caption, images, frame, fps, mouthFps);
  if (!image) return null;
  // Fully transparent placeholder cast stays hidden.
  if (image.alpha_required && /void/i.test(String(image.id ?? image.src ?? ""))) return null;
  const pad = layout?.characterSidePad ?? 30;
  const sideStyle = speaker.side === "left" ? { left: pad } : { right: pad };
  const phase = speaker.side === "left" ? 0 : Math.PI;
  const lift = isActive ? activeBounce(captionLocalFrame, fps) : idleBob(frame, fps, phase);
  const pop = isActive ? popIn(captionLocalFrame, fps) : 0;
  const characterScale = isActive ? 0.97 + 0.05 * pop : 0.95;
  const tilt = speaker.side === "left" ? -1.5 : 1.5;

  return h(
    "div",
    {
      style: {
        position: "absolute",
        bottom: layout?.characterBottom ?? -26,
        width: layout?.characterWidth ?? 620,
        ...sideStyle
      }
    },
    isActive ? h(SprayBlob, { color: speaker.accent, pop }) : null,
    h(Img, {
      src: staticFile(image.src),
      style: {
        position: "relative",
        width: "100%",
        transform: `translateY(${-lift}px) rotate(${isActive ? 0 : tilt}deg) scale(${characterScale})`,
        transformOrigin: "bottom center",
        filter: isActive ? "none" : "saturate(0.82)",
        opacity: isActive ? 1 : 0.92
      }
    })
  );
}

function SprayBlob({ color, pop }) {
  return h(
    "svg",
    {
      viewBox: "0 0 200 200",
      style: {
        position: "absolute",
        width: 830,
        left: -105,
        bottom: -55,
        opacity: 0.4 * pop,
        transform: `scale(${0.7 + 0.3 * pop})`,
        transformOrigin: "center bottom"
      }
    },
    h("path", {
      d: "M100 18 C140 10 178 42 182 84 C186 122 162 158 122 172 C86 184 40 172 22 138 C6 106 16 60 48 38 C64 27 80 22 100 18 Z",
      fill: color
    }),
    h("circle", { cx: 178, cy: 40, r: 9, fill: color }),
    h("circle", { cx: 16, cy: 68, r: 6, fill: color }),
    h("circle", { cx: 190, cy: 120, r: 5, fill: color })
  );
}

function CaptionBar({ caption, speaker, localFrame, fps, layout }) {
  if (!caption || !speaker) return null;
  const pop = popIn(localFrame, fps);
  const parts = emphasizedTextParts(caption.text, caption.emphasis ?? []);
  const portrait = layout?.portrait;
  return h(
    "div",
    {
      style: {
        position: "absolute",
        bottom: portrait ? 48 : 56,
        left: "50%",
        width: portrait ? 960 : 980,
        maxWidth: portrait ? "92%" : undefined,
        transform: `translateX(-50%) scale(${0.9 + 0.1 * pop})`,
        transformOrigin: "bottom center",
        backgroundColor: STREET_THEME.cream,
        border: `5px solid ${STREET_THEME.ink}`,
        borderRadius: 26,
        boxShadow: `12px 12px 0 ${speaker.accent}`,
        padding: portrait ? "26px 28px 22px" : "30px 38px 26px"
      }
    },
    h(
      "div",
      {
        style: {
          position: "absolute",
          top: -28,
          left: 30,
          backgroundColor: speaker.accent,
          color: STREET_THEME.ink,
          border: `4px solid ${STREET_THEME.ink}`,
          borderRadius: 999,
          padding: "5px 24px",
          fontSize: 27,
          fontWeight: 900
        }
      },
      speaker.display_name
    ),
    h(
      "div",
      { style: { fontSize: 41, fontWeight: 700, lineHeight: 1.5, textAlign: "left" } },
      parts.map((part, index) =>
        part.emphasized
          ? h(
              "span",
              {
                key: `${part.text}-${index}`,
                style: {
                  fontWeight: 900,
                  backgroundColor: `${speaker.accent}59`,
                  borderRadius: 8,
                  padding: "0 6px"
                }
              },
              part.text
            )
          : h("span", { key: `${part.text}-${index}` }, part.text)
      )
    )
  );
}

function SourceLine({ presentation }) {
  if (!presentation?.source_title) return null;
  return h(
    "div",
    {
      style: {
        position: "absolute",
        bottom: 22,
        left: "50%",
        transform: "translateX(-50%)",
        fontSize: 20,
        fontWeight: 600,
        color: "rgba(38, 34, 43, 0.6)"
      }
    },
    `出典: ${presentation.source_title}`
  );
}

function ProgressBar({ progress }) {
  return h(
    "div",
    {
      style: {
        position: "absolute",
        bottom: 0,
        left: 0,
        width: `${progress * 100}%`,
        height: 12,
        background: `linear-gradient(90deg, ${STREET_THEME.accentLeft}, ${STREET_THEME.accentRight})`
      }
    }
  );
}

function DraftChip() {
  return h(
    "div",
    {
      style: {
        position: "absolute",
        top: 20,
        left: "50%",
        transform: "translateX(-50%)",
        backgroundColor: "rgba(38, 34, 43, 0.72)",
        color: STREET_THEME.cream,
        borderRadius: 999,
        padding: "6px 20px",
        fontSize: 21,
        fontWeight: 800,
        letterSpacing: 2
      }
    },
    "DRAFT — 無音プレビュー"
  );
}
