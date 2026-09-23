import { z } from "zod";
import { fastEditSchema } from "../fastEdit/schema.js";
import { digestRefSchema, digestSchema, safeIdSchema } from "../productionControl/schema.js";

const aspectSchema = z.enum(["16:9", "9:16", "1:1", "4:5", "3:4", "5:4"]);

const motionPreviewPresetSchema = z.enum([
  "none",
  "fade",
  "slide-left",
  "slide-right",
  "rise",
  "zoom-in",
  "zoom-out",
  "pan-left",
  "pan-right",
  "parallax",
  "pulse",
  "wipe"
]);

const motionCueSchema = z
  .object({
    preset: motionPreviewPresetSchema,
    label: z.string().min(1).optional(),
    description: z.string().min(1),
    target: z.string().min(1).default("frame"),
    duration_seconds: z.number().positive().max(60).optional(),
    easing: z.string().min(1).optional()
  })
  .passthrough();

const audioReactiveMotionSchema = z
  .object({
    source_track_id: z.string().min(1),
    mode: z.enum(["pulse", "shake", "flicker"]),
    strength: z.number().min(0).max(1),
    measurement_window_ms: z.number().int().min(20).max(2_000)
  })
  .strict();

const shotMotionSchema = z
  .object({
    entrance: motionCueSchema.optional(),
    emphasis: motionCueSchema.optional(),
    exit: motionCueSchema.optional(),
    transition_to_next: motionCueSchema.optional(),
    audio_reactive: audioReactiveMotionSchema.optional(),
    implementation_notes: z.array(z.string().min(1)).max(12).default([])
  })
  .passthrough();

const motionDesignSchema = z
  .object({
    summary: z.string().min(1),
    pacing: z.string().min(1).optional(),
    principles: z.array(z.string().min(1)).max(12).default([])
  })
  .passthrough();

const imageSchema = z
  .object({
    id: z.string().min(1),
    src: z.string().min(1),
    alt: z.string().optional(),
    alpha_required: z.boolean().optional()
  })
  .passthrough();

const nativeAssetSchema = z.object({
  asset_id: z.string().min(1).max(256),
  src: z.string().min(1),
  kind: z.enum(["audio", "image", "video"])
}).strict();

const nativeFontSchema = z.object({
  src: z.string().min(1),
  family: z.string().min(1).optional(),
  style: z.string().min(1).optional()
}).strict().superRefine((font, context) => {
  if ((font.family === undefined) !== (font.style === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "native font family and style must be supplied together" });
  }
});

const nativeOutputSchema = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
  path: z.string().min(1).max(256).refine((value) =>
    !value.startsWith("/") && !/^[A-Za-z]:/.test(value) && !value.includes("\\") && !/[\u0000-\u001f]/.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "native output path must be a safe run-relative path"
  ),
  duration_seconds: z.number().positive().max(3_600).optional(),
  width: z.number().int().positive().max(32_768).optional(),
  height: z.number().int().positive().max(32_768).optional(),
  fps: z.number().positive().max(240).optional(),
  video_codec: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/).optional(),
  alpha_required: z.boolean().optional(),
  audio_required: z.boolean().optional()
}).strict();

const nativePrimaryOutputSchema = z.object({
  width: z.number().int().positive().max(32_768),
  height: z.number().int().positive().max(32_768),
  fps: z.number().positive().max(240),
  audio_required: z.boolean()
}).strict();

const nativeEditSchema = z
  .object({
    /** Opaque backend-owned editing data. Its internal schema is validated by the selected backend. */
    payload: z.unknown().optional(),
    /** Local files required by the payload, copied into and fingerprinted within the run. */
    assets: z.array(nativeAssetSchema).max(256).optional(),
    /** Local font resources required by the payload. */
    fonts: z.array(nativeFontSchema).max(64).optional(),
    /** Additional backend-produced files; exact kinds and paths are validated by the selected backend. */
    outputs: z.array(nativeOutputSchema).max(16).optional(),
    /** Gate 1 declaration of the canonical media file produced from a native document. */
    primary_output: nativePrimaryOutputSchema.optional(),
    /** Whether the native payload replaces the ordinary timeline or extends it. */
    mode: z.enum(["replace", "extend"]).default("extend")
  })
  .strict()
  .superRefine((native, context) => {
    if (native.payload === undefined && !native.assets?.length && !native.fonts?.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "native_edit must contain a payload or declared resources" });
    }
    const ids = new Set<string>();
    const paths = new Set<string>();
    native.assets?.forEach((asset, index) => {
      if (ids.has(asset.asset_id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["assets", index, "asset_id"], message: `duplicate native asset id '${asset.asset_id}'` });
      if (paths.has(asset.src)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["assets", index, "src"], message: `duplicate native asset source '${asset.src}'` });
      ids.add(asset.asset_id);
      paths.add(asset.src);
    });
    const fontPaths = new Set<string>();
    native.fonts?.forEach((font, index) => {
      if (fontPaths.has(font.src)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["fonts", index, "src"], message: `duplicate native font source '${font.src}'` });
      fontPaths.add(font.src);
    });
    const outputPaths = new Set<string>();
    native.outputs?.forEach((output, index) => {
      if (outputPaths.has(output.path)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["outputs", index, "path"], message: `duplicate native output path '${output.path}'` });
      outputPaths.add(output.path);
    });
    try {
      if (Buffer.byteLength(JSON.stringify(native), "utf8") > 4 * 1024 * 1024) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["payload"], message: "native_edit exceeds the 4 MiB inline data limit" });
      }
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["payload"], message: "native_edit must contain JSON-serializable data" });
    }
  });

