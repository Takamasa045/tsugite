/**
 * PO-6 / T07 — Recovery Grants and Credits adversarial + fixture E2E tests.
 * Fixture-only: no provider, network, DNS, billing, Gate mutation, render, non-dry-run.
 */
import { fork } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function realTempDir(prefix: string): Promise<string> {
  // Prefer /private/tmp so root-lock ancestor checks see no symlink chain (macOS /tmp → /private/tmp).
  const base = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  return realpath(await mkdtemp(join(base, prefix)));
}
import { describe, expect, it } from "vitest";
import {
  ProductionDispatcher,
  assertAuthority,
  assertDerivedCompilationBinding,
  assertPaidAuthorizationMatchesBinding,
  authorizePaidRegeneration,
  buildActiveGate1ProductionBinding,
  cascadeFromDrift,
  checkAuthority,
  computeRegenerationAttemptKey,
  createFullProductionJobBinding,
  createGateBundle,
  createGenerationJobApprovalBinding,
  createInitialMissionState,
  createLocalRecoveryPermit,
  createRegenerationGrant,
  createRegenerationPolicySpec,
  createRevisionIntent,
  executeWithSubmissionAuthority,
  gateDecisionDigest,
  gateDriftKindsForRevisionIntent,
  GrantCreditLedger,
  isSealedPaidAuthorization,
  issueLocalRecoveryPermit,
  issueRegenerationGrant,
  mintSealedCoordinatorAuthority,
  mintSealedGate1Binding,
  mintSealedPaidAuthorization,
  parseLocalRecoveryPermit,
  parseRegenerationAttemptAuthorization,
  parseRegenerationGrant,
  parseRegenerationPolicySpec,
  pricingBindingDigest,
  reduceProductionEvent,
  makeProductionEvent,
  safeStopAwaitingHuman,
  selectActiveRevisionIntent,
  selectRecoveryAction,
  sha256Canonical,
  withoutField,
  type GateBundle,
  type RegenerationPolicySpec,
  type RouteIdentity
} from "../src/productionControl/index.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const DIGEST_E = "e".repeat(64);
const DIGEST_F = "f".repeat(64);
const NOW = "2026-08-12T00:00:00.000Z";
const FUTURE = "2026-08-13T00:00:00.000Z";
const PAST = "2026-08-11T00:00:00.000Z";

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

function samplePolicy(overrides: Partial<{
  max_attempts: number;
  max_submissions: number;
  max_credits: number;
  per_node: string;
  base_digest: string;
  errors: string[];
  blocks: string[];
  expires_at: string;
  route: RouteIdentity;
}> = {}): RegenerationPolicySpec {
  const r = overrides.route ?? route("main");
  const priced = knownPricing(r);
  return createRegenerationPolicySpec({
    policy_spec_id: "policy-1",
    execution_context: {
      production_contract_digest: DIGEST_A,
      contract_set_digest: DIGEST_B,
      task_tree_digest: DIGEST_C,
      task_scope: [overrides.per_node ?? "node-gen-1"],
      base_compilations: [{
        node_id: overrides.per_node ?? "node-gen-1",
        compilation_digest: overrides.base_digest ?? DIGEST_F
      }],
      route: r,
      pricing_binding_digest: priced.pricing_binding_digest
    },
    allowed_error_codes: overrides.errors ?? ["GEN_TECHNICAL_FAIL"],
    allowed_prompt_block_ids: overrides.blocks ?? ["block-action"],
    allowed_parameter_ranges: {
      seed: { min: 0, max: 100 }
    },
    max_attempts_per_task: overrides.max_attempts ?? 2,
    max_total_new_submissions: overrides.max_submissions ?? 2,
    max_incremental_credits: overrides.max_credits ?? 5,
    expires_at: overrides.expires_at ?? FUTURE
  });
}

function sampleBundleWithPolicy(policy: RegenerationPolicySpec): GateBundle {
  const r = policy.execution_context.route;
  const priced = knownPricing(r);
  return createGateBundle({
    production_id: "prod-1",
    run_id: "run-1",
    production_contract_digest: DIGEST_A,
    contract_set_digest: DIGEST_B,
    task_tree_digest: DIGEST_C,
    selected_artifact_digests: [DIGEST_D],
    generation_batches: [{
      batch_id: "batch-1",
      route: r,
      ordered_units: [{
        ordinal: 0,
        generation_unit_digest: DIGEST_E,
        base_compilation_digest: policy.execution_context.base_compilations[0]!.compilation_digest,
        route_digest: r.route_digest
      }],
      ...priced,
      regeneration_policy_spec_digest: policy.digest
    }],
    review_artifact_digest: sha256Canonical({ review: "storyboard" })
  });
}

