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
import { OFFTHREAD_VIDEO_FETCH_GUARD } from "./renderSettings.mjs";
import { resolveSkateCamPresentation } from "./skateCamPresentation.mjs";

const h = React.createElement;
const MONO = 'SFMono-Regular, Menlo, Consolas, monospace';

export function SkateCam({ manifest }) {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const presentation = resolveSkateCamPresentation(manifest);
  const designScale = width / 2560;
  const timelineFrame = frame + Math.round(presentation.timelineOffsetSeconds * fps);
  const second = timelineFrame / fps;
  const boundaryFrame = Math.round(presentation.firstClipDuration * fps);
  const titleOpacity = interpolate(timelineFrame, [3, 8, 38, 48], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic)
  });
  const titleScale = interpolate(timelineFrame, [3, 10, 15, 21], [0.58, 1.13, 0.97, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.34, 1.56, 0.64, 1)
  });
  const cutDistance = Math.abs(timelineFrame - boundaryFrame);
  const cutFlash = cutDistance > 4 ? 0 : (1 - cutDistance / 4) * 0.28;
  const line = second < presentation.firstClipDuration ? "LINE 01" : "LINE 02";
  const endFrame = Math.round(presentation.totalDuration * fps);
  const endFade = interpolate(timelineFrame, [endFrame - 4, endFrame - 1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const blinkFrames = Math.max(1, Math.round(fps));

  return h(
    AbsoluteFill,
    {
      style: {
        color: "#fff8e8",
        fontFamily: MONO,
        pointerEvents: "none",
        overflow: "hidden"
      }
    },
    h(AnalogTexture, { frame: timelineFrame }),
    h(AfterimageEffects, {
      fps,
      timelineOffsetSeconds: presentation.timelineOffsetSeconds,
      effects: presentation.afterimageEffects,
      images: manifest.images ?? []
    }),
    h(RotoscopeEffects, {
      fps,
      timelineOffsetSeconds: presentation.timelineOffsetSeconds,
      effects: presentation.rotoscopeEffects,
      images: manifest.images ?? []
    }),
    h(ActionTextEffects, {
      frame: timelineFrame,
      fps,
      effects: presentation.actionTextEffects
    }),
    h(DoodleEffects, {
      frame: timelineFrame,
      fps,
      effects: presentation.doodleEffects
    }),
    h(Viewfinder),
    h(
      "div",
      {
        style: {
          position: "absolute",
          top: 52,
          left: 62,
          display: "flex",
          alignItems: "center",
          gap: 16,
          fontSize: 24,
          fontWeight: 700,
          letterSpacing: "0.09em",
          textShadow: "0 2px 8px rgba(0,0,0,.8)"
        }
      },
      h("span", {
        style: {
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: timelineFrame % blinkFrames < blinkFrames * 0.6 ? "#ff3b2f" : "#64130e",
          boxShadow: "0 0 12px rgba(255,59,47,.6)"
        }
      }),
      "REC",
      h("span", { style: { opacity: 0.72, fontSize: 19 } }, line)
    ),
    h(
      "div",
      {
        style: {
          position: "absolute",
          top: 54,
          right: 64,
          fontSize: 21,
          letterSpacing: "0.08em",
          textShadow: "0 2px 8px rgba(0,0,0,.8)"
        }
      },
      `${formatTimecode(timelineFrame, fps)}  SP`
    ),
    h(
      "div",
      {
        style: {
          position: "absolute",
          left: "50%",
          top: "43%",
          opacity: titleOpacity,
          transform: `translate(-50%, -50%) rotate(-1.4deg) scale(${titleScale})`,
          transformOrigin: "50% 50%",
          textAlign: "center",
          textShadow: "0 5px 24px rgba(0,0,0,.88)"
        }
      },
      h(
        "div",
        {
          style: {
            position: "relative",
            display: "inline-flex",
            flexDirection: "column",
            alignItems: "center",
            minWidth: 900 * designScale,
            background: "rgba(8,8,8,.82)",
            border: `${6 * designScale}px solid #fff2c9`,
            padding: `${34 * designScale}px ${64 * designScale}px ${30 * designScale}px`,
            boxShadow: `${18 * designScale}px ${18 * designScale}px 0 rgba(239,35,60,.88), ${30 * designScale}px ${30 * designScale}px 0 rgba(0,0,0,.26)`,
            clipPath: "polygon(2% 4%, 99% 0, 97% 94%, 0 100%)"
          }
        },
        h("div", {
          style: {
            fontFamily: '"Hiragino Sans", "Yu Gothic", "Noto Sans JP", sans-serif',
            fontSize: 122 * designScale,
            lineHeight: 1.05,
            fontWeight: 900,
            letterSpacing: "-0.065em",
            color: "#fff2c9",
            WebkitTextStroke: `${2 * designScale}px rgba(0,0,0,.55)`,
            paintOrder: "stroke fill"
          },
          children: presentation.title
        }),
        presentation.riderName &&
          h("div", {
            style: {
              marginTop: 18 * designScale,
              padding: `${7 * designScale}px ${24 * designScale}px ${8 * designScale}px`,
              background: "#ef233c",
              color: "#fff8e8",
              fontFamily: '"Hiragino Sans", "Yu Gothic", "Noto Sans JP", sans-serif',
              fontSize: 40 * designScale,
              lineHeight: 1,
              fontWeight: 900,
              letterSpacing: "0.16em",
              transform: "rotate(1.4deg)"
            },
            children: presentation.riderName
          })
      )
    ),
    h(
      "div",
      {
        style: {
          position: "absolute",
          right: 66,
          bottom: 56,
          fontSize: 18,
          letterSpacing: "0.12em",
          opacity: 0.8,
          textShadow: "0 2px 8px rgba(0,0,0,.8)"
        }
      },
      presentation.location
    ),
    h(AbsoluteFill, {
      style: {
        background: "#fff",
        opacity: cutFlash,
        mixBlendMode: "screen"
      }
    }),
    h(AbsoluteFill, {
      style: {
        background: "#000",
        opacity: endFade
      }
    })
  );
}

const ACTION_TEXT_POSITIONS = {
  ledge: [82, 32],
  jump: [17, 33],
  stairs: [82, 36],
  rail: [18, 37]
};

function ActionTextEffects({ frame, fps, effects }) {
  return h(
    React.Fragment,
    null,
    ...effects.map((effect) => {
      const startFrame = Math.round(effect.start * fps);
      const endFrame = Math.round(effect.end * fps);
      if (frame < startFrame || frame >= endFrame) return null;
      return h(ActionTextPop, {
        key: effect.id,
        effect,
        frame: frame - startFrame,
        durationInFrames: Math.max(1, endFrame - startFrame),
        fps
      });
    })
  );
}

function ActionTextPop({ effect, frame, durationInFrames, fps }) {
  const { width } = useVideoConfig();
  const designScale = width / 2560;
  const progress = frame / Math.max(1, durationInFrames - 1);
  const opacity = interpolate(progress, [0, 0.08, 0.78, 1], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const scale = interpolate(progress, [0, 0.13, 0.23, 1], [0.48, 1.2, 0.98, 1.05], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.34, 1.56, 0.64, 1)
  });
  const stepFrames = Math.max(1, Math.round(fps / 12));
  const steppedFrame = Math.floor(frame / stepFrames);
  const jitter = [
    [-3, 2, -7],
    [2, -2, -4],
    [-1, 1, -6],
    [3, 0, -3],
    [0, -1, -5]
  ][steppedFrame % 5];
  const [defaultX, defaultY] = ACTION_TEXT_POSITIONS[effect.kind] ?? [50, 22];
  const x = effect.x_percent ?? defaultX;
  const y = effect.y_percent ?? defaultY;

  return h(
    "div",
    {
      style: {
        position: "absolute",
        left: `${x}%`,
        top: `${y}%`,
        opacity,
        transform: `translate(-50%, -50%) translate(${jitter[0] * designScale}px, ${jitter[1] * designScale}px) rotate(${jitter[2]}deg) scale(${scale})`,
        transformOrigin: "50% 50%"
      }
    },
    h("div", {
      style: {
        position: "absolute",
        inset: `${-10 * designScale}px ${-30 * designScale}px ${-9 * designScale}px`,
        background: "#ef233c",
        transform: "skewX(-13deg) rotate(-1deg)",
        clipPath: "polygon(3% 8%, 100% 0, 96% 92%, 0 100%)",
        boxShadow: `${9 * designScale}px ${8 * designScale}px 0 rgba(9,8,7,.7)`
      }
    }),
    h(
      "div",
      {
        style: {
          position: "relative",
          color: "#fff2c9",
          WebkitTextStroke: `${5 * designScale}px rgba(9,8,7,.92)`,
          paintOrder: "stroke fill",
          fontFamily: '"Marker Felt", "Arial Black", sans-serif',
          fontSize: 112 * designScale,
          lineHeight: 0.95,
          fontWeight: 900,
          letterSpacing: "-0.055em",
          whiteSpace: "nowrap",
          textShadow: `${5 * designScale}px ${5 * designScale}px 0 rgba(9,8,7,.92)`
        }
      },
      effect.label
    )
  );
}

