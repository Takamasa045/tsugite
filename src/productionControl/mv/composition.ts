import { z } from "zod";
import { sha256Canonical, withoutField } from "../canonical.js";
import {
  contractFragmentRefSchema,
  digestSchema,
  humanDecisionRefSchema,
  safeIdSchema,
  type ContractFragmentRef
} from "../schema.js";
import { lyricsContractSchema, type LyricsContract } from "../contracts/lyrics.js";
import { generationUnitContractSchema, type GenerationUnitContract } from "../contracts/generationUnit.js";
import { musicStructureContractSchema, type MusicStructureContract } from "../contracts/music.js";

const finiteInt = z.number().finite().int();
const nonNegativeInt = finiteInt.nonnegative();
const positiveInt = finiteInt.positive();

export const timeTransformSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({
    kind: z.literal("speed"),
    source_duration_ms: positiveInt,
    timeline_duration_ms: positiveInt,
    reason: z.string().min(1).max(2_000),
    decision: humanDecisionRefSchema
  }).strict()
]);
export type TimeTransformV1 = z.infer<typeof timeTransformSchema>;

export const compositionPlacementSchema = z.object({
  generation_unit_digest: digestSchema,
  track_id: safeIdSchema,
  layer: nonNegativeInt,
  timeline_start_ms: nonNegativeInt,
  timeline_end_ms: positiveInt,
  planned_time_transform: timeTransformSchema,
  blend_policy: z.enum(["replace", "overlay", "crossfade"])
}).strict();
export type CompositionPlacementV1 = z.infer<typeof compositionPlacementSchema>;

const visualCoverageSchema = z.object({
  track_id: safeIdSchema,
  start_ms: nonNegativeInt,
  end_ms: positiveInt
}).strict();

export const compositionIntentSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("mv-composition-intent"),
  master_audio_digest: digestSchema,
  duration_ms: positiveInt,
  placements: z.array(compositionPlacementSchema).min(1).max(10_000),
  required_visual_coverage_intervals: z.array(visualCoverageSchema).max(10_000),
  caption_cue_refs: z.array(contractFragmentRefSchema).max(100_000),
  digest: digestSchema
}).strict().superRefine((value, context) => {
  const placementKeys = value.placements.map((placement) => `${placement.generation_unit_digest}\u0000${placement.track_id}\u0000${placement.timeline_start_ms}\u0000${placement.timeline_end_ms}`);
  if (new Set(placementKeys).size !== placementKeys.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["placements"], message: "composition placements must be unique" });
  for (const [index, placement] of value.placements.entries()) {
    if (placement.timeline_start_ms >= placement.timeline_end_ms || placement.timeline_end_ms > value.duration_ms) context.addIssue({ code: z.ZodIssueCode.custom, path: ["placements", index], message: "composition placement is outside master duration" });
    const transform = placement.planned_time_transform;
    if (transform.kind === "speed") {
      const expected = timeTransformSubjectDigest(placement.generation_unit_digest, transform.source_duration_ms, transform.timeline_duration_ms);
      if (transform.decision.subject_digest !== expected) context.addIssue({ code: z.ZodIssueCode.custom, path: ["placements", index, "planned_time_transform", "decision", "subject_digest"], message: "speed decision must bind unit and duration" });
      if (transform.timeline_duration_ms !== placement.timeline_end_ms - placement.timeline_start_ms) context.addIssue({ code: z.ZodIssueCode.custom, path: ["placements", index, "planned_time_transform"], message: "speed timeline duration must match placement" });
    }
  }
  validatePlacementOverlap(value.placements, context);
  for (const [index, interval] of value.required_visual_coverage_intervals.entries()) {
    if (interval.start_ms >= interval.end_ms || interval.end_ms > value.duration_ms) context.addIssue({ code: z.ZodIssueCode.custom, path: ["required_visual_coverage_intervals", index], message: "required coverage interval is outside master duration" });
  }
  for (const [index, ref] of value.caption_cue_refs.entries()) {
    if (ref.slot !== "lyrics" || ref.kind !== "lyric-cue") context.addIssue({ code: z.ZodIssueCode.custom, path: ["caption_cue_refs", index], message: "captions must bind lyric cues only" });
  }
  if (sha256Canonical(withoutField(value, "digest")) !== value.digest) context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "composition intent digest mismatch" });
});
export type MvCompositionIntentV1 = z.infer<typeof compositionIntentSchema>;
export type CompositionIntent = MvCompositionIntentV1;

