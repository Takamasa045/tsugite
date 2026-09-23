const VIDEO_SUFFIXES = new Set([".mp4", ".mov", ".m4v"]);
const AUDIO_SUFFIXES = new Set([".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"]);
const CLIP_KEYS = new Set(["id", "src", "in", "out", "duration", "fps", "resolution", "audio", "motion"]);
const TRACK_KEYS = new Set(["id", "src", "start", "end", "volume"]);
const CAPTION_KEYS = new Set(["id", "text", "speaker", "start", "end", "pose", "emphasis", "visual"]);
const CAPTION_VISUAL_KEYS = new Set(["headline", "badges", "motion"]);
const PRESENTATION_KEYS = new Set(["preset", "required_aspect", "title", "source_title", "source_url", "draft", "motion_design"]);
const AUDIO_GROUPS = new Set(["bgm", "narration", "sfx"]);
const MOTION_KEYS = new Set(["entrance", "emphasis", "exit", "transition_to_next", "audio_reactive", "implementation_notes"]);
const MOTION_CUE_KEYS = new Set(["preset", "label", "description", "target", "duration_seconds", "easing"]);
const MOTION_PHASES = ["entrance", "emphasis", "exit", "transition_to_next"];
const DEFAULT_MOTION_DURATION_SECONDS = 0.5;
const MANIFEST_KEYS = new Set([
  "fast_edit", "meta", "clips", "images", "speakers", "presentation", "audio",
  "master_audio_binding", "caption_binding", "chapter_binding", "captions", "chapters", "provenance"
]);
const META_KEYS = new Set(["aspect", "fps", "target_duration_seconds", "slug"]);

