import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  compileProjectVideoPrompts,
  compileVideoPromptRequest,
  DEFAULT_H3_GRAMMAR_PROFILE_V3,
  h3GrammarProfileDigest,
  validateMvBinding,
  verifyCompilationBundle,
  assertCompilationBundleAssets,
  assertHomogeneousRouteIdentity,
  routeFromProfiles,
  renderH3GrammarV3,
  type PromptBudget,
  type VideoPromptIrV2
} from "../src/videoPromptDirector/index.js";
import { sha256Canonical, sha256Text } from "../src/integrity/canonical.js";
import { sha256Bytes } from "../src/productionControl/canonical.js";
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
          { id: "singing-1", kind: "singing", speaker_ids: ["S1", "S2"], language_id: "ja-JP", content: { source: "lyrics-cue", lyrics_contract_digest: ZERO, cue_id: "cue-1", occurrence_id: "occ-1", text_digest: lyricDigest }, start_ms: 1_000, end_ms: 10_000, continuity: "continues-out" },
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
        language_bcp47: "ja-JP",
        cues: [{ cue_id: "cue-1", occurrence_id: "occ-1", timing: "timed", lyrics_contract_digest: ZERO, language_bcp47: "ja-JP", source_span: { start_utf8_byte: 0, end_utf8_byte: Buffer.byteLength(lyricText), text_digest: lyricDigest }, start_ms: 1_000, end_ms: 10_000, singer_ids: ["S1", "S2"], use: ["generated-singing"] }]
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
      target: { model_profile_id: "minimax-h3", mode: "reference", duration_ms: 10_000, quality: "768p", aspect: "16:9", audio: false },
      audio: { policy: "silent", reference_asset_ids: [], final_mix: "discard-generated" },
      assets: [{ id: "hero", type: "image", path: "assets/hero.png", role: "subject_reference", sha256: ZERO }],
      shots: [{
        ...baseV2().shots[0]!,
        vocal_events: [{ id: "dialogue-1", kind: "dialogue", speaker_ids: ["S1"], language_id: "en", content: { source: "inline-exact", exact_text: exactText, text_digest: sha256Text(exactText) }, continuity: "contained" }],
        constraints: { positive: [], exact_text_refs: ["dialogue-1"] }
      }]
    });
    const result = compileVideoPromptIrV2(ir, { route: route("reference") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain("VPD-X001");
  });

  it("revalidates locked identity digests and emits identity blocks for cast subjects", () => {
    const locked = "voice and appearance remain exact";
    const appearance = "red coat";
    const identityBody = {
      schema_version: 1 as const,
      contract_id: "identity-locked-1",
      revision: 1,
      subjects: [{
        id: "hero",
        locked_blocks: {
          voice: { text: locked, sha256: sha256Text(locked) },
          appearance: { text: appearance, sha256: sha256Text(appearance) }
        },
        variants: []
      }],
      scenes: [],
      verification_requirements: {
        risk_class: "low" as const,
        conditions: [{ condition_id: "hero-locked", description: "hero stays stable", subject_ids: ["hero"] }],
        minimum_distinct_outputs: 1,
        minimum_distinct_conditions: 1
      },
      definition_status: "confirmed" as const
    };
    const definitionDigest = sha256Canonical(identityBody);
    const confirmation = {
      decision_id: "identity-locked-confirmation",
      decision: "confirmed",
      actor: "human",
      decided_at: "2026-08-11T00:00:00Z",
      subject_digest: definitionDigest
    };
    const withoutEnvelopeDigest = { ...identityBody, definition_digest: definitionDigest, definition_confirmation: confirmation };
    const identityDefinition = { ...withoutEnvelopeDigest, digest: sha256Canonical(withoutEnvelopeDigest) };
    const ir = baseV2({
      identity_definition: identityDefinition,
      subjects: [{ id: "hero", description: "traveler", speaker_id: "S1", locked_blocks: { voice: { text: locked, sha256: sha256Text(locked) }, appearance: { text: appearance, sha256: sha256Text(appearance) } } }],
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

  it("does not promote advisory catalog limits into execution hard evidence", () => {
    const advisory = createEffectiveGenerationContract({
      mode: "text-to-video",
      route: route(),
      execution_capable: false,
      capability_evidence: {
        duration: "hard", aspect: "hard", resolution: "hard", mode: "hard",
        reference: "hard", group_speaker: "hard", exact_text: "hard"
      },
      budget: {
        hard: { limit: 20_000, unit: "utf8-bytes", source: "advisory-catalog", verified_at: "2026-08-11T00:00:00Z" },
        soft: null,
        unknown: false
      }
    });
    expect(advisory.ok).toBe(true);
    if (!advisory.ok) return;
    const result = compileVideoPromptIrV2(baseV2(), { route: route(), intent: "execute", effective_contract: advisory.contract });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain("VPD-K003");
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
    const sourceBody = {
      schema_version: 1,
      kind: "mv-generation-unit-source" as const,
      production_id: "production-1",
      unit_id: "unit-1",
      ordinal: 0,
      music: { contract_id: "music-1", revision: 1, contract_digest: ZERO, master_audio_digest: ZERO },
      program_start_ms: 0,
      program_end_ms: 10_000,
      beat_anchor_refs: [],
      lyric_cue_refs: [],
      route: mvRoute
    };
    const source = { ...sourceBody, generation_unit_digest: sha256Canonical({ kind: "mv-generation-unit", body: sourceBody }) };
    const binding = { generation_unit_digest: source.generation_unit_digest, production_id: "production-1", music_contract_digest: ZERO, program_start_ms: 0, program_end_ms: 10_000, beat_anchor_ids: [], lyric_cue_ids: [] };
    const mv = baseV2({ program_kind: "mv", program_binding: binding });
    const missing = compileVideoPromptIrV2(mv, { route: mvRoute });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues.map((item) => item.code)).toContain("VPD-U001");
    const forged = compileVideoPromptIrV2(mv, { route: mvRoute, generation_unit_source: source });
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.issues.map((item) => item.code)).toContain("VPD-U001");
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
    const result = compileVideoPromptIrV2(unpinned, { route: route("reference"), intent: "execute" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain("VPD-J002");
  });

  it("routes project video_prompt V2 through the v3 compiler boundary", async () => {
    const ir = baseV2({ target: { ...baseV2().target, model_profile_id: "minimax-h3" } });
    const result = await compileProjectVideoPrompts({
      slug: "v2-project",
      name: "v2-project",
      run_id: "v2-project",
      manifest: "manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      orchestration: { mode: "active" },
      generation: {
        adapter: "minimax",
        connection: "minimax-direct",
        requests: [{ id: "v2-request", prompt: "", params: {}, video_prompt: ir } as never]
      }
    } as never, {
      connectionId: "minimax-direct",
      intent: "planning",
      implementedAdapterIds: ["minimax"],
      modelProfileRoots: ["profiles/model-prompts"],
      connectionProfileRoots: ["profiles/connection-capabilities"]
    });
    expect(result.ok).toBe(true);
    expect(result.plans[0]?.compilation.lineage.workflow_id).toBe("video-prompt-v3");
    expect(result.plans[0]?.v2_compilation?.bundle).toBeDefined();
    expect(result.plans[0]?.compilation.execution_request).not.toHaveProperty("video_prompt");
    expect(result.plans[0]?.compilation.execution_request).not.toHaveProperty("h3");
  });

  it("distinguishes planning-only from execution and rejects unknown capability evidence", () => {
    const planning = compileVideoPromptIrV2(baseV2(), { route: route(), intent: "planning" });
    expect(planning.ok).toBe(true);
    const execute = compileVideoPromptIrV2(baseV2(), { route: route(), intent: "execute" });
    expect(execute.ok).toBe(false);
    if (!execute.ok) expect(execute.issues.map((item) => item.code)).toContain("VPD-K003");
    const contract = createEffectiveGenerationContract({ mode: "text-to-video", route: route() });
    expect(contract.ok).toBe(true);
    if (contract.ok) {
      const injected = compileVideoPromptIrV2(baseV2(), { route: route(), intent: "execute", effective_contract: contract.contract });
      expect(injected.ok).toBe(false);
      if (!injected.ok) expect(injected.issues.map((item) => item.code)).toContain("VPD-K003");
    }
  });

  it("binds the complete effective contract body into the immutable bundle", () => {
    const result = compileVideoPromptIrV2(baseV2(), { route: route(), intent: "planning" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compilation.bundle).toHaveProperty("effective_contract");
    expect(result.compilation.bundle.effective_contract.digest).toBe(result.compilation.effective_contract.digest);
    expect(() => verifyCompilationBundle({
      ...result.compilation.bundle,
      effective_contract: { ...result.compilation.bundle.effective_contract, mode: "reference" }
    })).toThrow();
  });

  it("requires a typed, confirmed identity definition for locked identity", () => {
    const locked = "voice stays exact";
    const planning = compileVideoPromptIrV2(baseV2({
      subjects: [{ id: "hero", description: "traveler", locked_blocks: { voice: { text: locked, sha256: sha256Text(locked) } } }]
    }), { route: route(), intent: "planning" });
    expect(planning.ok).toBe(false);
    if (!planning.ok) expect(planning.issues.map((item) => item.code)).toContain("VPD-I001");
    const execute = compileVideoPromptIrV2(baseV2({
      subjects: [{ id: "hero", description: "traveler", locked_blocks: { voice: { text: locked, sha256: sha256Text(locked) } } }]
    }), { route: route(), intent: "execute" });
    expect(execute.ok).toBe(false);
    if (!execute.ok) expect(execute.issues.map((item) => item.code)).toContain("VPD-I001");
  });

  it("accepts only a digest-bound confirmed identity definition and binds its digest", () => {
    const locked = "voice stays exact";
    const identityBody = {
      schema_version: 1 as const,
      contract_id: "identity-1",
      revision: 1,
      subjects: [{ id: "hero", locked_blocks: { voice: { text: locked, sha256: sha256Text(locked) } }, variants: [] }],
      scenes: [],
      verification_requirements: {
        risk_class: "low" as const,
        conditions: [{ condition_id: "hero-condition", description: "hero remains stable", subject_ids: ["hero"] }],
        minimum_distinct_outputs: 1,
        minimum_distinct_conditions: 1
      },
      definition_status: "confirmed" as const
    };
    const definitionDigest = sha256Canonical(identityBody);
    const confirmation = {
      decision_id: "identity-confirmation-1",
      decision: "confirmed",
      actor: "human",
      decided_at: "2026-08-11T00:00:00Z",
      subject_digest: definitionDigest
    };
    const withoutEnvelopeDigest = { ...identityBody, definition_digest: definitionDigest, definition_confirmation: confirmation };
    const identityDefinition = { ...withoutEnvelopeDigest, digest: sha256Canonical(withoutEnvelopeDigest) };
    const result = compileVideoPromptIrV2(baseV2({
      identity_definition: identityDefinition,
      subjects: [{ id: "hero", description: "traveler", locked_blocks: { voice: { text: locked, sha256: sha256Text(locked) } } }]
    }), { route: route(), intent: "planning" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.compilation.bundle.lineage.contract_bindings).toContain(identityDefinition.digest);
  });

  it("rejects a non-H3 renderer/dialect combination instead of leaking H3 labels", () => {
    const plainRoute = createRouteIdentity({
      ir_model: "c1", provider_model: "c1", model_profile_digest: ZERO, connection_id: "fixture-connection",
      connection_digest: ZERO, adapter_id: "unknown-dialect", transport: "manual", mode_binding: "text-to-video"
    });
    const result = compileVideoPromptIrV2(baseV2({ target: { ...baseV2().target, model_profile_id: "c1" } }), { route: plainRoute });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain("VPD-R002");
  });

  it("requires group-speaker grammar support and keeps every speaker in the block", () => {
    const ir = baseV2({
      subjects: [{ id: "a", description: "singer A", speaker_id: "S1" }, { id: "b", description: "singer B", speaker_id: "S2" }],
      shots: [{ ...baseV2().shots[0]!, cast: [{ subject_id: "a" }, { subject_id: "b" }], vocal_events: [{
        id: "group-1", kind: "singing", speaker_ids: ["S1", "S2"], language_id: "en",
        content: { source: "inline-exact", exact_text: "together", text_digest: sha256Text("together") }, continuity: "contained"
      }] }]
    });
    const profileBase = {
      ...DEFAULT_H3_GRAMMAR_PROFILE_V3,
      features: { ...DEFAULT_H3_GRAMMAR_PROFILE_V3.features, group_speaker: false }
    };
    const profile = { ...profileBase, digest: h3GrammarProfileDigest(profileBase) } as never;
    const result = compileVideoPromptIrV2(ir, { route: route(), grammar_profile: profile });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain("VPD-V001");
    const supported = compileVideoPromptIrV2(ir, { route: route() });
    expect(supported.ok).toBe(true);
    if (supported.ok) expect(supported.compilation.canonical_prompt).toContain("(S1, S2)");
  });

  it("serializes style, quality, positive constraints, identity, vocal, and visible-text blocks once", () => {
    const result = compileVideoPromptIrV2(baseV2({
      creative: { style: { medium: "watercolor", tone: "quiet" }, must_include: ["lantern"], prohibited: [] },
      shots: [{ ...baseV2().shots[0]!, constraints: { positive: ["no flicker"], exact_text_refs: [] }, visible_text_events: [{ id: "title", text: "RIVER", text_digest: sha256Text("RIVER"), purpose: "generated-scene-text", render_target: "model" }] }]
    }), { route: route() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.compilation.canonical_prompt.match(/watercolor/g)).toHaveLength(1);
      expect(result.compilation.canonical_prompt.match(/768p/g)).toHaveLength(1);
      expect(result.compilation.canonical_prompt.match(/no flicker/g)).toHaveLength(1);
      expect(result.compilation.canonical_prompt.match(/On-screen text: RIVER/g)).toHaveLength(1);
    }
  });

  it("does not trust a self-declared asset sha for an execution bundle", () => {
    const result = compileVideoPromptIrV2(baseV2({
      target: { model_profile_id: "minimax-h3", mode: "reference", duration_ms: 10_000, quality: "768p", aspect: "16:9", audio: false },
      audio: { policy: "silent", reference_asset_ids: [], final_mix: "discard-generated" },
      assets: [{ id: "hero", type: "image", path: "assets/hero.png", role: "subject_reference", sha256: ZERO }]
    }), { route: route("reference"), intent: "execute" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain("VPD-J002");
  });

  it("rejects vocal events outside shot bounds and invalid continuity", () => {
    const result = compileVideoPromptIrV2(baseV2({
      shots: [{ ...baseV2().shots[0]!, vocal_events: [{
        id: "dialogue-1", kind: "dialogue", speaker_ids: ["S1"], language_id: "en",
        content: { source: "inline-exact", exact_text: "late", text_digest: sha256Text("late") },
        start_ms: 9_000, end_ms: 11_000, continuity: "contained"
      }] }]
    }), { route: route() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain("VPD-T004");
  });

  it("keeps execution blocked when budget evidence is only caller-supplied", async () => {
    const model = await loadModelPromptProfile("minimax-h3");
    const connection = await loadConnectionCapabilityProfile("minimax-direct");
    expect(model.ok && connection.ok).toBe(true);
    if (!model.ok || !connection.ok) return;
    const selected = routeFromProfiles({
      model: "minimax-h3",
      mode: "reference",
      model_profile: model.profile,
      connection_profile: connection.profile,
      model_profile_digest: model.digest,
      connection_profile_digest: connection.digest
    });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    const bytes = await readFile("test/fixtures/h3/t2v.json");
    const path = resolve("test/fixtures/h3/t2v.json");
    const referenceIr = baseV2({
      target: { model_profile_id: "minimax-h3", mode: "reference", duration_ms: 10_000, quality: "768p", aspect: "16:9", audio: false },
      audio: { policy: "silent", reference_asset_ids: [], final_mix: "discard-generated" },
      assets: [{ id: "hero", type: "image", path: "t2v.json", role: "subject_reference", sha256: sha256Bytes(bytes) }]
    });
    const result = compileVideoPromptIrV2(referenceIr, {
      route: selected.route,
      model_profile: model.profile,
      connection_profile: connection.profile,
      model_profile_digest: model.digest,
      connection_capability_digest: connection.digest,
      intent: "execute",
      budget: { hard: { limit: 20_000, unit: "utf8-bytes", source: "official-api", verified_at: "2026-08-11T00:00:00Z" }, soft: null, unknown: false },
      project_root: resolve("test/fixtures/h3"),
      asset_evidence: { hero: { source: "project-bytes", real_path: path, sha256: sha256Bytes(bytes), byte_size: bytes.byteLength, regular_file: true, contained_in_project_root: true } }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain("VPD-K003");
  });

  it("rejects frame/audio asset matrix contradictions and supports V1 video_prompt H3 upgrade", async () => {
    expect(safeParseVideoPromptIrV2(baseV2({
      assets: [{ id: "reference", type: "image", path: "reference.png", role: "subject_reference", sha256: ZERO }]
    })).success).toBe(false);
    expect(safeParseVideoPromptIrV2(baseV2({
      assets: [{ id: "first", type: "image", path: "first.png", role: "first_frame", sha256: ZERO }]
    })).success).toBe(false);
    expect(safeParseVideoPromptIrV2(baseV2({
      target: { model_profile_id: "minimax-h3", mode: "reference", duration_ms: 10_000, quality: "768p", aspect: "16:9", audio: false },
      audio: { policy: "silent", reference_asset_ids: [], final_mix: "discard-generated" }
    })).success).toBe(false);
    const legacy = parseH3CreativeIr(JSON.parse(await readFile("test/fixtures/h3/t2v.json", "utf8")));
    const legacyForCompile = { ...legacy, target: { ...legacy.target, quality: "768p" } };
    const result = await compileVideoPromptRequest({ id: "legacy-vp", prompt: "", params: {}, video_prompt: legacyForCompile } as never, legacyForCompile as never, {
      connectionId: "minimax-direct",
      intent: "planning",
      implementedAdapterIds: ["minimax"],
      modelProfileRoots: ["profiles/model-prompts"],
      connectionProfileRoots: ["profiles/connection-capabilities"]
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.compiler_workflow).toBe("video-prompt-v3");
      expect(result.plan.v2_compilation?.bundle.lineage.authoring_schema).toBe("V1");
      expect(result.plan.v2_compilation?.bundle.lineage.upgrader_version).toBe("video-prompt-v1-to-v2@1");
    }
  });

  it("keeps the public renderer compatibility call deterministic while active compile uses AST", () => {
    const rendered = renderH3GrammarV3(baseV2({
      scenes: [{ id: "scene-1", location_map: "river bank", palette: "blue", props: ["lantern"], active_subject_ids: [] }],
      shots: [{ ...baseV2().shots[0]!, scene_id: "scene-1", camera: { type: "pan", direction: "left", amplitude: "slow", optics: { fov_degrees: 35 } }, visible_text_events: [{ id: "title", text: "RIVER", text_digest: sha256Text("RIVER"), purpose: "generated-scene-text", render_target: "model" }] }]
    }));
    expect(rendered.issues.filter((item) => item.severity === "error")).toHaveLength(0);
    expect(rendered.text).toContain("LOCATION MAP:");
    expect(rendered.text).toContain("On-screen text: RIVER");
  });

  it("detects mutation of the real bytes bound by a compilation bundle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tsugite-po4-"));
    const path = join(directory, "asset.bin");
    try {
      const original = Buffer.from("original bytes", "utf8");
      await writeFile(path, original);
      const result = compileVideoPromptIrV2(baseV2({
        target: { model_profile_id: "minimax-h3", mode: "reference", duration_ms: 10_000, quality: "768p", aspect: "16:9", audio: false },
        audio: { policy: "silent", reference_asset_ids: [], final_mix: "discard-generated" },
        assets: [{ id: "hero", type: "image", path: "asset.bin", role: "subject_reference", sha256: sha256Bytes(original) }]
      }), {
        route: route("reference"),
        asset_evidence: {
          hero: { source: "project-bytes", real_path: path, sha256: sha256Bytes(original), byte_size: original.byteLength, regular_file: true, contained_in_project_root: true }
        }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      assertCompilationBundleAssets(result.compilation.bundle, { hero: { path: "asset.bin", sha256: sha256Bytes(original) } }, { hero: { real_path: path, project_root: directory } });
      await writeFile(path, "mutated bytes", "utf8");
      expect(() => assertCompilationBundleAssets(result.compilation.bundle, { hero: { path: "asset.bin", sha256: sha256Bytes(original) } }, { hero: { real_path: path, project_root: directory } })).toThrow("asset bytes changed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
