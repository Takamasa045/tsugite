import { z } from "zod";
import { sha256Canonical } from "./canonical.js";
import { pcError } from "./errors.js";
import { contractFragmentRefSchema, digestSchema, safeIdSchema, type ContractFragmentRef } from "./schema.js";

export const routeIdentitySchema = z.object({
  ir_model: safeIdSchema,
  provider_model: safeIdSchema,
  model_profile_digest: digestSchema,
  connection_id: safeIdSchema,
  connection_digest: digestSchema,
  adapter_id: safeIdSchema,
  transport: safeIdSchema,
  mode_binding: safeIdSchema,
  route_digest: digestSchema
}).strict();
export type RouteIdentity = z.infer<typeof routeIdentitySchema>;
export type RouteIdentityV1 = RouteIdentity;

/**
 * The stable GenerationUnit -> VideoPrompt IR boundary from the design. It
 * intentionally contains no IR or compilation digest, so the lineage remains
 * one-way and cannot form a circular digest. T03 validates the source-side
 * contract fragment kinds and route identity; T04 owns duration/timing
 * feasibility and compiler-side route verification.
 */
export const programBindingSchema = z.object({
  generation_unit_digest: digestSchema,
  production_id: safeIdSchema,
  music_contract_digest: digestSchema,
  lyrics_contract_digest: digestSchema.optional(),
  program_start_ms: z.number().int().nonnegative(),
  program_end_ms: z.number().int().positive(),
  section_id: safeIdSchema.optional(),
  beat_anchor_ids: z.array(safeIdSchema).max(256),
  lyric_cue_ids: z.array(safeIdSchema).max(256)
}).strict().superRefine((binding, context) => {
  if (binding.program_end_ms <= binding.program_start_ms) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["program_end_ms"], message: "program end must be after start" });
  }
  if (new Set(binding.beat_anchor_ids).size !== binding.beat_anchor_ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["beat_anchor_ids"], message: "beat anchor ids must be unique" });
  }
  if (new Set(binding.lyric_cue_ids).size !== binding.lyric_cue_ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["lyric_cue_ids"], message: "lyric cue ids must be unique" });
  }
});
export type ProgramBinding = z.infer<typeof programBindingSchema>;
export type ProgramBindingV1 = ProgramBinding;

const contractBindingSchema = z.object({
  contract_id: safeIdSchema,
  revision: z.number().int().nonnegative(),
  contract_digest: digestSchema,
  timing_digest: digestSchema.optional(),
  text_digest: digestSchema.optional(),
  master_audio_digest: digestSchema.optional()
}).strict();

/**
 * Stable source-side reference consumed by the MV compiler. The route and
 * contract revisions live here, upstream of the IR binding.
 */
export const generationUnitProgramSourceSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("mv-generation-unit-source"),
  production_id: safeIdSchema,
  unit_id: safeIdSchema,
  ordinal: z.number().int().nonnegative(),
  generation_unit_digest: digestSchema,
  music: contractBindingSchema,
  lyrics: contractBindingSchema.optional(),
  program_start_ms: z.number().int().nonnegative(),
  program_end_ms: z.number().int().positive(),
  section_id: safeIdSchema.optional(),
  beat_anchor_refs: z.array(contractFragmentRefSchema).max(256),
  lyric_cue_refs: z.array(contractFragmentRefSchema).max(256),
  route: routeIdentitySchema
}).strict().superRefine((unit, context) => {
  if (unit.program_end_ms <= unit.program_start_ms) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["program_end_ms"], message: "program end must be after start" });
  }
  if (unit.music.master_audio_digest === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["music", "master_audio_digest"], message: "music binding requires master audio digest" });
  }
  for (const [index, ref] of unit.beat_anchor_refs.entries()) {
    if (ref.kind !== "beat" || ref.slot !== "music" || ref.contract_id !== unit.music.contract_id || ref.revision !== unit.music.revision) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["beat_anchor_refs", index], message: "beat anchor must bind the source music contract revision" });
    }
  }
  for (const [index, ref] of unit.lyric_cue_refs.entries()) {
    if (ref.kind !== "lyric-cue" || !unit.lyrics || ref.slot !== "lyrics" || ref.contract_id !== unit.lyrics.contract_id || ref.revision !== unit.lyrics.revision) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["lyric_cue_refs", index], message: "lyric cue must bind the source lyrics contract revision" });
    }
  }
});
export type GenerationUnitProgramSource = z.infer<typeof generationUnitProgramSourceSchema>;
export type GenerationUnitProgramSourceV1 = GenerationUnitProgramSource;

export function buildProgramBinding(source: GenerationUnitProgramSource): ProgramBinding {
  const parsed = generationUnitProgramSourceSchema.parse(source);
  const binding = {
    generation_unit_digest: parsed.generation_unit_digest,
    production_id: parsed.production_id,
    music_contract_digest: parsed.music.contract_digest,
    ...(parsed.lyrics ? { lyrics_contract_digest: parsed.lyrics.contract_digest } : {}),
    program_start_ms: parsed.program_start_ms,
    program_end_ms: parsed.program_end_ms,
    ...(parsed.section_id ? { section_id: parsed.section_id } : {}),
    beat_anchor_ids: parsed.beat_anchor_refs.map((ref) => ref.fragment_id),
    lyric_cue_ids: parsed.lyric_cue_refs.map((ref) => ref.fragment_id)
  };
  return programBindingSchema.parse(binding);
}

export function programBindingDigest(binding: ProgramBinding): string {
  return sha256Canonical(programBindingSchema.parse(binding));
}

export function assertProgramBindingMatchesSource(
  binding: ProgramBinding,
  source: GenerationUnitProgramSource
): void {
  const parsedBinding = programBindingSchema.parse(binding);
  const parsedSource = generationUnitProgramSourceSchema.parse(source);
  const expected = buildProgramBinding(parsedSource);
  if (sha256Canonical(parsedBinding) !== sha256Canonical(expected)) {
    throw pcError("PC_PROGRAM_BINDING_INVALID", "program binding does not match the generation unit source");
  }
}

export function assertNoCircularProgramBinding(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.some((key) => ["video_prompt_digest", "ir_digest", "compilation_digest", "program_binding_digest"].includes(key))) {
    throw pcError("PC_PROGRAM_BINDING_INVALID", "program binding must not reference a downstream IR or compilation digest");
  }
  try {
    programBindingSchema.parse(value);
  } catch {
    throw pcError("PC_PROGRAM_BINDING_INVALID", "invalid program binding");
  }
}

export function programBindingRoute(source: GenerationUnitProgramSource): RouteIdentity {
  return routeIdentitySchema.parse(source.route);
}