export function assertSupportedManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("manifest must be an object");
  if (manifest.transitions !== undefined) throw new Error("Tesseract does not support top-level manifest.transitions; use a supported clips[].motion.transition_to_next cue");
  rejectUnknownKeys(manifest, MANIFEST_KEYS, "manifest");
  rejectUnknownKeys(manifest.meta, META_KEYS, "meta");
  if (!Number.isFinite(manifest.meta?.target_duration_seconds) || manifest.meta.target_duration_seconds <= 0) {
    throw new Error("meta.target_duration_seconds must be a positive finite duration in seconds");
  }
  if (!Array.isArray(manifest.clips) || manifest.clips.length === 0) throw new Error("Tesseract requires at least one video clip");
  if (manifest.fast_edit) throw new Error("Tesseract does not support Fast Edit");
  if ((manifest.images?.length ?? 0) > 0) throw new Error("Tesseract backend does not yet support manifest images");
  if ((manifest.speakers?.length ?? 0) > 0) throw new Error("Tesseract backend does not yet support speaker artwork");
  if ((manifest.chapters?.length ?? 0) > 0) throw new Error("Tesseract backend does not yet support chapter cards");
  if (manifest.presentation && manifest.presentation.preset !== "tesseract-basic") {
    throw new Error("Tesseract supports only the 'tesseract-basic' presentation preset");
  }
  if (manifest.presentation) {
    rejectUnknownKeys(manifest.presentation, PRESENTATION_KEYS, "presentation");
    if (manifest.presentation.required_aspect && manifest.presentation.required_aspect !== manifest.meta.aspect) {
      throw new Error("presentation.required_aspect does not match the Tesseract composition aspect");
    }
    if (manifest.presentation.motion_design) {
      rejectUnknownKeys(manifest.presentation.motion_design, new Set(["summary", "pacing", "principles"]), "presentation.motion_design");
    }
  }
  if (!["16:9", "9:16"].includes(manifest.meta?.aspect)) throw new Error("Tesseract requires a supported 16:9 or 9:16 aspect ratio");
  if (!Number.isFinite(manifest.meta?.fps) || manifest.meta.fps !== 30) {
    throw new Error("Tesseract export uses an automatic frame rate; this adapter currently accepts only 30 fps and will verify the encoded rate");
  }

  const clipIds = new Set();
  for (const [index, clip] of manifest.clips.entries()) {
    rejectUnknownKeys(clip, CLIP_KEYS, `clips.${index}`);
    if (typeof clip.id !== "string" || !clip.id) throw new Error(`clips.${index}.id must be a non-empty string`);
    if (clipIds.has(clip.id)) throw new Error(`Tesseract motion requires unique clip ids; duplicate '${clip.id}'`);
    clipIds.add(clip.id);
    validateClipMotion(
      clip.motion,
      index,
      clip.duration,
      manifest.meta.fps,
      index < manifest.clips.length - 1 ? manifest.clips[index + 1]?.duration : undefined
    );
    if (!VIDEO_SUFFIXES.has(extension(clip.src))) throw new Error(`clips.${index}.src must be a local MP4, MOV, or M4V file`);
    if (!Number.isFinite(clip.in) || clip.in < 0 || !Number.isFinite(clip.out) || clip.out <= clip.in) {
      throw new Error(`clips.${index} has an invalid source interval`);
    }
    if (!Number.isFinite(clip.duration) || Math.abs(clip.duration - (clip.out - clip.in)) > 0.01) {
      throw new Error(`clips.${index}.duration must match out - in; speed changes are not supported`);
    }
    if (clip.fps !== undefined && (!Number.isFinite(clip.fps) || clip.fps <= 0)) throw new Error(`clips.${index}.fps must be positive`);
    if (clip.resolution !== undefined && (!Number.isInteger(clip.resolution.width) || clip.resolution.width <= 0 || !Number.isInteger(clip.resolution.height) || clip.resolution.height <= 0)) {
      throw new Error(`clips.${index}.resolution must contain positive integer width and height`);
    }
    if (clip.audio !== true && clip.audio !== false) throw new Error(`clips.${index}.audio must explicitly select embedded source audio`);
  }

  let timelineStartMs = 0;
  const validationClipLayers = manifest.clips.map((clip, index) => {
    const layer = {
      clipId: clip.id,
      layerId: index + 1,
      timelineStartMs,
      durationMs: Math.round(clip.duration * 1000),
      sourceStartMs: Math.round(clip.in * 1000)
    };
    timelineStartMs += layer.durationMs;
    return layer;
  });
  buildTesseractMotionActions(manifest, { compositionId: "main", clipLayers: validationClipLayers });

  const executableMotionCueCount = manifest.clips.reduce((count, clip) =>
    count + MOTION_PHASES.filter((phase) => clip.motion?.[phase]).length + Number(Boolean(clip.motion?.audio_reactive)), 0) +
    (manifest.captions ?? []).reduce((count, caption) => count +
      ["entrance", "emphasis", "exit"].filter((phase) => caption.visual?.motion?.[phase]).length +
      Number(Boolean(caption.visual?.motion?.audio_reactive)), 0);
  if (manifest.presentation?.motion_design) {
    if (executableMotionCueCount === 0) {
      throw new Error("presentation.motion_design is descriptive only; add a supported clips[].motion cue to specify executable motion");
    }
    if ((manifest.presentation.motion_design.principles?.length ?? 0) > 0) {
      throw new Error("presentation.motion_design.principles contains guidance that Tesseract cannot verify or execute; express supported actions as clip motion cues");
    }
  }

  for (const group of Object.keys(manifest.audio ?? {})) {
    if (!AUDIO_GROUPS.has(group)) throw new Error(`audio.${group} is not supported by the Tesseract renderer`);
  }
  for (const [group, entries] of Object.entries(manifest.audio ?? {})) {
    if (!Array.isArray(entries)) throw new Error(`audio.${group} must be an array`);
    for (const [index, track] of entries.entries()) {
      rejectUnknownKeys(track, TRACK_KEYS, `audio.${group}.${index}`);
      if (typeof track.src !== "string" || !track.src) throw new Error(`audio.${group}.${index}.src must point to a local audio file`);
      if (!AUDIO_SUFFIXES.has(extension(track.src))) throw new Error(`audio.${group}.${index}.src must be a supported audio file`);
      if (!Number.isFinite(track.start ?? 0) || (track.start ?? 0) < 0) throw new Error(`audio.${group}.${index}.start must be a non-negative timeline time`);
      if (track.end !== undefined && (!Number.isFinite(track.end) || track.end <= (track.start ?? 0))) {
        throw new Error(`audio.${group}.${index}.end must be greater than its timeline start`);
      }
      if (track.volume !== undefined && (!Number.isFinite(track.volume) || track.volume < 0)) {
        throw new Error(`audio.${group}.${index}.volume must be a finite non-negative linear gain`);
      }
    }
  }
  assertAudioReactiveSourceTracks(manifest);

  const captionActionNames = new Set();
  for (const [index, caption] of (manifest.captions ?? []).entries()) {
    rejectUnknownKeys(caption, CAPTION_KEYS, `captions.${index}`);
    const captionId = caption.id ?? String(index + 1);
    const captionActionName = `Tsugite caption ${captionId}`;
    if (captionActionNames.has(captionActionName)) throw new Error(`Tesseract caption layer names must be unique; duplicate '${captionActionName}'`);
    captionActionNames.add(captionActionName);
    if (caption.speaker || caption.pose || (caption.emphasis?.length ?? 0) > 0) {
      throw new Error(`captions.${index} includes speaker, pose, or emphasis styling that Tesseract does not support yet`);
    }
    if (typeof caption.text !== "string" || caption.text.length === 0 || !Number.isFinite(caption.start) || !Number.isFinite(caption.end) || caption.start < 0 || caption.end <= caption.start) {
      throw new Error(`captions.${index} must have text and a valid timeline interval`);
    }
    if (caption.visual) {
      const visualPath = `captions.${index}.visual`;
      if (caption.visual.image_id || caption.visual.kicker || caption.visual.detail || (caption.visual.badges?.length ?? 0) > 0) {
        throw new Error(`${visualPath} includes visual styling that Tesseract does not support yet`);
      }
      rejectUnknownKeys(caption.visual, CAPTION_VISUAL_KEYS, visualPath);
      if (caption.visual.headline !== caption.text) throw new Error(`${visualPath}.headline must exactly match captions.${index}.text; differing headline text is unsupported visual styling`);
      if (caption.visual.motion) {
        rejectUnknownKeys(caption.visual.motion, new Set(["entrance", "emphasis", "exit", "audio_reactive", "implementation_notes"]), `${visualPath}.motion`);
        if ((caption.visual.motion.implementation_notes?.length ?? 0) > 0) {
          throw new Error(`${visualPath}.motion.implementation_notes contains visual instructions that Tesseract cannot verify`);
        }
        validateCaptionMotion(caption.visual.motion, index, caption.end - caption.start, manifest.meta.fps);
      }
    }
  }
  assertNoAudioReactiveMotionConflicts(manifest);

  return { width: manifest.meta.aspect === "16:9" ? 1920 : 1080, height: manifest.meta.aspect === "16:9" ? 1080 : 1920 };
}

