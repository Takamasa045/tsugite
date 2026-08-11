import { z } from "zod";
import { sha256Canonical, withoutField } from "../canonical.js";
import { digestSchema, safeIdSchema } from "../schema.js";
import { type LyricsContract } from "../contracts/lyrics.js";
import { type GenerationUnitContract } from "../contracts/generationUnit.js";
import { type MusicStructureContract } from "../contracts/music.js";
import { compileMvTimeline } from "../mv/timeline.js";

export const mvTemplateSchema = z.object({
  schema_version: z.literal(1),
  template_id: safeIdSchema,
  kind: z.literal("mv"),
  production_id: safeIdSchema,
  duration_ms: z.number().int().positive(),
  master_audio_digest: digestSchema,
  generation_unit_digests: z.array(digestSchema).min(1).max(10_000),
  lyric_cue_ids: z.array(safeIdSchema).max(100_000),
  audio_policy: z.enum(["reuse-master", "reference-only", "native-generated", "silent", "mixed"]),
  identity_requirement: z.enum(["required", "optional", "not_applicable"]),
  digest: digestSchema
}).strict().superRefine((value, context) => {
  if (new Set(value.generation_unit_digests).size !== value.generation_unit_digests.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["generation_unit_digests"], message: "MV template generation units must be unique" });
  if (sha256Canonical(withoutField(value, "digest")) !== value.digest) context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "MV template digest mismatch" });
});
export type MvTemplateV1 = z.infer<typeof mvTemplateSchema>;

export function createMvTemplate(input: {
  production_id: string;
  music: MusicStructureContract;
  lyrics?: LyricsContract;
  units: GenerationUnitContract[];
  template_id?: string;
  identity_requirement?: "required" | "optional" | "not_applicable";
}): MvTemplateV1 {
  const timeline = compileMvTimeline({ music: input.music, lyrics: input.lyrics, units: input.units, exact_sync: Boolean(input.lyrics) });
  if (timeline.units.some((unit) => unit.production_id !== input.production_id)) throw new Error("MV template production id must match generation units");
  const policies = new Set(timeline.units.map((unit) => unit.audio_policy));
  const base = {
    schema_version: 1 as const,
    template_id: safeIdSchema.parse(input.template_id ?? "mv-standard"),
    kind: "mv" as const,
    production_id: safeIdSchema.parse(input.production_id),
    duration_ms: timeline.duration_ms,
    master_audio_digest: timeline.master_audio_digest,
    generation_unit_digests: timeline.units.map((unit) => unit.digest),
    lyric_cue_ids: input.lyrics?.cues.map((cue) => cue.id) ?? [],
    audio_policy: policies.size === 1 ? timeline.units[0]!.audio_policy : "mixed" as const,
    identity_requirement: input.identity_requirement ?? "optional"
  };
  return mvTemplateSchema.parse({ ...base, digest: sha256Canonical(base) });
}

export function mvTemplateDigest(value: MvTemplateV1): string {
  return mvTemplateSchema.parse(value).digest;
}

export const mvProductionTemplate = mvTemplateSchema;
