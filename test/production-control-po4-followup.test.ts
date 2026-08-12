import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile, rm, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCompilationBundleAssets,
  compileVideoPromptIrV2,
  compileProjectVideoPrompts,
  loadAdapterDialectCapability,
  loadConnectionCapabilityProfile,
  loadModelPromptProfile,
  routeFromProfiles,
  verifyCompilationBundle,
  validatePromptLength,
  type VideoPromptIrV2
} from "../src/videoPromptDirector/index.js";
import { buildProgramBinding, type GenerationUnitProgramSourceV1 } from "../src/productionControl/programBinding.js";
import { createArtifactStore } from "../src/productionControl/artifactStore.js";
import { createGenerationUnit, toProgramBindingSource } from "../src/productionControl/contracts/generationUnit.js";
import { createLyricsContract } from "../src/productionControl/contracts/lyrics.js";
import { createMusicStructureContract } from "../src/productionControl/contracts/music.js";
import { createDryRun, createPlan } from "../src/orchestrator/plan.js";
import { createReviewDocument, inspectGate1Review, renderReviewHtml, writeCreativeReview } from "../src/orchestrator/review.js";
import { validateProject } from "../src/project/validateProject.js";
import { assertEffectiveGenerationContract, createEffectiveGenerationContract } from "../src/videoPromptDirector/effectiveContract.js";
import { h3IssueToProjectIssue } from "../src/videoPromptDirector/compile.js";
import { loadPlanningOnlyPinnedPromptBudgetEvidence } from "../src/videoPromptDirector/promptBudgetEvidence.js";
import { sha256Canonical, sha256Text } from "../src/integrity/canonical.js";
import { isProjectAssetIdentityContained } from "../src/videoPromptDirector/compilationBundle.js";
import { consumeGenerationUnitLyricsForSource, consumeGenerationUnitLyricsToken, createProjectGenerationUnitSourceResolver, isAuthoritativeGenerationUnitSource, isGenerationUnitPathContained } from "../src/videoPromptDirector/generationUnitSourceResolver.js";
import { loadProject } from "../src/project/loadProject.js";

const ZERO = "0".repeat(64);

function baseV2(modelOrOverrides: string | Partial<Record<string, unknown>> = "minimax-h3"): VideoPromptIrV2 {
  const model = typeof modelOrOverrides === "string" ? modelOrOverrides : "minimax-h3";
  const overrides = typeof modelOrOverrides === "string" ? {} : modelOrOverrides;
  return {
    version: 2,
    program_kind: "standalone",
    target: {
      model_profile_id: model,
      mode: "text-to-video",
      duration_ms: 10_000,
      quality: model === "minimax-h3" ? "768p" : "720p",
      aspect: "16:9",
      audio: false
    },
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
    audio: { policy: "silent", reference_asset_ids: [], final_mix: "discard-generated" },
    ...overrides
  };
}

async function realProfiles(modelId = "minimax-h3", connectionId = "minimax-direct", mode: "text-to-video" | "reference" = "text-to-video") {
  const model = await loadModelPromptProfile(modelId);
  const connection = await loadConnectionCapabilityProfile(connectionId);
  expect(model.ok && connection.ok).toBe(true);
  if (!model.ok || !connection.ok) throw new Error("fixture profiles are unavailable");
  const selected = routeFromProfiles({
    model: modelId,
    mode,
    model_profile: model.profile,
    connection_profile: connection.profile,
    model_profile_digest: model.digest,
    connection_profile_digest: connection.digest
  });
  expect(selected.ok).toBe(true);
  if (!selected.ok) throw new Error("fixture route is unavailable");
  return { model, connection, route: selected.route };
}

function cli(args: string[], cwd: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, TSUGITE_PROJECTS_HOME: join(cwd, "launcher-projects") }
  });
}

function sourceFor(route: Awaited<ReturnType<typeof realProfiles>>["route"], unitId = "mv-unit-01", ordinal = 0): GenerationUnitProgramSourceV1 {
  const body = {
    schema_version: 1,
    kind: "mv-generation-unit-source",
    production_id: "production-1",
    unit_id: unitId,
    ordinal,
    music: { contract_id: "music-1", revision: 1, contract_digest: ZERO, master_audio_digest: ZERO },
    lyrics: { contract_id: "lyrics-1", revision: 1, contract_digest: ZERO },
    program_start_ms: 0,
    program_end_ms: 10_000,
    section_id: "section-1",
    beat_anchor_refs: [{ slot: "music", contract_id: "music-1", revision: 1, kind: "beat", fragment_id: "beat-1", digest: ZERO }],
    lyric_cue_refs: [{ slot: "lyrics", contract_id: "lyrics-1", revision: 1, kind: "lyric-cue", fragment_id: "cue-1", digest: ZERO }],
    route
  };
  return { ...body, generation_unit_digest: sha256Canonical({ kind: "mv-generation-unit", body }) };
}