const compositionClipSchema = z.object({
  artifact_id: safeIdSchema,
  artifact_digest: digestSchema,
  generation_unit_digest: digestSchema,
  track_id: safeIdSchema,
  layer: nonNegativeInt,
  source_in_ms: nonNegativeInt,
  source_out_ms: positiveInt,
  timeline_start_ms: nonNegativeInt,
  timeline_end_ms: positiveInt,
  time_transform: timeTransformSchema,
  blend_policy: z.enum(["replace", "overlay", "crossfade"]),
  audio_policy: z.enum(["discard", "mix", "replace-master"])
}).strict();

const captionSchema = z.object({
  lyric_cue_id: safeIdSchema,
  timeline_start_ms: nonNegativeInt,
  timeline_end_ms: positiveInt,
  style_ref: safeIdSchema
}).strict();

const chapterSchema = z.object({ id: safeIdSchema, start_ms: nonNegativeInt, end_ms: positiveInt }).strict();

export const compositionPlanSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("mv-composition-plan"),
  composition_intent_digest: digestSchema,
  master_audio_asset_id: safeIdSchema,
  master_audio_digest: digestSchema,
  duration_ms: positiveInt,
  clips: z.array(compositionClipSchema).min(1).max(10_000),
  captions: z.array(captionSchema).max(100_000),
  chapters: z.array(chapterSchema).max(256),
  digest: digestSchema
}).strict().superRefine((value, context) => {
  for (const [index, clip] of value.clips.entries()) {
    if (clip.source_in_ms >= clip.source_out_ms || clip.timeline_start_ms >= clip.timeline_end_ms || clip.timeline_end_ms > value.duration_ms) context.addIssue({ code: z.ZodIssueCode.custom, path: ["clips", index], message: "composition clip interval is invalid" });
    if (clip.time_transform.kind === "none" && clip.source_out_ms - clip.source_in_ms !== clip.timeline_end_ms - clip.timeline_start_ms) context.addIssue({ code: z.ZodIssueCode.custom, path: ["clips", index, "time_transform"], message: "none transform requires equal source and timeline duration" });
    if (clip.time_transform.kind === "speed") {
      if (clip.time_transform.source_duration_ms !== clip.source_out_ms - clip.source_in_ms || clip.time_transform.timeline_duration_ms !== clip.timeline_end_ms - clip.timeline_start_ms) context.addIssue({ code: z.ZodIssueCode.custom, path: ["clips", index, "time_transform"], message: "speed transform duration expression mismatch" });
    }
  }
  validateResolvedOverlap(value.clips, context);
  if (sha256Canonical(withoutField(value, "digest")) !== value.digest) context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "composition plan digest mismatch" });
});
export type MvCompositionPlanV1 = z.infer<typeof compositionPlanSchema>;
export type CompositionPlan = MvCompositionPlanV1;

export type CompositionIntentInput = {
  music: MusicStructureContract;
  lyrics?: LyricsContract;
  units: GenerationUnitContract[];
  placements: Array<Omit<CompositionPlacementV1, "generation_unit_digest"> & { generation_unit_digest: string }>;
  required_visual_coverage_intervals: Array<z.infer<typeof visualCoverageSchema>>;
  caption_cue_refs: ContractFragmentRef[];
};

export type CompositionArtifact = {
  generation_unit_digest: string;
  artifact_id: string;
  artifact_digest: string;
  duration_ms: number;
  source_in_ms?: number;
  source_out_ms?: number;
};

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
}

export function timeTransformSubjectDigest(generationUnitDigest: string, sourceDurationMs: number, timelineDurationMs: number): string {
  return sha256Canonical({ generation_unit_digest: generationUnitDigest, source_duration_ms: sourceDurationMs, timeline_duration_ms: timelineDurationMs });
}

