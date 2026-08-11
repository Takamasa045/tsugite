import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProject } from "../src/project/loadProject.js";
import { validateProject } from "../src/project/validateProject.js";
import { createDryRun, createPlan } from "../src/orchestrator/plan.js";
import { createReviewDocument } from "../src/orchestrator/review.js";
import {
  assertCompilationBundleAssets,
  compileVideoPromptIrV2,
  createEffectiveGenerationContract,
  loadConnectionCapabilityProfile,
  loadModelPromptProfile,
  routeFromProfiles,
  type VideoPromptIrV2
} from "../src/videoPromptDirector/index.js";
import { createRouteIdentity } from "../src/videoPromptDirector/effectiveContract.js";
import { sha256Canonical, sha256Text } from "../src/integrity/canonical.js";
import { buildProgramBinding, type GenerationUnitProgramSourceV1 } from "../src/productionControl/programBinding.js";
import { createArtifactStore } from "../src/productionControl/artifactStore.js";
import { createGenerationUnit, toProgramBindingSource } from "../src/productionControl/contracts/generationUnit.js";
import { createMusicStructureContract } from "../src/productionControl/contracts/music.js";

const ZERO = "0".repeat(64);
const FIXTURE_ROOT = resolve("examples/local-fixture");

function baseV2(overrides: Partial<Record<string, unknown>> = {}): VideoPromptIrV2 {
  return {
    version: 2,
    program_kind: "standalone",
    target: {
      model_profile_id: "minimax-h3",
      mode: "text-to-video",
      duration_ms: 10_000,
      quality: "768p",
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
  } as VideoPromptIrV2;
}

function customFixtureCatalog(): object {
  return {
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
  };
}

async function writeFixtureProject(ir: VideoPromptIrV2, requestId: string): Promise<{
  root: string;
  configPath: string;
  catalogPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "tsugite-po4-audit-"));
  await mkdir(join(root, "media"), { recursive: true });
  const manifest = JSON.parse(await readFile(join(FIXTURE_ROOT, "manifest.json"), "utf8")) as Record<string, unknown>;
  (manifest.meta as Record<string, unknown>).target_duration_seconds = 72;
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  await copyFile(join(FIXTURE_ROOT, "media", "clip-001.mp4"), join(root, "media", "clip-001.mp4"));
  await copyFile(join(FIXTURE_ROOT, "media", "clip-002.mp4"), join(root, "media", "clip-002.mp4"));
  const project = {
    slug: "po4-v2-audit",
    name: "PO4 V2 audit fixture",
    run_id: "po4-v2-audit-run",
    manifest: "manifest.json",
    dist_dir: "dist",
    edit: { backend: "remotion" },
    orchestration: { mode: "active" },
    generation: {
      connection: "minimax-direct",
      adapter: "minimax",
      requests: [{
        id: requestId,
        operation: "video",
        model: "minimax-h3",
        mode: "text-to-video",
        prompt: "",
        params: {},
        video_prompt: ir
      }]
    }
  };
  const configPath = join(root, "project.yaml");
  const catalogPath = join(root, "fixture.catalog.json");
  await writeFile(configPath, JSON.stringify(project));
  await writeFile(catalogPath, JSON.stringify(customFixtureCatalog()));
  return { root, configPath, catalogPath };
}

async function realProfiles() {
  const model = await loadModelPromptProfile("minimax-h3");
  const connection = await loadConnectionCapabilityProfile("minimax-direct");
  expect(model.ok && connection.ok).toBe(true);
  if (!model.ok || !connection.ok) throw new Error("fixture profiles are unavailable");
  const selected = routeFromProfiles({
    model: "minimax-h3",
    mode: "text-to-video",
    model_profile: model.profile,
    connection_profile: connection.profile,
    model_profile_digest: model.digest,
    connection_profile_digest: connection.digest
  });
  expect(selected.ok).toBe(true);
  if (!selected.ok) throw new Error("fixture route is unavailable");
  return { model, connection, route: selected.route };
}

