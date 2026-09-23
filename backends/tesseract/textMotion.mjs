import { buildTesseractCaptionLayerTargets } from "./manifest.mjs";

export function buildTesseractCaptionMotionActions(manifest, input) {
  const { compositionId, textActions, width, height, fps } = input;
  if (typeof compositionId !== "string" || !compositionId) throw new Error("compositionId is required for Tesseract caption motion");
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0 || !Number.isFinite(fps) || fps <= 0) {
    throw new Error("Tesseract caption motion requires positive composition dimensions and fps");
  }
  const targets = buildTesseractCaptionLayerTargets(manifest, textActions);
  const captions = manifest.captions ?? [];
  const textByName = new Map(textActions.map((action) => [action.name, action]));
  const tracksByLayer = new Map();
  const ensureTrack = (layerId, property, neutral) => {
    const key = `${layerId}:${property}`;
    if (!tracksByLayer.has(key)) tracksByLayer.set(key, { layerId, property, neutral, segments: [] });
    return tracksByLayer.get(key);
  };

  for (const [index, caption] of captions.entries()) {
    const motion = caption.visual?.motion;
    if (!motion) continue;
    const target = targets[index];
    if (!target) throw new Error(`captions.${index} has no Tesseract text target`);
    const textAction = textByName.get(`Tsugite caption ${target.captionId}`);
    if (!textAction) throw new Error(`captions.${index} has no corresponding text layer`);
    const boxWidth = textAction.sourceText?.boxSize?.[0];
    const boxHeight = textAction.sourceText?.boxSize?.[1];
    const [baseX, baseY] = target.baselinePosition;
    const durationFrames = Math.round(target.durationMs * fps / 1000);
    const phases = ["entrance", "emphasis", "exit"];
    for (const phase of phases) {
      const cue = motion[phase];
      if (!cue) continue;
      const cueFrames = Math.max(1, Math.round((cue.duration_seconds ?? 0.5) * fps));
      const cueMs = Math.round(cueFrames * 1000 / fps);
      const startMs = phase === "entrance" ? 0
        : phase === "exit" ? target.durationMs - cueMs
        : Math.floor((target.durationMs - cueMs) / 2);
      const endMs = startMs + cueMs;
      if (cueFrames > durationFrames || startMs < 0 || endMs > target.durationMs) {
        throw new Error(`captions.${index}.visual.motion.${phase} exceeds the active text layer interval`);
      }
      const owner = `captions.${index}.visual.motion.${phase}`;
      if (cue.preset === "fade") {
        addSegment(ensureTrack(target.layerId, "opacity", 100), startMs, endMs,
          phase === "entrance" ? 0 : 100, phase === "entrance" ? 100 : 0, owner);
      } else if (cue.preset === "zoom-in" || cue.preset === "zoom-out") {
        const from = phase === "entrance" ? (cue.preset === "zoom-in" ? 80 : 120) : 100;
        const to = phase === "exit" ? (cue.preset === "zoom-in" ? 120 : 80) : 100;
        const points = phase === "emphasis"
          ? [[startMs, 100], [Math.round((startMs + endMs) / 2), 115], [endMs, 100]]
          : [[startMs, from], [endMs, to]];
        for (const property of ["scaleX", "scaleY"]) addPoints(ensureTrack(target.layerId, property, 100), points, owner);
      } else if (cue.preset === "pulse") {
        if (phase !== "emphasis") throw new Error(`${owner} uses pulse outside the emphasis phase`);
        const middleMs = Math.round((startMs + endMs) / 2);
        for (const property of ["scaleX", "scaleY"]) {
          addPoints(ensureTrack(target.layerId, property, 100), [[startMs, 100], [middleMs, 115], [endMs, 100]], owner);
        }
      } else if (["slide-left", "slide-right", "rise"].includes(cue.preset)) {
        if (!Number.isFinite(boxWidth) || !Number.isFinite(boxHeight)) throw new Error(`${owner} requires a measured text box size`);
        let fromX = baseX;
        let toX = baseX;
        let fromY = baseY;
        let toY = baseY;
        const halfBoxWidth = boxWidth / 2;
        const halfBoxHeight = boxHeight / 2;
        if (cue.preset === "slide-left") {
          if (phase === "entrance") fromX = width + halfBoxWidth;
          else toX = -halfBoxWidth;
        } else if (cue.preset === "slide-right") {
          if (phase === "entrance") fromX = -halfBoxWidth;
          else toX = width + halfBoxWidth;
        } else if (phase === "entrance") fromY = height + halfBoxHeight;
        else toY = -halfBoxHeight;
        const count = 10;
        if (cueMs < count - 1) throw new Error(`${owner} needs at least 9 ms for a verified paired text position path`);
        const xPoints = [];
        const yPoints = [];
        for (let point = 0; point < count; point += 1) {
          const fraction = point / (count - 1);
          const timeMs = startMs + Math.round(point * cueMs / (count - 1));
          xPoints.push([timeMs, fromX + ((toX - fromX) * fraction)]);
          yPoints.push([timeMs, fromY + ((toY - fromY) * fraction)]);
        }
        addPoints(ensureTrack(target.layerId, "positionX", baseX), xPoints, owner);
        addPoints(ensureTrack(target.layerId, "positionY", baseY), yPoints, owner);
      } else {
        throw new Error(`${owner} preset '${cue.preset}' has no verified Tesseract text mapping`);
      }
    }
  }

  const grouped = new Map();
  for (const track of tracksByLayer.values()) {
    const keyframes = compileTrack(track);
    if (track.property === "positionX" || track.property === "positionY") {
      if (!grouped.has(track.layerId)) grouped.set(track.layerId, {});
      grouped.get(track.layerId)[track.property] = keyframes;
    } else {
      grouped.set(`${track.layerId}:${track.property}`, { layerId: track.layerId, property: track.property, keyframes });
    }
  }

  const actions = [];
  for (const [key, track] of grouped) {
    if (typeof key === "number") {
      if (!track.positionX || !track.positionY) throw new Error(`text layer ${key} position motion requires paired X/Y keyframes`);
      actions.push({ type: "setFxPositionKeyframes", compositionId, layerId: key,
        positionX: { keyframes: track.positionX }, positionY: { keyframes: track.positionY } });
    } else {
      actions.push({ type: "setFxPropertyKeyframes", compositionId,
        property: { layerId: track.layerId, propertyType: track.property }, keyframes: track.keyframes });
    }
  }
  return actions;
}

