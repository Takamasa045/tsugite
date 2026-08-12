import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/productionControl/artifactStore.js";
import { sha256Canonical } from "../src/integrity/canonical.js";
import {
  compileVideoPromptIrV2,
  compilationRevisionId,
  consumeExecutionSubmissionLease,
  createExecutionSubmissionLease,
  deriveExecutionCompilationBundleFromPlanningArtifact,
  isAdoptedExecutionCompilationBundle,
  isExecutionAuthoritativePinnedPromptBudgetEvidence,
  isTrustedPinnedPromptBudgetEvidence,
  loadAdapterDialectCapability,
  loadConnectionCapabilityProfile,
  loadExecutionAuthoritativePinnedPromptBudgetEvidence,
  loadModelPromptProfile,
  loadPlanningArtifactRef,
  loadPlanningOnlyPinnedPromptBudgetEvidence,
  releaseExecutionSubmissionInput,
  routeFromProfiles,
  verifyCompilationBundle,
  type VideoPromptIrV2
} from "../src/videoPromptDirector/index.js";
import { persistPlanningCompilationArtifact } from "../src/videoPromptDirector/compilationBundle.js";

function standalonePlainPrompt(model = "v6"): VideoPromptIrV2 {
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
    loadAdapterDialectCapability("pixverse", ["adapters"], {
      model_profile_id: "v6",
      provider_model: "v6",
      mode: "text-to-video"
    })
  ]);
  if (!model.ok || !connection.ok || !adapter.ok) throw new Error("fixture route unavailable");
  const route = routeFromProfiles({
    model: "v6",
    mode: "text-to-video",
    model_profile: model.profile,
    connection_profile: connection.profile,
    model_profile_digest: model.digest,
    connection_profile_digest: connection.digest
  });
  if (!route.ok) throw new Error("fixture route unavailable");
  return { model, connection, adapter, route: route.route };
}

function budgetArtifactBody(input: {
  model_profile_digest: string;
  connection_profile_digest: string;
  route_digest: string;
  source?: "official-api" | "adapter" | "advisory-catalog";
  expires_at?: string;
  source_id?: string;
}) {
  return {
    schema_version: 1 as const,
    source_id: input.source_id ?? "execution-budget-local",
    hard: {
      limit: 20_000,
      unit: "utf8-bytes" as const,
      source: input.source ?? ("official-api" as const),
      verified_at: "2026-08-11T00:00:00Z",
      source_digest: "2".repeat(64)
    },
    soft: null,
    unknown: false as const,
    model_profile_digest: input.model_profile_digest,
    connection_profile_digest: input.connection_profile_digest,
    route_digest: input.route_digest,
    retrieved_at: "2026-08-11T00:00:00Z",
    expires_at: input.expires_at ?? "2099-12-31T00:00:00Z"
  };
}

