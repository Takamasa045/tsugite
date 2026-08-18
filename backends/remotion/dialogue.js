import React from "react";
import { AbsoluteFill, CanvasImage, Easing, Interactive, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import {
  activeCaptionAt,
  designScale,
  emphasizedTextParts,
  resolveArticleDialogueTheme,
  resolveCharacterFrame,
  resolveSpeakerImage
} from "./presentation.mjs";

export function ArticleDialogue({ manifest }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const fps = manifest.meta.fps;
  const second = frame / fps;
  const active = activeCaptionAt(manifest.captions, second);
  const speakers = manifest.speakers ?? [];
  const presentation = manifest.presentation ?? {};
  const scale = designScale(width, height);
  const left = (width - 1920 * scale) / 2;
  const top = (height - 1080 * scale) / 2;
  const stickyVisual = stickyVisualAt(manifest.captions, second);
  const theme = resolveArticleDialogueTheme(manifest);

  return React.createElement(
    AbsoluteFill,
    {
      style: {
        background: theme.background,
        color: theme.ink,
        fontFamily: theme.bodyFontFamily,
        overflow: "hidden"
      }
    },
    React.createElement(
      "div",
      {
        style: {
          position: "absolute",
          left,
          top,
          width: 1920,
          height: 1080,
          overflow: "hidden",
          scale,
          transformOrigin: "top left"
        }
      },
      React.createElement(Header, { presentation, theme }),
      React.createElement(CenterVisual, {
        active,
        visual: stickyVisual,
        images: manifest.images ?? [],
        frame,
        fps,
        second,
        theme
      }),
      ...speakers.map((speaker) =>
        React.createElement(Character, {
          key: speaker.id,
          speaker,
          image: resolveSpeakerImage(speaker, active, manifest.images, frame, fps, 4),
          active: active?.speaker === speaker.id,
          frame,
          fps,
          theme
        })
      ),
      React.createElement(DialogueCaption, { active, speakers, frame, fps, theme })
    )
  );
}

function Header({ presentation, theme }) {
  return React.createElement(
    Interactive.Div,
    {
      name: "Header",
      style: {
        position: "absolute",
        top: 36,
        left: 56,
        right: 56,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 24,
        zIndex: 5
      }
    },
    React.createElement(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 } },
      React.createElement(
        "div",
        { style: { fontSize: 20, fontWeight: 800, letterSpacing: "0.14em", color: theme.label } },
        presentation.label ?? "ARTICLE DIALOGUE"
      ),
      React.createElement(
        "div",
        {
          style: {
            maxWidth: 1280,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 30,
            fontWeight: 800
          }
        },
        presentation.title ?? presentation.source_title ?? "60秒で記事を紹介"
      )
    ),
    presentation.draft
      ? React.createElement(
          "div",
          {
            style: {
              flex: "0 0 auto",
              border: `2px solid ${theme.draftBorder}`,
              borderRadius: 999,
              color: theme.draftInk,
              fontSize: 20,
              fontWeight: 800,
              padding: "8px 16px",
              backgroundColor: theme.draftBackground
            }
          },
          "SILENT DRAFT"
        )
      : null
  );
}

