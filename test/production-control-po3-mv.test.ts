import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  assetContractSchema,
  createAssetContract,
  createCompositionIntent,
  createGenerationUnit,
  createLyricsContract,
  createMusicStructureContract,
  createMvTemplate,
  identityRequirementSchema,
  lyricsContractSchema,
  musicStructureContractSchema,
  generationUnitContractSchema,
  compositionIntentSchema,
  compositionPlanSchema,
  compileMvTimeline,
  resolveCompositionPlan,
  validateFrameQuantization,
  buildDependencyIndex,
  computeInvalidation,
  validateTaskTreeSpec,
  toProgramBindingSource,
  buildProgramBinding,
  type LyricsContract,
  type MusicStructureContract,
  type GenerationUnitContract,
  type ContractFragmentRef,
} from "../src/productionControl/index.js";
import { sha256Bytes, sha256Canonical, withoutField } from "../src/productionControl/canonical.js";
import { projectSchema } from "../src/project/schema.js";
import { manifestSchema } from "../src/manifest/schema.js";

const ZERO = "0".repeat(64);
const route = {
  ir_model: "neutral-video-v2",
  provider_model: "fixture-video",
  model_profile_digest: "1".repeat(64),
  connection_id: "fixture-connection",
  connection_digest: "2".repeat(64),
  adapter_id: "fixture-adapter",
  transport: "fixture",
  mode_binding: "text-to-video",
  route_digest: "3".repeat(64),
};

function textDigest(text: string): string {
  return sha256Bytes(new TextEncoder().encode(text));
}

function makeLyricsInput() {
  const lines = Array.from({ length: 24 }, (_, index) => `ひかり ${index + 1}  \nつづく`);
  const canonicalText = lines.join("\n");
  const bytes = new TextEncoder().encode(canonicalText);
  let cursor = 0;
  const cues = lines.map((line, index) => {
    const lineBytes = new TextEncoder().encode(line);
    const start = cursor;
    cursor += lineBytes.byteLength;
    const cue = {
      timing: "timed" as const,
      id: `cue-${String(index + 1).padStart(2, "0")}`,
      section_id: index < 6 ? "intro" : index < 12 ? "verse" : index < 18 ? "chorus" : "outro",
      source_span: {
        occurrence_id: `occurrence-${String(index + 1).padStart(2, "0")}`,
        start_utf8_byte: start,
        end_utf8_byte: cursor,
        text_digest: textDigest(line),
      },
      start_ms: index * 3_000,
      end_ms: (index + 1) * 3_000,
      singer_ids: ["lead"],
      use: ["caption-overlay" as const],
    };
    cursor += 1;
    return cue;
  });
  return {
    contract_id: "lyrics-72s",
    revision: 0,
    language_bcp47: "ja-JP",
    source: { canonical_text: canonicalText, text_digest: textDigest(canonicalText) },
    alignment_state: "complete" as const,
    alignment_basis: "human-reviewed" as const,
    cues,
  };
}

function makeMusic(): MusicStructureContract {
  return createMusicStructureContract({
    contract_id: "music-72s",
    revision: 0,
    master_audio: {
      asset_id: "master-audio",
      sha256: "a".repeat(64),
      duration_ms: 72_000,
      sample_rate: 48_000,
      channels: 2,
    },
    analysis: { status: "analyzed", analyzer_id: "fixture-analyzer", analyzer_version: "1" },
    tempo_map: [
      { id: "tempo-0", start_ms: 0, end_ms: 36_000, bpm: 120, meter: "4/4" },
      { id: "tempo-1", start_ms: 36_000, bpm: 128, meter: "4/4" },
    ],
    beat_markers: [
      { id: "beat-0", at_ms: 0, kind: "downbeat", bar: 1, beat: 1 },
      { id: "beat-1", at_ms: 18_000, kind: "downbeat", bar: 1, beat: 1 },
      { id: "beat-2", at_ms: 36_000, kind: "transition", bar: 1, beat: 1 },
      { id: "beat-3", at_ms: 54_000, kind: "downbeat", bar: 1, beat: 1 },
    ],
    sections: [
      { id: "intro", label: "Intro", start_ms: 0, end_ms: 18_000, musical_role: "opening" },
      { id: "verse", label: "Verse", start_ms: 18_000, end_ms: 36_000, musical_role: "development" },
      { id: "chorus", label: "Chorus", start_ms: 36_000, end_ms: 54_000, musical_role: "lift" },
      { id: "outro", label: "Outro", start_ms: 54_000, end_ms: 72_000, musical_role: "release" },
    ],
  });
}

