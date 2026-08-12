/**
 * Recovery Controller (PO-6) — local permits and opt-in paid regeneration.
 * Paid path requires policy + grant + one-shot attempt authorization + ledger reserve.
 * No self-issuance, structural fake, actor string, status, Gate, locked identity, or
 * stale permit may authorize. submission_unknown never auto-retries.
 */
import { randomUUID } from "node:crypto";
import { sha256Canonical } from "./canonical.js";
import { pcError } from "./errors.js";
import type { GateBundle } from "./gateBundle.js";
import { assertGateBundleExecutable, gateBundleHasUnknownPrice } from "./gateBundle.js";
import { gateDecisionDigest } from "./gateSubjects.js";
import {
  GrantCreditLedger,
  type DirectoryIdentity,
  type LedgerReservation
} from "./grantLedger.js";
import { DurableRegenerationStore } from "./grantStore.js";
import type { RouteIdentity } from "./programBinding.js";
import {
  assertNotExpired,
  createLocalRecoveryPermit,
  createRegenerationAttemptAuthorization,
  createRegenerationGrant,
  createRegenerationPolicySpec,
  executionContextDigest,
  parseLocalRecoveryPermit,
  parseRegenerationAttemptAuthorization,
  parseRegenerationGrant,
  parseRegenerationPolicySpec,
  type LocalRecoveryAction,
  type LocalRecoveryPermit,
  type RegenerationAttemptAuthorization,
  type RegenerationGrant,
  type RegenerationPolicySpec
} from "./recoveryContracts.js";
import {
  humanDecisionRefSchema,
  type DigestRef,
  type HumanDecisionRef,
  type MissionState,
  type TaskTreeSpec
} from "./schema.js";
import {
  gateDriftKindsForRevisionIntent,
  isPolicyEligibleRevisionIntent,
  parseRevisionIntent,
  type RevisionIntent
} from "./revisionIntent.js";
import type { GateDriftKind } from "./gateSubjects.js";

/** Opaque sealed paid authorization — only authorizePaidRegeneration / rehydrate may mint. */
export type SealedPaidAuthorization = {
  readonly kind: "pc-sealed-paid-authorization";
  readonly authorization_digest: string;
  readonly grant_digest: string;
  readonly reservation_id: string;
  readonly reservation_digest: string;
  readonly node_id: string;
  readonly attempt_key: string;
  readonly derived_compilation_digest: string;
  readonly base_compilation_digest: string;
  readonly pricing_binding_digest: string;
  readonly observed_error_code: string;
  readonly reserved_credits: number;
  readonly ledger_root_identity: DirectoryIdentity;
  readonly policy_digest: string;
  readonly ordinal: number;
};

/** Opaque sealed local recovery permit. */
export type SealedLocalRecoveryPermit = {
  readonly kind: "pc-sealed-local-recovery-permit";
  readonly permit_digest: string;
  readonly production_id: string;
  readonly node_id: string;
  readonly action: LocalRecoveryAction;
  readonly max_new_submissions: 0;
  readonly max_new_credits: 0;
};

const sealedPaidAuthorizations = new WeakSet<object>();
const sealedLocalPermits = new WeakSet<object>();

function isObject(value: unknown): value is object {
  return Boolean(value) && typeof value === "object";
}

export function isSealedPaidAuthorization(value: unknown): value is SealedPaidAuthorization {
  return isObject(value) && sealedPaidAuthorizations.has(value);
}

export function isSealedLocalRecoveryPermit(value: unknown): value is SealedLocalRecoveryPermit {
  return isObject(value) && sealedLocalPermits.has(value);
}

export type RecoveryStopReason =
  | "grant_missing"
  | "grant_exhausted"
  | "grant_expired"
  | "policy_mismatch"
  | "unknown_price"
  | "unknown_error"
  | "identity_drift"
  | "submission_unknown"
  | "max_attempts"
  | "digest_drift"
  | "disallowed_error"
  | "disallowed_scope"
  | "stale_permit"
  | "awaiting_human";

export type RecoveryDecision =
  | {
      action: "local";
      sealed: SealedLocalRecoveryPermit;
    }
  | {
      action: "paid-regeneration";
      sealed: SealedPaidAuthorization;
    }
  | {
      action: "awaiting_human";
      reason_code: RecoveryStopReason;
      public_reason: string;
    };

export function createPolicySpec(input: Parameters<typeof createRegenerationPolicySpec>[0]): RegenerationPolicySpec {
  return createRegenerationPolicySpec(input);
}

/**
 * Issue a grant only from a verified policy + GateBundle + exact Gate1 HumanDecisionRef.
 * Actor strings alone never issue grants. Gate status is not authority.
 */