export function buildTesseractMotionActions(manifest, options) {
  const { compositionId, clipLayers } = options;
  if (typeof compositionId !== "string" || !compositionId) throw new Error("compositionId is required to build Tesseract motion actions");
  if (!Array.isArray(clipLayers) || clipLayers.length !== manifest.clips.length) throw new Error("clip layer metadata does not match the manifest timeline");

  const clipIds = new Set();
  for (const [index, clip] of manifest.clips.entries()) {
    if (clipIds.has(clip.id)) throw new Error(`Tesseract motion requires unique clip ids; duplicate '${clip.id}'`);
    clipIds.add(clip.id);
    if (clipLayers[index]?.clipId !== clip.id) throw new Error(`clips.${index} has no matching Tesseract video layer`);
  }

  const tracksByLayer = new Map();
  const track = (layerId, propertyType) => {
    const key = `${layerId}:${propertyType}`;
    if (!tracksByLayer.has(key)) tracksByLayer.set(key, { layerId, propertyType, segments: [] });
    return tracksByLayer.get(key);
  };
  const addSegment = (layerId, propertyType, startFrame, endFrame, startValue, endValue, owner) => {
    const value = track(layerId, propertyType);
    if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || endFrame <= startFrame) {
      throw new Error(`${owner} motion must span at least one output frame`);
    }
    const next = { startFrame, endFrame, startValue, endValue, owner };
    for (const existing of value.segments) {
      if (next.startFrame === existing.startFrame && next.endFrame === existing.endFrame &&
          next.startValue === existing.startValue && next.endValue === existing.endValue) return;
      if (Math.max(next.startFrame, existing.startFrame) < Math.min(next.endFrame, existing.endFrame)) {
        throw new Error(`${owner} conflicts with ${existing.owner} on ${propertyType}; overlapping motion cues are not supported`);
      }
    }
    value.segments.push(next);
  };

  const actions = [];
  for (const [index, clip] of manifest.clips.entries()) {
    const layer = clipLayers[index];
    if (!layer || layer.clipId !== clip.id || !Number.isInteger(layer.layerId) || !Number.isInteger(layer.durationMs) || layer.durationMs <= 0 ||
        !Number.isInteger(layer.sourceStartMs) || !Number.isInteger(layer.timelineStartMs)) {
      throw new Error(`clips.${index} has no matching Tesseract video layer`);
    }
    const clipFrames = Math.round((layer.durationMs / 1000) * manifest.meta.fps);
    const motion = clip.motion;
    if (!motion) continue;

    if (motion.entrance) addCue(motion.entrance, "entrance", layer, clipFrames, manifest.meta.fps, addSegment);
    if (motion.emphasis) addCue(motion.emphasis, "emphasis", layer, clipFrames, manifest.meta.fps, addSegment);
    if (motion.exit) addCue(motion.exit, "exit", layer, clipFrames, manifest.meta.fps, addSegment);

    if (motion.transition_to_next) {
      if (index >= manifest.clips.length - 1) throw new Error(`clips.${index}.motion.transition_to_next has no following clip`);
      const nextLayer = clipLayers[index + 1];
      if (!nextLayer || nextLayer.clipId !== manifest.clips[index + 1].id) throw new Error(`clips.${index + 1} has no matching Tesseract video layer`);
      const cue = motion.transition_to_next;
      const totalFrames = cueFrameCount(cue, manifest.meta.fps, `clips.${index}.motion.transition_to_next`);
      const transitionOutMs = layer.transitionOutMs ?? Math.round(totalFrames * 1000 / manifest.meta.fps);
      if (totalFrames > clipFrames || totalFrames > Math.round((nextLayer.durationMs / 1000) * manifest.meta.fps)) {
        throw new Error(`clips.${index}.motion.transition_to_next duration exceeds an adjacent clip`);
      }
      const sourceEndMs = layer.sourceStartMs + layer.durationMs - 1;
      actions.push({
        type: "setFxLayerTimeRemap",
        compositionId,
        layerId: layer.layerId,
        timeRemap: {
          keyframes: [
            {
              id: `tsugite-layer-${layer.layerId}-hold-start`,
              time: layer.timelineStartMs,
              value: layer.sourceStartMs,
              easing: { type: "linear" }
            },
            {
              id: `tsugite-layer-${layer.layerId}-hold-source-end`,
              time: layer.timelineStartMs + layer.durationMs,
              value: sourceEndMs,
              easing: { type: "linear" }
            },
            {
              id: `tsugite-layer-${layer.layerId}-hold-active-end`,
              time: layer.timelineStartMs + layer.durationMs + transitionOutMs,
              value: sourceEndMs,
              easing: { type: "linear" }
            }
          ],
          before: "inactive",
          after: "hold"
        }
      });
      const transitionOwner = `clips.${index}.motion.transition_to_next`;
      if (cue.preset === "fade") {
        addSegment(nextLayer.layerId, "opacity", 0, totalFrames, 0, 100, transitionOwner);
      } else if (cue.preset === "slide-left" || cue.preset === "slide-right") {
        const dimensions = tesseractDimensions(manifest.meta.aspect);
        const baselinePosition = [dimensions.width / 2, dimensions.height / 2];
        actions.push(buildSlidePositionAction({
          compositionId,
          layerId: nextLayer.layerId,
          durationMs: Math.round(totalFrames * 1000 / manifest.meta.fps),
          fromX: baselinePosition[0] + (cue.preset === "slide-left" ? dimensions.width : -dimensions.width),
          toX: baselinePosition[0],
          y: baselinePosition[1],
          owner: transitionOwner
        }));
      } else if (cue.preset === "zoom-in" || cue.preset === "zoom-out") {
        const from = cue.preset === "zoom-in" ? 80 : 120;
        const to = 100;
        const endTime = Math.round(totalFrames * 1000 / manifest.meta.fps);
        for (const propertyType of ["scaleX", "scaleY"]) {
          actions.push({
            type: "setFxPropertyKeyframes",
            compositionId,
            property: { layerId: nextLayer.layerId, propertyType },
            keyframes: [
              { id: `tsugite-${transitionOwner}-start-${propertyType}`, layerTime: 0, value: { type: "float", value: from }, easing: { type: "linear" } },
              { id: `tsugite-${transitionOwner}-end-${propertyType}`, layerTime: endTime, value: { type: "float", value: to }, easing: { type: "linear" } }
            ]
          });
        }
      } else {
        throw new Error(`${transitionOwner}.preset '${cue.preset}' has no verified Tesseract transition mapping`);
      }
    }
  }

  for (const { layerId, propertyType, segments } of tracksByLayer.values()) {
    const keyframes = [];
    const orderedSegments = segments.sort((a, b) => a.startFrame - b.startFrame);
    for (let index = 0; index < orderedSegments.length; index += 1) {
      const segment = orderedSegments[index];
      const previousSegment = orderedSegments[index - 1];
      if (index === 0 && segment.startFrame > 0) {
        const neutral = neutralMotionValue(propertyType);
        if (segment.startValue !== neutral) {
          throw new Error(`${segment.owner} begins away from the ${propertyType} neutral value, so Tesseract cannot hold the property before the cue`);
        }
        keyframes.push({ frame: 0, value: neutral });
        if (segment.startFrame - 1 > 0) keyframes.push({ frame: segment.startFrame - 1, value: neutral });
      }
      if (previousSegment) {
        if (previousSegment.endValue !== segment.startValue) {
          throw new Error(`${segment.owner} cannot connect to ${previousSegment.owner} on ${propertyType}: the boundary values differ and linear interpolation would add unrequested motion`);
        }
        if (segment.startFrame - previousSegment.endFrame > 1) {
          // Keep the property explicitly fixed through the gap before the next cue begins.
          keyframes.push({ frame: segment.startFrame - 1, value: previousSegment.endValue });
        }
      }
      keyframes.push({ frame: segment.startFrame, value: segment.startValue }, { frame: segment.endFrame, value: segment.endValue });
    }
    const deduped = [];
    for (const frameValue of keyframes) {
      const previous = deduped.at(-1);
      if (previous?.frame === frameValue.frame) {
        if (previous.value !== frameValue.value) throw new Error(`conflicting ${propertyType} keyframes at frame ${frameValue.frame}`);
        continue;
      }
      deduped.push(frameValue);
    }
    actions.push({
      type: "setFxPropertyKeyframes",
      compositionId,
      property: { layerId, propertyType },
      keyframes: deduped.map(({ frame, value }, index) => ({
        id: `tsugite-layer-${layerId}-${propertyType}-${index + 1}`,
        layerTime: Math.round(frame * 1000 / manifest.meta.fps),
        value: { type: "float", value },
        easing: { type: "linear" }
      }))
    });
  }
  assertNoConflictingKeyframeActions(actions);
  return actions;
}