function AfterimageEffects({ fps, timelineOffsetSeconds, effects, images }) {
  const assets = new Map(images.map((image) => [image.id, image.src]));
  const children = [];

  for (const effect of effects) {
    const src = assets.get(effect.asset_id);
    if (!src) continue;
    const localEffectStart = Math.round((effect.start - timelineOffsetSeconds) * fps);
    const localEffectEnd = Math.round((effect.end - timelineOffsetSeconds) * fps);
    const delays = effect.delays_frames ?? [3, 6, 9];
    const timingFps = Number.isFinite(effect.timing_fps) ? effect.timing_fps : 24;
    const opacities = effect.opacities ?? [0.34, 0.22, 0.12];

    for (const [index, configuredDelay] of delays.entries()) {
      const delay = Math.max(1, Math.round(configuredDelay * fps / timingFps));
      const delayedStart = localEffectStart + delay;
      const sequenceFrom = Math.max(0, delayedStart);
      const sourceStart = Math.max(0, -delayedStart);
      const durationInFrames = localEffectEnd - sequenceFrom;
      if (durationInFrames <= 0) continue;
      children.push(
        h(
          Sequence,
          {
            key: `${effect.id}-echo-${index}`,
            from: sequenceFrom,
            durationInFrames,
            name: `${effect.id} afterimage ${index + 1}`
          },
          h(AfterimageLayer, {
            src,
            startFrom: sourceStart,
            durationInFrames,
            opacity: opacities[index] ?? Math.max(0.08, 0.34 - index * 0.1),
            tint: index % 2 === 0 ? "warm" : "cool"
          })
        )
      );
    }
  }

  return children.length > 0 ? h(React.Fragment, null, ...children) : null;
}