function validatePlacementOverlap(placements: readonly CompositionPlacementV1[], context: z.RefinementCtx): void {
  const byTrack = new Map<string, Array<{ placement: CompositionPlacementV1; index: number }>>();
  placements.forEach((placement, index) => {
    const current = byTrack.get(placement.track_id) ?? [];
    current.push({ placement, index });
    byTrack.set(placement.track_id, current);
  });
  for (const entries of byTrack.values()) {
    entries.sort((left, right) => left.placement.timeline_start_ms - right.placement.timeline_start_ms);
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1]!;
      const current = entries[index]!;
      if (current.placement.timeline_start_ms < previous.placement.timeline_end_ms
        && (current.placement.layer === previous.placement.layer
          || current.placement.blend_policy === "replace"
          || previous.placement.blend_policy === "replace")) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["placements", current.index], message: "overlap requires distinct layers and explicit overlay/crossfade blend" });
      }
    }
  }
}

function validateResolvedOverlap(clips: readonly z.infer<typeof compositionClipSchema>[], context: z.RefinementCtx): void {
  const byTrack = new Map<string, Array<{ clip: z.infer<typeof compositionClipSchema>; index: number }>>();
  clips.forEach((clip, index) => {
    const current = byTrack.get(clip.track_id) ?? [];
    current.push({ clip, index });
    byTrack.set(clip.track_id, current);
  });
  for (const entries of byTrack.values()) {
    entries.sort((left, right) => left.clip.timeline_start_ms - right.clip.timeline_start_ms);
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1]!;
      const current = entries[index]!;
      if (current.clip.timeline_start_ms < previous.clip.timeline_end_ms
        && (current.clip.layer === previous.clip.layer || current.clip.blend_policy === "replace" || previous.clip.blend_policy === "replace")) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["clips", current.index], message: "resolved clip overlap is not explicitly blended" });
      }
    }
  }
}

function assertCoverage(placements: readonly CompositionPlacementV1[], intervals: readonly z.infer<typeof visualCoverageSchema>[]): void {
  for (const interval of intervals) {
    const relevant = placements.filter((placement) => placement.track_id === interval.track_id).sort((left, right) => left.timeline_start_ms - right.timeline_start_ms);
    let cursor = interval.start_ms;
    for (const placement of relevant) {
      if (placement.timeline_end_ms <= cursor) continue;
      if (placement.timeline_start_ms > cursor) break;
      cursor = Math.max(cursor, placement.timeline_end_ms);
      if (cursor >= interval.end_ms) break;
    }
    if (cursor < interval.end_ms) throw new Error(`required visual coverage is not covered on track ${interval.track_id}`);
  }
}