export function issueRegenerationGrant(input: {
  grant_id: string;
  policy: RegenerationPolicySpec;
  gate_bundle: GateBundle;
  gate_1_decision: HumanDecisionRef;
  /** Live recomputed Gate1 subject digest (must match decision.subject_digest). */
  live_gate_1_subject_digest: string;
  /** Live recomputed Gate1 decision digest. */
  live_gate_1_decision_digest: string;
  issued_at: string;
  now?: Date;
}): RegenerationGrant {
  const policy = parseRegenerationPolicySpec(input.policy);
  const bundle = input.gate_bundle;
  assertGateBundleExecutable(bundle);
  if (gateBundleHasUnknownPrice(bundle)) {
    throw pcError("PC_POLICY_MISMATCH", "unknown price cannot issue a regeneration grant");
  }
  const decision = humanDecisionRefSchema.parse(input.gate_1_decision);
  if (decision.decision !== "approved") {
    throw pcError("PC_GRANT_INVALID", "grant requires an approved Gate 1 decision");
  }
  if (decision.subject_digest !== input.live_gate_1_subject_digest) {
    throw pcError("PC_GRANT_INVALID", "grant Gate1 decision subject does not match live subject");
  }
  const decisionDigest = gateDecisionDigest(decision);
  if (decisionDigest !== input.live_gate_1_decision_digest) {
    throw pcError("PC_GRANT_INVALID", "grant Gate1 decision digest does not match live decision");
  }
  // Policy must be bound on at least one batch of the approved GateBundle.
  const bound = bundle.generation_batches.some(
    (batch) => batch.regeneration_policy_spec_digest === policy.digest
  );
  if (!bound) {
    throw pcError(
      "PC_POLICY_MISMATCH",
      "policy digest is not bound on the approved GateBundle"
    );
  }
  // Execution context digests must match live bundle bindings.
  if (policy.execution_context.task_tree_digest !== bundle.task_tree_digest) {
    throw pcError("PC_POLICY_MISMATCH", "policy task_tree_digest does not match GateBundle");
  }
  if (policy.execution_context.production_contract_digest !== bundle.production_contract_digest) {
    throw pcError("PC_POLICY_MISMATCH", "policy production_contract_digest does not match GateBundle");
  }
  if (policy.execution_context.contract_set_digest !== bundle.contract_set_digest) {
    throw pcError("PC_POLICY_MISMATCH", "policy contract_set_digest does not match GateBundle");
  }
  const routeOk = bundle.generation_batches.some(
    (batch) =>
      batch.route.route_digest === policy.execution_context.route.route_digest
      && batch.pricing_binding_digest === policy.execution_context.pricing_binding_digest
  );
  if (!routeOk) {
    throw pcError("PC_POLICY_MISMATCH", "policy route/pricing is not a member of GateBundle");
  }
  // Base compilations in policy must appear in the bundle.
  for (const base of policy.execution_context.base_compilations) {
    const found = bundle.generation_batches.some((batch) =>
      batch.ordered_units.some((unit) => unit.base_compilation_digest === base.compilation_digest)
    );
    if (!found) {
      throw pcError("PC_POLICY_MISMATCH", "policy base compilation is not in GateBundle");
    }
  }
  const now = input.now ?? new Date();
  assertNotExpired(policy.expires_at, now, "PC_POLICY_MISMATCH");
  const grant = createRegenerationGrant({
    grant_id: input.grant_id,
    policy,
    gate_bundle_digest: bundle.digest,
    gate_1_decision: decision,
    issued_at: input.issued_at,
    expires_at: policy.expires_at
  });
  // Grant is not self-issued: requires external Gate1 decision body + live digests.
  return grant;
}

/**
 * Issue grant and persist create-only under DurableRegenerationStore with ledger root binding.
 * One grant digest → one ledger root identity; cross-root reopen rejects.
 */
export async function issueAndPersistRegenerationGrant(input: {
  grant_id: string;
  policy: RegenerationPolicySpec;
  gate_bundle: GateBundle;
  gate_1_decision: HumanDecisionRef;
  live_gate_1_subject_digest: string;
  live_gate_1_decision_digest: string;
  issued_at: string;
  production_id: string;
  store: DurableRegenerationStore;
  ledger: GrantCreditLedger;
  now?: Date;
}): Promise<RegenerationGrant> {
  const grant = issueRegenerationGrant({
    grant_id: input.grant_id,
    policy: input.policy,
    gate_bundle: input.gate_bundle,
    gate_1_decision: input.gate_1_decision,
    live_gate_1_subject_digest: input.live_gate_1_subject_digest,
    live_gate_1_decision_digest: input.live_gate_1_decision_digest,
    issued_at: input.issued_at,
    now: input.now
  });
  const identity = await input.ledger.captureRootIdentity();
  await input.store.writeGrantCreateOnly({
    grant,
    policy: parseRegenerationPolicySpec(input.policy),
    production_id: input.production_id,
    ledger_root_identity: identity
  });
  return grant;
}