function AfterimageLayer({ src, startFrom, durationInFrames, opacity, tint }) {
  const frame = useCurrentFrame();
  const fadeFrames = Math.min(5, Math.max(1, Math.floor(durationInFrames / 3)));
  const layerOpacity = interpolate(
    frame,
    [0, fadeFrames, Math.max(fadeFrames, durationInFrames - fadeFrames), durationInFrames],
    [0, opacity, opacity, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const filter = tint === "warm"
    ? "saturate(1.45) brightness(1.12) sepia(.12) drop-shadow(0 0 10px rgba(255,72,48,.7))"
    : "saturate(1.25) brightness(1.18) hue-rotate(168deg) drop-shadow(0 0 10px rgba(95,211,255,.55))";

  return h(OffthreadVideo, {
    ...OFFTHREAD_VIDEO_FETCH_GUARD,
    src: staticFile(src),
    startFrom,
    muted: true,
    style: {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      objectFit: "cover",
      opacity: layerOpacity,
      filter,
      mixBlendMode: "screen"
    }
  });
}

function RotoscopeEffects({ fps, timelineOffsetSeconds, effects, images }) {
  const assets = new Map(images.map((image) => [image.id, image.src]));
  const children = [];

  for (const effect of effects) {
    const creamSrc = assets.get(effect.cream_asset_id);
    const redSrc = assets.get(effect.red_asset_id);
    if (!creamSrc || !redSrc) continue;

    const effectStart = Math.round((effect.start - timelineOffsetSeconds) * fps);
    const effectEnd = Math.round((effect.end - timelineOffsetSeconds) * fps);
    const trailDelays = effect.trail_delays_frames ?? [3, 6];
    const timingFps = Number.isFinite(effect.timing_fps) ? effect.timing_fps : 24;
    const roles = [
      { id: "current", delay: 0 },
      { id: "trail-cream", delay: Math.max(1, Math.round((trailDelays[0] ?? 3) * fps / timingFps)) },
      { id: "trail-red", delay: Math.max(1, Math.round((trailDelays[1] ?? 6) * fps / timingFps)) }
    ];

    for (const role of roles) {
      const delayedStart = effectStart + role.delay;
      const sequenceFrom = Math.max(0, delayedStart);
      const sourceStart = Math.max(0, -delayedStart);
      const durationInFrames = effectEnd - sequenceFrom;
      if (durationInFrames <= 0) continue;
      children.push(
        h(
          Sequence,
          {
            key: `${effect.id}-${role.id}`,
            from: sequenceFrom,
            durationInFrames,
            name: `${effect.id} rotoscope ${role.id}`
          },
          h(RotoscopeLayer, {
            creamSrc,
            redSrc,
            startFrom: sourceStart,
            durationInFrames,
            fps,
            role: role.id
          })
        )
      );
    }

    const impactStart = Math.round((effect.impact_time - timelineOffsetSeconds) * fps);
    const impactDuration = Math.max(1, Math.round((effect.impact_duration_seconds ?? 0.55) * fps));
    const impactFrom = Math.max(0, impactStart);
    const impactSourceStart = Math.max(0, -impactStart);
    const visibleImpactDuration = impactDuration - impactSourceStart;
    if (visibleImpactDuration > 0) {
      children.push(
        h(
          Sequence,
          {
            key: `${effect.id}-impact`,
            from: impactFrom,
            durationInFrames: visibleImpactDuration,
            name: `${effect.id} landing accent`
          },
          h(ImpactAccent, {
            kind: effect.kind,
            durationInFrames: impactDuration,
            sourceStart: impactSourceStart
          })
        )
      );
    }
  }

  return children.length > 0 ? h(React.Fragment, null, ...children) : null;
}

function RotoscopeLayer({ creamSrc, redSrc, startFrom, durationInFrames, fps, role }) {
  const frame = useCurrentFrame();
  const fadeFrames = Math.min(4, Math.max(1, Math.floor(durationInFrames / 3)));
  const envelope = interpolate(
    frame,
    [0, fadeFrames, Math.max(fadeFrames, durationInFrames - fadeFrames), durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const stepFrames = Math.max(1, Math.round(fps / 12));
  const steppedFrame = Math.floor(frame / stepFrames);
  const jitter = [
    [0, 0],
    [-2, 1],
    [2, -1],
    [-1, -2],
    [1, 2],
    [-2, 0],
    [2, 1],
    [0, -1]
  ][steppedFrame % 8];
  const commonStyle = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
    mixBlendMode: "screen"
  };

  if (role === "trail-cream") {
    return h(OffthreadVideo, {
      ...OFFTHREAD_VIDEO_FETCH_GUARD,
      src: staticFile(creamSrc),
      startFrom,
      muted: true,
      style: {
        ...commonStyle,
        opacity: envelope * 0.31,
        transform: `translate(${jitter[0] - 8}px, ${jitter[1] + 5}px)`,
        filter: "drop-shadow(0 0 2px rgba(255,239,176,.5))"
      }
    });
  }

  if (role === "trail-red") {
    return h(OffthreadVideo, {
      ...OFFTHREAD_VIDEO_FETCH_GUARD,
      src: staticFile(redSrc),
      startFrom,
      muted: true,
      style: {
        ...commonStyle,
        opacity: envelope * 0.2,
        transform: `translate(${jitter[0] + 12}px, ${jitter[1] - 7}px)`,
        filter: "drop-shadow(0 0 3px rgba(239,35,60,.55))"
      }
    });
  }

  return h(
    React.Fragment,
    null,
    h(OffthreadVideo, {
      ...OFFTHREAD_VIDEO_FETCH_GUARD,
      src: staticFile(redSrc),
      startFrom,
      muted: true,
      style: {
        ...commonStyle,
        opacity: envelope * 0.62,
        transform: `translate(${jitter[0] + 5}px, ${jitter[1] - 3}px) rotate(${-jitter[0] * 0.035}deg)`,
        filter: "drop-shadow(0 0 3px rgba(239,35,60,.62))"
      }
    }),
    h(OffthreadVideo, {
      ...OFFTHREAD_VIDEO_FETCH_GUARD,
      src: staticFile(creamSrc),
      startFrom,
      muted: true,
      style: {
        ...commonStyle,
        opacity: envelope * 0.9,
        transform: `translate(${jitter[0]}px, ${jitter[1]}px) rotate(${jitter[0] * 0.025}deg)`,
        filter: "drop-shadow(0 0 2px rgba(255,239,176,.72))"
      }
    })
  );
}

const IMPACT_POSITIONS = {
  ledge: [645, 575],
  jump: [650, 575],
  stairs: [790, 615],
  rail: [820, 610]
};

function ImpactAccent({ kind, durationInFrames, sourceStart }) {
  const frame = useCurrentFrame() + sourceStart;
  const progress = frame / Math.max(1, durationInFrames - 1);
  const opacity = interpolate(progress, [0, 0.12, 0.7, 1], [0, 0.94, 0.72, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const scale = interpolate(progress, [0, 0.22, 1], [0.68, 1, 1.12], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic)
  });
  const [x, y] = IMPACT_POSITIONS[kind] ?? [640, 580];
  const artwork = {
    ledge: h(
      "g",
      null,
      h("path", { d: `M ${x - 220} ${y + 10} Q ${x - 40} ${y - 15} ${x + 210} ${y + 2}`, className: "cream" }),
      h("path", { d: `M ${x - 185} ${y + 30} Q ${x + 10} ${y + 7} ${x + 260} ${y + 22}`, className: "red" }),
      h("path", { d: `M ${x + 145} ${y - 10} q 35 -34 70 -15`, className: "cream" })
    ),
    jump: h(
      "g",
      null,
      h("path", { d: `M ${x - 180} ${y + 18} Q ${x - 55} ${y - 36} ${x + 80} ${y + 4}`, className: "cream" }),
      h("path", { d: `M ${x + 25} ${y + 14} Q ${x + 145} ${y - 38} ${x + 260} ${y + 8}`, className: "red" }),
      h("path", { d: `M ${x - 220} ${y - 4} l -30 -16 m 44 7 l -10 -31`, className: "red" })
    ),
    stairs: h(
      "g",
      null,
      h("path", { d: `M ${x} ${y} l -82 38 l -44 57`, className: "cream" }),
      h("path", { d: `M ${x + 8} ${y} l 66 50 l -18 67`, className: "red" }),
      h("path", { d: `M ${x - 6} ${y + 8} l -10 84 l -58 53`, className: "cream" })
    ),
    rail: h(
      "g",
      null,
      ...Array.from({ length: 7 }, (_, index) => {
        const angle = (-75 + index * 18) * Math.PI / 180;
        const length = 42 + (index % 3) * 18;
        return h("line", {
          key: `rail-impact-${index}`,
          x1: x,
          y1: y,
          x2: x + Math.cos(angle) * length,
          y2: y + Math.sin(angle) * length,
          className: index % 2 === 0 ? "red" : "cream"
        });
      }),
      h("path", { d: `M ${x - 30} ${y + 16} C ${x + 80} ${y - 48} ${x + 160} ${y + 10} ${x + 255} ${y - 74}`, className: "cream" })
    )
  }[kind];

  return h(
    AbsoluteFill,
    { style: { opacity } },
    h(
      "svg",
      {
        viewBox: "0 0 1280 720",
        width: "100%",
        height: "100%",
        preserveAspectRatio: "none",
        style: {
          overflow: "visible",
          transform: `scale(${scale})`,
          transformOrigin: `${x}px ${y}px`,
          filter: "drop-shadow(0 2px 1px rgba(12,10,8,.55))"
        }
      },
      h(
        "style",
        null,
        ".cream,.red{fill:none;stroke-linecap:round;stroke-linejoin:round}.cream{stroke:#ffefb0;stroke-width:6}.red{stroke:#ef233c;stroke-width:5}"
      ),
      artwork
    )
  );
}

const DOODLE_SCENES = {
  title: {
    path: "M 1710 350 C 1880 375 2090 360 2360 315",
    x: [2050, 2190],
    y: [330, 310],
    labelPosition: [2100, 350],
    label: "ROLL!"
  },
  ledge: {
    path: "M 1390 1090 C 1650 1080 1910 1030 2260 930",
    x: [1430, 1980],
    y: [1080, 960],
    labelPosition: [1850, 340],
    label: "LOCK!"
  },
  jump: {
    path: "M 1390 1090 C 1660 1060 1930 970 2280 790",
    x: [1450, 2010],
    y: [1070, 900],
    labelPosition: [900, 300],
    label: "POP!"
  },
  stairs: {
    path: "M 1510 1100 C 1740 1080 1990 1000 2320 840",
    x: [1570, 2110],
    y: [1080, 900],
    labelPosition: [1780, 360],
    label: "DROP!"
  },
  rail: {
    path: "M 1660 1120 C 1900 1090 2170 990 2460 800",
    x: [1740, 2280],
    y: [1080, 900],
    labelPosition: [500, 340],
    label: "SLIDE!"
  }
};

function DoodleEffects({ frame, fps, effects }) {
  return h(
    React.Fragment,
    null,
    ...effects.map((effect) => {
      const startFrame = Math.round(effect.start * fps);
      const endFrame = Math.round(effect.end * fps);
      if (frame < startFrame || frame >= endFrame) return null;
      const duration = Math.max(1, endFrame - startFrame);
      const progress = (frame - startFrame) / duration;
      return h(DoodleLayer, {
        key: effect.id,
        effect,
        progress,
        frame
      });
    })
  );
}

function DoodleLayer({ effect, progress, frame }) {
  const scene = DOODLE_SCENES[effect.kind];
  if (!scene) return null;
  if (effect.phase === "trick") {
    return h(TrickDoodleLayer, { effect, progress, frame, scene });
  }
  if (effect.kind !== "title") {
    return h(LandingDoodleLayer, { effect, progress, frame, scene });
  }
  const draw = interpolate(progress, [0.14, 0.52], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic)
  });
  const opacity = interpolate(progress, [0, 0.08, 0.8, 1], [0, 0.94, 0.94, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const action = interpolate(progress, [0.12, 0.82], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic)
  });
  const x = interpolate(action, [0, 1], scene.x);
  const y = interpolate(action, [0, 1], scene.y);
  const steppedFrame = Math.floor(frame / 2);
  const jitterX = Math.sin(steppedFrame * 2.17) * 5.2;
  const jitterY = Math.cos(steppedFrame * 1.73) * 4.4;
  const burst = interpolate(progress, [0, 0.12, 0.48], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const labelOpacity = interpolate(progress, [0.18, 0.28, 0.68, 0.8], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const accent = effect.accent ?? "#ff4b36";
  const ink = effect.ink ?? "#fff2c9";

  return h(
    AbsoluteFill,
    { style: { opacity } },
    h(
      "svg",
      {
        viewBox: "0 0 2560 1440",
        width: "100%",
        height: "100%",
        preserveAspectRatio: "none",
        style: { overflow: "visible", filter: "drop-shadow(0 3px 1px rgba(14,12,10,.48))" }
      },
      h(PaintSwashes, { scene, draw, progress, frame, accent, ink, jitterX, jitterY }),
      h("path", {
        d: scene.path,
        pathLength: 1,
        fill: "none",
        stroke: "rgba(10,10,10,.48)",
        strokeWidth: 31,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        strokeDasharray: 1,
        strokeDashoffset: 1 - draw,
        transform: `translate(${jitterX * 0.35} ${jitterY * 0.35})`
      }),
      h("path", {
        d: scene.path,
        pathLength: 1,
        fill: "none",
        stroke: ink,
        strokeWidth: 16,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        strokeDasharray: 1,
        strokeDashoffset: 1 - draw,
        transform: `translate(${jitterX} ${jitterY})`
      }),
      h("path", {
        d: scene.path,
        pathLength: 1,
        fill: "none",
        stroke: accent,
        strokeWidth: 8,
        strokeLinecap: "round",
        strokeDasharray: "0.035 0.028",
        strokeDashoffset: 1 - draw + (frame % 3) * 0.006,
        transform: `translate(${-jitterX * 0.7} ${jitterY * 0.6})`
      }),
      effect.kind !== "title" && h(BoardOrbit, { x, y, frame, progress, ink, accent }),
      effect.kind !== "title" && h(MotionMarks, { x, y, frame, ink, accent, progress }),
      effect.kind !== "title" && h(LandingBurst, { x, y, burst, frame, ink, accent }),
      effect.kind !== "title" && h(PaperScraps, { x, y, burst, frame, ink, accent }),
      h(DoodleSpark, {
        x: effect.kind === "title" ? 2330 : x - 115,
        y: effect.kind === "title" ? 245 : y - 145,
        size: effect.kind === "title" ? 44 : 34,
        rotation: frame * 4,
        color: accent
      })
    ),
    h(
      "div",
      {
        style: {
          position: "absolute",
          left: `${(scene.labelPosition[0] / 2560) * 100}%`,
          top: `${(scene.labelPosition[1] / 1440) * 100}%`,
          transform: `translate(-50%, -50%) rotate(${Math.sin(frame * 0.9) * 3 - 6}deg) scale(${0.86 + burst * 0.18})`,
          color: ink,
          WebkitTextStroke: "5px rgba(10,10,10,.82)",
          paintOrder: "stroke fill",
          fontFamily: '"Marker Felt", "Comic Sans MS", cursive',
          fontSize: effect.kind === "title" ? 48 : 70,
          fontWeight: 900,
          letterSpacing: "-0.04em",
          opacity: labelOpacity,
          textShadow: `5px 5px 0 ${accent}`
        }
      },
      effect.label ?? scene.label
    )
  );
}

function TrickDoodleLayer({ effect, progress, frame }) {
  const opacity = interpolate(progress, [0, 0.08, 0.88, 1], [0, 0.78, 0.78, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const draw = interpolate(progress, [0.02, 0.82], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic)
  });
  const accent = effect.accent ?? "#ff4b36";
  const ink = effect.ink ?? "#fff2c9";
  const artwork = {
    ledge: h(LedgeScratchMotion, { draw, progress, frame, accent, ink }),
    jump: h(JumpFlightMotion, { draw, progress, frame, accent, ink }),
    stairs: h(StairDropMotion, { draw, progress, frame, accent, ink }),
    rail: h(RailSlideMotion, { draw, progress, frame, accent, ink })
  }[effect.kind];

  return h(
    AbsoluteFill,
    { style: { opacity } },
    h(
      "svg",
      {
        viewBox: "0 0 2560 1440",
        width: "100%",
        height: "100%",
        preserveAspectRatio: "none",
        style: { overflow: "visible", filter: "drop-shadow(0 3px 1px rgba(14,12,10,.52))" }
      },
      artwork
    )
  );
}

function LedgeScratchMotion({ draw, progress, frame, accent, ink }) {
  const headX = interpolate(progress, [0, 1], [430, 1390]);
  const jitter = Math.sin(Math.floor(frame / 2) * 1.7) * 5;
  const hashes = Array.from({ length: 9 }, (_, index) => {
    const x = headX - 34 - index * 34;
    const visible = Math.max(0, 1 - index * 0.09);
    return h("line", {
      key: `ledge-hash-${index}`,
      x1: x,
      y1: 955 + (index % 2) * 7,
      x2: x - 15,
      y2: 1000 + (index % 3) * 9,
      stroke: index % 3 === 0 ? accent : ink,
      strokeWidth: index % 3 === 0 ? 10 : 7,
      strokeLinecap: "round",
      opacity: visible
    });
  });
  return h(
    "g",
    { transform: `translate(0 ${jitter})` },
    h("path", {
      d: "M 300 956 C 620 948 930 964 1480 936",
      pathLength: 1,
      fill: "none",
      stroke: "rgba(10,10,10,.64)",
      strokeWidth: 24,
      strokeLinecap: "round",
      strokeDasharray: "0.07 0.025",
      strokeDashoffset: 1 - draw
    }),
    h("path", {
      d: "M 300 956 C 620 948 930 964 1480 936",
      pathLength: 1,
      fill: "none",
      stroke: ink,
      strokeWidth: 10,
      strokeLinecap: "round",
      strokeDasharray: "0.07 0.025",
      strokeDashoffset: 1 - draw
    }),
    ...hashes,
    h(DoodleSpark, { x: headX + 8, y: 965, size: 18, rotation: frame * 12, color: accent })
  );
}

function JumpFlightMotion({ draw, progress, frame, accent, ink }) {
  const trails = [
    { d: "M 470 1160 C 720 1110 850 780 1450 690", width: 12, color: ink, offset: 0 },
    { d: "M 420 1200 C 760 1160 900 820 1500 730", width: 7, color: accent, offset: 0.08 },
    { d: "M 540 1115 C 770 1050 930 735 1390 650", width: 5, color: ink, offset: 0.16 }
  ];
  const ghosts = [
    { x: 650, y: 1060, rotation: -15, window: [0.12, 0.42] },
    { x: 930, y: 820, rotation: -8, window: [0.3, 0.62] },
    { x: 1210, y: 700, rotation: 5, window: [0.5, 0.84] }
  ];
  return h(
    "g",
    null,
    ...trails.map((trail, index) =>
      h("path", {
        key: `air-trail-${index}`,
        d: trail.d,
        pathLength: 1,
        fill: "none",
        stroke: trail.color,
        strokeWidth: trail.width,
        strokeLinecap: "round",
        strokeDasharray: index === 1 ? "0.055 0.032" : "0.16 0.04",
        strokeDashoffset: 1 - Math.max(0, draw - trail.offset),
        opacity: 0.82
      })
    ),
    ...ghosts.map((ghost, index) => {
      const ghostOpacity = interpolate(
        progress,
        [ghost.window[0], ghost.window[0] + 0.08, ghost.window[1] - 0.07, ghost.window[1]],
        [0, 0.76, 0.62, 0],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
      );
      return h(GhostBoard, {
        key: `ghost-board-${index}`,
        ...ghost,
        opacity: ghostOpacity,
        ink: index === 1 ? accent : ink,
        frame
      });
    })
  );
}

function GhostBoard({ x, y, rotation, opacity, ink, frame }) {
  return h(
    "g",
    {
      opacity,
      transform: `translate(${x} ${y}) rotate(${rotation + Math.sin(frame * 0.7) * 2})`
    },
    h("path", {
      d: "M -105 0 C -88 -25 82 -25 105 0 C 82 25 -88 25 -105 0 Z",
      fill: "none",
      stroke: ink,
      strokeWidth: 9,
      strokeDasharray: "24 11",
      strokeLinecap: "round"
    }),
    h("circle", { cx: -65, cy: 28, r: 9, fill: "none", stroke: ink, strokeWidth: 6 }),
    h("circle", { cx: 65, cy: 28, r: 9, fill: "none", stroke: ink, strokeWidth: 6 })
  );
}

function StairDropMotion({ draw, progress, frame, accent, ink }) {
  const steps = "M 320 780 L 520 780 L 520 850 L 720 850 L 720 920 L 920 920 L 920 990 L 1120 990 L 1120 1060 L 1370 1060";
  const pulse = 0.72 + Math.sin(Math.floor(frame / 2) * 1.4) * 0.16;
  const chevrons = [690, 930, 1170].map((x, index) =>
    h("path", {
      key: `drop-chevron-${index}`,
      d: `M ${x - 52} ${720 + index * 82} L ${x} ${774 + index * 82} L ${x + 52} ${720 + index * 82}`,
      fill: "none",
      stroke: index === 1 ? accent : ink,
      strokeWidth: 10,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      opacity: Math.max(0, draw - index * 0.17) * pulse
    })
  );
  return h(
    "g",
    null,
    h("path", {
      d: steps,
      pathLength: 1,
      fill: "none",
      stroke: "rgba(10,10,10,.62)",
      strokeWidth: 28,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeDasharray: "0.08 0.025",
      strokeDashoffset: 1 - draw
    }),
    h("path", {
      d: steps,
      pathLength: 1,
      fill: "none",
      stroke: accent,
      strokeWidth: 11,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeDasharray: "0.08 0.025",
      strokeDashoffset: 1 - draw
    }),
    ...chevrons
  );
}

function RailSlideMotion({ draw, progress, frame, accent, ink }) {
  const x = interpolate(progress, [0, 1], [1170, 2130]);
  const y = interpolate(progress, [0, 1], [1040, 610]);
  const sparks = Array.from({ length: 7 }, (_, index) => {
    const angle = (130 + index * 17) * Math.PI / 180;
    const length = 32 + (index % 3) * 18;
    return h("line", {
      key: `rail-spark-${index}`,
      x1: x,
      y1: y,
      x2: x + Math.cos(angle) * length,
      y2: y + Math.sin(angle) * length,
      stroke: index % 2 ? ink : accent,
      strokeWidth: index % 2 ? 7 : 10,
      strokeLinecap: "round",
      opacity: 0.68 + (frame % 2) * 0.18
    });
  });
  return h(
    "g",
    null,
    h("path", {
      d: "M 1120 1070 C 1450 940 1710 770 2220 560",
      pathLength: 1,
      fill: "none",
      stroke: "rgba(10,10,10,.68)",
      strokeWidth: 25,
      strokeLinecap: "round",
      strokeDasharray: "0.05 0.022",
      strokeDashoffset: 1 - draw
    }),
    h("path", {
      d: "M 1120 1070 C 1450 940 1710 770 2220 560",
      pathLength: 1,
      fill: "none",
      stroke: ink,
      strokeWidth: 9,
      strokeLinecap: "round",
      strokeDasharray: "0.05 0.022",
      strokeDashoffset: 1 - draw
    }),
    ...sparks,
    h(DoodleSpark, { x, y, size: 17, rotation: frame * 18, color: accent })
  );
}

function LandingDoodleLayer({ effect, progress, frame, scene }) {
  const opacity = interpolate(progress, [0, 0.05, 0.88, 1], [0, 0.96, 0.88, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const impact = interpolate(progress, [0, 0.14, 0.54], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic)
  });
  const afterglow = interpolate(progress, [0.08, 0.26, 0.78, 1], [0, 1, 0.78, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const labelOpacity = interpolate(progress, [0.12, 0.24, 0.72, 0.88], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const x = scene.x[0];
  const y = scene.y[0];
  const accent = effect.accent ?? "#ff4b36";
  const ink = effect.ink ?? "#fff2c9";
  const artwork = {
    ledge: h(LedgeLanding, { x, y, impact, afterglow, frame, accent, ink }),
    jump: h(JumpLanding, { x, y, impact, afterglow, frame, accent, ink }),
    stairs: h(StairLanding, { x, y, impact, afterglow, frame, accent, ink }),
    rail: h(RailLanding, { x, y, impact, afterglow, frame, accent, ink })
  }[effect.kind];

  return h(
    AbsoluteFill,
    { style: { opacity } },
    h(
      "svg",
      {
        viewBox: "0 0 2560 1440",
        width: "100%",
        height: "100%",
        preserveAspectRatio: "none",
        style: { overflow: "visible", filter: "drop-shadow(0 3px 1px rgba(14,12,10,.52))" }
      },
      artwork
    ),
    h(
      "div",
      {
        style: {
          position: "absolute",
          left: `${(scene.labelPosition[0] / 2560) * 100}%`,
          top: `${(scene.labelPosition[1] / 1440) * 100}%`,
          transform: `translate(-50%, -50%) rotate(${Math.sin(frame * 0.9) * 3 - 6}deg) scale(${0.88 + impact * 0.16})`,
          color: ink,
          WebkitTextStroke: "5px rgba(10,10,10,.82)",
          paintOrder: "stroke fill",
          fontFamily: '"Marker Felt", "Comic Sans MS", cursive',
          fontSize: 70,
          fontWeight: 900,
          letterSpacing: "-0.04em",
          opacity: labelOpacity,
          textShadow: `5px 5px 0 ${accent}`
        }
      },
      effect.label ?? scene.label
    )
  );
}

function LedgeLanding({ x, y, impact, afterglow, frame, accent, ink }) {
  const streaks = Array.from({ length: 6 }, (_, index) => {
    const offset = (index - 2.5) * 22;
    return h("path", {
      key: `skid-${index}`,
      d: `M ${x - 280 - index * 22} ${y + offset} C ${x - 80} ${y + offset - 12} ${x + 210} ${y + offset + 8} ${x + 430 + index * 18} ${y + offset - 18}`,
      fill: "none",
      stroke: index % 3 === 0 ? accent : ink,
      strokeWidth: index % 3 === 0 ? 12 : 8,
      strokeLinecap: "round",
      strokeDasharray: index % 2 ? "38 19" : "66 24",
      strokeDashoffset: frame * -8,
      opacity: afterglow
    });
  });
  const puffs = [0, 1, 2].map((index) =>
    h("circle", {
      key: `dust-${index}`,
      cx: x + 315 + index * 58,
      cy: y - 20 - index * 27,
      r: (22 + index * 10) * impact,
      fill: "none",
      stroke: index === 1 ? accent : ink,
      strokeWidth: 9,
      strokeDasharray: "22 13",
      opacity: impact
    })
  );
  return h("g", null, ...streaks, ...puffs);
}

function JumpLanding({ x, y, impact, afterglow, frame, accent, ink }) {
  const rings = [0, 1, 2].map((index) =>
    h("ellipse", {
      key: `bounce-ring-${index}`,
      cx: x,
      cy: y + 20,
      rx: (105 + index * 90) * (0.45 + impact),
      ry: (32 + index * 18) * (0.45 + impact),
      fill: "none",
      stroke: index === 1 ? accent : ink,
      strokeWidth: index === 1 ? 12 : 8,
      strokeDasharray: index === 2 ? "28 18" : "62 22",
      strokeDashoffset: frame * (index % 2 ? -5 : 4),
      opacity: Math.max(impact, afterglow * (0.72 - index * 0.12))
    })
  );
  return h(
    "g",
    null,
    ...rings,
    h("path", {
      d: `M ${x + 230} ${y - 40} C ${x + 280} ${y - 170} ${x + 355} ${y - 170} ${x + 390} ${y - 300} C ${x + 420} ${y - 210} ${x + 470} ${y - 225} ${x + 500} ${y - 330}`,
      fill: "none",
      stroke: accent,
      strokeWidth: 12,
      strokeLinecap: "round",
      strokeDasharray: "46 22",
      strokeDashoffset: frame * -7,
      opacity: afterglow
    })
  );
}

function StairLanding({ x, y, impact, afterglow, frame, accent, ink }) {
  const cracks = [
    `M ${x} ${y} L ${x - 120} ${y + 50} L ${x - 185} ${y + 126} L ${x - 310} ${y + 156}`,
    `M ${x + 15} ${y} L ${x + 105} ${y + 70} L ${x + 82} ${y + 152} L ${x + 220} ${y + 204}`,
    `M ${x - 20} ${y + 18} L ${x - 25} ${y + 115} L ${x - 110} ${y + 205}`
  ];
  const chevrons = [0, 1, 2].map((index) =>
    h("path", {
      key: `impact-chevron-${index}`,
      d: `M ${x + 300 + index * 95} ${y - 230 - index * 36} L ${x + 350 + index * 95} ${y - 175 - index * 36} L ${x + 400 + index * 95} ${y - 230 - index * 36}`,
      fill: "none",
      stroke: index === 1 ? accent : ink,
      strokeWidth: 11,
      strokeLinecap: "round",
      opacity: afterglow
    })
  );
  return h(
    "g",
    null,
    ...cracks.map((d, index) =>
      h("path", {
        key: `crack-${index}`,
        d,
        pathLength: 1,
        fill: "none",
        stroke: index === 1 ? accent : ink,
        strokeWidth: index === 1 ? 12 : 8,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        strokeDasharray: 1,
        strokeDashoffset: 1 - Math.max(impact, afterglow),
        opacity: 0.92
      })
    ),
    ...chevrons,
    h(DoodleSpark, { x: x - 20, y: y - 15, size: 30 * impact, rotation: frame * 14, color: accent })
  );
}

function RailLanding({ x, y, impact, afterglow, frame, accent, ink }) {
  const sparks = Array.from({ length: 13 }, (_, index) => {
    const angle = (-65 + index * 11) * Math.PI / 180;
    const distance = 75 + impact * (110 + (index % 4) * 25);
    return h("line", {
      key: `landing-spark-${index}`,
      x1: x + 45,
      y1: y,
      x2: x + 45 + Math.cos(angle) * distance,
      y2: y + Math.sin(angle) * distance,
      stroke: index % 3 === 0 ? accent : ink,
      strokeWidth: index % 3 === 0 ? 12 : 7,
      strokeLinecap: "round",
      opacity: impact
    });
  });
  return h(
    "g",
    null,
    ...sparks,
    h("path", {
      d: `M ${x - 40} ${y + 25} C ${x + 170} ${y - 90} ${x + 300} ${y + 35} ${x + 445} ${y - 135} C ${x + 565} ${y - 245} ${x + 610} ${y - 120} ${x + 720} ${y - 280}`,
      pathLength: 1,
      fill: "none",
      stroke: accent,
      strokeWidth: 15,
      strokeLinecap: "round",
      strokeDasharray: "0.18 0.04 0.08 0.03",
      strokeDashoffset: 1 - afterglow + frame * -0.004,
      opacity: afterglow
    }),
    h("path", {
      d: `M ${x - 20} ${y + 48} C ${x + 220} ${y - 20} ${x + 380} ${y + 15} ${x + 655} ${y - 210}`,
      fill: "none",
      stroke: ink,
      strokeWidth: 7,
      strokeLinecap: "round",
      strokeDasharray: "36 20",
      strokeDashoffset: frame * -6,
      opacity: afterglow
    })
  );
}

function PaintSwashes({ scene, draw, progress, frame, accent, ink, jitterX, jitterY }) {
  const swashOpacity = interpolate(progress, [0.12, 0.24, 0.72, 0.95], [0, 0.52, 0.42, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const strokes = [
    { width: 72, color: "rgba(12,10,9,.44)", offset: [jitterX * 0.25, jitterY * 0.25], dash: "1" },
    { width: 48, color: accent, offset: [jitterX, jitterY], dash: "0.62 0.03 0.21 0.04" },
    { width: 22, color: "rgba(255,242,201,.78)", offset: [-jitterX * 0.5, jitterY * 0.65], dash: "0.18 0.025 0.4 0.04" }
  ];
  return h(
    "g",
    { opacity: swashOpacity, style: { mixBlendMode: "multiply" } },
    ...strokes.map((stroke, index) =>
      h("path", {
        key: `swash-${index}`,
        d: scene.path,
        pathLength: 1,
        fill: "none",
        stroke: stroke.color,
        strokeWidth: stroke.width,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        strokeDasharray: stroke.dash,
        strokeDashoffset: 1 - draw + index * 0.012 + (frame % 2) * 0.004,
        transform: `translate(${stroke.offset[0]} ${stroke.offset[1]})`
      })
    ),
    h("path", {
      d: scene.path,
      pathLength: 1,
      fill: "none",
      stroke: ink,
      strokeWidth: 5,
      strokeLinecap: "round",
      strokeDasharray: "0.008 0.014",
      strokeDashoffset: 1 - draw - frame * 0.002,
      opacity: 0.8
    })
  );
}

function BoardOrbit({ x, y, frame, progress, ink, accent }) {
  const orbit = interpolate(progress, [0.16, 0.32, 0.7, 0.86], [0, 0.82, 0.82, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const rotation = frame * 11;
  return h(
    "g",
    {
      opacity: orbit,
      transform: `translate(${x} ${y + 18}) rotate(${rotation})`
    },
    h("ellipse", {
      cx: 0,
      cy: 0,
      rx: 150,
      ry: 72,
      pathLength: 1,
      fill: "none",
      stroke: "rgba(10,10,10,.68)",
      strokeWidth: 26,
      strokeDasharray: "0.34 0.16",
      strokeLinecap: "round"
    }),
    h("ellipse", {
      cx: 0,
      cy: 0,
      rx: 150,
      ry: 72,
      pathLength: 1,
      fill: "none",
      stroke: ink,
      strokeWidth: 13,
      strokeDasharray: "0.34 0.16",
      strokeLinecap: "round"
    }),
    h("ellipse", {
      cx: 0,
      cy: 0,
      rx: 188,
      ry: 96,
      pathLength: 1,
      fill: "none",
      stroke: accent,
      strokeWidth: 9,
      strokeDasharray: "0.08 0.045",
      strokeDashoffset: frame * -0.018,
      strokeLinecap: "round"
    })
  );
}

function MotionMarks({ x, y, frame, ink, accent, progress }) {
  const marksOpacity = interpolate(progress, [0.14, 0.28, 0.74, 0.92], [0, 1, 0.9, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const length = 150 + progress * 220;
  const marks = [-3, -2, -1, 0, 1, 2, 3].flatMap((offset, index) => {
    const yOffset = offset * 42 + Math.sin(Math.floor(frame / 2) * 1.3 + index) * 8;
    const x1 = x - 150 - index * 18;
    const x2 = x1 - length * (0.62 + (index % 3) * 0.18);
    const y2 = y + yOffset + offset * 10;
    return [
      h("line", {
        key: `motion-shadow-${index}`,
        x1,
        y1: y + yOffset,
        x2,
        y2,
        stroke: "rgba(8,8,8,.72)",
        strokeWidth: index % 2 === 0 ? 24 : 18,
        strokeLinecap: "round",
        opacity: 0.72
      }),
      h("line", {
        key: `motion-${index}`,
        x1,
        y1: y + yOffset,
        x2,
        y2,
        stroke: index % 3 === 1 ? accent : ink,
        strokeWidth: index % 3 === 1 ? 12 : 9,
        strokeLinecap: "round",
        opacity: 0.96
      })
    ];
  });
  return h("g", { opacity: marksOpacity }, ...marks);
}

function LandingBurst({ x, y, burst, frame, ink, accent }) {
  if (burst <= 0) return null;
  const rays = Array.from({ length: 16 }, (_, index) => {
    const angle = (-175 + index * 16) * Math.PI / 180;
    const inner = 58 + (index % 2) * 16;
    const outer = inner + 170 * burst + (index % 4) * 22;
    return h("line", {
      key: `ray-${index}`,
      x1: x + Math.cos(angle) * inner,
      y1: y + Math.sin(angle) * inner,
      x2: x + Math.cos(angle) * outer,
      y2: y + Math.sin(angle) * outer,
      stroke: index % 3 === 0 ? accent : ink,
      strokeWidth: index % 3 === 0 ? 15 : 9,
      strokeLinecap: "round",
      opacity: burst * (0.72 + (frame % 2) * 0.15)
    });
  });
  const ringScale = 0.4 + burst * 1.45;
  return h(
    "g",
    null,
    h("path", {
      d: "M -180 0 C -140 -55 -90 -48 -62 -104 C -18 -69 18 -118 52 -76 C 91 -106 112 -43 177 -35 C 144 8 195 43 126 63 C 90 108 37 70 4 122 C -31 79 -85 111 -104 61 C -173 58 -140 20 -180 0 Z",
      transform: `translate(${x} ${y}) scale(${ringScale}) rotate(${frame * 3})`,
      fill: "none",
      stroke: accent,
      strokeWidth: 15,
      opacity: burst * 0.86
    }),
    h("ellipse", {
      cx: x,
      cy: y,
      rx: 170 * ringScale,
      ry: 88 * ringScale,
      fill: "none",
      stroke: ink,
      strokeWidth: 18,
      strokeDasharray: "38 21 9 17",
      strokeLinecap: "round",
      opacity: burst
    }),
    ...rays
  );
}

function PaperScraps({ x, y, burst, frame, ink, accent }) {
  const amount = Math.max(0, burst);
  if (amount <= 0) return null;
  return h(
    "g",
    { opacity: amount },
    ...Array.from({ length: 12 }, (_, index) => {
      const angle = (-165 + index * 29) * Math.PI / 180;
      const distance = 90 + amount * (125 + (index % 4) * 28);
      const px = x + Math.cos(angle) * distance;
      const py = y + Math.sin(angle) * distance;
      const size = 14 + (index % 3) * 8;
      return h("rect", {
        key: `scrap-${index}`,
        x: px - size / 2,
        y: py - size / 2,
        width: size,
        height: size * (index % 2 ? 0.45 : 1.4),
        rx: index % 2 ? size * 0.2 : 0,
        fill: index % 3 === 0 ? accent : ink,
        stroke: "rgba(8,8,8,.78)",
        strokeWidth: 5,
        transform: `rotate(${frame * 9 + index * 31} ${px} ${py})`
      });
    })
  );
}

function DoodleSpark({ x, y, size, rotation, color }) {
  const points = [
    [0, -size],
    [size * 0.22, -size * 0.22],
    [size, 0],
    [size * 0.22, size * 0.22],
    [0, size],
    [-size * 0.22, size * 0.22],
    [-size, 0],
    [-size * 0.22, -size * 0.22]
  ].map(([px, py]) => `${px},${py}`).join(" ");
  return h("polygon", {
    points,
    transform: `translate(${x} ${y}) rotate(${rotation})`,
    fill: color,
    stroke: "#fff2c9",
    strokeWidth: 8,
    strokeLinejoin: "round"
  });
}

function AnalogTexture({ frame }) {
  const x = (frame * 17) % 91;
  const y = (frame * 29) % 73;
  return h(
    AbsoluteFill,
    null,
    h(AbsoluteFill, {
      style: {
        backgroundImage:
          "repeating-linear-gradient(0deg, rgba(255,255,255,.025) 0 1px, rgba(0,0,0,.018) 1px 3px)",
        mixBlendMode: "overlay",
        opacity: 0.55
      }
    }),
    h(AbsoluteFill, {
      style: {
        backgroundImage:
          "radial-gradient(circle at 15% 20%, rgba(255,255,255,.28) 0 1px, transparent 1.6px), radial-gradient(circle at 78% 64%, rgba(0,0,0,.3) 0 1px, transparent 1.8px)",
        backgroundSize: "9px 11px, 13px 15px",
        backgroundPosition: `${x}px ${y}px, ${-x}px ${-y}px`,
        mixBlendMode: "soft-light",
        opacity: 0.22
      }
    }),
    h(AbsoluteFill, {
      style: {
        boxShadow: "inset 0 0 150px rgba(0,0,0,.38), inset 0 0 22px rgba(0,0,0,.24)"
      }
    })
  );
}

function Viewfinder() {
  const corner = {
    position: "absolute",
    width: 54,
    height: 38,
    borderColor: "rgba(255,248,232,.72)",
    borderStyle: "solid"
  };
  return h(
    AbsoluteFill,
    null,
    h("div", { style: { ...corner, top: 34, left: 38, borderWidth: "3px 0 0 3px" } }),
    h("div", { style: { ...corner, top: 34, right: 38, borderWidth: "3px 3px 0 0" } }),
    h("div", { style: { ...corner, bottom: 34, left: 38, borderWidth: "0 0 3px 3px" } }),
    h("div", { style: { ...corner, bottom: 34, right: 38, borderWidth: "0 3px 3px 0" } }),
    null
  );
}

function formatTimecode(frame, fps) {
  const safeFrame = Math.max(0, frame);
  const roundedFps = Math.max(1, Math.round(fps));
  const totalSeconds = Math.floor(safeFrame / roundedFps);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const frames = safeFrame % roundedFps;
  return [minutes, seconds, frames].map((value) => String(value).padStart(2, "0")).join(":");
}