function sourceFor(route: ReturnType<typeof createRouteIdentity>): GenerationUnitProgramSourceV1 {
  const body = {
    schema_version: 1,
    kind: "mv-generation-unit-source",
    production_id: "production-1",
    unit_id: "mv-72s-unit-01",
    ordinal: 0,
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

describe("PO-4 independent audit reproductions", () => {
  it("accepts native V2 project YAML through load, validate, plan, review, and dry-run", async () => {
    const fixture = await writeFixtureProject(baseV2(), "native-v2");
    try {
      const loaded = await loadProject(fixture.configPath);
      expect(loaded.generation?.requests[0]?.video_prompt).toMatchObject({ version: 2 });
      const validation = await validateProject(fixture.configPath, {
        connectionCatalogPath: fixture.catalogPath,
        adapterDirs: ["adapters"]
      });
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
      const review = createReviewDocument(validation.project, validation.manifest, plan);
      expect(review).toBeDefined();
      const dryRun = createDryRun(
        validation.project,
        validation.manifest,
        validation.adapter,
        validation.analysisAdapter,
        validation.backend,
        validation.promptGuides,
        validation.audioAdapter,
        validation.generationConnection,
        validation.audioConnection,
        validation.h3_compilations,
        validation.video_prompt_plans
      );
      expect(dryRun.executed).toBe(false);
      expect(dryRun.plan.video_prompt_plans?.[0]?.compilation.lineage.workflow_id).toBe("video-prompt-v3");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a caller-expanded duration claim even after canonical digest recomputation", async () => {
    const { model, connection, route } = await realProfiles();
    const effective = createEffectiveGenerationContract({
      mode: "text-to-video",
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_profile_digest: connection.digest
    });
    expect(effective.ok).toBe(true);
    if (!effective.ok) return;
    const tamperedWithoutDigest = {
      ...effective.contract,
      effective: { ...effective.contract.effective, durations_ms: [16_000] }
    };
    const { digest: _digest, ...tamperedBody } = tamperedWithoutDigest;
    const tampered = { ...tamperedBody, digest: sha256Canonical(tamperedBody) };
    const result = compileVideoPromptIrV2(baseV2({
      target: { model_profile_id: "minimax-h3", mode: "text-to-video", duration_ms: 16_000, quality: "768p", aspect: "16:9", audio: false },
      shots: [{ ...baseV2().shots[0]!, end_ms: 16_000 }]
    }), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      effective_contract: tampered as never
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain("VPD-K002");
  });

  it("rejects an unknown route adapter instead of falling back to fixed H3 labels", () => {
    const route = createRouteIdentity({
      ir_model: "minimax-h3",
      provider_model: "minimax-h3",
      model_profile_digest: ZERO,
      connection_id: "fixture-connection",
      connection_digest: ZERO,
      adapter_id: "unknown-dialect",
      transport: "manual",
      mode_binding: "text-to-video"
    });
    const result = compileVideoPromptIrV2(baseV2(), { route });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain("VPD-R002");
  });

  it("keeps persisted bundle asset lineage relative and leaves real paths in runtime-only evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-bundle-"));
    try {
      const realPath = join(root, "assets", "hero.png");
      const result = compileVideoPromptIrV2(baseV2({
        target: { model_profile_id: "minimax-h3", mode: "reference", duration_ms: 10_000, quality: "768p", aspect: "16:9", audio: false },
        assets: [{ id: "hero", type: "image", path: "assets/hero.png", role: "subject_reference", sha256: ZERO }]
      }), {
        route: createRouteIdentity({
          ir_model: "minimax-h3", provider_model: "minimax-h3", model_profile_digest: ZERO,
          connection_id: "fixture-connection", connection_digest: ZERO, adapter_id: "fixture-adapter",
          transport: "manual", mode_binding: "reference"
        }),
        asset_evidence: {
          hero: {
            source: "project-bytes", real_path: realPath, sha256: ZERO, byte_size: 0,
            regular_file: true, contained_in_project_root: true
          }
        }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const serialized = JSON.stringify(result.compilation.bundle);
      expect(serialized).not.toContain("real_path");
      expect(serialized).not.toContain(realPath);
      expect(result.compilation.bundle.asset_lineage[0]?.path).toBe("assets/hero.png");
      expect(() => assertCompilationBundleAssets(result.compilation.bundle, {
        hero: { path: "assets/hero.png", sha256: ZERO }
      })).toThrow("runtime asset evidence");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves typed MV source at the actual project entrypoint and carries full binding lineage", async () => {
    const { route } = await realProfiles();
    const music = createMusicStructureContract({
      contract_id: "music-1", revision: 1,
      master_audio: { asset_id: "master-audio", sha256: sha256Text("master-audio"), duration_ms: 72_000 },
      analysis: { status: "imported" }, tempo_map: [], beat_markers: [], sections: [], section_policy: { gaps: "allow", overlaps: "forbid" }
    });
    const unit = createGenerationUnit({ production_id: "production-1", unit_id: "mv-72s-unit-01", ordinal: 0, music, start_ms: 0, end_ms: 10_000, audio_policy: "reuse-master", route });
    const source = toProgramBindingSource(unit);
    const ir = baseV2({
      program_kind: "mv",
      program_binding: buildProgramBinding(source),
      target: { model_profile_id: "minimax-h3", mode: "text-to-video", duration_ms: 10_000, quality: "768p", aspect: "16:9", audio: false }
    });
    const fixture = await writeFixtureProject(ir, "mv-72s-unit-01");
    try {
      const withoutSource = await validateProject(fixture.configPath, {
        connectionCatalogPath: fixture.catalogPath,
        adapterDirs: ["adapters"]
      });
      expect(withoutSource.ok).toBe(false);
      expect(withoutSource.issues.map((item) => item.code)).toContain("VPD-U001");

      await mkdir(join(fixture.root, "production-control"), { recursive: true });
      const store = await createArtifactStore(join(await realpath(fixture.root), "production-control"));
      await store.create({ artifact_id: music.contract_id, bytes: JSON.stringify(music) });
      await store.create({ artifact_id: unit.unit_id, bytes: JSON.stringify(unit) });
      const project = JSON.parse(await readFile(fixture.configPath, "utf8")) as Record<string, any>;
      project.orchestration.authoring = {
        music: { kind: "music-contract", id: music.contract_id, digest: music.digest },
        generation_units: [{ kind: "mv-generation-unit", id: unit.unit_id, digest: unit.digest }]
      };
      project.generation.requests[0].video_prompt.program_binding = buildProgramBinding(source);
      await writeFile(fixture.configPath, JSON.stringify(project));
      const withSource = await validateProject(fixture.configPath, {
        connectionCatalogPath: fixture.catalogPath,
        adapterDirs: ["adapters"]
      });
      expect(withSource.ok).toBe(true);
      if (!withSource.ok) return;
      const plan = createPlan(
        withSource.project,
        withSource.manifest,
        withSource.adapter,
        withSource.analysisAdapter,
        withSource.promptGuides,
        withSource.audioAdapter,
        withSource.generationConnection,
        withSource.audioConnection,
        withSource.backend,
        withSource.h3_compilations,
        withSource.video_prompt_plans
      );
      const mvCompilation = plan.video_prompt_plans?.[0]?.v2_compilation;
      expect(mvCompilation?.program_binding).toBeUndefined();
      expect(mvCompilation?.bundle.program_binding).toEqual(ir.program_binding);
      expect(mvCompilation?.route).toEqual(route);
      expect(createReviewDocument(withSource.project, withSource.manifest, plan)).toBeDefined();
      expect(createDryRun(
        withSource.project,
        withSource.manifest,
        withSource.adapter,
        withSource.analysisAdapter,
        withSource.backend,
        withSource.promptGuides,
        withSource.audioAdapter,
        withSource.generationConnection,
        withSource.audioConnection,
        withSource.h3_compilations,
        withSource.video_prompt_plans
      ).executed).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not erase unrelated issues when route validation is optional", () => {
    const result = compileVideoPromptIrV2(baseV2({
      shots: [{ ...baseV2().shots[0]!, start_ms: 100 }]
    }), { require_route: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.code)).toContain("VPD-T001");
      expect(result.issues.map((item) => item.code)).not.toContain("VPD-R001");
    }
  });

  it("returns video_prompt as the issue surface for V2 project compilation", async () => {
    const fixture = await writeFixtureProject(baseV2({
      shots: [{ ...baseV2().shots[0]!, start_ms: 100 }]
    }), "issue-surface");
    try {
      const validation = await validateProject(fixture.configPath, {
        connectionCatalogPath: fixture.catalogPath,
        adapterDirs: ["adapters"]
      });
      expect(validation.ok).toBe(false);
      expect(validation.issues.some((item) => item.path?.includes(".video_prompt"))).toBe(true);
      expect(validation.issues.some((item) => item.path?.includes(".h3"))).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
