import { z } from "zod";
import { sha256Canonical, withoutField } from "../canonical.js";
import { contractFragmentRefSchema, digestSchema, safeIdSchema, type ContractFragmentRef } from "../schema.js";
import {
  generationUnitProgramSourceSchema,
  routeIdentitySchema,
  type GenerationUnitProgramSource,
  type RouteIdentity
} from "../programBinding.js";
import { lyricsContractSchema, type LyricsContract } from "./lyrics.js";
import { musicStructureContractSchema, type MusicStructureContract } from "./music.js";

const nonNegativeInt = z.number().finite().int().nonnegative();
const positiveInt = z.number().finite().int().positive();

const referenceAudioBindingSchema = z.object({
  derived_asset_id: safeIdSchema,
  derived_asset_digest: digestSchema,
  source_master_audio_digest: digestSchema,
  source_start_ms: nonNegativeInt,
  source_end_ms: positiveInt,
  /** A reference asset is accepted only after project-local pin verification. */
  pinned: z.literal(true)
}).strict();

export const generationUnitContractSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("mv-generation-unit"),
  production_id: safeIdSchema,
  unit_id: safeIdSchema,
  ordinal: nonNegativeInt,
  music_binding: z.object({
    contract_id: safeIdSchema,
    revision: nonNegativeInt,
    contract_digest: digestSchema,
    timing_digest: digestSchema,
    master_audio_digest: digestSchema
  }).strict(),
  lyrics_binding: z.object({
    contract_id: safeIdSchema,
    revision: nonNegativeInt,
    contract_digest: digestSchema.optional(),
    text_digest: digestSchema,
    timing_digest: z.union([digestSchema, z.null()])
  }).strict().optional(),
  program: z.object({
    master_duration_ms: positiveInt,
    start_ms: nonNegativeInt,
    end_ms: positiveInt,
    section_id: safeIdSchema.optional()
  }).strict(),
  clip_duration_ms: positiveInt,
  beat_anchor_refs: z.array(contractFragmentRefSchema).max(256),
  lyric_cue_refs: z.array(contractFragmentRefSchema).max(256),
  audio_policy: z.enum(["reuse-master", "reference-only", "native-generated", "silent"]),
  reference_audio_binding: referenceAudioBindingSchema.optional(),
  route: routeIdentitySchema,
  digest: digestSchema
}).strict().superRefine((value, context) => {
  if (value.program.start_ms >= value.program.end_ms || value.program.end_ms > value.program.master_duration_ms) context.addIssue({ code: z.ZodIssueCode.custom, path: ["program"], message: "generation unit interval must be inside master audio" });
  if (value.program.end_ms - value.program.start_ms !== value.clip_duration_ms) context.addIssue({ code: z.ZodIssueCode.custom, path: ["clip_duration_ms"], message: "clip duration must equal master interval" });
  const beatKeys = value.beat_anchor_refs.map((ref) => `${ref.contract_id}\u0000${ref.revision}\u0000${ref.fragment_id}`);
  const cueKeys = value.lyric_cue_refs.map((ref) => `${ref.contract_id}\u0000${ref.revision}\u0000${ref.fragment_id}`);
  if (new Set(beatKeys).size !== beatKeys.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["beat_anchor_refs"], message: "beat anchors must be unique" });
  if (new Set(cueKeys).size !== cueKeys.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["lyric_cue_refs"], message: "lyric cues must be unique" });
  for (const [index, ref] of value.beat_anchor_refs.entries()) {
    if (ref.slot !== "music" || ref.kind !== "beat" || ref.contract_id !== value.music_binding.contract_id || ref.revision !== value.music_binding.revision) context.addIssue({ code: z.ZodIssueCode.custom, path: ["beat_anchor_refs", index], message: "beat anchor must bind music revision" });
  }
  for (const [index, ref] of value.lyric_cue_refs.entries()) {
    if (!value.lyrics_binding || ref.slot !== "lyrics" || ref.kind !== "lyric-cue" || ref.contract_id !== value.lyrics_binding.contract_id || ref.revision !== value.lyrics_binding.revision) context.addIssue({ code: z.ZodIssueCode.custom, path: ["lyric_cue_refs", index], message: "lyric cue must bind lyrics revision" });
  }
  if (value.audio_policy === "reference-only") {
    if (!value.reference_audio_binding) context.addIssue({ code: z.ZodIssueCode.custom, path: ["reference_audio_binding"], message: "reference-only requires a pinned derived asset" });
    else {
      const binding = value.reference_audio_binding;
      if (binding.source_master_audio_digest !== value.music_binding.master_audio_digest) context.addIssue({ code: z.ZodIssueCode.custom, path: ["reference_audio_binding", "source_master_audio_digest"], message: "reference audio source master digest mismatch" });
      if (binding.source_start_ms !== value.program.start_ms || binding.source_end_ms !== value.program.end_ms) context.addIssue({ code: z.ZodIssueCode.custom, path: ["reference_audio_binding"], message: "reference audio must be unit-local" });
    }
  } else if (value.reference_audio_binding) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reference_audio_binding"], message: "only reference-only may bind derived reference audio" });
  }
  if (sha256Canonical(withoutField(value, "digest")) !== value.digest) context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "generation unit digest mismatch" });
});
export type GenerationUnitContractV1 = z.infer<typeof generationUnitContractSchema>;
export type GenerationUnitContract = GenerationUnitContractV1;

