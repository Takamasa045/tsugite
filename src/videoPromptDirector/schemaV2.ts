import { win32 } from "node:path";
import { sha256Text } from "../integrity/canonical.js";
import { z } from "zod";
import {
  programBindingSchema,
  routeIdentitySchema,
  type ProgramBindingV1,
  type RouteIdentityV1
} from "../productionControl/programBinding.js";
import { identityDefinitionSchema } from "../personConsistency/schema.js";

const safeId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const finiteInt = z.number().finite().int();
const nonNegativeMs = finiteInt.nonnegative();
const positiveMs = finiteInt.positive();
const safeRelativePath = z.string().min(1).refine((value) => {
  const root = win32.parse(value).root;
  return !value.startsWith("/") && root.length === 0 && !value.includes("\\")
    && !value.split("/").includes("..");
}, "must be a project-relative path");

export const videoPromptModeV2Schema = z.enum([
  "text-to-video",
  "first-frame",
  "first-last",
  "last-frame",
  "reference"
]);
export type VideoPromptModeV2 = z.infer<typeof videoPromptModeV2Schema>;

/** Exported IR major version for RC revision bindings. */
export const VIDEO_PROMPT_IR_VERSION = 2 as const;

const targetSchema = z.object({
  model_profile_id: safeId,
  mode: videoPromptModeV2Schema,
  duration_ms: positiveMs,
  quality: z.string().min(1),
  aspect: z.string().min(1),
  audio: z.boolean()
}).strict();

const lockedTextSchema = z.object({
  text: z.string(),
  sha256: digest
}).strict().superRefine((value, context) => {
  if (sha256Text(value.text) !== value.sha256) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sha256"], message: "locked identity text digest does not match" });
  }
});

const subjectSchema = z.object({
  id: safeId,
  description: z.string().min(1),
  source_asset_id: safeId.optional(),
  speaker_id: z.string().regex(/^S\d+$/).optional(),
  voice: z.object({
    source_asset_id: safeId.optional(),
    description: z.string().min(1).optional(),
    relationship: z.string().min(1).optional()
  }).strict().optional(),
  locked_blocks: z.object({
    voice: lockedTextSchema.optional(),
    appearance: lockedTextSchema.optional(),
    manner: lockedTextSchema.optional()
  }).strict().optional(),
  variants: z.array(z.object({
    id: safeId,
    source_asset_id: safeId
  }).strict()).max(64).optional(),
  preservation: z.object({
    identity: z.enum(["strict", "loose"]).optional(),
    clothing: z.enum(["strict", "loose"]).optional(),
    hairstyle: z.enum(["strict", "loose"]).optional()
  }).strict().optional()
}).strict();

const sceneSchema = z.object({
  id: safeId,
  location_map: z.string().min(1),
  palette: z.string().optional(),
  wardrobe: z.string().optional(),
  props: z.array(z.string()).max(128),
  time_of_day: z.string().optional(),
  weather: z.string().optional(),
  screen_direction: z.string().optional(),
  active_subject_ids: z.array(safeId).max(128)
}).strict();

const assetSchema = z.object({
  id: safeId,
  type: z.enum(["image", "video", "audio"]),
  path: safeRelativePath,
  role: z.enum([
    "subject_reference",
    "first_frame",
    "last_frame",
    "motion_reference",
    "voice_reference",
    "environment_reference",
    "style_reference",
    "other"
  ]),
  sha256: digest.optional()
}).strict();

const cameraSchema = z.object({
  type: z.string().min(1),
  amplitude: z.string().min(1).optional(),
  speed: z.string().min(1).optional(),
  direction: z.string().min(1).optional(),
  optics: z.object({
    fov_degrees: z.number().finite().positive().optional(),
    lens_mm: z.number().finite().positive().optional()
  }).strict().optional()
}).strict();

const inlineTextContentSchema = z.object({
  source: z.literal("inline-exact"),
  exact_text: z.string(),
  text_digest: digest
}).strict();

const legacyTextContentSchema = z.object({
  source: z.literal("legacy-unaligned"),
  exact_text: z.string(),
  text_digest: digest
}).strict();

const lyricsCueContentSchema = z.object({
  source: z.literal("lyrics-cue"),
  lyrics_contract_digest: digest,
  cue_id: safeId,
  occurrence_id: safeId,
  text_digest: digest
}).strict();