export function describeTesseractMotion(manifest) {
  const cues = [];
  const audioReactive = [];
  for (const clip of manifest.clips) {
    for (const phase of MOTION_PHASES) {
      const cue = clip.motion?.[phase];
      if (!cue) continue;
      cues.push({
        target_type: "clip",
        target_id: clip.id,
        phase,
        preset: cue.preset,
        duration_seconds: cueDurationSeconds(cue),
        easing: "linear",
        description: cue.description
      });
    }
    if (clip.motion?.audio_reactive) {
      const cue = clip.motion.audio_reactive;
      audioReactive.push({
        target_type: "clip",
        target_id: clip.id,
        source_track_id: cue.source_track_id,
        mode: cue.mode,
        strength: cue.strength,
        measurement_window_ms: cue.measurement_window_ms,
        method: "precomputed local PCM envelope and editable Tesseract keyframes"
      });
    }
  }
  for (const [index, caption] of (manifest.captions ?? []).entries()) {
    const cue = caption.visual?.motion?.audio_reactive;
    if (cue) {
      audioReactive.push({
        target_type: "caption",
        target_id: caption.id ?? String(index + 1),
        source_track_id: cue.source_track_id,
        mode: cue.mode,
        strength: cue.strength,
        measurement_window_ms: cue.measurement_window_ms,
        method: "precomputed local PCM envelope and editable Tesseract keyframes"
      });
    }
    for (const phase of ["entrance", "emphasis", "exit"]) {
      const motionCue = caption.visual?.motion?.[phase];
      if (!motionCue) continue;
      cues.push({
        target_type: "caption",
        target_id: caption.id ?? String(index + 1),
        phase,
        preset: motionCue.preset,
        duration_seconds: cueDurationSeconds(motionCue),
        easing: "linear",
        description: motionCue.description
      });
    }
  }
  if (cues.length === 0 && audioReactive.length === 0) return undefined;
  const declared = manifest.presentation?.motion_design;
  return {
    applied_cues: cues,
    ...(audioReactive.length > 0 ? { audio_reactive: audioReactive } : {}),
    ...(declared ? { declared_design: { summary: declared.summary, ...(declared.pacing ? { pacing: declared.pacing } : {}) } } : {})
  };
}

