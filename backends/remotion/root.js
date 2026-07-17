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
import { resolveRenderDimensions } from "./dimensions.mjs";
import { resolveRemotionPreset } from "./presetRegistry.mjs";
import { audioTrackTiming, clipSequenceTimings, secondsToFrames, totalDuration } from "./timing.mjs";

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
      const size = resolveRenderDimensions(manifest);
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
  const children = [];
  const clipTimings = clipSequenceTimings(manifest.clips, fps);

  for (const [index, clip] of manifest.clips.entries()) {
    const timing = clipTimings[index];
    if (!timing || timing.durationInFrames === 0) continue;
    children.push(
      React.createElement(
        Sequence,
        { from: timing.from, durationInFrames: timing.durationInFrames, key: clip.id, name: clip.id },
        React.createElement(OffthreadVideo, {
          src: staticFile(clip.src),
          startFrom: timing.trimBefore,
          muted: !clip.audio,
          style: mediaStyle()
        })
      )
    );
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

  const registeredPreset = resolveRemotionPreset(manifest.presentation?.preset);
  if (registeredPreset) {
    children.push(React.createElement(registeredPreset.handler, { key: registeredPreset.id, manifest }));
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

function mediaStyle() {
  return {
    width: "100%",
    height: "100%",
    objectFit: "cover"
  };
}

registerRoot(Root);