/**
 * Coordinator issues a one-shot local permit bound to current production/tree/task/input.
 * Never authorizes new submissions or credits. Stale context rejects reuse.
 */
export function issueLocalRecoveryPermit(input: {
  permit_id: string;
  production_id: string;
  tree_revision: number;
  node_id: string;
  task_revision: number;
  input_digest: string;
  action: LocalRecoveryAction;
  known_job?: LocalRecoveryPermit["known_job"];
  issued_at: string;
  expires_at: string;
  max_attempts: number;
  /** Live context that must match the permit fields exactly. */
  live: {
    production_id: string;
    tree_revision: number;
    node_id: string;
    task_revision: number;
    input_digest: string;
  };
  now?: Date;
}): { permit: LocalRecoveryPermit; sealed: SealedLocalRecoveryPermit } {
  const live = input.live;
  if (
    live.production_id !== input.production_id
    || live.tree_revision !== input.tree_revision
    || live.node_id !== input.node_id
    || live.task_revision !== input.task_revision
    || live.input_digest !== input.input_digest
  ) {
    throw pcError("PC_PERMIT_INVALID", "local permit context does not match live production state");
  }
  if (input.action === "resume-known-job-poll" || input.action === "retry-verified-download") {
    if (!input.known_job?.provider_job_id) {
      throw pcError("PC_PERMIT_INVALID", "poll/download requires known provider job id");
    }
  }
  const permit = createLocalRecoveryPermit({
    permit_id: input.permit_id,
    production_id: input.production_id,
    tree_revision: input.tree_revision,
    node_id: input.node_id,
    task_revision: input.task_revision,
    input_digest: input.input_digest,
    action: input.action,
    known_job: input.known_job,
    issued_at: input.issued_at,
    expires_at: input.expires_at,
    max_attempts: input.max_attempts
  });
  const now = input.now ?? new Date();
  assertNotExpired(permit.expires_at, now, "PC_PERMIT_INVALID");
  const sealed = mintSealedLocalRecoveryPermit(permit, live, now);
  return { permit, sealed };
}

export function mintSealedLocalRecoveryPermit(
  permitInput: LocalRecoveryPermit,
  live: {
    production_id: string;
    tree_revision: number;
    node_id: string;
    task_revision: number;
    input_digest: string;
  },
  now: Date = new Date()
): SealedLocalRecoveryPermit {
  const permit = parseLocalRecoveryPermit(permitInput);
  assertNotExpired(permit.expires_at, now, "PC_PERMIT_INVALID");
  if (
    permit.production_id !== live.production_id
    || permit.tree_revision !== live.tree_revision
    || permit.node_id !== live.node_id
    || permit.task_revision !== live.task_revision
    || permit.input_digest !== live.input_digest
  ) {
    throw pcError("PC_PERMIT_INVALID", "permit is stale relative to live context");
  }
  if (permit.max_new_submissions !== 0 || permit.max_new_credits !== 0) {
    throw pcError("PC_PERMIT_INVALID", "local permit cannot authorize submissions or credits");
  }
  const sealed = Object.freeze({
    kind: "pc-sealed-local-recovery-permit" as const,
    permit_digest: permit.digest,
    production_id: permit.production_id,
    node_id: permit.node_id,
    action: permit.action,
    max_new_submissions: 0 as const,
    max_new_credits: 0 as const
  });
  sealedLocalPermits.add(sealed);
  return sealed;
}

export type AuthorizePaidRegenerationInput = {
  policy: RegenerationPolicySpec;
  grant: RegenerationGrant;
  gate_bundle: GateBundle;
  ledger: GrantCreditLedger;
  node_id: string;
  ordinal: number;
  attempt_key: string;
  trigger_failure_ref: DigestRef;
  observed_error_code: string;
  base_compilation_digest: string;
  patch_artifact_digest: string;
  derived_compilation_digest: string;
  changed_prompt_block_id?: string;
  parameter_changes?: Record<string, unknown>;
  requested_credits: number;
  run_id: string;
  production_id: string;
  /** Optional revision intent; must be policy-eligible when present. */
  revision_intent?: RevisionIntent;
  reservation_id?: string;
  now?: Date;
  /** Previous job status for no-resubmit checks. */
  previous_job?: {
    status: string;
    submission_unknown?: boolean;
    provider_job_id?: string;
  };
  /**
   * Durable create-only store. When provided, grant/auth are re-read/written
   * under durable identity; resume must use rehydrateSealedPaidAuthorization.
   */
  store?: DurableRegenerationStore;
};

/**
 * Full paid regeneration authorization: re-read durable grant/auth/reservation/budget
 * under live ledger, reserve, create durable attempt auth, mint one-shot opaque seal.
 * mintSealedPaidAuthorization is intentionally not a public caller API.
 */
