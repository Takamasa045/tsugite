import { z } from "zod";
import { sha256Canonical, withoutField } from "../canonical.js";
import { digestSchema, safeIdSchema, type ContractFragmentRef } from "../schema.js";
import { lyricsContractSchema, type LyricsContract } from "../contracts/lyrics.js";
import { generationUnitContractSchema, type GenerationUnitContract } from "../contracts/generationUnit.js";
import { musicStructureContractSchema, type MusicStructureContract } from "../contracts/music.js";

const nonNegativeInt = z.number().finite().int().nonnegative();
const positiveInt = z.number().finite().int().positive();

export const mvTimelineSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("mv-master-timeline"),
  production_id: safeIdSchema,
  master_audio_digest: digestSchema,
  duration_ms: positiveInt,
  units: z.array(generationUnitContractSchema).min(1).max(10_000),
  digest: digestSchema
}).strict().superRefine((value, context) => {
  const expected = sha256Canonical(withoutField(value, "digest"));
  if (expected !== value.digest) context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "MV timeline digest mismatch" });
});
export type MvTimelineV1 = z.infer<typeof mvTimelineSchema>;
export type MvMasterTimeline = MvTimelineV1;

export type CompileMvTimelineInput = {
  music: MusicStructureContract;
  lyrics?: LyricsContract;
  units: GenerationUnitContract[];
  exact_sync?: boolean;
  require_contiguous?: boolean;
};

function fragmentId(ref: ContractFragmentRef): string {
  return `${ref.contract_id}:${ref.revision}:${ref.fragment_id}`;
}

export function compileMvTimeline(input: CompileMvTimelineInput): MvTimelineV1 {
  const music = musicStructureContractSchema.parse(input.music);
  const lyrics = input.lyrics ? lyricsContractSchema.parse(input.lyrics) : undefined;
  const units = input.units.map((unit) => generationUnitContractSchema.parse(unit));
  if (units.length === 0) throw new Error("MV timeline requires at least one generation unit");
  const seenOrdinals = new Set<number>();
  let previousEnd = 0;
  for (const [index, unit] of units.entries()) {
    if (seenOrdinals.has(unit.ordinal) || unit.ordinal !== index) throw new Error("MV generation units must be contiguous and ordered by ordinal");
    seenOrdinals.add(unit.ordinal);
    if (unit.production_id !== units[0]!.production_id) throw new Error("MV generation units must share production id");
    if (unit.music_binding.contract_id !== music.contract_id || unit.music_binding.revision !== music.revision || unit.music_binding.contract_digest !== music.digest || unit.music_binding.timing_digest !== music.timing_digest || unit.music_binding.master_audio_digest !== music.master_audio.sha256) throw new Error("MV generation unit music binding mismatch");
    if (unit.program.master_duration_ms !== music.master_audio.duration_ms) throw new Error("MV generation unit master duration mismatch");
    if (unit.program.start_ms < previousEnd) throw new Error("MV generation units overlap");
    if (input.require_contiguous && unit.program.start_ms !== previousEnd) throw new Error("MV generation unit gap is not allowed");
    previousEnd = unit.program.end_ms;
    if (unit.program.section_id) {
      const section = music.sections.find((candidate) => candidate.id === unit.program.section_id);
      if (!section || unit.program.start_ms < section.start_ms || unit.program.end_ms > section.end_ms) throw new Error("MV generation unit is outside its section");
    }
    const musicBeatIds = new Set(music.beat_markers.map((beat) => beat.id));
    for (const ref of unit.beat_anchor_refs) {
      if (!musicBeatIds.has(ref.fragment_id)) throw new Error("MV generation unit references a missing beat");
      const beat = music.beat_markers.find((candidate) => candidate.id === ref.fragment_id)!;
      if (beat.at_ms < unit.program.start_ms || beat.at_ms > unit.program.end_ms) throw new Error("MV generation unit beat is outside its interval");
    }
    if (unit.lyric_cue_refs.length > 0 && !lyrics) throw new Error("MV generation unit lyric refs require a lyrics contract");
    if (lyrics) {
      if (unit.lyrics_binding?.contract_id !== lyrics.contract_id || unit.lyrics_binding.revision !== lyrics.revision || (unit.lyrics_binding.contract_digest !== undefined && unit.lyrics_binding.contract_digest !== lyrics.digest) || unit.lyrics_binding.text_digest !== lyrics.source.text_digest || unit.lyrics_binding.timing_digest !== lyrics.timing_digest) throw new Error("MV generation unit lyrics binding mismatch");
      const cueIds = new Set(lyrics.cues.map((cue) => cue.id));
      for (const ref of unit.lyric_cue_refs) {
        if (!cueIds.has(ref.fragment_id)) throw new Error("MV generation unit references a missing lyric cue");
        const cue = lyrics.cues.find((candidate) => candidate.id === ref.fragment_id)!;
        if (cue.timing === "timed" && (cue.start_ms < unit.program.start_ms || cue.end_ms > unit.program.end_ms)) throw new Error("MV generation unit lyric cue is outside its interval");
        if (input.exact_sync && (lyrics.timing_digest === null || cue.timing !== "timed")) throw new Error("exact-sync MV unit cannot use untimed lyrics");
      }
    } else if (input.exact_sync) {
      throw new Error("exact-sync MV timeline requires lyrics");
    }
    const ids = [...unit.beat_anchor_refs, ...unit.lyric_cue_refs].map(fragmentId);
    if (new Set(ids).size !== ids.length) throw new Error("MV generation unit cue references must be unique");
  }
  const base = {
    schema_version: 1 as const,
    kind: "mv-master-timeline" as const,
    production_id: units[0]!.production_id,
    master_audio_digest: music.master_audio.sha256,
    duration_ms: music.master_audio.duration_ms,
    units
  };
  return mvTimelineSchema.parse({ ...base, digest: sha256Canonical(base) });
}

export function mvTimelineDigest(value: MvTimelineV1): string {
  return mvTimelineSchema.parse(value).digest;
}
