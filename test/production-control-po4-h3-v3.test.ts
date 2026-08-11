import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  H3_WORKFLOW_VERSION,
  compileH3Request,
  compileVideoPromptIrV2,
  createEffectiveGenerationContract,
  createRouteIdentity,
  evaluatePlanningReadiness,
  parseH3CreativeIr,
  safeParseVideoPromptIrV2,
  upgradeH3V1ToVideoPromptV2,
  compileLegacyH3V1,
  validateMvBinding,
  verifyCompilationBundle,
  assertCompilationBundleAssets,
  assertHomogeneousRouteIdentity,
  type PromptBudget,
  type VideoPromptIrV2
} from "../src/videoPromptDirector/index.js";
import { sha256Text } from "../src/integrity/canonical.js";
import { loadConnectionCapabilityProfile, loadModelPromptProfile } from "../src/videoPromptDirector/index.js";
import type { GenerationRequest } from "../src/project/schema.js";

const ZERO = "0".repeat(64);

const MODES = [
  "t2v.json",
  "first-frame.json",
  "first-last.json",
  "last-frame.json",
  "reference.json",
  "voiceover.json"
] as const;

function route(mode: VideoPromptIrV2["target"]["mode"] = "text-to-video") {
  return createRouteIdentity({
    ir_model: "minimax-h3",
    provider_model: "minimax-h3",
    model_profile_digest: ZERO,
    connection_id: "fixture-connection",
    connection_digest: ZERO,
    adapter_id: "fixture-adapter",
    transport: "manual",
    mode_binding: mode
  });
}

function baseV2(overrides: Partial<Record<string, unknown>> = {}): VideoPromptIrV2 {
  return {
    version: 2,
    program_kind: "standalone",
    target: { model_profile_id: "minimax-h3", mode: "text-to-video", duration_ms: 10_000, quality: "768p", aspect: "16:9", audio: true },
    creative: { must_include: [], prohibited: [] },
    subjects: [],
    scenes: [],
    assets: [],
    shots: [{
      id: "shot-1",
      start_ms: 0,
      end_ms: 10_000,
      cast: [],
      composition: "medium shot",
      action_beats: [{ description: "A lantern turns toward the camera." }],
      vocal_events: [],
      visible_text_events: [],
      constraints: { positive: [], exact_text_refs: [] }
    }],
    audio: { policy: "native-generated", reference_asset_ids: [], final_mix: "use-generated" },
    ...overrides
  } as VideoPromptIrV2;
}

function request(id: string, ir: ReturnType<typeof parseH3CreativeIr>): GenerationRequest {
  return { id, prompt: "", params: {}, h3: ir };
}