export function buildTesseractDocumentLayers(manifest, options) {
  const { assetIds, sourceInfo, durationSeconds } = options;
  const dimensions = tesseractDimensions(manifest.meta.aspect);
  assertTesseractInputDimensions(manifest, sourceInfo, dimensions);
  const baselinePosition = [dimensions.width / 2, dimensions.height / 2];
  const videoLayers = [];
  const clipLayers = [];
  let cursor = 0;
  for (const [index, clip] of manifest.clips.entries()) {
    const media = sourceInfo.get(clip.src);
    if (!media?.hasVideo) throw new Error(`clips.${index}.src has no video stream`);
    if (clip.audio && !media.hasAudio) throw new Error(`clips.${index}.audio is true but the source has no audio stream`);
    const sourceDurationMs = Math.round((media.videoDurationSeconds ?? media.durationSeconds) * 1000);
    const sourceStartMs = Math.round(clip.in * 1000);
    const durationMs = Math.round(clip.duration * 1000);
    if (sourceStartMs + durationMs > sourceDurationMs + 20) throw new Error(`clips.${index} source interval exceeds the probed media duration`);
    const transitionOutMs = clip.motion?.transition_to_next
      ? Math.round(cueFrameCount(clip.motion.transition_to_next, manifest.meta.fps, `clips.${index}.motion.transition_to_next`) * 1000 / manifest.meta.fps)
      : 0;
    const layer = {
      type: "Video",
      id: index + 1,
      name: `Tsugite clip ${clip.id}`,
      activeRange: { start: Math.round(cursor * 1000), duration: durationMs + transitionOutMs },
      sourceRange: { start: sourceStartMs, duration: durationMs },
      sourceIntrinsicDuration: sourceDurationMs,
      transform: centeredVideoTransform(dimensions),
      source: { assetId: requiredAssetId(assetIds, clip.src), fit: "contain" }
    };
    if (clip.audio) layer.volume = 1.0;
    videoLayers.push(layer);
    clipLayers.push({
      clipId: clip.id,
      layerId: layer.id,
      timelineStartMs: layer.activeRange.start,
      durationMs,
      sourceStartMs,
      transitionOutMs,
      baselinePosition: [...baselinePosition]
    });
    cursor += clip.duration;
  }

  const actualTimelineDuration = Math.max(manifest.meta.target_duration_seconds, cursor);
  if (Math.abs(actualTimelineDuration - durationSeconds) > 0.001) throw new Error("internal duration mismatch while constructing Tesseract layers");
  const audioLayers = [];
  let nextId = videoLayers.length + 1;
  for (const group of ["bgm", "narration", "sfx"]) {
    for (const [index, track] of (manifest.audio?.[group] ?? []).entries()) {
      const media = sourceInfo.get(track.src);
      if (!media?.hasAudio) throw new Error(`audio.${group}.${index}.src has no audio stream`);
      const start = track.start ?? 0;
      const end = track.end ?? actualTimelineDuration;
      if (start >= actualTimelineDuration || end > actualTimelineDuration + 0.01) throw new Error(`audio.${group}.${index} timeline range exceeds the composition duration`);
      const sourceDuration = end - start;
      const sourceDurationSeconds = media.audioDurationSeconds ?? media.durationSeconds;
      if (sourceDuration > sourceDurationSeconds + 0.02) throw new Error(`audio.${group}.${index} requires ${sourceDuration.toFixed(3)}s but its source is only ${sourceDurationSeconds.toFixed(3)}s`);
      audioLayers.push({
        type: "Audio",
        id: nextId++,
        name: `Tsugite ${group} ${track.id ?? index + 1}`,
        activeRange: { start: Math.round(start * 1000), duration: Math.round(sourceDuration * 1000) },
        sourceRange: { start: 0, duration: Math.round(sourceDuration * 1000) },
        sourceIntrinsicDuration: Math.round(sourceDurationSeconds * 1000),
        source: { assetId: requiredAssetId(assetIds, track.src) },
        volume: track.volume ?? 1,
        captionsEnabled: false
      });
    }
  }
  return { layers: [...videoLayers.toReversed(), ...audioLayers], clipLayers, durationSeconds: actualTimelineDuration, nextLayerId: nextId };
}

export function assertTesseractInputDimensions(manifest, sourceInfo, dimensions = tesseractDimensions(manifest.meta.aspect)) {
  for (const [index, clip] of manifest.clips.entries()) {
    const media = sourceInfo.get(clip.src);
    if (!Number.isInteger(media?.width) || !Number.isInteger(media?.height) || media.width <= 0 || media.height <= 0) {
      throw new Error(`clips.${index}.src video dimensions could not be confirmed; Tesseract 0.1.0 export requires each source clip to match ${dimensions.width}x${dimensions.height}`);
    }
    if (media.width !== dimensions.width || media.height !== dimensions.height) {
      throw new Error(`clips.${index}.src is ${media.width}x${media.height}; Tesseract 0.1.0 export preserves source dimensions and requires ${dimensions.width}x${dimensions.height}`);
    }
  }
}

export function buildTesseractTextActions(manifest, options) {
  const { compositionId, firstLayerId, fontFamily, fontStyle, width, height, durationSeconds } = options;
  const captions = manifest.captions ?? [];
  const title = manifest.presentation?.title;
  if (!title && captions.length === 0) return [];
  if (!fontFamily || !fontStyle) throw new Error("Tesseract title/captions require a local font imported from edit.backend_options.tesseract.font_path");
  const result = [];
  let layerId = firstLayerId;
  if (title) {
    result.push(textAction({
      compositionId,
      layerId: layerId++,
      name: "Tsugite title",
      text: title,
      start: 0,
      duration: Math.min(3, durationSeconds),
      fontFamily,
      fontStyle,
      width,
      height,
      kind: "title"
    }));
  }
  for (const [index, caption] of captions.entries()) {
    if (caption.end > durationSeconds + 0.01) throw new Error(`captions.${index} extends past the composition duration`);
    result.push(textAction({
      compositionId,
      layerId: layerId++,
      name: `Tsugite caption ${caption.id ?? index + 1}`,
      text: caption.text,
      start: caption.start,
      duration: caption.end - caption.start,
      fontFamily,
      fontStyle,
      width,
      height,
      kind: "caption"
    }));
  }
  return result;
}