export type GenerationUnitInput = {
  production_id: string;
  unit_id: string;
  ordinal: number;
  music: MusicStructureContract;
  lyrics?: LyricsContract;
  start_ms: number;
  end_ms: number;
  section_id?: string;
  beat_anchor_ids?: string[];
  lyric_cue_ids?: string[];
  audio_policy: GenerationUnitContractV1["audio_policy"];
  reference_audio_binding?: z.infer<typeof referenceAudioBindingSchema>;
  route: RouteIdentity;
};

function musicFragment(music: MusicStructureContract, id: string): ContractFragmentRef {
  const beat = music.beat_markers.find((candidate) => candidate.id === id);
  if (!beat) throw new Error(`unknown music beat: ${id}`);
  return { slot: "music", contract_id: music.contract_id, revision: music.revision, kind: "beat", fragment_id: id, digest: sha256Canonical(beat) };
}

function lyricsFragment(lyrics: LyricsContract, id: string): ContractFragmentRef {
  const cue = lyrics.cues.find((candidate) => candidate.id === id);
  if (!cue) throw new Error(`unknown lyrics cue: ${id}`);
  return { slot: "lyrics", contract_id: lyrics.contract_id, revision: lyrics.revision, kind: "lyric-cue", fragment_id: id, digest: sha256Canonical(cue) };
}

