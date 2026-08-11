import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/productionControl/artifactStore.js";
import {
  compileProjectVideoPrompts,
  compileVideoPromptIrV2,
  DEFAULT_H3_GRAMMAR_PROFILE_V3,
  adoptExecutionCompilationBundle,
  loadAdapterDialectCapability,
  loadConnectionCapabilityProfile,
  loadCreateOnlyArtifactStoreEnvelope,
  loadModelPromptProfile,
  loadPinnedH3GrammarProfile,
  isTrustedH3GrammarProfile,
  routeFromProfiles,
  writeCompilationBundleAtomic,
  verifyCompilationBundle,
  type VideoPromptIrV2
} from "../src/videoPromptDirector/index.js";
import { sha256Canonical } from "../src/integrity/canonical.js";
import * as generationUnitResolver from "../src/videoPromptDirector/generationUnitSourceResolver.js";

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

  it("does not expose a mutable lyrics source getter from the public resolver boundary", async () => {
    expect("lyricsSourceForGenerationUnitSource" in generationUnitResolver).toBe(false);
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
      const target = join(root, "compilation");
      await writeCompilationBundleAtomic(target, compiled.compilation.bundle);
      expect((await stat(target)).isDirectory()).toBe(true);
      const marker = JSON.parse(await readFile(join(target, "compilation-manifest.json"), "utf8")) as { compilation_digest: string };
      expect(marker.compilation_digest).toBe(compiled.compilation.bundle.compilation_digest);
      const persisted = JSON.parse(await readFile(join(target, "bundle.json"), "utf8")) as Record<string, unknown>;
      await writeFile(join(target, "bundle.json"), JSON.stringify({ ...persisted, canonical_prompt: "tampered" }));
      await expect(writeCompilationBundleAtomic(target, compiled.compilation.bundle, { allow_existing_same_digest: true })).rejects.toThrow(/VPD-K002/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("separates structural bundle parsing from execution authority adoption", async () => {
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
    const { digest: _contractDigest, ...effectiveBody } = compiled.compilation.bundle.effective_contract;
    const contractWithoutDigest = {
      ...effectiveBody,
      execution: {
        ...compiled.compilation.bundle.effective_contract.execution,
        status: "execution-capable" as const
      }
    };
    const forgedContract = { ...contractWithoutDigest, digest: sha256Canonical(contractWithoutDigest) };
    const { compilation_digest: _bundleDigest, ...bundleBody } = compiled.compilation.bundle;
    const forgedBody = {
      ...bundleBody,
      effective_contract: forgedContract,
      effective_contract_digest: forgedContract.digest,
      execution_capable: true
    };
    const forged = { ...forgedBody, compilation_digest: sha256Canonical(forgedBody) };
    expect(() => verifyCompilationBundle(forged)).not.toThrow();
    const pinnedGrammar = await loadPinnedH3GrammarProfile();
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-envelope-"));
    try {
      const realRoot = await realpath(root);
      const storeRoot = join(realRoot, "artifacts");
      const store = new ArtifactStore(storeRoot);
      await mkdir(storeRoot, { recursive: true });
      const stored = await store.create({ artifact_id: forged.request_id, bytes: "fixture-only artifact" });
      const trustedEnvelope = await loadCreateOnlyArtifactStoreEnvelope({ store, artifact_id: stored.artifact_id, artifact_digest: stored.sha256 });
      expect(() => adoptExecutionCompilationBundle(forged, {
        effective_contract: forgedContract,
        grammar_profile: pinnedGrammar,
        trusted_pinned_budget_evidence: {},
        asset_pins: {},
        artifact_store_envelope: { ...trustedEnvelope }
      })).toThrow(/VPD-K003/);
      expect(() => adoptExecutionCompilationBundle(forged, {
      effective_contract: forgedContract,
      grammar_profile: pinnedGrammar,
      trusted_pinned_budget_evidence: {},
      asset_pins: {},
      artifact_store_envelope: {
        kind: "create-only-artifact-store-envelope",
        create_only: true,
        artifact_id: forged.request_id,
        artifact_digest: "0".repeat(64)
      }
      })).toThrow(/VPD-K003/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