describe("T05 execution-authoritative pinned prompt budget", () => {
  it("adopts a zero-asset plain-prompt planning bundle via genuine execution budget evidence and one-shot lease", async () => {
    const { model, connection, adapter, route } = await v6Route();
    const compiled = compileVideoPromptIrV2(standalonePlainPrompt(), {
      request_id: "exec-budget-happy-1",
      route,
      model_profile: model.profile,
      model_profile_digest: model.digest,
      connection_profile: connection.profile,
      connection_capability_digest: connection.digest,
      adapter_dialect_capability: adapter.capability
    });
    expect(compiled.ok, JSON.stringify(compiled)).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.compilation.bundle.execution_capable).toBe(false);
    expect(compiled.compilation.bundle.asset_lineage).toEqual([]);
    expect(model.profile.renderer).toBe("plain-prompt");

    const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-t05-exec-budget-happy-")));
    try {
      const storeRoot = join(root, "production-control");
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

      const budgetPath = join(root, "budget-execution.json");
      await writeFile(budgetPath, JSON.stringify(budgetArtifactBody({
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest,
        route_digest: route.route_digest,
        source: "official-api"
      })));

      const fixtureBudget = loadPlanningOnlyPinnedPromptBudgetEvidence({
        artifactPath: budgetPath,
        repoRoot: root,
        route,
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest
      });
      expect(fixtureBudget).toBeDefined();
      if (!fixtureBudget) return;
      expect(isTrustedPinnedPromptBudgetEvidence(fixtureBudget)).toBe(true);
      expect(isExecutionAuthoritativePinnedPromptBudgetEvidence(fixtureBudget)).toBe(false);

      const executionBudget = loadExecutionAuthoritativePinnedPromptBudgetEvidence({
        artifactPath: budgetPath,
        repoRoot: root,
        route,
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest
      });
      expect(executionBudget).toBeDefined();
      if (!executionBudget) return;
      expect(isTrustedPinnedPromptBudgetEvidence(executionBudget)).toBe(true);
      expect(isExecutionAuthoritativePinnedPromptBudgetEvidence(executionBudget)).toBe(true);
      expect(Object.isFrozen(executionBudget)).toBe(true);
      expect(executionBudget.hard?.source).toBe("official-api");

      // Structural twin / raw JSON cannot become authoritative or adopted.
      const rawTwin = JSON.parse(JSON.stringify(executionBudget));
      expect(isTrustedPinnedPromptBudgetEvidence(rawTwin)).toBe(false);
      expect(isExecutionAuthoritativePinnedPromptBudgetEvidence(rawTwin)).toBe(false);

      await expect(deriveExecutionCompilationBundleFromPlanningArtifact({
        planning_artifact: reloaded,
        store,
        production_id: "production",
        project_id: "project",
        revision_id: revision,
        project_root: root,
        asset_pin_root: join(root, "pins"),
        model_profile: model.profile,
        connection_profile: connection.profile,
        trusted_pinned_budget_evidence: fixtureBudget
      })).rejects.toThrow(/unknown or not authoritative/);

      const derived = await deriveExecutionCompilationBundleFromPlanningArtifact({
        planning_artifact: reloaded,
        store,
        production_id: "production",
        project_id: "project",
        revision_id: revision,
        project_root: root,
        asset_pin_root: join(root, "pins"),
        model_profile: model.profile,
        connection_profile: connection.profile,
        trusted_pinned_budget_evidence: executionBudget
      });
      expect(isAdoptedExecutionCompilationBundle(derived.bundle)).toBe(true);
      expect(derived.bundle.execution_capable).toBe(true);
      expect(derived.bundle.asset_lineage).toEqual([]);
      expect(derived.bundle.effective_contract.effective.prompt_budget.evidence?.digest).toBe(executionBudget.digest);

      const structuralTwin = verifyCompilationBundle(JSON.parse(JSON.stringify(derived.bundle)));
      expect(isAdoptedExecutionCompilationBundle(structuralTwin)).toBe(false);
      expect(() => createExecutionSubmissionLease(structuralTwin as never, {
        production_id: "production",
        project_id: "project",
        revision_id: revision,
        request_id: derived.bundle.request_id,
        attempt_id: "attempt-1",
        job_id: "job-1",
        compilation_digest: derived.bundle.compilation_digest,
        effective_contract_digest: derived.bundle.effective_contract_digest,
        asset_lineage_digest: sha256Canonical(derived.bundle.asset_lineage)
      })).toThrow(/VPD-K003/);

      const binding = {
        production_id: "production",
        project_id: "project",
        revision_id: revision,
        request_id: derived.bundle.request_id,
        attempt_id: "attempt-1",
        job_id: "job-1",
        compilation_digest: derived.bundle.compilation_digest,
        effective_contract_digest: derived.bundle.effective_contract_digest,
        asset_lineage_digest: sha256Canonical(derived.bundle.asset_lineage)
      };
      const lease = createExecutionSubmissionLease(derived.bundle, binding);
      const submission = consumeExecutionSubmissionLease(lease, binding);
      expect(submission.kind).toBe("video-prompt-execution-submission-input");

      // One-shot: second consume is burned.
      expect(() => consumeExecutionSubmissionLease(lease, binding)).toThrow(/not an opaque trusted token|unavailable/);

      // Binding mismatch burns a fresh lease without granting submission.
      const mismatchLease = createExecutionSubmissionLease(derived.bundle, binding);
      expect(() => consumeExecutionSubmissionLease(mismatchLease, {
        ...binding,
        attempt_id: "wrong-attempt"
      })).toThrow(/expected binding does not match/);
      expect(() => consumeExecutionSubmissionLease(mismatchLease, binding)).toThrow(/not an opaque trusted token|unavailable/);

      releaseExecutionSubmissionInput(submission);
      expect(() => releaseExecutionSubmissionInput(submission)).toThrow(/not an opaque trusted token|unavailable/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for symlink, oversize, non-file, mutate-after-mint, route/profile mismatch, expired, and advisory sources", async () => {
    const { model, connection, route } = await v6Route();
    const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-t05-exec-budget-adv-")));
    try {
      const baseBody = budgetArtifactBody({
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest,
        route_digest: route.route_digest,
        source: "official-api"
      });
      const goodPath = join(root, "good.json");
      await writeFile(goodPath, JSON.stringify(baseBody));

      // Happy local load for mutation baseline.
      const first = loadExecutionAuthoritativePinnedPromptBudgetEvidence({
        artifactPath: goodPath,
        repoRoot: root,
        route,
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest
      });
      expect(first).toBeDefined();
      if (!first) return;
      expect(isExecutionAuthoritativePinnedPromptBudgetEvidence(first)).toBe(true);

      // Mutate artifact after mint: already-minted token stays snapshot-bound;
      // re-load of mutated bytes yields a different source_digest (or reject).
      await writeFile(goodPath, JSON.stringify({
        ...baseBody,
        hard: { ...baseBody.hard!, limit: 19_999 }
      }));
      expect(isExecutionAuthoritativePinnedPromptBudgetEvidence(first)).toBe(true);
      const reloadedAfterMutate = loadExecutionAuthoritativePinnedPromptBudgetEvidence({
        artifactPath: goodPath,
        repoRoot: root,
        route,
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest
      });
      expect(reloadedAfterMutate).toBeDefined();
      if (!reloadedAfterMutate) return;
      expect(reloadedAfterMutate.source_digest).not.toBe(first.source_digest);
      expect(reloadedAfterMutate.digest).not.toBe(first.digest);

      // Symlink rejection (lexical path is a symlink).
      const target = join(root, "target-budget.json");
      await writeFile(target, JSON.stringify(baseBody));
      const linkPath = join(root, "linked-budget.json");
      await symlink(target, linkPath);
      expect(loadExecutionAuthoritativePinnedPromptBudgetEvidence({
        artifactPath: linkPath,
        repoRoot: root,
        route,
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest
      })).toBeUndefined();
      // Planning loader also rejects symlinks (unchanged fail-closed semantics).
      expect(loadPlanningOnlyPinnedPromptBudgetEvidence({
        artifactPath: linkPath,
        repoRoot: root,
        route,
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest
      })).toBeUndefined();

      // Oversize rejection.
      const oversizePath = join(root, "oversize.json");
      await writeFile(oversizePath, `${"x".repeat(1 * 1024 * 1024 + 16)}`);
      expect(loadExecutionAuthoritativePinnedPromptBudgetEvidence({
        artifactPath: oversizePath,
        repoRoot: root,
        route,
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest
      })).toBeUndefined();

      // Non-file (directory) rejection.
      const dirPath = join(root, "budget-dir");
      await mkdir(dirPath);
      expect(loadExecutionAuthoritativePinnedPromptBudgetEvidence({
        artifactPath: dirPath,
        repoRoot: root,
        route,
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest
      })).toBeUndefined();

      // Route digest mismatch.
      const routeMismatch = join(root, "route-mismatch.json");
      await writeFile(routeMismatch, JSON.stringify(budgetArtifactBody({
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest,
        route_digest: "0".repeat(64),
        source: "official-api"
      })));
      expect(loadExecutionAuthoritativePinnedPromptBudgetEvidence({
        artifactPath: routeMismatch,
        repoRoot: root,
        route,
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest
      })).toBeUndefined();

      // Model / connection profile mismatch.
      const profileMismatch = join(root, "profile-mismatch.json");
      await writeFile(profileMismatch, JSON.stringify(budgetArtifactBody({
        model_profile_digest: "1".repeat(64),
        connection_profile_digest: connection.digest,
        route_digest: route.route_digest,
        source: "adapter"
      })));
      expect(loadExecutionAuthoritativePinnedPromptBudgetEvidence({
        artifactPath: profileMismatch,
        repoRoot: root,
        route,
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest
      })).toBeUndefined();

      // Expired.
      const expiredPath = join(root, "expired.json");
      await writeFile(expiredPath, JSON.stringify(budgetArtifactBody({
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest,
        route_digest: route.route_digest,
        source: "official-api",
        expires_at: "2020-01-01T00:00:00Z"
      })));
      expect(loadExecutionAuthoritativePinnedPromptBudgetEvidence({
        artifactPath: expiredPath,
        repoRoot: root,
        route,
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest,
        now: "2026-08-12T00:00:00Z"
      })).toBeUndefined();

      // Advisory-catalog is never execution-authoritative (planning may still trust it).
      const advisoryPath = join(root, "advisory.json");
      await writeFile(advisoryPath, JSON.stringify(budgetArtifactBody({
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest,
        route_digest: route.route_digest,
        source: "advisory-catalog"
      })));
      expect(loadExecutionAuthoritativePinnedPromptBudgetEvidence({
        artifactPath: advisoryPath,
        repoRoot: root,
        route,
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest
      })).toBeUndefined();
      const planningAdvisory = loadPlanningOnlyPinnedPromptBudgetEvidence({
        artifactPath: advisoryPath,
        repoRoot: root,
        route,
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest
      });
      expect(planningAdvisory).toBeDefined();
      if (!planningAdvisory) return;
      expect(isTrustedPinnedPromptBudgetEvidence(planningAdvisory)).toBe(true);
      expect(isExecutionAuthoritativePinnedPromptBudgetEvidence(planningAdvisory)).toBe(false);

      // Empty hard/soft with unknown:false is fail-closed for execution.
      const emptyLimitsPath = join(root, "empty-limits.json");
      await writeFile(emptyLimitsPath, JSON.stringify({
        ...baseBody,
        hard: null,
        soft: null
      }));
      expect(loadExecutionAuthoritativePinnedPromptBudgetEvidence({
        artifactPath: emptyLimitsPath,
        repoRoot: root,
        route,
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest
      })).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts adapter source as execution-authoritative and keeps planning loader fixture-only", async () => {
    const { model, connection, route } = await v6Route();
    const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-t05-exec-budget-adapter-")));
    try {
      const path = join(root, "adapter-budget.json");
      await writeFile(path, JSON.stringify(budgetArtifactBody({
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest,
        route_digest: route.route_digest,
        source: "adapter"
      })));
      const execution = loadExecutionAuthoritativePinnedPromptBudgetEvidence({
        artifactPath: path,
        repoRoot: root,
        route,
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest
      });
      expect(execution).toBeDefined();
      if (!execution) return;
      expect(isExecutionAuthoritativePinnedPromptBudgetEvidence(execution)).toBe(true);
      expect(execution.hard?.source).toBe("adapter");

      const planning = loadPlanningOnlyPinnedPromptBudgetEvidence({
        artifactPath: path,
        repoRoot: root,
        route,
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest
      });
      expect(planning).toBeDefined();
      if (!planning) return;
      expect(isTrustedPinnedPromptBudgetEvidence(planning)).toBe(true);
      expect(isExecutionAuthoritativePinnedPromptBudgetEvidence(planning)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