export const vocalEventV2Schema = z.object({
  id: safeId,
  kind: z.enum(["dialogue", "singing", "voiceover"]),
  speaker_ids: z.array(z.string().regex(/^S\d+$/)).min(1).max(32),
  language_id: safeId,
  content: z.discriminatedUnion("source", [
    lyricsCueContentSchema,
    inlineTextContentSchema,
    legacyTextContentSchema
  ]),
  start_ms: nonNegativeMs.optional(),
  end_ms: positiveMs.optional(),
  continuity: z.enum(["contained", "continues-in", "continues-out", "cutoff"])
}).strict().superRefine((event, context) => {
  if ((event.start_ms === undefined) !== (event.end_ms === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["start_ms"], message: "start_ms and end_ms must be provided together" });
  }
  if (event.start_ms !== undefined && event.end_ms !== undefined && event.end_ms <= event.start_ms) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["end_ms"], message: "end_ms must be after start_ms" });
  }
  if (event.continuity === "cutoff" && event.end_ms === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["continuity"], message: "cutoff requires an event end" });
  }
});
export type VocalEventV2 = z.infer<typeof vocalEventV2Schema>;

export const visibleTextEventV2Schema = z.object({
  id: safeId,
  text: z.string(),
  text_digest: digest,
  purpose: z.enum(["generated-scene-text", "caption-overlay", "title-overlay"]),
  render_target: z.enum(["model", "editor"])
}).strict();
export type VisibleTextEventV2 = z.infer<typeof visibleTextEventV2Schema>;

const shotSchema = z.object({
  id: safeId,
  start_ms: nonNegativeMs,
  end_ms: positiveMs,
  scene_id: safeId.optional(),
  cast: z.array(z.object({
    subject_id: safeId,
    variant_id: safeId.optional()
  }).strict()).max(128),
  composition: z.string().min(1).optional(),
  action_beats: z.array(z.object({
    at_ms: nonNegativeMs.optional(),
    description: z.string().min(1)
  }).strict()).max(128),
  camera: cameraSchema.optional(),
  vocal_events: z.array(vocalEventV2Schema).max(128),
  visible_text_events: z.array(visibleTextEventV2Schema).max(128),
  subject_expectations: z.array(z.object({
    subject_id: safeId,
    visibility: z.enum(["visible", "partial", "occluded", "offscreen"]),
    face_visibility: z.enum(["required", "optional", "not_expected"])
  }).strict()).max(128).optional(),
  constraints: z.object({
    positive: z.array(z.string().min(1)).max(256),
    exact_text_refs: z.array(safeId).max(256)
  }).strict()
}).strict().superRefine((shot, context) => {
  if (shot.end_ms <= shot.start_ms) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["end_ms"], message: "end_ms must be after start_ms" });
  }
  for (const [index, beat] of shot.action_beats.entries()) {
    if (beat.at_ms !== undefined && (beat.at_ms < shot.start_ms || beat.at_ms > shot.end_ms)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["action_beats", index, "at_ms"], message: "action beat must be inside the shot" });
    }
  }
});
export type ShotV2 = z.infer<typeof shotSchema>;

const audioSchema = z.object({
  policy: z.enum(["reuse-master", "reference-only", "native-generated", "silent"]),
  soundscape: z.string().optional(),
  non_diegetic_music: z.string().optional(),
  reference_asset_ids: z.array(safeId).max(64),
  final_mix: z.enum(["discard-generated", "use-generated", "mix-explicitly"])
}).strict();

const creativeSchema = z.object({
  intent: z.string().optional(),
  style: z.object({
    medium: z.string().optional(),
    tone: z.string().optional(),
    lighting: z.string().optional(),
    palette: z.array(z.string()).optional()
  }).strict().optional(),
  must_include: z.array(z.string().min(1)).max(256),
  prohibited: z.array(z.string().min(1)).max(256)
}).strict();

const commonShape = {
  version: z.literal(VIDEO_PROMPT_IR_VERSION),
  target: targetSchema,
  creative: creativeSchema,
  /** A locked subject is only execution-safe when this typed contract is bound. */
  identity_definition: identityDefinitionSchema.optional(),
  subjects: z.array(subjectSchema).max(256),
  scenes: z.array(sceneSchema).max(256),
  assets: z.array(assetSchema).max(256),
  shots: z.array(shotSchema).min(1).max(256),
  audio: audioSchema
};

const standaloneSchema = z.object({
  ...commonShape,
  program_kind: z.literal("standalone"),
  program_binding: z.never().optional()
}).strict();

const mvSchema = z.object({
  ...commonShape,
  program_kind: z.literal("mv"),
  program_binding: programBindingSchema
}).strict();

