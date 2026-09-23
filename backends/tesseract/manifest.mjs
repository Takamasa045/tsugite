const VIDEO_SUFFIXES = new Set([".mp4", ".mov", ".m4v"]);
const AUDIO_SUFFIXES = new Set([".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"]);
const CLIP_KEYS = new Set(["id", "src", "in", "out", "duration", "fps", "resolution", "audio", "motion"]);
const TRACK_KEYS = new Set(["id", "src", "start", "end", "volume"]);
const CAPTION_KEYS = new Set(["id", "text", "speaker", "start", "end", "pose", "emphasis", "visual"]);
const PRESENTATION_KEYS = new Set(["preset", "required_aspect", "title", "source_title", "source_url", "draft", "motion_design"]);
const AUDIO_GROUPS = new Set(["bgm", "narration", "sfx"]);
const MANIFEST_KEYS = new Set([
  "fast_edit", "meta", "clips", "images", "speakers", "presentation", "audio",
  "master_audio_binding", "caption_binding", "chapter_binding", "captions", "chapters", "provenance"
]);
const META_KEYS = new Set(["aspect", "fps", "target_duration_seconds", "slug"]);

export function assertSupportedManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("manifest must be an object");
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
  if ((manifest.transitions?.length ?? 0) > 0) throw new Error("Tesseract backend does not yet support transitions");
  if (manifest.clips.some((clip) => clip.motion)) throw new Error("Tesseract backend does not yet support clip motion or transition instructions");
  if (manifest.presentation?.motion_design) throw new Error("Tesseract backend does not yet support presentation motion design");
  if (manifest.presentation && manifest.presentation.preset !== "tesseract-basic") {
    throw new Error("Tesseract supports only the 'tesseract-basic' presentation preset");
  }
  if (manifest.presentation) {
    rejectUnknownKeys(manifest.presentation, PRESENTATION_KEYS, "presentation");
    if (manifest.presentation.required_aspect && manifest.presentation.required_aspect !== manifest.meta.aspect) {
      throw new Error("presentation.required_aspect does not match the Tesseract composition aspect");
    }
  }
  if (!["16:9", "9:16"].includes(manifest.meta?.aspect)) throw new Error("Tesseract requires a supported 16:9 or 9:16 aspect ratio");
  if (!Number.isFinite(manifest.meta?.fps) || manifest.meta.fps !== 30) {
    throw new Error("Tesseract export uses an automatic frame rate; this adapter currently accepts only 30 fps and will verify the encoded rate");
  }

  for (const [index, clip] of manifest.clips.entries()) {
    rejectUnknownKeys(clip, CLIP_KEYS, `clips.${index}`);
    if (typeof clip.id !== "string" || !clip.id) throw new Error(`clips.${index}.id must be a non-empty string`);
    if (clip.motion) throw new Error(`clips.${index}.motion is not supported by Tesseract`);
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

  for (const [index, caption] of (manifest.captions ?? []).entries()) {
    rejectUnknownKeys(caption, CAPTION_KEYS, `captions.${index}`);
    if (caption.speaker || caption.pose || caption.visual || (caption.emphasis?.length ?? 0) > 0) {
      throw new Error(`captions.${index} includes speaker, pose, emphasis, or visual styling that Tesseract does not support yet`);
    }
    if (typeof caption.text !== "string" || caption.text.length === 0 || !Number.isFinite(caption.start) || !Number.isFinite(caption.end) || caption.start < 0 || caption.end <= caption.start) {
      throw new Error(`captions.${index} must have text and a valid timeline interval`);
    }
  }

  return { width: manifest.meta.aspect === "16:9" ? 1920 : 1080, height: manifest.meta.aspect === "16:9" ? 1080 : 1920 };
}

export function buildTesseractDocumentLayers(manifest, options) {
  const { assetIds, sourceInfo, durationSeconds } = options;
  const videoLayers = [];
  let cursor = 0;
  for (const [index, clip] of manifest.clips.entries()) {
    const media = sourceInfo.get(clip.src);
    if (!media?.hasVideo) throw new Error(`clips.${index}.src has no video stream`);
    if (clip.audio && !media.hasAudio) throw new Error(`clips.${index}.audio is true but the source has no audio stream`);
    const sourceDurationMs = Math.round((media.videoDurationSeconds ?? media.durationSeconds) * 1000);
    const sourceStartMs = Math.round(clip.in * 1000);
    const durationMs = Math.round(clip.duration * 1000);
    if (sourceStartMs + durationMs > sourceDurationMs + 20) throw new Error(`clips.${index} source interval exceeds the probed media duration`);
    const layer = {
      type: "Video",
      id: index + 1,
      name: `Tsugite clip ${clip.id}`,
      activeRange: { start: Math.round(cursor * 1000), duration: durationMs },
      sourceRange: { start: sourceStartMs, duration: durationMs },
      sourceIntrinsicDuration: sourceDurationMs,
      transform: identityTransform(),
      source: { assetId: requiredAssetId(assetIds, clip.src), fit: "contain" }
    };
    if (clip.audio) layer.volume = 1.0;
    videoLayers.push(layer);
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
  return { layers: [...videoLayers, ...audioLayers], durationSeconds: actualTimelineDuration, nextLayerId: nextId };
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

function textAction(input) {
  const title = input.kind === "title";
  const boxSize = title ? [Math.round(input.width * 0.84), Math.round(input.height * 0.22)] : [Math.round(input.width * 0.84), Math.round(input.height * 0.12)];
  const position = title ? [Math.round(input.width * 0.08), Math.round(input.height * 0.28)] : [Math.round(input.width * 0.08), Math.round(input.height * 0.80)];
  return {
    type: "createFxTextLayer",
    compositionId: input.compositionId,
    layerId: input.layerId,
    insertIndex: 0,
    name: input.name,
    activeRange: { start: Math.round(input.start * 1000), duration: Math.round(input.duration * 1000) },
    transform: { anchorPoint: [0, 0], position, scale: [100, 100], rotation: 0, opacity: 100 },
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

function identityTransform() {
  return { anchorPoint: [0, 0], position: [0, 0], scale: [100, 100], rotation: 0, opacity: 100 };
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