const speakerSchema = z
  .object({
    id: z.string().min(1),
    display_name: z.string().min(1),
    side: z.union([z.literal("left"), z.literal("right")]),
    accent: z.string().min(1),
    poses: z.record(z.string(), z.string().min(1)),
    mouth_frames: z.array(z.string().min(1)).length(3).optional()
  })
  .passthrough();

const presentationSchema = z
  .object({
    preset: z.string().min(1),
    required_aspect: aspectSchema.optional(),
    title: z.string().min(1).optional(),
    source_title: z.string().min(1).optional(),
    source_url: z.string().url().optional(),
    draft: z.boolean().default(false),
    motion_design: motionDesignSchema.optional()
  })
  .passthrough();

const captionVisualSchema = z
  .object({
    image_id: z.string().min(1).optional(),
    kicker: z.string().optional(),
    headline: z.string().min(1),
    detail: z.string().optional(),
    badges: z.array(z.string().min(1)).max(4).default([]),
    motion: shotMotionSchema.optional()
  })
  .passthrough();

const trackSchema = z
  .object({
    id: z.string().optional(),
    src: z.string().optional(),
    start: z.number().nonnegative().optional(),
    end: z.number().positive().optional(),
    volume: z.number().nonnegative().optional()
  })
  .passthrough();

const clipSchema = z
  .object({
    id: z.string().min(1),
    src: z.string().min(1),
    in: z.number().nonnegative(),
    out: z.number().positive(),
    duration: z.number().positive(),
    fps: z.number().positive(),
    resolution: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive()
    }),
    audio: z.boolean(),
    motion: shotMotionSchema.optional()
  })
  .passthrough();

export const masterAudioBindingSchema = z.object({
  asset_id: safeIdSchema,
  sha256: digestSchema,
  duration_ms: z.number().int().positive(),
  contract_id: safeIdSchema,
  revision: z.number().int().nonnegative(),
  contract_digest: digestSchema
}).strict();

export const captionBindingSchema = z.object({
  contract_id: safeIdSchema,
  revision: z.number().int().nonnegative(),
  timing_digest: z.union([digestSchema, z.null()]),
  cue_refs: z.array(digestRefSchema).max(100_000)
}).strict();

export const chapterBindingSchema = z.object({
  contract_id: safeIdSchema,
  revision: z.number().int().nonnegative(),
  timing_digest: digestSchema,
  section_refs: z.array(digestRefSchema).max(256)
}).strict();