function CenterVisual({ active, visual, images, frame, fps, second, theme }) {
  if (!visual) return null;
  const localFrame = Math.max(0, frame - Math.round((active?.start ?? visual._start ?? 0) * fps));
  const image = visual.image_id ? images.find((entry) => entry.id === visual.image_id) : undefined;
  const enter = softEnter(localFrame, fps);
  const steps = Array.isArray(visual.steps) ? visual.steps : [];
  const stepReveal = Math.max(0, Math.floor((localFrame / fps - 0.35) / 0.7));

  return React.createElement(
    "div",
    {
      style: {
        position: "absolute",
        top: 96,
        left: 120,
        right: 120,
        bottom: 300,
        display: "grid",
        gridTemplateColumns: image ? "1.15fr 0.85fr" : "1fr",
        gap: 28,
        padding: 28,
        borderRadius: theme.cardRadius,
        border: theme.cardBorder,
        // Gradients (Claude theme) must use `background`, not backgroundColor.
        background: theme.cardBackground,
        boxShadow: theme.cardShadow,
        opacity: enter.opacity,
        translate: `0px ${enter.y}px`,
        scale: enter.scale,
        overflow: "hidden"
      }
    },
    image
      ? React.createElement(
          "div",
          {
            style: {
              position: "relative",
              borderRadius: Math.max(8, theme.cardRadius - 8),
              overflow: "hidden",
              backgroundColor: theme.imagePlaceholder,
              minHeight: 0
            }
          },
          React.createElement(CanvasImage, {
            src: staticFile(image.src),
            alt: image.alt ?? visual.headline ?? "visual",
            style: {
              width: "100%",
              height: "100%",
              objectFit: "cover",
              scale: interpolate(localFrame, [0, fps * 8], [1.04, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.out(Easing.cubic),
                output: "perceptual-scale"
              })
            }
          }),
          visual.kicker
            ? React.createElement(
                "div",
                {
                  style: {
                    position: "absolute",
                    top: 18,
                    left: 18,
                    borderRadius: theme.badgeRadius,
                    backgroundColor: theme.kickerBackground,
                    color: theme.kicker,
                    fontSize: 22,
                    fontWeight: 900,
                    letterSpacing: "0.12em",
                    padding: "8px 14px"
                  }
                },
                visual.kicker
              )
            : null
        )
      : null,
    React.createElement(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 18,
          minWidth: 0,
          padding: image ? "8px 8px 8px 4px" : "24px 36px",
          textAlign: image ? "left" : "center",
          alignItems: image ? "flex-start" : "center"
        }
      },
      !image && visual.kicker
        ? React.createElement(
            "div",
            { style: { color: theme.kicker, fontSize: 24, fontWeight: 900, letterSpacing: "0.14em" } },
            visual.kicker
          )
        : null,
      React.createElement(
        "div",
        {
          style: {
            maxWidth: image ? 560 : 900,
            fontSize: image ? 48 : 64,
            lineHeight: 1.18,
            // Display face is scoped to this element; dialogue captions stay on the body sans.
            fontFamily: theme.headlineFontFamily,
            fontWeight: theme.headlineWeight,
            letterSpacing: theme.headlineLetterSpacing,
            whiteSpace: "pre-line"
          }
        },
        visual.headline
      ),
      visual.detail
        ? React.createElement(
            "div",
            {
              style: {
                maxWidth: image ? 520 : 820,
                color: theme.detail,
                fontSize: image ? 28 : 34,
                lineHeight: 1.45,
                fontWeight: 650,
                // Japanese wraps mid-phrase and strands single characters; authored breaks win.
                whiteSpace: "pre-line"
              }
            },
            visual.detail
          )
        : null,
      steps.length
        ? React.createElement(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 10, width: "100%", marginTop: 4 } },
            ...steps.map((step, index) => {
              const visible = index <= stepReveal;
              const progress = visible
                ? interpolate(localFrame - Math.round((0.35 + index * 0.7) * fps), [0, Math.round(0.45 * fps)], [0, 1], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                    easing: Easing.out(Easing.cubic)
                  })
                : 0;
              return React.createElement(
                "div",
                {
                  key: `${index}-${step}`,
                  style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    opacity: progress,
                    translate: `${(1 - progress) * 18}px 0px`
                  }
                },
                React.createElement(
                  "div",
                  {
                    style: {
                      width: 34,
                      height: 34,
                      borderRadius: 999,
                      backgroundColor: index <= stepReveal ? theme.stepActive : theme.stepIdle,
                      color: "white",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 18,
                      fontWeight: 900,
                      flex: "0 0 auto"
                    }
                  },
                  String(index + 1)
                ),
                React.createElement(
                  "div",
                  {
                    style: {
                      flex: 1,
                      borderRadius: Math.max(8, theme.cardRadius - 20),
                      backgroundColor: theme.stepBackground,
                      color: theme.stepInk,
                      fontSize: 26,
                      fontWeight: 750,
                      padding: "12px 16px"
                    }
                  },
                  step
                )
              );
            })
          )
        : null,
      visual.badges?.length
        ? React.createElement(
            "div",
            {
              style: {
                display: "flex",
                flexWrap: "wrap",
                justifyContent: image ? "flex-start" : "center",
                gap: 10,
                marginTop: 4
              }
            },
            ...visual.badges.map((badge, index) => {
              const progress = interpolate(localFrame - index * 6, [0, 14], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.out(Easing.cubic)
              });
              return React.createElement(
                "div",
                {
                  key: badge,
                  style: {
                    borderRadius: theme.badgeRadius,
                    backgroundColor: theme.badgeBackground,
                    color: theme.badgeInk,
                    fontSize: 24,
                    fontWeight: 800,
                    padding: "10px 16px",
                    opacity: progress,
                    translate: `0px ${(1 - progress) * 10}px`
                  }
                },
                badge
              );
            })
          )
        : null,
      React.createElement(
        "div",
        {
          style: {
            position: "absolute",
            left: 28,
            right: 28,
            bottom: 18,
            height: 6,
            borderRadius: 999,
            backgroundColor: theme.progressTrack,
            overflow: "hidden"
          }
        },
        React.createElement("div", {
          style: {
            width: `${Math.min(100, Math.max(8, ((second - (active?.start ?? 0)) / Math.max(0.001, (active?.end ?? second + 1) - (active?.start ?? 0))) * 100))}%`,
            height: "100%",
            borderRadius: 999,
            background: theme.progress,
            transition: "none"
          }
        })
      )
    )
  );
}