async function writeMvProject(withSource: boolean, withLyrics = false): Promise<{
  root: string;
  configPath: string;
  source: GenerationUnitProgramSourceV1;
  unitPath: string;
  ir: VideoPromptIrV2;
}> {
  const root = await mkdtemp(join(tmpdir(), "tsugite-po4-cli-"));
  await mkdir(join(root, "media"), { recursive: true });
  await mkdir(join(root, "production-control", "generation-units"), { recursive: true });
  const manifest = JSON.parse(await readFile("examples/local-fixture/manifest.json", "utf8")) as Record<string, unknown>;
  (manifest.meta as Record<string, unknown>).target_duration_seconds = 72;
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  await copyFile("examples/local-fixture/media/clip-001.mp4", join(root, "media/clip-001.mp4"));
  await copyFile("examples/local-fixture/media/clip-002.mp4", join(root, "media/clip-002.mp4"));
  const { route } = await realProfiles("v6", "pixverse");
  const music = createMusicStructureContract({
    contract_id: "music-1",
    revision: 1,
    master_audio: { asset_id: "master-audio", sha256: sha256Text("master-audio"), duration_ms: 72_000 },
    analysis: { status: "imported" },
    tempo_map: [],
    beat_markers: [],
    sections: [],
    section_policy: { gaps: "allow", overlaps: "forbid" }
  });
  const lyrics = withLyrics ? createLyricsContract({
    contract_id: "lyrics-1",
    revision: 1,
    language_bcp47: "ja-JP",
    source: { canonical_text: "歌", text_digest: sha256Text("歌") },
    alignment_state: "complete",
    alignment_basis: "human-reviewed",
    cues: [{
      id: "cue-1",
      timing: "timed",
      source_span: { occurrence_id: "occ-1", start_utf8_byte: 0, end_utf8_byte: 3, text_digest: sha256Text("歌") },
      singer_ids: ["S1"],
      use: ["generated-singing"],
      start_ms: 0,
      end_ms: 1_000
    }]
  }) : undefined;
  const unit = createGenerationUnit({ production_id: "production-1", unit_id: "mv-unit-01", ordinal: 0, music, ...(lyrics ? { lyrics, lyric_cue_ids: ["cue-1"] } : {}), start_ms: 0, end_ms: 10_000, audio_policy: "reuse-master", route });
  const source = toProgramBindingSource(unit);
  const store = await createArtifactStore(join(await realpath(root), "production-control"));
  await store.create({ artifact_id: music.contract_id, bytes: JSON.stringify(music) });
  if (lyrics) await store.create({ artifact_id: lyrics.contract_id, bytes: JSON.stringify(lyrics) });
  if (withSource) await store.create({ artifact_id: unit.unit_id, bytes: JSON.stringify(unit) });
  const ir = {
    ...baseV2("v6"),
    program_kind: "mv",
    audio: { policy: "reuse-master", reference_asset_ids: [], final_mix: "discard-generated" },
    program_binding: buildProgramBinding(source),
    ...(lyrics ? {
      subjects: [{ id: "subject-s1", description: "singer", speaker_id: "S1" }],
      shots: [{
        ...baseV2("v6").shots[0]!,
        vocal_events: [{
          id: "event-1",
          kind: "singing" as const,
          speaker_ids: ["S1"],
          language_id: "ja-JP",
          content: { source: "lyrics-cue" as const, lyrics_contract_digest: lyrics.digest, cue_id: "cue-1", occurrence_id: "occ-1", text_digest: sha256Text("歌") },
          start_ms: 0,
          end_ms: 1_000,
          continuity: "contained" as const
        }]
      }]
    } : {})
  } as VideoPromptIrV2;
  const project = {
    slug: "po4-cli-mv",
    name: "PO4 CLI MV",
    run_id: "po4-cli-mv-run",
    manifest: "manifest.json",
    dist_dir: "dist",
    edit: { backend: "remotion" },
    orchestration: {
      mode: "active",
      authoring: {
        music: { kind: "music-contract", id: music.contract_id, digest: music.digest },
        ...(lyrics ? { lyrics: { kind: "lyrics-contract", id: lyrics.contract_id, digest: lyrics.digest } } : {}),
        generation_units: [{ kind: "mv-generation-unit", id: unit.unit_id, digest: unit.digest }]
      }
    },
    generation: {
      connection: "pixverse",
      adapter: "pixverse",
      requests: [{ id: "mv-unit-01", operation: "video", model: "v6", mode: "text-to-video", prompt: "", params: {}, video_prompt: ir }]
    }
  };
  const configPath = join(root, "project.yaml");
  await writeFile(configPath, JSON.stringify(project));
  const unitPath = join(root, "production-control", "artifacts", "mv-unit-01.json");
  return { root, configPath, source, unitPath, ir };
}