export function buildTesseractCaptionLayerTargets(manifest, textActions) {
  const captions = manifest.captions ?? [];
  const actions = textActions.filter((action) => typeof action.name === "string" && action.name.startsWith("Tsugite caption "));
  if (actions.length !== captions.length) throw new Error("Tesseract caption text actions do not match the manifest captions");
  const targets = [];
  const seenNames = new Set();
  for (const [index, caption] of captions.entries()) {
    const captionId = caption.id ?? String(index + 1);
    const expectedName = `Tsugite caption ${captionId}`;
    if (seenNames.has(expectedName)) throw new Error(`Tesseract caption layer names must be unique; duplicate '${expectedName}'`);
    seenNames.add(expectedName);
    const action = actions[index];
    if (action?.name !== expectedName || !Number.isInteger(action.layerId) ||
        !Number.isFinite(action.activeRange?.start) || !Number.isFinite(action.activeRange?.duration) ||
        !Array.isArray(action.transform?.position) || action.transform.position.length !== 2 ||
        !action.transform.position.every(Number.isFinite)) {
      throw new Error(`captions.${index} has no matching Tesseract text layer metadata`);
    }
    targets.push({
      captionId,
      layerId: action.layerId,
      timelineStartMs: action.activeRange.start,
      durationMs: action.activeRange.duration,
      baselinePosition: [...action.transform.position]
    });
  }
  return targets;
}

export function assertNoConflictingKeyframeActions(...actionGroups) {
  const owners = new Map();
  for (const action of actionGroups.flat()) {
    const tracks = action.type === "setFxPropertyKeyframes"
      ? [`${action.property?.layerId}:${action.property?.propertyType}`]
      : action.type === "setFxPositionKeyframes"
        ? ["positionX", "positionY"].filter((key) => action[key]).map((key) => `${action.layerId}:${key}`)
        : [];
    for (const track of tracks) {
      const previous = owners.get(track);
      if (previous) throw new Error(`conflicting Tesseract motion actions target the same keyframe property '${track}'; combine or remove one cue`);
      owners.set(track, action);
    }
  }
}

function textAction(input) {
  const title = input.kind === "title";
  const boxSize = title ? [Math.round(input.width * 0.84), Math.round(input.height * 0.22)] : [Math.round(input.width * 0.84), Math.round(input.height * 0.12)];
  const boxPosition = title ? [Math.round(input.width * 0.08), Math.round(input.height * 0.28)] : [Math.round(input.width * 0.08), Math.round(input.height * 0.80)];
  const anchorPoint = [boxSize[0] / 2, boxSize[1] / 2];
  const position = [boxPosition[0] + anchorPoint[0], boxPosition[1] + anchorPoint[1]];
  return {
    type: "createFxTextLayer",
    compositionId: input.compositionId,
    layerId: input.layerId,
    insertIndex: 0,
    name: input.name,
    activeRange: { start: Math.round(input.start * 1000), duration: Math.round(input.duration * 1000) },
    transform: { anchorPoint, position, scale: [100, 100], rotation: 0, opacity: 100 },
    sourceText: {
      text: input.text,
      fontFamily: input.fontFamily,
      fontStyle: input.fontStyle,
      fontSize: Math.round(input.height * (title ? 0.075 : 0.033)),
      fillColor: [1, 1, 1, 1],
      justification: "center",
      boxText: true,
      boxPosition: [0, 0],
      boxSize
    }
  };
}

function validateClipMotion(motion, clipIndex, clipDuration, fps, nextClipDuration) {
  if (motion === undefined) return;
  const path = `clips.${clipIndex}.motion`;
  if (!motion || typeof motion !== "object" || Array.isArray(motion)) throw new Error(`${path} must be an object`);
  rejectUnknownKeys(motion, MOTION_KEYS, path);
  if ((motion.implementation_notes?.length ?? 0) > 0) {
    throw new Error(`${path}.implementation_notes contains visual instructions that Tesseract cannot verify; encode supported actions as motion cues`);
  }
  if (motion.audio_reactive !== undefined) {
    validateAudioReactiveCue(motion.audio_reactive, `${path}.audio_reactive`);
  }
  for (const phase of MOTION_PHASES) {
    const cue = motion[phase];
    if (cue === undefined) continue;
    if (!cue || typeof cue !== "object" || Array.isArray(cue)) throw new Error(`${path}.${phase} must be an object`);
    rejectUnknownKeys(cue, MOTION_CUE_KEYS, `${path}.${phase}`);
    const supportedPresets = phase === "transition_to_next"
      ? ["fade", "slide-left", "slide-right", "zoom-in", "zoom-out"]
      : phase === "emphasis" ? ["pulse"] : ["fade", "zoom-in", "zoom-out"];
    if (!supportedPresets.includes(cue.preset)) {
      throw new Error(`${path}.${phase}.preset '${cue.preset}' is not supported by Tesseract; supported presets: ${supportedPresets.join(", ")}`);
    }
    if ((cue.target ?? "frame") !== "frame") throw new Error(`${path}.${phase}.target '${cue.target}' is not supported; Tesseract motion targets the complete video frame`);
    if (cue.easing !== undefined && cue.easing !== "linear") {
      throw new Error(`${path}.${phase}.easing '${cue.easing}' is not verified by the pinned Tesseract renderer; use linear or omit it`);
    }
    const frames = cueFrameCount(cue, fps, `${path}.${phase}`);
    const clipFrames = Math.round(clipDuration * fps);
    if (frames > clipFrames) throw new Error(`${path}.${phase}.duration_seconds exceeds the clip duration`);
    if (phase === "transition_to_next") {
      if (nextClipDuration === undefined) throw new Error(`${path}.transition_to_next has no following clip`);
      if (frames > Math.round(nextClipDuration * fps)) throw new Error(`${path}.transition_to_next duration exceeds the following clip`);
    }
    if (phase === "emphasis" && frames < 2) throw new Error(`${path}.emphasis requires at least two output frames`);
  }
}