function Character({ speaker, image, active, frame, fps, theme }) {
  // Soft idle sway (~2.4s) instead of fast bounce
  const bob = Math.sin((frame / fps) * Math.PI * 0.85) * (active ? 3.5 : 2);
  const cutout = resolveCharacterFrame(image) === "cutout";
  const activeScale = active
    ? interpolate(Math.sin((frame / fps) * Math.PI * 0.6), [-1, 1], [1.0, 1.02])
    : 0.94;

  return React.createElement(
    "div",
    {
      style: {
        position: "absolute",
        bottom: 118,
        width: cutout ? 300 : 280,
        height: cutout ? 400 : 300,
        [speaker.side]: 48,
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        alignItems: "center",
        gap: 10,
        opacity: active ? 1 : 0.72,
        translate: `0px ${Math.round(bob + (active ? 0 : 8))}px`,
        scale: activeScale,
        transformOrigin: "bottom center",
        zIndex: active ? 4 : 3
      }
    },
    React.createElement(
      "div",
      {
        style: {
          width: cutout ? "100%" : 230,
          height: cutout ? 330 : 230,
          overflow: "hidden",
          borderRadius: cutout ? 0 : theme.characterRadius,
          border: cutout ? "none" : `6px solid ${speaker.accent}`,
          backgroundColor: cutout ? "transparent" : theme.characterBackground,
          boxShadow:
            cutout || theme.cardShadow === "none"
              ? "none"
              : active
                ? `0 16px 36px ${speaker.accent}38`
                : "0 12px 28px rgba(55,45,35,0.14)"
        }
      },
      image
        ? React.createElement(CanvasImage, {
            src: staticFile(image.src),
            alt: image.alt ?? speaker.display_name,
            style: {
              width: "100%",
              height: "100%",
              // Cutouts must stay whole; face closeups fill the circle.
              objectFit: cutout ? "contain" : "cover",
              objectPosition: cutout ? "center bottom" : speaker.id === "itopan" ? "center 30%" : "center 20%",
              scale: !cutout && speaker.id === "itopan" ? 1.06 : 1,
              transformOrigin: "center 32%"
            }
          })
        : React.createElement("div", { style: { width: "100%", height: "100%", backgroundColor: theme.imagePlaceholder } })
    ),
    React.createElement(
      "div",
      {
        style: {
          minWidth: 120,
          borderRadius: 999,
          backgroundColor: active ? speaker.accent : theme.nameIdle,
          color: "white",
          fontSize: 24,
          fontWeight: 900,
          padding: "8px 16px",
          textAlign: "center",
          boxShadow: theme.cardShadow === "none" ? "none" : "0 8px 20px rgba(55,45,35,0.14)"
        }
      },
      speaker.display_name
    )
  );
}

function DialogueCaption({ active, speakers, frame, fps, theme }) {
  if (!active) return null;
  const speaker = speakers.find((candidate) => candidate.id === active.speaker);
  const parts = emphasizedTextParts(active.text, active.emphasis);
  const localFrame = Math.max(0, frame - Math.round(active.start * fps));
  const enter = softEnter(localFrame, fps, 0.28);

  return React.createElement(
    Interactive.Div,
    {
      name: "Caption",
      style: {
        position: "absolute",
        left: 360,
        right: 360,
        bottom: 28,
        minHeight: 96,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
        borderRadius: theme.captionRadius,
        border: `3px solid ${speaker?.accent ?? "#3f3a35"}`,
        backgroundColor: theme.captionBackground,
        boxShadow: theme.captionShadow,
        color: theme.captionInk,
        padding: "18px 28px",
        textAlign: "center",
        opacity: enter.opacity,
        translate: `0px ${enter.y * 0.6}px`,
        zIndex: 6
      }
    },
    React.createElement(
      "div",
      {
        style: {
          display: "-webkit-box",
          WebkitBoxOrient: "vertical",
          WebkitLineClamp: 2,
          overflow: "hidden",
          fontSize: 40,
          lineHeight: 1.35,
          fontWeight: 800,
          letterSpacing: "-0.02em"
        }
      },
      ...parts.map((part, index) =>
        React.createElement(
          "span",
          {
            key: `${index}-${part.text}`,
            style: {
              color: part.emphasized
                ? theme.captionEmphasis ?? speaker?.accent ?? "#f4b45f"
                : theme.captionInk
            }
          },
          part.text
        )
      )
    )
  );
}

function softEnter(localFrame, fps, seconds = 0.4) {
  const end = Math.max(1, Math.round(seconds * fps));
  const t = interpolate(localFrame, [0, end], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.22, 1, 0.36, 1)
  });
  return {
    opacity: t,
    scale: 0.97 + t * 0.03,
    y: (1 - t) * 16
  };
}

/** Hold the last visual that defined content so image demos don't flash away mid-answer. */
export function stickyVisualAt(captions, second) {
  let current;
  for (const caption of captions ?? []) {
    if (second < caption.start) break;
    if (caption.visual?.headline || caption.visual?.image_id || caption.visual?.steps?.length) {
      current = { ...caption.visual, _start: caption.start };
    }
    if (second >= caption.start && second < caption.end && caption.visual) {
      current = { ...caption.visual, _start: caption.start };
    }
  }
  return current;
}
