import React from "react";
import { AbsoluteFill, Easing, continueRender, delayRender, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { useWindowedAudioData, visualizeAudio } from "@remotion/media-utils";
import { totalDuration } from "./timing.mjs";
import { NATURE_VIBE_REGGAE_FONT_PATH } from "./natureVibeAssets.mjs";

export const NATURE_VIBE_VISUALIZER_PRESET = "nature-vibe-visualizer-9x16";

const h = React.createElement;
const FONT = '"Hiragino Sans", "Yu Gothic", "Noto Sans JP", sans-serif';
const GOLD = "#f6b63d";
const CREAM = "#fff4df";
const REGGAE_FONT_FAMILY = "NatureVibeReggae";
const LYRIC_SCRIM = Object.freeze({
  top: 760,
  bottom: 300,
  background: "linear-gradient(180deg, rgba(5,9,16,0) 0%, rgba(5,9,16,0.18) 16%, rgba(5,9,16,0.78) 42%, rgba(5,9,16,0.88) 70%, rgba(5,9,16,0) 100%)"
});

export function NatureVibeVisualizer({ manifest }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const second = frame / fps;
  const lyricScrim = resolveLyricScrim();
  const finalFade = resolveFinalFadeOpacity({ second, duration: resolveVisualizerDuration(manifest), fadeSeconds: 3 });
  const caption = (manifest.captions ?? []).find((entry) => second >= entry.start && second < entry.end);
  const lyricText = caption?.visual?.headline ?? caption?.text ?? "";
  const audioTrack = manifest.audio?.bgm?.[0];
  const audioFrame = audioTrack
    ? resolveAudioVisualizationFrame({ frame, fps, start: audioTrack.start ?? 0, end: audioTrack.end })
    : undefined;
  const bass = 0;
  const localFrame = Math.max(0, frame - Math.round((caption?.start ?? 0) * fps));
  const captionDuration = Math.max(1, Math.round(((caption?.end ?? second + 1) - (caption?.start ?? second)) * fps));
  const entrance = interpolate(localFrame, [0, Math.min(12, captionDuration)], [0, 1], {
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic)
  });
  const exit = interpolate(localFrame, [Math.max(0, captionDuration - 8), captionDuration], [1, 0], {
    extrapolateLeft: "clamp",
    easing: Easing.in(Easing.cubic)
  });
  const textOpacity = Math.min(entrance, exit);

  return h(
    AbsoluteFill,
    { style: { color: CREAM, fontFamily: FONT, overflow: "hidden", pointerEvents: "none", opacity: finalFade } },
    h(ReggaeFont),
    h("div", { style: { position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(4,9,23,0.14), rgba(4,9,23,0.28) 45%, rgba(4,9,23,0.82))" } }),
    h("div", { style: { position: "absolute", inset: 0, background: "radial-gradient(circle at 50% 53%, rgba(246,182,61,0.06), transparent 34%)" } }),
    h("div", { style: { position: "absolute", left: 0, right: 0, top: lyricScrim.top, bottom: lyricScrim.bottom, background: lyricScrim.background } }),
    h(LeafField),
    caption
      ? h(
          "div",
          {
            style: {
              position: "absolute", left: 84, right: 84, top: 900, bottom: 540,
              display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", textAlign: "center",
              opacity: textOpacity, translate: `0 ${interpolate(entrance, [0, 1], [28, 0])}px`, scale: 0.985 + entrance * 0.015
            }
          },
          h(ReggaeLyric, { text: lyricText })
        )
      : null,
    audioTrack?.src && audioFrame !== undefined
      ? h(AudioSpectrum, { audioSrc: audioTrack.src, frame: audioFrame })
      : h(Spectrum, { frequencies: [], bass: 0 })
  );
}

function Spectrum({ frequencies, bass }) {
  const samples = frequencies.length ? frequencies.slice(0, 36) : Array.from({ length: 36 }, () => 0.05);
  return h("div", { style: { position: "absolute", left: 84, right: 84, bottom: 146, height: 150, display: "flex", alignItems: "flex-end", gap: 7, opacity: 0.78 } },
    ...samples.map((value, index) => h("div", { key: index, style: { flex: 1, minHeight: 8, height: `${Math.min(100, 8 + Math.pow(value, 0.55) * 92 + bass * 18)}%`, borderRadius: 999, background: `linear-gradient(180deg, ${CREAM}, ${GOLD})`, boxShadow: `0 0 ${8 + bass * 22}px rgba(246,182,61,0.58)` } }))
  );
}

function AudioSpectrum({ audioSrc, frame }) {
  const { fps } = useVideoConfig();
  const { audioData, dataOffsetInSeconds } = useWindowedAudioData({
    src: staticFile(audioSrc),
    frame,
    fps,
    windowInSeconds: 30
  });
  const frequencies = audioData
    ? visualizeAudio({ fps, frame, audioData, dataOffsetInSeconds, numberOfSamples: 64, optimizeFor: "speed" })
    : [];
  const bass = frequencies.length ? frequencies.slice(0, 12).reduce((sum, value) => sum + value, 0) / 12 : 0;
  return h(Spectrum, { frequencies, bass });
}

export function resolveAudioVisualizationFrame({ frame, fps, start = 0, end }) {
  const startFrame = Math.round(start * fps);
  const endFrame = end === undefined ? undefined : startFrame + Math.max(1, Math.round(Math.max(0.01, end - start) * fps));
  if (frame < startFrame || (endFrame !== undefined && frame >= endFrame)) return undefined;
  return frame - startFrame;
}

export function resolveFinalFadeOpacity({ second, duration, fadeSeconds }) {
  const fadeStart = Math.max(0, duration - fadeSeconds);
  if (second <= fadeStart) return 1;
  if (second >= duration) return 0;
  return 1 - (second - fadeStart) / Math.max(0.001, fadeSeconds);
}

export function resolveVisualizerDuration(manifest) {
  return totalDuration(manifest);
}

export function resolveLyricScrim() {
  return LYRIC_SCRIM;
}

export function resolveReggaeLyricStyle({ text }) {
  return {
    fontFamily: `"${REGGAE_FONT_FAMILY}", "Hiragino Maru Gothic ProN", "Yu Gothic", sans-serif`,
    fontSize: text.length > 18 ? 80 : 100,
    fontWeight: 400,
    lineHeight: 1.1,
    letterSpacing: "0.01em",
    wordBreak: "break-all",
    color: "#fff1c8",
    textShadow: "0 14px 34px rgba(0,0,0,0.78)"
  };
}

export function resolveReggaeGlyphStyle({ index, lineIndex }) {
  const bounce = [-4, 1, 4, -1, 3, -3, 2, 0][index % 8] + lineIndex * 2;
  const tilt = [-2.4, 1.2, -0.8, 2, -1.5, 1.8, -1, 0.7][index % 8];
  return {
    display: "inline-block",
    transform: `translateY(${bounce}px) rotate(${tilt}deg)`,
    marginInline: index % 4 === 0 ? "0.018em" : "0",
    WebkitTextStroke: "2.4px #efb134",
    paintOrder: "stroke fill",
    textShadow: "3px 4px 0 #8c351c, 0 10px 18px rgba(0,0,0,0.64)"
  };
}

function ReggaeFont() {
  const [handle] = React.useState(() => delayRender("Loading Reggae One lyric font"));

  React.useEffect(() => {
    const font = new FontFace(REGGAE_FONT_FAMILY, `url(${staticFile(NATURE_VIBE_REGGAE_FONT_PATH)})`);
    font.load()
      .then((loaded) => document.fonts.add(loaded))
      .catch(() => undefined)
      .finally(() => continueRender(handle));
  }, [handle]);

  return null;
}

function ReggaeLyric({ text }) {
  const style = resolveReggaeLyricStyle({ text });
  return h(
    "div",
    { style },
    ...text.split("\n").map((line, lineIndex) => h(
      "div",
      { key: `${lineIndex}-${line}`, style: { minHeight: "1.1em" } },
      ...Array.from(line).map((glyph, index) => h(
        "span",
        { key: `${index}-${glyph}`, style: resolveReggaeGlyphStyle({ index, lineIndex }) },
        glyph === " " ? "\u00a0" : glyph
      ))
    ))
  );
}

function LeafField() {
  return h("div", { style: { position: "absolute", inset: 0 } },
    ...Array.from({ length: 18 }, (_, index) => {
      const progress = (index * 0.071) % 1;
      return h("div", { key: index, style: { position: "absolute", left: `${(index * 37 + 11) % 102}%`, top: `${-8 + progress * 115}%`, width: 13 + (index % 4) * 6, height: 20 + (index % 3) * 7, borderRadius: "100% 0 100% 0", backgroundColor: index % 3 === 0 ? "rgba(246,182,61,0.85)" : "rgba(185,73,28,0.72)", rotate: `${index * 31 + progress * 300}deg`, opacity: 0.22 + (index % 4) * 0.09 } });
    })
  );
}
