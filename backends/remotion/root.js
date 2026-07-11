import React from "react";
import {
  AbsoluteFill,
  Audio,
  Composition,
  OffthreadVideo,
  Sequence,
  registerRoot,
  staticFile,
  useCurrentFrame
} from "remotion";
import { CinematicImpactCaptions } from "./cinematicImpactCaptions.js";
import { resolveCaptionStyle } from "./captionMotion.mjs";
import { audioTrackTiming, secondsToFrames, secondsToTimelineFrame, totalDuration } from "./timing.mjs";
import { ArticleDialogue } from "./dialogue.js";
import { ARTICLE_DIALOGUE_PRESET } from "./presentation.mjs";
import { StreetDialogue } from "./streetDialogue.js";
import { STREET_DIALOGUE_PRESET } from "./streetPresentation.mjs";

const DEFAULT_MANIFEST = {
  meta: {
    aspect: "16:9",
    fps: 30,
    target_duration_seconds: 1,
    slug: "tsugite"
  },
  clips: [
    {
      id: "blank",
      src: "",
      in: 0,
      out: 1,
      duration: 1,
      fps: 30,
      resolution: { width: 320, height: 180 },
      audio: false
    }
  ],
  audio: { bgm: [], narration: [], sfx: [] },
  captions: [],
  images: [],
  speakers: []
};

function Root() {
  return React.createElement(Composition, {
    id: "tsugite-render",
    component: Timeline,
    defaultProps: { manifest: DEFAULT_MANIFEST },
    calculateMetadata: ({ props }) => {
      const manifest = props.manifest ?? DEFAULT_MANIFEST;
      const fps = manifest.meta.fps;
      const size = dimensions(manifest);
      return {
        fps,
        width: size.width,
        height: size.height,
        durationInFrames: secondsToFrames(totalDuration(manifest), fps)
      };
    }
  });
}

function Timeline({ manifest }) {
  const fps = manifest.meta.fps;
  let cursor = 0;
  const children = [];

  for (const clip of manifest.clips) {
    const durationInFrames = secondsToFrames(clip.duration, fps);
    const trimBefore = secondsToTimelineFrame(clip.in ?? 0, fps);
    children.push(
      React.createElement(
        Sequence,
        { from: cursor, durationInFrames, key: clip.id, name: clip.id },
        React.createElement(OffthreadVideo, {
          src: staticFile(clip.src),
          startFrom: trimBefore,
          muted: !clip.audio,
          style: mediaStyle()
        })
      )
    );
    cursor += durationInFrames;
  }

  for (const track of audioTracks(manifest)) {
    const timing = audioTrackTiming(track, manifest, fps);
    children.push(
      React.createElement(
        Sequence,
        {
          from: timing.from,
          durationInFrames: timing.durationInFrames,
          key: `audio-sequence-${track.id ?? track.src}`,
          name: `audio-${track.id ?? track.src}`
        },
        React.createElement(Audio, {
        key: `audio-${track.id ?? track.src}`,
        src: staticFile(track.src),
        volume: track.volume ?? 1
        })
      )
    );
  }

  if (manifest.presentation?.preset === ARTICLE_DIALOGUE_PRESET) {
    children.push(React.createElement(ArticleDialogue, { key: "article-dialogue", manifest }));
  } else if (manifest.presentation?.preset === STREET_DIALOGUE_PRESET) {
    children.push(React.createElement(StreetDialogue, { key: "street-dialogue", manifest }));
  } else {
    const captionStyle = resolveCaptionStyle(manifest);
    children.push(
      captionStyle === "cinematic-impact"
        ? React.createElement(CinematicImpactCaptions, {
            key: "captions-cinematic-impact",
            captions: manifest.captions ?? [],
            fps
          })
        : React.createElement(Captions, { key: "captions", captions: manifest.captions ?? [], fps })
    );
  }

  return React.createElement(AbsoluteFill, { style: { backgroundColor: "black" } }, ...children);
}

function Captions({ captions, fps }) {
  const frame = useCurrentFrame();
  const second = frame / fps;
  const active = captions.find((caption) => second >= caption.start && second < caption.end);
  if (!active) return null;

  return React.createElement(
    AbsoluteFill,
    {
      style: {
        justifyContent: "flex-end",
        alignItems: "center",
        padding: "6%",
        pointerEvents: "none"
      }
    },
    React.createElement(
      "div",
      {
        style: {
          maxWidth: "84%",
          backgroundColor: "rgba(0, 0, 0, 0.68)",
          color: "white",
          fontFamily: "Arial, sans-serif",
          fontSize: 34,
          lineHeight: 1.25,
          padding: "14px 20px",
          textAlign: "center"
        }
      },
      active.speaker ? `${active.speaker}: ${active.text}` : active.text
    )
  );
}

function audioTracks(manifest) {
  return [...(manifest.audio?.bgm ?? []), ...(manifest.audio?.narration ?? []), ...(manifest.audio?.sfx ?? [])].filter(
    (track) => track.src
  );
}

function dimensions(manifest) {
  const first = manifest.clips[0]?.resolution;
  if (first) {
    return { width: even(first.width), height: even(first.height) };
  }

  return manifest.meta.aspect === "9:16" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}

function even(value) {
  return value % 2 === 0 ? value : value + 1;
}

function mediaStyle() {
  return {
    width: "100%",
    height: "100%",
    objectFit: "cover"
  };
}

registerRoot(Root);
