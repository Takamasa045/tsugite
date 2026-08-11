import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/productionControl/artifactStore.js";
import {
  compileProjectVideoPrompts,
  compileVideoPromptIrV2,
  buildSemanticBlocks,
  DEFAULT_H3_GRAMMAR_PROFILE_V3,
  adoptExecutionCompilationBundle,
  loadAdapterDialectCapability,
  loadConnectionCapabilityProfile,
  loadCreateOnlyArtifactStoreEnvelope,
  createExecutionCompilationBundleArtifact,
  loadModelPromptProfile,
  loadPinnedH3GrammarProfile,
  isTrustedH3GrammarProfile,
  routeFromProfiles,
  writeCompilationBundleAtomic,
  readCompilationBundleAtomic,
  writeShadowComparisonAtomic,
  createVerifiedAssetPin,
  verifyVerifiedAssetPin,
  isTrustedAssetPin,
  isProjectAssetIdentityContained,
  verifyCompilationBundle,
  buildAdapterLabelMap,
  compileAdapterDialect,
  validateAdapterDialect,
  resolveRendererDialectCapability,
  type VideoPromptIrV2
} from "../src/videoPromptDirector/index.js";
import { sha256Canonical, sha256Text } from "../src/integrity/canonical.js";
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
      const target = join(root, "revision-1", "video-prompt", compiled.compilation.bundle.request_id);
      await writeCompilationBundleAtomic(root, compiled.compilation.bundle, { project_root: root, revision_id: "revision-1", request_id: compiled.compilation.bundle.request_id });
      expect((await stat(target)).isDirectory()).toBe(true);
      const marker = JSON.parse(await readFile(join(target, "compilation-manifest.json"), "utf8")) as { compilation_digest: string };
      expect(marker.compilation_digest).toBe(compiled.compilation.bundle.compilation_digest);
      for (const file of ["ir.normalized.json", "semantic-blocks.json", "labels.json", "prompt.canonical.txt", "prompt.pixverse.txt"]) {
        expect((await stat(join(target, file))).isFile(), file).toBe(true);
      }
      const persisted = JSON.parse(await readFile(join(target, "bundle.json"), "utf8")) as Record<string, unknown>;
      await writeFile(join(target, "bundle.json"), JSON.stringify({ ...persisted, canonical_prompt: "tampered" }));
      await expect(writeCompilationBundleAtomic(root, compiled.compilation.bundle, { project_root: root, revision_id: "revision-1", request_id: compiled.compilation.bundle.request_id, allow_existing_same_digest: true })).rejects.toThrow(/VPD-K002/);
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
      const writer = writeCompilationBundleAtomic as unknown as (
        root: string,
        bundle: typeof compiled.compilation.bundle,
        options: { project_root: string; revision_id: string; request_id: string; allow_existing_same_digest?: boolean }
      ) => Promise<void>;
      await writer(root, compiled.compilation.bundle, {
        project_root: root,
        revision_id: "plan-1",
        request_id: compiled.compilation.bundle.request_id,
        allow_existing_same_digest: true
      });
      await writer(root, compiled.compilation.bundle, {
        project_root: root,
        revision_id: "plan-2",
        request_id: compiled.compilation.bundle.request_id,
        allow_existing_same_digest: true
      });
      expect((await stat(join(root, "plan-1", "video-prompt", compiled.compilation.bundle.request_id))).isDirectory()).toBe(true);
      expect((await stat(join(root, "plan-2", "video-prompt", compiled.compilation.bundle.request_id))).isDirectory()).toBe(true);
      await writeFile(join(root, "plan-1", "video-prompt", compiled.compilation.bundle.request_id, "canonical-prompt.txt"), "tampered\n");
      expect(() => readCompilationBundleAtomic(root, {
        project_root: root,
        revision_id: "plan-1",
        request_id: compiled.compilation.bundle.request_id
      })).toThrow(/VPD-K002/);
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
      })).toThrow(/VPD-(?:K003|C003)/);
      const exactEnvelope = await createExecutionCompilationBundleArtifact({ store, bundle: forged, revision_id: "plan-1" });
      expect(exactEnvelope.raw_bytes_digest).toBe(exactEnvelope.artifact_digest);
      expect(exactEnvelope.compilation_digest).toBe(forged.compilation_digest);
      expect(exactEnvelope.request_id).toBe(forged.request_id);
      expect(exactEnvelope.revision_id).toBe("plan-1");
      expect(() => adoptExecutionCompilationBundle(forged, {
        effective_contract: forgedContract,
        grammar_profile: pinnedGrammar,
        trusted_pinned_budget_evidence: {},
        asset_pins: {},
        revision_id: "plan-1",
        artifact_store_envelope: exactEnvelope
      })).toThrow(/VPD-(?:K003|C003)/);
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
      })).toThrow(/VPD-(?:K003|C003)/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
      expect(isProjectAssetIdentityContained(realRoot, join(realRoot, "..", "outside"))).toBe(false);
      expect(() => createVerifiedAssetPin({ ...input, asset_id: "voice" })).toThrow(/EEXIST|VPD-J002/);
      expect(() => createVerifiedAssetPin({ ...input, pin_root: join(realRoot, "..", "outside") })).toThrow(/VPD-J002/);
      expect(() => verifyVerifiedAssetPin(pin, { project_root: realRoot, pin_root: input.pin_root, expected_sha256: sha256Text("BBBB") })).toThrow(/VPD-J002/);
      await rm(join(realRoot, "new-pins", "asset-pins", "voice.bin"));
      await symlink(source, join(realRoot, "new-pins", "asset-pins", "voice.bin"));
      expect(() => verifyVerifiedAssetPin(pin, { project_root: realRoot, pin_root: input.pin_root })).toThrow(/VPD-J002/);
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
      const options = { project_root: root, revision_id: "revision-1", request_id: compiled.compilation.bundle.request_id };
      await writeCompilationBundleAtomic(root, compiled.compilation.bundle, options);
      await expect(writeCompilationBundleAtomic(root, compiled.compilation.bundle, { ...options, allow_existing_same_digest: true })).resolves.toBeUndefined();
      await rm(join(root, "revision-1", "video-prompt", compiled.compilation.bundle.request_id, "compilation-manifest.json"));
      await expect(writeCompilationBundleAtomic(root, compiled.compilation.bundle, { ...options, allow_existing_same_digest: true })).resolves.toBeUndefined();
      await expect(writeCompilationBundleAtomic(root, compiled.compilation.bundle, { ...options, request_id: "../escape" })).rejects.toThrow(/VPD-K002/);
      const target = join(root, "revision-1", "video-prompt", compiled.compilation.bundle.request_id);
      expect(readCompilationBundleAtomic(target, { project_root: root }).bundle.compilation_digest).toBe(compiled.compilation.bundle.compilation_digest);

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
      await expect(writeShadowComparisonAtomic(root, comparison, { project_root: "", revision_id: "revision-2" })).rejects.toThrow(/VPD-K002/);
    } finally {
      await rm(root, { recursive: true, force: true });
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

  it("rejects forged create-only envelope inputs before any execution adoption", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-envelope-failures-"));
    try {
      const storeRoot = join(await realpath(root), "artifacts");
      await mkdir(storeRoot, { recursive: true });
      const store = new ArtifactStore(storeRoot);
      const stored = await store.create({ artifact_id: "raw", bytes: "raw artifact" });
      await expect(loadCreateOnlyArtifactStoreEnvelope({ store, artifact_id: stored.artifact_id, artifact_digest: "z".repeat(64) })).rejects.toThrow(/VPD-K003/);
      await expect(loadCreateOnlyArtifactStoreEnvelope({ store, artifact_id: stored.artifact_id, artifact_digest: "0".repeat(64) })).rejects.toThrow(/VPD-K003/);
      await expect(loadCreateOnlyArtifactStoreEnvelope({ store: {} as ArtifactStore, artifact_id: stored.artifact_id, artifact_digest: stored.sha256 })).rejects.toThrow(/VPD-K003/);
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
    expect(generationUnitResolver.materializeGenerationUnitLyrics(forged)).toBeUndefined();
  });
});
