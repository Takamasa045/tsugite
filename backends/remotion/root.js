import React from "react";
import { Audio, Video } from "@remotion/media";
import {
  AbsoluteFill,
  Composition,
  Interactive,
  Sequence,
  registerRoot,
  staticFile,
  useCurrentFrame
} from "remotion";
import { CinematicImpactCaptions } from "./cinematicImpactCaptions.js";
import {
  captionContainerLayout,
  captionTextLayout,
  mediaLayout,
  resolveCaptionLayout
} from "./captionLayout.mjs";
import { resolveCaptionStyle } from "./captionMotion.mjs";
import { createClipVolume } from "./clipAudio.mjs";
import { resolveRenderDimensions } from "./dimensions.mjs";
import { resolveRemotionPreset } from "./presetRegistry.mjs";
import { OFFTHREAD_VIDEO_FETCH_GUARD } from "./renderSettings.mjs";
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

function clipVideoProps(clip, timing, fps, captionLayout) {
  const layout = mediaLayout(captionLayout);
  const { objectFit, objectPosition, ...style } = layout;
  return {
    ...OFFTHREAD_VIDEO_FETCH_GUARD,
    src: staticFile(clip.src),
    trimBefore: timing.trimBefore,
    muted: !clip.audio,
    volume: createClipVolume(clip, timing.durationInFrames, fps),
    objectFit,
    style: objectPosition ? { ...style, objectPosition } : style
  };
}

function Timeline({ manifest }) {
  const fps = manifest.meta.fps;
  const children = [];
  const clipTimings = clipSequenceTimings(manifest.clips, fps);
  const captionLayout = resolveCaptionLayout(manifest);
  const registeredPreset = resolveRemotionPreset(manifest.presentation?.preset);

  for (const [index, clip] of manifest.clips.entries()) {
    const timing = clipTimings[index];
    if (!timing || timing.durationInFrames === 0) continue;
    children.push(
      React.createElement(
        Sequence,
        { from: timing.from, durationInFrames: timing.durationInFrames, key: clip.id, name: clip.id },
        React.createElement(Video, clipVideoProps(clip, timing, fps, captionLayout))
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
        : React.createElement(Captions, {
            key: "captions",
            captions: manifest.captions ?? [],
            fps,
            layout: captionLayout
          })
    );
  }

  return React.createElement(AbsoluteFill, { style: { backgroundColor: "black" } }, ...children);
}

function Captions({ captions, fps, layout }) {
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
        ...captionContainerLayout(layout),
        pointerEvents: "none"
      }
    },
    React.createElement(
      Interactive.Div,
      {
        name: "Caption",
        style: captionTextLayout(layout)
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

registerRoot(Root);