describe("PO-4 follow-up security and profile regressions", () => {
  it("selects one exact model+mode route independent of profile array order", async () => {
    const { model, connection } = await realProfiles("v6", "pixverse");
    const split = {
      ...connection.profile,
      exact_model_routes: [
        { model: "v6", provider_model: "v6-text", modes: ["text-to-video"] },
        { model: "v6", provider_model: "v6-image", modes: ["first-frame"] }
      ]
    };
    const text = routeFromProfiles({ model: "v6", mode: "text-to-video", model_profile: model.profile, connection_profile: split, model_profile_digest: model.digest });
    const image = routeFromProfiles({ model: "v6", mode: "first-frame", model_profile: model.profile, connection_profile: split, model_profile_digest: model.digest });
    const reversed = routeFromProfiles({ model: "v6", mode: "text-to-video", model_profile: model.profile, connection_profile: { ...split, exact_model_routes: [...split.exact_model_routes].reverse() }, model_profile_digest: model.digest });
    expect(text.ok && text.route.provider_model).toBe("v6-text");
    expect(image.ok && image.route.provider_model).toBe("v6-image");
    expect(reversed.ok && reversed.route.provider_model).toBe("v6-text");
    const ambiguous = routeFromProfiles({ model: "v6", mode: "text-to-video", model_profile: model.profile, connection_profile: { ...split, exact_model_routes: [...split.exact_model_routes, { model: "v6", provider_model: "v6-other", modes: ["text-to-video"] }] }, model_profile_digest: model.digest });
    expect(ambiguous.ok).toBe(false);
  });

  it("rejects a lyrics token swapped between two authoritative generation-unit sources", async () => {
    const a = await writeMvProject(true, true);
    const b = await writeMvProject(true, true);
    try {
      const projectA = await loadProject(a.configPath);
      const projectB = await loadProject(b.configPath);
      const requestA = projectA.generation!.requests[0]!;
      const requestB = projectB.generation!.requests[0]!;
      const irA = a.ir;
      const sourceA = await createProjectGenerationUnitSourceResolver(a.configPath)({ project: projectA, request: requestA, ir: irA, requestIndex: 0 });
      const sourceB = await createProjectGenerationUnitSourceResolver(b.configPath)({ project: projectB, request: requestB, ir: b.ir, requestIndex: 0 });
      expect(sourceA && sourceB && isAuthoritativeGenerationUnitSource(sourceA) && isAuthoritativeGenerationUnitSource(sourceB)).toBe(true);
      if (!sourceA || !sourceB) return;
      const tokenA = consumeGenerationUnitLyricsToken(sourceA);
      const tokenB = consumeGenerationUnitLyricsToken(sourceB);
      expect(tokenA && tokenB).toBeTruthy();
      expect(consumeGenerationUnitLyricsForSource(sourceA, tokenB!)).toBeUndefined();
      const profiles = await realProfiles("v6", "pixverse");
      const capability = await loadAdapterDialectCapability("pixverse", ["adapters"], {
        model_profile_id: "v6", provider_model: profiles.route.provider_model, mode: "text-to-video"
      });
      expect(capability.ok).toBe(true);
      if (!capability.ok || !tokenB) return;
      const compiled = compileVideoPromptIrV2(irA, {
        route: profiles.route,
        model_profile: profiles.model.profile,
        model_profile_digest: profiles.model.digest,
        connection_profile: profiles.connection.profile,
        connection_capability_digest: profiles.connection.digest,
        adapter_dialect_capability: capability.capability,
        generation_unit_source: sourceA,
        generation_unit_lyrics_token: tokenB,
        require_exact_sync: true
      });
      expect(compiled.ok).toBe(false);
      expect(compiled.issues.map((issue) => issue.code)).toContain("VPD-L002");
    } finally {
      await rm(a.root, { recursive: true, force: true });
      await rm(b.root, { recursive: true, force: true });
    }
  });

  it("uses a loaded provider-neutral adapter capability for a new non-H3 route", async () => {
    const { model, connection, route } = await realProfiles("v6", "pixverse");
    const capability = await loadAdapterDialectCapability("pixverse", ["adapters"], { model_profile_id: "v6", provider_model: "v6", mode: "text-to-video" });
    expect(capability.ok).toBe(true);
    if (!capability.ok) return;
    const result = compileVideoPromptIrV2(baseV2("v6"), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: capability.capability
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.compilation.adapter_prompt).not.toContain("<Picture 1>");
      expect(result.compilation.adapter_prompt).not.toContain("@image1");
    }
  });

  it("loads the minimax-http api adapter profile and compiles its native H3 route", async () => {
    const model = await loadModelPromptProfile("minimax-h3");
    const connection = await loadConnectionCapabilityProfile("minimax-http");
    const capability = await loadAdapterDialectCapability("minimax-http", ["adapters"], { model_profile_id: "minimax-h3", provider_model: "MiniMax-H3", mode: "last-frame" });
    expect(model.ok && connection.ok && capability.ok).toBe(true);
    if (!model.ok || !connection.ok || !capability.ok) return;
    const selected = routeFromProfiles({
      model: "minimax-h3",
      mode: "last-frame",
      model_profile: model.profile,
      connection_profile: connection.profile,
      model_profile_digest: model.digest,
      connection_profile_digest: connection.digest
    });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    const result = compileVideoPromptIrV2({
      ...baseV2(),
      target: { ...baseV2().target, mode: "last-frame" },
      assets: [{ id: "last", type: "image", path: "last.png", role: "last_frame" }]
    }, {
      route: selected.route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: capability.capability
    });
    expect(result.ok).toBe(true);
  });

  it("routes connected legacy request.h3 through the V2 compiler without rewriting authoring", async () => {
    const legacy = JSON.parse(await readFile(join(process.cwd(), "test", "fixtures", "h3", "t2v.json"), "utf8")) as Record<string, unknown>;
    legacy.target = { ...(legacy.target as Record<string, unknown>), quality: "768p" };
    const project = {
      slug: "legacy-h3-v2-entry",
      name: "legacy h3 v2 entry",
      manifest: "manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      generation: {
        connection: "minimax-direct",
        adapter: "minimax",
        requests: [{ id: "legacy-h3-01", prompt: "", params: {}, h3: legacy }]
      },
      orchestration: { mode: "active" }
    } as never;
    const result = await compileProjectVideoPrompts(project, {
      connectionId: "minimax-direct",
      intent: "planning",
      implementedAdapterIds: ["minimax"]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plans[0]?.compiler_workflow).toBe("video-prompt-v3");
    expect(result.plans[0]?.v2_compilation?.bundle.lineage.authoring_schema).toBe("H3-V1");
    expect(result.project.generation?.requests[0]?.h3).toEqual(legacy);
    expect((result.project.generation?.requests[0] as { video_prompt?: unknown }).video_prompt).toBeUndefined();
    expect(result.project.generation?.requests[0]?.prompt).toBeTruthy();
  });

  it("connects validateProject and createPlan to the same legacy-H3 V2 boundary", async () => {
    const fixture = await writeMvProject(true);
    try {
      const legacy = JSON.parse(await readFile(join(process.cwd(), "test", "fixtures", "h3", "t2v.json"), "utf8")) as Record<string, unknown>;
      legacy.target = { ...(legacy.target as Record<string, unknown>), quality: "768p" };
      const project = JSON.parse(await readFile(fixture.configPath, "utf8")) as Record<string, any>;
      project.generation.connection = "minimax-direct";
      project.generation.adapter = "minimax";
      project.generation.requests[0] = {
        id: "legacy-h3-validate-01",
        operation: "video",
        model: "minimax-h3",
        mode: "text-to-video",
        prompt: "",
        params: {},
        h3: legacy
      };
      await writeFile(fixture.configPath, JSON.stringify(project));
      const catalogPath = join(fixture.root, "fixture.catalog.json");
      await writeFile(catalogPath, JSON.stringify({
        schema_version: 1,
        selection_prompt: {
          id: "fixture-selection",
          question: "select fixture connection",
          required_when: "connection-unspecified",
          instruction: "fixture-only",
          no_subscription_message: "fixture-only",
          no_subscription_options: ["minimax-direct"]
        },
        connections: [{
          id: "minimax-direct",
          aliases: [],
          display_name: "MiniMax fixture",
          provider: "minimax",
          transport: "cli",
          auth_kind: "none",
          implementation_status: "integrated",
          adapter: "minimax",
          execution_mode: "pipeline-adapter",
          capabilities: ["video.text-to-video"],
          automated_capabilities: ["video.text-to-video"],
          model_policy: "catalog",
          model_families: ["minimax", "minimax-h3"],
          route_note: "fixture-only; no provider submission",
          setup_checks: []
        }]
      }));
      const validation = await validateProject(fixture.configPath, { connectionCatalogPath: catalogPath });
      expect(validation.ok).toBe(true);
      if (!validation.ok) return;
      const plan = createPlan(
        validation.project,
        validation.manifest,
        validation.adapter,
        validation.analysisAdapter,
        validation.promptGuides,
        validation.audioAdapter,
        validation.generationConnection,
        validation.audioConnection,
        validation.backend,
        validation.h3_compilations,
        validation.video_prompt_plans
      );
      expect(plan.video_prompt_plans?.[0]?.compiler_workflow).toBe("video-prompt-v3");
      expect(plan.video_prompt_plans?.[0]?.v2_compilation?.bundle.lineage.authoring_schema).toBe("H3-V1");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not let provider-neutral rendering retain H3 controls or grammar profile", async () => {
    const { model, connection, route } = await realProfiles("v6", "pixverse");
    const capability = await loadAdapterDialectCapability("pixverse", ["adapters"], { model_profile_id: "v6", provider_model: "v6", mode: "text-to-video" });
    expect(capability.ok).toBe(true);
    if (!capability.ok) return;
    const exact = "line 1\n🙂";
    const ir = {
      ...baseV2("v6"),
      shots: [{
        ...baseV2("v6").shots[0]!,
        vocal_events: [{
          id: "dialogue-1",
          kind: "dialogue" as const,
          speaker_ids: ["S1"],
          language_id: "ja",
          content: { source: "inline-exact" as const, exact_text: exact, text_digest: sha256Text(exact) },
          start_ms: 8_000,
          end_ms: 10_000,
          continuity: "cutoff" as const
        }]
      }]
    } as VideoPromptIrV2;
    const result = compileVideoPromptIrV2(ir, {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: capability.capability
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compilation.canonical_prompt).not.toMatch(/<\/?(?:d|scenetrans|cutoff)>/);
    expect(result.compilation.canonical_prompt).not.toMatch(/<(?:Picture|Subject) \d+>/);
    expect(result.compilation.bundle.grammar_profile).toBeUndefined();
    expect(result.compilation.canonical_prompt).toContain(exact);
  });

  it("binds the complete MV source artifact and rejects source-field mutation", async () => {
    const fixture = await writeMvProject(true);
    try {
      const project = JSON.parse(await readFile(fixture.configPath, "utf8")) as never;
      const resolver = createProjectGenerationUnitSourceResolver(fixture.configPath);
      const resolved = await resolver({
        project,
        request: { id: "mv-unit-01" } as never,
        ir: fixture.ir,
        requestIndex: 0
      });
      expect(resolved).toBeDefined();
      if (!resolved) return;
      expect(isAuthoritativeGenerationUnitSource(resolved)).toBe(true);
      expect(Object.isFrozen(resolved)).toBe(true);
      expect(isAuthoritativeGenerationUnitSource({ ...resolved, music: { ...resolved.music, revision: 2 } })).toBe(false);
      const validation = await validateProject(fixture.configPath);
      expect(validation.ok).toBe(true);
      if (!validation.ok) return;
      const plan = validation.video_prompt_plans?.[0];
      expect(plan?.v2_compilation?.bundle.lineage.generation_unit_source_digest).toBe(fixture.source.generation_unit_digest);
      const mutated = { ...fixture.source, music: { ...fixture.source.music, revision: 2 } };
      const rawUnit = JSON.parse(await readFile(fixture.unitPath, "utf8")) as Record<string, unknown>;
      rawUnit.music_binding = { ...(rawUnit.music_binding as Record<string, unknown>), revision: 2 };
      await writeFile(fixture.unitPath, JSON.stringify(rawUnit));
      const stale = await validateProject(fixture.configPath);
      expect(stale.ok).toBe(false);
      expect(stale.issues.map((item) => item.code)).toContain("VPD-U001");
      if (plan?.v2_compilation) expect(() => verifyCompilationBundle(plan.v2_compilation.bundle)).not.toThrow();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects generation-unit directory and leaf symlinks plus Windows escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-source-identity-"));
    let outside: string | undefined;
    try {
      outside = await mkdtemp(join(tmpdir(), "tsugite-po4-source-outside-"));
      await mkdir(join(root, "production-control"), { recursive: true });
      await mkdir(join(outside, "generation-units"), { recursive: true });
      const { route } = await realProfiles("v6", "pixverse");
      await writeFile(join(outside, "generation-units", "mv-unit-01.json"), JSON.stringify(sourceFor(route)));
      await symlink(join(outside, "generation-units"), join(root, "production-control", "generation-units"));
      const project = { production_control: { generation_unit_sources_dir: "production-control/generation-units" } } as never;
      const resolver = createProjectGenerationUnitSourceResolver(join(root, "project.yaml"));
      expect(await resolver({ project, request: { id: "mv-unit-01" } as never, ir: baseV2("v6"), requestIndex: 0 })).toBeUndefined();
      expect(isGenerationUnitPathContained("C:\\project", "C:\\project\\generation-units\\x.json", win32)).toBe(true);
      expect(isGenerationUnitPathContained("C:\\project", "C:\\project-foreign\\x.json", win32)).toBe(false);
      expect(isGenerationUnitPathContained("C:\\project", "D:\\project\\x.json", win32)).toBe(false);
      expect(isGenerationUnitPathContained("\\\\server\\share\\project", "\\\\server\\other\\x.json", win32)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      if (outside) await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a self-consistent but unpinned adapter capability", async () => {
    const { model, connection, route } = await realProfiles("v6", "pixverse");
    const forged = {
      adapter_id: route.adapter_id,
      renderer: model.profile.renderer,
      label_dialect: model.profile.label_dialect,
      source_digest: sha256Text("caller-registered-adapter")
    } as const;
    const result = compileVideoPromptIrV2(baseV2("v6"), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: forged
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain("VPD-R002");
  });

  it("resolves a typed MV source through every real CLI planning entrypoint", async () => {
    const fixture = await writeMvProject(true);
    try {
      for (const command of ["validate", "plan", "review", "run --dry-run"]) {
        const args = [command.split(" "), "--config", fixture.configPath, "--json"].flat();
        if (command === "review") args.push("--state-dir", join(fixture.root, "dist"));
        const result = cli(args, fixture.root);
        expect(result.status, `${command}: ${result.stderr}`).toBe(0);
        const output = JSON.parse(result.stdout) as { ok?: boolean; issues?: Array<{ code?: string }>; video_prompt_plans?: unknown[]; plan?: { video_prompt_plans?: unknown[] }; dry_run?: { plan?: { video_prompt_plans?: unknown[] } } };
        expect(output.ok).toBe(true);
        const plans = output.video_prompt_plans ?? output.plan?.video_prompt_plans ?? output.dry_run?.plan?.video_prompt_plans;
        if (command !== "review") expect(plans).toHaveLength(1);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed in the CLI when the MV source is missing or mismatched", async () => {
    const missing = await writeMvProject(false);
    try {
      const result = cli(["validate", "--config", missing.configPath, "--json"], missing.root);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("VPD-U001");
    } finally {
      await rm(missing.root, { recursive: true, force: true });
    }
    const mismatch = await writeMvProject(true);
    try {
      const wrong = JSON.parse(await readFile(mismatch.unitPath, "utf8")) as Record<string, unknown>;
      wrong.program_end_ms = 9_000;
      await writeFile(mismatch.unitPath, JSON.stringify(wrong));
      const result = cli(["validate", "--config", mismatch.configPath, "--json"], mismatch.root);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("VPD-U001");
    } finally {
      await rm(mismatch.root, { recursive: true, force: true });
    }
  });

  it("projects V2 prompts into review data/HTML and Gate 1 rejects tampered ordered digest sets", async () => {
    const fixture = await writeMvProject(true);
    try {
      const validation = await validateProject(fixture.configPath);
      expect(validation.ok).toBe(true);
      if (!validation.ok) return;
      const plan = createPlan(validation.project, validation.manifest, validation.adapter, validation.analysisAdapter, validation.promptGuides, validation.audioAdapter, validation.generationConnection, validation.audioConnection, validation.backend, validation.h3_compilations, validation.video_prompt_plans);
      const document = createReviewDocument(validation.project, validation.manifest, plan);
      expect(document.video_prompt_plans).toHaveLength(1);
      expect(JSON.stringify(document.video_prompt_plans)).not.toContain(fixture.root);
      expect(renderReviewHtml(document)).toContain("data-testid=\"video-prompt-plans\"");
      await writeCreativeReview({ configPath: fixture.configPath, project: validation.project, manifest: validation.manifest, plan, stateDir: join(fixture.root, "dist") });
      const first = await inspectGate1Review({ configPath: fixture.configPath, project: validation.project, manifest: validation.manifest, stateDir: join(fixture.root, "dist") });
      expect(first.ok, first.ok ? "" : JSON.stringify(first.issues)).toBe(true);
      const dataPath = join(fixture.root, "dist", "po4-cli-mv-run", "review", "review-data.json");
      const reviewPath = join(fixture.root, "dist", "po4-cli-mv-run", "review", "index.html");
      const data = JSON.parse(await readFile(dataPath, "utf8")) as typeof document;
      data.video_prompt_plans![0]!.compilation.canonical_prompt += " tampered";
      await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`);
      await writeFile(reviewPath, renderReviewHtml(data));
      const tampered = await inspectGate1Review({ configPath: fixture.configPath, project: validation.project, manifest: validation.manifest, stateDir: join(fixture.root, "dist") });
      expect(tampered.ok).toBe(false);
      if (!tampered.ok) expect(tampered.issues.map((item) => item.code)).toContain("gate.video_prompt_changed");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a caller-supplied execution budget without trusted pinned evidence", async () => {
    const { model, connection, route } = await realProfiles();
    const result = compileVideoPromptIrV2(baseV2(), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      budget: {
        hard: {
          limit: 999_999,
          unit: "unicode-code-points",
          source: "official-api",
          verified_at: "2026-08-11T00:00:00Z",
          source_digest: ZERO
        },
        soft: null,
        unknown: false
      },
      intent: "execute"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain("VPD-K003");
  });

  it("does not count emoji as Unicode code points for an unimplemented token budget", () => {
    const issues = validatePromptLength("🙂", {
      hard: { limit: 1, unit: "tokens", source: "official-api", verified_at: "2026-08-11T00:00:00Z" },
      soft: null,
      unknown: false
    });
    expect(issues.map((item) => item.code)).toContain("VPD-B003");
    expect(issues.map((item) => item.code)).not.toContain("VPD-B001");
  });

  it("does not accept same-byte assets from a different real path", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-asset-identity-"));
    try {
      const expectedPath = join(root, "expected.png");
      const foreignPath = join(root, "foreign.png");
      await writeFile(expectedPath, "same bytes");
      await writeFile(foreignPath, "same bytes");
      const { model, connection, route } = await realProfiles("minimax-h3", "minimax-direct", "reference");
      const adapter = await loadAdapterDialectCapability("minimax", ["adapters"], { model_profile_id: "minimax-h3", provider_model: "MiniMax-H3", mode: "text-to-video" });
      expect(adapter.ok).toBe(true);
      if (!adapter.ok) return;
      const result = compileVideoPromptIrV2({
        ...baseV2(),
        target: { ...baseV2().target, mode: "reference" },
        assets: [{ id: "hero", type: "image", path: "expected.png", role: "subject_reference", sha256: sha256Text("same bytes") }]
      } as VideoPromptIrV2, {
        route: { ...route, mode_binding: "reference" },
        model_profile: model.profile,
        model_profile_digest: model.digest,
        connection_profile: connection.profile,
        connection_capability_digest: connection.digest,
        adapter_dialect_capability: adapter.capability,
        project_root: root,
        asset_evidence: {
          hero: {
            source: "project-bytes",
            real_path: expectedPath,
            sha256: sha256Text("same bytes"),
            byte_size: Buffer.byteLength("same bytes"),
            regular_file: true,
            contained_in_project_root: true
          }
        }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(() => assertCompilationBundleAssets(
        result.compilation.bundle,
        { hero: { path: "expected.png", sha256: sha256Text("same bytes") } },
        { hero: { real_path: foreignPath, project_root: root } }
      )).toThrow("VPD-J002");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects Windows drive and UNC escapes in the separator-aware containment helper", () => {
    expect(isProjectAssetIdentityContained("C:\\project", "C:\\project\\assets\\hero.png", win32)).toBe(true);
    expect(isProjectAssetIdentityContained("C:\\project", "C:\\project-foreign\\hero.png", win32)).toBe(false);
    expect(isProjectAssetIdentityContained("C:\\project", "D:\\project\\hero.png", win32)).toBe(false);
    expect(isProjectAssetIdentityContained("\\\\server\\share\\project", "\\\\server\\other\\hero.png", win32)).toBe(false);
  });

  it("normalizes issue paths relative to the actual video_prompt surface", () => {
    const mapped = h3IssueToProjectIssue({
      code: "VPD-T001",
      message: "timeline gap",
      severity: "error",
      path: ["video_prompt", "shots", 0, "start_ms"]
    }, 0, "video_prompt");
    expect(mapped.path).toBe("generation.requests.0.video_prompt.shots.0.start_ms");
  });

  it("does not allow an injected effective contract to bypass pinned profile truth", async () => {
    const { model, connection, route } = await realProfiles();
    const honest = createEffectiveGenerationContract({
      mode: "text-to-video",
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_profile_digest: connection.digest
    });
    expect(honest.ok).toBe(true);
    if (!honest.ok) return;
    const body = {
      ...honest.contract,
      effective: {
        ...honest.contract.effective,
        durations_ms: [16_000]
      }
    };
    const { digest: _digest, ...withoutDigest } = body;
    const injected = { ...withoutDigest, digest: sha256Canonical(withoutDigest) };
    const result = assertEffectiveGenerationContract(injected, {
      route,
      mode: "text-to-video",
      intent: "planning",
      truth: {
        model_profile: model.profile,
        model_profile_digest: model.digest,
        connection_profile: connection.profile,
        connection_profile_digest: connection.digest
      }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain("VPD-K002");
  });

  it("rejects a self-consistent caller budget object and keeps fixture loader tokens non-executable", async () => {
    const { model, connection, route } = await realProfiles();
    const honest = createEffectiveGenerationContract({
      mode: "text-to-video",
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_profile_digest: connection.digest
    });
    expect(honest.ok).toBe(true);
    if (!honest.ok) return;
    const evidenceBody = {
      schema_version: 1 as const,
      hard: { limit: 20_000, unit: "utf8-bytes" as const, source: "official-api" as const, verified_at: "2026-08-11T00:00:00Z", source_digest: sha256Text("caller-source") },
      soft: null,
      unknown: false as const,
      source_digest: sha256Text("caller-artifact"),
      source_id: "caller-artifact",
      retrieved_at: "2026-08-11T00:00:00Z",
      expires_at: "2026-12-31T00:00:00Z",
      model_profile_digest: model.digest,
      connection_profile_digest: connection.digest,
      route_digest: route.route_digest
    };
    const forgedBudget = {
      hard: evidenceBody.hard,
      soft: null,
      unknown: false,
      evidence: { ...evidenceBody, digest: sha256Canonical(evidenceBody) }
    };
    const forgedBody = {
      ...honest.contract,
      effective: { ...honest.contract.effective, prompt_budget: forgedBudget },
      freshness: { status: "fresh" as const, review_after: "2026-12-31T00:00:00Z" },
      execution: {
        status: "execution-capable" as const,
        capability_evidence: { duration: "hard" as const, aspect: "hard" as const, resolution: "hard" as const, mode: "hard" as const, reference: "hard" as const, group_speaker: "hard" as const, exact_text: "hard" as const }
      }
    };
    const { digest: _digest, ...withoutDigest } = forgedBody;
    const forged = { ...withoutDigest, digest: sha256Canonical(withoutDigest) };
    const rejected = assertEffectiveGenerationContract(forged, {
      route,
      mode: "text-to-video",
      intent: "execute",
      truth: {
        model_profile: model.profile,
        model_profile_digest: model.digest,
        connection_profile: connection.profile,
        connection_profile_digest: connection.digest
      }
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.issues.map((item) => item.code)).toContain("VPD-K003");

    const directForged = compileVideoPromptIrV2(baseV2(), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      trusted_pinned_budget_evidence: forgedBudget.evidence as never,
      intent: "execute"
    });
    expect(directForged.ok).toBe(false);
    if (!directForged.ok) expect(directForged.issues.map((item) => item.code)).toContain("VPD-K003");

    const trusted = loadPlanningOnlyPinnedPromptBudgetEvidence({
      artifactPath: join(process.cwd(), "test", "fixtures", "prompt-budget", "fixture.json"),
      route,
      model_profile_digest: model.digest,
      connection_profile_digest: connection.digest
    });
    expect(trusted).toBeDefined();
    if (!trusted) return;
    expect(Object.isFrozen(trusted)).toBe(true);
    expect(Object.isFrozen(trusted.hard)).toBe(true);
    const adapter = await loadAdapterDialectCapability("minimax", ["adapters"], { model_profile_id: "minimax-h3", provider_model: "MiniMax-H3", mode: "text-to-video" });
    expect(adapter.ok).toBe(true);
    if (!adapter.ok) return;
    const accepted = compileVideoPromptIrV2(baseV2(), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability,
      trusted_pinned_budget_evidence: trusted,
      intent: "execute"
    });
    expect(accepted.ok).toBe(false);
    if (!accepted.ok) expect(accepted.issues.map((item) => item.code)).toContain("VPD-K003");
  });
});
