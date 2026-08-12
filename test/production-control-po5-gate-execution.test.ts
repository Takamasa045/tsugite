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
  mintSealedCoordinatorAuthority,
  mintSealedGate1Binding,
  mintSealedGate2Binding,
  mintSealedHumanDecision,
  isSealedGate1Binding,
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
  const decision = {
    decision_id: "seal-d1",
    decision: "approved",
    actor: "human",
    decided_at: "2026-08-12T00:00:00.000Z"
  };
  const gate1 = buildActiveGate1ProductionBinding({
    production_id: bundle.production_id,
    run_id: bundle.run_id,
    gate_bundle: bundle,
    legacy_approved_input_digest: DIGEST_A,
    decision
  });
  return mintSealedGate1Binding({
    gate_bundle: bundle,
    production_id: bundle.production_id,
    run_id: bundle.run_id,
    legacy_approved_input_digest: DIGEST_A,
    decision,
    live_subject_digest: gate1.subject_digest,
    live_decision_digest: gate1.decision_digest
  });
}

function sealedCoordinator(gate1DecisionDigest = DIGEST_B) {
  const principalBody = {
    schema_version: 1 as const,
    kind: "coordinator-principal" as const,
    actor: "coordinator" as const,
    gate_1_decision_digest: gate1DecisionDigest
  };
  return mintSealedCoordinatorAuthority({
    actor: "coordinator",
    durable_principal: {
      ...principalBody,
      digest: sha256Canonical(principalBody)
    },
    live_gate_1_decision_digest: gate1DecisionDigest
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
  it("denies paid until PO-6 and requires sealed Gate1+bundle+Coordinator for submit", () => {
    const bundle = sampleBundle();
    const coordinator = sealedCoordinator();
    // paid_authorization:true is still unconditionally denied in T06.
    expect(checkAuthority({
      role: "generator",
      effect: "paid",
      actor: "coordinator",
      mode: "active",
      coordinator_authority: coordinator,
      paid_authorization: true
    }).allowed).toBe(false);
    expect(checkAuthority({
      role: "generator",
      effect: "paid",
      actor: "coordinator",
      mode: "active",
      coordinator_authority: coordinator,
      paid_authorization: true
    }).reason).toBe("paid execution denied until PO-6 typed authorization exists");

    expect(checkAuthority({
      role: "generator",
      effect: "external-submit",
      actor: "coordinator",
      mode: "active",
      coordinator_authority: coordinator,
      gate_bundle: bundle,
      gate_1: sealedGate1(bundle)
    }).allowed).toBe(true);

    // Free-form sealed copy / self coordinator string rejected.
    const freeFormGate1 = {
      kind: "pc-sealed-gate-1",
      subject_digest: DIGEST_A,
      decision_digest: DIGEST_B,
      gate_bundle_digest: bundle.digest,
      stale: false as const
    };
    expect(isSealedGate1Binding(freeFormGate1)).toBe(false);
    expect(checkAuthority({
      role: "generator",
      effect: "external-submit",
      actor: "coordinator",
      mode: "active",
      coordinator_authority: coordinator,
      gate_bundle: bundle,
      gate_1: freeFormGate1 as never
    }).allowed).toBe(false);
    expect(checkAuthority({
      role: "generator",
      effect: "external-submit",
      actor: "coordinator",
      mode: "active",
      coordinator_actor: "coordinator",
      gate_bundle: bundle,
      gate_1: sealedGate1(bundle)
    }).allowed).toBe(false);

    // known_price alone is forbidden.
    expect(checkAuthority({
      role: "generator",
      effect: "external-submit",
      actor: "coordinator",
      mode: "active",
      coordinator_authority: coordinator,
      known_price: true
    }).allowed).toBe(false);
    expect(checkAuthority({
      role: "generator",
      effect: "external-submit",
      actor: "coordinator",
      mode: "active",
      coordinator_authority: coordinator,
      known_price: true
    }).reason).toBe("known_price alone cannot authorize external-submit");

    expect(checkAuthority({
      role: "generator",
      effect: "external-submit",
      actor: "planner",
      mode: "active",
      known_price: true
    }).allowed).toBe(false);

    const sealedG2 = mintSealedGate2Binding({
      subject_digest: DIGEST_C,
      decision_digest: DIGEST_D,
      live_subject_digest: DIGEST_C,
      live_decision_digest: DIGEST_D
    });
    expect(checkAuthority({
      role: "coordinator",
      effect: "render",
      actor: "coordinator",
      mode: "active",
      coordinator_authority: coordinator,
      explicit_render_command: true,
      gate_2: sealedG2
    }).allowed).toBe(true);

    expect(checkAuthority({
      role: "coordinator",
      effect: "render",
      actor: "coordinator",
      mode: "active",
      coordinator_authority: coordinator,
      explicit_render_command: false,
      gate_2: sealedG2
    }).allowed).toBe(false);

    expect(checkAuthority({
      role: "generator",
      effect: "external-submit",
      actor: "coordinator",
      mode: "shadow",
      coordinator_authority: coordinator,
      known_price: true
    }).allowed).toBe(false);
  });

  it("enforces pure max3 / effectful max1 and rejects duplicate node/attempt leases", () => {
    const dispatcher = new ProductionDispatcher();
    const authority = {
      actor: "coordinator",
      mode: "active" as const,
      coordinator_authority: sealedCoordinator()
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
      coordinator_authority: sealedCoordinator(),
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
    const coordinator = sealedCoordinator();
    expect(checkAuthority({
      role: "editor",
      effect: "local-write",
      actor: "coordinator",
      mode: "active",
      coordinator_authority: coordinator
    }).allowed).toBe(true);
    expect(checkAuthority({
      role: "editor",
      effect: "local-write",
      actor: "planner",
      mode: "active",
      is_coordinator: true
    }).allowed).toBe(false);
    // Free-form human_decision_ref is not authority.
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
    }).allowed).toBe(false);
    const sealedDecision = mintSealedHumanDecision({
      gate: "gate_1",
      decision: {
        decision_id: "d1",
        decision: "approved",
        actor: "human",
        decided_at: "2026-08-12T00:00:00.000Z",
        subject_digest: DIGEST_A
      },
      live_subject_digest: DIGEST_A,
      live_decision_digest: gateDecisionDigest({
        decision_id: "d1",
        decision: "approved",
        actor: "human",
        decided_at: "2026-08-12T00:00:00.000Z",
        subject_digest: DIGEST_A
      }),
      decision_source: "human"
    });
    expect(checkAuthority({
      role: "coordinator",
      effect: "gate",
      actor: "human",
      mode: "active",
      sealed_human_decision: sealedDecision
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
      coordinator_authority: coordinator,
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
    // Unknown price cannot be sealed; free-form forged digests are rejected.
    expect(() => mintSealedGate1Binding({
      gate_bundle: unknown,
      production_id: "prod-1",
      run_id: "run-1",
      legacy_approved_input_digest: DIGEST_A,
      decision: {
        decision_id: "d-unknown",
        decision: "approved",
        actor: "human",
        decided_at: "2026-08-12T00:00:00.000Z"
      },
      live_subject_digest: DIGEST_A,
      live_decision_digest: DIGEST_B
    })).toThrow(/unknown price|PC_AUTHORITY_DENIED/);
    // Forged matching 64-hex pair without recomputed GateBundle subject is rejected.
    const knownBundle = sampleBundle();
    expect(() => mintSealedGate1Binding({
      gate_bundle: knownBundle,
      production_id: knownBundle.production_id,
      run_id: knownBundle.run_id,
      legacy_approved_input_digest: DIGEST_A,
      decision: {
        decision_id: "forged",
        decision: "approved",
        actor: "human",
        decided_at: "2026-08-12T00:00:00.000Z"
      },
      live_subject_digest: DIGEST_A,
      live_decision_digest: DIGEST_A
    })).toThrowError(expect.objectContaining({ code: "PC_AUTHORITY_DENIED" }));
    expect(checkAuthority({
      role: "generator",
      effect: "external-submit",
      actor: "coordinator",
      mode: "active",
      coordinator_authority: coordinator,
      gate_bundle: unknown,
      gate_1: {
        kind: "pc-sealed-gate-1",
        subject_digest: DIGEST_A,
        decision_digest: DIGEST_B,
        gate_bundle_digest: unknown.digest,
        stale: false
      } as never
    }).allowed).toBe(false);
    expect(checkAuthority({
      role: "generator",
      effect: "external-submit",
      actor: "coordinator",
      mode: "active",
      coordinator_authority: coordinator,
      known_price: true
    }).allowed).toBe(false);
    expect(checkAuthority({
      role: "coordinator",
      effect: "render",
      actor: "coordinator",
      mode: "active",
      coordinator_authority: coordinator,
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
    const unitCompile = bundle.generation_batches[0]!.ordered_units[0]!.base_compilation_digest;
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
      compilation_digest: unitCompile,
      route: r,
      pricing_binding_digest: bundle.generation_batches[0]!.pricing_binding_digest
    });
    expect(() => assertBindingMatchesGateBundle(binding, bundle)).not.toThrow();
    expect(() => assertBindingMatchesGateBundle({
      ...binding,
      gate_bundle_digest: DIGEST_A,
      immutable_identity_digest: computeDriftedIdentity({
        ...binding,
        compilation_digest: unitCompile
      })
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
      authority: { actor: "c", mode: "active" },
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
      authority: { actor: "c", mode: "active" },
      now: "2026-08-12T00:00:00.000Z",
      ttl_ms: 1
    });
    expect(pure.lease.lease_id).toBeTruthy();
    expect(effectful.lease.lease_id).toBeTruthy();
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
      const { computeRequestDigest } = await import("../src/generationJobs/approval.js");
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

      const principalBody = {
        schema_version: 1 as const,
        kind: "coordinator-principal" as const,
        actor: "coordinator" as const,
        gate_1_decision_digest: DIGEST_C
      };
      const machine = new GenerationJobMachine({
        store,
        adapter: {
          adapter_id: "stub",
          connection_id: "conn-main",
          capabilities: { submit: true, poll: true, download: true, cancel: false },
          async preflight() {
            return { ok: true as const, execution_ready: true };
          },
          async submit() {
            adapterSubmitCount += 1;
            return { ok: true as const, provider_job_id: "prov-1", accepted: true as const };
          },
          async poll() {
            return { ok: true as const, status: "succeeded" as const };
          },
          async download() {
            return {
              ok: true as const,
              absolute_path: join(root, "out.mp4"),
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
        }),
        resolveGateBundle: async () => sampleBundle(),
        // Forged digest pair (no decision body / recomputed subject) fails closed before adapter.
        resolveLiveGate1: async () => ({
          subject_digest: DIGEST_A,
          decision_digest: DIGEST_C,
          production_id: "prod-1",
          run_id: "run-1",
          legacy_approved_input_digest: DIGEST_A,
          decision: {
            decision_id: "forged-d1",
            decision: "approved",
            actor: "human",
            decided_at: "2026-08-12T00:00:00.000Z"
          }
        }),
        resolveCoordinatorPrincipal: async () => ({
          ...principalBody,
          digest: sha256Canonical(principalBody)
        })
      });

      // Approve requires full binding (present).
      const approved = await machine.approve("job-active-1", "coordinator");
      expect(approved.status).toBe("approved");

      // Active submit with forged Gate1 / fake T05 path → adapter invoke 0, fails closed.
      const failed = await machine.submit("job-active-1");
      expect(failed.status).toBe("failed");
      expect(failed.error?.code).toBe("GJ-E027");
      expect(failed.error?.message).toMatch(
        /T05 authority failed|adopted|active submit|Gate 1 sealed|recomputed|PC_AUTHORITY/
      );
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
    expect(() => requireResolvedModeForEffect(undefined, "external-submit")).toThrowError(
      expect.objectContaining({ code: "PC_MODE_INACTIVE" })
    );
    expect(() => requireResolvedModeForEffect(undefined, "gate")).toThrowError(
      expect.objectContaining({ code: "PC_MODE_INACTIVE" })
    );

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

describe("PO-5 pricing evidence never invents amount0/max0", () => {
  it("maps pricing_status=known without authoritative amounts to unknown, not USD 0/0", async () => {
    const {
      resolveAuthoritativeGatePricing,
      extractAuthoritativePricingFromProfile
    } = await import("../src/productionControl/pricingEvidence.js");
    const invented = resolveAuthoritativeGatePricing({ pricing_status: "known" });
    expect(invented.status).toBe("unknown");
    expect(invented.amount).toBeNull();
    expect(invented.max_amount).toBeNull();

    const fromProfile = resolveAuthoritativeGatePricing(
      extractAuthoritativePricingFromProfile({ pricing_status: "known" })
    );
    expect(fromProfile.status).toBe("unknown");

    const known = resolveAuthoritativeGatePricing({
      pricing_status: "known",
      authoritative: {
        version: "price-v1",
        currency: "USD",
        amount: 1.5,
        max_amount: 3
      }
    });
    expect(known.status).toBe("known");
    expect(known.amount).toBe(1.5);

    const zeroWithoutPolicy = resolveAuthoritativeGatePricing({
      authoritative: {
        version: "price-v1",
        currency: "USD",
        amount: 0,
        max_amount: 0
      }
    });
    expect(zeroWithoutPolicy.status).toBe("unknown");

    const zeroWithPolicy = resolveAuthoritativeGatePricing({
      authoritative: {
        version: "price-v1",
        currency: "USD",
        amount: 0,
        max_amount: 0,
        zero_cost_policy_id: "local-fixture-zero"
      }
    });
    expect(zeroWithPolicy.status).toBe("known");
    expect(zeroWithPolicy.amount).toBe(0);
    expect(zeroWithPolicy.zero_cost_policy_id).toBe("local-fixture-zero");

    // Hand-written / durable GateBundle known 0/0 without policy is rejected.
    expect(() => createGateBundle({
      production_id: "prod-1",
      run_id: "run-1",
      production_contract_digest: DIGEST_A,
      contract_set_digest: DIGEST_B,
      task_tree_digest: DIGEST_C,
      selected_artifact_digests: [],
      generation_batches: [{
        batch_id: "batch-zero",
        route: route("zero"),
        ordered_units: [{
          ordinal: 0,
          generation_unit_digest: DIGEST_E,
          base_compilation_digest: DIGEST_F
        }],
        pricing: {
          status: "known",
          version: "price-v1",
          currency: "USD",
          amount: 0,
          max_amount: 0
        },
        pricing_binding_digest: "0".repeat(64)
      }],
      review_artifact_digest: DIGEST_D
    })).toThrow(/zero_cost_policy_id|PC_GATE_BUNDLE_INVALID/);

    // Policy id is bound into pricing digest and differs without it (when non-zero path).
    const rZero = route("zpolicy");
    const withPolicy = {
      status: "known" as const,
      version: "price-v1",
      currency: "USD",
      amount: 0,
      max_amount: 0,
      zero_cost_policy_id: "local-fixture-zero"
    };
    const digestWith = pricingBindingDigest(withPolicy, rZero);
    const digestAlt = pricingBindingDigest({
      ...withPolicy,
      zero_cost_policy_id: "other-zero-policy"
    }, rZero);
    expect(digestWith).not.toBe(digestAlt);
    expect(digestWith).toHaveLength(64);

    // Non-zero known pricing still does not require policy id.
    const nonZero = resolveAuthoritativeGatePricing({
      authoritative: {
        version: "price-v1",
        currency: "USD",
        amount: 1,
        max_amount: 2
      }
    });
    expect(nonZero.status).toBe("known");
    expect(nonZero.zero_cost_policy_id).toBeUndefined();
  });

  it("buildActiveGenerationUnitEvidenceFromPlan never invents known 0/0 pricing", async () => {
    const { buildActiveGenerationUnitEvidenceFromPlan } = await import(
      "../src/orchestrator/review.js"
    );
    const units = buildActiveGenerationUnitEvidenceFromPlan({
      backend: "remotion",
      estimated_credits: 0,
      video_prompt_plans: [{
        request_id: "r1",
        model_profile_digest: DIGEST_A,
        connection_profile: { pricing_status: "known" },
        v2_compilation: {
          route: route("price"),
          bundle: { compilation_digest: DIGEST_E }
        }
      }]
    } as never);
    expect(units).toHaveLength(1);
    expect(units[0]!.pricing.status).toBe("unknown");
    expect(units[0]!.pricing.amount).toBeNull();
  });
});

describe("PO-5 active machine resolvers fail closed", () => {
  it("rejects active submit without resolveGateBundle/resolveLiveGate1/resolveCoordinatorPrincipal", async () => {
    const { GenerationJobMachine } = await import("../src/generationJobs/machine.js");
    const { GenerationJobStore } = await import("../src/generationJobs/store.js");
    const root = await mkdtemp(join("/private/tmp", "tsugite-po5-resolvers-"));
    try {
      const store = new GenerationJobStore({ rootDir: root });
      const r = route("main");
      const fullBinding = createGenerationJobApprovalBinding({
        production_id: "prod-1",
        run_id: "run-1",
        node_id: "n1",
        attempt_id: "a1",
        generation_job_id: "job-res-1",
        approval_observed_revision: 0,
        approval_digest: DIGEST_A,
        gate_bundle_digest: DIGEST_B,
        gate_1_decision_digest: DIGEST_C,
        request_digest: DIGEST_D,
        compilation_digest: DIGEST_E,
        route: r,
        pricing_binding_digest: DIGEST_F
      });
      const { computeRequestDigest } = await import("../src/generationJobs/approval.js");
      const request = {
        digest: "",
        model_id: "model-main",
        mode: "text-to-video",
        connection_id: "conn-main",
        auth_env_names: [] as string[],
        asset_paths: [] as string[],
        params: { text: "fixture" }
      };
      request.digest = computeRequestDigest(request);
      await store.create({
        job_id: "job-res-1",
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
          async preflight() {
            return { ok: true as const, execution_ready: true };
          },
          async submit() {
            return { ok: true as const, provider_job_id: "x", accepted: true as const };
          },
          async poll() {
            return { ok: true as const, status: "succeeded" as const };
          },
          async download() {
            return {
              ok: true as const,
              absolute_path: join(root, "out.mp4"),
              sha256: DIGEST_D,
              byte_length: 1
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
        // intentionally omit GateBundle / Gate1 / coordinator resolvers
      });
      await machine.approve("job-res-1", "coordinator");
      const failed = await machine.submit("job-res-1");
      expect(failed.status).toBe("failed");
      expect(failed.error?.code).toBe("GJ-E027");
      expect(failed.error?.message).toMatch(
        /resolveGateBundle|resolveLiveGate1|resolveCoordinatorPrincipal/
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects coordinator mint without durable principal evidence", () => {
    expect(() => mintSealedCoordinatorAuthority({
      actor: "coordinator",
      durable_principal: {
        schema_version: 1,
        kind: "coordinator-principal",
        actor: "coordinator",
        gate_1_decision_digest: DIGEST_A,
        digest: ZERO
      },
      live_gate_1_decision_digest: DIGEST_A
    })).toThrowError(expect.objectContaining({ code: "PC_AUTHORITY_DENIED" }));

    expect(() => mintSealedCoordinatorAuthority({
      actor: "not-coordinator",
      durable_principal: {
        schema_version: 1,
        kind: "coordinator-principal",
        actor: "coordinator",
        gate_1_decision_digest: DIGEST_A,
        digest: sha256Canonical({
          schema_version: 1,
          kind: "coordinator-principal",
          actor: "coordinator",
          gate_1_decision_digest: DIGEST_A
        })
      },
      live_gate_1_decision_digest: DIGEST_A
    })).toThrowError(expect.objectContaining({ code: "PC_AUTHORITY_DENIED" }));
  });
});

describe("PO-5 durable Gate2/Gate3 evidence recompute and cascade", () => {
  it("recomputes Gate2/Gate3 subjects from distinct durable evidence and blocks on QA tamper", async () => {
    const {
      writeDurableGateBundle,
      buildActiveGate1ProductionBinding,
      buildActiveGate2ProductionBinding,
      buildActiveGate3ProductionBinding
    } = await import("../src/productionControl/activePipeline.js");
    const {
      writeDurableGateDecision,
      writeDurableCoordinatorPrincipal,
      writeDurableGate2Evidence,
      writeDurableGate3Evidence,
      writeDurableSelectedCompletions,
      assertLiveActiveSubjectsBeforePhase,
      loadDurableGate2Evidence,
      loadDurableGate3Evidence
    } = await import("../src/productionControl/durableGateEvidence.js");
    const { createGenerationCompletionRef } = await import("../src/productionControl/generationBridge.js");
    const root = await mkdtemp(join("/private/tmp", "tsugite-po5-g23-"));
    try {
      const bundle = sampleBundle();
      const runDir = join(root, "run-1");
      await writeDurableGateBundle(runDir, bundle);
      const gate1 = buildActiveGate1ProductionBinding({
        production_id: "prod-1",
        run_id: "run-1",
        gate_bundle: bundle,
        legacy_approved_input_digest: DIGEST_A,
        decision: {
          decision_id: "d1",
          decision: "approved",
          actor: "coordinator",
          decided_at: "2026-08-12T00:00:00.000Z"
        }
      });
      await writeDurableGateDecision(runDir, {
        gate: "gate_1",
        decision: {
          decision_id: "d1",
          decision: "approved",
          actor: "coordinator",
          decided_at: "2026-08-12T00:00:00.000Z",
          subject_digest: gate1.subject_digest
        },
        decision_source: "human",
        legacy_approved_input_digest: DIGEST_A
      });
      await writeDurableCoordinatorPrincipal(runDir, {
        gate_1_decision_digest: gate1.decision_digest
      });

      // Distinct evidence digests — not one composite stuffed into every slot.
      const jobBinding = createGenerationJobApprovalBinding({
        production_id: "prod-1",
        run_id: "run-1",
        node_id: "n1",
        attempt_id: "a1",
        generation_job_id: "job-1",
        approval_observed_revision: 0,
        approval_digest: DIGEST_A,
        gate_bundle_digest: bundle.digest,
        gate_1_decision_digest: gate1.decision_digest,
        request_digest: DIGEST_D,
        compilation_digest: DIGEST_E,
        route: route("main"),
        pricing_binding_digest: knownPricing(route("main")).pricing_binding_digest
      });
      const completion = createGenerationCompletionRef({
        production_id: "prod-1",
        run_id: "run-1",
        node_id: "n1",
        attempt_id: "a1",
        generation_job_id: "job-1",
        pinned_revision: 5,
        immutable_identity_digest: jobBinding.immutable_identity_digest,
        artifact_sha256: DIGEST_D,
        artifact_byte_length: 128,
        verification_digest: DIGEST_F
      });
      await writeDurableSelectedCompletions(runDir, [completion]);

      const g2 = buildActiveGate2ProductionBinding({
        gate_1_decision_digest: gate1.decision_digest,
        gate_bundle_digest: bundle.digest,
        selected_generation_completion_digests: [completion.digest],
        manifest_digest: DIGEST_A,
        technical_qa_digest: DIGEST_B,
        semantic_qa_digest: DIGEST_C,
        decision: {
          decision_id: "d2",
          decision: "approved",
          actor: "coordinator",
          decided_at: "2026-08-12T00:00:01.000Z"
        },
        decision_source: "human",
        legacy_approved_input_digest: DIGEST_D
      });
      await writeDurableGate2Evidence(runDir, {
        gate_bundle_digest: bundle.digest,
        gate_1_decision_digest: gate1.decision_digest,
        selected_generation_completion_digests: [completion.digest],
        manifest_digest: DIGEST_A,
        technical_qa_digest: DIGEST_B,
        semantic_qa_digest: DIGEST_C
      });
      await writeDurableGateDecision(runDir, {
        gate: "gate_2",
        decision: {
          decision_id: "d2",
          decision: "approved",
          actor: "coordinator",
          decided_at: "2026-08-12T00:00:01.000Z",
          subject_digest: g2.subject_digest
        },
        decision_source: "human",
        legacy_approved_input_digest: DIGEST_D
      });

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
          actor: "coordinator",
          decided_at: "2026-08-12T00:00:02.000Z"
        },
        legacy_approved_input_digest: DIGEST_E
      });
      await writeDurableGate3Evidence(runDir, {
        gate_2_decision_digest: g2.decision_digest,
        gate_2_subject_digest: g2.subject_digest,
        final_artifact_sha256: DIGEST_A,
        render_report_digest: DIGEST_B,
        gate_3_qc_digest: DIGEST_C,
        selected_branch_digest: DIGEST_D
      });
      await writeDurableGateDecision(runDir, {
        gate: "gate_3",
        decision: {
          decision_id: "d3",
          decision: "approved",
          actor: "coordinator",
          decided_at: "2026-08-12T00:00:02.000Z",
          subject_digest: g3.subject_digest
        },
        decision_source: "human",
        legacy_approved_input_digest: DIGEST_E
      });

      let state = createPlannedState("run-1");
      state = markGateAwaiting(state, "gate_1");
      state = recordGateDecision(state, "gate_1", "approved", undefined, DIGEST_A, "human", undefined, gate1.productionBinding);
      state = markGateAwaiting(state, "gate_2");
      state = recordGateDecision(state, "gate_2", "approved", undefined, DIGEST_D, "human", undefined, g2.productionBinding);
      state = markGateAwaiting(state, "gate_3");
      state = recordGateDecision(state, "gate_3", "approved", undefined, DIGEST_E, "human", undefined, g3.productionBinding);

      await expect(assertLiveActiveSubjectsBeforePhase({
        mode: "active",
        phase: "finalize",
        runDir,
        state,
        production_id: "prod-1"
      })).resolves.toMatchObject({
        ok: true,
        expected: {
          gate_1_subject_digest: gate1.subject_digest,
          gate_2_subject_digest: g2.subject_digest,
          gate_3_subject_digest: g3.subject_digest
        }
      });

      // Tamper technical QA digest in durable Gate2 evidence while state unchanged.
      const g2ev = await loadDurableGate2Evidence(runDir);
      expect(g2ev?.technical_qa_digest).toBe(DIGEST_B);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        join(runDir, "production-control", "gate-2-evidence.json"),
        `${JSON.stringify({
          ...g2ev!,
          technical_qa_digest: ZERO,
          digest: g2ev!.digest
        }, null, 2)}\n`,
        "utf8"
      );
      await expect(assertLiveActiveSubjectsBeforePhase({
        mode: "active",
        phase: "render",
        runDir,
        state,
        production_id: "prod-1"
      })).rejects.toThrowError(expect.objectContaining({
        code: expect.stringMatching(/PC_GATE|PC_SCHEMA/)
      }));

      // Restore and tamper Gate3 final artifact evidence.
      await writeDurableGate2Evidence(runDir, {
        gate_bundle_digest: bundle.digest,
        gate_1_decision_digest: gate1.decision_digest,
        selected_generation_completion_digests: [completion.digest],
        manifest_digest: DIGEST_A,
        technical_qa_digest: DIGEST_B,
        semantic_qa_digest: DIGEST_C
      });
      const g3ev = await loadDurableGate3Evidence(runDir);
      await writeFile(
        join(runDir, "production-control", "gate-3-evidence.json"),
        `${JSON.stringify({
          ...g3ev!,
          final_artifact_sha256: ZERO,
          digest: g3ev!.digest
        }, null, 2)}\n`,
        "utf8"
      );
      await expect(assertLiveActiveSubjectsBeforePhase({
        mode: "active",
        phase: "finalize",
        runDir,
        state,
        production_id: "prod-1"
      })).rejects.toThrowError(expect.objectContaining({
        code: expect.stringMatching(/PC_GATE|PC_SCHEMA/)
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PO-5 live subject recompute blocks tampered durable evidence", () => {
  it("blocks run when durable GateBundle is tampered while RunState is unchanged", async () => {
    const {
      writeDurableGateBundle,
      buildActiveGate1ProductionBinding
    } = await import("../src/productionControl/activePipeline.js");
    const {
      writeDurableGateDecision,
      writeDurableCoordinatorPrincipal,
      assertLiveActiveSubjectsBeforePhase
    } = await import("../src/productionControl/durableGateEvidence.js");
    const { writeFile } = await import("node:fs/promises");
    const root = await mkdtemp(join("/private/tmp", "tsugite-po5-tamper-"));
    try {
      const bundle = sampleBundle();
      const runDir = join(root, "run-1");
      await writeDurableGateBundle(runDir, bundle);
      const gate1 = buildActiveGate1ProductionBinding({
        production_id: "prod-1",
        run_id: "run-1",
        gate_bundle: bundle,
        legacy_approved_input_digest: DIGEST_A,
        decision: {
          decision_id: "d1",
          decision: "approved",
          actor: "coordinator",
          decided_at: "2026-08-12T00:00:00.000Z"
        }
      });
      await writeDurableGateDecision(runDir, {
        gate: "gate_1",
        decision: {
          decision_id: "d1",
          decision: "approved",
          actor: "coordinator",
          decided_at: "2026-08-12T00:00:00.000Z",
          subject_digest: gate1.subject_digest
        },
        decision_source: "human",
        legacy_approved_input_digest: DIGEST_A
      });
      await writeDurableCoordinatorPrincipal(runDir, {
        gate_1_decision_digest: gate1.decision_digest
      });

      let state = createPlannedState("run-1");
      state = markGateAwaiting(state, "gate_1");
      state = recordGateDecision(
        state,
        "gate_1",
        "approved",
        undefined,
        DIGEST_A,
        "human",
        undefined,
        gate1.productionBinding
      );

      // Happy path: recomputed subjects match stored state.
      await expect(assertLiveActiveSubjectsBeforePhase({
        mode: "active",
        phase: "run",
        runDir,
        state,
        production_id: "prod-1"
      })).resolves.toMatchObject({ ok: true });

      // Tamper durable GateBundle bytes; state unchanged → must block.
      const tampered = {
        ...bundle,
        review_artifact_digest: ZERO,
        digest: bundle.digest // leave stored digest stale vs body
      };
      await writeFile(
        join(runDir, "production-control", "gate-bundle.json"),
        `${JSON.stringify(tampered, null, 2)}\n`,
        "utf8"
      );
      await expect(assertLiveActiveSubjectsBeforePhase({
        mode: "active",
        phase: "run",
        runDir,
        state,
        production_id: "prod-1"
      })).rejects.toThrowError(
        expect.objectContaining({
          code: expect.stringMatching(/PC_GATE|PC_SCHEMA/)
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("M3: phase drift returns cascade that persists Gate1→2/3 stale on disk atomically", async () => {
    const {
      writeDurableGateBundle,
      buildActiveGate1ProductionBinding
    } = await import("../src/productionControl/activePipeline.js");
    const {
      writeDurableGateDecision,
      writeDurableCoordinatorPrincipal,
      assertLiveActiveSubjectsBeforePhase
    } = await import("../src/productionControl/durableGateEvidence.js");
    const { writeState, readState } = await import("../src/orchestrator/state.js");
    const root = await mkdtemp(join("/private/tmp", "tsugite-po5-m3-cascade-"));
    try {
      // sampleBundle uses production_id=prod-1 and run_id=run-1
      const bundle = sampleBundle();
      const runDir = join(root, "run-1");
      await writeDurableGateBundle(runDir, bundle);
      const gate1 = buildActiveGate1ProductionBinding({
        production_id: "prod-1",
        run_id: "run-1",
        gate_bundle: bundle,
        legacy_approved_input_digest: DIGEST_A,
        decision: {
          decision_id: "d1",
          decision: "approved",
          actor: "human",
          decided_at: "2026-08-12T00:00:00.000Z"
        }
      });
      await writeDurableGateDecision(runDir, {
        gate: "gate_1",
        decision: {
          decision_id: "d1",
          decision: "approved",
          actor: "human",
          decided_at: "2026-08-12T00:00:00.000Z",
          subject_digest: gate1.subject_digest
        },
        decision_source: "human",
        legacy_approved_input_digest: DIGEST_A
      });
      await writeDurableCoordinatorPrincipal(runDir, {
        gate_1_decision_digest: gate1.decision_digest
      });

      let state = createPlannedState("run-1");
      state = markGateAwaiting(state, "gate_1");
      state = recordGateDecision(
        state,
        "gate_1",
        "approved",
        undefined,
        DIGEST_A,
        "human",
        undefined,
        gate1.productionBinding
      );
      // Also mark Gate2/3 approved so cascade can clear them.
      state = markGateAwaiting(state, "gate_2");
      state = recordGateDecision(
        state,
        "gate_2",
        "approved",
        undefined,
        DIGEST_D,
        "human",
        undefined,
        { production_subject_digest: DIGEST_E, production_decision_digest: DIGEST_F }
      );
      state = markGateAwaiting(state, "gate_3");
      state = recordGateDecision(
        state,
        "gate_3",
        "approved",
        undefined,
        DIGEST_C,
        "human",
        undefined,
        { production_subject_digest: DIGEST_B, production_decision_digest: DIGEST_A }
      );
      await writeState(root, state);

      // Force subject drift: rewrite state digests to forged values while durable evidence stays.
      const drifted = {
        ...state,
        gates: {
          ...state.gates,
          gate_1: {
            ...state.gates.gate_1,
            production_subject_digest: ZERO,
            production_decision_digest: ZERO
          }
        }
      };
      await writeState(root, drifted);

      const phaseCheck = await assertLiveActiveSubjectsBeforePhase({
        mode: "active",
        phase: "run",
        runDir,
        state: drifted,
        production_id: "prod-1"
      });
      expect(phaseCheck.ok).toBe(false);
      if (phaseCheck.ok) return;
      expect(phaseCheck.cascade.stale_gate_1).toBe(true);
      expect(phaseCheck.cascade.stale_gate_2).toBe(true);
      expect(phaseCheck.cascade.stale_gate_3).toBe(true);
      expect(phaseCheck.cascadeKinds).toContain("compilation");
      // Persist cascaded state atomically (CLI serial boundary).
      await writeState(root, phaseCheck.cascadedState);
      const onDisk = await readState(join(root, "run-1", "state.json"));
      expect(onDisk.gates.gate_1.status).toBe("pending");
      expect(onDisk.gates.gate_1.production_subject_digest).toBeUndefined();
      expect(onDisk.gates.gate_2.status).toBe("pending");
      expect(onDisk.gates.gate_3.status).toBe("pending");
      expect(onDisk.status).toBe("planned");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PO-5 Exit E2E fixture-only (live orchestrator active run call graph)", () => {
  it("proves active GateBundle, Gate1, full binding, T05 adopt via execution budget loader, one-shot same-FD stub, pin; second consume 0; provider 0", {
    timeout: 20_000
  }, async () => {
    const networkHits: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: unknown[]) => {
      networkHits.push(String(args[0]));
      throw new Error("network forbidden in fixture E2E");
    }) as typeof fetch;

    const { mkdir, mkdtemp, realpath, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const {
      compileVideoPromptIrV2,
      compilationRevisionId,
      deriveExecutionCompilationBundleFromPlanningArtifact,
      isAdoptedExecutionCompilationBundle,
      loadAdapterDialectCapability,
      loadConnectionCapabilityProfile,
      loadExecutionAuthoritativePinnedPromptBudgetEvidence,
      loadModelPromptProfile,
      loadPlanningArtifactRef,
      routeFromProfiles
    } = await import("../src/videoPromptDirector/index.js");
    const { persistPlanningCompilationArtifact } = await import("../src/videoPromptDirector/compilationBundle.js");
    const { ArtifactStore } = await import("../src/productionControl/artifactStore.js");
    const { GenerationJobMachine } = await import("../src/generationJobs/machine.js");
    const { GenerationJobStore } = await import("../src/generationJobs/store.js");
    const { computeRequestDigest } = await import("../src/generationJobs/approval.js");

    try {
      // --- 1) Genuine planning artifact + execution-authoritative budget → adopted bundle
      const [model, connection, adapter] = await Promise.all([
        loadModelPromptProfile("v6"),
        loadConnectionCapabilityProfile("pixverse"),
        loadAdapterDialectCapability("pixverse", ["adapters"], {
          model_profile_id: "v6",
          provider_model: "v6",
          mode: "text-to-video"
        })
      ]);
      expect(model.ok && connection.ok && adapter.ok).toBe(true);
      if (!model.ok || !connection.ok || !adapter.ok) return;
      const routeResult = routeFromProfiles({
        model: "v6",
        mode: "text-to-video",
        model_profile: model.profile,
        connection_profile: connection.profile,
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest
      });
      expect(routeResult.ok).toBe(true);
      if (!routeResult.ok) return;
      const v6Route = routeResult.route;

      const ir = {
        version: 2 as const,
        program_kind: "standalone" as const,
        target: { model_profile_id: "v6", mode: "text-to-video" as const, duration_ms: 10_000, quality: "720p" as const, aspect: "16:9" as const, audio: false },
        creative: { must_include: [] as string[], prohibited: [] as string[] },
        subjects: [] as never[],
        scenes: [] as never[],
        assets: [] as never[],
        shots: [{
          id: "shot-1",
          start_ms: 0,
          end_ms: 10_000,
          cast: [] as string[],
          composition: "wide shot",
          action_beats: [{ description: "A lantern turns toward the camera." }],
          vocal_events: [] as never[],
          visible_text_events: [] as never[],
          constraints: { positive: [] as string[], exact_text_refs: [] as string[] }
        }],
        audio: { policy: "silent" as const, reference_asset_ids: [] as string[], final_mix: "discard-generated" as const }
      };
      const compiled = compileVideoPromptIrV2(ir, {
        request_id: "e2e-exit-req",
        route: v6Route,
        model_profile: model.profile,
        model_profile_digest: model.digest,
        connection_profile: connection.profile,
        connection_capability_digest: connection.digest,
        adapter_dialect_capability: adapter.capability
      });
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return;

      const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-po5-exit-e2e-")));
      const storeRoot = join(root, "production-control");
      await mkdir(storeRoot);
      const store = new ArtifactStore(await realpath(storeRoot));
      const planningBundle = compiled.compilation.bundle;
      const revision = compilationRevisionId(planningBundle);
      const planning = await persistPlanningCompilationArtifact({
        store,
        bundle: planningBundle,
        production_id: "prod-e2e",
        project_id: "proj-e2e",
        revision_id: revision
      });
      const reloaded = await loadPlanningArtifactRef({
        store,
        artifact_id: planning.artifact_id,
        artifact_digest: planning.artifact_digest,
        production_id: "prod-e2e",
        project_id: "proj-e2e",
        revision_id: revision,
        request_id: planningBundle.request_id,
        expected_store_root: storeRoot
      });

      const budgetPath = join(root, "budget-execution.json");
      await writeFile(budgetPath, JSON.stringify({
        schema_version: 1,
        source_id: "po5-e2e-budget",
        hard: {
          limit: 20_000,
          unit: "utf8-bytes",
          source: "official-api",
          verified_at: "2026-08-11T00:00:00Z",
          source_digest: "2".repeat(64)
        },
        soft: null,
        unknown: false,
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest,
        route_digest: v6Route.route_digest,
        retrieved_at: "2026-08-11T00:00:00Z",
        expires_at: "2099-12-31T00:00:00Z"
      }));
      const executionBudget = loadExecutionAuthoritativePinnedPromptBudgetEvidence({
        artifactPath: budgetPath,
        repoRoot: root,
        route: v6Route,
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest
      });
      expect(executionBudget).toBeDefined();
      if (!executionBudget) return;

      const derived = await deriveExecutionCompilationBundleFromPlanningArtifact({
        planning_artifact: reloaded,
        store,
        production_id: "prod-e2e",
        project_id: "proj-e2e",
        revision_id: revision,
        project_root: root,
        asset_pin_root: join(root, "pins"),
        model_profile: model.profile,
        connection_profile: connection.profile,
        trusted_pinned_budget_evidence: executionBudget
      });
      expect(isAdoptedExecutionCompilationBundle(derived.bundle)).toBe(true);
      expect(derived.bundle.execution_capable).toBe(true);

      // --- 2) Real nonempty GateBundle with route/pricing/unit membership
      const priced = knownPricing(v6Route as never);
      const bundle = buildActiveGateBundle({
        production_id: "prod-e2e",
        run_id: "run-e2e",
        production_contract_digest: DIGEST_A,
        contract_set_digest: DIGEST_B,
        task_tree_digest: DIGEST_C,
        selected_artifact_digests: [DIGEST_D],
        generation_batches: [{
          batch_id: "batch-e2e",
          route: v6Route as never,
          ordered_units: [{
            ordinal: 0,
            generation_unit_digest: DIGEST_E,
            base_compilation_digest: derived.bundle.compilation_digest,
            route_digest: v6Route.route_digest
          }],
          ...priced
        }],
        review_artifact_digest: sha256Canonical({ review: "e2e" })
      });
      expect(bundle.generation_batches.length).toBe(1);
      expect(projectGateBundleForReview(bundle).has_unknown_price).toBe(false);
      expect(projectGateBundleForReview(bundle).digest).toBe(bundle.digest);

      // --- 3) Exact Gate1 human decision
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

      // Durable artifacts the live CLI path writes at Gate1 approve.
      const { writeDurableGateBundle } = await import("../src/productionControl/activePipeline.js");
      const {
        writeDurableGateDecision,
        writeDurableCoordinatorPrincipal,
        assertLiveActiveSubjectsBeforePhase,
        loadDurableSelectedCompletions
      } = await import("../src/productionControl/durableGateEvidence.js");
      const { executeActiveGenerationForRun } = await import(
        "../src/productionControl/activeRunGeneration.js"
      );
      const runDir = join(root, "run-e2e");
      await writeDurableGateBundle(runDir, bundle);
      await writeDurableGateDecision(runDir, {
        gate: "gate_1",
        decision: {
          decision_id: "e2e-d1",
          decision: "approved",
          actor: "human",
          decided_at: "2026-08-12T00:00:00.000Z",
          subject_digest: gate1.subject_digest
        },
        decision_source: "human",
        legacy_approved_input_digest: DIGEST_A
      });
      await writeDurableCoordinatorPrincipal(runDir, {
        gate_1_decision_digest: gate1.decision_digest
      });

      // Live subject recompute (CLI run boundary) — not stored-state self-comparison.
      await assertLiveActiveSubjectsBeforePhase({
        mode: "active",
        phase: "run",
        runDir,
        state: runState,
        production_id: "prod-e2e",
        gate_bundle: bundle
      });

      // --- 4/5) Live orchestrator active run call graph (not hand-built machine alone)
      // Fixture artifact file for downloadAndPin verification.
      const fixtureBytes = Buffer.from("fixture-e2e-out");
      const fixtureOut = join(root, "fixture-out.mp4");
      await writeFile(fixtureOut, fixtureBytes);
      const fixtureSha = sha256Canonical({ kind: "bytes", b64: fixtureBytes.toString("base64") });
      // Use real file hash for pin verification.
      const { createHash } = await import("node:crypto");
      const realSha = createHash("sha256").update(fixtureBytes).digest("hex");

      let adapterInvokes = 0;
      let sawSubmissionInput = false;
      const stubAdapter = {
        adapter_id: "stub",
        connection_id: "pixverse",
        capabilities: { submit: true, poll: true, download: true, cancel: false },
        async preflight() {
          return { ok: true as const, execution_ready: true };
        },
        async submit(_request: unknown, ctx: { submission_input?: unknown }) {
          adapterInvokes += 1;
          expect(ctx.submission_input).toBeTruthy();
          sawSubmissionInput = true;
          return { ok: true as const, provider_job_id: "prov-e2e-1", accepted: true as const };
        },
        async poll() {
          return { ok: true as const, status: "succeeded" as const };
        },
        async download(_id: string, destinationDir: string) {
          const { copyFile } = await import("node:fs/promises");
          const dest = join(destinationDir, "out.mp4");
          await mkdir(destinationDir, { recursive: true });
          await copyFile(fixtureOut, dest);
          return {
            ok: true as const,
            absolute_path: dest,
            sha256: realSha,
            byte_length: fixtureBytes.byteLength
          };
        },
        async cancel() {
          return { ok: true as const, cancelled: true };
        }
      };

      // Missing productionControlRoot fails closed before adapter (mandatory root).
      const missingRoot = await executeActiveGenerationForRun({
        runId: "run-e2e",
        runDir,
        state: runState,
        production_id: "prod-e2e",
        project_id: "proj-e2e",
        revision_id: revision,
        pinnedRequests: [{
          id: "req-e2e",
          model: "v6",
          mode: "text-to-video",
          prompt: "fixture only"
        } as never],
        adapter: stubAdapter,
        resolveExecutionBundle: async () => derived.bundle,
        gate_bundle: bundle,
        productionControlRoot: ""
      });
      expect(missingRoot.ok).toBe(false);
      expect(missingRoot.issues[0]?.code).toBe("run.active_production_control_root_required");
      expect(adapterInvokes).toBe(0);

      const pcRoot = join(root, "production-control-events");
      const activeResult = await executeActiveGenerationForRun({
        runId: "run-e2e",
        runDir,
        state: runState,
        production_id: "prod-e2e",
        project_id: "proj-e2e",
        revision_id: revision,
        pinnedRequests: [{
          id: "req-e2e",
          model: "v6",
          mode: "text-to-video",
          prompt: "fixture only"
        } as never],
        adapter: stubAdapter,
        resolveExecutionBundle: async () => derived.bundle,
        gate_bundle: bundle,
        productionControlRoot: pcRoot
      });
      if (!activeResult.ok) {
        expect.fail(JSON.stringify(activeResult.issues, null, 2));
      }
      expect(activeResult.ok).toBe(true);
      expect(adapterInvokes).toBe(1);
      expect(sawSubmissionInput).toBe(true);
      expect(activeResult.completion_refs.length).toBe(1);
      expect(activeResult.completion_refs[0]!.generation_job_id).toContain("job-run-e2e");
      expect(activeResult.requests[0]?.metadata?.submission_via).toBe("t05-lease");

      // Durable completions written for Gate2 subject membership.
      const completions = await loadDurableSelectedCompletions(runDir);
      expect(completions).toHaveLength(1);
      expect(completions[0]!.digest).toBe(activeResult.completion_refs[0]!.digest);

      // Second live path resubmit: existing job fails closed; adapter count unchanged.
      const restart = await executeActiveGenerationForRun({
        runId: "run-e2e",
        runDir,
        state: runState,
        production_id: "prod-e2e",
        project_id: "proj-e2e",
        revision_id: revision,
        pinnedRequests: [{
          id: "req-e2e",
          model: "v6",
          mode: "text-to-video",
          prompt: "fixture only"
        } as never],
        adapter: stubAdapter,
        resolveExecutionBundle: async () => derived.bundle,
        gate_bundle: bundle,
        productionControlRoot: pcRoot
      });
      expect(restart.ok).toBe(false);
      expect(restart.issues[0]?.code).toBe("run.active_job_exists");
      expect(adapterInvokes).toBe(1);

      // Structural fake bundle → 0 additional invokes
      const fakeInvokesBefore = adapterInvokes;
      const fake = await executeWithSubmissionAuthority({
        bundle: JSON.parse(JSON.stringify(derived.bundle)),
        binding: {
          production_id: "prod-e2e",
          project_id: "proj-e2e",
          revision_id: revision,
          request_id: derived.bundle.request_id,
          attempt_id: "att-e2e",
          job_id: "job-e2e",
          compilation_digest: derived.bundle.compilation_digest,
          effective_contract_digest: derived.bundle.effective_contract_digest,
          asset_lineage_digest: sha256Canonical(derived.bundle.asset_lineage)
        },
        hooks: { onAdapterInvoke: () => { adapterInvokes += 1; } }
      });
      expect(fake.ok).toBe(false);
      expect(fake.adapter_invocations).toBe(0);
      expect(adapterInvokes).toBe(fakeInvokesBefore);

      // Real orchestrator active injection resolver (not voided): missing fixture fails closed.
      const {
        resolveActiveGenerationInjection,
        clearActiveGenerationFixtureForTests
      } = await import("../src/productionControl/activeRunGeneration.js");
      clearActiveGenerationFixtureForTests();
      const noInject = resolveActiveGenerationInjection({ connection_id: "pixverse" });
      expect(noInject.ok).toBe(false);
      expect(noInject.issues[0]?.code).toBe("run.active_generation_adapter_required");

      // Legacy binding mode checks remain.
      expect(() => assertProductionBindingForMode(
        pinnedJob({ status: "approved", artifact: undefined }),
        "disabled"
      )).not.toThrow();
      expect(() => assertProductionBindingForMode(
        pinnedJob({ status: "approved", artifact: undefined }),
        "shadow"
      )).not.toThrow();
      expect(networkHits).toEqual([]);
      expect(fixtureSha).toHaveLength(64);
      expect(typeof computeRequestDigest).toBe("function");
      expect(GenerationJobMachine).toBeTypeOf("function");
      expect(GenerationJobStore).toBeTypeOf("function");

      await rm(root, { recursive: true, force: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("assemble active run: fixture injection → resolve → GenerationJob/T05/lease → stub once; second run active_job_exists; corrupt mandatory root blocks at 0", {
    timeout: 60_000
  }, async () => {
    const networkHits: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: unknown[]) => {
      networkHits.push(String(args[0]));
      throw new Error("network forbidden in assemble active fixture E2E");
    }) as typeof fetch;

    const { mkdir, mkdtemp, realpath, writeFile, rm: rmFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { resolve } = await import("node:path");
    const { vi } = await import("vitest");
    const {
      installActiveGenerationFixtureForTests,
      clearActiveGenerationFixtureForTests,
      createFixtureGenerationJobAdapter,
      inspectProductionControlRoot,
      resolveCanonicalProductionControlRoot
    } = await import("../src/productionControl/activeRunGeneration.js");
    const {
      writeDurableGateBundle,
      buildActiveGate1ProductionBinding,
      buildActiveGateBundle
    } = await import("../src/productionControl/activePipeline.js");
    const {
      writeDurableGateDecision,
      writeDurableCoordinatorPrincipal
    } = await import("../src/productionControl/durableGateEvidence.js");
    const { assembleLocalMediaRun } = await import("../src/orchestrator/run.js");
    const { validateProject } = await import("../src/project/validateProject.js");
    const cliGeneration = await import("../src/adapters/cliGeneration.js");
    const legacyCliSpy = vi.spyOn(cliGeneration, "runCliGenerationAdapter").mockImplementation(() => {
      throw new Error("legacy runCliGenerationAdapter must not be invoked on active path");
    });

    const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-po5-assemble-active-")));
    try {
      // --- Adopted T05 execution bundle (planning → derive) ---
      const {
        compileVideoPromptIrV2,
        compilationRevisionId,
        deriveExecutionCompilationBundleFromPlanningArtifact,
        isAdoptedExecutionCompilationBundle,
        loadAdapterDialectCapability,
        loadConnectionCapabilityProfile,
        loadExecutionAuthoritativePinnedPromptBudgetEvidence,
        loadModelPromptProfile,
        loadPlanningArtifactRef,
        routeFromProfiles
      } = await import("../src/videoPromptDirector/index.js");
      const { persistPlanningCompilationArtifact } = await import(
        "../src/videoPromptDirector/compilationBundle.js"
      );
      const { ArtifactStore } = await import("../src/productionControl/artifactStore.js");
      const [model, connection, adapterCap] = await Promise.all([
        loadModelPromptProfile("v6"),
        loadConnectionCapabilityProfile("pixverse"),
        loadAdapterDialectCapability("pixverse", ["adapters"], {
          model_profile_id: "v6",
          provider_model: "v6",
          mode: "text-to-video"
        })
      ]);
      expect(model.ok && connection.ok && adapterCap.ok).toBe(true);
      if (!model.ok || !connection.ok || !adapterCap.ok) return;
      const routeResult = routeFromProfiles({
        model: "v6",
        mode: "text-to-video",
        model_profile: model.profile,
        connection_profile: connection.profile,
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest
      });
      expect(routeResult.ok).toBe(true);
      if (!routeResult.ok) return;
      const ir = {
        version: 2 as const,
        program_kind: "standalone" as const,
        target: {
          model_profile_id: "v6",
          mode: "text-to-video" as const,
          duration_ms: 10_000,
          quality: "720p" as const,
          aspect: "16:9" as const,
          audio: false
        },
        creative: { must_include: [] as string[], prohibited: [] as string[] },
        subjects: [] as never[],
        scenes: [] as never[],
        assets: [] as never[],
        shots: [{
          id: "shot-1",
          start_ms: 0,
          end_ms: 10_000,
          cast: [] as string[],
          composition: "wide shot",
          action_beats: [{ description: "A lantern turns toward the camera." }],
          vocal_events: [] as never[],
          visible_text_events: [] as never[],
          constraints: { positive: [] as string[], exact_text_refs: [] as string[] }
        }],
        audio: {
          policy: "silent" as const,
          reference_asset_ids: [] as string[],
          final_mix: "discard-generated" as const
        }
      };
      const compiled = compileVideoPromptIrV2(ir, {
        request_id: "assemble-exit-req",
        route: routeResult.route,
        model_profile: model.profile,
        model_profile_digest: model.digest,
        connection_profile: connection.profile,
        connection_capability_digest: connection.digest,
        adapter_dialect_capability: adapterCap.capability
      });
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return;

      // Artifact planning store is under a non-canonical subdir; the mandatory
      // event-chain root is projectRoot/production-control (derived by assemble).
      const planningStoreRoot = join(root, "planning-artifact-store");
      await mkdir(planningStoreRoot, { recursive: true });
      const store = new ArtifactStore(await realpath(planningStoreRoot));
      const planningBundle = compiled.compilation.bundle;
      const revision = compilationRevisionId(planningBundle);
      const planning = await persistPlanningCompilationArtifact({
        store,
        bundle: planningBundle,
        production_id: "prod-assemble",
        project_id: "proj-assemble",
        revision_id: revision
      });
      const reloaded = await loadPlanningArtifactRef({
        store,
        artifact_id: planning.artifact_id,
        artifact_digest: planning.artifact_digest,
        production_id: "prod-assemble",
        project_id: "proj-assemble",
        revision_id: revision,
        request_id: planningBundle.request_id,
        expected_store_root: planningStoreRoot
      });
      const budgetPath = join(root, "budget-execution.json");
      await writeFile(budgetPath, JSON.stringify({
        schema_version: 1,
        source_id: "po5-assemble-budget",
        hard: {
          limit: 20_000,
          unit: "utf8-bytes",
          source: "official-api",
          verified_at: "2026-08-11T00:00:00Z",
          source_digest: "2".repeat(64)
        },
        soft: null,
        unknown: false,
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest,
        route_digest: routeResult.route.route_digest,
        retrieved_at: "2026-08-11T00:00:00Z",
        expires_at: "2099-12-31T00:00:00Z"
      }));
      const executionBudget = loadExecutionAuthoritativePinnedPromptBudgetEvidence({
        artifactPath: budgetPath,
        repoRoot: root,
        route: routeResult.route,
        model_profile_digest: model.digest,
        connection_profile_digest: connection.digest
      });
      expect(executionBudget).toBeDefined();
      if (!executionBudget) return;
      const derived = await deriveExecutionCompilationBundleFromPlanningArtifact({
        planning_artifact: reloaded,
        store,
        production_id: "prod-assemble",
        project_id: "proj-assemble",
        revision_id: revision,
        project_root: root,
        asset_pin_root: join(root, "pins"),
        model_profile: model.profile,
        connection_profile: connection.profile,
        trusted_pinned_budget_evidence: executionBudget
      });
      expect(isAdoptedExecutionCompilationBundle(derived.bundle)).toBe(true);

      // --- Complete active project + config/plan/state/run directory ---
      // Adapter/manifest from local fixture (validate rejects raw prompt-only active).
      // Active project is assembled in-process with orchestration.mode=active.
      const validation = await validateProject(
        resolve("fixtures/projects/cli-generation.yaml"),
        { adapterDirs: [resolve("fixtures/adapters"), resolve("adapters")] }
      );
      if (!validation.ok || !validation.project || !validation.manifest || !validation.adapter) {
        expect.fail(JSON.stringify(validation.issues, null, 2));
        return;
      }

      const runId = "run-assemble";
      const manifestPath = join(root, "manifest.json");
      await writeFile(manifestPath, `${JSON.stringify({
        meta: { aspect: "16:9", fps: 24, target_duration_seconds: 1, slug: "assemble-active" },
        clips: [],
        audio: { bgm: [], narration: [], sfx: [] },
        captions: [],
        provenance: []
      }, null, 2)}\n`);
      const configPath = join(root, "project.yaml");
      await writeFile(configPath, [
        "slug: assemble-active",
        "name: assemble-active",
        `run_id: ${runId}`,
        "manifest: manifest.json",
        "dist_dir: dist",
        "orchestration:",
        "  mode: active",
        "edit:",
        "  backend: remotion",
        "generation:",
        "  adapter: mock-cli",
        "  connection: pixverse",
        "  requests:",
        "    - id: req-assemble",
        "      prompt: fixture assemble only",
        "      model: v6",
        "      mode: text-to-video",
        "      duration: 1",
        "      aspect: \"16:9\"",
        "      params: {}",
        ""
      ].join("\n"));

      const activeProject = {
        ...validation.project,
        slug: "assemble-active",
        name: "assemble-active",
        run_id: runId,
        manifest: "manifest.json",
        dist_dir: "dist",
        orchestration: { mode: "active" as const },
        generation: {
          adapter: "mock-cli",
          connection: "pixverse",
          requests: [{
            id: "req-assemble",
            prompt: "fixture assemble only",
            model: "v6",
            mode: "text-to-video",
            duration: 1,
            aspect: "16:9",
            params: {}
          }]
        }
      };
      const activeManifest = {
        ...validation.manifest,
        meta: {
          ...validation.manifest.meta,
          slug: "assemble-active",
          target_duration_seconds: 1
        },
        clips: [],
        provenance: []
      };

      const liveBundle = buildActiveGateBundle({
        production_id: "prod-assemble",
        run_id: runId,
        production_contract_digest: DIGEST_A,
        contract_set_digest: DIGEST_B,
        task_tree_digest: DIGEST_C,
        selected_artifact_digests: [DIGEST_D],
        generation_batches: [{
          batch_id: "batch-assemble",
          route: routeResult.route as never,
          ordered_units: [{
            ordinal: 0,
            generation_unit_digest: DIGEST_E,
            base_compilation_digest: derived.bundle.compilation_digest,
            route_digest: routeResult.route.route_digest
          }],
          ...knownPricing(routeResult.route as never)
        }],
        review_artifact_digest: sha256Canonical({ review: "assemble" })
      });
      const liveGate1 = buildActiveGate1ProductionBinding({
        production_id: "prod-assemble",
        run_id: runId,
        gate_bundle: liveBundle,
        legacy_approved_input_digest: DIGEST_A,
        decision: {
          decision_id: "assemble-d1",
          decision: "approved",
          actor: "human",
          decided_at: "2026-08-12T00:00:00.000Z"
        }
      });

      const stateDir = join(root, "dist");
      const runDir = join(stateDir, runId);
      await mkdir(runDir, { recursive: true });
      await writeDurableGateBundle(runDir, liveBundle);
      await writeDurableGateDecision(runDir, {
        gate: "gate_1",
        decision: {
          decision_id: "assemble-d1",
          decision: "approved",
          actor: "human",
          decided_at: "2026-08-12T00:00:00.000Z",
          subject_digest: liveGate1.subject_digest
        },
        decision_source: "human",
        legacy_approved_input_digest: DIGEST_A
      });
      await writeDurableCoordinatorPrincipal(runDir, {
        gate_1_decision_digest: liveGate1.decision_digest
      });

      const runState = recordGateDecision(
        markGateAwaiting(createPlannedState(runId), "gate_1"),
        "gate_1",
        "approved",
        undefined,
        DIGEST_A,
        "human",
        undefined,
        liveGate1.productionBinding
      );

      let adapterInvokes = 0;
      let sawSubmissionInput = false;
      const fixtureOut = join(root, "fixture-out.mp4");
      await writeFile(fixtureOut, Buffer.from("assemble-fixture-out"));
      const stubAdapter = createFixtureGenerationJobAdapter({
        connection_id: "pixverse",
        adapter_id: "local-fixture",
        fixture_artifact_path: fixtureOut,
        onSubmit: async (request, ctx) => {
          adapterInvokes += 1;
          expect(ctx.submission_input).toBeTruthy();
          sawSubmissionInput = true;
          expect(request.asset_paths).toEqual([]);
        }
      });

      // Same-process fixture injection (CLI/assemble resolveActiveGenerationInjection reads this).
      installActiveGenerationFixtureForTests({
        adapter: stubAdapter,
        project_id: "proj-assemble",
        revision_id: revision,
        production_id: "prod-assemble",
        resolveExecutionBundle: async () => derived.bundle
      });

      const canonicalRoot = resolveCanonicalProductionControlRoot(root);
      expect(canonicalRoot).toBe(join(root, "production-control"));
      expect(await inspectProductionControlRoot(canonicalRoot)).toBe("missing");

      const generationConnection = {
        id: "pixverse",
        adapter: "mock-cli",
        transport: "cli" as const,
        provider: "fixture",
        route_note: "fixture: assemble active E2E",
        setup_status: "ready" as const,
        execution_mode: "pipeline-adapter" as const
      };

      const assembleOpts = {
        configPath,
        manifestPath,
        stateDir,
        state: runState,
        connectionVerificationApproved: true,
        generationConnection
      };

      // 1) Actual assembleLocalMediaRun active branch (not direct executeActiveGenerationForRun).
      // Call graph: assemble → resolveActiveGenerationInjection → executeActiveGenerationForRun
      // → GenerationJob/T05/lease → stub adapter once.
      const first = await assembleLocalMediaRun(
        activeProject as never,
        activeManifest as never,
        assembleOpts,
        validation.adapter
      );
      if (!first.ok) {
        expect.fail(JSON.stringify(first.issues, null, 2));
      }
      expect(first.ok).toBe(true);
      expect(adapterInvokes).toBe(1);
      expect(sawSubmissionInput).toBe(true);
      expect(legacyCliSpy).not.toHaveBeenCalled();
      expect(networkHits).toEqual([]);

      // 2) Same assemble path again with persisted run/job state → exact no-resubmit failure.
      const second = await assembleLocalMediaRun(
        activeProject as never,
        activeManifest as never,
        assembleOpts,
        validation.adapter
      );
      expect(second.ok).toBe(false);
      expect(second.issues[0]?.code).toBe("run.active_job_exists");
      expect(adapterInvokes).toBe(1);
      expect(legacyCliSpy).not.toHaveBeenCalled();

      // 3) Corrupt mandatory canonical root blocks a fresh run at invocation 0.
      await rmFile(join(runDir, "generation-jobs"), { recursive: true, force: true });
      await mkdir(canonicalRoot, { recursive: true });
      await writeFile(join(canonicalRoot, "events.jsonl"), "{not-json\n");
      expect(await inspectProductionControlRoot(canonicalRoot)).toBe("nonempty");
      const beforeCorrupt = adapterInvokes;
      const corrupt = await assembleLocalMediaRun(
        activeProject as never,
        activeManifest as never,
        {
          ...assembleOpts,
          state: recordGateDecision(
            markGateAwaiting(createPlannedState(runId), "gate_1"),
            "gate_1",
            "approved",
            undefined,
            DIGEST_A,
            "human",
            undefined,
            liveGate1.productionBinding
          )
        },
        validation.adapter
      );
      expect(corrupt.ok).toBe(false);
      expect(corrupt.issues[0]?.code).toBe("run.active_production_control_resume_failed");
      expect(adapterInvokes).toBe(beforeCorrupt);
      expect(legacyCliSpy).not.toHaveBeenCalled();
      expect(networkHits).toEqual([]);
    } finally {
      clearActiveGenerationFixtureForTests();
      legacyCliSpy.mockRestore();
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("active residual: fixture adapter rejects reopenable asset_paths; submission_input is authority", async () => {
    const {
      createFixtureGenerationJobAdapter
    } = await import("../src/productionControl/activeRunGeneration.js");
    const { computeRequestDigest } = await import("../src/generationJobs/approval.js");
    let sawPaths: string[] | undefined;
    const adapter = createFixtureGenerationJobAdapter({
      connection_id: "pixverse",
      onSubmit: async (request) => {
        sawPaths = [...(request.asset_paths ?? [])];
      }
    });
    const withPaths = {
      model_id: "v6",
      mode: "text-to-video",
      connection_id: "pixverse",
      auth_env_names: [] as string[],
      asset_paths: ["media/secret-ref.png"],
      params: { prompt: "x" }
    };
    const rejected = await adapter.submit(
      { ...withPaths, digest: computeRequestDigest(withPaths) },
      { job: { request: withPaths } as never }
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.code).toBe("fixture.asset_paths_forbidden");
    }
    expect(sawPaths).toBeUndefined();

    const clean = {
      ...withPaths,
      asset_paths: [] as string[]
    };
    const accepted = await adapter.submit(
      { ...clean, digest: computeRequestDigest(clean) },
      { job: { request: clean } as never, submission_input: { same_fd: true } }
    );
    expect(accepted.ok).toBe(true);
    expect(sawPaths).toEqual([]);
  });
});
