import React from "react";
import {
  AbsoluteFill,
  Sequence,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { sampleFastEdit } from "../fastEditScene.mjs";
import { resolveRenderDimensions } from "./dimensions.mjs";
import { clipSequenceTimings } from "./timing.mjs";
export function FastEditTimeline({ manifest }) {
  const time = useCurrentFrame() / manifest.meta.fps;
  const scene = sampleFastEdit(
    manifest,
    time,
    resolveRenderDimensions(manifest),
  );
  const timings = clipSequenceTimings(manifest.clips, manifest.meta.fps);
  const node = (n) =>
    React.createElement(
      n.style.display === "inline" ? "span" : "div",
      { key: n.id, id: n.id, style: n.style },
      n.text,
      ...n.children.map(node),
    );
  return React.createElement(
    AbsoluteFill,
    { style: { background: "#000", overflow: "hidden" } },
    ...manifest.clips.map((c, i) =>
      React.createElement(
        Sequence,
        {
          key: c.id,
          from: timings[i].from,
          durationInFrames: timings[i].durationInFrames,
        },
        React.createElement(OffthreadVideo, {
          src: staticFile(c.src),
          trimBefore: timings[i].trimBefore,
          muted: true,
          style: scene.video,
        }),
      ),
    ),
    ...scene.layers.map(node),
  );
}
