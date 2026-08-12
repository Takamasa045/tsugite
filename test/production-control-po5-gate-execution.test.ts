/**
 * PO-5 / T06 — GateBundle + Execution Bridge adversarial tests.
 * Fixture-only: no provider, network, DNS, billing, Gate mutation, render, or non-dry-run.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProductionDispatcher,
  assertAuthority,
  assertCurrentGateSubjects,
  assertEventChainIntegrity,
  assertGateBundleExecutable,
  assertActiveBindingRequired,
  assertBindingMatchesGateBundle,
  assertHomogeneousBatchRoutes,
  assertJobRevisionAndIdentity,
  assertNoResubmitOnSubmissionUnknown,
  assertPinnedCompletion,
  assertUnitsMatchBatchRoute,
  bindGateDecision,
  cascadeFromDrift,
  checkAuthority,
  createAttemptLease,
  createCompletionRefFromPinnedJob,
  createGate1Subject,
  createGate2Subject,
  createGate3Subject,
  createGateBundle,
  createGenerationJobApprovalBinding,
  createInitialMissionState,
  createLeaseIndex,
  evaluateGate2AutoPass,
  executeWithSubmissionAuthority,
  findOrphanArtifactIds,
  gateBundleHasUnknownPrice,
  gateDecisionDigest,
  groupUnitsByRoute,
  makeProductionEvent,
  parseGateBundle,
  parseGenerationCompletionRef,
  parseGenerationJobApprovalBinding,
  pricingBindingDigest,
  projectGateBundleForReview,
  reconcileExpiredLease,
  reduceProductionEvent,
  rejectFakeExecutionAuthority,
  registerLease,
  requireMvCompositionIntent,
  resolveSubmissionUnknownAction,
  resumeProductionControl,
  reverifyArtifactEnvelopes,
  routeIdentityKey,
  sha256Canonical,
  withoutField,
  type GateBundle,
  type RouteIdentity
} from "../src/productionControl/index.js";
import { EventStore } from "../src/productionControl/eventStore.js";
import { SnapshotStore } from "../src/productionControl/statePersistence.js";
import { recordGateDecision, markGateAwaiting, createPlannedState } from "../src/orchestrator/stateTransitions.js";
import { legacyReviewDocumentProjection } from "../src/orchestrator/review.js";
import { assertProductionBindingForMode } from "../src/generationJobs/approval.js";
import type { GenerationJobRecord } from "../src/generationJobs/schema.js";
import { isAdoptedExecutionCompilationBundle } from "../src/videoPromptDirector/compilationBundle.js";

const D = (n: number) => n.toString(16).padStart(64, "0").slice(0, 64);
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const DIGEST_E = "e".repeat(64);
const DIGEST_F = "f".repeat(64);
const ZERO = "0".repeat(64);

function route(seed = "r1"): RouteIdentity {
  const base = {
    ir_model: `model-${seed}`,
    provider_model: `provider-${seed}`,
    model_profile_digest: sha256Canonical({ k: "model", seed }),
    connection_id: `conn-${seed}`,
    connection_digest: sha256Canonical({ k: "conn", seed }),
    adapter_id: `adapter-${seed}`,
    transport: "http",
    mode_binding: "text-to-video"
  };
  return { ...base, route_digest: sha256Canonical(base) };
}

function knownPricing(routeId: RouteIdentity) {
  const pricing = {
    status: "known" as const,
    version: "price-v1",
    currency: "USD",
    amount: 1.5,
    max_amount: 3
  };
  return {
    pricing,
    pricing_binding_digest: pricingBindingDigest(pricing, routeId)
  };
}

function unknownPricing(routeId: RouteIdentity) {
  const pricing = {
    status: "unknown" as const,
    version: null,
    currency: null,
    amount: null,
    max_amount: null
  };
  return {
    pricing,
    pricing_binding_digest: pricingBindingDigest(pricing, routeId)
  };
}

function sampleBundle(overrides: Partial<{
  batches: GateBundle["generation_batches"];
  composition_intent_digest?: string;
  selected?: string[];
}> = {}): GateBundle {
  const r = route("main");
  const priced = knownPricing(r);
  return createGateBundle({
    production_id: "prod-1",
    run_id: "run-1",
    production_contract_digest: DIGEST_A,
    contract_set_digest: DIGEST_B,
    task_tree_digest: DIGEST_C,
    selected_artifact_digests: overrides.selected ?? [DIGEST_D],
    ...(overrides.composition_intent_digest
      ? { composition_intent_digest: overrides.composition_intent_digest }
      : {}),
    generation_batches: overrides.batches ?? [
      {
        batch_id: "batch-1",
        route: r,
        ordered_units: [
          {
            ordinal: 0,
            generation_unit_digest: DIGEST_E,
            base_compilation_digest: DIGEST_F,
            program_start_ms: 0,
            program_end_ms: 8_000
          },
          {
            ordinal: 1,
            generation_unit_digest: sha256Canonical({ unit: 2 }),
            base_compilation_digest: sha256Canonical({ compile: 2 }),
            program_start_ms: 8_000,
            program_end_ms: 16_000
          }
        ],
        ...priced
      }
    ],
    review_artifact_digest: sha256Canonical({ review: "storyboard" })
  });
}

function computeDriftedIdentity(binding: { production_id: string; run_id: string; node_id: string; attempt_id: string; generation_job_id: string; approval_digest: string; gate_bundle_digest: string; gate_1_decision_digest: string; request_digest: string; compilation_digest: string; route: RouteIdentity; pricing_binding_digest: string }): string {
  return sha256Canonical({
    kind: "generation-job-immutable-identity",
    schema_version: 1,
    production_id: binding.production_id,
    run_id: binding.run_id,
    node_id: binding.node_id,
    attempt_id: binding.attempt_id,
    generation_job_id: binding.generation_job_id,
    approval_digest: binding.approval_digest,
    gate_bundle_digest: DIGEST_A,
    gate_1_decision_digest: binding.gate_1_decision_digest,
    request_digest: binding.request_digest,
    compilation_digest: binding.compilation_digest,
    route: binding.route,
    pricing_binding_digest: binding.pricing_binding_digest
  });
}

function pinnedJob(overrides: Partial<GenerationJobRecord> = {}): GenerationJobRecord {
  return {
    schema_version: 1,
    job_id: "job-1",
    status: "pinned",
    connection_id: "conn-main",
    model_id: "model-main",
    mode: "text-to-video",
    request: {
      digest: DIGEST_A,
      model_id: "model-main",
      mode: "text-to-video",
      connection_id: "conn-main",
      auth_env_names: [],
      asset_paths: [],
      params: {}
    },
    model_profile_digest: DIGEST_B,
    connection_capability_digest: DIGEST_C,
    pricing: {
      status: "known",
      version: "price-v1",
      currency: "USD",
      amount: 1,
      max_amount: 2
    },
    submit_attempts: 1,
    poll_attempts: 1,
    download_attempts: 1,
    submission_unknown: false,
    artifact: {
      relative_path: "artifacts/out.mp4",
      sha256: DIGEST_D,
      byte_length: 128,
      pinned: true
    },
    cancel_requested: false,
    created_at: "2026-08-12T00:00:00.000Z",
    updated_at: "2026-08-12T00:00:01.000Z",
    revision: 5,
    ...overrides
  } as GenerationJobRecord;
}

describe("PO-5 GateBundle canonical / digest / order / tamper / mixed-route / MV", () => {
  it("is digest-stable under object key reorder and sensitive to array order", () => {
    const bundle = sampleBundle({ composition_intent_digest: DIGEST_A });
    const reordered = parseGateBundle({
      digest: bundle.digest,
      schema_version: bundle.schema_version,
      run_id: bundle.run_id,
      production_id: bundle.production_id,
      task_tree_digest: bundle.task_tree_digest,
      contract_set_digest: bundle.contract_set_digest,
      production_contract_digest: bundle.production_contract_digest,
      review_artifact_digest: bundle.review_artifact_digest,
      composition_intent_digest: bundle.composition_intent_digest,
      selected_artifact_digests: bundle.selected_artifact_digests,
      generation_batches: bundle.generation_batches
    });
    expect(reordered.digest).toBe(bundle.digest);

    const swappedUnits = sampleBundle({
      composition_intent_digest: DIGEST_A,
      batches: [
        {
          ...bundle.generation_batches[0]!,
          ordered_units: [...bundle.generation_batches[0]!.ordered_units].reverse().map((unit, index) => ({
            ...unit,
            ordinal: index
          }))
        }
      ]
    });
    expect(swappedUnits.digest).not.toBe(bundle.digest);
  });

  it("rejects tampered digests and mixed RouteIdentity in one batch", () => {
    const bundle = sampleBundle();
    expect(() => parseGateBundle({ ...bundle, digest: DIGEST_A })).toThrow();
    const r1 = route("a");
    const r2 = route("b");
    expect(() => assertUnitsMatchBatchRoute(r1, [r1, r2])).toThrow(/mix RouteIdentity/);
    expect(() => assertHomogeneousBatchRoutes([{
      ...bundle.generation_batches[0]!,
      route: { ...r1, route_digest: DIGEST_A }
    }])).toThrow(/stale/);
  });

  it("binds MV composition intent and program ranges", () => {
    const withIntent = sampleBundle({ composition_intent_digest: DIGEST_A });
    expect(projectGateBundleForReview(withIntent).composition_intent_bound).toBe(true);
    expect(withIntent.generation_batches[0]!.ordered_units[0]!.program_start_ms).toBe(0);
  });

  it("allows unknown price for review but never for approve/execute", () => {
    const r = route("u");
    const unknown = createGateBundle({
      production_id: "prod-1",
      run_id: "run-1",
      production_contract_digest: DIGEST_A,
      contract_set_digest: DIGEST_B,
      task_tree_digest: DIGEST_C,
      selected_artifact_digests: [],
      generation_batches: [{
        batch_id: "batch-u",
        route: r,
        ordered_units: [{ ordinal: 0, generation_unit_digest: DIGEST_E, base_compilation_digest: DIGEST_F }],
        ...unknownPricing(r)
      }],
      review_artifact_digest: DIGEST_D
    });
    expect(gateBundleHasUnknownPrice(unknown)).toBe(true);
    expect(projectGateBundleForReview(unknown).has_unknown_price).toBe(true);
    expect(() => assertGateBundleExecutable(unknown)).toThrow(/unknown price/);
  });
});

describe("PO-5 Gate subjects / cascade / legacy compatibility", () => {
  it("binds Gate1/2/3 subjects without replacing legacy approved_input_digest", () => {
    const bundle = sampleBundle({ composition_intent_digest: DIGEST_A });
    const legacy = sha256Canonical({ legacy_review: true });
    const g1 = createGate1Subject({
      production_id: "prod-1",
      run_id: "run-1",
      gate_bundle: bundle,
      legacy_approved_input_digest: legacy
    });
    expect(g1.legacy_approved_input_digest).toBe(legacy);
    expect(g1.gate_bundle_digest).toBe(bundle.digest);

    const decision = bindGateDecision({
      gate: "gate_1",
      subject_digest: g1.digest,
      decision: {
        decision_id: "d1",
        decision: "approved",
        actor: "human",
        decided_at: "2026-08-12T00:00:00.000Z"
      },
      legacy_approved_input_digest: legacy,
      decision_source: "human"
    });
    expect(decision.legacy_approved_input_digest).toBe(legacy);

    const g2 = createGate2Subject({
      gate_1_decision_digest: gateDecisionDigest(decision.decision),
      gate_bundle_digest: bundle.digest,
      selected_generation_completion_digests: [DIGEST_A],
      manifest_digest: DIGEST_B,
      technical_qa_digest: DIGEST_C,
      identity_verification_report_digest: DIGEST_D
    });
    const g3 = createGate3Subject({
      gate_2_decision_digest: DIGEST_E,
      gate_2_subject_digest: g2.digest,
      final_artifact_sha256: DIGEST_F,
      render_report_digest: DIGEST_A,
      gate_3_qc_digest: DIGEST_B,
      selected_branch_digest: DIGEST_C
    });
    expect(g3.final_artifact_sha256).toBe(DIGEST_F);
  });

  it("cascades IdentityDefinition to 1→2→3 and IdentityVerification to 2→3 only", () => {
    const definition = cascadeFromDrift(["identity-definition"]);
    expect(definition).toEqual({
      stale_gate_1: true,
      stale_gate_2: true,
      stale_gate_3: true,
      render_forbidden: true,
      finalize_forbidden: true
    });
    const verification = cascadeFromDrift(["identity-verification"]);
    expect(verification).toEqual({
      stale_gate_1: false,
      stale_gate_2: true,
      stale_gate_3: true,
      render_forbidden: true,
      finalize_forbidden: true
    });
    const selected = cascadeFromDrift(["selected-completion", "manifest", "technical-qa"]);
    expect(selected.stale_gate_1).toBe(false);
    expect(selected.stale_gate_2).toBe(true);
    expect(selected.stale_gate_3).toBe(true);
    const finalOnly = cascadeFromDrift(["final-artifact", "render-report", "gate3-qc"]);
    expect(finalOnly.stale_gate_1).toBe(false);
    expect(finalOnly.stale_gate_2).toBe(false);
    expect(finalOnly.stale_gate_3).toBe(true);
    expect(finalOnly.finalize_forbidden).toBe(true);
    expect(finalOnly.render_forbidden).toBe(false);
  });

  it("recomputes live subjects before render/finalize and never widens Gate2 auto-pass", () => {
    const current = {
      gate_1_subject_digest: DIGEST_A,
      gate_1_decision_digest: DIGEST_B,
      gate_2_subject_digest: DIGEST_C,
      gate_2_decision_digest: DIGEST_D,
      gate_3_subject_digest: DIGEST_E,
      gate_3_decision_digest: DIGEST_F
    };
    expect(() => assertCurrentGateSubjects({ phase: "render", current, expected: current })).not.toThrow();
    expect(() => assertCurrentGateSubjects({
      phase: "render",
      current,
      expected: { ...current, gate_2_subject_digest: ZERO }
    })).toThrow(/stale/);
    expect(() => assertCurrentGateSubjects({
      phase: "finalize",
      current: { ...current, gate_3_decision_digest: undefined },
      expected: current
    })).toThrow(/Gate 3/);

    expect(evaluateGate2AutoPass({
      project_opt_in: true,
      credits_consumed: 0,
      newly_generated_assets: 0,
      technical_qa_issue_count: 0,
      has_semantic_qa: false
    }).auto_pass).toBe(true);
    expect(evaluateGate2AutoPass({
      project_opt_in: true,
      credits_consumed: 1,
      newly_generated_assets: 0,
      technical_qa_issue_count: 0,
      has_semantic_qa: false
    }).auto_pass).toBe(false);
  });

  it("preserves legacy Gate transitions and additive production digests", () => {
    let state = createPlannedState("run-legacy");
    state = markGateAwaiting(state, "gate_1");
    state = recordGateDecision(state, "gate_1", "approved", undefined, DIGEST_A, "human", undefined, {
      production_subject_digest: DIGEST_B,
      production_decision_digest: DIGEST_C
    });
    expect(state.gates.gate_1.approved_input_digest).toBe(DIGEST_A);
    expect(state.gates.gate_1.production_subject_digest).toBe(DIGEST_B);
    expect(state.gates.gate_1.production_decision_digest).toBe(DIGEST_C);
    expect(() => recordGateDecision(
      markGateAwaiting(createPlannedState("run-2"), "gate_1"),
      "gate_1",
      "approved",
      undefined,
      DIGEST_A,
      "auto_qc"
    )).toThrow(/human/);

    const stripped = legacyReviewDocumentProjection({
      project: { slug: "x" },
      run: { id: "r", status: "planned", draft: true, gate: "gate-1" },
      motion_design: { summary: "", camera_moves: [], transitions: [], timing_notes: [] },
      characters: [],
      storyboard: [],
      handoffs: [],
      prompt_guidance: [],
      steps: [],
      warnings: [],
      gate_bundle_review: projectGateBundleForReview(sampleBundle())
    } as never);
    expect("gate_bundle_review" in stripped).toBe(false);
  });
});

describe("PO-5 authority / dispatcher / leases", () => {
  it("denies paid until PO-6 and requires Gate1+known price+Coordinator for submit", () => {
    const bundle = sampleBundle();
    expect(checkAuthority({
      role: "generator",
      effect: "paid",
      actor: "coordinator",
      mode: "active",
      is_coordinator: true,
      gate_1_current: true,
      paid_authorization: false
    }).allowed).toBe(false);

    expect(checkAuthority({
      role: "generator",
      effect: "external-submit",
      actor: "coordinator",
      mode: "active",
      is_coordinator: true,
      gate_1_current: true,
      gate_bundle: bundle
    }).allowed).toBe(true);

    expect(checkAuthority({
      role: "generator",
      effect: "external-submit",
      actor: "planner",
      mode: "active",
      is_coordinator: false,
      gate_1_current: true,
      known_price: true
    }).allowed).toBe(false);

    expect(checkAuthority({
      role: "coordinator",
      effect: "render",
      actor: "coordinator",
      mode: "active",
      is_coordinator: true,
      explicit_render_command: true,
      gate_2_current: true
    }).allowed).toBe(true);

    expect(checkAuthority({
      role: "coordinator",
      effect: "render",
      actor: "coordinator",
      mode: "active",
      is_coordinator: true,
      explicit_render_command: false,
      gate_2_current: true
    }).allowed).toBe(false);

    expect(checkAuthority({
      role: "generator",
      effect: "external-submit",
      actor: "coordinator",
      mode: "shadow",
      is_coordinator: true,
      gate_1_current: true,
      known_price: true
    }).allowed).toBe(false);
  });

  it("enforces pure max3 / effectful max1 and rejects duplicate node/attempt leases", () => {
    const dispatcher = new ProductionDispatcher();
    const authority = {
      actor: "coordinator",
      mode: "active" as const,
      is_coordinator: true
    };
    const slots = [0, 1, 2].map((i) => dispatcher.acquire({
      node_id: `pure-${i}`,
      attempt_id: `attempt-pure-${i}`,
      task_revision: 1,
      input_digest: DIGEST_A,
      role: "story",
      effect: "propose",
      authority
    }));
    expect(dispatcher.activePureCount).toBe(3);
    expect(() => dispatcher.acquire({
      node_id: "pure-3",
      attempt_id: "attempt-pure-3",
      task_revision: 1,
      input_digest: DIGEST_A,
      role: "story",
      effect: "read",
      authority
    })).toThrow(/pure worker/);

    const effectful = dispatcher.acquire({
      node_id: "effect-1",
      attempt_id: "attempt-effect-1",
      task_revision: 1,
      input_digest: DIGEST_B,
      role: "generator",
      effect: "external-observe",
      authority
    });
    expect(dispatcher.activeEffectfulCount).toBe(1);
    expect(() => dispatcher.acquire({
      node_id: "effect-2",
      attempt_id: "attempt-effect-2",
      task_revision: 1,
      input_digest: DIGEST_B,
      role: "generator",
      effect: "external-observe",
      authority
    })).toThrow(/effectful worker/);

    for (const slot of slots) dispatcher.release(slot.lease.lease_id);
    dispatcher.release(effectful.lease.lease_id);

    // Duplicate node/attempt leases are rejected by the lease index (independent of concurrency).
    const index = createLeaseIndex();
    const leaseA = createAttemptLease({
      lease_id: "lease-a",
      node_id: "shared-node",
      task_revision: 1,
      attempt_id: "att-a",
      attempt_key: DIGEST_A,
      input_digest: DIGEST_B,
      role: "story",
      effect: "read"
    });
    registerLease(index, leaseA);
    expect(() => registerLease(index, createAttemptLease({
      lease_id: "lease-b",
      node_id: "shared-node",
      task_revision: 1,
      attempt_id: "att-b",
      attempt_key: DIGEST_C,
      input_digest: DIGEST_D,
      role: "story",
      effect: "read"
    }))).toThrow(/duplicate active lease for node/);
    expect(() => registerLease(index, createAttemptLease({
      lease_id: "lease-c",
      node_id: "other-node",
      task_revision: 1,
      attempt_id: "att-a",
      attempt_key: DIGEST_E,
      input_digest: DIGEST_F,
      role: "story",
      effect: "read"
    }))).toThrow(/duplicate active lease for attempt/);
  });

  it("never auto-reruns effectful work on lease expiry", () => {
    const lease = createAttemptLease({
      lease_id: "lease-exp",
      node_id: "node-1",
      task_revision: 1,
      attempt_id: "attempt-1",
      attempt_key: DIGEST_A,
      input_digest: DIGEST_B,
      role: "generator",
      effect: "external-submit",
      acquired_at: "2026-08-12T00:00:00.000Z",
      expires_at: "2026-08-12T00:00:01.000Z"
    });
    const result = reconcileExpiredLease(lease, new Date("2026-08-12T00:01:00.000Z"));
    expect(result.expired).toBe(true);
    expect(result.may_auto_requeue).toBe(false);

    const pure = createAttemptLease({
      lease_id: "lease-pure",
      node_id: "node-2",
      task_revision: 1,
      attempt_id: "attempt-2",
      attempt_key: DIGEST_C,
      input_digest: DIGEST_D,
      role: "story",
      effect: "propose",
      acquired_at: "2026-08-12T00:00:00.000Z",
      expires_at: "2026-08-12T00:00:01.000Z"
    });
    expect(reconcileExpiredLease(pure, new Date("2026-08-12T00:01:00.000Z")).may_auto_requeue).toBe(true);

    const index = createLeaseIndex();
    registerLease(index, lease);
    expect(() => registerLease(index, createAttemptLease({
      lease_id: "other",
      node_id: lease.node_id,
      task_revision: 1,
      attempt_id: "other-attempt",
      attempt_key: DIGEST_E,
      input_digest: DIGEST_F,
      role: "generator",
      effect: "external-submit"
    }))).toThrow(/node/);
  });
});

describe("PO-5 generation bridge / submission_unknown / pin-only / T05 authority", () => {
  it("allows revision increase while rejecting identity drift and rollback", () => {
    assertJobRevisionAndIdentity({
      previous_revision: 3,
      next_revision: 4,
      previous_immutable_identity_digest: DIGEST_A,
      next_immutable_identity_digest: DIGEST_A
    });
    expect(() => assertJobRevisionAndIdentity({
      previous_revision: 4,
      next_revision: 3,
      previous_immutable_identity_digest: DIGEST_A,
      next_immutable_identity_digest: DIGEST_A
    })).toThrow(/roll back/);
    expect(() => assertJobRevisionAndIdentity({
      previous_revision: 3,
      next_revision: 4,
      previous_immutable_identity_digest: DIGEST_A,
      next_immutable_identity_digest: DIGEST_B
    })).toThrow(/identity drifted/);
  });

  it("excludes mutable revision from immutable identity digest", () => {
    const r = route("bind");
    const bindingA = createGenerationJobApprovalBinding({
      production_id: "prod-1",
      run_id: "run-1",
      node_id: "gen-1",
      attempt_id: "att-1",
      generation_job_id: "job-1",
      approval_observed_revision: 1,
      approval_digest: DIGEST_A,
      gate_bundle_digest: DIGEST_B,
      gate_1_decision_digest: DIGEST_C,
      request_digest: DIGEST_D,
      compilation_digest: DIGEST_E,
      route: r,
      pricing_binding_digest: DIGEST_F
    });
    const bindingB = createGenerationJobApprovalBinding({
      ...bindingA,
      approval_observed_revision: 99
    });
    expect(bindingA.immutable_identity_digest).toBe(bindingB.immutable_identity_digest);
    expect(bindingA.approval_observed_revision).not.toBe(bindingB.approval_observed_revision);
  });

  it("creates pin-only completion refs and rejects non-pinned jobs", () => {
    const r = route("pin");
    const binding = createGenerationJobApprovalBinding({
      production_id: "prod-1",
      run_id: "run-1",
      node_id: "gen-1",
      attempt_id: "att-1",
      generation_job_id: "job-1",
      approval_observed_revision: 5,
      approval_digest: DIGEST_A,
      gate_bundle_digest: DIGEST_B,
      gate_1_decision_digest: DIGEST_C,
      request_digest: DIGEST_D,
      compilation_digest: DIGEST_E,
      route: r,
      pricing_binding_digest: DIGEST_F
    });
    const ref = createCompletionRefFromPinnedJob({
      job: pinnedJob(),
      binding,
      verification_digest: sha256Canonical({ verify: true })
    });
    expect(ref.pinned_revision).toBe(5);
    expect(ref.artifact_sha256).toBe(DIGEST_D);
    expect(() => assertPinnedCompletion(pinnedJob({ status: "verified", artifact: { relative_path: "a", sha256: DIGEST_D, byte_length: 1, pinned: false } }))).toThrow(/pinned/);
  });

  it("handles submission_unknown for known and unknown provider ids without resubmit", () => {
    const known = resolveSubmissionUnknownAction({
      status: "submission_unknown",
      submission_unknown: true,
      provider_job_id: "provider-123"
    });
    expect(known).toEqual({ action: "poll_or_download", may_submit: false, provider_job_known: true });

    const unknown = resolveSubmissionUnknownAction({
      status: "submission_unknown",
      submission_unknown: true
    });
    expect(unknown).toEqual({ action: "awaiting_human", may_submit: false, provider_job_known: false });

    expect(() => assertNoResubmitOnSubmissionUnknown({
      status: "submission_unknown",
      submission_unknown: true
    })).toThrow(/resubmit/);
  });

  it("rejects raw/fake authority with adapter invocation 0 and burns mismatched leases", async () => {
    let invocations = 0;
    const fake = { compilation_digest: DIGEST_A, execution_capable: true };
    expect(isAdoptedExecutionCompilationBundle(fake)).toBe(false);
    expect(() => rejectFakeExecutionAuthority(fake)).toThrow(/not execution authority/);

    const failed = await executeWithSubmissionAuthority({
      bundle: fake,
      binding: {
        production_id: "prod-1",
        project_id: "proj-1",
        revision_id: "revision-1",
        request_id: "req-1",
        attempt_id: "att-1",
        job_id: "job-1",
        compilation_digest: DIGEST_A,
        effective_contract_digest: DIGEST_B,
        asset_lineage_digest: DIGEST_C
      },
      hooks: {
        onAdapterInvoke: () => {
          invocations += 1;
        },
        submitEffect: () => {
          throw new Error("should not run");
        }
      }
    });
    expect(failed.ok).toBe(false);
    expect(failed.adapter_invocations).toBe(0);
    expect(invocations).toBe(0);

    // Double-consume / release paths: fake never yields a lease, so no adapter effect.
    const again = await executeWithSubmissionAuthority({
      bundle: JSON.parse(JSON.stringify(sampleBundle())),
      binding: {
        production_id: "prod-1",
        project_id: "proj-1",
        revision_id: "revision-1",
        request_id: "req-1",
        attempt_id: "att-1",
        job_id: "job-1",
        compilation_digest: DIGEST_A,
        effective_contract_digest: DIGEST_B,
        asset_lineage_digest: DIGEST_C
      },
      hooks: { onAdapterInvoke: () => { invocations += 1; } }
    });
    expect(again.ok).toBe(false);
    expect(again.adapter_invocations).toBe(0);
    expect(invocations).toBe(0);
  });

  it("requires production_binding only in active mode", () => {
    const job = pinnedJob({ status: "approved", artifact: undefined, revision: 1 });
    expect(() => assertProductionBindingForMode(job, "disabled")).not.toThrow();
    expect(() => assertProductionBindingForMode(job, "shadow")).not.toThrow();
    expect(() => assertProductionBindingForMode(job, "active")).toThrow(/production_binding/);
    expect(() => assertProductionBindingForMode({
      ...job,
      production_binding: {
        production_id: "prod-1",
        run_id: "run-1",
        node_id: "n1",
        attempt_id: "a1",
        gate_bundle_digest: DIGEST_A,
        immutable_identity_digest: DIGEST_B,
        approval_observed_revision: 1
      }
    }, "active")).not.toThrow();
  });
});

describe("PO-5 resume / events / snapshot / orphan / interleaving", () => {
  it("replays deterministically, rejects gap/duplicate/tamper, and treats snapshot as cache", async () => {
    const root = await mkdtemp(join("/private/tmp", "tsugite-po5-resume-"));
    try {
      const store = new EventStore(root);
      const e1 = await store.append({
        type: "mission-created",
        production_id: "prod-1",
        payload: { mission_digest: DIGEST_A, tree_revision: 1 },
        coordinator_instance_id: "c1"
      });
      await store.append({
        type: "tree-compiled",
        production_id: "prod-1",
        payload: { tree_revision: 1, tree_digest: DIGEST_B },
        coordinator_instance_id: "c1"
      });
      await store.append({
        type: "gate-binding-recorded",
        production_id: "prod-1",
        payload: {
          binding_id: "gb-1",
          gate: "gate_1",
          subject_digest: DIGEST_C,
          decision_digest: DIGEST_D,
          legacy_approved_input_digest: DIGEST_E,
          stale: false
        },
        coordinator_instance_id: "c1"
      });

      const resumed = await resumeProductionControl({
        mode: "active",
        production_id: "prod-1",
        root,
        event_store: store
      });
      expect(resumed.state.applied_event_sequence).toBe(3);
      expect(resumed.state.gate_bindings["gb-1"]?.subject_digest).toBe(DIGEST_C);

      const snapshot = new SnapshotStore(root);
      await snapshot.compareAndSwap(resumed.state, null);
      const withCache = await resumeProductionControl({
        mode: "active",
        production_id: "prod-1",
        root,
        event_store: store,
        snapshot_store: snapshot
      });
      expect(withCache.snapshot_used).toBe(true);
      expect(withCache.state.applied_event_digest).toBe(resumed.state.applied_event_digest);

      // gap / ahead
      expect(() => assertEventChainIntegrity([
        e1,
        makeProductionEvent({
          type: "tree-compiled",
          production_id: "prod-1",
          sequence: 3,
          previous_event_digest: e1.event_digest,
          payload: { tree_revision: 1, tree_digest: DIGEST_B }
        })
      ], "prod-1")).toThrow(/gap|ahead|sequence/);

      // duplicate sequence
      const e2 = makeProductionEvent({
        type: "tree-compiled",
        production_id: "prod-1",
        sequence: 2,
        previous_event_digest: e1.event_digest,
        payload: { tree_revision: 1, tree_digest: DIGEST_B }
      });
      expect(() => assertEventChainIntegrity([e1, e2, e2], "prod-1")).toThrow();

      // tamper previous digest
      const tampered = makeProductionEvent({
        type: "tree-compiled",
        production_id: "prod-1",
        sequence: 2,
        previous_event_digest: ZERO,
        payload: { tree_revision: 1, tree_digest: DIGEST_B }
      });
      // force wrong previous after construction
      const forged = { ...tampered, previous_event_digest: DIGEST_F, event_digest: tampered.event_digest };
      expect(() => assertEventChainIntegrity([e1, forged as typeof e2], "prod-1")).toThrow();

      await expect(resumeProductionControl({
        mode: "shadow",
        production_id: "prod-1",
        root
      })).rejects.toMatchObject({ code: "PC_MODE_INACTIVE" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-verifies artifact envelopes and reports orphans without accepting them", () => {
    let state = createInitialMissionState("prod-1");
    const created = makeProductionEvent({
      type: "mission-created",
      production_id: "prod-1",
      sequence: 1,
      payload: { mission_digest: DIGEST_A, tree_revision: 1 }
    });
    state = reduceProductionEvent(state, created);
    const envelope = {
      schema_version: 1 as const,
      artifact_id: "art-orphan",
      kind: "proposal",
      production_id: "prod-1",
      tree_revision: 1,
      node_id: "node-1",
      task_revision: 1,
      attempt_id: "att-1",
      producer_role: "story",
      input_refs: [],
      contract_bindings: [],
      parent_artifact_ids: [],
      payload: { ok: true },
      payload_digest: sha256Canonical({ ok: true }),
      created_at: "2026-08-12T00:00:00.000Z",
      envelope_digest: ZERO
    };
    const withDigest = {
      ...envelope,
      envelope_digest: sha256Canonical(withoutField(envelope, "envelope_digest"))
    };
    reverifyArtifactEnvelopes(state, [withDigest]);
    expect(findOrphanArtifactIds(state, ["art-orphan", "art-missing"])).toEqual(["art-missing", "art-orphan"]);
  });

  it("records generation-job-bound with revision increase and rejects identity drift", () => {
    let state = createInitialMissionState("prod-1");
    state = reduceProductionEvent(state, makeProductionEvent({
      type: "mission-created",
      production_id: "prod-1",
      sequence: 1,
      payload: { mission_digest: DIGEST_A, tree_revision: 1 }
    }));
    state = reduceProductionEvent(state, makeProductionEvent({
      type: "generation-job-bound",
      production_id: "prod-1",
      sequence: 2,
      previous_event_digest: state.applied_event_digest,
      payload: {
        binding_id: "bind-1",
        generation_job_id: "job-1",
        node_id: "node-1",
        attempt_id: "att-1",
        immutable_identity_digest: DIGEST_A,
        gate_bundle_digest: DIGEST_B,
        approval_observed_revision: 1
      }
    }));
    state = reduceProductionEvent(state, makeProductionEvent({
      type: "generation-job-bound",
      production_id: "prod-1",
      sequence: 3,
      previous_event_digest: state.applied_event_digest,
      payload: {
        binding_id: "bind-1",
        generation_job_id: "job-1",
        node_id: "node-1",
        attempt_id: "att-1",
        immutable_identity_digest: DIGEST_A,
        gate_bundle_digest: DIGEST_B,
        approval_observed_revision: 2
      }
    }));
    expect(state.generation_bindings["bind-1"]?.approval_observed_revision).toBe(2);
    expect(() => reduceProductionEvent(state, makeProductionEvent({
      type: "generation-job-bound",
      production_id: "prod-1",
      sequence: 4,
      previous_event_digest: state.applied_event_digest,
      payload: {
        binding_id: "bind-1",
        generation_job_id: "job-1",
        node_id: "node-1",
        attempt_id: "att-1",
        immutable_identity_digest: DIGEST_C,
        gate_bundle_digest: DIGEST_B,
        approval_observed_revision: 3
      }
    }))).toThrow(/identity/);
  });
});

describe("PO-5 authority assert helpers", () => {
  it("assertAuthority throws on denied effects", () => {
    expect(() => assertAuthority({
      role: "generator",
      effect: "paid",
      actor: "coordinator",
      mode: "active",
      is_coordinator: true,
      gate_1_current: true
    })).toThrow(/PO-6/);
  });

  it("route identity keys distinguish complete routes", () => {
    expect(routeIdentityKey(route("x"))).not.toBe(routeIdentityKey(route("y")));
  });
});

describe("PO-5 branch coverage extras", () => {
  it("covers authority branches for local-write, gate, paid-authorized, and unknown-price submit", () => {
    expect(checkAuthority({
      role: "editor",
      effect: "local-write",
      actor: "coordinator",
      mode: "active",
      is_coordinator: true
    }).allowed).toBe(true);
    expect(checkAuthority({
      role: "editor",
      effect: "local-write",
      actor: "planner",
      mode: "active",
      is_coordinator: false
    }).allowed).toBe(false);
    expect(checkAuthority({
      role: "coordinator",
      effect: "gate",
      actor: "human",
      mode: "active",
      is_coordinator: true,
      human_gate_decision: true
    }).allowed).toBe(true);
    expect(checkAuthority({
      role: "coordinator",
      effect: "gate",
      actor: "human",
      mode: "active",
      is_coordinator: true,
      human_gate_decision: false
    }).allowed).toBe(false);
    expect(checkAuthority({
      role: "generator",
      effect: "paid",
      actor: "coordinator",
      mode: "active",
      is_coordinator: true,
      gate_1_current: true,
      paid_authorization: true
    }).allowed).toBe(true);
    const unknown = createGateBundle({
      production_id: "prod-1",
      run_id: "run-1",
      production_contract_digest: DIGEST_A,
      contract_set_digest: DIGEST_B,
      task_tree_digest: DIGEST_C,
      selected_artifact_digests: [],
      generation_batches: [{
        batch_id: "batch-u2",
        route: route("u2"),
        ordered_units: [{ ordinal: 0, generation_unit_digest: DIGEST_E, base_compilation_digest: DIGEST_F }],
        ...unknownPricing(route("u2"))
      }],
      review_artifact_digest: DIGEST_D
    });
    expect(checkAuthority({
      role: "generator",
      effect: "external-submit",
      actor: "coordinator",
      mode: "active",
      is_coordinator: true,
      gate_1_current: true,
      gate_bundle: unknown
    }).allowed).toBe(false);
    expect(checkAuthority({
      role: "generator",
      effect: "external-submit",
      actor: "coordinator",
      mode: "active",
      is_coordinator: true,
      gate_1_current: true,
      known_price: true
    }).allowed).toBe(true);
    expect(checkAuthority({
      role: "generator",
      effect: "external-submit",
      actor: "coordinator",
      mode: "active",
      is_coordinator: true,
      gate_1_current: false,
      known_price: true
    }).allowed).toBe(false);
    expect(checkAuthority({
      role: "coordinator",
      effect: "render",
      actor: "coordinator",
      mode: "active",
      is_coordinator: true,
      explicit_render_command: true,
      gate_2_current: false
    }).allowed).toBe(false);
    expect(checkAuthority({
      role: "story",
      effect: "paid",
      actor: "story",
      mode: "active",
      is_coordinator: false
    }).allowed).toBe(false);
  });

  it("covers not-applicable pricing, MV intent requirement, and unit grouping", () => {
    const r = route("na");
    const pricing = {
      status: "not-applicable" as const,
      version: null,
      currency: null,
      amount: null,
      max_amount: null
    };
    const bundle = createGateBundle({
      production_id: "prod-1",
      run_id: "run-1",
      production_contract_digest: DIGEST_A,
      contract_set_digest: DIGEST_B,
      task_tree_digest: DIGEST_C,
      selected_artifact_digests: [],
      generation_batches: [{
        batch_id: "batch-na",
        route: r,
        ordered_units: [{ ordinal: 0, generation_unit_digest: DIGEST_E, base_compilation_digest: DIGEST_F }],
        pricing,
        pricing_binding_digest: pricingBindingDigest(pricing, r)
      }],
      review_artifact_digest: DIGEST_D
    });
    expect(() => assertGateBundleExecutable(bundle)).not.toThrow();

    const mv = sampleBundle({ composition_intent_digest: DIGEST_A });
    expect(() => requireMvCompositionIntent(mv)).not.toThrow();
    expect(() => requireMvCompositionIntent(sampleBundle())).toThrow(/composition_intent/);
    const groups = groupUnitsByRoute([
      { route: route("g1"), id: 1 },
      { route: route("g2"), id: 2 },
      { route: route("g1"), id: 3 }
    ]);
    expect(groups.size).toBe(2);
  });

  it("covers gate decision mismatch, auto-pass opt-out, and cascade unknown kind", () => {
    const g1 = createGate1Subject({
      production_id: "prod-1",
      run_id: "run-1",
      gate_bundle: sampleBundle(),
      legacy_approved_input_digest: DIGEST_A
    });
    expect(() => bindGateDecision({
      gate: "gate_1",
      subject_digest: g1.digest,
      decision: {
        decision_id: "d-bad",
        decision: "approved",
        actor: "human",
        decided_at: "2026-08-12T00:00:00.000Z",
        subject_digest: DIGEST_B
      }
    })).toThrow(/subject digest/);
    expect(() => bindGateDecision({
      gate: "gate_1",
      subject_digest: g1.digest,
      decision: {
        decision_id: "d-auto",
        decision: "approved",
        actor: "bot",
        decided_at: "2026-08-12T00:00:00.000Z"
      },
      decision_source: "auto_qc"
    })).toThrow(/human/);
    expect(evaluateGate2AutoPass({
      project_opt_in: false,
      credits_consumed: 0,
      newly_generated_assets: 0,
      technical_qa_issue_count: 0,
      has_semantic_qa: false
    }).auto_pass).toBe(false);
    expect(evaluateGate2AutoPass({
      project_opt_in: true,
      credits_consumed: 0,
      newly_generated_assets: 1,
      technical_qa_issue_count: 0,
      has_semantic_qa: false
    }).blocked_reason).toMatch(/assets/);
    expect(evaluateGate2AutoPass({
      project_opt_in: true,
      credits_consumed: 0,
      newly_generated_assets: 0,
      technical_qa_issue_count: 1,
      has_semantic_qa: false
    }).blocked_reason).toMatch(/QA/);
    expect(evaluateGate2AutoPass({
      project_opt_in: true,
      credits_consumed: 0,
      newly_generated_assets: 0,
      technical_qa_issue_count: 0,
      has_semantic_qa: true
    }).blocked_reason).toMatch(/semantic/);
    expect(() => cascadeFromDrift(["not-a-kind" as never])).toThrow(/unknown gate drift/);
  });

  it("covers generation bridge binding match, active binding, and non-unknown resume errors", () => {
    const bundle = sampleBundle();
    const r = bundle.generation_batches[0]!.route;
    const binding = createGenerationJobApprovalBinding({
      production_id: "prod-1",
      run_id: "run-1",
      node_id: "n1",
      attempt_id: "a1",
      generation_job_id: "job-1",
      approval_observed_revision: 1,
      approval_digest: DIGEST_A,
      gate_bundle_digest: bundle.digest,
      gate_1_decision_digest: DIGEST_B,
      request_digest: DIGEST_C,
      compilation_digest: DIGEST_D,
      route: r,
      pricing_binding_digest: bundle.generation_batches[0]!.pricing_binding_digest
    });
    expect(() => assertBindingMatchesGateBundle(binding, bundle)).not.toThrow();
    expect(() => assertBindingMatchesGateBundle({
      ...binding,
      gate_bundle_digest: DIGEST_A,
      immutable_identity_digest: computeDriftedIdentity(binding)
    }, bundle)).toThrow();
    expect(() => assertActiveBindingRequired("active", undefined)).toThrow(/production binding/);
    expect(() => assertActiveBindingRequired("shadow", undefined)).not.toThrow();
    expect(() => resolveSubmissionUnknownAction({
      status: "approved",
      submission_unknown: false
    })).toThrow(/not in submission_unknown/);
    const parsed = parseGenerationJobApprovalBinding(binding);
    expect(parsed.generation_job_id).toBe("job-1");
    const completion = createCompletionRefFromPinnedJob({
      job: pinnedJob(),
      binding: { ...binding, generation_job_id: "job-1" },
      verification_digest: DIGEST_E
    });
    expect(parseGenerationCompletionRef(completion).digest).toBe(completion.digest);
    expect(() => createCompletionRefFromPinnedJob({
      job: pinnedJob({ job_id: "other" }),
      binding,
      verification_digest: DIGEST_E
    })).toThrow(/job id/);
  });

  it("covers dispatcher expiry reconciliation and lease release", () => {
    const dispatcher = new ProductionDispatcher();
    const pure = dispatcher.acquire({
      node_id: "pure-exp",
      attempt_id: "att-pure-exp",
      task_revision: 1,
      input_digest: DIGEST_A,
      role: "story",
      effect: "propose",
      authority: { actor: "c", mode: "active", is_coordinator: true },
      now: "2026-08-12T00:00:00.000Z",
      ttl_ms: 1
    });
    const effectful = dispatcher.acquire({
      node_id: "eff-exp",
      attempt_id: "att-eff-exp",
      task_revision: 1,
      input_digest: DIGEST_B,
      role: "generator",
      effect: "external-observe",
      authority: { actor: "c", mode: "active", is_coordinator: true },
      now: "2026-08-12T00:00:00.000Z",
      ttl_ms: 1
    });
    void pure;
    void effectful;
    const result = dispatcher.reconcileExpiries(new Date("2026-08-12T00:01:00.000Z"));
    expect(result.expired_pure.length).toBe(1);
    expect(result.expired_effectful.length).toBe(1);
    expect(dispatcher.activePureCount).toBe(0);
    expect(dispatcher.activeEffectfulCount).toBe(1);
    dispatcher.release(effectful.lease.lease_id);
    expect(() => dispatcher.release("missing")).toThrow(/unknown lease/);
  });

  it("covers resume snapshot rebuild and accepted artifact reverify mismatch", async () => {
    const root = await mkdtemp(join("/private/tmp", "tsugite-po5-resume2-"));
    try {
      const store = new EventStore(root);
      await store.append({
        type: "mission-created",
        production_id: "prod-2",
        payload: { mission_digest: DIGEST_A, tree_revision: 1 },
        coordinator_instance_id: "c1"
      });
      const resumed = await resumeProductionControl({
        mode: "active",
        production_id: "prod-2",
        root,
        event_store: store
      });
      const snapshot = new SnapshotStore(root);
      // Corrupt cache: write a snapshot that does not match event replay.
      const forged = {
        ...resumed.state,
        tree_revision: 99
      };
      await snapshot.compareAndSwap(forged, null);
      const rebuilt = await resumeProductionControl({
        mode: "active",
        production_id: "prod-2",
        root,
        event_store: store,
        snapshot_store: snapshot
      });
      expect(rebuilt.snapshot_rebuilt || rebuilt.state.tree_revision === 1).toBe(true);

      let state = createInitialMissionState("prod-3");
      state = reduceProductionEvent(state, makeProductionEvent({
        type: "mission-created",
        production_id: "prod-3",
        sequence: 1,
        payload: { mission_digest: DIGEST_A, tree_revision: 1 }
      }));
      // Inject a fake accepted artifact into state for mismatch check.
      state = {
        ...state,
        accepted_artifacts: {
          "art-1": {
            artifact_id: "art-1",
            artifact_digest: DIGEST_A,
            node_id: "n1",
            attempt_id: "a1",
            invalidated: false
          }
        }
      };
      const envelopeBase = {
        schema_version: 1 as const,
        artifact_id: "art-1",
        kind: "proposal",
        production_id: "prod-3",
        tree_revision: 1,
        node_id: "n1",
        task_revision: 1,
        attempt_id: "a1",
        producer_role: "story",
        input_refs: [],
        contract_bindings: [],
        parent_artifact_ids: [],
        payload: { ok: true },
        payload_digest: sha256Canonical({ ok: true }),
        created_at: "2026-08-12T00:00:00.000Z",
        envelope_digest: ZERO
      };
      const envelope = {
        ...envelopeBase,
        envelope_digest: sha256Canonical(withoutField(envelopeBase, "envelope_digest"))
      };
      expect(() => reverifyArtifactEnvelopes(state, [envelope])).toThrow(/digest mismatch/);
      expect(() => reverifyArtifactEnvelopes({
        ...state,
        accepted_artifacts: {
          "art-1": { ...state.accepted_artifacts["art-1"]!, invalidated: true, artifact_digest: envelope.envelope_digest }
        }
      }, [envelope])).toThrow(/invalidated/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