export function createCompositionIntent(input: CompositionIntentInput): MvCompositionIntentV1 {
  const music = musicStructureContractSchema.parse(input.music);
  const lyrics = input.lyrics ? lyricsContractSchema.parse(input.lyrics) : undefined;
  const units = input.units.map((unit) => generationUnitContractSchema.parse(unit));
  for (const unit of units) {
    if (unit.music_binding.contract_id !== music.contract_id || unit.music_binding.revision !== music.revision || unit.music_binding.contract_digest !== music.digest || unit.music_binding.master_audio_digest !== music.master_audio.sha256) throw new Error("composition unit music binding mismatch");
    if (lyrics && (!unit.lyrics_binding || unit.lyrics_binding.contract_id !== lyrics.contract_id || unit.lyrics_binding.revision !== lyrics.revision || (unit.lyrics_binding.contract_digest !== undefined && unit.lyrics_binding.contract_digest !== lyrics.digest))) throw new Error("composition unit lyrics binding mismatch");
  }
  const unitMap = new Map(units.map((unit) => [unit.digest, unit]));
  const placements = input.placements.map((placement) => {
    const unit = unitMap.get(placement.generation_unit_digest);
    if (!unit) throw new Error("composition placement must bind a known generation unit");
    if (placement.timeline_start_ms >= placement.timeline_end_ms || placement.timeline_end_ms > music.master_audio.duration_ms) throw new Error("composition placement is outside master duration");
    if (placement.planned_time_transform.kind === "none") {
      if (unit.clip_duration_ms !== placement.timeline_end_ms - placement.timeline_start_ms) throw new Error("none transform requires source and timeline duration equality");
    } else {
      const transform = placement.planned_time_transform;
      assertFinitePositive(transform.source_duration_ms, "speed source duration");
      assertFinitePositive(transform.timeline_duration_ms, "speed timeline duration");
      if (transform.source_duration_ms !== unit.clip_duration_ms || transform.timeline_duration_ms !== placement.timeline_end_ms - placement.timeline_start_ms) throw new Error("speed transform duration does not bind generation unit and placement");
      if (transform.decision.subject_digest !== timeTransformSubjectDigest(unit.digest, transform.source_duration_ms, transform.timeline_duration_ms)) throw new Error("speed transform decision subject mismatch");
    }
    return placement;
  });
  const captionRefs = input.caption_cue_refs.map((ref) => contractFragmentRefSchema.parse(ref));
  if (captionRefs.length > 0 && !lyrics) throw new Error("caption refs require a lyrics contract");
  if (lyrics) {
    for (const ref of captionRefs) {
      const cue = lyrics.cues.find((candidate) => candidate.id === ref.fragment_id);
      if (!cue || ref.contract_id !== lyrics.contract_id || ref.revision !== lyrics.revision || ref.digest !== sha256Canonical(cue)) throw new Error("caption cue ref does not match lyrics contract");
    }
  }
  assertCoverage(placements, input.required_visual_coverage_intervals);
  const base = {
    schema_version: 1 as const,
    kind: "mv-composition-intent" as const,
    master_audio_digest: music.master_audio.sha256,
    duration_ms: music.master_audio.duration_ms,
    placements,
    required_visual_coverage_intervals: input.required_visual_coverage_intervals,
    caption_cue_refs: captionRefs
  };
  return compositionIntentSchema.parse({ ...base, digest: sha256Canonical(base) });
}

export type ResolveCompositionPlanInput = {
  intent: MvCompositionIntentV1;
  music: MusicStructureContract;
  lyrics?: LyricsContract;
  units: GenerationUnitContract[];
  artifacts: CompositionArtifact[];
  caption_style_ref?: string;
};