export function createGenerationUnit(input: GenerationUnitInput): GenerationUnitContractV1 {
  const music = musicStructureContractSchema.parse(input.music);
  const lyrics = input.lyrics ? lyricsContractSchema.parse(input.lyrics) : undefined;
  if (input.start_ms < 0 || input.end_ms <= input.start_ms || input.end_ms > music.master_audio.duration_ms) throw new Error("generation unit interval must be inside master audio");
  if (input.section_id) {
    const section = music.sections.find((candidate) => candidate.id === input.section_id);
    if (!section || input.start_ms < section.start_ms || input.end_ms > section.end_ms) throw new Error("generation unit interval must be inside its section");
  }
  const beatIds = input.beat_anchor_ids ?? [];
  const cueIds = input.lyric_cue_ids ?? [];
  for (const beatId of beatIds) {
    const beat = music.beat_markers.find((candidate) => candidate.id === beatId);
    if (!beat || beat.at_ms < input.start_ms || beat.at_ms > input.end_ms) throw new Error("generation unit beat must be inside its interval");
  }
  if (lyrics) {
    for (const cueId of cueIds) {
      const cue = lyrics.cues.find((candidate) => candidate.id === cueId);
      if (!cue) throw new Error(`unknown lyrics cue: ${cueId}`);
      if (cue.timing === "timed" && (cue.start_ms < input.start_ms || cue.end_ms > input.end_ms)) throw new Error("generation unit lyric cue must be inside its interval");
    }
  }
  const base = {
    schema_version: 1 as const,
    kind: "mv-generation-unit" as const,
    production_id: safeIdSchema.parse(input.production_id),
    unit_id: safeIdSchema.parse(input.unit_id),
    ordinal: input.ordinal,
    music_binding: {
      contract_id: music.contract_id,
      revision: music.revision,
      contract_digest: music.digest,
      timing_digest: music.timing_digest,
      master_audio_digest: music.master_audio.sha256
    },
    ...(lyrics ? {
      lyrics_binding: {
        contract_id: lyrics.contract_id,
        revision: lyrics.revision,
        contract_digest: lyrics.digest,
        text_digest: lyrics.source.text_digest,
        timing_digest: lyrics.timing_digest
      }
    } : {}),
    program: {
      master_duration_ms: music.master_audio.duration_ms,
      start_ms: input.start_ms,
      end_ms: input.end_ms,
      ...(input.section_id ? { section_id: input.section_id } : {})
    },
    clip_duration_ms: input.end_ms - input.start_ms,
    beat_anchor_refs: beatIds.map((id) => musicFragment(music, id)),
    lyric_cue_refs: cueIds.map((id) => {
      if (!lyrics) throw new Error("lyric cue ids require a lyrics contract");
      return lyricsFragment(lyrics, id);
    }),
    audio_policy: input.audio_policy,
    ...(input.reference_audio_binding ? { reference_audio_binding: input.reference_audio_binding } : {}),
    route: routeIdentitySchema.parse(input.route)
  };
  return generationUnitContractSchema.parse({ ...base, digest: sha256Canonical(base) });
}

export function generationUnitContractDigest(value: GenerationUnitContractV1): string {
  return generationUnitContractSchema.parse(value).digest;
}

export function toProgramBindingSource(unit: GenerationUnitContractV1): GenerationUnitProgramSource {
  const parsed = generationUnitContractSchema.parse(unit);
  if (parsed.lyrics_binding && !parsed.lyrics_binding.contract_digest) throw new Error("lyrics contract digest is required to produce the T03 program-binding source");
  return generationUnitProgramSourceSchema.parse({
    schema_version: 1,
    kind: "mv-generation-unit-source",
    production_id: parsed.production_id,
    unit_id: parsed.unit_id,
    ordinal: parsed.ordinal,
    generation_unit_digest: parsed.digest,
    music: {
      contract_id: parsed.music_binding.contract_id,
      revision: parsed.music_binding.revision,
      contract_digest: parsed.music_binding.contract_digest,
      timing_digest: parsed.music_binding.timing_digest,
      master_audio_digest: parsed.music_binding.master_audio_digest
    },
    ...(parsed.lyrics_binding ? {
      lyrics: {
        contract_id: parsed.lyrics_binding.contract_id,
        revision: parsed.lyrics_binding.revision,
        contract_digest: parsed.lyrics_binding.contract_digest,
        text_digest: parsed.lyrics_binding.text_digest,
        timing_digest: parsed.lyrics_binding.timing_digest
      }
    } : {}),
    program_start_ms: parsed.program.start_ms,
    program_end_ms: parsed.program.end_ms,
    ...(parsed.program.section_id ? { section_id: parsed.program.section_id } : {}),
    beat_anchor_refs: parsed.beat_anchor_refs,
    lyric_cue_refs: parsed.lyric_cue_refs,
    route: parsed.route
  });
}

export const generationUnitSchema = generationUnitContractSchema;
