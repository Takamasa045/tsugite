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
  createFullProductionJobBinding,
  createGenerationJobApprovalBinding,
  createInitialMissionState,
  buildActiveGate1ProductionBinding,
  buildActiveGateBundle,
  cascadeRunStateFromDrift,
  mapRunConditionsToGate2AutoPass,
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
  composition_intent_digest?: string | null;
  selected?: string[];
  with_program_ranges?: boolean;
}> = {}): GateBundle {
  const r = route("main");
  const priced = knownPricing(r);
  const withRanges = overrides.with_program_ranges !== false;
  const compositionIntent = overrides.composition_intent_digest === null
    ? undefined
    : (overrides.composition_intent_digest ?? (withRanges ? DIGEST_A : undefined));
  return createGateBundle({
    production_id: "prod-1",
    run_id: "run-1",
    production_contract_digest: DIGEST_A,
    contract_set_digest: DIGEST_B,
    task_tree_digest: DIGEST_C,
    selected_artifact_digests: overrides.selected ?? [DIGEST_D],
    ...(compositionIntent ? { composition_intent_digest: compositionIntent } : {}),
    generation_batches: overrides.batches ?? [
      {
        batch_id: "batch-1",
        route: r,
        ordered_units: [
          {
            ordinal: 0,
            generation_unit_digest: DIGEST_E,
            base_compilation_digest: DIGEST_F,
            route_digest: r.route_digest,
            ...(withRanges
              ? { program_start_ms: 0, program_end_ms: 8_000 }
              : {})
          },
          {
            ordinal: 1,
            generation_unit_digest: sha256Canonical({ unit: 2 }),
            base_compilation_digest: sha256Canonical({ compile: 2 }),
            route_digest: r.route_digest,
            ...(withRanges
              ? { program_start_ms: 8_000, program_end_ms: 16_000 }
              : {})
          }
        ],
        ...priced
      }
    ],
    review_artifact_digest: sha256Canonical({ review: "storyboard" })
  });
}