function validateCaptionMotion(motion, captionIndex, captionDuration, fps) {
  const path = `captions.${captionIndex}.visual.motion`;
  for (const phase of ["entrance", "emphasis", "exit"]) {
    const cue = motion[phase];
    if (cue === undefined) continue;
    if (!cue || typeof cue !== "object" || Array.isArray(cue)) throw new Error(`${path}.${phase} must be an object`);
    rejectUnknownKeys(cue, MOTION_CUE_KEYS, `${path}.${phase}`);
    const supported = phase === "emphasis" ? ["pulse"] : ["fade", "slide-left", "slide-right", "rise", "zoom-in", "zoom-out"];
    if (!supported.includes(cue.preset)) throw new Error(`${path}.${phase}.preset '${cue.preset}' is unsupported for Tesseract text; supported: ${supported.join(", ")}`);
    if (cue.target !== undefined && cue.target !== "text") throw new Error(`${path}.${phase}.target must be 'text' for Tesseract caption motion`);
    if (cue.easing !== undefined && cue.easing !== "linear") throw new Error(`${path}.${phase}.easing '${cue.easing}' is not verified for Tesseract text motion; use linear or omit it`);
    const frames = cueFrameCount(cue, fps, `${path}.${phase}`);
    if (frames > Math.round(captionDuration * fps)) throw new Error(`${path}.${phase}.duration_seconds exceeds the caption duration`);
    if (phase === "emphasis" && frames < 2) throw new Error(`${path}.emphasis requires at least two output frames`);
  }
  if (motion.audio_reactive !== undefined) validateAudioReactiveCue(motion.audio_reactive, `${path}.audio_reactive`);
}

function validateAudioReactiveCue(cue, cuePath) {
  if (!cue || typeof cue !== "object" || Array.isArray(cue)) throw new Error(`${cuePath} must be an object`);
  rejectUnknownKeys(cue, new Set(["source_track_id", "mode", "strength", "measurement_window_ms"]), cuePath);
  if (typeof cue.source_track_id !== "string" || !cue.source_track_id) throw new Error(`${cuePath}.source_track_id must name an audio track`);
  if (!["pulse", "shake", "flicker"].includes(cue.mode)) {
    throw new Error(`${cuePath}.mode '${cue.mode}' is not supported; Tesseract supports pulse, shake, and flicker`);
  }
  if (!Number.isFinite(cue.strength) || cue.strength < 0 || cue.strength > 1) throw new Error(`${cuePath}.strength must be from 0 to 1`);
  if (!Number.isInteger(cue.measurement_window_ms) || cue.measurement_window_ms < 20 || cue.measurement_window_ms > 2_000) {
    throw new Error(`${cuePath}.measurement_window_ms must be an integer from 20 to 2000`);
  }
}

function assertNoAudioReactiveMotionConflicts(manifest) {
  const propertiesForMode = {
    pulse: new Set(["scaleX", "scaleY"]),
    shake: new Set(["positionX", "positionY"]),
    flicker: new Set(["opacity"])
  };
  const propertiesForPreset = (preset) => {
    if (preset === "fade") return new Set(["opacity"]);
    if (["zoom-in", "zoom-out", "pulse"].includes(preset)) return new Set(["scaleX", "scaleY"]);
    if (["slide-left", "slide-right", "rise"].includes(preset)) return new Set(["positionX", "positionY"]);
    return new Set();
  };
  const assertNoConflict = (cue, otherCues, path) => {
    if (!cue) return;
    const reactiveProperties = propertiesForMode[cue.mode] ?? new Set();
    for (const other of otherCues) {
      if (!other) continue;
      const overlap = [...propertiesForPreset(other.preset)].filter((property) => reactiveProperties.has(property));
      if (overlap.length > 0) throw new Error(`${path} conflicts with another cue on ${overlap.join(", ")}; Tesseract requires one motion writer per layer property`);
    }
  };
  for (const [index, clip] of manifest.clips.entries()) {
    const cues = [clip.motion?.entrance, clip.motion?.emphasis, clip.motion?.exit];
    if (index > 0) cues.push(manifest.clips[index - 1]?.motion?.transition_to_next);
    assertNoConflict(clip.motion?.audio_reactive, cues, `clips.${index}.motion.audio_reactive`);
  }
  for (const [index, caption] of (manifest.captions ?? []).entries()) {
    const motion = caption.visual?.motion;
    assertNoConflict(motion?.audio_reactive, [motion?.entrance, motion?.emphasis, motion?.exit], `captions.${index}.visual.motion.audio_reactive`);
  }
}