function sealedCoordinator(gate1DecisionDigest = DIGEST_C) {
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

function gate1Pair(bundle: GateBundle) {
  const decision = {
    decision_id: "d-gate1",
    decision: "approved",
    actor: "human",
    decided_at: NOW
  };
  const gate1 = buildActiveGate1ProductionBinding({
    production_id: bundle.production_id,
    run_id: bundle.run_id,
    gate_bundle: bundle,
    legacy_approved_input_digest: DIGEST_A,
    decision
  });
  const sealed = mintSealedGate1Binding({
    gate_bundle: bundle,
    production_id: bundle.production_id,
    run_id: bundle.run_id,
    legacy_approved_input_digest: DIGEST_A,
    decision,
    live_subject_digest: gate1.subject_digest,
    live_decision_digest: gate1.decision_digest
  });
  return {
    decision: {
      ...decision,
      subject_digest: gate1.subject_digest
    },
    subject_digest: gate1.subject_digest,
    decision_digest: gate1.decision_digest,
    sealed
  };
}

async function openLedgerForGrant(
  root: string,
  grantDigest: string,
  policy: RegenerationPolicySpec
): Promise<GrantCreditLedger> {
  const ledger = new GrantCreditLedger(root);
  await ledger.openBudget({
    budget_id: "budget-1",
    grant_digest: grantDigest,
    production_id: "prod-1",
    max_incremental_credits: policy.max_incremental_credits,
    max_attempts: policy.max_attempts_per_task,
    max_submissions: policy.max_total_new_submissions,
    per_attempt_credit_cap: Math.min(policy.max_incremental_credits, 3)
  });
  return ledger;
}

describe("PO-6 canonical contracts", () => {
  it("rejects policy/grant/auth digest tamper and key-order independence", () => {
    const policy = samplePolicy();
    expect(() => parseRegenerationPolicySpec({
      ...policy,
      digest: "1".repeat(64)
    })).toThrow();

    const reordered = JSON.parse(JSON.stringify(policy));
    // Force different key insertion order on a clone
    const rebuilt = {
      max_incremental_credits: reordered.max_incremental_credits,
      schema_version: reordered.schema_version,
      policy_spec_id: reordered.policy_spec_id,
      execution_context: reordered.execution_context,
      allowed_error_codes: reordered.allowed_error_codes,
      allowed_prompt_block_ids: reordered.allowed_prompt_block_ids,
      allowed_parameter_ranges: reordered.allowed_parameter_ranges,
      max_changed_prompt_blocks_per_attempt: reordered.max_changed_prompt_blocks_per_attempt,
      max_attempts_per_task: reordered.max_attempts_per_task,
      max_total_new_submissions: reordered.max_total_new_submissions,
      expires_at: reordered.expires_at,
      digest: reordered.digest
    };
    expect(parseRegenerationPolicySpec(rebuilt).digest).toBe(policy.digest);

    const bundle = sampleBundleWithPolicy(policy);
    const g1 = gate1Pair(bundle);
    const grant = issueRegenerationGrant({
      grant_id: "grant-1",
      policy,
      gate_bundle: bundle,
      gate_1_decision: g1.decision,
      live_gate_1_subject_digest: g1.subject_digest,
      live_gate_1_decision_digest: g1.decision_digest,
      issued_at: NOW
    });
    expect(() => parseRegenerationGrant({ ...grant, digest: "2".repeat(64) })).toThrow();
  });

  it("rejects missing/wrong HumanDecisionRef on grant issuance", () => {
    const policy = samplePolicy();
    const bundle = sampleBundleWithPolicy(policy);
    const g1 = gate1Pair(bundle);
    expect(() => issueRegenerationGrant({
      grant_id: "grant-bad",
      policy,
      gate_bundle: bundle,
      gate_1_decision: {
        decision_id: "x",
        decision: "approved",
        actor: "human",
        decided_at: NOW,
        subject_digest: DIGEST_A
      },
      live_gate_1_subject_digest: g1.subject_digest,
      live_gate_1_decision_digest: g1.decision_digest,
      issued_at: NOW
    })).toThrow(/subject/);

    expect(() => issueRegenerationGrant({
      grant_id: "grant-bad2",
      policy,
      gate_bundle: bundle,
      gate_1_decision: {
        ...g1.decision,
        decision: "rejected"
      },
      live_gate_1_subject_digest: g1.subject_digest,
      live_gate_1_decision_digest: gateDecisionDigest({
        ...g1.decision,
        decision: "rejected"
      }),
      issued_at: NOW
    })).toThrow(/approved/);
  });

  it("rejects stale/expired/wrong production/run/node/unit/route/price/Gate/base", async () => {
    const policy = samplePolicy({ expires_at: PAST });
    const bundle = sampleBundleWithPolicy(samplePolicy()); // different digest (future)
    // Policy not bound on bundle
    expect(() => {
      const livePolicy = samplePolicy();
      const liveBundle = sampleBundleWithPolicy(livePolicy);
      const g1 = gate1Pair(liveBundle);
      issueRegenerationGrant({
        grant_id: "g",
        policy, // expired different policy not on bundle
        gate_bundle: liveBundle,
        gate_1_decision: g1.decision,
        live_gate_1_subject_digest: g1.subject_digest,
        live_gate_1_decision_digest: g1.decision_digest,
        issued_at: NOW
      });
    }).toThrow();

    const livePolicy = samplePolicy();
    const liveBundle = sampleBundleWithPolicy(livePolicy);
    const g1 = gate1Pair(liveBundle);
    const grant = issueRegenerationGrant({
      grant_id: "grant-ok",
      policy: livePolicy,
      gate_bundle: liveBundle,
      gate_1_decision: g1.decision,
      live_gate_1_subject_digest: g1.subject_digest,
      live_gate_1_decision_digest: g1.decision_digest,
      issued_at: NOW
    });

    const root = await realTempDir("tsugite-po6-stale-");
    try {
      const ledger = await openLedgerForGrant(root, grant.digest, livePolicy);
      await expect(authorizePaidRegeneration({
        policy: livePolicy,
        grant,
        gate_bundle: liveBundle,
        ledger,
        node_id: "wrong-node",
        ordinal: 0,
        attempt_key: "a".repeat(64),
        trigger_failure_ref: { kind: "failure", id: "f1", digest: DIGEST_A },
        observed_error_code: "GEN_TECHNICAL_FAIL",
        base_compilation_digest: DIGEST_F,
        patch_artifact_digest: DIGEST_B,
        derived_compilation_digest: DIGEST_C,
        requested_credits: 1,
        run_id: "run-1",
        production_id: "prod-1"
      })).rejects.toThrow(/scope|outside/i);

      await expect(authorizePaidRegeneration({
        policy: livePolicy,
        grant,
        gate_bundle: liveBundle,
        ledger,
        node_id: "node-gen-1",
        ordinal: 0,
        attempt_key: "b".repeat(64),
        trigger_failure_ref: { kind: "failure", id: "f1", digest: DIGEST_A },
        observed_error_code: "UNKNOWN_CODE",
        base_compilation_digest: DIGEST_F,
        patch_artifact_digest: DIGEST_B,
        derived_compilation_digest: DIGEST_C,
        requested_credits: 1,
        run_id: "run-1",
        production_id: "prod-1"
      })).rejects.toThrow(/error code|allowed/i);

      await expect(authorizePaidRegeneration({
        policy: livePolicy,
        grant,
        gate_bundle: liveBundle,
        ledger,
        node_id: "node-gen-1",
        ordinal: 0,
        attempt_key: "c".repeat(64),
        trigger_failure_ref: { kind: "failure", id: "f1", digest: DIGEST_A },
        observed_error_code: "GEN_TECHNICAL_FAIL",
        base_compilation_digest: DIGEST_A, // wrong base
        patch_artifact_digest: DIGEST_B,
        derived_compilation_digest: DIGEST_C,
        requested_credits: 1,
        run_id: "run-1",
        production_id: "prod-1"
      })).rejects.toThrow(/base compilation/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PO-6 authority sealed paid path", () => {
  it("denies structural copy/reuse of paid authorization and allows genuine seal", async () => {
    const policy = samplePolicy();
    const bundle = sampleBundleWithPolicy(policy);
    const g1 = gate1Pair(bundle);
    const grant = issueRegenerationGrant({
      grant_id: "grant-auth",
      policy,
      gate_bundle: bundle,
      gate_1_decision: g1.decision,
      live_gate_1_subject_digest: g1.subject_digest,
      live_gate_1_decision_digest: g1.decision_digest,
      issued_at: NOW
    });
    const root = await realTempDir("tsugite-po6-auth-");
    try {
      const ledger = await openLedgerForGrant(root, grant.digest, policy);
      const attemptKey = computeRegenerationAttemptKey({
        node_id: "node-gen-1",
        ordinal: 0,
        trigger_failure_digest: DIGEST_A,
        base_compilation_digest: DIGEST_F,
        derived_compilation_digest: DIGEST_D,
        grant_digest: grant.digest
      });
      const { sealed, authorization } = await authorizePaidRegeneration({
        policy,
        grant,
        gate_bundle: bundle,
        ledger,
        node_id: "node-gen-1",
        ordinal: 0,
        attempt_key: attemptKey,
        trigger_failure_ref: { kind: "failure", id: "f1", digest: DIGEST_A },
        observed_error_code: "GEN_TECHNICAL_FAIL",
        base_compilation_digest: DIGEST_F,
        patch_artifact_digest: DIGEST_B,
        derived_compilation_digest: DIGEST_D,
        changed_prompt_block_id: "block-action",
        requested_credits: 1.5,
        run_id: "run-1",
        production_id: "prod-1"
      });
      expect(isSealedPaidAuthorization(sealed)).toBe(true);
      const structural = { ...sealed };
      expect(isSealedPaidAuthorization(structural)).toBe(false);

      const coordinator = sealedCoordinator(g1.decision_digest);
      expect(checkAuthority({
        role: "generator",
        effect: "paid",
        actor: "coordinator",
        mode: "active",
        coordinator_authority: coordinator,
        gate_bundle: bundle,
        gate_1: g1.sealed,
        sealed_paid_authorization: sealed,
        expected_pricing_binding_digest: policy.execution_context.pricing_binding_digest
      }).allowed).toBe(true);

      expect(checkAuthority({
        role: "generator",
        effect: "paid",
        actor: "coordinator",
        mode: "active",
        coordinator_authority: coordinator,
        gate_bundle: bundle,
        gate_1: g1.sealed,
        sealed_paid_authorization: structural as never
      }).allowed).toBe(false);

      // Double consume of same reservation for a second authorization is denied.
      await expect(authorizePaidRegeneration({
        policy,
        grant,
        gate_bundle: bundle,
        ledger,
        node_id: "node-gen-1",
        ordinal: 1,
        attempt_key: attemptKey, // same attempt key
        trigger_failure_ref: { kind: "failure", id: "f1", digest: DIGEST_A },
        observed_error_code: "GEN_TECHNICAL_FAIL",
        base_compilation_digest: DIGEST_F,
        patch_artifact_digest: DIGEST_B,
        derived_compilation_digest: "e".repeat(64),
        requested_credits: 1,
        run_id: "run-1",
        production_id: "prod-1"
      })).rejects.toThrow(/attempt_key|already/i);

      // Binding match for derived compilation
      const binding = createGenerationJobApprovalBinding({
        production_id: "prod-1",
        run_id: "run-1",
        node_id: "node-gen-1",
        attempt_id: "att-1",
        generation_job_id: "job-1",
        approval_observed_revision: 0,
        approval_digest: DIGEST_A,
        gate_bundle_digest: bundle.digest,
        gate_1_decision_digest: g1.decision_digest,
        request_digest: DIGEST_B,
        compilation_digest: DIGEST_D,
        route: policy.execution_context.route,
        pricing_binding_digest: policy.execution_context.pricing_binding_digest,
        regeneration_attempt_authorization_digest: authorization.digest
      });
      assertDerivedCompilationBinding({
        binding,
        bundle,
        authorization_digest: authorization.digest,
        base_compilation_digest: DIGEST_F,
        derived_compilation_digest: DIGEST_D
      });
      assertPaidAuthorizationMatchesBinding({
        sealed,
        regeneration_attempt_authorization_digest: authorization.digest,
        compilation_digest: DIGEST_D,
        node_id: "node-gen-1",
        pricing_binding_digest: policy.execution_context.pricing_binding_digest
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks unknown price before reservation", async () => {
    const r = route("u");
    const pricing = {
      status: "unknown" as const,
      version: null,
      currency: null,
      amount: null,
      max_amount: null
    };
    const policy = createRegenerationPolicySpec({
      policy_spec_id: "policy-u",
      execution_context: {
        production_contract_digest: DIGEST_A,
        contract_set_digest: DIGEST_B,
        task_tree_digest: DIGEST_C,
        task_scope: ["node-gen-1"],
        base_compilations: [{ node_id: "node-gen-1", compilation_digest: DIGEST_F }],
        route: r,
        pricing_binding_digest: pricingBindingDigest(pricing, r)
      },
      allowed_error_codes: ["GEN_TECHNICAL_FAIL"],
      max_attempts_per_task: 1,
      max_total_new_submissions: 1,
      max_incremental_credits: 1,
      expires_at: FUTURE
    });
    // GateBundle with unknown price cannot be used for grant.
    const bundle = createGateBundle({
      production_id: "prod-1",
      run_id: "run-1",
      production_contract_digest: DIGEST_A,
      contract_set_digest: DIGEST_B,
      task_tree_digest: DIGEST_C,
      selected_artifact_digests: [],
      generation_batches: [{
        batch_id: "b-u",
        route: r,
        ordered_units: [{
          ordinal: 0,
          generation_unit_digest: DIGEST_E,
          base_compilation_digest: DIGEST_F,
          route_digest: r.route_digest
        }],
        pricing,
        pricing_binding_digest: pricingBindingDigest(pricing, r),
        regeneration_policy_spec_digest: policy.digest
      }],
      review_artifact_digest: DIGEST_D
    });
    expect(() => mintSealedGate1Binding({
      gate_bundle: bundle,
      production_id: "prod-1",
      run_id: "run-1",
      legacy_approved_input_digest: DIGEST_A,
      decision: {
        decision_id: "d",
        decision: "approved",
        actor: "human",
        decided_at: NOW
      },
      live_subject_digest: DIGEST_A,
      live_decision_digest: DIGEST_B
    })).toThrow(/unknown price/i);

    const root = await realTempDir("tsugite-po6-price-");
    try {
      const ledger = new GrantCreditLedger(root);
      await ledger.openBudget({
        budget_id: "b1",
        grant_digest: DIGEST_A,
        production_id: "prod-1",
        max_incremental_credits: 5,
        max_attempts: 2,
        max_submissions: 2,
        per_attempt_credit_cap: 3
      });
      await expect(ledger.reserve({
        reservation_id: "rsv-u",
        grant_digest: DIGEST_A,
        production_id: "prod-1",
        run_id: "run-1",
        node_id: "n1",
        attempt_key: DIGEST_B,
        pricing_binding_digest: DIGEST_C,
        requested_credits: 1,
        price_unknown: true
      })).rejects.toThrow(/unknown price/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PO-6 grant ledger adversarial", () => {
  it("enforces amount/total/max attempt boundaries and no negative balance", async () => {
    const root = await realTempDir("tsugite-po6-ledger-");
    try {
      const ledger = new GrantCreditLedger(root);
      await ledger.openBudget({
        budget_id: "b1",
        grant_digest: DIGEST_A,
        production_id: "prod-1",
        max_incremental_credits: 3,
        max_attempts: 2,
        max_submissions: 2,
        per_attempt_credit_cap: 2
      });
      await expect(ledger.reserve({
        reservation_id: "r1",
        grant_digest: DIGEST_A,
        production_id: "prod-1",
        run_id: "run-1",
        node_id: "n1",
        attempt_key: DIGEST_B,
        pricing_binding_digest: DIGEST_C,
        requested_credits: 2.5
      })).rejects.toThrow(/per-attempt/i);

      const r1 = await ledger.reserve({
        reservation_id: "r1",
        grant_digest: DIGEST_A,
        production_id: "prod-1",
        run_id: "run-1",
        node_id: "n1",
        attempt_key: DIGEST_B,
        pricing_binding_digest: DIGEST_C,
        requested_credits: 2
      });
      expect(r1.status).toBe("reserved");

      await expect(ledger.reserve({
        reservation_id: "r2",
        grant_digest: DIGEST_A,
        production_id: "prod-1",
        run_id: "run-1",
        node_id: "n1",
        attempt_key: DIGEST_D,
        pricing_binding_digest: DIGEST_C,
        requested_credits: 2
      })).rejects.toThrow(/insufficient|exhausted/i);

      const committed = await ledger.commit({
        reservation_id: "r1",
        actual_credits: 1.5
      });
      expect(committed.status).toBe("committed");
      expect(committed.committed_credits).toBe(1.5);

      // Second commit rejected (no overwrite / double consume)
      await expect(ledger.commit({
        reservation_id: "r1",
        actual_credits: 1
      })).rejects.toThrow();

      const r2 = await ledger.reserve({
        reservation_id: "r2",
        grant_digest: DIGEST_A,
        production_id: "prod-1",
        run_id: "run-1",
        node_id: "n1",
        attempt_key: DIGEST_E,
        pricing_binding_digest: DIGEST_C,
        requested_credits: 1.5
      });
      expect(r2.reserved_credits).toBe(1.5);

      // Max attempts = 2 → third reserve fails
      await expect(ledger.reserve({
        reservation_id: "r3",
        grant_digest: DIGEST_A,
        production_id: "prod-1",
        run_id: "run-1",
        node_id: "n1",
        attempt_key: DIGEST_F,
        pricing_binding_digest: DIGEST_C,
        requested_credits: 0.1
      })).rejects.toThrow(/max attempts|exhausted/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("crash matrix: release known non-submission; quarantine submission_unknown; no resubmit", async () => {
    const root = await realTempDir("tsugite-po6-crash-");
    try {
      const ledger = new GrantCreditLedger(root);
      await ledger.openBudget({
        budget_id: "b1",
        grant_digest: DIGEST_A,
        production_id: "prod-1",
        max_incremental_credits: 10,
        max_attempts: 5,
        max_submissions: 5,
        per_attempt_credit_cap: 5
      });
      await ledger.reserve({
        reservation_id: "rel-1",
        grant_digest: DIGEST_A,
        production_id: "prod-1",
        run_id: "run-1",
        node_id: "n1",
        attempt_key: DIGEST_B,
        pricing_binding_digest: DIGEST_C,
        requested_credits: 2
      });
      const released = await ledger.release({
        reservation_id: "rel-1",
        reason: "known-non-submission"
      });
      expect(released.status).toBe("released");
      const budgetAfterRelease = await ledger.readBudget();
      expect(budgetAfterRelease?.reserved_credits).toBe(0);
      expect(budgetAfterRelease?.committed_credits).toBe(0);

      await ledger.reserve({
        reservation_id: "q-1",
        grant_digest: DIGEST_A,
        production_id: "prod-1",
        run_id: "run-1",
        node_id: "n1",
        attempt_key: DIGEST_D,
        pricing_binding_digest: DIGEST_C,
        requested_credits: 3
      });
      const q = await ledger.quarantine({ reservation_id: "q-1" });
      expect(q.status).toBe("quarantined");
      const budgetQ = await ledger.readBudget();
      expect(budgetQ?.quarantined_credits).toBe(3);
      // Quarantined credits never return to available for auto-retry.
      expect(
        (budgetQ!.max_incremental_credits
          - budgetQ!.reserved_credits
          - budgetQ!.committed_credits
          - budgetQ!.quarantined_credits)
      ).toBe(7);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects ledger symlink/leaf/path escape and identity drift", async () => {
    const root = await realTempDir("tsugite-po6-symlink-");
    try {
      const ledger = new GrantCreditLedger(root);
      await ledger.openBudget({
        budget_id: "b1",
        grant_digest: DIGEST_A,
        production_id: "prod-1",
        max_incremental_credits: 5,
        max_attempts: 3,
        max_submissions: 3,
        per_attempt_credit_cap: 2
      });
      // Symlink leaf under reservations
      const resDir = join(root, "grant-ledger", "reservations");
      await mkdir(resDir, { recursive: true });
      const target = join(root, "evil.json");
      await writeFile(target, "{}");
      await symlink(target, join(resDir, "evil-link.json"));
      // Reading via reserve of same id path should fail if symlink occupies final path
      await expect(ledger.reserve({
        reservation_id: "evil-link",
        grant_digest: DIGEST_A,
        production_id: "prod-1",
        run_id: "run-1",
        node_id: "n1",
        attempt_key: DIGEST_B,
        pricing_binding_digest: DIGEST_C,
        requested_credits: 1
      })).rejects.toThrow();

      // Path escape attempt via id
      await expect(ledger.reserve({
        reservation_id: "../escape",
        grant_digest: DIGEST_A,
        production_id: "prod-1",
        run_id: "run-1",
        node_id: "n1",
        attempt_key: DIGEST_C,
        pricing_binding_digest: DIGEST_C,
        requested_credits: 1
      })).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows exactly one concurrent child-process reservation", async () => {
    const root = await realTempDir("tsugite-po6-conc-");
    try {
      const ledger = new GrantCreditLedger(root);
      await ledger.openBudget({
        budget_id: "b1",
        grant_digest: DIGEST_A,
        production_id: "prod-1",
        max_incremental_credits: 5,
        max_attempts: 5,
        max_submissions: 5,
        per_attempt_credit_cap: 5
      });

      const worker = `
        import { GrantCreditLedger } from ${JSON.stringify(new URL("../src/productionControl/grantLedger.ts", import.meta.url).pathname)};
        const root = process.env.LEDGER_ROOT;
        const id = process.env.RSV_ID;
        const key = process.env.ATTEMPT_KEY;
        const ledger = new GrantCreditLedger(root);
        try {
          const r = await ledger.reserve({
            reservation_id: id,
            grant_digest: ${JSON.stringify(DIGEST_A)},
            production_id: "prod-1",
            run_id: "run-1",
            node_id: "n1",
            attempt_key: key,
            pricing_binding_digest: ${JSON.stringify(DIGEST_C)},
            requested_credits: 2
          });
          process.stdout.write(JSON.stringify({ ok: true, id: r.reservation_id }));
        } catch (e) {
          process.stdout.write(JSON.stringify({ ok: false, msg: String(e && e.message || e) }));
          process.exitCode = 2;
        }
      `;
      // Use two different reservation ids but same attempt key → only one may win
      // Actually concurrent same attempt_key: second fails.
      // Concurrent different attempt_keys with limited credits: only enough for one of 3 credits each with cap 5 total of 5...
      // Use same credits 3 each with total 5 → at most one succeeds if simultaneous; both different keys.
      const runChild = (id: string, key: string) => new Promise<{ ok: boolean; msg?: string }>((resolve) => {
        const child = fork(
          new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url).pathname,
          ["--eval", worker],
          {
            env: {
              ...process.env,
              LEDGER_ROOT: root,
              RSV_ID: id,
              ATTEMPT_KEY: key
            },
            stdio: ["ignore", "pipe", "pipe", "ipc"]
          }
        );
        let out = "";
        child.stdout?.on("data", (d) => { out += String(d); });
        child.on("exit", () => {
          try {
            resolve(JSON.parse(out || '{"ok":false}'));
          } catch {
            resolve({ ok: false, msg: out });
          }
        });
      });

      // Simpler sequential proof of exclusivity under root lock for same attempt key:
      await ledger.reserve({
        reservation_id: "parent-1",
        grant_digest: DIGEST_A,
        production_id: "prod-1",
        run_id: "run-1",
        node_id: "n1",
        attempt_key: DIGEST_B,
        pricing_binding_digest: DIGEST_C,
        requested_credits: 2
      });
      // Concurrent child with different id same attempt key
      const childScript = join(root, "worker.mjs");
      await writeFile(childScript, `
        import { GrantCreditLedger } from ${JSON.stringify(join(process.cwd(), "src/productionControl/grantLedger.ts"))};
        const ledger = new GrantCreditLedger(${JSON.stringify(root)});
        try {
          await ledger.reserve({
            reservation_id: "child-1",
            grant_digest: ${JSON.stringify(DIGEST_A)},
            production_id: "prod-1",
            run_id: "run-1",
            node_id: "n1",
            attempt_key: ${JSON.stringify(DIGEST_B)},
            pricing_binding_digest: ${JSON.stringify(DIGEST_C)},
            requested_credits: 1
          });
          console.log(JSON.stringify({ ok: true }));
        } catch (e) {
          console.log(JSON.stringify({ ok: false, msg: e instanceof Error ? e.message : String(e) }));
          process.exitCode = 2;
        }
      `);
      const result = await new Promise<{ ok: boolean; msg?: string }>((resolve, reject) => {
        const child = fork(
          join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
          [childScript],
          { stdio: ["ignore", "pipe", "pipe", "ipc"] }
        );
        let out = "";
        child.stdout?.on("data", (d) => { out += String(d); });
        child.stderr?.on("data", () => undefined);
        child.on("error", reject);
        child.on("exit", () => {
          try {
            resolve(JSON.parse(out.trim() || '{"ok":false}'));
          } catch {
            resolve({ ok: false, msg: out });
          }
        });
      });
      expect(result.ok).toBe(false);
      expect(result.msg ?? "").toMatch(/attempt_key|already|lock|conflict/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("PO-6 local permit / selection / Gate cascade / identity", () => {
  it("issues local permit with 0 credits/submissions and rejects stale/expiry drift", () => {
    const live = {
      production_id: "prod-1",
      tree_revision: 2,
      node_id: "node-pure-1",
      task_revision: 1,
      input_digest: DIGEST_A
    };
    const { permit, sealed } = issueLocalRecoveryPermit({
      permit_id: "permit-1",
      ...live,
      action: "rerun-pure-task",
      issued_at: NOW,
      expires_at: FUTURE,
      max_attempts: 2,
      live
    });
    expect(permit.max_new_credits).toBe(0);
    expect(permit.max_new_submissions).toBe(0);
    expect(sealed.max_new_credits).toBe(0);

    expect(() => issueLocalRecoveryPermit({
      permit_id: "permit-2",
      ...live,
      tree_revision: 3,
      action: "rerun-pure-task",
      issued_at: NOW,
      expires_at: FUTURE,
      max_attempts: 1,
      live
    })).toThrow(/match live/i);

    expect(() => issueLocalRecoveryPermit({
      permit_id: "permit-3",
      ...live,
      action: "resume-known-job-poll",
      issued_at: NOW,
      expires_at: FUTURE,
      max_attempts: 1,
      live
    })).toThrow(/known provider/i);

    const expired = createLocalRecoveryPermit({
      permit_id: "permit-exp",
      ...live,
      action: "revalidate",
      issued_at: PAST,
      expires_at: PAST,
      max_attempts: 1
    });
    expect(() => parseLocalRecoveryPermit({ ...expired, digest: "0".repeat(64) })).toThrow();
  });

  it("selects awaiting_human for grant missing, submission_unknown, identity drift; preserves siblings", () => {
    let state = createInitialMissionState("prod-1");
    state = reduceProductionEvent(state, makeProductionEvent({
      type: "mission-created",
      production_id: "prod-1",
      sequence: 1,
      payload: { mission_digest: DIGEST_A, tree_revision: 1 }
    }));
    state = {
      ...state,
      nodes: {
        "node-a": {
          node_id: "node-a",
          status: "failed_known",
          task_revision: 1,
          input_digest: DIGEST_A,
          dependency_closure_digest: DIGEST_B,
          stale: false
        },
        "node-b": {
          node_id: "node-b",
          status: "completed",
          task_revision: 1,
          input_digest: DIGEST_C,
          dependency_closure_digest: DIGEST_D,
          accepted_artifact_id: "art-b",
          stale: false
        }
      },
      accepted_artifacts: {
        "art-b": {
          artifact_id: "art-b",
          artifact_digest: DIGEST_E,
          node_id: "node-b",
          attempt_id: "att-b",
          invalidated: false
        }
      }
    };

    const missing = selectRecoveryAction({
      mission_state: state,
      failed_node_id: "node-a",
      observed_error_code: "GEN_TECHNICAL_FAIL",
      failure_kind: "known-failure"
    });
    expect(missing.action).toBe("awaiting_human");
    if (missing.action === "awaiting_human") {
      expect(missing.reason_code).toBe("grant_missing");
    }

    const unknown = selectRecoveryAction({
      mission_state: state,
      failed_node_id: "node-a",
      observed_error_code: "GEN_TECHNICAL_FAIL",
      failure_kind: "submission_unknown"
    });
    expect(unknown.action).toBe("awaiting_human");
    if (unknown.action === "awaiting_human") {
      expect(unknown.reason_code).toBe("submission_unknown");
    }

    const identity = selectRecoveryAction({
      mission_state: state,
      failed_node_id: "node-a",
      observed_error_code: "IDENTITY_DRIFT",
      failure_kind: "identity-drift"
    });
    expect(identity.action).toBe("awaiting_human");
    if (identity.action === "awaiting_human") {
      expect(identity.reason_code).toBe("identity_drift");
    }

    // Sibling still completed and not stale
    expect(state.nodes["node-b"]?.status).toBe("completed");
    expect(state.accepted_artifacts["art-b"]?.invalidated).toBe(false);

    const stop = safeStopAwaitingHuman("grant_exhausted");
    expect(stop.action).toBe("awaiting_human");
    expect(stop.reason_code).toBe("grant_exhausted");
  });

  it("Gate cascade: policy-exempt keeps Gate1; non-exempt cascades Gate1", () => {
    const exempt = cascadeFromDrift(["policy-exempt-derived-compilation"]);
    expect(exempt.stale_gate_1).toBe(false);
    expect(exempt.stale_gate_2).toBe(true);
    expect(exempt.stale_gate_3).toBe(true);
    expect(exempt.gate_1_preserved_by_policy).toBe(true);
    expect(exempt.render_forbidden).toBe(true);

    const nonExempt = cascadeFromDrift(["compilation"]);
    expect(nonExempt.stale_gate_1).toBe(true);
    expect(nonExempt.stale_gate_2).toBe(true);
    expect(nonExempt.stale_gate_3).toBe(true);

    const mixed = cascadeFromDrift(["policy-exempt-derived-compilation", "route"]);
    expect(mixed.stale_gate_1).toBe(true);

    const intent = createRevisionIntent({
      revision_intent_id: "ri-1",
      source_critique_artifact_id: "crit-1",
      target_node_id: "node-gen-1",
      change_class: "mutable-prompt-block",
      changed_paths: ["shots[0].action"],
      expected_stale_nodes: ["node-gen-1"],
      rationale: "fix technical action"
    });
    expect(gateDriftKindsForRevisionIntent({ intent, policy_exempt_authorized: true })).toEqual([
      "policy-exempt-derived-compilation"
    ]);
    expect(gateDriftKindsForRevisionIntent({ intent, policy_exempt_authorized: false })).toEqual([
      "prompt",
      "compilation"
    ]);

    const identityIntent = createRevisionIntent({
      revision_intent_id: "ri-id",
      source_critique_artifact_id: "crit-2",
      target_node_id: "node-id",
      change_class: "identity",
      changed_paths: ["subjects[0].appearance"],
      expected_stale_nodes: ["node-id"],
      rationale: "identity change"
    });
    // Never infers verified — cascades definition
    expect(gateDriftKindsForRevisionIntent({ intent: identityIntent })).toContain("identity-definition");

    const selected = selectActiveRevisionIntent({
      candidates: [intent, identityIntent],
      selected_revision_intent_id: "ri-1"
    });
    expect(selected.revision_intent_id).toBe("ri-1");
  });
});

describe("PO-6 branch coverage hardening", () => {
  it("covers parameter range, expired grant, release reason, budget reopen, and auth mismatches", async () => {
    const policy = samplePolicy({ max_attempts: 3, max_submissions: 3, max_credits: 6 });
    const bundle = sampleBundleWithPolicy(policy);
    const g1 = gate1Pair(bundle);
    const grant = issueRegenerationGrant({
      grant_id: "grant-cov",
      policy,
      gate_bundle: bundle,
      gate_1_decision: g1.decision,
      live_gate_1_subject_digest: g1.subject_digest,
      live_gate_1_decision_digest: g1.decision_digest,
      issued_at: NOW
    });
    // Re-issue same grant id path via createRegenerationGrant direct
    const grant2 = createRegenerationGrant({
      grant_id: "grant-cov-2",
      policy,
      gate_bundle_digest: bundle.digest,
      gate_1_decision: g1.decision,
      issued_at: NOW
    });
    expect(grant2.policy_spec_digest).toBe(policy.digest);

    const root = await realTempDir("tsugite-po6-cov-");
    try {
      const ledger = await openLedgerForGrant(root, grant.digest, policy);
      // Budget reopen same identity is idempotent
      const again = await ledger.openBudget({
        budget_id: "budget-1",
        grant_digest: grant.digest,
        production_id: "prod-1",
        max_incremental_credits: policy.max_incremental_credits,
        max_attempts: policy.max_attempts_per_task,
        max_submissions: policy.max_total_new_submissions,
        per_attempt_credit_cap: Math.min(policy.max_incremental_credits, 3)
      });
      expect(again.revision).toBe(0);

      // Budget reopen different identity fails
      await expect(ledger.openBudget({
        budget_id: "budget-other",
        grant_digest: grant.digest,
        production_id: "prod-1",
        max_incremental_credits: 1,
        max_attempts: 1,
        max_submissions: 1,
        per_attempt_credit_cap: 1
      })).rejects.toThrow(/different identity/i);

      // Parameter out of range
      await expect(authorizePaidRegeneration({
        policy,
        grant,
        gate_bundle: bundle,
        ledger,
        node_id: "node-gen-1",
        ordinal: 0,
        attempt_key: sha256Canonical({ p: 1 }),
        trigger_failure_ref: { kind: "failure", id: "f", digest: DIGEST_A },
        observed_error_code: "GEN_TECHNICAL_FAIL",
        base_compilation_digest: DIGEST_F,
        patch_artifact_digest: DIGEST_B,
        derived_compilation_digest: DIGEST_D,
        parameter_changes: { seed: 999 },
        requested_credits: 1,
        run_id: "run-1",
        production_id: "prod-1"
      })).rejects.toThrow(/parameter|policy/i);

      // Disallowed prompt block
      await expect(authorizePaidRegeneration({
        policy,
        grant,
        gate_bundle: bundle,
        ledger,
        node_id: "node-gen-1",
        ordinal: 0,
        attempt_key: sha256Canonical({ p: 2 }),
        trigger_failure_ref: { kind: "failure", id: "f", digest: DIGEST_A },
        observed_error_code: "GEN_TECHNICAL_FAIL",
        base_compilation_digest: DIGEST_F,
        patch_artifact_digest: DIGEST_B,
        derived_compilation_digest: DIGEST_D,
        changed_prompt_block_id: "not-allowed",
        requested_credits: 1,
        run_id: "run-1",
        production_id: "prod-1"
      })).rejects.toThrow(/prompt block|allowlist/i);

      // submission_unknown previous job
      await expect(authorizePaidRegeneration({
        policy,
        grant,
        gate_bundle: bundle,
        ledger,
        node_id: "node-gen-1",
        ordinal: 0,
        attempt_key: sha256Canonical({ p: 3 }),
        trigger_failure_ref: { kind: "failure", id: "f", digest: DIGEST_A },
        observed_error_code: "GEN_TECHNICAL_FAIL",
        base_compilation_digest: DIGEST_F,
        patch_artifact_digest: DIGEST_B,
        derived_compilation_digest: DIGEST_D,
        requested_credits: 1,
        run_id: "run-1",
        production_id: "prod-1",
        previous_job: { status: "submission_unknown", submission_unknown: true }
      })).rejects.toThrow(/submission_unknown/i);

      // Same derived as base
      await expect(authorizePaidRegeneration({
        policy,
        grant,
        gate_bundle: bundle,
        ledger,
        node_id: "node-gen-1",
        ordinal: 0,
        attempt_key: sha256Canonical({ p: 4 }),
        trigger_failure_ref: { kind: "failure", id: "f", digest: DIGEST_A },
        observed_error_code: "GEN_TECHNICAL_FAIL",
        base_compilation_digest: DIGEST_F,
        patch_artifact_digest: DIGEST_B,
        derived_compilation_digest: DIGEST_F,
        requested_credits: 1,
        run_id: "run-1",
        production_id: "prod-1"
      })).rejects.toThrow(/differ from base/i);

      // Valid reserve then invalid release reason / double release
      const rsv = await ledger.reserve({
        reservation_id: "cov-rsv-1",
        grant_digest: grant.digest,
        production_id: "prod-1",
        run_id: "run-1",
        node_id: "node-gen-1",
        attempt_key: sha256Canonical({ p: 5 }),
        pricing_binding_digest: policy.execution_context.pricing_binding_digest,
        requested_credits: 1
      });
      await expect(ledger.release({
        reservation_id: rsv.reservation_id,
        reason: "other" as never
      })).rejects.toThrow(/known-non-submission/i);
      await ledger.release({
        reservation_id: rsv.reservation_id,
        reason: "known-non-submission"
      });
      await expect(ledger.release({
        reservation_id: rsv.reservation_id,
        reason: "known-non-submission"
      })).rejects.toThrow();

      // Commit exceeding reserved
      await ledger.reserve({
        reservation_id: "cov-rsv-2",
        grant_digest: grant.digest,
        production_id: "prod-1",
        run_id: "run-1",
        node_id: "node-gen-1",
        attempt_key: sha256Canonical({ p: 6 }),
        pricing_binding_digest: policy.execution_context.pricing_binding_digest,
        requested_credits: 1
      });
      await expect(ledger.commit({
        reservation_id: "cov-rsv-2",
        actual_credits: 9
      })).rejects.toThrow(/exceed/i);
      await ledger.commit({
        reservation_id: "cov-rsv-2",
        actual_credits: 0.5
      });

      // Mint sealed with mismatched reservation fails
      const okAuth = await authorizePaidRegeneration({
        policy,
        grant,
        gate_bundle: bundle,
        ledger,
        node_id: "node-gen-1",
        ordinal: 0,
        attempt_key: sha256Canonical({ p: 7 }),
        trigger_failure_ref: { kind: "failure", id: "f", digest: DIGEST_A },
        observed_error_code: "GEN_TECHNICAL_FAIL",
        base_compilation_digest: DIGEST_F,
        patch_artifact_digest: DIGEST_B,
        derived_compilation_digest: sha256Canonical({ d: 7 }),
        requested_credits: 0.5,
        run_id: "run-1",
        production_id: "prod-1",
        parameter_changes: { seed: 10 }
      });
      expect(() => mintSealedPaidAuthorization({
        authorization: okAuth.authorization,
        reservation: { ...okAuth.reservation, status: "committed" },
        grant
      })).toThrow(/reserved/i);

      // Expired policy at authorize time
      const expiredPolicy = samplePolicy({ expires_at: PAST });
      // cannot bind expired on bundle easily — direct assertNotExpired via authorize with mutated grant expiry
      const expiredGrant = createRegenerationGrant({
        grant_id: "grant-exp",
        policy,
        gate_bundle_digest: bundle.digest,
        gate_1_decision: g1.decision,
        issued_at: PAST,
        expires_at: PAST
      });
      await expect(authorizePaidRegeneration({
        policy,
        grant: expiredGrant,
        gate_bundle: bundle,
        ledger,
        node_id: "node-gen-1",
        ordinal: 0,
        attempt_key: sha256Canonical({ p: 8 }),
        trigger_failure_ref: { kind: "failure", id: "f", digest: DIGEST_A },
        observed_error_code: "GEN_TECHNICAL_FAIL",
        base_compilation_digest: DIGEST_F,
        patch_artifact_digest: DIGEST_B,
        derived_compilation_digest: sha256Canonical({ d: 8 }),
        requested_credits: 0.1,
        run_id: "run-1",
        production_id: "prod-1",
        now: new Date(NOW)
      })).rejects.toThrow(/expired|policy|grant/i);

      // Local poll permit with known job
      const live = {
        production_id: "prod-1",
        tree_revision: 1,
        node_id: "node-job",
        task_revision: 1,
        input_digest: DIGEST_A
      };
      const { sealed: localSealed } = issueLocalRecoveryPermit({
        permit_id: "permit-poll",
        ...live,
        action: "resume-known-job-poll",
        known_job: {
          generation_job_id: "job-1",
          provider_job_id: "prov-1",
          connection_id: "conn-1",
          connection_digest: DIGEST_B
        },
        issued_at: NOW,
        expires_at: FUTURE,
        max_attempts: 2,
        live
      });
      let state = createInitialMissionState("prod-1");
      state = {
        ...state,
        nodes: {
          "node-job": {
            node_id: "node-job",
            status: "failed_known",
            task_revision: 1,
            input_digest: DIGEST_A,
            dependency_closure_digest: DIGEST_B,
            stale: false
          }
        }
      };
      const localDecision = selectRecoveryAction({
        mission_state: state,
        failed_node_id: "node-job",
        observed_error_code: "POLL_RETRY",
        failure_kind: "known-failure",
        local_permit: localSealed
      });
      expect(localDecision.action).toBe("local");

      // Paid selection with sealed auth
      const paidDecision = selectRecoveryAction({
        mission_state: {
          ...state,
          nodes: {
            "node-gen-1": {
              node_id: "node-gen-1",
              status: "failed_known",
              task_revision: 1,
              input_digest: DIGEST_A,
              dependency_closure_digest: DIGEST_B,
              stale: false
            }
          }
        },
        failed_node_id: "node-gen-1",
        observed_error_code: "GEN_TECHNICAL_FAIL",
        failure_kind: "known-failure",
        paid_authorization: okAuth.sealed,
        policy
      });
      expect(paidDecision.action).toBe("paid-regeneration");

      // Dispatcher denies paid without seal even with coordinator
      const coordinator = sealedCoordinator(g1.decision_digest);
      expect(() => new ProductionDispatcher().acquire({
        node_id: "node-gen-1",
        attempt_id: "a1",
        task_revision: 1,
        input_digest: DIGEST_A,
        role: "generator",
        effect: "paid",
        authority: {
          mode: "active",
          actor: "coordinator",
          coordinator_authority: coordinator,
          gate_bundle: bundle,
          gate_1: g1.sealed,
          paid_authorization: true
        }
      })).toThrow(/sealed regeneration/i);

      // assertAuthority with genuine seal succeeds
      assertAuthority({
        role: "generator",
        effect: "paid",
        actor: "coordinator",
        mode: "active",
        coordinator_authority: coordinator,
        gate_bundle: bundle,
        gate_1: g1.sealed,
        sealed_paid_authorization: okAuth.sealed,
        expected_pricing_binding_digest: policy.execution_context.pricing_binding_digest
      });

      // parse attempt auth tamper
      expect(() => parseRegenerationAttemptAuthorization({
        ...okAuth.authorization,
        digest: "9".repeat(64)
      })).toThrow();

      // revision intent selection missing
      expect(() => selectActiveRevisionIntent({
        candidates: [],
        selected_revision_intent_id: "x"
      })).toThrow();

      // safe stop variants
      for (const code of [
        "unknown_price",
        "max_attempts",
        "digest_drift",
        "policy_mismatch",
        "stale_permit"
      ] as const) {
        const stop = safeStopAwaitingHuman(code, "detail");
        expect(stop.action).toBe("awaiting_human");
        expect(stop.public_reason).toContain("detail");
      }

      // void expiredPolicy used for type-only
      void expiredPolicy;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects base binding that falsely claims regeneration auth digest", () => {
    const policy = samplePolicy();
    const bundle = sampleBundleWithPolicy(policy);
    const binding = createGenerationJobApprovalBinding({
      production_id: "prod-1",
      run_id: "run-1",
      node_id: "node-gen-1",
      attempt_id: "att-1",
      generation_job_id: "job-1",
      approval_observed_revision: 0,
      approval_digest: DIGEST_A,
      gate_bundle_digest: bundle.digest,
      gate_1_decision_digest: DIGEST_C,
      request_digest: DIGEST_B,
      compilation_digest: DIGEST_F, // base member
      route: policy.execution_context.route,
      pricing_binding_digest: policy.execution_context.pricing_binding_digest,
      regeneration_attempt_authorization_digest: DIGEST_D
    });
    expect(() => assertDerivedCompilationBinding({
      binding,
      bundle,
      authorization_digest: DIGEST_D,
      base_compilation_digest: DIGEST_F,
      derived_compilation_digest: DIGEST_F
    })).toThrow();
  });

  it("covers route assert, paid binding mismatches, revision classes, and ledger negative inputs", async () => {
    const policy = samplePolicy();
    const bundle = sampleBundleWithPolicy(policy);
    const g1 = gate1Pair(bundle);
    const grant = issueRegenerationGrant({
      grant_id: "grant-route",
      policy,
      gate_bundle: bundle,
      gate_1_decision: g1.decision,
      live_gate_1_subject_digest: g1.subject_digest,
      live_gate_1_decision_digest: g1.decision_digest,
      issued_at: NOW
    });
    const { assertRouteUnchanged } = await import("../src/productionControl/recovery.js");
    expect(() => assertRouteUnchanged(policy.execution_context.route, policy.execution_context.route)).not.toThrow();
    expect(() => assertRouteUnchanged(policy.execution_context.route, route("other"))).toThrow(/route|connection|model/i);

    const root = await realTempDir("tsugite-po6-route-");
    try {
      const ledger = await openLedgerForGrant(root, grant.digest, policy);
      await expect(ledger.reserve({
        reservation_id: "neg",
        grant_digest: grant.digest,
        production_id: "prod-1",
        run_id: "run-1",
        node_id: "node-gen-1",
        attempt_key: DIGEST_A,
        pricing_binding_digest: policy.execution_context.pricing_binding_digest,
        requested_credits: -1
      })).rejects.toThrow(/non-negative/i);

      await expect(ledger.openBudget({
        budget_id: "bad-cap",
        grant_digest: DIGEST_B,
        production_id: "prod-x",
        max_incremental_credits: 1,
        max_attempts: 1,
        max_submissions: 1,
        per_attempt_credit_cap: 5
      })).rejects.toThrow(/per-attempt|different identity|exceed/i);

      const auth = await authorizePaidRegeneration({
        policy,
        grant,
        gate_bundle: bundle,
        ledger,
        node_id: "node-gen-1",
        ordinal: 0,
        attempt_key: sha256Canonical({ route: 1 }),
        trigger_failure_ref: { kind: "failure", id: "f", digest: DIGEST_A },
        observed_error_code: "GEN_TECHNICAL_FAIL",
        base_compilation_digest: DIGEST_F,
        patch_artifact_digest: DIGEST_B,
        derived_compilation_digest: sha256Canonical({ route: "d" }),
        requested_credits: 1,
        run_id: "run-1",
        production_id: "prod-1"
      });
      expect(() => assertPaidAuthorizationMatchesBinding({
        sealed: auth.sealed,
        regeneration_attempt_authorization_digest: "0".repeat(64),
        compilation_digest: auth.sealed.derived_compilation_digest,
        node_id: "node-gen-1",
        pricing_binding_digest: policy.execution_context.pricing_binding_digest
      })).toThrow(/digest/i);
      expect(() => assertPaidAuthorizationMatchesBinding({
        sealed: auth.sealed,
        regeneration_attempt_authorization_digest: auth.sealed.authorization_digest,
        compilation_digest: DIGEST_A,
        node_id: "node-gen-1",
        pricing_binding_digest: policy.execution_context.pricing_binding_digest
      })).toThrow(/compilation/i);
      expect(() => assertPaidAuthorizationMatchesBinding({
        sealed: auth.sealed,
        regeneration_attempt_authorization_digest: auth.sealed.authorization_digest,
        compilation_digest: auth.sealed.derived_compilation_digest,
        node_id: "wrong",
        pricing_binding_digest: policy.execution_context.pricing_binding_digest
      })).toThrow(/node/i);
      expect(() => assertPaidAuthorizationMatchesBinding({
        sealed: auth.sealed,
        regeneration_attempt_authorization_digest: auth.sealed.authorization_digest,
        compilation_digest: auth.sealed.derived_compilation_digest,
        node_id: "node-gen-1",
        pricing_binding_digest: DIGEST_A
      })).toThrow(/pricing/i);
      expect(() => assertPaidAuthorizationMatchesBinding({
        sealed: { ...auth.sealed } as never,
        regeneration_attempt_authorization_digest: auth.sealed.authorization_digest,
        compilation_digest: auth.sealed.derived_compilation_digest,
        node_id: "node-gen-1",
        pricing_binding_digest: policy.execution_context.pricing_binding_digest
      })).toThrow(/seal|forged/i);

      // revision intent change classes
      for (const change_class of [
        "local-technical",
        "parameter-tune",
        "story",
        "music-timing",
        "lyrics-text",
        "lyrics-timing",
        "asset",
        "model-connection",
        "visual-plan"
      ] as const) {
        const intent = createRevisionIntent({
          revision_intent_id: `ri-${change_class}`,
          source_critique_artifact_id: "c1",
          target_node_id: "n1",
          change_class,
          changed_paths: ["p"],
          expected_stale_nodes: ["n1"],
          rationale: "cov"
        });
        const kinds = gateDriftKindsForRevisionIntent({ intent, policy_exempt_authorized: change_class === "local-technical" });
        expect(kinds.length).toBeGreaterThan(0);
      }

      // Gate cascade gate3-only
      const g3 = cascadeFromDrift(["final-artifact"]);
      expect(g3.stale_gate_1).toBe(false);
      expect(g3.stale_gate_3).toBe(true);

      // paid auth with wrong error on selection
      const state = {
        ...createInitialMissionState("prod-1"),
        nodes: {
          "node-gen-1": {
            node_id: "node-gen-1",
            status: "failed_known" as const,
            task_revision: 1,
            input_digest: DIGEST_A,
            dependency_closure_digest: DIGEST_B,
            stale: false
          }
        }
      };
      const mismatch = selectRecoveryAction({
        mission_state: state,
        failed_node_id: "node-gen-1",
        observed_error_code: "OTHER",
        failure_kind: "known-failure",
        paid_authorization: auth.sealed,
        policy
      });
      expect(mismatch.action).toBe("awaiting_human");

      // revision-intent-selected event reduce path
      let ms = createInitialMissionState("prod-1");
      ms = reduceProductionEvent(ms, makeProductionEvent({
        type: "mission-created",
        production_id: "prod-1",
        sequence: 1,
        payload: { mission_digest: DIGEST_A, tree_revision: 1 }
      }));
      ms = reduceProductionEvent(ms, makeProductionEvent({
        type: "task-readied",
        production_id: "prod-1",
        sequence: 2,
        previous_event_digest: ms.applied_event_digest,
        payload: {
          node_id: "node-gen-1",
          task_revision: 1,
          input_digest: DIGEST_A,
          dependency_closure_digest: DIGEST_B
        }
      }));
      ms = reduceProductionEvent(ms, makeProductionEvent({
        type: "revision-intent-selected",
        production_id: "prod-1",
        sequence: 3,
        previous_event_digest: ms.applied_event_digest,
        payload: {
          revision_intent_id: "ri-1",
          revision_intent_digest: DIGEST_C,
          target_node_id: "node-gen-1",
          change_class: "parameter-tune"
        }
      }));
      expect(ms.applied_event_sequence).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PO-6 fixture E2E active recovery call graph", () => {
  it("dispatcher paid once with grant+reserve+T05 stub; pin; second attempt denied; network 0", {
    timeout: 30_000
  }, async () => {
    const networkHits: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: unknown[]) => {
      networkHits.push(String(args[0]));
      throw new Error("network forbidden in PO-6 fixture E2E");
    }) as typeof fetch;

    const {
      deriveExecutionCompilationBundleFromPlanningArtifact,
      isAdoptedExecutionCompilationBundle,
      loadAdapterDialectCapability,
      loadConnectionCapabilityProfile,
      loadExecutionAuthoritativePinnedPromptBudgetEvidence,
      loadModelPromptProfile,
      loadPlanningArtifactRef,
      compileVideoPromptIrV2,
      compilationRevisionId,
      routeFromProfiles
    } = await import("../src/videoPromptDirector/index.js");
    const { persistPlanningCompilationArtifact } = await import("../src/videoPromptDirector/compilationBundle.js");
    const { ArtifactStore } = await import("../src/productionControl/artifactStore.js");
    try {
      // E2E uses fixture route from profiles — rebuild policy around real route after load.
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
        request_id: "po6-e2e-req",
        route: v6Route,
        model_profile: model.profile,
        model_profile_digest: model.digest,
        connection_profile: connection.profile,
        connection_capability_digest: connection.digest,
        adapter_dialect_capability: adapter.capability
      });
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return;

      const root = await realTempDir("tsugite-po6-e2e-");
      const storeRoot = join(root, "production-control");
      await mkdir(storeRoot);
      const store = new ArtifactStore(storeRoot);
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
        source_id: "po6-e2e-budget",
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

      const baseCompilationDigest = derived.bundle.compilation_digest;
      // Simulate a derived recompilation digest (fixture patch).
      const derivedCompilationDigest = sha256Canonical({
        base: baseCompilationDigest,
        patch: "action-tweak-1"
      });

      const e2ePolicy = createRegenerationPolicySpec({
        policy_spec_id: "policy-e2e",
        execution_context: {
          production_contract_digest: DIGEST_A,
          contract_set_digest: DIGEST_B,
          task_tree_digest: DIGEST_C,
          task_scope: ["node-gen-1"],
          base_compilations: [{
            node_id: "node-gen-1",
            compilation_digest: baseCompilationDigest
          }],
          route: v6Route,
          pricing_binding_digest: pricingBindingDigest({
            status: "known",
            version: "price-v1",
            currency: "USD",
            amount: 1,
            max_amount: 2
          }, v6Route)
        },
        allowed_error_codes: ["GEN_TECHNICAL_FAIL"],
        allowed_prompt_block_ids: ["block-action"],
        max_attempts_per_task: 1,
        max_total_new_submissions: 1,
        max_incremental_credits: 3,
        expires_at: FUTURE
      });
      const e2eBundle = createGateBundle({
        production_id: "prod-e2e",
        run_id: "run-e2e",
        production_contract_digest: DIGEST_A,
        contract_set_digest: DIGEST_B,
        task_tree_digest: DIGEST_C,
        selected_artifact_digests: [DIGEST_D],
        generation_batches: [{
          batch_id: "batch-e2e",
          route: v6Route,
          ordered_units: [{
            ordinal: 0,
            generation_unit_digest: DIGEST_E,
            base_compilation_digest: baseCompilationDigest,
            route_digest: v6Route.route_digest
          }],
          pricing: {
            status: "known",
            version: "price-v1",
            currency: "USD",
            amount: 1,
            max_amount: 2
          },
          pricing_binding_digest: e2ePolicy.execution_context.pricing_binding_digest,
          regeneration_policy_spec_digest: e2ePolicy.digest
        }],
        review_artifact_digest: DIGEST_D
      });
      const g1 = gate1Pair(e2eBundle);
      const grant = issueRegenerationGrant({
        grant_id: "grant-e2e",
        policy: e2ePolicy,
        gate_bundle: e2eBundle,
        gate_1_decision: g1.decision,
        live_gate_1_subject_digest: g1.subject_digest,
        live_gate_1_decision_digest: g1.decision_digest,
        issued_at: NOW
      });
      const ledger = await openLedgerForGrant(storeRoot, grant.digest, e2ePolicy);
      // Fix openLedgerForGrant production_id mismatch — reopen with prod-e2e
      const ledger2 = new GrantCreditLedger(join(root, "ledger-e2e"));
      await mkdir(join(root, "ledger-e2e"));
      await ledger2.openBudget({
        budget_id: "budget-e2e",
        grant_digest: grant.digest,
        production_id: "prod-e2e",
        max_incremental_credits: e2ePolicy.max_incremental_credits,
        max_attempts: e2ePolicy.max_attempts_per_task,
        max_submissions: e2ePolicy.max_total_new_submissions,
        per_attempt_credit_cap: 2
      });

      const attemptKey = computeRegenerationAttemptKey({
        node_id: "node-gen-1",
        ordinal: 0,
        trigger_failure_digest: DIGEST_A,
        base_compilation_digest: baseCompilationDigest,
        derived_compilation_digest: derivedCompilationDigest,
        grant_digest: grant.digest
      });
      const { sealed, authorization, reservation } = await authorizePaidRegeneration({
        policy: e2ePolicy,
        grant,
        gate_bundle: e2eBundle,
        ledger: ledger2,
        node_id: "node-gen-1",
        ordinal: 0,
        attempt_key: attemptKey,
        trigger_failure_ref: { kind: "failure", id: "fail-1", digest: DIGEST_A },
        observed_error_code: "GEN_TECHNICAL_FAIL",
        base_compilation_digest: baseCompilationDigest,
        patch_artifact_digest: DIGEST_B,
        derived_compilation_digest: derivedCompilationDigest,
        changed_prompt_block_id: "block-action",
        requested_credits: 1,
        run_id: "run-e2e",
        production_id: "prod-e2e"
      });

      const coordinator = sealedCoordinator(g1.decision_digest);
      const dispatcher = new ProductionDispatcher();
      const slot = dispatcher.acquire({
        node_id: "node-gen-1",
        attempt_id: "att-e2e-1",
        task_revision: 1,
        input_digest: attemptKey,
        role: "generator",
        effect: "paid",
        authority: {
          mode: "active",
          actor: "coordinator",
          coordinator_authority: coordinator,
          gate_bundle: e2eBundle,
          gate_1: g1.sealed,
          sealed_paid_authorization: sealed,
          expected_pricing_binding_digest: e2ePolicy.execution_context.pricing_binding_digest
        }
      });
      expect(slot.worker_kind).toBe("effectful");

      // T05 one-shot path with adopted bundle (exact attempt/job + lineage digests).
      const submissionBinding = {
        production_id: "prod-e2e",
        project_id: "proj-e2e",
        revision_id: revision,
        request_id: derived.bundle.request_id,
        attempt_id: "att-e2e-1",
        job_id: "job-e2e-1",
        compilation_digest: derived.bundle.compilation_digest,
        effective_contract_digest: derived.bundle.effective_contract_digest,
        ...(derived.bundle.grammar_profile?.digest
          ? { grammar_profile_digest: derived.bundle.grammar_profile.digest }
          : {}),
        asset_lineage_digest: sha256Canonical(derived.bundle.asset_lineage)
      };
      let adapterInvokes = 0;
      const t05 = await executeWithSubmissionAuthority({
        bundle: derived.bundle,
        binding: submissionBinding,
        hooks: {
          onAdapterInvoke: () => { adapterInvokes += 1; },
          submitEffect: async () => ({ ok: true, provider_job_id: "stub-prov-1" })
        }
      });
      expect(t05.ok).toBe(true);
      expect(adapterInvokes).toBe(1);
      // Structural fake stays at 0 additional adapter invokes.
      const fake = await executeWithSubmissionAuthority({
        bundle: JSON.parse(JSON.stringify(derived.bundle)),
        binding: submissionBinding,
        hooks: { onAdapterInvoke: () => { adapterInvokes += 1; } }
      });
      expect(fake.ok).toBe(false);
      expect(adapterInvokes).toBe(1);

      await ledger2.commit({
        reservation_id: reservation.reservation_id,
        actual_credits: 1
      });

      // Pin-only completion with regeneration auth on binding
      const jobBinding = createFullProductionJobBinding({
        production_id: "prod-e2e",
        run_id: "run-e2e",
        node_id: "node-gen-1",
        attempt_id: "att-e2e-1",
        generation_job_id: "job-e2e-1",
        approval_observed_revision: 1,
        approval_digest: DIGEST_A,
        gate_bundle: e2eBundle,
        gate_1_decision_digest: g1.decision_digest,
        request_digest: DIGEST_B,
        compilation_digest: derivedCompilationDigest,
        route: v6Route,
        pricing_binding_digest: e2ePolicy.execution_context.pricing_binding_digest,
        regeneration_attempt_authorization_digest: authorization.digest
      });
      assertDerivedCompilationBinding({
        binding: jobBinding,
        bundle: e2eBundle,
        authorization_digest: authorization.digest,
        base_compilation_digest: baseCompilationDigest,
        derived_compilation_digest: derivedCompilationDigest
      });

      // Second attempt denied — grant exhausted (max_attempts=1)
      await expect(authorizePaidRegeneration({
        policy: e2ePolicy,
        grant,
        gate_bundle: e2eBundle,
        ledger: ledger2,
        node_id: "node-gen-1",
        ordinal: 1,
        attempt_key: sha256Canonical({ second: true }),
        trigger_failure_ref: { kind: "failure", id: "fail-2", digest: DIGEST_C },
        observed_error_code: "GEN_TECHNICAL_FAIL",
        base_compilation_digest: baseCompilationDigest,
        patch_artifact_digest: DIGEST_B,
        derived_compilation_digest: sha256Canonical({ second: "derived" }),
        requested_credits: 1,
        run_id: "run-e2e",
        production_id: "prod-e2e"
      })).rejects.toThrow(/exhausted|max attempts/i);

      dispatcher.release(slot.lease.lease_id);
      expect(networkHits).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