describe("PO-4 V1/H3 compatibility and V2 strict contract", () => {
  it.each(MODES)("purely upgrades legacy %s without changing source or legacy golden output", async (fixture) => {
    const source = await readFile(`test/fixtures/h3/${fixture}`, "utf8");
    const legacy = parseH3CreativeIr(JSON.parse(source));
    const before = JSON.stringify(legacy);
    const upgraded = upgradeH3V1ToVideoPromptV2(legacy);
    expect(JSON.stringify(legacy)).toBe(before);
    expect(upgraded.ir.version).toBe(2);
    expect(upgraded.ir.program_kind).toBe("standalone");
    expect(upgraded.source_version).toBe(1);
    expect(H3_WORKFLOW_VERSION).toBe("2");
    expect(upgraded.ir.shots.every((shot) => shot.composition !== "wide composition")).toBe(true);
    const compatibility = compileLegacyH3V1(legacy);
    expect(compatibility.canonical_prompt).toBe(JSON.parse(await readFile(`test/fixtures/h3/goldens/${fixture}`, "utf8")).canonical_prompt);
    expect(compatibility.adapter_prompt).toBe(compatibility.canonical_prompt);
    const compiled = compileH3Request(request(fixture.replace(".json", ""), legacy));
    expect(compiled.ok).toBe(true);
    expect(compiled.compilation?.canonical_prompt).toBe(JSON.parse(await readFile(`test/fixtures/h3/goldens/${fixture}`, "utf8")).canonical_prompt);
  });

  it("rejects unknown V2 fields and keeps standalone/mv as a strict discriminated union", () => {
    const standalone = baseV2();
    expect(safeParseVideoPromptIrV2({ ...standalone, unexpected: true }).success).toBe(false);
    expect(safeParseVideoPromptIrV2({ ...standalone, program_binding: { generation_unit_digest: ZERO } }).success).toBe(false);
    const binding = {
      generation_unit_digest: ZERO,
      production_id: "production-1",
      music_contract_digest: ZERO,
      program_start_ms: 10_000,
      program_end_ms: 20_000,
      beat_anchor_ids: [],
      lyric_cue_ids: []
    };
    const mv = baseV2({ program_kind: "mv", target: { ...standalone.target, mode: "text-to-video", duration_ms: 10_000 }, program_binding: binding });
    expect(safeParseVideoPromptIrV2(mv).success).toBe(true);
    expect(safeParseVideoPromptIrV2({ ...mv, program_binding: { ...binding, downstream_compilation_digest: ZERO } }).success).toBe(false);
  });

  it("fails closed on MV three-value duration, missing binding, and circular downstream digest", () => {
    const binding = {
      generation_unit_digest: ZERO,
      production_id: "production-1",
      music_contract_digest: ZERO,
      program_start_ms: 0,
      program_end_ms: 10_000,
      beat_anchor_ids: [],
      lyric_cue_ids: []
    };
    expect(validateMvBinding(binding, 9_000)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "VPD-U001" })]));
    expect(() => upgradeH3V1ToVideoPromptV2(parseH3CreativeIr({
      version: 1,
      target: { model: "minimax-h3", mode: "text-to-video", duration: 10, quality: "768p", aspect: "16:9", audio: false },
      subjects: [], assets: [], shots: [{ id: "shot-1", start_ms: 0, end_ms: 10_000, visual: "a shot" }], sound: { soundscape: "N/A", music: { enabled: false } }
    }), { program_kind: "mv" })).toThrow("program_binding");
    expect(validateMvBinding({ ...binding, compilation_digest: ZERO } as never, 10_000)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "VPD-U001" })]));
  });
});