export const videoPromptIrV2Schema = z.discriminatedUnion("program_kind", [standaloneSchema, mvSchema]).superRefine((ir, context) => {
  const checkUnique = (values: string[], path: string) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: z.ZodIssueCode.custom, path: path.split("."), message: `${path} ids must be unique` });
  };
  checkUnique(ir.subjects.map((item) => item.id), "subjects");
  checkUnique(ir.scenes.map((item) => item.id), "scenes");
  checkUnique(ir.assets.map((item) => item.id), "assets");
  checkUnique(ir.shots.map((item) => item.id), "shots");
  const firstShot = ir.shots[0];
  if (firstShot && firstShot.start_ms !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["shots", 0, "start_ms"], message: "shot timeline must start at 0ms", params: { code: "VPD-T001" } });
  }
  for (let index = 1; index < ir.shots.length; index += 1) {
    const previous = ir.shots[index - 1]!;
    const current = ir.shots[index]!;
    if (current.start_ms < previous.start_ms) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["shots", index, "start_ms"], message: "shots must be ordered by start_ms", params: { code: "VPD-T001" } });
    }
    if (current.start_ms !== previous.end_ms) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["shots", index, "start_ms"], message: current.start_ms > previous.end_ms ? "shot timeline contains a gap" : "shot timeline contains an overlap", params: { code: "VPD-T002" } });
    }
  }
  const finalShot = ir.shots[ir.shots.length - 1];
  if (finalShot && finalShot.end_ms !== ir.target.duration_ms) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["shots", ir.shots.length - 1, "end_ms"], message: "shot timeline must end at target.duration_ms", params: { code: "VPD-T003" } });
  }
  const subjectIds = new Set(ir.subjects.map((item) => item.id));
  const sceneIds = new Set(ir.scenes.map((item) => item.id));
  const assetIds = new Set(ir.assets.map((item) => item.id));
  for (const [subjectIndex, subject] of ir.subjects.entries()) {
    if (subject.source_asset_id && !assetIds.has(subject.source_asset_id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["subjects", subjectIndex, "source_asset_id"], message: "subject source asset is undefined" });
    if (subject.voice?.source_asset_id && !assetIds.has(subject.voice.source_asset_id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["subjects", subjectIndex, "voice", "source_asset_id"], message: "voice source asset is undefined" });
    for (const [variantIndex, variant] of (subject.variants ?? []).entries()) {
      if (!assetIds.has(variant.source_asset_id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["subjects", subjectIndex, "variants", variantIndex, "source_asset_id"], message: "variant source asset is undefined" });
    }
  }
  for (const [sceneIndex, scene] of ir.scenes.entries()) {
    for (const [subjectIndex, subjectId] of scene.active_subject_ids.entries()) {
      if (!subjectIds.has(subjectId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["scenes", sceneIndex, "active_subject_ids", subjectIndex], message: "scene subject is undefined" });
    }
  }
  for (const [shotIndex, shot] of ir.shots.entries()) {
    if (shot.scene_id && !sceneIds.has(shot.scene_id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["shots", shotIndex, "scene_id"], message: "shot scene is undefined" });
    const eventIds: string[] = [];
    for (const [castIndex, cast] of shot.cast.entries()) {
      if (!subjectIds.has(cast.subject_id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["shots", shotIndex, "cast", castIndex, "subject_id"], message: "cast subject is undefined" });
      const subject = ir.subjects.find((candidate) => candidate.id === cast.subject_id);
      if (cast.variant_id && !subject?.variants?.some((variant) => variant.id === cast.variant_id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["shots", shotIndex, "cast", castIndex, "variant_id"], message: "cast variant is undefined" });
    }
    for (const expectation of shot.subject_expectations ?? []) if (!subjectIds.has(expectation.subject_id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["shots", shotIndex, "subject_expectations"], message: "subject expectation is undefined" });
    for (const event of shot.vocal_events) eventIds.push(event.id);
    for (const event of shot.visible_text_events) eventIds.push(event.id);
    checkUnique(eventIds, `shots.${shotIndex}.events`);
    const exactIds = new Set([...eventIds]);
    for (const [constraintIndex, ref] of shot.constraints.exact_text_refs.entries()) if (!exactIds.has(ref)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["shots", shotIndex, "constraints", "exact_text_refs", constraintIndex], message: "exact text reference is undefined" });
    for (const [eventIndex, event] of shot.vocal_events.entries()) {
      if (event.start_ms !== undefined && event.end_ms !== undefined
        && (event.start_ms < shot.start_ms || event.end_ms > shot.end_ms)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["shots", shotIndex, "vocal_events", eventIndex], message: "vocal event must be contained by its shot", params: { code: "VPD-T004" } });
      }
      if (event.continuity === "continues-in" && event.start_ms !== undefined && event.start_ms !== shot.start_ms) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["shots", shotIndex, "vocal_events", eventIndex, "start_ms"], message: "continues-in vocal event must begin at the shot boundary", params: { code: "VPD-T005" } });
      }
      if ((event.continuity === "continues-out" || event.continuity === "cutoff") && event.end_ms !== undefined && event.end_ms !== shot.end_ms) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["shots", shotIndex, "vocal_events", eventIndex, "end_ms"], message: "continuing or cutoff vocal event must end at the shot boundary", params: { code: "VPD-T005" } });
      }
    }
  }
  const first = ir.assets.filter((asset) => asset.role === "first_frame" && asset.type === "image");
  const last = ir.assets.filter((asset) => asset.role === "last_frame" && asset.type === "image");
  if (ir.target.mode === "text-to-video" && ir.assets.length > 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["assets"], message: "text-to-video mode must not declare execution assets", params: { code: "VPD-A002" } });
  if (ir.target.mode === "first-frame" && (first.length !== 1 || last.length > 0 || ir.assets.length !== 1)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["assets"], message: "first-frame mode requires exactly one first-frame image and no other asset" });
  if (ir.target.mode === "first-last" && (first.length !== 1 || last.length !== 1)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["assets"], message: "first-last mode requires one first-frame and one last-frame image" });
  if (ir.target.mode === "last-frame" && (last.length !== 1 || ir.assets.some((asset) => asset.role !== "last_frame" || asset.type !== "image"))) context.addIssue({ code: z.ZodIssueCode.custom, path: ["assets"], message: "last-frame mode requires exactly one last-frame image" });
  if (ir.target.mode === "text-to-video" && (first.length > 0 || last.length > 0)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["assets"], message: "text-to-video mode cannot carry frame-alignment assets", params: { code: "VPD-A002" } });
  if (ir.target.mode === "first-last" && ir.assets.length !== 2) context.addIssue({ code: z.ZodIssueCode.custom, path: ["assets"], message: "first-last mode cannot mix frame alignment with other assets", params: { code: "VPD-A002" } });
  if (ir.target.mode === "reference" && (ir.assets.length === 0 || first.length > 0 || last.length > 0)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["assets"], message: "reference mode requires reference assets and cannot carry frame-alignment assets", params: { code: "VPD-A002" } });
  for (const [index, assetId] of ir.audio.reference_asset_ids.entries()) {
    const asset = ir.assets.find((candidate) => candidate.id === assetId);
    if (!asset) context.addIssue({ code: z.ZodIssueCode.custom, path: ["audio", "reference_asset_ids", index], message: "audio reference asset is undefined", params: { code: "VPD-A001" } });
    else if (asset.type !== "audio" || !["voice_reference", "other"].includes(asset.role)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["audio", "reference_asset_ids", index], message: "audio reference must bind an audio asset with an audio role", params: { code: "VPD-A001" } });
  }
  const audioAssets = ir.assets.filter((asset) => asset.type === "audio");
  const audioAssetIds = audioAssets.map((asset) => asset.id).sort();
  const referenceAssetIds = [...ir.audio.reference_asset_ids].sort();
  if (ir.audio.policy === "reference-only") {
    if (referenceAssetIds.length !== 1 || audioAssetIds.join("\u0000") !== referenceAssetIds.join("\u0000")) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["audio", "reference_asset_ids"], message: "reference-only audio must send exactly its one authoritative reference asset", params: { code: "VPD-A001" } });
    }
  } else if (referenceAssetIds.length > 0 || audioAssetIds.length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["audio"], message: "only reference-only audio policy may bind provider audio assets", params: { code: "VPD-A001" } });
  }
  if (ir.audio.policy === "reuse-master" && ir.audio.final_mix !== "discard-generated") context.addIssue({ code: z.ZodIssueCode.custom, path: ["audio", "final_mix"], message: "reuse-master must discard generated audio" });
  if (ir.audio.policy === "native-generated" && ir.audio.final_mix === "discard-generated") context.addIssue({ code: z.ZodIssueCode.custom, path: ["audio", "final_mix"], message: "native-generated audio must be used or explicitly mixed" });
  if (ir.audio.policy === "silent" && ir.audio.final_mix !== "discard-generated") context.addIssue({ code: z.ZodIssueCode.custom, path: ["audio", "final_mix"], message: "silent audio policy cannot use generated audio" });
});
export type VideoPromptIrV2 = z.infer<typeof videoPromptIrV2Schema>;
export type VideoPromptIrV2Standalone = z.infer<typeof standaloneSchema>;
export type VideoPromptIrV2Mv = z.infer<typeof mvSchema>;
export type ProgramBindingForV2 = ProgramBindingV1;
export type RouteIdentityForV2 = RouteIdentityV1;

export function parseVideoPromptIrV2(value: unknown): VideoPromptIrV2 {
  return videoPromptIrV2Schema.parse(value);
}

export function safeParseVideoPromptIrV2(value: unknown) {
  return videoPromptIrV2Schema.safeParse(value);
}

export { programBindingSchema, routeIdentitySchema };