export async function authorizePaidRegeneration(
  input: AuthorizePaidRegenerationInput
): Promise<{
  authorization: RegenerationAttemptAuthorization;
  reservation: LedgerReservation;
  sealed: SealedPaidAuthorization;
}> {
  const policy = parseRegenerationPolicySpec(input.policy);
  let grant = parseRegenerationGrant(input.grant);
  const bundle = input.gate_bundle;
  const now = input.now ?? new Date();

  if (gateBundleHasUnknownPrice(bundle)) {
    throw pcError("PC_RESERVATION_INVALID", "unknown price blocks reservation before provider");
  }
  assertGateBundleExecutable(bundle);

  assertNotExpired(policy.expires_at, now, "PC_POLICY_MISMATCH");
  assertNotExpired(grant.expires_at, now, "PC_GRANT_EXPIRED");

  if (grant.policy_spec_digest !== policy.digest) {
    throw pcError("PC_POLICY_MISMATCH", "grant policy_spec_digest does not match policy");
  }
  if (grant.gate_bundle_digest !== bundle.digest) {
    throw pcError("PC_POLICY_MISMATCH", "grant gate_bundle_digest does not match live GateBundle");
  }
  if (grant.execution_context_digest !== executionContextDigest(policy.execution_context)) {
    throw pcError("PC_POLICY_MISMATCH", "grant execution_context_digest does not match policy");
  }

  // Authorize enforces ordinal / max attempts / totals itself (not openBudget trust alone).
  if (!Number.isInteger(input.ordinal) || input.ordinal < 0) {
    throw pcError("PC_AUTHORIZATION_INVALID", "ordinal must be a non-negative integer");
  }
  if (input.ordinal >= policy.max_attempts_per_task) {
    throw pcError("PC_GRANT_EXHAUSTED", "ordinal exceeds policy max_attempts_per_task");
  }
  if (input.requested_credits > policy.max_incremental_credits + 1e-12) {
    throw pcError("PC_GRANT_EXHAUSTED", "requested credits exceed policy total cap");
  }

  if (input.previous_job) {
    if (input.previous_job.status === "submission_unknown" || input.previous_job.submission_unknown) {
      throw pcError("PC_SUBMISSION_UNKNOWN", "automatic recovery forbidden after submission_unknown");
    }
  }

  if (!policy.execution_context.task_scope.includes(input.node_id)) {
    throw pcError("PC_RECOVERY_DENIED", "node is outside policy task_scope");
  }
  if (!policy.allowed_error_codes.includes(input.observed_error_code)) {
    throw pcError("PC_RECOVERY_DENIED", "error code is not allowed by policy");
  }

  const baseInPolicy = policy.execution_context.base_compilations.find(
    (entry) => entry.node_id === input.node_id
  );
  if (!baseInPolicy || baseInPolicy.compilation_digest !== input.base_compilation_digest) {
    throw pcError("PC_POLICY_MISMATCH", "base compilation does not match policy for node");
  }
  const baseInBundle = bundle.generation_batches.some((batch) =>
    batch.ordered_units.some((unit) => unit.base_compilation_digest === input.base_compilation_digest)
  );
  if (!baseInBundle) {
    throw pcError("PC_POLICY_MISMATCH", "base compilation is not in live GateBundle");
  }

  const pricing = policy.execution_context.pricing_binding_digest;
  const routeMatch = bundle.generation_batches.some(
    (batch) =>
      batch.route.route_digest === policy.execution_context.route.route_digest
      && batch.pricing_binding_digest === pricing
  );
  if (!routeMatch) {
    throw pcError("PC_POLICY_MISMATCH", "route or pricing drifted from policy");
  }

  // Changed prompt block / parameter limits enforced here (not openBudget caller trust).
  const changedBlocks = input.changed_prompt_block_id ? 1 : 0;
  if (changedBlocks > policy.max_changed_prompt_blocks_per_attempt) {
    throw pcError("PC_RECOVERY_DENIED", "changed prompt blocks exceed policy max of 1");
  }
  if (input.changed_prompt_block_id) {
    if (!policy.allowed_prompt_block_ids.includes(input.changed_prompt_block_id)) {
      throw pcError("PC_RECOVERY_DENIED", "changed prompt block is not in policy allowlist");
    }
  }
  const paramKeys = Object.keys(input.parameter_changes ?? {});
  for (const key of paramKeys) {
    const range = policy.allowed_parameter_ranges[key];
    if (!range) {
      throw pcError("PC_RECOVERY_DENIED", "parameter change is not in policy allowlist");
    }
    const value = (input.parameter_changes ?? {})[key];
    if (typeof value === "number") {
      if (range.min !== undefined && value < range.min) {
        throw pcError("PC_RECOVERY_DENIED", "parameter below policy min");
      }
      if (range.max !== undefined && value > range.max) {
        throw pcError("PC_RECOVERY_DENIED", "parameter above policy max");
      }
    } else if (typeof value === "string" && range.values && !range.values.includes(value)) {
      throw pcError("PC_RECOVERY_DENIED", "parameter value not in policy values");
    }
  }

  if (input.revision_intent) {
    const intent = parseRevisionIntent(input.revision_intent);
    if (!isPolicyEligibleRevisionIntent(intent)) {
      throw pcError("PC_RECOVERY_DENIED", "revision intent change_class is not policy-eligible");
    }
    if (intent.target_node_id !== input.node_id) {
      throw pcError("PC_RECOVERY_DENIED", "revision intent target node mismatch");
    }
  }

  if (input.derived_compilation_digest === input.base_compilation_digest) {
    throw pcError("PC_AUTHORIZATION_INVALID", "derived compilation must differ from base");
  }

  // Live ledger budget re-read before reserve (do not trust caller openBudget snapshot).
  const budgetBefore = await input.ledger.readBudget();
  if (!budgetBefore) {
    throw pcError("PC_LEDGER_CONFLICT", "ledger budget is not open");
  }
  if (budgetBefore.grant_digest !== grant.digest) {
    throw pcError("PC_LEDGER_CONFLICT", "live budget grant_digest does not match grant");
  }
  if (budgetBefore.production_id !== input.production_id) {
    throw pcError("PC_LEDGER_CONFLICT", "live budget production_id does not match");
  }
  if (budgetBefore.attempt_count >= budgetBefore.max_attempts) {
    throw pcError("PC_GRANT_EXHAUSTED", "max attempts exhausted");
  }
  if (budgetBefore.submission_count >= budgetBefore.max_submissions) {
    throw pcError("PC_GRANT_EXHAUSTED", "max submissions exhausted");
  }
  if (budgetBefore.attempt_count >= policy.max_attempts_per_task) {
    throw pcError("PC_GRANT_EXHAUSTED", "policy max_attempts_per_task exhausted on live budget");
  }
  if (budgetBefore.submission_count >= policy.max_total_new_submissions) {
    throw pcError("PC_GRANT_EXHAUSTED", "policy max_total_new_submissions exhausted on live budget");
  }
  if (
    budgetBefore.committed_credits + budgetBefore.reserved_credits + budgetBefore.quarantined_credits
      + input.requested_credits
    > policy.max_incremental_credits + 1e-12
  ) {
    throw pcError("PC_GRANT_EXHAUSTED", "requested credits would exceed policy total on live budget");
  }

  if (input.store) {
    // Prefer durable grant body when present; reject structural grant drift.
    const durableGrant = await input.store.loadGrant(grant.digest).catch(() => undefined);
    if (durableGrant) {
      if (durableGrant.digest !== grant.digest) {
        throw pcError("PC_GRANT_INVALID", "durable grant digest mismatch");
      }
      grant = durableGrant;
    }
    const identity = await input.ledger.captureRootIdentity();
    await input.store.writeGrantCreateOnly({
      grant,
      policy,
      production_id: input.production_id,
      ledger_root_identity: identity
    });
    await input.store.assertLedgerRootForGrant(grant.digest, identity);
  }

  const reservationId = input.reservation_id ?? `rsv-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const reservation = await input.ledger.reserve({
    reservation_id: reservationId,
    grant_digest: grant.digest,
    production_id: input.production_id,
    run_id: input.run_id,
    node_id: input.node_id,
    attempt_key: input.attempt_key,
    pricing_binding_digest: pricing,
    requested_credits: input.requested_credits,
    price_unknown: false,
    now: now.toISOString()
  });

  // Re-read reservation from ledger (terminal-preferring) — never mint from caller struct.
  const liveReservation = await input.ledger.readReservation(reservation.reservation_id);
  if (!liveReservation || liveReservation.status !== "reserved") {
    throw pcError(
      "PC_AUTHORIZATION_INVALID",
      "paid authorization requires a live reserved reservation after reserve"
    );
  }
  if (liveReservation.digest !== reservation.digest) {
    throw pcError("PC_AUTHORIZATION_INVALID", "live reservation digest mismatch after reserve");
  }

  const authorization = createRegenerationAttemptAuthorization({
    grant,
    node_id: input.node_id,
    ordinal: input.ordinal,
    attempt_key: input.attempt_key,
    trigger_failure_ref: input.trigger_failure_ref,
    observed_error_code: input.observed_error_code,
    base_compilation_digest: input.base_compilation_digest,
    patch_artifact_digest: input.patch_artifact_digest,
    changed_prompt_block_id: input.changed_prompt_block_id,
    parameter_changes: input.parameter_changes,
    derived_compilation_digest: input.derived_compilation_digest,
    pricing_binding_digest: pricing,
    credit_ledger_reservation_id: liveReservation.reservation_id,
    credit_ledger_reservation_digest: liveReservation.digest
  });

  if (input.store) {
    await input.store.writeAuthorizationCreateOnly(authorization);
  }

  const ledgerRootIdentity = await input.ledger.captureRootIdentity();
  const sealed = mintSealedPaidAuthorizationInternal({
    authorization,
    reservation: liveReservation,
    grant,
    policy_digest: policy.digest,
    ledger_root_identity: ledgerRootIdentity
  });

  return { authorization, reservation: liveReservation, sealed };
}

/**
 * Internal mint only. Not exported — callers must use authorizePaidRegeneration
 * or rehydrateSealedPaidAuthorization after durable revalidation.
 */
function mintSealedPaidAuthorizationInternal(input: {
  authorization: RegenerationAttemptAuthorization;
  reservation: LedgerReservation;
  grant: RegenerationGrant;
  policy_digest: string;
  ledger_root_identity: DirectoryIdentity;
}): SealedPaidAuthorization {
  const auth = parseRegenerationAttemptAuthorization(input.authorization);
  const grant = parseRegenerationGrant(input.grant);
  if (auth.grant_digest !== grant.digest) {
    throw pcError("PC_AUTHORIZATION_INVALID", "authorization grant_digest does not match grant");
  }
  if (input.reservation.reservation_id !== auth.credit_ledger_reservation_id) {
    throw pcError("PC_AUTHORIZATION_INVALID", "authorization reservation id mismatch");
  }
  if (input.reservation.digest !== auth.credit_ledger_reservation_digest) {
    throw pcError("PC_AUTHORIZATION_INVALID", "authorization reservation digest mismatch");
  }
  if (input.reservation.status !== "reserved") {
    throw pcError("PC_AUTHORIZATION_INVALID", "paid authorization requires a live reserved reservation");
  }
  if (input.reservation.subject.attempt_key !== auth.attempt_key) {
    throw pcError("PC_AUTHORIZATION_INVALID", "reservation attempt_key does not match authorization");
  }
  if (input.reservation.subject.node_id !== auth.node_id) {
    throw pcError("PC_AUTHORIZATION_INVALID", "reservation node_id does not match authorization");
  }
  if (input.reservation.subject.grant_digest !== grant.digest) {
    throw pcError("PC_AUTHORIZATION_INVALID", "reservation grant_digest does not match grant");
  }
  if (input.reservation.subject.pricing_binding_digest !== auth.pricing_binding_digest) {
    throw pcError("PC_AUTHORIZATION_INVALID", "reservation pricing does not match authorization");
  }

  const sealed = Object.freeze({
    kind: "pc-sealed-paid-authorization" as const,
    authorization_digest: auth.digest,
    grant_digest: grant.digest,
    reservation_id: auth.credit_ledger_reservation_id,
    reservation_digest: auth.credit_ledger_reservation_digest,
    node_id: auth.node_id,
    attempt_key: auth.attempt_key,
    derived_compilation_digest: auth.derived_compilation_digest,
    base_compilation_digest: auth.base_compilation_digest,
    pricing_binding_digest: auth.pricing_binding_digest,
    observed_error_code: auth.observed_error_code,
    reserved_credits: input.reservation.reserved_credits,
    ledger_root_identity: Object.freeze({ ...input.ledger_root_identity }),
    policy_digest: input.policy_digest,
    ordinal: auth.ordinal
  });
  sealedPaidAuthorizations.add(sealed);
  return sealed;
}

/** Burn opaque seal after effect commit/release/quarantine so one-shot cannot reuse. */
export function burnSealedPaidAuthorization(sealed: SealedPaidAuthorization): void {
  if (isObject(sealed)) {
    sealedPaidAuthorizations.delete(sealed);
  }
}

/**
 * Resume rehydrate: load durable grant+auth, re-read live ledger reservation (terminal-first),
 * re-bind seal only when still reserved and root identity matches. WeakSet alone is never enough.
 */
export async function rehydrateSealedPaidAuthorization(input: {
  store: DurableRegenerationStore;
  ledger: GrantCreditLedger;
  authorization_digest: string;
  now?: Date;
}): Promise<SealedPaidAuthorization> {
  const auth = await input.store.loadAuthorization(input.authorization_digest);
  const grant = await input.store.loadGrant(auth.grant_digest);
  const policy = await input.store.loadPolicy(grant.policy_spec_digest);
  const now = input.now ?? new Date();
  assertNotExpired(grant.expires_at, now, "PC_GRANT_EXPIRED");
  assertNotExpired(policy.expires_at, now, "PC_POLICY_MISMATCH");

  const identity = await input.ledger.captureRootIdentity();
  await input.store.assertLedgerRootForGrant(grant.digest, identity);

  const reservation = await input.ledger.readReservation(auth.credit_ledger_reservation_id);
  if (!reservation) {
    throw pcError("PC_AUTHORIZATION_INVALID", "reservation missing during rehydrate");
  }
  if (reservation.status !== "reserved") {
    throw pcError(
      "PC_AUTHORIZATION_INVALID",
      `cannot remint paid authority after terminal reservation status=${reservation.status}`
    );
  }
  if (reservation.digest !== auth.credit_ledger_reservation_digest) {
    throw pcError("PC_AUTHORIZATION_INVALID", "reservation digest mismatch during rehydrate");
  }
  return mintSealedPaidAuthorizationInternal({
    authorization: auth,
    reservation,
    grant,
    policy_digest: policy.digest,
    ledger_root_identity: identity
  });
}

/**
 * Deterministic recovery selection from current TaskTree / failure evidence.
 * Never infers Identity confirmed/verified. Only explicitly failed allowed units.
 */
export function selectRecoveryAction(input: {
  mission_state: MissionState;
  task_tree?: TaskTreeSpec;
  failed_node_id: string;
  observed_error_code: string;
  /** Known terminal failure only — submission_unknown forces awaiting_human. */
  failure_kind: "known-failure" | "submission_unknown" | "outcome_unknown" | "identity-drift";
  /** Optional live local permit sealed token. */
  local_permit?: SealedLocalRecoveryPermit;
  /** Optional live paid authorization sealed token. */
  paid_authorization?: SealedPaidAuthorization;
  policy?: RegenerationPolicySpec;
}): RecoveryDecision {
  const node = input.mission_state.nodes[input.failed_node_id];
  if (!node) {
    return {
      action: "awaiting_human",
      reason_code: "disallowed_scope",
      public_reason: "failed node is not in the mission state"
    };
  }
  if (input.failure_kind === "submission_unknown" || input.failure_kind === "outcome_unknown") {
    return {
      action: "awaiting_human",
      reason_code: "submission_unknown",
      public_reason: "submission outcome is unknown; automatic retry is forbidden"
    };
  }
  if (input.failure_kind === "identity-drift") {
    return {
      action: "awaiting_human",
      reason_code: "identity_drift",
      public_reason: "identity drift requires human decision; verification is never inferred"
    };
  }
  // Recovery selection is failed_known only — ready/stale/running never auto-recover.
  if (node.status !== "failed_known") {
    return {
      action: "awaiting_human",
      reason_code: "disallowed_scope",
      public_reason: "recovery selection requires failed_known node status"
    };
  }

  if (input.paid_authorization && isSealedPaidAuthorization(input.paid_authorization)) {
    if (input.paid_authorization.node_id !== input.failed_node_id) {
      return {
        action: "awaiting_human",
        reason_code: "disallowed_scope",
        public_reason: "paid authorization node does not match failed node"
      };
    }
    if (input.policy) {
      const policy = parseRegenerationPolicySpec(input.policy);
      if (!policy.allowed_error_codes.includes(input.observed_error_code)) {
        return {
          action: "awaiting_human",
          reason_code: "disallowed_error",
          public_reason: "error code is outside regeneration policy"
        };
      }
      if (input.paid_authorization.observed_error_code !== input.observed_error_code) {
        return {
          action: "awaiting_human",
          reason_code: "disallowed_error",
          public_reason: "sealed authorization error code does not match observed failure"
        };
      }
    }
    // Paid path is enabled only with genuine sealed auth (already reserved).
    return {
      action: "paid-regeneration",
      sealed: input.paid_authorization
    };
  }

  if (input.local_permit && isSealedLocalRecoveryPermit(input.local_permit)) {
    if (input.local_permit.node_id !== input.failed_node_id) {
      return {
        action: "awaiting_human",
        reason_code: "stale_permit",
        public_reason: "local permit node does not match failed node"
      };
    }
    return {
      action: "local",
      sealed: input.local_permit
    };
  }

  if (!input.policy) {
    return {
      action: "awaiting_human",
      reason_code: "grant_missing",
      public_reason: "no regeneration policy or local permit; automatic paid recovery is 0"
    };
  }

  return {
    action: "awaiting_human",
    reason_code: "grant_missing",
    public_reason: "paid regeneration requires policy, grant, reservation, and sealed attempt authorization"
  };
}

/**
 * Safe-stop helper: map exhaustion / mismatch to awaiting_human public reason codes.
 */
export function safeStopAwaitingHuman(reason: RecoveryStopReason, detail?: string): RecoveryDecision {
  const messages: Record<RecoveryStopReason, string> = {
    grant_missing: "regeneration grant is missing",
    grant_exhausted: "regeneration grant attempts or credits exhausted",
    grant_expired: "regeneration grant has expired",
    policy_mismatch: "recovery policy does not match live production context",
    unknown_price: "unknown price blocks paid recovery",
    unknown_error: "error code is unknown to the recovery policy",
    identity_drift: "identity drift requires human verification",
    submission_unknown: "submission outcome unknown; no automatic resubmit",
    max_attempts: "max recovery attempts reached",
    digest_drift: "digest drift detected; recovery stopped",
    disallowed_error: "error code is not allowed by policy",
    disallowed_scope: "target node or unit is outside recovery scope",
    stale_permit: "local recovery permit is stale or expired",
    awaiting_human: "recovery requires a human decision"
  };
  return {
    action: "awaiting_human",
    reason_code: reason,
    public_reason: detail ? `${messages[reason]}: ${detail}` : messages[reason]
  };
}

/** Compute attempt key bound to node + failure + ordinal + base compilation. */
export function computeRegenerationAttemptKey(input: {
  node_id: string;
  ordinal: number;
  trigger_failure_digest: string;
  base_compilation_digest: string;
  derived_compilation_digest: string;
  grant_digest: string;
}): string {
  return sha256Canonical({
    kind: "regeneration-attempt-key",
    schema_version: 1,
    node_id: input.node_id,
    ordinal: input.ordinal,
    trigger_failure_digest: input.trigger_failure_digest,
    base_compilation_digest: input.base_compilation_digest,
    derived_compilation_digest: input.derived_compilation_digest,
    grant_digest: input.grant_digest
  });
}

/**
 * Verify a sealed paid authorization still matches a job approval binding subject.
 * Used at resume / poll adoption time.
 */
export function assertPaidAuthorizationMatchesBinding(input: {
  sealed: SealedPaidAuthorization;
  regeneration_attempt_authorization_digest?: string;
  compilation_digest: string;
  node_id: string;
  pricing_binding_digest: string;
}): void {
  if (!isSealedPaidAuthorization(input.sealed)) {
    throw pcError("PC_AUTHORIZATION_INVALID", "paid authorization seal is missing or forged");
  }
  if (input.regeneration_attempt_authorization_digest !== input.sealed.authorization_digest) {
    throw pcError(
      "PC_AUTHORIZATION_INVALID",
      "binding regeneration authorization digest does not match sealed authorization"
    );
  }
  if (input.compilation_digest !== input.sealed.derived_compilation_digest) {
    throw pcError(
      "PC_AUTHORIZATION_INVALID",
      "binding compilation is not the authorized derived compilation"
    );
  }
  if (input.node_id !== input.sealed.node_id) {
    throw pcError("PC_AUTHORIZATION_INVALID", "binding node does not match sealed authorization");
  }
  if (input.pricing_binding_digest !== input.sealed.pricing_binding_digest) {
    throw pcError("PC_AUTHORIZATION_INVALID", "pricing binding drifted from sealed authorization");
  }
}

export function assertRouteUnchanged(policyRoute: RouteIdentity, liveRoute: RouteIdentity): void {
  if (policyRoute.route_digest !== liveRoute.route_digest) {
    throw pcError("PC_POLICY_MISMATCH", "route identity drifted from policy");
  }
  if (
    policyRoute.connection_id !== liveRoute.connection_id
    || policyRoute.connection_digest !== liveRoute.connection_digest
    || policyRoute.provider_model !== liveRoute.provider_model
    || policyRoute.ir_model !== liveRoute.ir_model
  ) {
    throw pcError("PC_POLICY_MISMATCH", "model or connection changed outside policy");
  }
}

/**
 * Policy-exempt Gate cascade requires a genuine sealed paid authorization.
 * Caller boolean `policy_exempt_authorized` alone never keeps Gate1.
 */
export function assertPolicyExemptSealedAuthorization(
  sealed: unknown
): asserts sealed is SealedPaidAuthorization {
  if (!isSealedPaidAuthorization(sealed)) {
    throw pcError(
      "PC_AUTHORIZATION_INVALID",
      "policy-exempt Gate cascade requires genuine sealed paid authorization"
    );
  }
}

export function gateDriftKindsForSealedRevisionIntent(input: {
  intent: RevisionIntent;
  sealed_paid_authorization: SealedPaidAuthorization;
}): GateDriftKind[] {
  assertPolicyExemptSealedAuthorization(input.sealed_paid_authorization);
  const intent = parseRevisionIntent(input.intent);
  if (input.sealed_paid_authorization.node_id !== intent.target_node_id) {
    throw pcError("PC_AUTHORIZATION_INVALID", "sealed authorization node does not match revision intent");
  }
  return gateDriftKindsForRevisionIntent({
    intent,
    _sealed_policy_exempt_validated: true
  });
}