export const manifestSchema = z
  .object({
    fast_edit: fastEditSchema.optional(),
    native_edit: nativeEditSchema.optional(),
    meta: z
      .object({
        aspect: aspectSchema,
        fps: z.number().positive(),
        target_duration_seconds: z.number().positive(),
        slug: z.string().min(1)
      })
      .passthrough(),
    clips: z.array(clipSchema).default([]),
    images: z.array(imageSchema).default([]),
    speakers: z.array(speakerSchema).default([]),
    presentation: presentationSchema.optional(),
    audio: z
      .object({
        bgm: z.array(trackSchema).default([]),
        narration: z.array(trackSchema).default([]),
        sfx: z.array(trackSchema).default([])
      })
      .passthrough()
      .default({ bgm: [], narration: [], sfx: [] }),
    master_audio_binding: masterAudioBindingSchema.optional(),
    caption_binding: captionBindingSchema.optional(),
    chapter_binding: chapterBindingSchema.optional(),
    captions: z
      .array(
        z
          .object({
            id: z.string().min(1).optional(),
            text: z.string(),
            speaker: z.string().min(1).optional(),
            start: z.number().nonnegative(),
            end: z.number().positive(),
            pose: z.string().min(1).optional(),
            emphasis: z.array(z.string().min(1)).default([]),
            visual: captionVisualSchema.optional()
          })
          .passthrough()
      )
      .default([]),
    chapters: z
      .array(
        z
          .object({
            title: z.string().min(1),
            start: z.number().nonnegative(),
            end: z.number().positive()
          })
          .passthrough()
      )
      .default([]),
    provenance: z
      .array(
        z
          .object({
            clip_id: z.string().optional(),
            engine: z.string().optional(),
            model: z.string().optional(),
            params: z.record(z.string(), z.unknown()).optional(),
            credits: z.number().nonnegative().optional()
          })
          .passthrough()
      )
      .default([])
  })
  .passthrough()
  .superRefine((manifest, context) => {
    let nativeWalkExceededDepth = false;
    let nativeWalkVisitedNodes = 0;
    if (manifest.native_edit) {
      const budget = { visitedNodes: 0, exceededDepth: false, seen: new WeakSet<object>() };
      inspectNativeValueTree(manifest.native_edit.payload, 0, budget);
      nativeWalkVisitedNodes = budget.visitedNodes;
      nativeWalkExceededDepth = budget.exceededDepth;
      if (nativeWalkExceededDepth || nativeWalkVisitedNodes > 200_000) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["native_edit", "payload"], message: "native payload must stay within 64 levels and 200,000 values" });
      }
    }
    if (manifest.clips.length === 0 && manifest.native_edit?.mode !== "replace") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["clips"], message: "at least one video clip is required unless native_edit.mode is 'replace'" });
    }
    const uses: Array<{ sourceTrackId: string; start: number; end: number; path: Array<string | number> }> = [];
    let clipCursor = 0;
    manifest.clips.forEach((clip, index) => {
      const cue = clip.motion?.audio_reactive;
      if (cue) uses.push({
        sourceTrackId: cue.source_track_id,
        start: clipCursor,
        end: clipCursor + clip.duration,
        path: ["clips", index, "motion", "audio_reactive", "source_track_id"]
      });
      clipCursor += clip.duration;
    });
    manifest.captions.forEach((caption, index) => {
      const cue = caption.visual?.motion?.audio_reactive;
      if (!cue) return;
      uses.push({
        sourceTrackId: cue.source_track_id,
        start: caption.start,
        end: caption.end,
        path: ["captions", index, "visual", "motion", "audio_reactive", "source_track_id"]
      });
    });
    if (uses.length === 0) return;

    // Audio is passthrough for forward compatibility. Only known groups can
    // participate in a cue; unknown non-array values must never make parsing
    // throw before the caller can report schema issues.
    const tracks = (["bgm", "narration", "sfx"] as const).flatMap((group) => {
      const entries: unknown = manifest.audio[group];
      if (!Array.isArray(entries)) return [];
      return entries.flatMap((track: unknown, index: number) => track && typeof track === "object" && !Array.isArray(track)
        ? [{ track: track as { id?: string; src?: string; start?: number; end?: number }, path: ["audio", group, index] as Array<string | number> }]
        : []);
    });
    const idCounts = new Map<string, number>();
    for (const { track } of tracks) {
      if (track.id) idCounts.set(track.id, (idCounts.get(track.id) ?? 0) + 1);
    }
    for (const [trackId, count] of idCounts) {
      if (count > 1) context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["audio"],
        message: `audio track id '${trackId}' must be unique when used by audio-reactive motion`
      });
    }

    for (const use of uses) {
      const matches = tracks.filter(({ track }) => track.id === use.sourceTrackId);
      if (matches.length !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: use.path,
          message: `source_track_id '${use.sourceTrackId}' must identify exactly one audio track`
        });
        continue;
      }
      const { track, path } = matches[0]!;
      const trackStart = track.start ?? 0;
      if (!track.src) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "src"], message: "audio-reactive source track requires a local audio src" });
      }
      if (trackStart > use.start + 0.001) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: use.path, message: "source audio must be active by the start of its audio-reactive target" });
      }
      if (track.end !== undefined && track.end < use.end - 0.001) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: use.path, message: "source audio timeline range does not cover its audio-reactive target" });
      }
      if (track.end !== undefined && track.end <= trackStart) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "end"], message: "audio track end must be later than its timeline start" });
      }
    }
  });

function inspectNativeValueTree(
  value: unknown,
  depth = 0,
  budget: { visitedNodes: number; exceededDepth: boolean; seen: WeakSet<object> } = {
    visitedNodes: 0,
    exceededDepth: false,
    seen: new WeakSet<object>()
  }
): { visitedNodes: number; exceededDepth: boolean; seen: WeakSet<object> } {
  if (value === undefined || value === null) return budget;
  budget.visitedNodes += 1;
  if (depth > 64) {
    budget.exceededDepth = true;
    return budget;
  }
  if (Array.isArray(value)) {
    if (budget.seen.has(value)) return budget;
    budget.seen.add(value);
    for (const child of value) {
      inspectNativeValueTree(child, depth + 1, budget);
      if (budget.exceededDepth || budget.visitedNodes > 200_000) break;
    }
  } else if (typeof value === "object") {
    if (budget.seen.has(value)) return budget;
    budget.seen.add(value);
    for (const child of Object.values(value)) {
      inspectNativeValueTree(child, depth + 1, budget);
      if (budget.exceededDepth || budget.visitedNodes > 200_000) break;
    }
  }
  return budget;
}

export type Manifest = z.infer<typeof manifestSchema>;