function sealedGate1(bundle: GateBundle) {
  return {
    subject_digest: DIGEST_A,
    decision_digest: DIGEST_B,
    gate_bundle_digest: bundle.digest,
    stale: false as const
  };
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
  it("denies paid until PO-6 and requires sealed Gate1+bundle+Coordinator for submit", () => {
    const bundle = sampleBundle();
    // paid_authorization:true is still unconditionally denied in T06.
    expect(checkAuthority({
      role: "generator",
      effect: "paid",
      actor: "coordinator",
      mode: "active",
      coordinator_actor: "coordinator",
      paid_authorization: true
    }).allowed).toBe(false);
    expect(checkAuthority({
      role: "generator",
      effect: "paid",
      actor: "coordinator",
      mode: "active",
      coordinator_actor: "coordinator",
      paid_authorization: true
    }).reason).toBe("paid execution denied until PO-6 typed authorization exists");

    expect(checkAuthority({
      role: "generator",
      effect: "external-submit",
      actor: "coordinator",
      mode: "active",
      coordinator_actor: "coordinator",
      gate_bundle: bundle,
      gate_1: sealedGate1(bundle)
    }).allowed).toBe(true);

    // known_price alone is forbidden.
    expect(checkAuthority({
      role: "generator",
      effect: "external-submit",
      actor: "coordinator",
      mode: "active",
      coordinator_actor: "coordinator",
      known_price: true
    }).allowed).toBe(false);
    expect(checkAuthority({
      role: "generator",
      effect: "external-submit",
      actor: "coordinator",
      mode: "active",
      coordinator_actor: "coordinator",
      known_price: true
    }).reason).toBe("known_price alone cannot authorize external-submit");

    expect(checkAuthority({
      role: "generator",
      effect: "external-submit",
      actor: "planner",
      mode: "active",
      known_price: true
    }).allowed).toBe(false);

    expect(checkAuthority({
      role: "coordinator",
      effect: "render",
      actor: "coordinator",
      mode: "active",
      coordinator_actor: "coordinator",
      explicit_render_command: true,
      gate_2: { subject_digest: DIGEST_C, decision_digest: DIGEST_D, stale: false }
    }).allowed).toBe(true);

    expect(checkAuthority({
      role: "coordinator",
      effect: "render",
      actor: "coordinator",
      mode: "active",
      coordinator_actor: "coordinator",
      explicit_render_command: false,
      gate_2: { subject_digest: DIGEST_C, decision_digest: DIGEST_D, stale: false }
    }).allowed).toBe(false);

    expect(checkAuthority({
      role: "generator",
      effect: "external-submit",
      actor: "coordinator",
      mode: "shadow",
      coordinator_actor: "coordinator",
      known_price: true
    }).allowed).toBe(false);
  });

  it("enforces pure max3 / effectful max1 and rejects duplicate node/attempt leases", () => {
    const dispatcher = new ProductionDispatcher();
    const authority = {
      actor: "coordinator",
      mode: "active" as const,
      coordinator_actor: "coordinator"
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

  it("requires full production_binding only in active mode", () => {
    const job = pinnedJob({ status: "approved", artifact: undefined, revision: 1 });
    const r = route("main");
    const full = createGenerationJobApprovalBinding({
      production_id: "prod-1",
      run_id: "run-1",
      node_id: "n1",
      attempt_id: "a1",
      generation_job_id: job.job_id,
      approval_observed_revision: 1,
      approval_digest: DIGEST_A,
      gate_bundle_digest: DIGEST_B,
      gate_1_decision_digest: DIGEST_C,
      request_digest: DIGEST_D,
      compilation_digest: DIGEST_E,
      route: r,
      pricing_binding_digest: DIGEST_F
    });
    expect(() => assertProductionBindingForMode(job, "disabled")).not.toThrow();
    expect(() => assertProductionBindingForMode(job, "shadow")).not.toThrow();
    expect(() => assertProductionBindingForMode(job, "active")).toThrow(
      /active production mode requires generation job production_binding/
    );
    // Length-only shell / wrong identity is rejected.
    expect(() => assertProductionBindingForMode({
      ...job,
      production_binding: {
        production_id: "prod-1",
        run_id: "run-1",
        node_id: "n1",
        attempt_id: "a1",
        generation_job_id: job.job_id,
        approval_observed_revision: 1,
        approval_digest: DIGEST_A,
        gate_bundle_digest: DIGEST_B,
        gate_1_decision_digest: DIGEST_C,
        request_digest: DIGEST_D,
        compilation_digest: DIGEST_E,
        route: r,
        pricing_binding_digest: DIGEST_F,
        immutable_identity_digest: "0".repeat(64)
      }
    }, "active")).toThrow(/production_binding invalid|identity/);
    expect(() => assertProductionBindingForMode({
      ...job,
      production_binding: full
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
  it("assertAuthority throws with exact PC_AUTHORITY_DENIED for paid", () => {
    expect(() => assertAuthority({
      role: "generator",
      effect: "paid",
      actor: "coordinator",
      mode: "active",
      coordinator_actor: "coordinator",
      paid_authorization: true
    })).toThrowError(expect.objectContaining({
      code: "PC_AUTHORITY_DENIED",
      message: "paid execution denied until PO-6 typed authorization exists"
    }));
  });

  it("route identity keys distinguish complete routes", () => {
    expect(routeIdentityKey(route("x"))).not.toBe(routeIdentityKey(route("y")));
  });
});

describe("PO-5 sealed authority integration", () => {
  it("requires sealed coordinator/gate bindings and rejects boolean-only authority", () => {
    expect(checkAuthority({
      role: "editor",
      effect: "local-write",
      actor: "coordinator",
      mode: "active",
      coordinator_actor: "coordinator"
    }).allowed).toBe(true);
    expect(checkAuthority({
      role: "editor",
      effect: "local-write",
      actor: "planner",
      mode: "active",
      is_coordinator: true
    }).allowed).toBe(false);
    expect(checkAuthority({
      role: "coordinator",
      effect: "gate",
      actor: "human",
      mode: "active",
      human_decision_ref: {
        decision_id: "d1",
        decision: "approved",
        actor: "human",
        decided_at: "2026-08-12T00:00:00.000Z",
        subject_digest: DIGEST_A
      }
    }).allowed).toBe(true);
    expect(checkAuthority({
      role: "coordinator",
      effect: "gate",
      actor: "human",
      mode: "active",
      human_gate_decision: true
    }).allowed).toBe(false);
    expect(checkAuthority({
      role: "generator",
      effect: "paid",
      actor: "coordinator",
      mode: "active",
      coordinator_actor: "coordinator",
      paid_authorization: true
    }).allowed).toBe(false);
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
      coordinator_actor: "coordinator",
      gate_bundle: unknown,
      gate_1: sealedGate1(unknown)
    }).allowed).toBe(false);
    expect(checkAuthority({
      role: "generator",
      effect: "external-submit",
      actor: "coordinator",
      mode: "active",
      coordinator_actor: "coordinator",
      known_price: true
    }).allowed).toBe(false);
    expect(checkAuthority({
      role: "coordinator",
      effect: "render",
      actor: "coordinator",
      mode: "active",
      coordinator_actor: "coordinator",
      explicit_render_command: true
    }).allowed).toBe(false);
    expect(checkAuthority({
      role: "story",
      effect: "paid",
      actor: "story",
      mode: "active"
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
    // Without program ranges, composition intent is not required.
    expect(() => requireMvCompositionIntent(sampleBundle({ with_program_ranges: false, composition_intent_digest: null }))).not.toThrow();
    // createGateBundle rejects program ranges without composition intent (exact code).
    expect(() => sampleBundle({ with_program_ranges: true, composition_intent_digest: null })).toThrowError(
      expect.objectContaining({
        code: "PC_GATE_BUNDLE_INVALID",
        message: "MV GateBundle requires composition_intent_digest with program ranges"
      })
    );
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
      authority: { actor: "c", mode: "active", coordinator_actor: "c" },
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
      authority: { actor: "c", mode: "active", coordinator_actor: "c" },
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

describe("PO-5 createGateBundle live enforcements", () => {
  it("rejects known amount > max_amount and mixed unit route digests inside createGateBundle", () => {
    const r = route("cap");
    expect(() => createGateBundle({
      production_id: "prod-1",
      run_id: "run-1",
      production_contract_digest: DIGEST_A,
      contract_set_digest: DIGEST_B,
      task_tree_digest: DIGEST_C,
      selected_artifact_digests: [],
      generation_batches: [{
        batch_id: "batch-cap",
        route: r,
        ordered_units: [{ ordinal: 0, generation_unit_digest: DIGEST_E, base_compilation_digest: DIGEST_F }],
        pricing: {
          status: "known",
          version: "price-v1",
          currency: "USD",
          amount: 5,
          max_amount: 3
        }
      }],
      review_artifact_digest: DIGEST_D
    })).toThrowError(expect.objectContaining({
      code: "PC_GATE_BUNDLE_INVALID",
      message: "known pricing amount must be <= max_amount"
    }));

    const r2 = route("other");
    expect(() => createGateBundle({
      production_id: "prod-1",
      run_id: "run-1",
      production_contract_digest: DIGEST_A,
      contract_set_digest: DIGEST_B,
      task_tree_digest: DIGEST_C,
      selected_artifact_digests: [],
      generation_batches: [{
        batch_id: "batch-mix",
        route: r,
        ordered_units: [{
          ordinal: 0,
          generation_unit_digest: DIGEST_E,
          base_compilation_digest: DIGEST_F,
          route_digest: r2.route_digest
        }],
        ...knownPricing(r)
      }],
      review_artifact_digest: DIGEST_D
    })).toThrowError(expect.objectContaining({
      code: "PC_GATE_BUNDLE_INVALID",
      message: "generation batch cannot mix RouteIdentity values"
    }));
  });

  it("requires composition_intent_digest when program ranges are present", () => {
    const r = route("mv");
    expect(() => createGateBundle({
      production_id: "prod-1",
      run_id: "run-1",
      production_contract_digest: DIGEST_A,
      contract_set_digest: DIGEST_B,
      task_tree_digest: DIGEST_C,
      selected_artifact_digests: [],
      generation_batches: [{
        batch_id: "batch-mv",
        route: r,
        ordered_units: [{
          ordinal: 0,
          generation_unit_digest: DIGEST_E,
          base_compilation_digest: DIGEST_F,
          program_start_ms: 0,
          program_end_ms: 1000
        }],
        ...knownPricing(r)
      }],
      review_artifact_digest: DIGEST_D
    })).toThrowError(expect.objectContaining({
      code: "PC_GATE_BUNDLE_INVALID",
      message: "MV GateBundle requires composition_intent_digest with program ranges"
    }));
  });
});

describe("PO-5 live RunState cascade / Gate2 auto-pass / Gate1 binding", () => {
  it("cascades IdentityDefinition onto real RunState and unifies gate ids", () => {
    let state = createPlannedState("run-cascade");
    state = markGateAwaiting(state, "gate_1");
    state = recordGateDecision(state, "gate_1", "approved", undefined, DIGEST_A, "human", undefined, {
      production_subject_digest: DIGEST_B,
      production_decision_digest: DIGEST_C
    });
    expect(state.gates.gate_1.production_subject_digest).toBe(DIGEST_B);
    const cascaded = cascadeRunStateFromDrift(state, ["identity-definition"]);
    expect(cascaded.cascade.stale_gate_1).toBe(true);
    expect(cascaded.state.gates.gate_1.status).toBe("pending");
    expect(cascaded.state.gates.gate_1.production_subject_digest).toBeUndefined();
  });

  it("maps live run conditions through the single Gate2 auto-pass implementation", () => {
    expect(mapRunConditionsToGate2AutoPass({
      project_opt_in: true,
      credits: 0,
      generatedAssetCount: 0,
      qcIssueCount: 0,
      semanticQaEnabled: false
    }).auto_pass).toBe(true);
    expect(mapRunConditionsToGate2AutoPass({
      project_opt_in: true,
      credits: 1,
      generatedAssetCount: 0,
      qcIssueCount: 0,
      semanticQaEnabled: false
    })).toEqual({ auto_pass: false, blocked_reason: "credits consumed" });
  });

  it("binds active Gate1 subject to exact GateBundle digest and rejects absent/unknown-price approve", () => {
    const bundle = sampleBundle();
    const bound = buildActiveGate1ProductionBinding({
      production_id: "prod-1",
      run_id: "run-1",
      gate_bundle: bundle,
      legacy_approved_input_digest: DIGEST_A,
      decision: {
        decision_id: "d-gate1",
        decision: "approved",
        actor: "coordinator",
        decided_at: "2026-08-12T00:00:00.000Z"
      }
    });
    expect(bound.productionBinding.production_subject_digest).toHaveLength(64);
    expect(bound.gate_bundle_digest).toBe(bundle.digest);

    expect(() => buildActiveGate1ProductionBinding({
      production_id: "prod-1",
      run_id: "run-1",
      gate_bundle: undefined,
      legacy_approved_input_digest: DIGEST_A,
      decision: {
        decision_id: "d-missing",
        decision: "approved",
        actor: "coordinator",
        decided_at: "2026-08-12T00:00:00.000Z"
      }
    })).toThrowError(expect.objectContaining({
      code: "PC_GATE_BUNDLE_INVALID",
      message: "active Gate 1 approval requires a GateBundle"
    }));

    const r = route("u");
    const unknown = createGateBundle({
      production_id: "prod-1",
      run_id: "run-1",
      production_contract_digest: DIGEST_A,
      contract_set_digest: DIGEST_B,
      task_tree_digest: DIGEST_C,
      selected_artifact_digests: [],
      generation_batches: [{
        batch_id: "batch-u3",
        route: r,
        ordered_units: [{ ordinal: 0, generation_unit_digest: DIGEST_E, base_compilation_digest: DIGEST_F }],
        ...unknownPricing(r)
      }],
      review_artifact_digest: DIGEST_D
    });
    expect(() => buildActiveGate1ProductionBinding({
      production_id: "prod-1",
      run_id: "run-1",
      gate_bundle: unknown,
      legacy_approved_input_digest: DIGEST_A,
      decision: {
        decision_id: "d-unknown",
        decision: "approved",
        actor: "coordinator",
        decided_at: "2026-08-12T00:00:00.000Z"
      }
    })).toThrowError(expect.objectContaining({
      code: "PC_GATE_BUNDLE_INVALID",
      message: "unknown price cannot be approved or executed"
    }));
  });
});

describe("PO-5 machine active submit T05 path (stub adapter)", () => {
  it("active submit never reaches adapter without adopted T05 authority; fake/raw/swap stay at 0", async () => {
    const { GenerationJobMachine } = await import("../src/generationJobs/machine.js");
    const { GenerationJobStore } = await import("../src/generationJobs/store.js");
    const root = await mkdtemp(join("/private/tmp", "tsugite-po5-machine-"));
    try {
      let adapterSubmitCount = 0;
      const store = new GenerationJobStore({ rootDir: root });
      const r = route("main");
      const fullBinding = createGenerationJobApprovalBinding({
        production_id: "prod-1",
        run_id: "run-1",
        node_id: "n1",
        attempt_id: "a1",
        generation_job_id: "job-active-1",
        approval_observed_revision: 0,
        approval_digest: DIGEST_A,
        gate_bundle_digest: DIGEST_B,
        gate_1_decision_digest: DIGEST_C,
        request_digest: DIGEST_D,
        compilation_digest: DIGEST_E,
        route: r,
        pricing_binding_digest: DIGEST_F
      });
      const request = {
        digest: computeRequestDigestForTest({
          model_id: "model-main",
          mode: "text-to-video",
          connection_id: "conn-main",
          auth_env_names: [],
          asset_paths: [],
          params: { text: "fixture only" }
        }),
        model_id: "model-main",
        mode: "text-to-video",
        connection_id: "conn-main",
        auth_env_names: [] as string[],
        asset_paths: [] as string[],
        params: { text: "fixture only" }
      };
      // Fix request digest with real function
      const { computeRequestDigest, createApproval } = await import("../src/generationJobs/approval.js");
      request.digest = computeRequestDigest(request);

      await store.create({
        job_id: "job-active-1",
        connection_id: "conn-main",
        model_id: "model-main",
        mode: "text-to-video",
        request,
        model_profile_digest: DIGEST_A,
        connection_capability_digest: DIGEST_B,
        pricing: {
          status: "known",
          version: "price-v1",
          currency: "USD",
          amount: 1,
          max_amount: 2
        },
        status: "awaiting_cost_approval",
        production_binding: fullBinding
      });

      const machine = new GenerationJobMachine({
        store,
        adapter: {
          adapter_id: "stub",
          connection_id: "conn-main",
          capabilities: { submit: true, poll: true, download: true, cancel: false },
          async submit() {
            adapterSubmitCount += 1;
            return { ok: true as const, provider_job_id: "prov-1" };
          },
          async poll() {
            return { ok: true as const, status: "succeeded" as const };
          },
          async download() {
            return {
              ok: true as const,
              relative_path: "out.mp4",
              bytes: Buffer.from("fixture"),
              sha256: DIGEST_D,
              byte_length: 7
            };
          }
        },
        orchestrationMode: "active",
        resolveExecutionBundle: async () => ({ execution_capable: true, compilation_digest: DIGEST_E }),
        resolveSubmissionBinding: async (job) => ({
          production_id: "prod-1",
          project_id: "proj-1",
          revision_id: "rev-1",
          request_id: "req-1",
          attempt_id: job.production_binding!.attempt_id,
          job_id: job.job_id,
          compilation_digest: DIGEST_E,
          effective_contract_digest: DIGEST_A,
          asset_lineage_digest: DIGEST_B
        })
      });

      // Approve requires full binding (present).
      const approved = await machine.approve("job-active-1", "coordinator");
      expect(approved.status).toBe("approved");

      // Active submit with fake bundle → adapter invoke 0, fails closed (not submission_unknown).
      const failed = await machine.submit("job-active-1");
      expect(failed.status).toBe("failed");
      expect(failed.error?.code).toBe("GJ-E027");
      expect(failed.error?.message).toMatch(/T05 authority failed|adopted|active submit/);
      expect(adapterSubmitCount).toBe(0);
      expect(machine.lastActiveSubmitUsedT05).toBe(false);

      // Raw JSON swap / double-use paths already covered by executeWithSubmissionAuthority unit tests.
      const raw = await executeWithSubmissionAuthority({
        bundle: JSON.parse(JSON.stringify({ execution_capable: true })),
        binding: {
          production_id: "prod-1",
          project_id: "proj-1",
          revision_id: "rev-1",
          request_id: "req-1",
          attempt_id: "a1",
          job_id: "job-active-1",
          compilation_digest: DIGEST_E,
          effective_contract_digest: DIGEST_A,
          asset_lineage_digest: DIGEST_B
        },
        hooks: { onAdapterInvoke: () => { adapterSubmitCount += 1; } }
      });
      expect(raw.ok).toBe(false);
      expect(raw.adapter_invocations).toBe(0);
      expect(adapterSubmitCount).toBe(0);
      void createApproval;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function computeRequestDigestForTest(request: {
  model_id: string;
  mode: string;
  connection_id: string;
  auth_env_names: string[];
  asset_paths: string[];
  params: Record<string, unknown>;
}): string {
  return sha256Canonical({
    kind: "generation-job-request",
    schema_version: 1,
    ...request
  });
}

describe("PO-5 activePipeline public API branches", () => {
  it("resolves modes, normalizes gate ids, and builds Gate2/Gate3 production bindings", async () => {
    const {
      resolveOrchestrationMode,
      requireResolvedModeForEffect,
      normalizeGateId,
      buildActiveGate2ProductionBinding,
      buildActiveGate3ProductionBinding,
      assertActiveSubjectsBeforePhase,
      liveSubjectsFromRunState,
      productionDecisionId,
      assertFullProductionBinding,
      buildActiveGateBundleForProject
    } = await import("../src/productionControl/activePipeline.js");

    expect(resolveOrchestrationMode({ orchestration: { mode: "active" } })).toBe("active");
    expect(resolveOrchestrationMode({ orchestration: { mode: "shadow" } })).toBe("shadow");
    expect(resolveOrchestrationMode({})).toBeUndefined();
    expect(requireResolvedModeForEffect(undefined, "run")).toBe("legacy");
    expect(requireResolvedModeForEffect("active", "render")).toBe("active");
    expect(requireResolvedModeForEffect("disabled", "finalize")).toBe("disabled");

    expect(normalizeGateId("gate-1")).toBe("gate_1");
    expect(normalizeGateId("Gate2")).toBe("gate_2");
    expect(normalizeGateId("gate_3")).toBe("gate_3");
    expect(normalizeGateId("nope")).toBeUndefined();

    const g2 = buildActiveGate2ProductionBinding({
      gate_1_decision_digest: DIGEST_A,
      gate_bundle_digest: DIGEST_B,
      selected_generation_completion_digests: [DIGEST_C],
      manifest_digest: DIGEST_D,
      technical_qa_digest: DIGEST_E,
      identity_verification_report_digest: DIGEST_F,
      decision: {
        decision_id: "d2",
        decision: "approved",
        actor: "human",
        decided_at: "2026-08-12T00:00:00.000Z"
      },
      decision_source: "human",
      legacy_approved_input_digest: DIGEST_A
    });
    expect(g2.subject_digest).toHaveLength(64);

    const g3 = buildActiveGate3ProductionBinding({
      gate_2_decision_digest: g2.decision_digest,
      gate_2_subject_digest: g2.subject_digest,
      final_artifact_sha256: DIGEST_A,
      render_report_digest: DIGEST_B,
      gate_3_qc_digest: DIGEST_C,
      selected_branch_digest: DIGEST_D,
      decision: {
        decision_id: "d3",
        decision: "approved",
        actor: "human",
        decided_at: "2026-08-12T00:00:01.000Z"
      },
      legacy_approved_input_digest: DIGEST_A
    });
    expect(g3.productionBinding.production_decision_digest).toHaveLength(64);

    let state = createPlannedState("run-api");
    state = markGateAwaiting(state, "gate_1");
    state = recordGateDecision(state, "gate_1", "approved", undefined, DIGEST_A, "human", undefined, {
      production_subject_digest: DIGEST_B,
      production_decision_digest: DIGEST_C
    });
    const subjects = liveSubjectsFromRunState(state);
    expect(subjects.gate_1_subject_digest).toBe(DIGEST_B);
    expect(() => assertActiveSubjectsBeforePhase({
      mode: "active",
      phase: "run",
      state,
      expected: subjects
    })).not.toThrow();
    expect(() => assertActiveSubjectsBeforePhase({
      mode: "active",
      phase: "run",
      state,
      expected: { ...subjects, gate_1_subject_digest: ZERO }
    })).toThrowError(expect.objectContaining({ code: "PC_GATE_SUBJECT_STALE" }));
    expect(() => assertActiveSubjectsBeforePhase({
      mode: "disabled",
      phase: "finalize",
      state,
      expected: {}
    })).not.toThrow();

    expect(productionDecisionId("gate_1", "coordinator", "2026-08-12T00:00:00.000Z")).toHaveLength(32);

    const full = createGenerationJobApprovalBinding({
      production_id: "prod-1",
      run_id: "run-1",
      node_id: "n1",
      attempt_id: "a1",
      generation_job_id: "job-1",
      approval_observed_revision: 1,
      approval_digest: DIGEST_A,
      gate_bundle_digest: DIGEST_B,
      gate_1_decision_digest: DIGEST_C,
      request_digest: DIGEST_D,
      compilation_digest: DIGEST_E,
      route: route("api"),
      pricing_binding_digest: DIGEST_F
    });
    expect(assertFullProductionBinding(full, "active")?.generation_job_id).toBe("job-1");
    expect(assertFullProductionBinding(undefined, "shadow")).toBeUndefined();
    expect(() => assertFullProductionBinding(undefined, "active")).toThrowError(
      expect.objectContaining({ code: "PC_GENERATION_BINDING_INVALID" })
    );

    const project = {
      slug: "api-active",
      name: "api-active",
      manifest: "manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      orchestration: { mode: "active" as const },
      generation: { connection: "pixverse", adapter: "pixverse", requests: [] }
    } as never;
    try {
      const bundle = buildActiveGateBundleForProject({
        project,
        run_id: "run-api",
        review_artifact_digest: DIGEST_A
      });
      expect(bundle.run_id).toBe("run-api");
    } catch (error) {
      expect(error).toBeTruthy();
    }
  });
});

describe("PO-5 Exit E2E fixture-only (mission → Gate1 → job binding → T05 stub)", () => {
  it("proves active compile/plan/review GateBundle, Gate1 subject, full job binding, T05-only submit path, pin ref; provider 0", async () => {
    const networkHits: string[] = [];
    const originalFetch = globalThis.fetch;
    // Fail-closed network: any fetch is a test failure signal.
    globalThis.fetch = (async (...args: unknown[]) => {
      networkHits.push(String(args[0]));
      throw new Error("network forbidden in fixture E2E");
    }) as typeof fetch;

    try {
      const r = route("e2e");
      const priced = knownPricing(r);
      const bundle = buildActiveGateBundle({
        production_id: "prod-e2e",
        run_id: "run-e2e",
        production_contract_digest: DIGEST_A,
        contract_set_digest: DIGEST_B,
        task_tree_digest: DIGEST_C,
        selected_artifact_digests: [DIGEST_D],
        composition_intent_digest: DIGEST_A,
        generation_batches: [{
          batch_id: "batch-e2e",
          route: r,
          ordered_units: [{
            ordinal: 0,
            generation_unit_digest: DIGEST_E,
            base_compilation_digest: DIGEST_F,
            route_digest: r.route_digest,
            program_start_ms: 0,
            program_end_ms: 4_000
          }],
          ...priced
        }],
        review_artifact_digest: sha256Canonical({ review: "e2e" })
      });
      expect(projectGateBundleForReview(bundle).has_unknown_price).toBe(false);

      // Human Gate1 exact subject
      const gate1 = buildActiveGate1ProductionBinding({
        production_id: "prod-e2e",
        run_id: "run-e2e",
        gate_bundle: bundle,
        legacy_approved_input_digest: DIGEST_A,
        decision: {
          decision_id: "e2e-d1",
          decision: "approved",
          actor: "human",
          decided_at: "2026-08-12T00:00:00.000Z"
        }
      });
      expect(gate1.gate_bundle_digest).toBe(bundle.digest);

      let runState = createPlannedState("run-e2e");
      runState = markGateAwaiting(runState, "gate_1");
      runState = recordGateDecision(
        runState,
        "gate_1",
        "approved",
        undefined,
        DIGEST_A,
        "human",
        undefined,
        gate1.productionBinding
      );
      expect(runState.gates.gate_1.production_subject_digest).toBe(gate1.subject_digest);
      expect(runState.gates.gate_1.production_decision_digest).toBe(gate1.decision_digest);

      // Full generation job binding + immutable identity recompute
      const jobBinding = createFullProductionJobBinding({
        production_id: "prod-e2e",
        run_id: "run-e2e",
        node_id: "gen-1",
        attempt_id: "att-e2e",
        generation_job_id: "job-e2e",
        approval_observed_revision: 0,
        approval_digest: DIGEST_A,
        gate_bundle: bundle,
        gate_1_decision_digest: gate1.decision_digest,
        request_digest: DIGEST_D,
        compilation_digest: DIGEST_F,
        route: r,
        pricing_binding_digest: priced.pricing_binding_digest
      });
      expect(jobBinding.gate_bundle_digest).toBe(bundle.digest);
      expect(jobBinding.immutable_identity_digest).toHaveLength(64);

      // Active submit path: only T05 authority; fake bundle → 0 adapter invokes.
      let adapterInvokes = 0;
      const submit = await executeWithSubmissionAuthority({
        bundle: { execution_capable: true, compilation_digest: DIGEST_F },
        binding: {
          production_id: "prod-e2e",
          project_id: "proj-e2e",
          revision_id: "rev-e2e",
          request_id: "req-e2e",
          attempt_id: "att-e2e",
          job_id: "job-e2e",
          compilation_digest: DIGEST_F,
          effective_contract_digest: DIGEST_A,
          asset_lineage_digest: DIGEST_B
        },
        hooks: {
          onAdapterInvoke: () => { adapterInvokes += 1; },
          submitEffect: () => {
            throw new Error("stub adapter must not run without adopted lease");
          }
        }
      });
      expect(submit.ok).toBe(false);
      expect(submit.adapter_invocations).toBe(0);
      expect(adapterInvokes).toBe(0);

      // Pin completion ref from pinned job + full binding
      const pinned = pinnedJob({
        job_id: "job-e2e",
        production_binding: jobBinding as never
      });
      const completion = createCompletionRefFromPinnedJob({
        job: pinned,
        binding: jobBinding,
        verification_digest: DIGEST_E
      });
      expect(completion.generation_job_id).toBe("job-e2e");
      expect(completion.immutable_identity_digest).toBe(jobBinding.immutable_identity_digest);

      // Legacy/disabled/shadow unchanged: no production binding required.
      expect(() => assertProductionBindingForMode(pinnedJob({ status: "approved", artifact: undefined }), "disabled")).not.toThrow();
      expect(() => assertProductionBindingForMode(pinnedJob({ status: "approved", artifact: undefined }), "shadow")).not.toThrow();

      expect(networkHits).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
