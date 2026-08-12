import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/productionControl/artifactStore.js";
import {
  compileProjectVideoPrompts,
  compileVideoPromptRequest,
  compileVideoPromptIrV2,
  buildSemanticBlocks,
  DEFAULT_H3_GRAMMAR_PROFILE_V3,
  loadAdapterDialectCapability,
  loadConnectionCapabilityProfile,
  resolveConnectionPinPath,
  verifyConnectionPinFile,
  loadModelPromptProfile,
  loadPinnedH3GrammarProfile,
  isTrustedH3GrammarProfile,
  routeFromProfiles,
  writeCompilationBundleAtomic,
  readCompilationBundleAtomic,
  compilationRevisionId,
  writeShadowComparisonAtomic,
  isProjectAssetIdentityContained,
  verifyCompilationBundle,
  buildAdapterLabelMap,
  compileAdapterDialect,
  validateAdapterDialect,
  resolveRendererDialectCapability,
  resolveExactModelRoute,
  resolveExactModelRouteForMode,
  createExecutionSubmissionLease,
  consumeExecutionSubmissionLease,
  type VideoPromptIrV2
} from "../src/videoPromptDirector/index.js";
import { validateProject } from "../src/project/validateProject.js";
import { createVideoPromptReviewProjection, inspectGate1Review, writeCreativeReview } from "../src/orchestrator/review.js";
import { createPlan } from "../src/orchestrator/plan.js";
import { sha256Canonical, sha256Text } from "../src/integrity/canonical.js";
import { createAssetContract } from "../src/productionControl/contracts/asset.js";
import { createCompilationBundle, createVerifiedAssetPin, verifyVerifiedAssetPin, isTrustedAssetPin, loadCreateOnlyArtifactStoreEnvelope, persistPlanningCompilationArtifact, loadPlanningArtifactRef } from "../src/videoPromptDirector/compilationBundle.js";
import * as generationUnitResolver from "../src/videoPromptDirector/generationUnitSourceResolver.js";
import * as videoPromptDirector from "../src/videoPromptDirector/index.js";
import {
  isExecutionAuthoritativePinnedPromptBudgetEvidence,
  isTrustedPinnedPromptBudgetEvidence,
  loadPlanningOnlyPinnedPromptBudgetEvidence
} from "../src/videoPromptDirector/promptBudgetEvidence.js";

function standalone(model = "v6"): VideoPromptIrV2 {
  return {
    version: 2,
    program_kind: "standalone",
    target: { model_profile_id: model, mode: "text-to-video", duration_ms: 10_000, quality: "720p", aspect: "16:9", audio: false },
    creative: { must_include: [], prohibited: [] },
    subjects: [],
    scenes: [],
    assets: [],
    shots: [{
      id: "shot-1",
      start_ms: 0,
      end_ms: 10_000,
      cast: [],
      composition: "wide shot",
      action_beats: [{ description: "A lantern turns toward the camera." }],
      vocal_events: [],
      visible_text_events: [],
      constraints: { positive: [], exact_text_refs: [] }
    }],
    audio: { policy: "silent", reference_asset_ids: [], final_mix: "discard-generated" }
  };
}

async function v6Route() {
  const [model, connection, adapter] = await Promise.all([
    loadModelPromptProfile("v6"),
    loadConnectionCapabilityProfile("pixverse"),
    loadAdapterDialectCapability("pixverse", ["adapters"], { model_profile_id: "v6", provider_model: "v6", mode: "text-to-video" })
  ]);
  if (!model.ok || !connection.ok || !adapter.ok) throw new Error("fixture route unavailable");
  const route = routeFromProfiles({ model: "v6", mode: "text-to-video", model_profile: model.profile, connection_profile: connection.profile, model_profile_digest: model.digest, connection_profile_digest: connection.digest });
  if (!route.ok) throw new Error("fixture route unavailable");
  return { model, connection, adapter, route: route.route };
}