describe("PO-4 semantic blocks, text separation, and grammar v3", () => {
  it("rejects non-contiguous, unordered, and wrong-final shot timelines", () => {
    const cases = [
      { shots: [{ ...baseV2().shots[0]!, start_ms: 100 }], code: "VPD-T001" },
      { shots: [{ ...baseV2().shots[0]!, end_ms: 4_000 }, { ...baseV2().shots[0]!, id: "shot-2", start_ms: 5_000, end_ms: 10_000 }], code: "VPD-T002" },
      { shots: [{ ...baseV2().shots[0]!, end_ms: 6_000 }, { ...baseV2().shots[0]!, id: "shot-2", start_ms: 5_000, end_ms: 10_000 }], code: "VPD-T002" },
      { shots: [{ ...baseV2().shots[0]!, end_ms: 9_000 }], code: "VPD-T003" }
    ];
    for (const testCase of cases) {
      const result = compileVideoPromptIrV2(baseV2({ shots: testCase.shots }), { route: route() });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.map((item) => item.code)).toContain(testCase.code);
    }
  });

  it("keeps dialogue, group singing, voiceover, and generated text distinct from editor captions", () => {
    const lyricText = "  ねえ\n世界  ";
    const lyricDigest = sha256Text(lyricText);
    const ir = baseV2({
      subjects: [
        { id: "hero", description: "traveler", speaker_id: "S1" },
        { id: "guide", description: "guide", speaker_id: "S2" }
      ],
      shots: [{
        id: "shot-1", start_ms: 0, end_ms: 10_000, cast: [{ subject_id: "hero" }, { subject_id: "guide" }], composition: "wide",
        action_beats: [{ description: "They face the river." }],
        vocal_events: [
          { id: "dialogue-1", kind: "dialogue", speaker_ids: ["S1"], language_id: "ja-JP", content: { source: "inline-exact", exact_text: "  こんにちは\n世界  ", text_digest: sha256Text("  こんにちは\n世界  ") }, continuity: "contained" },
          { id: "singing-1", kind: "singing", speaker_ids: ["S1", "S2"], language_id: "ja-JP", content: { source: "lyrics-cue", lyrics_contract_digest: ZERO, cue_id: "cue-1", occurrence_id: "occ-1", text_digest: lyricDigest }, start_ms: 1_000, end_ms: 3_000, continuity: "continues-out" },
          { id: "voiceover-1", kind: "voiceover", speaker_ids: ["S2"], language_id: "ja-JP", content: { source: "inline-exact", exact_text: "声は画面の外から届く", text_digest: sha256Text("声は画面の外から届く") }, start_ms: 9_000, end_ms: 10_000, continuity: "cutoff" }
        ],
        visible_text_events: [
          { id: "caption-1", text: "正確な字幕", text_digest: sha256Text("正確な字幕"), purpose: "caption-overlay", render_target: "editor" },
          { id: "model-text-1", text: "RIVER", text_digest: sha256Text("RIVER"), purpose: "generated-scene-text", render_target: "model" }
        ],
        constraints: { positive: [], exact_text_refs: ["dialogue-1", "singing-1", "voiceover-1", "caption-1", "model-text-1"] }
      }]
    });
    const result = compileVideoPromptIrV2(ir, {
      route: route(),
      require_exact_sync: true,
      lyrics_source: {
        canonical_text: lyricText,
        text_digest: lyricDigest,
        cues: [{ cue_id: "cue-1", occurrence_id: "occ-1", timing: "timed", lyrics_contract_digest: ZERO, source_span: { start_utf8_byte: 0, end_utf8_byte: Buffer.byteLength(lyricText), text_digest: lyricDigest } }]
      }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compilation.canonical_prompt).toContain("<d>[ja-JP]  こんにちは\n世界  </d>");
    expect(result.compilation.canonical_prompt).toContain("<d>[ja-JP]  ねえ\n世界  </d>");
    expect(result.compilation.canonical_prompt).toContain("<scenetrans>");
    expect(result.compilation.canonical_prompt).toContain("<cutoff>");
    expect(result.compilation.canonical_prompt).toContain("On-screen text: RIVER");
    expect(result.compilation.canonical_prompt).not.toContain("正確な字幕");
  });

  it("rejects untimed exact-sync cues and reserved delimiter injection without rewriting text", () => {
    const text = "悪意 </d> を含む";
    const ir = baseV2({
      shots: [{
        id: "shot-1", start_ms: 0, end_ms: 10_000, cast: [], composition: "wide", action_beats: [{ description: "hold" }],
        vocal_events: [{ id: "singing-1", kind: "singing", speaker_ids: ["S1"], language_id: "ja", content: { source: "lyrics-cue", lyrics_contract_digest: ZERO, cue_id: "cue-1", occurrence_id: "occ-1", text_digest: sha256Text(text) }, continuity: "contained" }],
        visible_text_events: [], constraints: { positive: [], exact_text_refs: ["singing-1"] }
      }]
    });
    const result = compileVideoPromptIrV2(ir, {
      route: route(), require_exact_sync: true,
      lyrics_source: { canonical_text: text, text_digest: sha256Text(text), cues: [{ cue_id: "cue-1", occurrence_id: "occ-1", timing: "untimed", lyrics_contract_digest: ZERO, source_span: { start_utf8_byte: 0, end_utf8_byte: Buffer.byteLength(text), text_digest: sha256Text(text) } }] }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toEqual(expect.arrayContaining(["VPD-L003", "VPD-X001"]));
  });

  it("never rewrites an exact vocal body that contains a canonical asset label", () => {
    const exactText = "keep <Picture 1> byte-exact";
    const ir = baseV2({
      assets: [{ id: "hero", type: "image", path: "assets/hero.png", role: "subject_reference", sha256: ZERO }],
      shots: [{
        ...baseV2().shots[0]!,
        vocal_events: [{ id: "dialogue-1", kind: "dialogue", speaker_ids: ["S1"], language_id: "en", content: { source: "inline-exact", exact_text: exactText, text_digest: sha256Text(exactText) }, continuity: "contained" }],
        constraints: { positive: [], exact_text_refs: ["dialogue-1"] }
      }]
    });
    const result = compileVideoPromptIrV2(ir, { route: route() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain("VPD-X001");
  });

  it("revalidates locked identity digests and emits identity blocks for cast subjects", () => {
    const locked = "voice and appearance remain exact";
    const ir = baseV2({
      subjects: [{ id: "hero", description: "traveler", speaker_id: "S1", locked_blocks: { voice: { text: locked, sha256: sha256Text(locked) }, appearance: { text: "red coat", sha256: sha256Text("red coat") } } }],
      shots: [{ ...baseV2().shots[0]!, cast: [{ subject_id: "hero" }] }]
    });
    const result = compileVideoPromptIrV2(ir, { route: route() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.compilation.semantic_blocks.map((block) => block.block_id)).toEqual(expect.arrayContaining(["subject-hero-voice", "subject-hero-appearance"]));
      expect(result.compilation.canonical_prompt).toContain("VOICE (locked):");
    }
    const tampered = { ...ir, subjects: [{ ...ir.subjects[0]!, locked_blocks: { voice: { text: locked, sha256: ZERO } } }] };
    expect(safeParseVideoPromptIrV2(tampered).success).toBe(false);
  });

  it("renders V2 base with exactly three top-level sections and reference with six", () => {
    const base = compileVideoPromptIrV2(baseV2(), { route: route() });
    expect(base.ok).toBe(true);
    if (base.ok) expect(base.compilation.canonical_prompt.match(/^[a-z_]+:/gm)).toEqual([
      "integrated_multimodal_description:", "overall_soundscape:", "non_diegetic_music:"
    ]);
    const referenceIr = baseV2({ target: { model_profile_id: "minimax-h3", mode: "reference", duration_ms: 10_000, quality: "768p", aspect: "16:9", audio: false }, audio: { policy: "silent", reference_asset_ids: [], final_mix: "discard-generated" }, assets: [{ id: "hero", type: "image", path: "assets/hero.png", role: "subject_reference", sha256: ZERO }] });
    const reference = compileVideoPromptIrV2(referenceIr, { route: route("reference") });
    expect(reference.ok).toBe(true);
    if (reference.ok) expect(reference.compilation.canonical_prompt.match(/^[a-z_]+:/gm)).toEqual([
      "subject_definitions:", "summary:", "retention_analysis:", "detailed_description:", "overall_soundscape:", "non_diegetic_music:"
    ]);
  });
});

describe("PO-4 effective contract, budget, route, and immutable bundle", () => {
  it("keeps hard/soft/unknown budget states separate and rejects contradictions", () => {
    const contradiction: PromptBudget = {
      hard: { limit: 100, unit: "unicode-code-points", source: "adapter", verified_at: "2026-08-11T00:00:00Z" },
      soft: { limit: 101, unit: "unicode-code-points", source: "advisory-catalog", verified_at: "2026-08-11T00:00:00Z" },
      unknown: false
    };
    const result = createEffectiveGenerationContract({ mode: "text-to-video", route: route(), budget: contradiction });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe("VPD-B001");
    const unknown = createEffectiveGenerationContract({ mode: "text-to-video", route: route(), budget: { hard: null, soft: null, unknown: true } });
    expect(unknown.ok).toBe(true);
    if (unknown.ok) expect(unknown.contract.effective.prompt_budget.unknown).toBe(true);
    const tooSmall = compileVideoPromptIrV2(baseV2(), { route: route(), budget: { hard: { limit: 1, unit: "unicode-code-points", source: "official-api", verified_at: "2026-08-11T00:00:00Z" }, soft: null, unknown: false } });
    expect(tooSmall.ok).toBe(false);
    if (!tooSmall.ok) expect(tooSmall.issues.map((item) => item.code)).toContain("VPD-B001");
  });

  it("rejects stale/mismatched route and mixed RouteIdentity batch", () => {
    const second = createRouteIdentity({ ...route(), mode_binding: "reference" });
    expect(assertHomogeneousRouteIdentity([route(), second])).toEqual(expect.arrayContaining([expect.objectContaining({ code: "VPD-R001" })]));
    const stale = createEffectiveGenerationContract({ mode: "text-to-video", route: route(), freshness: { status: "stale", review_after: "2020-01-01T00:00:00Z" } });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.issues.map((item) => item.code)).toContain("VPD-K001");
    const mismatch = compileVideoPromptIrV2(baseV2(), { route: { ...route(), mode_binding: "reference" } });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.issues.map((item) => item.code)).toContain("VPD-R001");
  });

  it("rejects injected effective contracts unless strict digest and route bindings match", () => {
    const good = createEffectiveGenerationContract({ mode: "text-to-video", route: route() });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(compileVideoPromptIrV2(baseV2(), { route: route(), effective_contract: good.contract }).ok).toBe(true);
    expect(compileVideoPromptIrV2(baseV2(), { route: route(), effective_contract: { ...good.contract, digest: ZERO } }).ok).toBe(false);
    expect(compileVideoPromptIrV2(baseV2(), { route: route(), effective_contract: { ...good.contract, digests: { ...good.contract.digests, model_profile: sha256Text("wrong") }, digest: sha256Text("recomputed-by-attacker") } as never }).ok).toBe(false);
    expect(compileVideoPromptIrV2(baseV2(), { route: route(), effective_contract: { ...good.contract, mode: "reference" } as never }).ok).toBe(false);
    expect(compileVideoPromptIrV2(baseV2(), { route: route(), effective_contract: { ...good.contract, unexpected: true } as never }).ok).toBe(false);
  });

  it("rejects partial/tampered bundle and asset mutation", () => {
    const result = compileVideoPromptIrV2(baseV2({
      target: { model_profile_id: "minimax-h3", mode: "reference", duration_ms: 10_000, quality: "768p", aspect: "16:9", audio: false },
      audio: { policy: "silent", reference_asset_ids: [], final_mix: "discard-generated" },
      assets: [{ id: "hero", type: "image", path: "assets/hero.png", role: "subject_reference", sha256: ZERO }]
    }), { route: route("reference") });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => verifyCompilationBundle({ ...result.compilation.bundle, adapter_prompt: undefined })).toThrow();
    expect(() => assertCompilationBundleAssets(result.compilation.bundle, { "missing": { path: "other" } })).toThrow("asset lineage changed");
    expect(() => verifyCompilationBundle({ ...result.compilation.bundle, compilation_digest: ZERO })).toThrow();
  });

  it("fails closed without a connection route and execute readiness remains planning-only", async () => {
    const noRoute = compileVideoPromptIrV2(baseV2(), { require_route: true });
    expect(noRoute.ok).toBe(false);
    if (!noRoute.ok) expect(noRoute.issues.map((item) => item.code)).toContain("VPD-R001");
    const model = await loadModelPromptProfile("minimax-h3");
    const connection = await loadConnectionCapabilityProfile("minimax-direct");
    expect(model.ok && connection.ok).toBe(true);
    if (!model.ok || !connection.ok) return;
    const readiness = evaluatePlanningReadiness({ modelProfile: model.profile, connectionProfile: connection.profile, mode: "text-to-video", adapterImplemented: true, intent: "execute" });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) expect(readiness.code).toBe("VPD-E022");
  });

  it("requires T03 GenerationUnitProgramSource for every MV compile and checks the complete binding", () => {
    const mvRoute = route();
    const source = {
      schema_version: 1,
      kind: "mv-generation-unit-source" as const,
      production_id: "production-1",
      unit_id: "unit-1",
      ordinal: 0,
      generation_unit_digest: ZERO,
      music: { contract_id: "music-1", revision: 1, contract_digest: ZERO, master_audio_digest: ZERO },
      program_start_ms: 0,
      program_end_ms: 10_000,
      beat_anchor_refs: [],
      lyric_cue_refs: [],
      route: mvRoute
    };
    const binding = { generation_unit_digest: ZERO, production_id: "production-1", music_contract_digest: ZERO, program_start_ms: 0, program_end_ms: 10_000, beat_anchor_ids: [], lyric_cue_ids: [] };
    const mv = baseV2({ program_kind: "mv", program_binding: binding });
    const missing = compileVideoPromptIrV2(mv, { route: mvRoute });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues.map((item) => item.code)).toContain("VPD-U001");
    const valid = compileVideoPromptIrV2(mv, { route: mvRoute, generation_unit_source: source });
    expect(valid.ok).toBe(true);
    const mismatched = compileVideoPromptIrV2(mv, { route: mvRoute, generation_unit_source: { ...source, production_id: "other-production" } });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.issues.map((item) => item.code)).toContain("VPD-U001");
  });

  it("requires sha256 pin evidence before an execution-capable bundle can be created", () => {
    const unpinned = baseV2({
      target: { model_profile_id: "minimax-h3", mode: "reference", duration_ms: 10_000, quality: "768p", aspect: "16:9", audio: false },
      audio: { policy: "silent", reference_asset_ids: [], final_mix: "discard-generated" },
      assets: [{ id: "hero", type: "image", path: "assets/hero.png", role: "subject_reference" }]
    });
    const result = compileVideoPromptIrV2(unpinned, { route: route("reference") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain("VPD-J001");
  });
});