function addSegment(track, startMs, endMs, from, to, owner) {
  addPoints(track, [[startMs, from], [endMs, to]], owner);
}

function addPoints(track, points, owner) {
  const startMs = points[0][0];
  const endMs = points.at(-1)[0];
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs) || endMs <= startMs) {
    throw new Error(`${owner} motion must span at least one millisecond`);
  }
  for (const existing of track.segments) {
    if (Math.max(startMs, existing.startMs) < Math.min(endMs, existing.endMs)) {
      throw new Error(`${owner} conflicts with ${existing.owner} on ${track.property}; overlapping text cues are unsupported`);
    }
  }
  track.segments.push({ startMs, endMs, points, owner });
}

function compileTrack(track) {
  const segments = track.segments.sort((a, b) => a.startMs - b.startMs);
  const points = [];
  let previous;
  for (const segment of segments) {
    const segmentStart = segment.points[0][1];
    if (!previous) {
      if (segment.startMs > 0) {
        points.push([0, track.neutral]);
        if (segmentStart !== track.neutral) throw new Error(`${segment.owner} starts away from the ${track.property} neutral value`);
        if (segment.startMs > 1) points.push([segment.startMs - 1, track.neutral]);
      }
    } else {
      const previousEnd = previous.points.at(-1)[1];
      if (previousEnd !== segmentStart) throw new Error(`${segment.owner} cannot follow ${previous.owner} on ${track.property}; the gap would introduce unrequested motion`);
      if (segment.startMs - previous.endMs > 1) points.push([segment.startMs - 1, previousEnd]);
    }
    points.push(...segment.points);
    previous = segment;
  }
  const deduped = [];
  for (const [layerTime, value] of points) {
    const item = { layerTime, value };
    const prior = deduped.at(-1);
    if (prior?.layerTime === layerTime) {
      if (prior.value !== value) throw new Error(`conflicting ${track.property} keyframes at ${layerTime} ms`);
      continue;
    }
    deduped.push(item);
  }
  return deduped.map(({ layerTime, value }, index) => ({
    id: `tsugite-text-${track.layerId}-${track.property}-${index + 1}`,
    layerTime,
    value: { type: "float", value: Number(value.toFixed(6)) },
    easing: { type: "linear" }
  }));
}