describe("PO-4 final repair regressions", () => {
  it("rejects an active video operation whose declared output kind is image before adapter resolution", async () => {
    const project = {
      slug: "active-output-kind-mismatch",
      name: "active-output-kind-mismatch",
      manifest: "manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      orchestration: { mode: "active" },
      generation: {
        connection: "pixverse",
        adapter: "pixverse",
        requests: [{
          id: "mismatch-1",
          operation: "video",
          output_kind: "image",
          prompt: "raw prompt must not reach an adapter",
          params: {}
        }]
      }
    } as never;
    const result = await compileProjectVideoPrompts(project);
    expect(result.ok).toBe(false);
    expect(result.plans).toHaveLength(0);
    expect(result.issues.map((item) => item.code)).toContain("VPD-E022");
  });

  it("rejects active asset-bearing authoring when the authoritative contract resolver fails", async () => {
    const ir = standalone();
    ir.target.mode = "reference";
    ir.assets = [{ id: "ref-1", type: "image", role: "subject_reference", path: "assets/ref.png", sha256: "1".repeat(64) }];
    const result = await compileVideoPromptRequest(
      { id: "asset-1", operation: "video", prompt: "", params: {}, video_prompt: ir } as never,
      ir,
      {
        connectionId: "pixverse",
        intent: "planning",
        activeV2: true,
        modelProfileRoots: ["profiles/model-prompts"],
        connectionProfileRoots: ["profiles/connection-capabilities"],
        adapterDirs: ["adapters"]
      }
    );
    expect(result.ok).toBe(false);
    expect(result.plan).toBeUndefined();
    expect(result.issues.map((item) => item.code)).toContain("VPD-J002");
  });

  it("rejects an active project asset reference during validate before creating a planning bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-validate-asset-ref-"));
    try {
      const sourceProject = await readFile("examples/h3-prompt-director/project.yaml", "utf8");
      const activeProject = sourceProject.replace(
        "edit:\n",
        "orchestration:\n  mode: active\n  authoring:\n    assets:\n      kind: asset-contract\n      id: missing-asset-contract\n      digest: " + "f".repeat(64) + "\nedit:\n"
      );
      const configPath = join(root, "project.yaml");
      await writeFile(configPath, activeProject);
      await writeFile(join(root, "manifest.json"), await readFile("examples/h3-prompt-director/manifest.json", "utf8"));
      await mkdir(join(root, "media"));
      await copyFile("examples/h3-prompt-director/media/clip-001.mp4", join(root, "media/clip-001.mp4"));
      const result = await validateProject(configPath);
      expect(result.ok).toBe(false);
      expect(result.issues.map((issue) => issue.code)).toContain("VPD-J002");
      await expect(stat(join(root, "production-control", "video-prompt-planning"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds the exact H3 versus video_prompt authoring surface into review projection", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const h3 = compileVideoPromptIrV2(standalone(), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability,
      source: { authoring_surface: "h3", authoring_schema: "VideoPromptIrV2", upgrader_version: "native-v2", source_digest: sha256Canonical(standalone()) }
    });
    const v2 = compileVideoPromptIrV2(standalone(), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(h3.ok).toBe(true);
    expect(v2.ok).toBe(true);
    if (!h3.ok || !v2.ok) return;
    expect(createVideoPromptReviewProjection([{ v2_compilation: h3.compilation } as never])[0]?.request_identity.authoring_surface).toBe("h3");
    expect(createVideoPromptReviewProjection([{ v2_compilation: v2.compilation } as never])[0]?.request_identity.authoring_surface).toBe("video_prompt");
  });

  it("keeps disabled legacy validation read-only and creates no production-control planning store", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-disabled-readonly-"));
    try {
      await writeFile(join(root, "project.yaml"), await readFile("examples/h3-prompt-director/project.yaml", "utf8"));
      await writeFile(join(root, "manifest.json"), await readFile("examples/h3-prompt-director/manifest.json", "utf8"));
      await mkdir(join(root, "media"));
      await copyFile("examples/h3-prompt-director/media/clip-001.mp4", join(root, "media/clip-001.mp4"));
      const result = await validateProject(join(root, "project.yaml"));
      expect(result.ok).toBe(true);
      await expect(stat(join(root, "production-control"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(root, "dist"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("commits the active validate entrypoint to one project-local planning ArtifactStore", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-active-planning-entrypoint-"));
    try {
      const sourceProject = await readFile("examples/h3-prompt-director/project.yaml", "utf8");
      const activeProject = sourceProject.replace("edit:\n", "orchestration:\n  mode: active\nedit:\n");
      await writeFile(join(root, "project.yaml"), activeProject);
      await writeFile(join(root, "manifest.json"), await readFile("examples/h3-prompt-director/manifest.json", "utf8"));
      await mkdir(join(root, "media"));
      await copyFile("examples/h3-prompt-director/media/clip-001.mp4", join(root, "media/clip-001.mp4"));

      const result = await validateProject(join(root, "project.yaml"));
      expect(result.ok, result.ok ? "" : JSON.stringify(result.issues)).toBe(true);
      if (!result.ok) return;
      const planning = result.video_prompt_plans?.[0]?.v2_compilation?.planning_artifact;
      expect(planning).toMatchObject({ kind: "video-prompt-planning-artifact-ref", production_id: "production" });
      const artifacts = await readdir(join(root, "production-control", "video-prompt-planning", "artifacts"));
      expect(artifacts).toContain(`${(planning as { artifact_id: string }).artifact_id}.json`);
      await expect(stat(join(root, "dist"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reviews the committed planning artifact through the real validate-plan-review lifecycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-planning-review-lifecycle-"));
    try {
      const sourceProject = await readFile("examples/h3-prompt-director/project.yaml", "utf8");
      await writeFile(join(root, "project.yaml"), sourceProject.replace("edit:\n", "orchestration:\n  mode: active\nedit:\n"));
      await writeFile(join(root, "manifest.json"), await readFile("examples/h3-prompt-director/manifest.json", "utf8"));
      await mkdir(join(root, "media"));
      await copyFile("examples/h3-prompt-director/media/clip-001.mp4", join(root, "media/clip-001.mp4"));

      const validation = await validateProject(join(root, "project.yaml"));
      expect(validation.ok, validation.ok ? "" : JSON.stringify(validation.issues)).toBe(true);
      if (!validation.ok) return;
      const plan = createPlan(
        validation.project,
        validation.manifest,
        validation.adapter,
        undefined,
        validation.promptGuides,
        validation.audioAdapter,
        validation.generationConnection,
        validation.audioConnection,
        validation.backend,
        validation.h3_compilations,
        validation.video_prompt_plans
      );
      const stateDir = join(root, "dist");
      await writeCreativeReview({
        configPath: join(root, "project.yaml"),
        project: validation.project,
        manifest: validation.manifest,
        plan,
        stateDir
      });
      const reviewed = await inspectGate1Review({
        configPath: join(root, "project.yaml"),
        project: validation.project,
        manifest: validation.manifest,
        stateDir
      });
      expect(reviewed.ok, reviewed.ok ? "" : JSON.stringify(reviewed.issues)).toBe(true);

      const artifactsDir = join(root, "production-control", "video-prompt-planning", "artifacts");
      const [artifactName] = await readdir(artifactsDir);
      await writeFile(join(artifactsDir, artifactName!), "tampered\n");
      const tampered = await inspectGate1Review({
        configPath: join(root, "project.yaml"),
        project: validation.project,
        manifest: validation.manifest,
        stateDir
      });
      expect(tampered.ok).toBe(false);
      expect(tampered.issues.map((issue) => issue.code)).toContain("gate.video_prompt_changed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails review closed when the active planning namespace is absent or contains unsafe copies", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-planning-missing-review-"));
    try {
      const sourceProject = await readFile("examples/h3-prompt-director/project.yaml", "utf8");
      const configPath = join(root, "project.yaml");
      await writeFile(configPath, sourceProject.replace("edit:\n", "orchestration:\n  mode: active\nedit:\n"));
      await writeFile(join(root, "manifest.json"), await readFile("examples/h3-prompt-director/manifest.json", "utf8"));
      await mkdir(join(root, "media"));
      await copyFile("examples/h3-prompt-director/media/clip-001.mp4", join(root, "media/clip-001.mp4"));
      const validation = await validateProject(configPath);
      expect(validation.ok).toBe(true);
      if (!validation.ok) return;
      await rm(join(root, "production-control"), { recursive: true, force: true });
      const plan = createPlan(validation.project, validation.manifest, validation.adapter, undefined, validation.promptGuides, validation.audioAdapter, validation.generationConnection, validation.audioConnection, validation.backend, validation.h3_compilations, validation.video_prompt_plans);
      const stateDir = join(root, "review-state");
      await writeCreativeReview({ configPath, project: validation.project, manifest: validation.manifest, plan, stateDir });
      const missing = await inspectGate1Review({ configPath, project: validation.project, manifest: validation.manifest, stateDir });
      expect(missing.ok).toBe(false);
      expect(missing.issues.map((issue) => issue.code)).toContain("gate.video_prompt_changed");

      const planningRoot = join(root, "production-control", "video-prompt-planning");
      await mkdir(join(planningRoot, "artifacts"), { recursive: true });
      await writeFile(join(planningRoot, "artifacts", "unsafe name.json"), "not a planning artifact\n");
      await mkdir(join(planningRoot, "artifacts", "directory.json"));
      const { model, connection, adapter, route } = await v6Route();
      const unrelated = compileVideoPromptIrV2(standalone("v6"), {
        request_id: "different-request",
        route,
        model_profile: model.profile,
        model_profile_digest: model.digest,
        connection_profile: connection.profile,
        connection_capability_digest: connection.digest,
        adapter_dialect_capability: adapter.capability
      });
      expect(unrelated.ok).toBe(true);
      if (!unrelated.ok) return;
      const unrelatedId = `planning-production-${validation.project.slug}-${compilationRevisionId(unrelated.compilation.bundle)}-different-request`;
      await writeFile(join(planningRoot, "artifacts", `${unrelatedId}.json`), JSON.stringify(unrelated.compilation.bundle));
      const stillClosed = await inspectGate1Review({ configPath, project: validation.project, manifest: validation.manifest, stateDir });
      expect(stillClosed.ok).toBe(false);
      expect(stillClosed.issues.map((issue) => issue.code)).toContain("gate.video_prompt_changed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let active legacy H3 silently pass without an explicit connection", async () => {
    const project = {
      slug: "active-no-connection",
      name: "active-no-connection",
      manifest: "manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      orchestration: { mode: "active" },
      generation: {
        adapter: "pixverse",
        requests: [{ id: "legacy-1", prompt: "", params: {}, h3: standalone("v6") }]
      }
    } as never;
    const result = await compileProjectVideoPrompts(project);
    expect(result.ok).toBe(false);
    expect(result.issues.map((item) => item.code)).toContain("VPD-E022");
  });

  it("fails closed before any adapter boundary for active video prompt-only authoring", async () => {
    const project = {
      slug: "active-raw-video",
      name: "active-raw-video",
      manifest: "manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      orchestration: { mode: "active" },
      generation: {
        connection: "pixverse",
        adapter: "pixverse",
        requests: [{ id: "raw-video", operation: "video", prompt: "raw caller prompt", params: {} }]
      }
    } as never;
    const result = await compileProjectVideoPrompts(project);
    expect(result.ok).toBe(false);
    expect(result.plans).toHaveLength(0);
    expect(result.issues.map((item) => item.code)).toContain("VPD-E022");
  });

  it("does not infer video authority from an omitted operation when output_kind is image", async () => {
    const project = {
      slug: "active-omitted-operation-image",
      name: "active-omitted-operation-image",
      manifest: "manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      orchestration: { mode: "active" },
      generation: {
        connection: "pixverse",
        adapter: "pixverse",
        requests: [{
          id: "raw-ambiguous",
          output_kind: "image",
          prompt: "raw prompt must never reach an adapter",
          params: {}
        }]
      }
    } as never;
    const result = await compileProjectVideoPrompts(project);
    expect(result.ok).toBe(false);
    expect(result.plans).toHaveLength(0);
    expect(result.issues.map((item) => item.code)).toContain("VPD-E022");
  });

  it("rejects provider-impact params on the active legacy H3 to V2 boundary", async () => {
    const legacy = JSON.parse(await readFile("test/fixtures/h3/t2v.json", "utf8"));
    const project = {
      slug: "active-legacy-params",
      name: "active-legacy-params",
      manifest: "manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      orchestration: { mode: "active" },
      generation: {
        connection: "minimax-direct",
        adapter: "minimax",
        requests: [{ id: "legacy-params-1", prompt: "", h3: legacy, params: { image: "caller-controlled.png" } }]
      }
    } as never;
    const result = await compileProjectVideoPrompts(project);
    expect(result.ok).toBe(false);
    expect(result.plans).toHaveLength(0);
    expect(result.issues.map((item) => item.code)).toContain("VPD-E033");
  });

  it("uses the repo-local AssetContract resolver for standalone planning and rejects path substitution", async () => {
    const raw = await mkdtemp(join(tmpdir(), "tsugite-po4-standalone-assets-"));
    const root = await realpath(raw);
    try {
      const bytes = Buffer.from("authoritative-asset\n", "utf8");
      const mediaDir = join(root, "media");
      await mkdir(mediaDir);
      await writeFile(join(mediaDir, "reference.bin"), bytes);
      const contract = createAssetContract({
        contract_id: "standalone-assets",
        revision: 1,
        assets: [{
          asset_id: "reference",
          kind: "image",
          project_relative_path: "media/reference.bin",
          sha256: sha256Text(bytes.toString("utf8")),
          byte_size: bytes.byteLength,
          roles: ["subject-reference"],
          provenance: { source: "user", usage_confirmed: true },
          external_send: "allowed"
        }]
      });
      const storeRoot = join(root, "production-control");
      await mkdir(storeRoot);
      const store = new ArtifactStore(await realpath(storeRoot));
      await store.create({ artifact_id: "standalone-assets", bytes: JSON.stringify(contract) });
      const videoRequest = {
        id: "standalone-asset-request",
        prompt: "",
        params: {},
        video_prompt: standalone("v6")
      };
      const project = {
        slug: "standalone-assets-project",
        name: "standalone-assets-project",
        manifest: "manifest.json",
        dist_dir: "dist",
        edit: { backend: "remotion" },
        orchestration: {
          mode: "active",
          authoring: { assets: { kind: "asset-contract", id: "standalone-assets", digest: contract.digest } }
        },
        generation: {
          connection: "pixverse",
          adapter: "pixverse",
          requests: [videoRequest]
        }
      } as never;
      const resolution = await generationUnitResolver.resolveProjectAssetContract(join(root, "project.yaml"), project);
      expect(resolution).toBeDefined();
      if (!resolution) return;
      await expect(generationUnitResolver.reloadAuthoritativeAssetContract(resolution)).resolves.toEqual(contract);
      await expect(generationUnitResolver.reloadAuthoritativeAssetContract({ ...resolution })).rejects.toThrow(/resolver token is not authoritative/);
      const ir = standalone("v6");
      ir.target = { ...ir.target, mode: "first-frame" };
      ir.assets = [{ id: "reference", type: "image", path: "media/reference.bin", role: "first_frame", sha256: contract.assets[0]!.sha256 }];
      videoRequest.video_prompt = ir;
      const result = await compileProjectVideoPrompts(project, { assetContractResolution: resolution } as never);
      expect(result.ok, JSON.stringify(result.issues)).toBe(true);
      expect(result.plans[0]?.v2_compilation?.bundle.asset_lineage[0]?.asset_contract?.digest).toBe(contract.digest);
      expect(result.plans[0]?.v2_compilation?.bundle.lineage.contract_bindings).toContain(contract.digest);

      const substituted = { ...ir, assets: [{ ...ir.assets[0]!, path: "media/other.bin" }] };
      videoRequest.video_prompt = substituted;
      const rejected = await compileProjectVideoPrompts(project, { assetContractResolution: resolution } as never);
      expect(rejected.ok).toBe(false);
      expect(rejected.issues.map((item) => item.code)).toContain("VPD-J002");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("revalidates AssetContract lineage through the committed active review lifecycle", async () => {
    const raw = await mkdtemp(join(tmpdir(), "tsugite-po4-review-assets-"));
    const root = await realpath(raw);
    try {
      const bytes = Buffer.from("review-authoritative-asset\n", "utf8");
      await mkdir(join(root, "media"));
      await writeFile(join(root, "media", "reference.bin"), bytes);
      await copyFile("examples/h3-prompt-director/media/clip-001.mp4", join(root, "media", "clip-001.mp4"));
      const contract = createAssetContract({
        contract_id: "review-assets",
        revision: 1,
        assets: [{
          asset_id: "reference",
          kind: "image",
          project_relative_path: "media/reference.bin",
          sha256: sha256Text(bytes.toString("utf8")),
          byte_size: bytes.byteLength,
          roles: ["first-frame"],
          provenance: { source: "user", usage_confirmed: true },
          external_send: "allowed"
        }]
      });
      await mkdir(join(root, "production-control"));
      const store = new ArtifactStore(join(root, "production-control"));
      await store.create({ artifact_id: contract.contract_id, bytes: JSON.stringify(contract) });
      const ir = standalone("v6");
      ir.target = { ...ir.target, mode: "first-frame" };
      ir.assets = [{ id: "reference", type: "image", path: "media/reference.bin", role: "first_frame", sha256: contract.assets[0]!.sha256 }];
      const configPath = join(root, "project.yaml");
      await writeFile(configPath, JSON.stringify({
        slug: "review-assets",
        name: "review-assets",
        manifest: "manifest.json",
        dist_dir: "dist",
        edit: { backend: "remotion" },
        orchestration: { mode: "active", authoring: { assets: { kind: "asset-contract", id: contract.contract_id, digest: contract.digest } } },
        generation: { connection: "pixverse", adapter: "pixverse", requests: [{ id: "asset-review-1", prompt: "", params: {}, video_prompt: ir }] }
      }));
      await writeFile(join(root, "manifest.json"), await readFile("examples/h3-prompt-director/manifest.json", "utf8"));
      const validation = await validateProject(configPath);
      expect(validation.ok, validation.ok ? "" : JSON.stringify(validation.issues)).toBe(true);
      if (!validation.ok) return;
      const plan = createPlan(validation.project, validation.manifest, validation.adapter, undefined, validation.promptGuides, validation.audioAdapter, validation.generationConnection, validation.audioConnection, validation.backend, validation.h3_compilations, validation.video_prompt_plans);
      const stateDir = join(root, "review-state");
      await writeCreativeReview({ configPath, project: validation.project, manifest: validation.manifest, plan, stateDir });
      const initial = await inspectGate1Review({ configPath, project: validation.project, manifest: validation.manifest, stateDir });
      expect(initial.ok, initial.ok ? "" : JSON.stringify(initial.issues)).toBe(true);

      const changed = createAssetContract({
        contract_id: contract.contract_id,
        revision: 2,
        assets: [{ ...contract.assets[0]!, external_send: "needs-human" }]
      });
      await writeFile(join(root, "production-control", "artifacts", `${contract.contract_id}.json`), JSON.stringify(changed));
      const stale = await inspectGate1Review({ configPath, project: validation.project, manifest: validation.manifest, stateDir });
      expect(stale.ok).toBe(false);
      expect(stale.issues.map((issue) => issue.code)).toContain("VPD-J002");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat an omitted operation plus image output as a non-video bypass", async () => {
    const project = {
      slug: "active-omitted-operation-image",
      name: "active-omitted-operation-image",
      manifest: "manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      orchestration: { mode: "active" },
      generation: {
        connection: "pixverse",
        adapter: "pixverse",
        requests: [{
          id: "omitted-operation-image",
          output_kind: "image",
          prompt: "raw prompt must not reach an adapter",
          params: {}
        }]
      }
    } as never;
    const result = await compileProjectVideoPrompts(project);
    expect(result.ok).toBe(false);
    expect(result.plans).toHaveLength(0);
    expect(result.issues.map((item) => item.code)).toContain("VPD-E022");
  });

  it("does not expose a mutable lyrics source getter from the public resolver boundary", async () => {
    expect("lyricsSourceForGenerationUnitSource" in generationUnitResolver).toBe(false);
    expect("materializeGenerationUnitLyrics" in generationUnitResolver).toBe(false);
  });

  it("does not expose low-level execution authority constructors through the public VPD surface", () => {
    expect("createExecutionCompilationBundleArtifact" in videoPromptDirector).toBe(false);
    expect("adoptExecutionCompilationBundle" in videoPromptDirector).toBe(false);
  });

  it("uses the pinned repo grammar in the project entrypoint and rejects a missing profile root", async () => {
    expect(isTrustedH3GrammarProfile(DEFAULT_H3_GRAMMAR_PROFILE_V3)).toBe(false);
    expect(isTrustedH3GrammarProfile(await loadPinnedH3GrammarProfile())).toBe(true);
    const project = {
      slug: "grammar-entrypoint",
      name: "grammar-entrypoint",
      manifest: "manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      orchestration: { mode: "active" },
      generation: { connection: "pixverse", adapter: "pixverse", requests: [{ id: "v6-1", prompt: "", params: {}, video_prompt: standalone("v6") }] }
    } as never;
    const result = await compileProjectVideoPrompts(project, { grammarProfileRoot: join(tmpdir(), "missing-po4-grammar") } as never);
    expect(result.ok).toBe(false);
    expect(result.issues.map((item) => item.code)).toContain("VPD-C003");
  });

  it("rejects malformed and stale pinned grammar provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-grammar-tamper-"));
    try {
      const profileRoot = join(root, "profiles");
      await mkdir(profileRoot);
      const yaml = await readFile("profiles/grammar/h3-v3.yaml", "utf8");
      await writeFile(join(profileRoot, "h3-v3.yaml"), yaml.replace("source_commit: h3-grammar-v3-official-pinned-2026-08-08", "source_commit: forged").replace("digest: e725e8b2135108c27122a110c6f690f9f4beaa3d501b4731dcbfd2414f89ab43", `digest: ${"0".repeat(64)}`));
      await expect(loadPinnedH3GrammarProfile(profileRoot)).rejects.toThrow("VPD-C003");
      await writeFile(join(profileRoot, "h3-v3.yaml"), "features:\n  scenetrans: true\n");
      await expect(loadPinnedH3GrammarProfile(profileRoot)).rejects.toThrow("VPD-C003");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("generates shadow V2 comparison evidence without changing legacy authority", async () => {
    const request = { id: "shadow-1", prompt: "", params: {}, h3: standalone("v6") };
    const project = {
      slug: "shadow-entrypoint",
      name: "shadow-entrypoint",
      manifest: "manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      orchestration: { mode: "shadow" },
      generation: { connection: "pixverse", adapter: "pixverse", requests: [request] }
    } as never;
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-shadow-"));
    try {
      const result = await compileProjectVideoPrompts(project, { shadowArtifactRoot: join(root, "shadow") });
      expect(result.ok).toBe(true);
      expect(result.plans).toHaveLength(0);
      expect(result.shadow_comparisons?.[0]?.authoritative).toBe("legacy");
      expect(result.project.generation?.requests[0]).toEqual(request);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists the bundle as a durable directory with a final manifest commit marker", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalone(), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-bundle-"));
    try {
      const revision = compilationRevisionId(compiled.compilation.bundle);
      const target = join(root, revision, "video-prompt", compiled.compilation.bundle.request_id);
      await writeCompilationBundleAtomic(root, compiled.compilation.bundle, { project_root: root, revision_id: revision, request_id: compiled.compilation.bundle.request_id });
      expect((await stat(target)).isDirectory()).toBe(true);
      const marker = JSON.parse(await readFile(join(target, "compilation-manifest.json"), "utf8")) as { compilation_digest: string };
      expect(marker.compilation_digest).toBe(compiled.compilation.bundle.compilation_digest);
      for (const file of ["ir.normalized.json", "semantic-blocks.json", "labels.json", "prompt.canonical.txt", "prompt.pixverse.txt"]) {
        expect((await stat(join(target, file))).isFile(), file).toBe(true);
      }
      const persisted = JSON.parse(await readFile(join(target, "bundle.json"), "utf8")) as Record<string, unknown>;
      await writeFile(join(target, "bundle.json"), JSON.stringify({ ...persisted, canonical_prompt: "tampered" }));
      await expect(writeCompilationBundleAtomic(root, compiled.compilation.bundle, { project_root: root, revision_id: revision, request_id: compiled.compilation.bundle.request_id, allow_existing_same_digest: true })).rejects.toThrow(/VPD-K002/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("strictly binds persisted marker identity and rejects unexpected artifact leaves", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalone(), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-manifest-identity-"));
    try {
      const options = { project_root: root, revision_id: compilationRevisionId(compiled.compilation.bundle), request_id: compiled.compilation.bundle.request_id };
      await writeCompilationBundleAtomic(root, compiled.compilation.bundle, options);
      const target = join(root, options.revision_id, "video-prompt", compiled.compilation.bundle.request_id);
      const marker = JSON.parse(await readFile(join(target, "compilation-manifest.json"), "utf8")) as Record<string, unknown>;
      await writeFile(join(target, "compilation-manifest.json"), JSON.stringify({ ...marker, revision_id: "revision-2" }));
      expect(() => readCompilationBundleAtomic(target, { ...options })).toThrow(/VPD-K002/);
      await writeFile(join(target, "compilation-manifest.json"), JSON.stringify(marker));
      for (const file of [
        "ir.normalized.json",
        "effective-contract.json",
        "semantic-blocks.json",
        "prompt.canonical.txt",
        `prompt.${compiled.compilation.bundle.route.adapter_id}.txt`,
        "labels.json",
        "validation.json",
        "route.json",
        "lineage.json",
        "bundle.json"
      ]) {
        const original = await readFile(join(target, file));
        await writeFile(join(target, file), "tampered\n");
        expect(() => readCompilationBundleAtomic(target, { ...options })).toThrow(/VPD-K002/);
        await writeFile(join(target, file), original);
      }
      await writeFile(join(target, "unexpected.json"), "unexpected\n");
      expect(() => readCompilationBundleAtomic(target, { ...options })).toThrow(/VPD-K002/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses revision/request placement and rejects an existing same-request artifact from another revision", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalone(), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-revision-"));
    try {
      const revision = compilationRevisionId(compiled.compilation.bundle);
      await writeCompilationBundleAtomic(root, compiled.compilation.bundle, {
        project_root: root,
        revision_id: revision,
        request_id: compiled.compilation.bundle.request_id,
        allow_existing_same_digest: true
      });
      expect((await stat(join(root, revision, "video-prompt", compiled.compilation.bundle.request_id))).isDirectory()).toBe(true);
      await expect(writeCompilationBundleAtomic(root, compiled.compilation.bundle, {
        project_root: root,
        revision_id: "plan-2",
        request_id: compiled.compilation.bundle.request_id,
        allow_existing_same_digest: true
      })).rejects.toThrow(/digest-bound revision/);
      await writeFile(join(root, revision, "video-prompt", compiled.compilation.bundle.request_id, "prompt.canonical.txt"), "tampered\n");
      expect(() => readCompilationBundleAtomic(root, {
        project_root: root,
        revision_id: revision,
        request_id: compiled.compilation.bundle.request_id
      })).toThrow(/VPD-K002/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("separates structural bundle parsing from execution authority adoption", async () => {
    expect("createExecutionCompilationBundleArtifact" in videoPromptDirector).toBe(false);
    expect("adoptExecutionCompilationBundle" in videoPromptDirector).toBe(false);
    expect(() => createCompilationBundle({ execution_capable: true } as never)).toThrow(/cannot grant execution authority/);
    await expect(videoPromptDirector.deriveExecutionCompilationBundleFromPlanningArtifact({
      planning_bundle: {} as never
    } as never)).rejects.toThrow(/VPD-K003/);
  });

  it("derives only from the namespaced committed planning artifact and keeps fixture budget non-executable", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalone(), {
      request_id: "derive-1",
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const raw = await mkdtemp(join(tmpdir(), "tsugite-po4-derive-"));
    const root = await realpath(raw);
    try {
      const storeRoot = join(root, "production-control");
      await mkdir(storeRoot);
      const store = new ArtifactStore(await realpath(storeRoot));
      const bundle = compiled.compilation.bundle;
      const revision = compilationRevisionId(bundle);
      const artifactId = `planning-production-project-${revision}-${bundle.request_id}`;
      const trustedPlanningRef = await persistPlanningCompilationArtifact({
        store,
        bundle,
        production_id: "production",
        project_id: "project",
        revision_id: revision
      });
      const base = {
        planning_artifact: trustedPlanningRef,
        store,
        production_id: "production",
        project_id: "project",
        revision_id: revision,
        project_root: root,
        asset_pin_root: join(root, "pins"),
        model_profile: model.profile,
        connection_profile: connection.profile,
        trusted_pinned_budget_evidence: {} as never
      };
      await expect(videoPromptDirector.deriveExecutionCompilationBundleFromPlanningArtifact({
        ...base,
        planning_artifact: { ...base.planning_artifact, artifact_id: "planning-arbitrary" }
      } as never)).rejects.toThrow(/exact committed planning artifact identity/);
      await expect(videoPromptDirector.deriveExecutionCompilationBundleFromPlanningArtifact({
        ...base,
        model_profile: { ...model.profile, display_name: "caller-forged-profile" }
      } as never)).rejects.toThrow(/current model\/connection profile/);
      await expect(videoPromptDirector.deriveExecutionCompilationBundleFromPlanningArtifact({
        ...base,
        planning_artifact: { ...base.planning_artifact, artifact_digest: "0".repeat(64) }
      } as never)).rejects.toThrow(/exact committed planning artifact identity|opaque/);
      const paddedStoreRoot = join(root, "padded-store");
      await mkdir(paddedStoreRoot);
      const paddedStore = new ArtifactStore(paddedStoreRoot);
      const paddedId = artifactId;
      const padded = await paddedStore.create({ artifact_id: paddedId, bytes: ` ${JSON.stringify(bundle)} ` });
      await expect(videoPromptDirector.deriveExecutionCompilationBundleFromPlanningArtifact({
        ...base,
        store: paddedStore,
        planning_artifact: { ...base.planning_artifact, store: paddedStore, artifact_id: paddedId, artifact_digest: padded.sha256 }
      } as never)).rejects.toThrow(/exact committed planning artifact identity|opaque/);
      await expect(videoPromptDirector.deriveExecutionCompilationBundleFromPlanningArtifact({
        ...base,
        adapter_dirs: [join(root, "missing-adapters")]
      } as never)).rejects.toThrow(/adapter capability/);
      await expect(videoPromptDirector.deriveExecutionCompilationBundleFromPlanningArtifact(base as never)).rejects.toThrow(/unknown or not authoritative/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not reconstruct an execution submission lease from a JSON-shaped caller object", () => {
    expect(() => createExecutionSubmissionLease({} as never)).toThrow(/VPD-K003/);
    expect(() => consumeExecutionSubmissionLease({ kind: "video-prompt-execution-submission-lease" } as never)).toThrow(/VPD-K003/);
  });

  it("detects same-size mutation of the opaque execution pin at the submission boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-pin-"));
    try {
      const realRoot = await realpath(root);
      await mkdir(join(root, "assets"));
      await mkdir(join(root, "pins"));
      await writeFile(join(root, "assets", "voice.wav"), "AAAA");
      const pin = createVerifiedAssetPin({
        asset_id: "voice",
        project_root: realRoot,
        project_relative_path: "assets/voice.wav",
        expected_sha256: sha256Text("AAAA"),
        expected_size: 4,
        expected_real_path: await realpath(join(root, "assets", "voice.wav")),
        pin_root: join(realRoot, "pins")
      });
      expect(() => verifyVerifiedAssetPin(pin, { project_root: realRoot, pin_root: join(realRoot, "pins") })).not.toThrow();
      await writeFile(join(root, "pins", "asset-pins", "voice.bin"), "BBBB");
      expect(() => verifyVerifiedAssetPin(pin, { project_root: realRoot, pin_root: join(realRoot, "pins") })).toThrow(/VPD-J002/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps opaque pin creation bounded across digest, identity, root, and leaf failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-pin-failures-"));
    try {
      const realRoot = await realpath(root);
      await mkdir(join(root, "assets"));
      await writeFile(join(root, "assets", "voice.wav"), "AAAA");
      await mkdir(join(root, "new-pins"));
      const source = join(realRoot, "assets", "voice.wav");
      const input = {
        asset_id: "voice",
        project_root: realRoot,
        project_relative_path: "assets/voice.wav",
        expected_sha256: sha256Text("AAAA"),
        expected_size: 4,
        expected_real_path: source,
        pin_root: join(realRoot, "new-pins")
      };
      expect(() => createVerifiedAssetPin({ ...input, expected_size: 5 })).toThrow(/VPD-J002/);
      expect(() => createVerifiedAssetPin({ ...input, expected_sha256: sha256Text("BBBB"), asset_id: "wrong-digest" })).toThrow(/VPD-J002/);
      const pin = createVerifiedAssetPin(input);
      expect(isTrustedAssetPin(pin)).toBe(true);
      expect(isTrustedAssetPin({ ...pin })).toBe(false);
      expect(isProjectAssetIdentityContained(realRoot, source)).toBe(true);
      expect(isProjectAssetIdentityContained(realRoot, realRoot)).toBe(true);
      expect(isProjectAssetIdentityContained(realRoot, join(realRoot, "..", "outside"))).toBe(false);
      expect(() => createVerifiedAssetPin({ ...input, asset_id: "voice" })).toThrow(/EEXIST|VPD-J002/);
      expect(() => createVerifiedAssetPin({ ...input, pin_root: join(realRoot, "..", "outside") })).toThrow(/VPD-J002/);
      expect(() => verifyVerifiedAssetPin(pin, { project_root: realRoot, pin_root: input.pin_root, expected_sha256: sha256Text("BBBB") })).toThrow(/VPD-J002/);
      await rm(join(realRoot, "new-pins", "asset-pins", "voice.bin"));
      await symlink(source, join(realRoot, "new-pins", "asset-pins", "voice.bin"));
      expect(() => verifyVerifiedAssetPin(pin, { project_root: realRoot, pin_root: input.pin_root })).toThrow(/VPD-J002/);

      await symlink(source, join(realRoot, "assets", "source-link.wav"));
      expect(() => createVerifiedAssetPin({ ...input, project_relative_path: "assets/source-link.wav", expected_real_path: source, asset_id: "source-link" })).toThrow(/VPD-J002/);
      const linkedPinRoot = join(realRoot, "linked-pins");
      await mkdir(linkedPinRoot);
      await symlink(join(realRoot, "new-pins"), join(linkedPinRoot, "asset-pins"));
      expect(() => createVerifiedAssetPin({ ...input, pin_root: linkedPinRoot, asset_id: "linked-root" })).toThrow(/VPD-J002/);
      const filePinRoot = join(realRoot, "file-pins");
      await writeFile(filePinRoot, "not-a-directory");
      expect(() => createVerifiedAssetPin({ ...input, pin_root: filePinRoot, asset_id: "file-root" })).toThrow(/VPD-J002/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps nonzero MV lyrics timing clip-local and serializes every group singer", () => {
    const ir = standalone();
    ir.subjects = [
      { id: "subject-1", description: "a singer", speaker_id: "S1" },
      { id: "subject-2", description: "another singer", speaker_id: "S2" }
    ];
    ir.shots[0]!.vocal_events = [{
      id: "cue-1",
      kind: "singing",
      speaker_ids: ["S1", "S2"],
      language_id: "ja-JP",
      content: {
        source: "lyrics-cue",
        lyrics_contract_digest: "a".repeat(64),
        cue_id: "cue-1",
        occurrence_id: "occ-1",
        text_digest: sha256Text("歌")
      },
      start_ms: 500,
      end_ms: 1_500,
      continuity: "contained"
    }];
    const result = buildSemanticBlocks(ir, {
      require_exact_sync: true,
      lyrics_source: {
        canonical_text: "歌",
        text_digest: sha256Text("歌"),
        language_bcp47: "ja-JP",
        program_start_ms: 1_000,
        cues: [{
          cue_id: "cue-1",
          occurrence_id: "occ-1",
          timing: "timed",
          lyrics_contract_digest: "a".repeat(64),
          language_bcp47: "ja-JP",
          source_span: { start_utf8_byte: 0, end_utf8_byte: 3, text_digest: sha256Text("歌") },
          start_ms: 1_500,
          end_ms: 2_500,
          singer_ids: ["S1", "S2"],
          use: ["generated-singing"]
        }]
      }
    });
    expect(result.issues).toEqual([]);
    expect(result.blocks.find((block) => block.kind === "AUDIO_EVENTS")?.text).toContain("S1, S2");
    expect(result.blocks.find((block) => block.kind === "AUDIO_EVENTS")?.text).toContain("0.500-1.500s");
  });

  it("persists shadow digests in the isolated revision namespace", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-shadow-durable-"));
    try {
      await writeShadowComparisonAtomic(root, {
        request_id: "shadow-1",
        authoritative: "legacy",
        status: "compiled",
        legacy_canonical_prompt_digest: "1".repeat(64),
        legacy_adapter_prompt_digest: "2".repeat(64),
        v2_canonical_prompt_digest: "3".repeat(64),
        v2_adapter_prompt_digest: "4".repeat(64),
        diff: { changed: ["canonical_prompt"] },
        issues: []
      }, { project_root: root, revision_id: "plan-1" });
      const persisted = JSON.parse(await readFile(join(root, "plan-1", "video-prompt", "shadow-1", "comparison.json"), "utf8")) as Record<string, unknown>;
      expect(persisted.legacy_canonical_prompt_digest).toBe("1".repeat(64));
      expect(persisted.gate_binding).toBeNull();
      expect(persisted.run_binding).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for missing, incomplete, and mismatched adapter capability selections", async () => {
    const missing = await loadAdapterDialectCapability("does-not-exist", ["adapters"], {
      model_profile_id: "v6", provider_model: "v6", mode: "text-to-video"
    });
    expect(missing.ok).toBe(false);
    const incomplete = await loadAdapterDialectCapability("pixverse", ["adapters"]);
    expect(incomplete.ok).toBe(false);
    const mismatched = await loadAdapterDialectCapability("pixverse", ["adapters"], {
      model_profile_id: "v6", provider_model: "not-the-declared-route", mode: "text-to-video"
    });
    expect(mismatched.ok).toBe(false);
    const wrongMode = await loadAdapterDialectCapability("pixverse", ["adapters"], {
      model_profile_id: "v6", provider_model: "v6", mode: "voiceover"
    });
    expect(wrongMode.ok).toBe(false);
  });

  it("keeps durable publication idempotent and rejects shadow replacement", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalone(), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-atomic-"));
    try {
      const options = { project_root: root, revision_id: compilationRevisionId(compiled.compilation.bundle), request_id: compiled.compilation.bundle.request_id };
      await writeCompilationBundleAtomic(root, compiled.compilation.bundle, options);
      await expect(writeCompilationBundleAtomic(root, compiled.compilation.bundle, options)).rejects.toThrow(/already exists/);
      await expect(writeCompilationBundleAtomic(root, compiled.compilation.bundle, { ...options, allow_existing_same_digest: true })).resolves.toBeUndefined();
      await rm(join(root, options.revision_id, "video-prompt", compiled.compilation.bundle.request_id, "compilation-manifest.json"));
      await expect(writeCompilationBundleAtomic(root, compiled.compilation.bundle, { ...options, allow_existing_same_digest: true })).resolves.toBeUndefined();
      await expect(writeCompilationBundleAtomic(root, compiled.compilation.bundle, { ...options, request_id: "../escape" })).rejects.toThrow(/VPD-K002/);
      const target = join(root, options.revision_id, "video-prompt", compiled.compilation.bundle.request_id);
      expect(readCompilationBundleAtomic(target, { project_root: root }).bundle.compilation_digest).toBe(compiled.compilation.bundle.compilation_digest);
      expect(() => readCompilationBundleAtomic(target, { project_root: "" })).toThrow(/project root is required/);
      expect(() => readCompilationBundleAtomic(join(root, "..", "outside"), { project_root: root })).toThrow(/escapes/);

      const comparison = {
        request_id: "shadow-idempotent",
        authoritative: "legacy" as const,
        status: "compiled",
        issues: [],
        legacy_canonical_prompt_digest: "1".repeat(64)
      };
      await writeShadowComparisonAtomic(root, comparison, { project_root: root, revision_id: "revision-1" });
      await writeShadowComparisonAtomic(root, comparison, { project_root: root, revision_id: "revision-1" });
      await expect(writeShadowComparisonAtomic(root, { ...comparison, status: "changed" }, { project_root: root, revision_id: "revision-1" })).rejects.toThrow(/VPD-C004/);
      await expect(writeShadowComparisonAtomic(root, comparison, { project_root: "", revision_id: "revision-2" })).rejects.toThrow(/project root is required/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates a missing compilation root only after parent identity validation", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalone(), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const raw = await mkdtemp(join(tmpdir(), "tsugite-po4-missing-root-"));
    try {
      const artifactRoot = join(raw, "dist");
      const revision = compilationRevisionId(compiled.compilation.bundle);
      await writeCompilationBundleAtomic(artifactRoot, compiled.compilation.bundle, {
        project_root: artifactRoot,
        revision_id: revision,
        request_id: compiled.compilation.bundle.request_id
      });
      expect(readCompilationBundleAtomic(artifactRoot, {
        project_root: artifactRoot,
        revision_id: revision,
        request_id: compiled.compilation.bundle.request_id
      }).bundle.compilation_digest).toBe(compiled.compilation.bundle.compilation_digest);
    } finally {
      await rm(raw, { recursive: true, force: true });
    }
  });

  it("quarantines a staged publication when cleanup identity is not trusted", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalone(), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-quarantine-"));
    try {
      await expect(writeCompilationBundleAtomic(root, compiled.compilation.bundle, {
        project_root: root,
        revision_id: compilationRevisionId(compiled.compilation.bundle),
        request_id: compiled.compilation.bundle.request_id,
        hooks: {
          before_link: () => { throw new Error("publication-before-link"); },
          before_cleanup: () => { throw new Error("cleanup identity changed"); }
        }
      })).rejects.toThrow(/publication-before-link/);
      const revisionRoot = join(root, compilationRevisionId(compiled.compilation.bundle), "video-prompt");
      const entries = await readdir(revisionRoot);
      expect(entries.some((name) => name.endsWith(".tmp"))).toBe(true);
      expect(entries.some((name) => name === compiled.compilation.bundle.request_id)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed at every atomic publication boundary and leaves no successful marker", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalone(), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const hookNames = [
      "before_temp_create",
      "after_temp_create",
      "before_stage_file",
      "before_marker_write",
      "before_target_reserve",
      "before_link"
    ] as const;
    for (const hookName of hookNames) {
      const raw = await mkdtemp(join(tmpdir(), `tsugite-po4-publication-${hookName}-`));
      try {
        const hooks = {
          [hookName]: () => { throw new Error(`publication-${hookName}`); }
        };
        await expect(writeCompilationBundleAtomic(raw, compiled.compilation.bundle, {
          project_root: raw,
          revision_id: compilationRevisionId(compiled.compilation.bundle),
          request_id: compiled.compilation.bundle.request_id,
          hooks: hooks as never
        })).rejects.toThrow(new RegExp(`publication-${hookName}|no-replace compilation publication failed`));
        const target = join(raw, compilationRevisionId(compiled.compilation.bundle), "video-prompt", compiled.compilation.bundle.request_id);
        await expect(readFile(join(target, "compilation-manifest.json"), "utf8")).rejects.toThrow();
      } finally {
        await rm(raw, { recursive: true, force: true });
      }
    }
  });

  it("does not adopt a target created during the publication reserve boundary", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalone(), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-publication-target-race-"));
    try {
      const revision = compilationRevisionId(compiled.compilation.bundle);
      const target = join(root, revision, "video-prompt", compiled.compilation.bundle.request_id);
      await expect(writeCompilationBundleAtomic(root, compiled.compilation.bundle, {
        project_root: root,
        revision_id: revision,
        request_id: compiled.compilation.bundle.request_id,
        allow_existing_same_digest: true,
        hooks: {
          before_target_reserve: async () => { await mkdir(target, { recursive: false, mode: 0o700 }); }
        }
      })).rejects.toThrow(/VPD-K002|file set|marker|compilation/);
      expect((await readdir(join(root, revision, "video-prompt"))).some((name) => name === compiled.compilation.bundle.request_id)).toBe(true);
      await expect(stat(join(target, "compilation-manifest.json"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe pre-existing file, symlink, and directory targets without replacement", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalone(), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-publication-existing-targets-"));
    try {
      const revision = compilationRevisionId(compiled.compilation.bundle);
      const parent = join(root, revision, "video-prompt");
      const target = join(parent, compiled.compilation.bundle.request_id);
      for (const kind of ["file", "symlink", "directory"] as const) {
        await mkdir(parent, { recursive: true });
        if (kind === "file") await writeFile(target, "sentinel\n");
        if (kind === "directory") await mkdir(target);
        if (kind === "symlink") await symlink(root, target);
        await expect(writeCompilationBundleAtomic(root, compiled.compilation.bundle, {
          project_root: root,
          revision_id: revision,
          request_id: compiled.compilation.bundle.request_id
        })).rejects.toThrow(/VPD-K002|already exists|identity/);
        await rm(target, { recursive: true, force: false });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects missing project roots and root/path identity mismatches before publication", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalone(), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-publication-identity-"));
    const other = await mkdtemp(join(tmpdir(), "tsugite-po4-publication-other-"));
    try {
      const revision = compilationRevisionId(compiled.compilation.bundle);
      const requestId = compiled.compilation.bundle.request_id;
      await expect(writeCompilationBundleAtomic(root, compiled.compilation.bundle, {
        project_root: "",
        revision_id: revision,
        request_id: requestId
      })).rejects.toThrow(/project root is required/);
      await expect(writeCompilationBundleAtomic(other, compiled.compilation.bundle, {
        project_root: root,
        revision_id: revision,
        request_id: requestId
      })).rejects.toThrow(/artifact root must equal/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  });

  it("rejects a symlink or file introduced at the final reserve boundary", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalone(), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    for (const kind of ["file", "symlink"] as const) {
      const root = await mkdtemp(join(tmpdir(), `tsugite-po4-publication-reserve-${kind}-`));
      try {
        const revision = compilationRevisionId(compiled.compilation.bundle);
        const parent = join(root, revision, "video-prompt");
        const target = join(parent, compiled.compilation.bundle.request_id);
        await expect(writeCompilationBundleAtomic(root, compiled.compilation.bundle, {
          project_root: root,
          revision_id: revision,
          request_id: compiled.compilation.bundle.request_id,
          hooks: {
            before_target_reserve: async () => {
              if (kind === "file") await writeFile(target, "outside-sentinel\n");
              else await symlink(root, target);
            }
          }
        })).rejects.toThrow(/VPD-K002: compilation artifact destination identity is unsafe/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("does not publish into an outside tree when an ancestor is swapped before reservation", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalone(), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-publication-swap-"));
    const outside = await mkdtemp(join(tmpdir(), "tsugite-po4-publication-outside-"));
    try {
      const revision = compilationRevisionId(compiled.compilation.bundle);
      const parent = join(root, revision, "video-prompt");
      await mkdir(parent, { recursive: true });
      await expect(writeCompilationBundleAtomic(root, compiled.compilation.bundle, {
        project_root: root,
        revision_id: revision,
        request_id: compiled.compilation.bundle.request_id,
        hooks: {
          before_target_reserve: async () => {
            await rm(parent, { recursive: true, force: false });
            await symlink(outside, parent);
          }
        }
      })).rejects.toThrow(/identity|symlink|path|artifact/);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects every persisted bundle digest and authority inconsistency", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalone(), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const base = compiled.compilation.bundle;
    const invalid = [
      (value: any) => { value.canonical_prompt_digest = "0".repeat(64); },
      (value: any) => { value.adapter_prompt_digest = "0".repeat(64); },
      (value: any) => { value.block_digests = {}; },
      (value: any) => { value.block_digests[value.semantic_blocks[0].block_id] = "0".repeat(64); },
      (value: any) => { value.route.route_digest = "0".repeat(64); },
      (value: any) => { value.effective_contract_digest = "0".repeat(64); },
      (value: any) => { value.execution_capable = true; },
      (value: any) => { value.validation.ok = false; },
      (value: any) => { value.lineage.generation_unit_source_digest = "0".repeat(64); },
      (value: any) => { value.compilation_digest = "0".repeat(64); }
    ];
    for (const mutate of invalid) {
      const candidate = JSON.parse(JSON.stringify(base));
      mutate(candidate);
      expect(() => verifyCompilationBundle(candidate)).toThrow();
    }
  });

  it("keeps adapter capability trust and exact-label protection fail-closed", async () => {
    const { adapter, route } = await v6Route();
    expect(resolveRendererDialectCapability({ route, adapter_dialect_capability: { ...adapter.capability } })).toBeUndefined();
    expect(resolveRendererDialectCapability({ route: { ...route, adapter_id: "other-adapter" }, adapter_dialect_capability: adapter.capability })).toBeUndefined();
    expect(resolveRendererDialectCapability({ route: { ...route, ir_model: "other-model" }, adapter_dialect_capability: adapter.capability })).toBeUndefined();
    expect(resolveRendererDialectCapability({ route: { ...route, provider_model: "other-provider" }, adapter_dialect_capability: adapter.capability })).toBeUndefined();
    expect(resolveRendererDialectCapability({ route: { ...route, mode_binding: "reference" }, adapter_dialect_capability: adapter.capability })).toBeUndefined();

    const ir = standalone("v6");
    ir.assets = [{ id: "hero", type: "image", path: "assets/hero.png", role: "subject_reference", sha256: "0".repeat(64) }];
    const labels = buildAdapterLabelMap(ir);
    expect(compileAdapterDialect(ir, "A <Picture 1>", undefined).issues.map((item) => item.code)).toContain("VPD-R002");
    const plain = compileAdapterDialect(ir, "A <Picture 1>", adapter.capability);
    expect(plain.issues.map((item) => item.code)).toContain("VPD-R002");
    expect(validateAdapterDialect("A <Picture 1>", "A @image1", labels)).toContainEqual(expect.objectContaining({ code: "VPD-R002" }));
    expect(validateAdapterDialect("A <Picture 1>", "A <Picture 1>", labels, adapter.capability)).toContainEqual(expect.objectContaining({ code: "VPD-R001" }));
  });

  it("rejects forged and mismatched asset pin identities before execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-pin-boundary-"));
    try {
      const realRoot = await realpath(root);
      await mkdir(join(root, "assets"));
      await mkdir(join(root, "pins"));
      await writeFile(join(root, "assets", "voice.wav"), "AAAA");
      const input = {
        asset_id: "voice",
        project_root: realRoot,
        project_relative_path: "assets/voice.wav",
        expected_sha256: sha256Text("AAAA"),
        expected_size: 4,
        expected_real_path: await realpath(join(root, "assets", "voice.wav")),
        pin_root: join(realRoot, "pins")
      };
      expect(() => createVerifiedAssetPin({ ...input, asset_id: "../voice" })).toThrow(/VPD-J002/);
      const pin = createVerifiedAssetPin(input);
      expect(() => verifyVerifiedAssetPin({ ...pin }, { project_root: realRoot, pin_root: input.pin_root })).toThrow(/VPD-J002/);
      expect(() => verifyVerifiedAssetPin(pin, { project_root: join(realRoot, "other"), pin_root: input.pin_root })).toThrow(/VPD-J002/);
      expect(() => createVerifiedAssetPin({ ...input, expected_real_path: join(realRoot, "assets", "other.wav") })).toThrow(/VPD-J002/);
      expect(() => createVerifiedAssetPin({ ...input, project_relative_path: "../outside.wav" })).toThrow(/VPD-J002/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires route and execution evidence at the V2 compiler boundary", async () => {
    expect(compileVideoPromptIrV2(standalone(), { require_route: true }).ok).toBe(false);
    const { model, connection, route } = await v6Route();
    const secondRoute = { ...route, mode_binding: "reference" as const };
    expect(compileVideoPromptIrV2(standalone(), { route, batch_routes: [route, secondRoute] }).ok).toBe(false);
    expect(compileVideoPromptIrV2(standalone(), { route, intent: "execute" }).ok).toBe(false);
    expect(compileVideoPromptIrV2(standalone(), {
      route,
      model_profile: model.profile,
      model_profile_digest: "0".repeat(64),
      intent: "planning"
    }).ok).toBe(false);
    expect(compileVideoPromptIrV2(standalone(), {
      route,
      connection_profile: connection.profile,
      connection_capability_digest: "0".repeat(64),
      intent: "planning"
    }).ok).toBe(false);
  });

  it("rejects route selector ambiguity, family-only matches, and unsupported modes", async () => {
    const { connection } = await v6Route();
    const exact = resolveExactModelRouteForMode(connection.profile, "v6", "text-to-video");
    expect(exact.ok).toBe(true);
    expect(resolveExactModelRouteForMode(connection.profile, "v6", "unsupported-mode")).toMatchObject({ code: "VPD-E012" });
    const first = connection.profile.exact_model_routes[0]!;
    const v6 = connection.profile.exact_model_routes.find((route) => route.model === "v6")!;
    expect(resolveExactModelRouteForMode({
      ...connection.profile,
      exact_model_routes: [{ ...first, model: "other-model", family: "family-model" }]
    }, "family-model", "text-to-video")).toMatchObject({ code: "VPD-E014" });
    expect(resolveExactModelRouteForMode({
      ...connection.profile,
      exact_model_routes: [v6, { ...v6 }]
    }, "v6", "text-to-video")).toMatchObject({ code: "VPD-E013" });
    expect(resolveExactModelRoute(connection.profile, "v6")).toMatchObject({ ok: true });
    expect(resolveExactModelRoute({
      ...connection.profile,
      exact_model_routes: [v6, { ...v6 }]
    }, "v6")).toMatchObject({ code: "VPD-E013" });
    expect(resolveExactModelRoute({
      ...connection.profile,
      exact_model_routes: [{ ...first, model: "other-model", family: "family-model" }]
    }, "family-model")).toMatchObject({ code: "VPD-E014" });
    expect(resolveExactModelRoute({ ...connection.profile, exact_model_routes: [] }, "missing-model"))
      .toMatchObject({ code: "VPD-E013" });
  });

  it("keeps connection pin verification bounded to regular files under trusted roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-connection-pin-"));
    const adapters = join(root, "adapters");
    const pin = join(adapters, "capability.yaml");
    try {
      await mkdir(adapters, { recursive: true });
      await writeFile(pin, "pinned capability\n");
      const options = { repoRoot: root, allowedPinRoots: ["adapters"] };
      expect(resolveConnectionPinPath("", options).ok).toBe(false);
      expect(resolveConnectionPinPath(join(root, "outside.yaml"), options).ok).toBe(false);
      expect(resolveConnectionPinPath("adapters/capability.yaml@v1", options).ok).toBe(false);
      expect(resolveConnectionPinPath("adapters/../outside.yaml", options).ok).toBe(false);
      expect(resolveConnectionPinPath("profiles/capability.yaml", options).ok).toBe(false);
      expect(resolveConnectionPinPath("adapters/capability.yaml", options)).toMatchObject({ ok: true });
      const digest = sha256Text("pinned capability\n");
      await expect(verifyConnectionPinFile("adapters/capability.yaml", digest, options)).resolves.toMatchObject({ ok: true });
      await expect(verifyConnectionPinFile("adapters/capability.yaml", "0".repeat(64), options)).resolves.toMatchObject({ ok: false });
      await expect(verifyConnectionPinFile("adapters/missing.yaml", digest, options)).resolves.toMatchObject({ ok: false });
      await expect(verifyConnectionPinFile("adapters", digest, options)).resolves.toMatchObject({ ok: false });
      await symlink(pin, join(adapters, "link.yaml"));
      await expect(verifyConnectionPinFile("adapters/link.yaml", digest, options)).resolves.toMatchObject({ ok: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects forged create-only envelope inputs before any execution adoption", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-envelope-failures-"));
    try {
      const storeRoot = join(await realpath(root), "artifacts");
      await mkdir(storeRoot, { recursive: true });
      const store = new ArtifactStore(await realpath(storeRoot));
      const stored = await store.create({ artifact_id: "raw", bytes: "raw artifact" });
      await expect(loadCreateOnlyArtifactStoreEnvelope({ store, artifact_id: stored.artifact_id, artifact_digest: "z".repeat(64) })).rejects.toThrow(/VPD-K003/);
      await expect(loadCreateOnlyArtifactStoreEnvelope({ store, artifact_id: stored.artifact_id, artifact_digest: "0".repeat(64) })).rejects.toThrow(/VPD-K003/);
      await expect(loadCreateOnlyArtifactStoreEnvelope({ store, artifact_id: stored.artifact_id, artifact_digest: stored.sha256, expected_compilation_digest: "0".repeat(64) })).rejects.toThrow(/strict compilation bundle/);
      await expect(loadCreateOnlyArtifactStoreEnvelope({ store: {} as ArtifactStore, artifact_id: stored.artifact_id, artifact_digest: stored.sha256 })).rejects.toThrow(/VPD-K003/);
      const { model, connection, adapter, route } = await v6Route();
      const compiled = compileVideoPromptIrV2(standalone(), {
        request_id: "envelope-1",
        route,
        model_profile: model.profile,
        model_profile_digest: model.digest,
        connection_profile: connection.profile,
        connection_capability_digest: connection.digest,
        adapter_dialect_capability: adapter.capability
      });
      expect(compiled.ok).toBe(true);
      if (compiled.ok) {
        const storedBundle = await store.create({ artifact_id: "planning-envelope", bytes: JSON.stringify(compiled.compilation.bundle) });
        const envelope = await loadCreateOnlyArtifactStoreEnvelope({
          store,
          artifact_id: storedBundle.artifact_id,
          artifact_digest: storedBundle.sha256,
          expected_compilation_digest: compiled.compilation.bundle.compilation_digest,
          request_id: compiled.compilation.bundle.request_id,
          revision_id: "revision-1",
          production_id: "production",
          project_id: "project"
        });
        expect(envelope.raw_bytes_digest).toBe(storedBundle.sha256);
        expect(envelope.compilation_digest).toBe(compiled.compilation.bundle.compilation_digest);
        await expect(loadCreateOnlyArtifactStoreEnvelope({
          store,
          artifact_id: storedBundle.artifact_id,
          artifact_digest: storedBundle.sha256,
          expected_compilation_digest: compiled.compilation.bundle.compilation_digest,
          request_id: "wrong-request"
        })).rejects.toThrow(/identity mismatch/);
      }
      expect(isProjectAssetIdentityContained(await realpath(root), join(await realpath(root), "missing"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps MV source and lyric authority separator-aware and opaque", () => {
    const winPath = { resolve: win32.resolve, relative: win32.relative, isAbsolute: win32.isAbsolute, sep: win32.sep };
    expect(generationUnitResolver.isGenerationUnitPathContained("C:\\project", "C:\\project\\generation-units\\unit.json", winPath)).toBe(true);
    expect(generationUnitResolver.isGenerationUnitPathContained("C:\\project", "C:\\project\\..\\outside.json", winPath)).toBe(false);
    expect(generationUnitResolver.isGenerationUnitPathContained("C:\\project", "D:\\project\\unit.json", winPath)).toBe(false);
    expect(generationUnitResolver.isGenerationUnitPathContained("\\\\server\\share\\project", "\\\\server\\share\\project\\unit.json", winPath)).toBe(true);
    const forged = {} as never;
    expect(generationUnitResolver.isAuthoritativeGenerationUnitSource(forged)).toBe(false);
    expect(generationUnitResolver.generationUnitContractFacts(forged)).toBeUndefined();
    expect(generationUnitResolver.consumeGenerationUnitLyricsToken(forged)).toBeUndefined();
    expect("materializeGenerationUnitLyrics" in generationUnitResolver).toBe(false);
  });

  it("rejects unsafe legacy source roots and identifiers without filesystem promotion", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-legacy-source-"));
    const outside = await mkdtemp(join(tmpdir(), "tsugite-po4-legacy-outside-"));
    const resolver = generationUnitResolver.createProjectGenerationUnitSourceResolver(join(root, "project.yaml"));
    const base = {
      project: { orchestration: { mode: "shadow" } },
      request: { id: "legacy-1" },
      ir: standalone(),
      requestIndex: 0
    } as never;
    try {
      await expect(resolver(base)).resolves.toBeUndefined();
      await expect(resolver({ ...base, request: { id: "../outside" } } as never)).resolves.toBeUndefined();
      await expect(resolver({
        ...base,
        project: { orchestration: { mode: "shadow" }, production_control: { generation_unit_sources_dir: 7 } }
      } as never)).resolves.toBeUndefined();
      await expect(resolver({
        ...base,
        project: { orchestration: { mode: "shadow" }, production_control: { generation_unit_sources_dir: "../outside" } }
      } as never)).resolves.toBeUndefined();

      const sourceRoot = join(root, "production-control");
      const sourceDir = join(sourceRoot, "generation-units");
      await mkdir(sourceRoot, { recursive: true });
      await writeFile(sourceDir, "not a directory");
      await expect(resolver(base)).resolves.toBeUndefined();
      await rm(sourceDir, { force: true });
      await symlink(outside, sourceDir, "dir");
      await expect(resolver(base)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("keeps active MV source resolution fail-closed before an authoritative artifact exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-active-source-"));
    const resolver = generationUnitResolver.createProjectGenerationUnitSourceResolver(join(root, "project.yaml"));
    const standaloneRequest = {
      project: { orchestration: { mode: "active" } },
      request: { id: "unit-1" },
      ir: standalone(),
      requestIndex: 0
    } as never;
    const mv = { ...standalone(), program_kind: "mv" } as never;
    try {
      await expect(resolver(standaloneRequest)).resolves.toBeUndefined();
      await expect(resolver({ ...standaloneRequest, ir: mv })).resolves.toBeUndefined();
      await expect(resolver({
        ...standaloneRequest,
        project: { orchestration: { mode: "active" }, production_control: { artifact_store_dir: 7 } },
        ir: mv
      } as never)).resolves.toBeUndefined();
      await expect(resolver({
        ...standaloneRequest,
        project: {
          orchestration: { mode: "active", authoring: { generation_units: [{ id: "unit-1", digest: "0".repeat(64) }, { id: "unit-1", digest: "0".repeat(64) }] } },
          production_control: { artifact_store_dir: "production-control" }
        },
        ir: mv
      } as never)).resolves.toBeUndefined();
      await expect(resolver({
        ...standaloneRequest,
        project: {
          orchestration: { mode: "active", authoring: { generation_units: [{ id: "unit-1", digest: "0".repeat(64) }] } },
          production_control: { artifact_store_dir: "production-control" }
        },
        ir: mv
      } as never)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("wires the production compiler to one namespaced planning ArtifactStore truth", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-planning-wire-"));
    try {
      const storeRoot = join(root, "production-control");
      await mkdir(storeRoot);
      const store = new ArtifactStore(await realpath(storeRoot));
      const project = {
        slug: "planning-wire",
        name: "planning-wire",
        manifest: "manifest.json",
        dist_dir: "dist",
        edit: { backend: "remotion" },
        orchestration: { mode: "active" },
        generation: {
          connection: "pixverse",
          adapter: "pixverse",
          requests: [{ id: "planning-wire-1", operation: "video", prompt: "", params: {}, video_prompt: standalone() }]
        }
      } as never;
      const result = await compileProjectVideoPrompts(project, {
        intent: "planning",
        planningArtifactStore: store,
        productionId: "production",
        projectId: "planning-wire"
      } as never);
      expect(result.ok).toBe(true);
      const ref = result.plans[0]?.v2_compilation?.planning_artifact;
      expect(ref).toMatchObject({ production_id: "production", project_id: "planning-wire", request_id: "planning-wire-1" });
      expect(ref?.artifact_id).toContain("planning-production-planning-wire-");
      const stored = JSON.parse((await store.read((ref as { artifact_id: string }).artifact_id)).toString("utf8")) as { execution_capable: boolean; compilation_digest: string };
      expect(stored.execution_capable).toBe(false);
      expect(stored.compilation_digest).toBe(result.plans[0]?.v2_compilation?.bundle.compilation_digest);
      const reloadedStore = new ArtifactStore(await realpath(storeRoot));
      const reloaded = await loadPlanningArtifactRef({
        store: reloadedStore,
        artifact_id: (ref as { artifact_id: string }).artifact_id,
        artifact_digest: (ref as { artifact_digest: string }).artifact_digest,
        production_id: "production",
        project_id: "planning-wire",
        revision_id: (ref as { revision_id: string }).revision_id,
        request_id: "planning-wire-1",
        expected_store_root: await realpath(storeRoot)
      });
      expect(reloaded).toMatchObject(ref);
      const copiedRoot = join(root, "copied-planning-store");
      await mkdir(copiedRoot);
      const copiedStoreRoot = await realpath(copiedRoot);
      const copiedStore = new ArtifactStore(copiedStoreRoot);
      await copiedStore.create({ artifact_id: (ref as { artifact_id: string }).artifact_id, bytes: await store.read((ref as { artifact_id: string }).artifact_id) });
      await expect(loadPlanningArtifactRef({
        store: copiedStore,
        artifact_id: (ref as { artifact_id: string }).artifact_id,
        artifact_digest: (ref as { artifact_digest: string }).artifact_digest,
        production_id: "production",
        project_id: "planning-wire",
        revision_id: (ref as { revision_id: string }).revision_id,
        request_id: "planning-wire-1",
        expected_store_root: await realpath(storeRoot)
      })).rejects.toThrow(/store root/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects every forged planning ArtifactStore identity before review adoption", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalone(), {
      request_id: "planning-loader-1",
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-po4-planning-loader-")));
    try {
      const store = new ArtifactStore(root);
      const bundle = compiled.compilation.bundle;
      const revision = compilationRevisionId(bundle);
      const artifactId = `planning-production-loader-${revision}-${bundle.request_id}`;
      const bytes = Buffer.from(JSON.stringify(bundle));
      const stored = await store.create({ artifact_id: artifactId, bytes });
      const base = {
        store,
        artifact_id: artifactId,
        artifact_digest: stored.sha256,
        production_id: "production",
        project_id: "loader",
        revision_id: revision,
        request_id: bundle.request_id,
        expected_store_root: root
      };
      await expect(loadPlanningArtifactRef({ ...base, store: {} as never })).rejects.toThrow(/unsafe namespace/);
      await expect(loadPlanningArtifactRef({ ...base, project_id: "../copy" })).rejects.toThrow(/unsafe namespace/);
      await expect(loadPlanningArtifactRef({ ...base, expected_store_root: join(root, "other") })).rejects.toThrow(/store root/);
      await expect(loadPlanningArtifactRef({ ...base, artifact_id: "planning-production-loader-other-request" })).rejects.toThrow(/namespace/);
      await expect(loadPlanningArtifactRef({ ...base, artifact_digest: "0".repeat(64) })).rejects.toThrow(/bytes changed/);

      const malformedRoot = join(root, "malformed-store");
      await mkdir(malformedRoot);
      const malformedStore = new ArtifactStore(await realpath(malformedRoot));
      await malformedStore.create({ artifact_id: artifactId, bytes: "not-json" });
      await expect(loadPlanningArtifactRef({ ...base, store: malformedStore, artifact_digest: sha256Text("not-json"), expected_store_root: await realpath(malformedRoot) })).rejects.toThrow(/strict compilation bundle/);

      const nonCanonicalRoot = join(root, "noncanonical-store");
      await mkdir(nonCanonicalRoot);
      const nonCanonicalStore = new ArtifactStore(await realpath(nonCanonicalRoot));
      const nonCanonicalId = artifactId;
      const padded = ` ${bytes.toString("utf8")} `;
      await nonCanonicalStore.create({ artifact_id: nonCanonicalId, bytes: padded });
      await expect(loadPlanningArtifactRef({ ...base, store: nonCanonicalStore, artifact_id: nonCanonicalId, artifact_digest: sha256Text(padded), expected_store_root: await realpath(nonCanonicalRoot), request_id: bundle.request_id })).rejects.toThrow(/canonical/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects active V2 provider-impact params instead of carrying caller fields into the adapter request", async () => {
    const project = {
      slug: "active-v2-params",
      name: "active-v2-params",
      manifest: "manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      orchestration: { mode: "active" },
      generation: {
        connection: "pixverse",
        adapter: "pixverse",
        requests: [{
          id: "active-v2-params-1",
          operation: "video",
          prompt: "",
          params: { image: "caller.jpg", provider_flag: true, input_audio: "caller.wav" },
          video_prompt: standalone()
        }]
      }
    } as never;
    const result = await compileProjectVideoPrompts(project);
    expect(result.ok).toBe(false);
    expect(result.plans).toHaveLength(0);
    expect(result.issues.map((item) => item.code)).toContain("VPD-E033");
  });

  it("rejects a hard-link alias while rereading a committed bundle", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalone(), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-po4-alias-reader-")));
    try {
      const revision = compilationRevisionId(compiled.compilation.bundle);
      await writeCompilationBundleAtomic(root, compiled.compilation.bundle, {
        project_root: root,
        revision_id: revision,
        request_id: compiled.compilation.bundle.request_id
      });
      const target = join(root, revision, "video-prompt", compiled.compilation.bundle.request_id);
      await (await import("node:fs/promises")).link(join(target, "bundle.json"), join(target, "bundle-alias.json"));
      expect(() => readCompilationBundleAtomic(target, { project_root: root, revision_id: revision, request_id: compiled.compilation.bundle.request_id })).toThrow(/unexpected|alias|file set/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps planning ArtifactStore publication create-only and idempotent", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalone(), {
      request_id: "planning-idempotent-1",
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-po4-planning-idempotent-")));
    try {
      const storeRoot = join(root, "store");
      await mkdir(storeRoot);
      const store = new ArtifactStore(await realpath(storeRoot));
      const revision = compilationRevisionId(compiled.compilation.bundle);
      const first = await persistPlanningCompilationArtifact({
        store,
        bundle: compiled.compilation.bundle,
        production_id: "production",
        project_id: "project",
        revision_id: revision
      });
      const second = await persistPlanningCompilationArtifact({
        store,
        bundle: compiled.compilation.bundle,
        production_id: "production",
        project_id: "project"
      });
      expect(second).toMatchObject(first);
      await expect(persistPlanningCompilationArtifact({
        store,
        bundle: compiled.compilation.bundle,
        production_id: "../outside",
        project_id: "project",
        revision_id: revision
      })).rejects.toThrow(/namespace is unsafe/);
      await expect(persistPlanningCompilationArtifact({
        store,
        bundle: compiled.compilation.bundle,
        production_id: "production",
        project_id: "project",
        revision_id: "revision-forged"
      })).rejects.toThrow(/digest-bound revision/);
      const envelope = await loadCreateOnlyArtifactStoreEnvelope({
        store,
        artifact_id: first.artifact_id,
        artifact_digest: first.artifact_digest
      });
      expect(envelope.compilation_digest).toBeUndefined();
      expect(envelope.artifact_id).toBe(first.artifact_id);

      await mkdir(join(root, "assets"));
      expect(() => createVerifiedAssetPin({
        asset_id: "directory-source",
        project_root: root,
        project_relative_path: "assets",
        expected_real_path: join(root, "assets"),
        pin_root: join(root, "pins")
      })).toThrow(/VPD-J002/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a caller-shaped AssetContract resolution at the production compiler boundary", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-po4-forged-asset-resolution-")));
    try {
      const project = {
        slug: "forged-asset-resolution",
        name: "forged-asset-resolution",
        manifest: "manifest.json",
        dist_dir: "dist",
        edit: { backend: "remotion" },
        orchestration: { mode: "active" },
        generation: {
          connection: "pixverse",
          adapter: "pixverse",
          requests: [{ id: "forged-asset-resolution-1", operation: "video", prompt: "", params: {}, video_prompt: standalone() }]
        }
      } as never;
      const resolution = await generationUnitResolver.resolveProjectAssetContract(join(root, "project.yaml"), project);
      expect(resolution).toBeUndefined();
      const authoringProject = {
        ...project,
        orchestration: {
          mode: "active",
          authoring: { assets: { kind: "asset-contract", id: "missing-contract", digest: "0".repeat(64) } }
        }
      } as never;
      expect(await generationUnitResolver.resolveProjectAssetContract(join(root, "project.yaml"), {
        ...authoringProject,
        production_control: { artifact_store_dir: "../outside" }
      } as never)).toBeUndefined();
      expect(await generationUnitResolver.resolveProjectAssetContract(join(root, "project.yaml"), authoringProject)).toBeUndefined();
      const artifactRoot = join(root, "production-control");
      await mkdir(artifactRoot);
      const malformedStore = new ArtifactStore(await realpath(artifactRoot));
      const malformed = await malformedStore.create({ artifact_id: "malformed-contract", bytes: "{}" });
      expect(await generationUnitResolver.resolveProjectAssetContract(join(root, "project.yaml"), {
        ...authoringProject,
        orchestration: { mode: "active", authoring: { assets: { kind: "asset-contract", id: malformed.artifact_id, digest: malformed.sha256 } } }
      } as never)).toBeUndefined();
      const validShape = createAssetContract({ contract_id: "shape-only", revision: 1, assets: [] });
      const digestMismatch = await malformedStore.create({ artifact_id: "digest-mismatch", bytes: JSON.stringify(validShape) });
      expect(await generationUnitResolver.resolveProjectAssetContract(join(root, "project.yaml"), {
        ...authoringProject,
        orchestration: { mode: "active", authoring: { assets: { kind: "asset-contract", id: digestMismatch.artifact_id, digest: "0".repeat(64) } } }
      } as never)).toBeUndefined();
      const result = await compileProjectVideoPrompts(project, {
        assetContractResolution: {
          kind: "trusted-asset-contract-resolution",
          project_root: root,
          artifact_id: "caller-made",
          contract_id: "caller-made",
          revision: 1,
          digest: "0".repeat(64),
          contract: {}
        }
      } as never);
      expect(result.ok).toBe(false);
      expect(result.issues.map((item) => item.code)).toContain("VPD-J002");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("strictly resolves create-only envelopes from bounded bytes and namespace identity", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalone(), {
      request_id: "envelope-1",
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-po4-envelope-")));
    try {
      const store = new ArtifactStore(root);
      const bundleBytes = Buffer.from(JSON.stringify(compiled.compilation.bundle), "utf8");
      const bundleDigest = sha256Text(bundleBytes.toString("utf8"));
      const stored = await store.create({ artifact_id: "bundle", bytes: bundleBytes });
      const envelope = await loadCreateOnlyArtifactStoreEnvelope({
        store,
        artifact_id: stored.artifact_id,
        artifact_digest: bundleDigest,
        expected_compilation_digest: compiled.compilation.bundle.compilation_digest,
        request_id: compiled.compilation.bundle.request_id,
        revision_id: "revision-1",
        production_id: "production",
        project_id: "project"
      });
      expect(envelope).toMatchObject({
        compilation_digest: compiled.compilation.bundle.compilation_digest,
        raw_bytes_digest: bundleDigest,
        request_id: compiled.compilation.bundle.request_id,
        revision_id: "revision-1",
        production_id: "production",
        project_id: "project"
      });
      await expect(loadCreateOnlyArtifactStoreEnvelope({ store: {} as never, artifact_id: "bundle", artifact_digest: bundleDigest })).rejects.toThrow(/resolver is unavailable/);
      await expect(loadCreateOnlyArtifactStoreEnvelope({ store, artifact_id: "bundle", artifact_digest: "0".repeat(64) })).rejects.toThrow(/digest mismatch/);
      await expect(loadCreateOnlyArtifactStoreEnvelope({
        store,
        artifact_id: stored.artifact_id,
        artifact_digest: bundleDigest,
        expected_compilation_digest: "0".repeat(64)
      })).rejects.toThrow(/identity mismatch/);
      await expect(loadCreateOnlyArtifactStoreEnvelope({
        store,
        artifact_id: stored.artifact_id,
        artifact_digest: bundleDigest,
        expected_compilation_digest: compiled.compilation.bundle.compilation_digest,
        request_id: "other-request"
      })).rejects.toThrow(/identity mismatch/);
      const spaced = Buffer.from(` ${bundleBytes.toString("utf8")} `, "utf8");
      const spacedStored = await store.create({ artifact_id: "spaced", bytes: spaced });
      await expect(loadCreateOnlyArtifactStoreEnvelope({
        store,
        artifact_id: spacedStored.artifact_id,
        artifact_digest: sha256Text(spaced.toString("utf8")),
        expected_compilation_digest: compiled.compilation.bundle.compilation_digest
      })).rejects.toThrow(/canonical/);
      const malformed = await store.create({ artifact_id: "malformed", bytes: "not-json" });
      await expect(loadCreateOnlyArtifactStoreEnvelope({
        store,
        artifact_id: malformed.artifact_id,
        artifact_digest: malformed.sha256,
        expected_compilation_digest: compiled.compilation.bundle.compilation_digest
      })).rejects.toThrow(/strict compilation bundle/);
      await expect(loadCreateOnlyArtifactStoreEnvelope({
        store,
        artifact_id: stored.artifact_id,
        artifact_digest: bundleDigest,
        expected_compilation_digest: compiled.compilation.bundle.compilation_digest,
        request_id: compiled.compilation.bundle.request_id
      })).resolves.toMatchObject({ artifact_id: stored.artifact_id });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let planning persistence or create-only collisions grant execution", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalone(), {
      request_id: "planning-authority-1",
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-po4-planning-authority-")));
    try {
      const store = new ArtifactStore(root);
      const bundle = compiled.compilation.bundle;
      const revision = compilationRevisionId(bundle);
      await expect(persistPlanningCompilationArtifact({
        store: {} as never,
        bundle,
        production_id: "production",
        project_id: "project",
        revision_id: revision
      })).rejects.toThrow(/ArtifactStore/);

      const executionCandidate = JSON.parse(JSON.stringify(bundle)) as Record<string, any>;
      executionCandidate.execution_capable = true;
      executionCandidate.effective_contract.execution.status = "execution-capable";
      const effectiveBody = { ...executionCandidate.effective_contract };
      delete effectiveBody.digest;
      executionCandidate.effective_contract.digest = sha256Canonical(effectiveBody);
      executionCandidate.effective_contract_digest = executionCandidate.effective_contract.digest;
      const withoutDigest = { ...executionCandidate };
      delete withoutDigest.compilation_digest;
      executionCandidate.compilation_digest = sha256Canonical(withoutDigest);
      await expect(persistPlanningCompilationArtifact({
        store,
        bundle: executionCandidate as never,
        production_id: "production",
        project_id: "project",
        revision_id: compilationRevisionId(executionCandidate as never)
      })).rejects.toThrow(/execution-capable bundle/);

      const artifactId = `planning-production-project-${revision}-${bundle.request_id}`;
      await store.create({ artifact_id: artifactId, bytes: "different bytes" });
      await expect(persistPlanningCompilationArtifact({
        store,
        bundle,
        production_id: "production",
        project_id: "project",
        revision_id: revision
      })).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on each committed planning identity mutation before budget authority", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalone(), {
      request_id: "planning-identity-1",
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-po4-planning-identity-")));
    try {
      const store = new ArtifactStore(root);
      const base = compiled.compilation.bundle;
      const recompute = (candidate: Record<string, any>) => {
        candidate.compilation_digest = sha256Canonical(Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== "compilation_digest")));
        return candidate;
      };
      const persist = async (candidate: Record<string, any>) => {
        const revision = compilationRevisionId(candidate as never);
        const planning = await persistPlanningCompilationArtifact({ store, bundle: candidate as never, production_id: "production", project_id: "project", revision_id: revision });
        return { planning, revision };
      };
      const deriveBase = (planning: any, revision: string, extra: Record<string, unknown> = {}) => videoPromptDirector.deriveExecutionCompilationBundleFromPlanningArtifact({
        planning_artifact: planning,
        store,
        production_id: "production",
        project_id: "project",
        revision_id: revision,
        project_root: root,
        asset_pin_root: join(root, "pins"),
        model_profile: model.profile,
        connection_profile: connection.profile,
        trusted_pinned_budget_evidence: {} as never,
        ...extra
      } as never);

      const unsupported = recompute({ ...JSON.parse(JSON.stringify(base)), lineage: { ...base.lineage, authoring_schema: "caller-forged" } });
      const unsupportedRef = await persist(unsupported);
      await expect(deriveBase(unsupportedRef.planning, unsupportedRef.revision)).rejects.toThrow(/authoring source tuple/);

      const wrongMode = JSON.parse(JSON.stringify(base)) as Record<string, any>;
      wrongMode.normalized_ir.target.mode = "reference";
      wrongMode.normalized_ir_digest = sha256Canonical(wrongMode.normalized_ir);
      const wrongModeRef = await persist(recompute(wrongMode));
      await expect(deriveBase(wrongModeRef.planning, wrongModeRef.revision)).rejects.toThrow(/committed route/);

      const missingConnection = JSON.parse(JSON.stringify(base)) as Record<string, any>;
      missingConnection.route.connection_id = "missing-connection";
      const routeWithoutDigest = { ...missingConnection.route };
      delete routeWithoutDigest.route_digest;
      missingConnection.route.route_digest = sha256Canonical(routeWithoutDigest);
      const missingConnectionRef = await persist(recompute(missingConnection));
      await expect(deriveBase(missingConnectionRef.planning, missingConnectionRef.revision)).rejects.toThrow(/profile is unavailable/);

      const missingAdapter = JSON.parse(JSON.stringify(base)) as Record<string, any>;
      missingAdapter.adapter_capability_digest = "0".repeat(64);
      const missingAdapterRef = await persist(recompute(missingAdapter));
      await expect(deriveBase(missingAdapterRef.planning, missingAdapterRef.revision)).rejects.toThrow(/adapter capability/);

      const h3Model = await loadModelPromptProfile("minimax-h3");
      const h3Connection = await loadConnectionCapabilityProfile("minimax-direct");
      const h3Adapter = await loadAdapterDialectCapability("minimax", ["adapters"], { model_profile_id: "minimax-h3", provider_model: "MiniMax-H3", mode: "text-to-video" });
      const h3Grammar = await loadPinnedH3GrammarProfile();
      expect(h3Model.ok && h3Connection.ok && h3Adapter.ok && isTrustedH3GrammarProfile(h3Grammar)).toBe(true);
      if (!h3Model.ok || !h3Connection.ok || !h3Adapter.ok || !isTrustedH3GrammarProfile(h3Grammar)) return;
      const h3Route = routeFromProfiles({ model: "minimax-h3", mode: "text-to-video", model_profile: h3Model.profile, connection_profile: h3Connection.profile, model_profile_digest: h3Model.digest, connection_profile_digest: h3Connection.digest });
      expect(h3Route.ok).toBe(true);
      if (!h3Route.ok) return;
      const h3Ir = standalone("minimax-h3");
      h3Ir.target = { ...h3Ir.target, quality: "768p" };
      const h3Compiled = compileVideoPromptIrV2(h3Ir, {
        request_id: "planning-h3-1",
        route: h3Route.route,
        model_profile: h3Model.profile,
        model_profile_digest: h3Model.digest,
        connection_profile: h3Connection.profile,
        connection_capability_digest: h3Connection.digest,
        adapter_dialect_capability: h3Adapter.capability,
        grammar_profile: h3Grammar,
        require_pinned_grammar: true
      });
      expect(h3Compiled.ok, JSON.stringify(h3Compiled)).toBe(true);
      if (!h3Compiled.ok) return;
      const h3Ref = await persist(h3Compiled.compilation.bundle as never);
      await expect(deriveBase(h3Ref.planning, h3Ref.revision, {
        model_profile: h3Model.profile,
        connection_profile: h3Connection.profile,
        grammar_profile: h3Grammar
      })).rejects.toThrow(/unknown or not authoritative/);

      expect(() => verifyCompilationBundle(h3Compiled.compilation.bundle)).not.toThrow();
      const forgedGrammar = JSON.parse(JSON.stringify(h3Compiled.compilation.bundle)) as Record<string, any>;
      forgedGrammar.grammar_profile.digest = "0".repeat(64);
      expect(() => verifyCompilationBundle(forgedGrammar)).toThrow(/grammar profile digest/);

      const plainWithGrammar = JSON.parse(JSON.stringify(base)) as Record<string, any>;
      plainWithGrammar.grammar_profile = h3Grammar;
      const plainGrammarRef = await persist(recompute(plainWithGrammar));
      await expect(deriveBase(plainGrammarRef.planning, plainGrammarRef.revision)).rejects.toThrow(/plain-prompt execution/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("strictly threads h3 and video_prompt authoring_surface through recompile and execution lineage", async () => {
    const h3Model = await loadModelPromptProfile("minimax-h3");
    const h3Connection = await loadConnectionCapabilityProfile("minimax-direct");
    const h3Adapter = await loadAdapterDialectCapability("minimax", ["adapters"], {
      model_profile_id: "minimax-h3",
      provider_model: "MiniMax-H3",
      mode: "text-to-video"
    });
    const h3Grammar = await loadPinnedH3GrammarProfile();
    expect(h3Model.ok && h3Connection.ok && h3Adapter.ok && isTrustedH3GrammarProfile(h3Grammar)).toBe(true);
    if (!h3Model.ok || !h3Connection.ok || !h3Adapter.ok || !isTrustedH3GrammarProfile(h3Grammar)) return;
    const h3Route = routeFromProfiles({
      model: "minimax-h3",
      mode: "text-to-video",
      model_profile: h3Model.profile,
      connection_profile: h3Connection.profile,
      model_profile_digest: h3Model.digest,
      connection_profile_digest: h3Connection.digest
    });
    expect(h3Route.ok).toBe(true);
    if (!h3Route.ok) return;
    const { model, connection, adapter, route } = await v6Route();
    const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-po4-authoring-surface-")));
    try {
      const storeRoot = join(root, "store");
      await mkdir(storeRoot);
      const store = new ArtifactStore(await realpath(storeRoot));
      const h3Ir = standalone("minimax-h3");
      h3Ir.target = { ...h3Ir.target, quality: "768p" };
      const sourceDigest = sha256Canonical(h3Ir);
      const compileOpts = {
        request_id: "surface-h3-1",
        route: h3Route.route,
        model_profile: h3Model.profile,
        model_profile_digest: h3Model.digest,
        connection_profile: h3Connection.profile,
        connection_capability_digest: h3Connection.digest,
        adapter_dialect_capability: h3Adapter.capability,
        grammar_profile: h3Grammar,
        require_pinned_grammar: true as const
      };
      const h3Compiled = compileVideoPromptIrV2(h3Ir, {
        ...compileOpts,
        source: {
          authoring_surface: "h3",
          authoring_schema: "VideoPromptIrV2",
          upgrader_version: "native-v2",
          source_digest: sourceDigest
        }
      });
      expect(h3Compiled.ok, JSON.stringify(h3Compiled)).toBe(true);
      if (!h3Compiled.ok) return;
      expect(h3Compiled.compilation.bundle.lineage.authoring_surface).toBe("h3");

      // Without surface passthrough, recompile defaults to video_prompt and digests diverge.
      const recompiledDefault = compileVideoPromptIrV2(h3Ir, {
        ...compileOpts,
        source: {
          authoring_schema: "VideoPromptIrV2",
          upgrader_version: "native-v2",
          source_digest: sourceDigest
        }
      });
      expect(recompiledDefault.ok).toBe(true);
      if (!recompiledDefault.ok) return;
      expect(recompiledDefault.compilation.bundle.lineage.authoring_surface).toBe("video_prompt");
      expect(recompiledDefault.compilation.bundle.compilation_digest).not.toBe(h3Compiled.compilation.bundle.compilation_digest);

      const recompiledH3 = compileVideoPromptIrV2(h3Ir, {
        ...compileOpts,
        source: {
          authoring_surface: "h3",
          authoring_schema: "VideoPromptIrV2",
          upgrader_version: "native-v2",
          source_digest: sourceDigest
        }
      });
      expect(recompiledH3.ok).toBe(true);
      if (!recompiledH3.ok) return;
      expect(recompiledH3.compilation.bundle.lineage.authoring_surface).toBe("h3");
      expect(recompiledH3.compilation.bundle.compilation_digest).toBe(h3Compiled.compilation.bundle.compilation_digest);

      const revision = compilationRevisionId(h3Compiled.compilation.bundle);
      const planning = await persistPlanningCompilationArtifact({
        store,
        bundle: h3Compiled.compilation.bundle,
        production_id: "production",
        project_id: "project",
        revision_id: revision
      });

      // Fixture-only budget loader marks trusted planning evidence, but must not
      // grant production execution authority. Prove surface/digest on planning
      // and recompile paths only — do not spy or elevate authority.
      const fixturePath = join(root, "budget.json");
      await writeFile(fixturePath, JSON.stringify({
        schema_version: 1,
        source_id: "surface-budget",
        hard: {
          limit: 20000,
          unit: "utf8-bytes",
          source: "advisory-catalog",
          verified_at: "2026-08-11T00:00:00Z",
          source_digest: "2".repeat(64)
        },
        soft: null,
        unknown: false,
        model_profile_digest: h3Model.digest,
        connection_profile_digest: h3Connection.digest,
        route_digest: h3Route.route.route_digest,
        retrieved_at: "2026-08-11T00:00:00Z",
        expires_at: "2099-12-31T00:00:00Z"
      }));
      const fixtureOnlyBudget = loadPlanningOnlyPinnedPromptBudgetEvidence({
        artifactPath: fixturePath,
        repoRoot: root,
        route: h3Route.route,
        model_profile_digest: h3Model.digest,
        connection_profile_digest: h3Connection.digest
      });
      expect(fixtureOnlyBudget).toBeDefined();
      if (!fixtureOnlyBudget) return;
      expect(isTrustedPinnedPromptBudgetEvidence(fixtureOnlyBudget)).toBe(true);
      expect(isExecutionAuthoritativePinnedPromptBudgetEvidence(fixtureOnlyBudget)).toBe(false);

      const reloadedPlanning = await loadPlanningArtifactRef({
        store,
        artifact_id: planning.artifact_id,
        artifact_digest: planning.artifact_digest,
        production_id: "production",
        project_id: "project",
        revision_id: revision,
        request_id: h3Compiled.compilation.bundle.request_id,
        expected_store_root: storeRoot
      });
      expect(reloadedPlanning.artifact_digest).toBe(planning.artifact_digest);
      expect(h3Compiled.compilation.bundle.lineage.authoring_surface).toBe("h3");
      expect(h3Compiled.compilation.bundle.lineage.authoring_schema).toBe("VideoPromptIrV2");

      await expect(videoPromptDirector.deriveExecutionCompilationBundleFromPlanningArtifact({
        planning_artifact: planning,
        store,
        production_id: "production",
        project_id: "project",
        revision_id: revision,
        project_root: root,
        asset_pin_root: join(root, "pins"),
        model_profile: h3Model.profile,
        connection_profile: h3Connection.profile,
        grammar_profile: h3Grammar,
        trusted_pinned_budget_evidence: fixtureOnlyBudget
      })).rejects.toThrow(/VPD-K003: production prompt budget evidence is unknown or not authoritative/);

      const v2Compiled = compileVideoPromptIrV2(standalone(), {
        request_id: "surface-vp-1",
        route,
        model_profile: model.profile,
        model_profile_digest: model.digest,
        connection_profile: connection.profile,
        connection_capability_digest: connection.digest,
        adapter_dialect_capability: adapter.capability,
        source: {
          authoring_surface: "video_prompt",
          authoring_schema: "VideoPromptIrV2",
          upgrader_version: "native-v2"
        }
      });
      expect(v2Compiled.ok).toBe(true);
      if (!v2Compiled.ok) return;
      expect(v2Compiled.compilation.bundle.lineage.authoring_surface).toBe("video_prompt");
      const v2Revision = compilationRevisionId(v2Compiled.compilation.bundle);
      const v2Planning = await persistPlanningCompilationArtifact({
        store,
        bundle: v2Compiled.compilation.bundle,
        production_id: "production",
        project_id: "project",
        revision_id: v2Revision
      });
      // video_prompt surface recompiles cleanly; only budget authority still blocks execution.
      await expect(videoPromptDirector.deriveExecutionCompilationBundleFromPlanningArtifact({
        planning_artifact: v2Planning,
        store,
        production_id: "production",
        project_id: "project",
        revision_id: v2Revision,
        project_root: root,
        asset_pin_root: join(root, "pins"),
        model_profile: model.profile,
        connection_profile: connection.profile,
        trusted_pinned_budget_evidence: {} as never
      })).rejects.toThrow(/unknown or not authoritative/);

      // Unknown / forged surfaces are rejected at the strict bundle boundary.
      const forgedUnknown = JSON.parse(JSON.stringify(h3Compiled.compilation.bundle)) as Record<string, any>;
      forgedUnknown.lineage = { ...forgedUnknown.lineage, authoring_surface: "caller-forged" };
      forgedUnknown.compilation_digest = sha256Canonical(Object.fromEntries(
        Object.entries(forgedUnknown).filter(([key]) => key !== "compilation_digest")
      ));
      expect(() => verifyCompilationBundle(forgedUnknown)).toThrow();

      const forgedFlip = JSON.parse(JSON.stringify(h3Compiled.compilation.bundle)) as Record<string, any>;
      forgedFlip.lineage = { ...forgedFlip.lineage, authoring_surface: "video_prompt" };
      forgedFlip.compilation_digest = sha256Canonical(Object.fromEntries(
        Object.entries(forgedFlip).filter(([key]) => key !== "compilation_digest")
      ));
      // Flipped surface recomputes as a different digest and cannot impersonate the h3 planning artifact.
      expect(forgedFlip.compilation_digest).not.toBe(h3Compiled.compilation.bundle.compilation_digest);
      expect(() => verifyCompilationBundle(forgedFlip)).not.toThrow();
      expect(verifyCompilationBundle(forgedFlip).lineage.authoring_surface).toBe("video_prompt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects planning authority loader for unsafe namespace, wrong root, tamper, and non-canonical bytes", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalone(), {
      request_id: "loader-1",
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-po4-loader-")));
    try {
      const storeRoot = join(root, "store");
      await mkdir(storeRoot);
      const store = new ArtifactStore(await realpath(storeRoot));
      const bundle = compiled.compilation.bundle;
      const revision = compilationRevisionId(bundle);
      const planning = await persistPlanningCompilationArtifact({
        store,
        bundle,
        production_id: "production",
        project_id: "project",
        revision_id: revision
      });

      await expect(loadPlanningArtifactRef({
        store,
        artifact_id: planning.artifact_id,
        artifact_digest: planning.artifact_digest,
        production_id: "../escape",
        project_id: "project",
        revision_id: revision,
        request_id: bundle.request_id,
        expected_store_root: storeRoot
      })).rejects.toThrow(/unsafe namespace/);

      await expect(loadPlanningArtifactRef({
        store,
        artifact_id: planning.artifact_id,
        artifact_digest: planning.artifact_digest,
        production_id: "production",
        project_id: "project",
        revision_id: revision,
        request_id: bundle.request_id,
        expected_store_root: join(root, "other-store")
      })).rejects.toThrow(/store root is not the trusted/);

      await expect(loadPlanningArtifactRef({
        store,
        artifact_id: "planning-production-project-wrong-revision-loader-1",
        artifact_digest: planning.artifact_digest,
        production_id: "production",
        project_id: "project",
        revision_id: revision,
        request_id: bundle.request_id,
        expected_store_root: storeRoot
      })).rejects.toThrow(/namespace does not match/);

      await expect(loadPlanningArtifactRef({
        store,
        artifact_id: planning.artifact_id,
        artifact_digest: "0".repeat(64),
        production_id: "production",
        project_id: "project",
        revision_id: revision,
        request_id: bundle.request_id,
        expected_store_root: storeRoot
      })).rejects.toThrow(/bytes changed or were copied/);

      // Non-canonical whitespace padding is rejected even with a matching digest of padded bytes.
      const paddedRoot = join(root, "padded");
      await mkdir(paddedRoot);
      const paddedStore = new ArtifactStore(paddedRoot);
      const paddedBytes = Buffer.from(` ${JSON.stringify(bundle)} `, "utf8");
      const paddedDigest = createHash("sha256").update(paddedBytes).digest("hex");
      const paddedId = `planning-production-project-${revision}-${bundle.request_id}`;
      await paddedStore.create({ artifact_id: paddedId, bytes: paddedBytes });
      await expect(loadPlanningArtifactRef({
        store: paddedStore,
        artifact_id: paddedId,
        artifact_digest: paddedDigest,
        production_id: "production",
        project_id: "project",
        revision_id: revision,
        request_id: bundle.request_id,
        expected_store_root: paddedRoot
      })).rejects.toThrow(/not a strict compilation bundle|not canonical|stale or execution-capable/);

      // Execution-capable payload cannot become planning authority.
      // Rebuild digests so verifyCompilationBundle accepts the structural flip;
      // the loader must still reject with the exact execution-capable identity error.
      const executionShaped = JSON.parse(JSON.stringify(bundle)) as Record<string, any>;
      executionShaped.execution_capable = true;
      executionShaped.effective_contract.execution.status = "execution-capable";
      const effectiveBody = { ...executionShaped.effective_contract };
      delete effectiveBody.digest;
      executionShaped.effective_contract.digest = sha256Canonical(effectiveBody);
      executionShaped.effective_contract_digest = executionShaped.effective_contract.digest;
      executionShaped.compilation_digest = sha256Canonical(Object.fromEntries(
        Object.entries(executionShaped).filter(([key]) => key !== "compilation_digest")
      ));
      expect(() => verifyCompilationBundle(executionShaped)).not.toThrow();
      const execBytes = Buffer.from(JSON.stringify(executionShaped), "utf8");
      const execRoot = join(root, "exec-store");
      await mkdir(execRoot);
      const execStore = new ArtifactStore(execRoot);
      const execRevision = compilationRevisionId({ compilation_digest: executionShaped.compilation_digest } as never);
      const execId = `planning-production-project-${execRevision}-${bundle.request_id}`;
      await execStore.create({ artifact_id: execId, bytes: execBytes });
      await expect(loadPlanningArtifactRef({
        store: execStore,
        artifact_id: execId,
        artifact_digest: createHash("sha256").update(execBytes).digest("hex"),
        production_id: "production",
        project_id: "project",
        revision_id: execRevision,
        request_id: bundle.request_id,
        expected_store_root: execRoot
      })).rejects.toThrow(/VPD-K003: planning authority identity is stale or execution-capable/);

      // Tamper after persist: rewrite artifact bytes under the same id is create-only rejected;
      // a second store with same namespace but different bytes fails digest match on reload.
      const reloaded = await loadPlanningArtifactRef({
        store,
        artifact_id: planning.artifact_id,
        artifact_digest: planning.artifact_digest,
        production_id: "production",
        project_id: "project",
        revision_id: revision,
        request_id: bundle.request_id,
        expected_store_root: storeRoot
      });
      expect(reloaded.artifact_digest).toBe(planning.artifact_digest);
      expect(reloaded.request_id).toBe(bundle.request_id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects lease creation without full expected binding and keeps disabled/shadow asset paths fail-closed", async () => {
    // Lease binding: forged JSON-shaped objects never mint or consume a lease.
    expect(() => createExecutionSubmissionLease({ execution_capable: true } as never)).toThrow(/VPD-K003/);
    expect(() => createExecutionSubmissionLease({} as never, {
      production_id: "production",
      project_id: "project",
      revision_id: "revision-1",
      request_id: "req-1",
      attempt_id: "attempt-1",
      job_id: "job-1",
      compilation_digest: "0".repeat(64),
      effective_contract_digest: "0".repeat(64),
      asset_lineage_digest: "0".repeat(64)
    } as never)).toThrow(/VPD-K003/);
    expect(() => consumeExecutionSubmissionLease({ kind: "video-prompt-execution-submission-lease" } as never, {
      production_id: "production",
      project_id: "project",
      revision_id: "revision-1",
      request_id: "req-1",
      attempt_id: "attempt-1",
      job_id: "job-1",
      compilation_digest: "0".repeat(64),
      effective_contract_digest: "0".repeat(64),
      asset_lineage_digest: "0".repeat(64)
    } as never)).toThrow(/VPD-K003/);

    // Disabled mode: raw image/video assets stay local and do not open production-control authority.
    const disabledRoot = await mkdtemp(join(tmpdir(), "tsugite-po4-disabled-asset-"));
    try {
      await writeFile(join(disabledRoot, "project.yaml"), await readFile("examples/h3-prompt-director/project.yaml", "utf8"));
      await writeFile(join(disabledRoot, "manifest.json"), await readFile("examples/h3-prompt-director/manifest.json", "utf8"));
      await mkdir(join(disabledRoot, "media"));
      await copyFile("examples/h3-prompt-director/media/clip-001.mp4", join(disabledRoot, "media", "clip-001.mp4"));
      const disabled = await validateProject(join(disabledRoot, "project.yaml"));
      expect(disabled.ok).toBe(true);
      await expect(stat(join(disabledRoot, "production-control"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(disabledRoot, { recursive: true, force: true });
    }

    // Shadow mode: comparison may write, but does not promote native V2 as authority and fails closed on bad asset refs.
    const shadowRoot = await mkdtemp(join(tmpdir(), "tsugite-po4-shadow-asset-fail-"));
    try {
      const sourceProject = await readFile("examples/h3-prompt-director/project.yaml", "utf8");
      const shadowProject = sourceProject.replace(
        "edit:\n",
        "orchestration:\n  mode: shadow\n  authoring:\n    assets:\n      kind: asset-contract\n      id: missing-shadow-asset\n      digest: " + "a".repeat(64) + "\nedit:\n"
      );
      await writeFile(join(shadowRoot, "project.yaml"), shadowProject);
      await writeFile(join(shadowRoot, "manifest.json"), await readFile("examples/h3-prompt-director/manifest.json", "utf8"));
      await mkdir(join(shadowRoot, "media"));
      await copyFile("examples/h3-prompt-director/media/clip-001.mp4", join(shadowRoot, "media", "clip-001.mp4"));
      const shadow = await validateProject(join(shadowRoot, "project.yaml"));
      // Shadow must never promote native V2 under production-control planning authority.
      await expect(stat(join(shadowRoot, "production-control", "video-prompt-planning"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(shadowRoot, "production-control"))).rejects.toMatchObject({ code: "ENOENT" });
      // Missing authoring asset contracts are advisory in shadow; validation stays open
      // while comparison artifacts may write under dist/shadow only.
      expect(shadow.ok).toBe(true);
    } finally {
      await rm(shadowRoot, { recursive: true, force: true });
    }
  });

  it("rejects atomic publication when target already exists, marker is invalid, or cleanup identity changes", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalone(), {
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const bundle = compiled.compilation.bundle;
    const revision = compilationRevisionId(bundle);

    // Existing directory without allow flag: hard no-replace.
    const rootA = await realpath(await mkdtemp(join(tmpdir(), "tsugite-po4-pub-exists-")));
    try {
      await writeCompilationBundleAtomic(rootA, bundle, {
        project_root: rootA,
        revision_id: revision,
        request_id: bundle.request_id
      });
      await expect(writeCompilationBundleAtomic(rootA, bundle, {
        project_root: rootA,
        revision_id: revision,
        request_id: bundle.request_id
      })).rejects.toThrow(/already exists/);
    } finally {
      await rm(rootA, { recursive: true, force: true });
    }

    // Orphan directory (no commit marker) with allow_existing_same_digest is quarantined then republished.
    const rootB = await realpath(await mkdtemp(join(tmpdir(), "tsugite-po4-pub-orphan-")));
    try {
      const parent = join(rootB, revision, "video-prompt");
      const target = join(parent, bundle.request_id);
      await mkdir(target, { recursive: true, mode: 0o700 });
      await writeFile(join(target, "orphan.txt"), "leftover\n");
      await writeCompilationBundleAtomic(rootB, bundle, {
        project_root: rootB,
        revision_id: revision,
        request_id: bundle.request_id,
        allow_existing_same_digest: true
      });
      const published = readCompilationBundleAtomic(rootB, {
        project_root: rootB,
        revision_id: revision,
        request_id: bundle.request_id
      });
      expect(published.bundle.compilation_digest).toBe(bundle.compilation_digest);
      const siblings = await readdir(parent);
      expect(siblings.some((name) => name.includes("quarantine"))).toBe(true);
    } finally {
      await rm(rootB, { recursive: true, force: true });
    }

    // Invalid committed marker with allow_existing_same_digest fails closed (does not silently adopt).
    const rootC = await realpath(await mkdtemp(join(tmpdir(), "tsugite-po4-pub-bad-marker-")));
    try {
      const parent = join(rootC, revision, "video-prompt");
      const target = join(parent, bundle.request_id);
      await mkdir(target, { recursive: true, mode: 0o700 });
      await writeFile(join(target, "compilation-manifest.json"), JSON.stringify({ committed: true, broken: true }));
      await expect(writeCompilationBundleAtomic(rootC, bundle, {
        project_root: rootC,
        revision_id: revision,
        request_id: bundle.request_id,
        allow_existing_same_digest: true
      })).rejects.toThrow(/VPD-K002: committed compilation manifest is invalid/);
    } finally {
      await rm(rootC, { recursive: true, force: true });
    }

    // Failed link path rejects with the pre-link error. Cleanup-hook exceptions on
    // the failure path are swallowed so the original publication failure stays visible.
    const rootD = await realpath(await mkdtemp(join(tmpdir(), "tsugite-po4-pub-cleanup-")));
    try {
      await expect(writeCompilationBundleAtomic(rootD, bundle, {
        project_root: rootD,
        revision_id: revision,
        request_id: bundle.request_id,
        hooks: {
          before_link: async () => {
            throw new Error("publication-before-link");
          },
          before_cleanup: async () => {
            throw new Error("cleanup identity changed");
          }
        }
      })).rejects.toThrow(/^publication-before-link$/);
      await expect(stat(join(rootD, revision, "video-prompt", bundle.request_id))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(rootD, { recursive: true, force: true });
    }

    // Reachable cleanup identity failure: mid-flight same-digest adoption leaves
    // the staging directory in place, so success-path cleanup runs and must fail closed.
    const rootCleanup = await realpath(await mkdtemp(join(tmpdir(), "tsugite-po4-pub-cleanup-identity-")));
    const rootCleanupRef = await realpath(await mkdtemp(join(tmpdir(), "tsugite-po4-pub-cleanup-ref-")));
    try {
      await writeCompilationBundleAtomic(rootCleanupRef, bundle, {
        project_root: rootCleanupRef,
        revision_id: revision,
        request_id: bundle.request_id
      });
      const refTarget = join(rootCleanupRef, revision, "video-prompt", bundle.request_id);
      const cleanupTarget = join(rootCleanup, revision, "video-prompt", bundle.request_id);
      await expect(writeCompilationBundleAtomic(rootCleanup, bundle, {
        project_root: rootCleanup,
        revision_id: revision,
        request_id: bundle.request_id,
        allow_existing_same_digest: true,
        hooks: {
          before_target_reserve: async () => {
            await mkdir(join(rootCleanup, revision, "video-prompt"), { recursive: true, mode: 0o700 });
            await cp(refTarget, cleanupTarget, { recursive: true });
          },
          before_cleanup: async () => {
            throw new Error("cleanup identity changed");
          }
        }
      })).rejects.toThrow(/^cleanup identity changed$/);
      // Same-digest target remains published; staging is left quarantined.
      expect(readCompilationBundleAtomic(rootCleanup, {
        project_root: rootCleanup,
        revision_id: revision,
        request_id: bundle.request_id
      }).bundle.compilation_digest).toBe(bundle.compilation_digest);
      const siblings = await readdir(join(rootCleanup, revision, "video-prompt"));
      expect(siblings.some((name) => name.endsWith(".tmp"))).toBe(true);
    } finally {
      await rm(rootCleanup, { recursive: true, force: true });
      await rm(rootCleanupRef, { recursive: true, force: true });
    }

    // before_marker_write failure aborts without publishing the target.
    const rootE = await realpath(await mkdtemp(join(tmpdir(), "tsugite-po4-pub-marker-hook-")));
    try {
      await expect(writeCompilationBundleAtomic(rootE, bundle, {
        project_root: rootE,
        revision_id: revision,
        request_id: bundle.request_id,
        hooks: {
          before_marker_write: async () => {
            throw new Error("marker write blocked");
          }
        }
      })).rejects.toThrow(/^marker write blocked$/);
      await expect(stat(join(rootE, revision, "video-prompt", bundle.request_id))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(rootE, { recursive: true, force: true });
    }
  });

  it("rejects review Gate1 when current asset contract is missing or stale", async () => {
    const raw = await mkdtemp(join(tmpdir(), "tsugite-po4-review-surface-"));
    const root = await realpath(raw);
    try {
      const bytes = Buffer.from("review-surface-asset\n", "utf8");
      await mkdir(join(root, "media"));
      await writeFile(join(root, "media", "reference.bin"), bytes);
      await copyFile("examples/h3-prompt-director/media/clip-001.mp4", join(root, "media", "clip-001.mp4"));
      const contract = createAssetContract({
        contract_id: "review-surface",
        revision: 1,
        assets: [{
          asset_id: "reference",
          kind: "image",
          project_relative_path: "media/reference.bin",
          sha256: sha256Text(bytes.toString("utf8")),
          byte_size: bytes.byteLength,
          roles: ["first-frame"],
          provenance: { source: "user", usage_confirmed: true },
          external_send: "allowed"
        }]
      });
      await mkdir(join(root, "production-control"));
      const store = new ArtifactStore(join(root, "production-control"));
      await store.create({ artifact_id: contract.contract_id, bytes: JSON.stringify(contract) });
      const ir = standalone("v6");
      ir.target = { ...ir.target, mode: "first-frame" };
      ir.assets = [{ id: "reference", type: "image", path: "media/reference.bin", role: "first_frame", sha256: contract.assets[0]!.sha256 }];
      const configPath = join(root, "project.yaml");
      await writeFile(configPath, JSON.stringify({
        slug: "review-surface",
        name: "review-surface",
        manifest: "manifest.json",
        dist_dir: "dist",
        edit: { backend: "remotion" },
        orchestration: { mode: "active", authoring: { assets: { kind: "asset-contract", id: contract.contract_id, digest: contract.digest } } },
        generation: { connection: "pixverse", adapter: "pixverse", requests: [{ id: "surface-review-1", prompt: "", params: {}, video_prompt: ir }] }
      }));
      await writeFile(join(root, "manifest.json"), await readFile("examples/h3-prompt-director/manifest.json", "utf8"));
      const validation = await validateProject(configPath);
      expect(validation.ok, validation.ok ? "" : JSON.stringify(validation.issues)).toBe(true);
      if (!validation.ok) return;
      const plan = createPlan(validation.project, validation.manifest, validation.adapter, undefined, validation.promptGuides, validation.audioAdapter, validation.generationConnection, validation.audioConnection, validation.backend, validation.h3_compilations, validation.video_prompt_plans);
      const stateDir = join(root, "review-state");
      await writeCreativeReview({ configPath, project: validation.project, manifest: validation.manifest, plan, stateDir });
      const fresh = await inspectGate1Review({ configPath, project: validation.project, manifest: validation.manifest, stateDir });
      expect(fresh.ok, fresh.ok ? "" : JSON.stringify(fresh.issues)).toBe(true);

      // Missing contract artifact after review write: freshness fails closed.
      await rm(join(root, "production-control", "artifacts", `${contract.contract_id}.json`), { force: true });
      const missing = await inspectGate1Review({ configPath, project: validation.project, manifest: validation.manifest, stateDir });
      expect(missing.ok).toBe(false);
      expect(missing.issues.map((issue) => issue.code)).toContain("VPD-J002");

      // Restore then digest mismatch: still fail closed.
      await store.create({ artifact_id: contract.contract_id, bytes: JSON.stringify(contract) });
      const mutated = createAssetContract({
        contract_id: contract.contract_id,
        revision: 3,
        assets: [{ ...contract.assets[0]!, external_send: "forbidden" }]
      });
      await writeFile(join(root, "production-control", "artifacts", `${contract.contract_id}.json`), JSON.stringify(mutated));
      const stale = await inspectGate1Review({ configPath, project: validation.project, manifest: validation.manifest, stateDir });
      expect(stale.ok).toBe(false);
      expect(stale.issues.map((issue) => issue.code)).toContain("VPD-J002");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
