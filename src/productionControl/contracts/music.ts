import { z } from "zod";
import { sha256Canonical, withoutField } from "../canonical.js";
import { digestSchema, safeIdSchema } from "../schema.js";

const finiteInt = z.number().finite().int();
const nonNegativeInt = finiteInt.nonnegative();
const positiveInt = finiteInt.positive();

export const musicSectionPolicySchema = z.object({
  gaps: z.enum(["allow", "forbid"]),
  overlaps: z.enum(["allow", "forbid"])
}).strict();
export type MusicSectionPolicyV1 = z.infer<typeof musicSectionPolicySchema>;

const masterAudioSchema = z.object({
  asset_id: safeIdSchema,
  sha256: digestSchema,
  duration_ms: positiveInt,
  sample_rate: positiveInt.optional(),
  channels: positiveInt.optional()
}).strict();

const musicAnalysisSchema = z.object({
  status: z.enum(["analyzed", "manual", "imported", "unknown"]),
  analyzer_id: safeIdSchema.optional(),
  analyzer_version: safeIdSchema.optional(),
  evidence_artifact_id: safeIdSchema.optional(),
  confidence: z.number().finite().min(0).max(1).optional()
}).strict();

export const tempoMapEntrySchema = z.object({
  id: safeIdSchema,
  start_ms: nonNegativeInt,
  end_ms: positiveInt.optional(),
  bpm: z.number().finite().positive(),
  meter: z.string().min(1).max(32).optional(),
  confidence: z.number().finite().min(0).max(1).optional()
}).strict();

export const beatMarkerSchema = z.object({
  id: safeIdSchema,
  at_ms: nonNegativeInt,
  kind: z.enum(["beat", "downbeat", "accent", "transition"]),
  bar: positiveInt.optional(),
  beat: positiveInt.optional()
}).strict();

export const musicSectionSchema = z.object({
  id: safeIdSchema,
  label: z.string().min(1).max(120),
  start_ms: nonNegativeInt,
  end_ms: positiveInt,
  musical_role: z.string().min(1).max(120).optional(),
  energy: z.number().finite().min(0).max(1).optional()
}).strict();

const musicStructureContentSchema = z.object({
  schema_version: z.literal(1),
  contract_id: safeIdSchema,
  revision: nonNegativeInt,
  master_audio: masterAudioSchema,
  analysis: musicAnalysisSchema,
  tempo_map: z.array(tempoMapEntrySchema).max(1_000),
  beat_markers: z.array(beatMarkerSchema).max(100_000),
  sections: z.array(musicSectionSchema).max(256),
  section_policy: musicSectionPolicySchema.default({ gaps: "allow", overlaps: "forbid" }),
  source_digest: digestSchema,
  timing_digest: digestSchema
}).strict();

export const musicStructureContractSchema = musicStructureContentSchema.extend({ digest: digestSchema }).strict().superRefine((value, context) => {
  const duration = value.master_audio.duration_ms;
  const tempoIds = value.tempo_map.map((entry) => entry.id);
  const beatIds = value.beat_markers.map((entry) => entry.id);
  const sectionIds = value.sections.map((section) => section.id);
  if (new Set(tempoIds).size !== tempoIds.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["tempo_map"], message: "tempo ids must be unique" });
  if (new Set(beatIds).size !== beatIds.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["beat_markers"], message: "beat ids must be unique" });
  if (new Set(sectionIds).size !== sectionIds.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["sections"], message: "section ids must be unique" });
  if (value.analysis.status === "unknown" && value.tempo_map.length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["tempo_map"], message: "unknown BPM cannot carry invented tempo entries" });
  }
  for (const [index, tempo] of value.tempo_map.entries()) {
    if (tempo.start_ms >= duration || tempo.end_ms !== undefined && tempo.end_ms > duration || tempo.end_ms !== undefined && tempo.end_ms <= tempo.start_ms) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tempo_map", index], message: "tempo interval is outside master audio" });
    }
    if (index > 0 && tempo.start_ms < value.tempo_map[index - 1]!.start_ms) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tempo_map", index, "start_ms"], message: "tempo map must be ordered" });
    }
  }
  for (const [index, beat] of value.beat_markers.entries()) {
    if (beat.at_ms > duration) context.addIssue({ code: z.ZodIssueCode.custom, path: ["beat_markers", index, "at_ms"], message: "beat marker is outside master audio" });
    if (index > 0 && beat.at_ms < value.beat_markers[index - 1]!.at_ms) context.addIssue({ code: z.ZodIssueCode.custom, path: ["beat_markers", index, "at_ms"], message: "beat markers must be ordered" });
  }
  for (const [index, section] of value.sections.entries()) {
    if (section.end_ms <= section.start_ms || section.end_ms > duration) context.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", index], message: "section interval is outside master audio" });
    if (index > 0) {
      const previous = value.sections[index - 1]!;
      if (section.start_ms < previous.start_ms) context.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", index, "start_ms"], message: "sections must be ordered" });
      if (section.start_ms < previous.end_ms && value.section_policy.overlaps === "forbid") context.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", index], message: "section overlap is forbidden" });
      if (section.start_ms > previous.end_ms && value.section_policy.gaps === "forbid") context.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", index], message: "section gap is forbidden" });
    }
  }
  const expectedSource = sha256Canonical({ master_audio: value.master_audio, analysis: value.analysis });
  const expectedTiming = sha256Canonical({ tempo_map: value.tempo_map, beat_markers: value.beat_markers, sections: value.sections, section_policy: value.section_policy });
  if (value.source_digest !== expectedSource) context.addIssue({ code: z.ZodIssueCode.custom, path: ["source_digest"], message: "music source digest mismatch" });
  if (value.timing_digest !== expectedTiming) context.addIssue({ code: z.ZodIssueCode.custom, path: ["timing_digest"], message: "music timing digest mismatch" });
  if (sha256Canonical(withoutField(value, "digest")) !== value.digest) context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "music contract digest mismatch" });
});
export type MusicStructureContractV1 = z.infer<typeof musicStructureContractSchema>;
export type MusicStructureContract = MusicStructureContractV1;

export type MusicStructureContractInput = Omit<MusicStructureContractV1, "schema_version" | "source_digest" | "timing_digest" | "digest">;

export function createMusicStructureContract(input: MusicStructureContractInput): MusicStructureContractV1 {
  const { schema_version: _schemaVersion, source_digest: _sourceDigest, timing_digest: _timingDigest, digest: _digest, ...raw } = input as MusicStructureContractInput & { schema_version?: unknown; source_digest?: unknown; timing_digest?: unknown; digest?: unknown };
  const content = musicStructureContentSchema.omit({ source_digest: true, timing_digest: true }).parse({ schema_version: 1, ...raw });
  const source_digest = sha256Canonical({ master_audio: content.master_audio, analysis: content.analysis });
  const timing_digest = sha256Canonical({ tempo_map: content.tempo_map, beat_markers: content.beat_markers, sections: content.sections, section_policy: content.section_policy });
  const withoutDigest = { ...content, source_digest, timing_digest };
  return musicStructureContractSchema.parse({ ...withoutDigest, digest: sha256Canonical(withoutDigest) });
}

export function musicStructureContractDigest(value: MusicStructureContractV1): string {
  return musicStructureContractSchema.parse(value).digest;
}

export const musicSchema = musicStructureContractSchema;