export function resolveCompositionPlan(input: ResolveCompositionPlanInput): MvCompositionPlanV1 {
  const intent = compositionIntentSchema.parse(input.intent);
  const music = musicStructureContractSchema.parse(input.music);
  const lyrics = input.lyrics ? lyricsContractSchema.parse(input.lyrics) : undefined;
  if (intent.master_audio_digest !== music.master_audio.sha256 || intent.duration_ms !== music.master_audio.duration_ms) throw new Error("composition intent master audio binding mismatch");
  const units = input.units.map((unit) => generationUnitContractSchema.parse(unit));
  const unitMap = new Map(units.map((unit) => [unit.digest, unit]));
  const artifactMap = new Map<string, CompositionArtifact>();
  for (const artifact of input.artifacts) {
    if (artifactMap.has(artifact.generation_unit_digest)) throw new Error("one resolved artifact per generation unit is required");
    if (!unitMap.has(artifact.generation_unit_digest)) throw new Error("artifact must bind a known generation unit");
    if (!safeIdSchema.safeParse(artifact.artifact_id).success || !digestSchema.safeParse(artifact.artifact_digest).success) throw new Error("artifact identity is invalid");
    assertFinitePositive(artifact.duration_ms, "artifact duration");
    artifactMap.set(artifact.generation_unit_digest, artifact);
  }
  const clips = intent.placements.map((placement) => {
    const unit = unitMap.get(placement.generation_unit_digest);
    const artifact = artifactMap.get(placement.generation_unit_digest);
    if (!unit || !artifact) throw new Error("every composition placement requires a resolved artifact");
    if (artifact.duration_ms !== unit.clip_duration_ms) throw new Error("artifact duration does not match generation unit");
    const sourceIn = artifact.source_in_ms ?? 0;
    const sourceOut = artifact.source_out_ms ?? artifact.duration_ms;
    if (sourceIn < 0 || sourceOut <= sourceIn || sourceOut - sourceIn !== artifact.duration_ms) throw new Error("artifact source duration is invalid");
    if (placement.planned_time_transform.kind === "none" && sourceOut - sourceIn !== placement.timeline_end_ms - placement.timeline_start_ms) throw new Error("none transform source/timeline duration mismatch");
    if (placement.planned_time_transform.kind === "speed" && (placement.planned_time_transform.source_duration_ms !== sourceOut - sourceIn || placement.planned_time_transform.timeline_duration_ms !== placement.timeline_end_ms - placement.timeline_start_ms)) throw new Error("speed transform source/timeline duration mismatch");
    return {
      artifact_id: safeIdSchema.parse(artifact.artifact_id),
      artifact_digest: digestSchema.parse(artifact.artifact_digest),
      generation_unit_digest: unit.digest,
      track_id: placement.track_id,
      layer: placement.layer,
      source_in_ms: sourceIn,
      source_out_ms: sourceOut,
      timeline_start_ms: placement.timeline_start_ms,
      timeline_end_ms: placement.timeline_end_ms,
      time_transform: placement.planned_time_transform,
      blend_policy: placement.blend_policy,
      audio_policy: unit.audio_policy === "native-generated" ? "mix" as const : "discard" as const
    };
  });
  const captions = intent.caption_cue_refs.map((ref) => {
    if (!lyrics) throw new Error("caption refs require a lyrics contract");
    const cue = lyrics.cues.find((candidate) => candidate.id === ref.fragment_id);
    if (!cue || cue.timing !== "timed" || ref.contract_id !== lyrics.contract_id || ref.revision !== lyrics.revision || ref.digest !== sha256Canonical(cue)) throw new Error("resolved captions require exact timed lyric cues");
    return {
      lyric_cue_id: cue.id,
      timeline_start_ms: cue.start_ms,
      timeline_end_ms: cue.end_ms,
      style_ref: safeIdSchema.parse(input.caption_style_ref ?? "caption-default")
    };
  });
  const base = {
    schema_version: 1 as const,
    kind: "mv-composition-plan" as const,
    composition_intent_digest: intent.digest,
    master_audio_asset_id: music.master_audio.asset_id,
    master_audio_digest: music.master_audio.sha256,
    duration_ms: music.master_audio.duration_ms,
    clips,
    captions,
    chapters: music.sections.map((section) => ({ id: section.id, start_ms: section.start_ms, end_ms: section.end_ms }))
  };
  return compositionPlanSchema.parse({ ...base, digest: sha256Canonical(base) });
}

export type FrameQuantization = { start_ms: number; end_ms: number; tolerance_ms: number };

export function validateFrameQuantization(input: { start_ms: number; end_ms: number; fps: number }): FrameQuantization {
  if (!Number.isFinite(input.start_ms) || !Number.isSafeInteger(input.start_ms) || input.start_ms < 0) throw new Error("frame start must be a finite non-negative safe integer");
  if (!Number.isFinite(input.end_ms) || !Number.isSafeInteger(input.end_ms) || input.end_ms <= input.start_ms) throw new Error("frame end must be a finite safe integer after start");
  if (!Number.isFinite(input.fps) || input.fps <= 0) throw new Error("fps must be finite and positive");
  return { start_ms: input.start_ms, end_ms: input.end_ms, tolerance_ms: Math.ceil(1_000 / input.fps) };
}

export function compositionIntentDigest(value: MvCompositionIntentV1): string {
  return compositionIntentSchema.parse(value).digest;
}

export function compositionPlanDigest(value: MvCompositionPlanV1): string {
  return compositionPlanSchema.parse(value).digest;
}

export const mvCompositionIntentSchema = compositionIntentSchema;
export const mvCompositionPlanSchema = compositionPlanSchema;