function fragment(slot: ContractFragmentRef["slot"], contractId: string, kind: ContractFragmentRef["kind"], id: string, digest = ZERO): ContractFragmentRef {
  return { slot, contract_id: contractId, revision: 0, kind, fragment_id: id, digest };
}

function makeUnits(music: MusicStructureContract, lyrics: LyricsContract): GenerationUnitContract[] {
  return [
    ["intro", 0, 18_000, "beat-0", 0],
    ["verse", 18_000, 36_000, "beat-1", 6],
    ["chorus", 36_000, 54_000, "beat-2", 12],
    ["outro", 54_000, 72_000, "beat-3", 18],
  ].map(([section, start, end, beat, cueOffset], index) => createGenerationUnit({
    production_id: "production-72s",
    unit_id: `${section}-unit`,
    ordinal: index,
    music,
    lyrics,
    start_ms: start,
    end_ms: end,
    section_id: section,
    beat_anchor_ids: [beat],
    lyric_cue_ids: lyrics.cues.slice(cueOffset, cueOffset + 6).map((cue) => cue.id),
    audio_policy: "reuse-master",
    route,
  }));
}

describe("PO-3 strict MV contracts", () => {
  it("pins asset bytes and rejects unknown fields or unsafe project paths", () => {
    const asset = createAssetContract({
      contract_id: "assets-72s",
      revision: 0,
      assets: [{
        asset_id: "master-audio",
        kind: "audio",
        project_relative_path: "media/master.wav",
        sha256: "a".repeat(64),
        byte_size: 123,
        roles: ["master-audio"],
        provenance: { source: "user", usage_confirmed: true },
        external_send: "forbidden",
      }],
    });
    expect(assetContractSchema.parse(asset)).toEqual(asset);
    expect(() => assetContractSchema.parse({ ...asset, unknown: true })).toThrow();
    expect(() => createAssetContract({ ...asset, assets: [{ ...asset.assets[0]!, project_relative_path: "../master.wav" }] })).toThrow();
  });

  it("accepts only additive project authoring refs and manifest MV bindings", () => {
    const project = projectSchema.parse({
      slug: "po3-project",
      name: "PO3 project",
      manifest: "manifest.json",
      edit: { backend: "remotion" },
      orchestration: {
        mode: "shadow",
        authoring: {
          music: { kind: "music-contract", id: "music-72s", digest: "a".repeat(64) },
          lyrics: { kind: "lyrics-contract", id: "lyrics-72s", digest: "b".repeat(64) },
          generation_units: [{ kind: "mv-generation-unit", id: "intro-unit", digest: "c".repeat(64) }]
        }
      }
    });
    expect(project.orchestration?.authoring?.music?.id).toBe("music-72s");
    expect(() => projectSchema.parse({
      slug: "po3-project",
      name: "PO3 project",
      manifest: "manifest.json",
      edit: { backend: "remotion" },
      orchestration: { mode: "shadow", authoring: { music: { kind: "music-contract", id: "music-72s", digest: "a".repeat(64), extra: true } } }
    })).toThrow();
    const manifest = manifestSchema.parse({
      meta: { aspect: "16:9", fps: 30, target_duration_seconds: 72, slug: "po3-project" },
      clips: [{ id: "intro", src: "media/intro.mp4", in: 0, out: 18, duration: 18, fps: 30, resolution: { width: 1920, height: 1080 }, audio: false }],
      master_audio_binding: { asset_id: "master-audio", sha256: "a".repeat(64), duration_ms: 72_000, contract_id: "music-72s", revision: 0, contract_digest: "d".repeat(64) },
      caption_binding: { contract_id: "lyrics-72s", revision: 0, timing_digest: "e".repeat(64), cue_refs: [] },
      chapter_binding: { contract_id: "music-72s", revision: 0, timing_digest: "f".repeat(64), section_refs: [] }
    });
    expect(manifest.master_audio_binding?.duration_ms).toBe(72_000);
  });

  it("keeps Identity optionality explicit instead of inferring not_applicable", () => {
    expect(identityRequirementSchema.parse({ requirement: "optional", reason: "no recurring subject was declared" })).toEqual({
      requirement: "optional",
      reason: "no recurring subject was declared",
    });
    expect(identityRequirementSchema.parse({ requirement: "required", reason: "performance subject is generated" }).requirement).toBe("required");
    expect(() => identityRequirementSchema.parse({ requirement: "not_applicable", reason: "guessed" })).not.toThrow();
    expect(() => identityRequirementSchema.parse({ requirement: "optional", reason: "x", extra: true })).toThrow();
  });

  it("validates tempo changes, unknown BPM, section gaps, and overlap policy", () => {
    const music = makeMusic();
    expect(music.tempo_map).toHaveLength(2);
    expect(music.sections[2]?.start_ms).toBe(36_000);
    expect(() => musicStructureContractSchema.parse({ ...music, unknown: true })).toThrow();
    expect(() => createMusicStructureContract({
      ...music,
      analysis: { status: "unknown" },
      tempo_map: [{ id: "invented", start_ms: 0, bpm: 120 }],
    })).toThrow();
    expect(() => createMusicStructureContract({
      ...music,
      sections: [music.sections[0]!, { ...music.sections[1]!, start_ms: 17_000 }],
    })).toThrow();
    expect(() => createMusicStructureContract({
      ...music,
      sections: [music.sections[0]!, { ...music.sections[1]!, start_ms: 19_000 }],
      section_policy: { gaps: "forbid", overlaps: "forbid" },
    })).toThrow();
    const unknownBpm = createMusicStructureContract({
      ...music,
      analysis: { status: "unknown" },
      tempo_map: [],
    });
    expect(unknownBpm.tempo_map).toEqual([]);
  });

  it("keeps exact lyrics bytes and enforces the full alignment matrix", () => {
    const input = makeLyricsInput();
    const lyrics = createLyricsContract(input);
    expect(lyrics.source.canonical_text).toContain("  \n");
    expect(lyrics.cues[0]?.source_span.text_digest).toBe(textDigest("ひかり 1  \nつづく"));
    expect(lyricsContractSchema.parse(lyrics)).toEqual(lyrics);
    expect(() => createLyricsContract({ ...input, source: { ...input.source, canonical_text: input.source.canonical_text.replace("  ", " ") } })).toThrow();
    expect(() => createLyricsContract({ ...input, alignment_state: "unaligned", alignment_basis: "human-reviewed" })).toThrow();
    expect(() => createLyricsContract({ ...input, alignment_state: "complete", alignment_basis: "not-aligned" })).toThrow();
    expect(() => createLyricsContract({ ...input, alignment_state: "partial", cues: input.cues.map((cue) => ({ ...cue, timing: "untimed" as const })) })).toThrow();
    expect(() => createLyricsContract({ ...input, cues: input.cues.map((cue) => ({ ...cue, source_span: { ...cue.source_span, end_utf8_byte: cue.source_span.end_utf8_byte + 1 } })) })).toThrow();
    const repeated = createLyricsContract({
      ...input,
      cues: input.cues.slice(0, 3).map((cue, index) => ({ ...cue, id: `repeat-${index}`, source_span: { ...cue.source_span, occurrence_id: `repeat-occurrence-${index}` } })),
    });
    expect(new Set(repeated.cues.map((cue) => cue.source_span.occurrence_id)).size).toBe(3);
  });

  it("does not turn caption-only cues into singing or visible text", () => {
    const lyrics = createLyricsContract(makeLyricsInput());
    expect(lyrics.cues.every((cue) => cue.use.includes("caption-overlay"))).toBe(true);
    expect(lyrics.cues.some((cue) => cue.use.includes("generated-singing"))).toBe(false);
    const singing = createLyricsContract({
      ...makeLyricsInput(),
      cues: makeLyricsInput().cues.map((cue) => ({ ...cue, use: ["caption-overlay", "generated-singing"] as const })),
    });
    expect(singing.cues[0]?.use).toContain("generated-singing");
  });

  it("binds GenerationUnits to exact music/lyrics revisions and master interval", () => {
    const music = makeMusic();
    const lyrics = createLyricsContract(makeLyricsInput());
    const unit = makeUnits(music, lyrics)[2]!;
    expect(generationUnitContractSchema.parse(unit)).toEqual(unit);
    expect(unit.program.end_ms - unit.program.start_ms).toBe(unit.clip_duration_ms);
    expect(unit.audio_policy).toBe("reuse-master");
    expect(() => createGenerationUnit({
      production_id: unit.production_id,
      unit_id: "bad-unit",
      ordinal: 0,
      music,
      lyrics,
      start_ms: 54_000,
      end_ms: 53_000,
      section_id: "chorus",
      beat_anchor_ids: ["beat-2"],
      lyric_cue_ids: ["cue-13"],
      audio_policy: "reuse-master",
      route,
    })).toThrow();
    expect(() => createGenerationUnit({
      ...unit,
      audio_policy: "reference-only",
      reference_audio_binding: undefined,
    } as never)).toThrow();
    const referenceUnit = createGenerationUnit({
      production_id: "production-72s",
      unit_id: "reference-unit",
      ordinal: 0,
      music,
      lyrics,
      start_ms: 0,
      end_ms: 18_000,
      section_id: "intro",
      beat_anchor_ids: ["beat-0"],
      lyric_cue_ids: ["cue-01"],
      audio_policy: "reference-only",
      reference_audio_binding: {
        derived_asset_id: "intro-reference-audio",
        derived_asset_digest: "9".repeat(64),
        source_master_audio_digest: music.master_audio.sha256,
        source_start_ms: 0,
        source_end_ms: 18_000,
        pinned: true,
      },
      route,
    });
    expect(referenceUnit.reference_audio_binding?.pinned).toBe(true);
    expect(() => createGenerationUnit({
      production_id: "production-72s",
      unit_id: "unpinned-reference-unit",
      ordinal: 0,
      music,
      lyrics,
      start_ms: 0,
      end_ms: 18_000,
      section_id: "intro",
      beat_anchor_ids: ["beat-0"],
      lyric_cue_ids: ["cue-01"],
      audio_policy: "reference-only",
      reference_audio_binding: { ...referenceUnit.reference_audio_binding!, pinned: undefined } as never,
      route,
    })).toThrow();
    expect(() => createGenerationUnit({
      ...unit,
      beat_anchor_ids: ["missing-beat"],
    } as never)).toThrow();
    expect(() => createGenerationUnit({
      ...unit,
      lyric_cue_ids: ["cue-13"],
      lyrics: createLyricsContract({ ...makeLyricsInput(), alignment_state: "unaligned", alignment_basis: "not-aligned", cues: makeLyricsInput().cues.map((cue) => ({
        timing: "untimed" as const,
        id: cue.id,
        source_span: cue.source_span,
        singer_ids: cue.singer_ids,
        use: cue.use,
      })) })
    } as never)).toThrow();
    const source = toProgramBindingSource(unit);
    expect(buildProgramBinding(source).lyrics_contract_digest).toBe(lyrics.digest);
  });

  it("compiles ordered MV timeline and preserves siblings during branch invalidation", () => {
    const music = makeMusic();
    const lyrics = createLyricsContract(makeLyricsInput());
    const units = makeUnits(music, lyrics);
    const timeline = compileMvTimeline({ music, lyrics, units, exact_sync: true });
    expect(timeline.units.map((unit) => unit.ordinal)).toEqual([0, 1, 2, 3]);
    expect(timeline.units.map((unit) => unit.unit_id)).toEqual(["intro-unit", "verse-unit", "chorus-unit", "outro-unit"]);
    expect(() => compileMvTimeline({ music, lyrics, units: [units[1]!, units[0]!, units[2]!, units[3]!] })).toThrow();
    expect(() => compileMvTimeline({ music, lyrics, units: units.map((unit) => ({ ...unit, lyric_cue_refs: [] })) })).toThrow();
  });

  it("invalidates the whole master timeline but preserves non-Chorus siblings", () => {
    const musicWhole = fragment("music", "music-72s", "whole", "music-72s.whole", "4".repeat(64));
    const chorusSection = fragment("music", "music-72s", "section", "chorus", "5".repeat(64));
    const task = (node_id: string, required_contract_fragments: ContractFragmentRef[], dependencies: string[] = []) => ({
      node_type: "task" as const,
      node_id,
      parent_id: "root",
      kind: "generation-batch" as const,
      role: "generator" as const,
      effect: "propose" as const,
      dependencies,
      required_contract_fragments,
      required_artifacts: [],
      output_schema: "mv-output",
      risk_class: "low" as const,
      invalidation_tags: []
    });
    const baseTree = {
      schema_version: 1 as const,
      production_id: "production-72s",
      tree_revision: 0,
      root_node_id: "root",
      nodes: [
        { node_type: "mission" as const, node_id: "root", aggregation: { kind: "all" as const }, child_ids: ["intro", "verse", "chorus", "outro", "edit"] },
        task("intro", [musicWhole]),
        task("verse", [musicWhole]),
        task("chorus", [musicWhole, chorusSection]),
        task("outro", [musicWhole]),
        task("edit", [musicWhole], ["intro", "verse", "chorus", "outro"])
      ]
    };
    const tree = validateTaskTreeSpec({ ...baseTree, digest: sha256Canonical(baseTree) });
    const index = buildDependencyIndex(tree);
    const chorus = computeInvalidation({ tree, index, changes: [{ kind: "contract-fragment", ref: chorusSection }] });
    expect(chorus.stale_node_ids).toEqual(["chorus", "edit"]);
    expect(chorus.preserved_node_ids).toEqual(["intro", "outro", "root", "verse"]);
    const master = computeInvalidation({ tree, index, changes: [{ kind: "contract-fragment", ref: musicWhole }] });
    expect(master.stale_node_ids).toEqual(["chorus", "edit", "intro", "outro", "verse"]);
    expect(master.preserved_node_ids).toEqual(["root"]);
  });

  it("rejects implicit overlap, invalid speed, and intent/plan mismatch", () => {
    const music = makeMusic();
    const lyrics = createLyricsContract(makeLyricsInput());
    const units = makeUnits(music, lyrics);
    const intent = createCompositionIntent({
      music,
      lyrics,
      units,
      placements: units.map((unit) => ({
        generation_unit_digest: unit.digest,
        track_id: "visual-main",
        layer: 0,
        timeline_start_ms: unit.program.start_ms,
        timeline_end_ms: unit.program.end_ms,
        planned_time_transform: { kind: "none" as const },
        blend_policy: "replace" as const,
      })),
      required_visual_coverage_intervals: [{ track_id: "visual-main", start_ms: 0, end_ms: 72_000 }],
      caption_cue_refs: lyrics.cues.map((cue) => fragment("lyrics", lyrics.contract_id, "lyric-cue", cue.id, sha256Canonical(cue))),
    });
    expect(compositionIntentSchema.parse(intent)).toEqual(intent);
    const artifacts = units.map((unit) => ({
      generation_unit_digest: unit.digest,
      artifact_id: `${unit.unit_id}-artifact`,
      artifact_digest: sha256Canonical({ artifact: unit.unit_id }),
      duration_ms: unit.clip_duration_ms,
    }));
    const plan = resolveCompositionPlan({ intent, music, lyrics, units, artifacts });
    expect(compositionPlanSchema.parse(plan)).toEqual(plan);
    expect(plan.clips.every((clip) => clip.audio_policy === "discard")).toBe(true);
    expect(plan.captions).toHaveLength(24);
    expect(() => resolveCompositionPlan({ intent: { ...intent, composition_intent_digest: ZERO } as never, music, lyrics, units, artifacts })).toThrow();
    expect(() => createCompositionIntent({
      music,
      lyrics,
      units,
      placements: [
        { ...intent.placements[0]!, timeline_start_ms: 0, timeline_end_ms: 18_000 },
        { ...intent.placements[1]!, timeline_start_ms: 17_000, timeline_end_ms: 35_000 },
      ],
      required_visual_coverage_intervals: [],
      caption_cue_refs: [],
    })).toThrow();
    expect(() => createCompositionIntent({
      music,
      lyrics,
      units,
      placements: [{
        ...intent.placements[0]!,
        planned_time_transform: {
          kind: "speed",
          source_duration_ms: 0,
          timeline_duration_ms: 1,
          reason: "bad",
          decision: {
            decision_id: "decision-speed",
            decision: "approve",
            actor: "human",
            decided_at: "2026-08-11T00:00:00.000Z",
            subject_digest: ZERO,
          },
        },
      }],
      required_visual_coverage_intervals: [],
      caption_cue_refs: [],
    })).toThrow();
  });

  it("enforces frame quantization boundaries and supports explicit speed transforms", () => {
    expect(validateFrameQuantization({ start_ms: 0, end_ms: 1_000, fps: 30 })).toEqual({ start_ms: 0, end_ms: 1_000, tolerance_ms: 34 });
    expect(() => validateFrameQuantization({ start_ms: 0, end_ms: 1_001, fps: 0 })).toThrow();
    expect(() => validateFrameQuantization({ start_ms: 0, end_ms: Number.NaN, fps: 30 })).toThrow();
    const music = makeMusic();
    const lyrics = createLyricsContract(makeLyricsInput());
    const units = makeUnits(music, lyrics);
    const decisionSubject = sha256Canonical({ source_duration_ms: 18_000, timeline_duration_ms: 9_000, generation_unit_digest: units[0]!.digest });
    const intent = createCompositionIntent({
      music,
      lyrics,
      units,
      placements: [{
        generation_unit_digest: units[0]!.digest,
        track_id: "visual-main",
        layer: 0,
        timeline_start_ms: 0,
        timeline_end_ms: 9_000,
        planned_time_transform: {
          kind: "speed",
          source_duration_ms: 18_000,
          timeline_duration_ms: 9_000,
          reason: "human-approved compression",
          decision: {
            decision_id: "decision-speed",
            decision: "approve",
            actor: "human",
            decided_at: "2026-08-11T00:00:00.000Z",
            subject_digest: decisionSubject,
          },
        },
        blend_policy: "replace",
      }],
      required_visual_coverage_intervals: [],
      caption_cue_refs: [],
    });
    const plan = resolveCompositionPlan({
      intent,
      music,
      lyrics,
      units,
      artifacts: [{ generation_unit_digest: units[0]!.digest, artifact_id: "speed-artifact", artifact_digest: "b".repeat(64), duration_ms: 18_000 }],
    });
    expect(plan.clips[0]?.time_transform.kind).toBe("speed");
    expect(() => resolveCompositionPlan({
      intent,
      music,
      lyrics,
      units,
      artifacts: [{ generation_unit_digest: units[0]!.digest, artifact_id: "wrong-artifact", artifact_digest: "b".repeat(64), duration_ms: 17_999 }],
    })).toThrow();
  });

  it("compiles the 72-second lyric MV fixture to the golden resolved plan without generation", async () => {
    const music = makeMusic();
    const lyrics = createLyricsContract(makeLyricsInput());
    const units = makeUnits(music, lyrics);
    const template = createMvTemplate({ production_id: "production-72s", music, lyrics, units });
    expect(template.duration_ms).toBe(72_000);
    const intent = createCompositionIntent({
      music,
      lyrics,
      units,
      placements: units.map((unit) => ({
        generation_unit_digest: unit.digest,
        track_id: "visual-main",
        layer: 0,
        timeline_start_ms: unit.program.start_ms,
        timeline_end_ms: unit.program.end_ms,
        planned_time_transform: { kind: "none" as const },
        blend_policy: "replace" as const,
      })),
      required_visual_coverage_intervals: [{ track_id: "visual-main", start_ms: 0, end_ms: 72_000 }],
      caption_cue_refs: lyrics.cues.map((cue) => fragment("lyrics", lyrics.contract_id, "lyric-cue", cue.id, sha256Canonical(cue))),
    });
    const plan = resolveCompositionPlan({
      intent,
      music,
      lyrics,
      units,
      artifacts: units.map((unit) => ({
        generation_unit_digest: unit.digest,
        artifact_id: `${unit.unit_id}-artifact`,
        artifact_digest: sha256Canonical({ artifact: unit.unit_id }),
        duration_ms: unit.clip_duration_ms,
      })),
    });
    const golden = JSON.parse(await readFile(new URL("./fixtures/production-control/po3/lyrics-mv-72s.golden.json", import.meta.url), "utf8")) as Record<string, unknown>;
    expect({
      duration_ms: template.duration_ms,
      template_digest: template.digest,
      generation_unit_count: template.generation_unit_digests.length,
      intent_digest: intent.digest,
      plan_digest: plan.digest,
      clip_count: plan.clips.length,
      caption_count: plan.captions.length,
      chapter_ids: plan.chapters.map((chapter) => chapter.id)
    }).toEqual(golden);
  });
});