function assertAudioReactiveSourceTracks(manifest) {
  const uses = [];
  let cursor = 0;
  for (const [index, clip] of manifest.clips.entries()) {
    if (clip.motion?.audio_reactive) {
      uses.push({ cue: clip.motion.audio_reactive, start: cursor, end: cursor + clip.duration, path: `clips.${index}.motion.audio_reactive` });
    }
    cursor += clip.duration;
  }
  for (const [index, caption] of (manifest.captions ?? []).entries()) {
    if (caption.visual?.motion?.audio_reactive) {
      uses.push({ cue: caption.visual.motion.audio_reactive, start: caption.start, end: caption.end, path: `captions.${index}.visual.motion.audio_reactive` });
    }
  }
  if (uses.length === 0) return;
  const tracks = ["bgm", "narration", "sfx"].flatMap((group) => Array.isArray(manifest.audio?.[group]) ? manifest.audio[group] : []);
  const ids = new Set();
  for (const track of tracks) {
    if (!track.id) continue;
    if (ids.has(track.id)) throw new Error(`audio track id '${track.id}' must be unique when used by audio-reactive motion`);
    ids.add(track.id);
  }
  for (const { cue, start, end, path } of uses) {
    const matches = tracks.filter((track) => track.id === cue.source_track_id);
    if (matches.length !== 1) throw new Error(`${path}.source_track_id '${cue.source_track_id}' must identify exactly one audio track`);
    const track = matches[0];
    if (!track.src) throw new Error(`${path}.source_track_id '${cue.source_track_id}' has no local audio src`);
    const trackStart = track.start ?? 0;
    if (trackStart > start + 0.001) throw new Error(`${path} starts before its source audio track is active`);
    if (track.end !== undefined && track.end < end - 0.001) throw new Error(`${path} exceeds its source audio track timeline range`);
  }
}

function addCue(cue, phase, layer, clipFrames, fps, addSegment) {
  const owner = `clips.${layer.clipId}.motion.${phase}`;
  const frames = cueFrameCount(cue, fps, owner);
  const zoomIn = cue.preset === "zoom-in";
  const zoomOut = cue.preset === "zoom-out";
  if (phase === "entrance") {
    if (cue.preset === "fade") addSegment(layer.layerId, "opacity", 0, frames, 0, 100, owner);
    if (zoomIn || zoomOut) {
      const from = zoomIn ? 100 : 110;
      const to = zoomIn ? 110 : 100;
      addSegment(layer.layerId, "scaleX", 0, frames, from, to, owner);
      addSegment(layer.layerId, "scaleY", 0, frames, from, to, owner);
    }
    return;
  }
  if (phase === "emphasis") {
    const start = Math.floor((clipFrames - frames) / 2);
    const middle = start + Math.floor(frames / 2);
    const end = start + frames;
    for (const propertyType of ["scaleX", "scaleY"]) {
      addSegment(layer.layerId, propertyType, start, middle, 100, 110, owner);
      addSegment(layer.layerId, propertyType, middle, end, 110, 100, owner);
    }
    return;
  }
  if (phase === "exit") {
    const end = clipFrames - 1;
    const start = end - frames;
    if (start < 0) throw new Error(`${owner}.duration_seconds leaves no complete exit animation interval`);
    if (cue.preset === "fade") addSegment(layer.layerId, "opacity", start, end, 100, 0, owner);
    if (zoomIn || zoomOut) {
      const from = zoomIn ? 100 : 110;
      const to = zoomIn ? 110 : 100;
      addSegment(layer.layerId, "scaleX", start, end, from, to, owner);
      addSegment(layer.layerId, "scaleY", start, end, from, to, owner);
    }
  }
}

function tesseractDimensions(aspect) {
  return aspect === "16:9" ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
}

function buildSlidePositionAction({ compositionId, layerId, durationMs, fromX, toX, y, owner }) {
  if (!Number.isInteger(durationMs) || durationMs < 9) throw new Error(`${owner} must last at least 9 ms for a verified paired position path`);
  const keyframes = (property, from, to) => Array.from({ length: 10 }, (_, index) => ({
    id: `tsugite-layer-${layerId}-${property}-${index + 1}`,
    layerTime: Math.round(index * durationMs / 9),
    value: { type: "float", value: Number((from + ((to - from) * index / 9)).toFixed(6)) },
    easing: { type: "linear" }
  }));
  return {
    type: "setFxPositionKeyframes",
    compositionId,
    layerId,
    positionX: { keyframes: keyframes("slide-x", fromX, toX) },
    positionY: { keyframes: keyframes("slide-y", y, y) }
  };
}

function cueFrameCount(cue, fps, label) {
  const seconds = cueDurationSeconds(cue);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new Error(`${label}.duration_seconds must be a positive duration no greater than 60 seconds`);
  const frames = Math.round(seconds * fps);
  if (frames < 1) throw new Error(`${label}.duration_seconds is shorter than one output frame`);
  return frames;
}

function cueDurationSeconds(cue) {
  return cue.duration_seconds ?? DEFAULT_MOTION_DURATION_SECONDS;
}

function neutralMotionValue(propertyType) {
  if (propertyType === "opacity" || propertyType === "scaleX" || propertyType === "scaleY") return 100;
  throw new Error(`No verified neutral value for Tesseract motion property '${propertyType}'`);
}

function centeredVideoTransform({ width, height }) {
  const center = [width / 2, height / 2];
  return { anchorPoint: [...center], position: [...center], scale: [100, 100], rotation: 0, opacity: 100 };
}

function requiredAssetId(assetIds, src) {
  const id = assetIds.get(src);
  if (typeof id !== "string" || !id) throw new Error(`Tesseract import did not return an asset ID for '${src}'`);
  return id;
}

function rejectUnknownKeys(value, allowed, path) {
  for (const key of Object.keys(value ?? {})) if (!allowed.has(key)) throw new Error(`${path}.${key} is not supported by the Tesseract renderer`);
}

function extension(path) {
  const name = String(path ?? "").split(/[\\/]/).at(-1) ?? "";
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index).toLowerCase();
}
