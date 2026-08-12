/**
 * Active recovery controller (PO-6 live call graph).
 *
 * After eligible known failure / QA signal:
 *   select policy-allowed unit → load/issue durable grant+auth → reserve
 *   → job binding with regeneration_attempt_authorization_digest + RevisionIntent
 *     parent/base/derived digests → ProductionDispatcher paid effect
 *   → GenerationJobMachine + T05 same-FD submit → pinned CompletionRef
 *   → commit / release / quarantine reservation and burn sealed auth
 *
 * Base first-submit remains PO-5 external-submit. submission_unknown never resubmits.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { GenerationJobProviderAdapter } from "../generationJobs/adapter.js";
import { GenerationJobMachine, type LiveGate1Evidence } from "../generationJobs/machine.js";
import { GenerationJobStore } from "../generationJobs/store.js";
import type { GenerationJobRecord, GenerationJobRequest } from "../generationJobs/schema.js";
import { sha256Canonical } from "./canonical.js";
import { pcError, ProductionControlError } from "./errors.js";
import {
  createFullProductionJobBinding,
  requireActiveModeForEffect
} from "./activePipeline.js";
import type { DurableCoordinatorPrincipalEvidence } from "./authorityGuard.js";
import { ProductionDispatcher } from "./dispatcher.js";
import type { GateBundle } from "./gateBundle.js";
import {
  createCompletionRefFromPinnedJob,
  type GenerationCompletionRef
} from "./generationBridge.js";
import { GrantCreditLedger } from "./grantLedger.js";
import { DurableRegenerationStore } from "./grantStore.js";
import {
  authorizePaidRegeneration,
  burnSealedPaidAuthorization,
  computeRegenerationAttemptKey,
  issueAndPersistRegenerationGrant,
  issueLocalRecoveryPermit,
  selectRecoveryAction,
  type RecoveryDecision,
  type SealedLocalRecoveryPermit,
  type SealedPaidAuthorization
} from "./recovery.js";
import {
  parseRegenerationPolicySpec,
  type LocalRecoveryAction,
  type LocalRecoveryPermit,
  type RegenerationGrant,
  type RegenerationPolicySpec
} from "./recoveryContracts.js";
import type { RevisionIntent } from "./revisionIntent.js";
import { createInitialMissionState } from "./reducer.js";
import type { DigestRef, HumanDecisionRef, MissionState } from "./schema.js";
import type { ExecutionCompilationBundle } from "../videoPromptDirector/compilationBundle.js";

export type ActivePaidRegenerationInput = {
  production_id: string;
  run_id: string;
  project_id: string;
  revision_id: string;
  productionControlRoot: string;
  /** Ledger root; defaults to productionControlRoot. */
  ledgerRoot?: string;
  node_id: string;
  observed_error_code: string;
  failure_kind: "known-failure" | "submission_unknown" | "outcome_unknown" | "identity-drift";
  policy: RegenerationPolicySpec;
  gate_bundle: GateBundle;
  gate_1_decision: HumanDecisionRef;
  live_gate_1_subject_digest: string;
  live_gate_1_decision_digest: string;
  grant?: RegenerationGrant;
  grant_id?: string;
  base_compilation_digest: string;
  derived_compilation_digest: string;
  patch_artifact_digest: string;
  changed_prompt_block_id?: string;
  parameter_changes?: Record<string, unknown>;
  requested_credits: number;
  ordinal: number;
  trigger_failure_ref: DigestRef;
  revision_intent?: RevisionIntent;
  mission_state?: MissionState;
  /** Sibling node ids that must remain unchanged after recovery stop. */
  sibling_node_ids?: string[];
  job_request: GenerationJobRequest;
  adapter: GenerationJobProviderAdapter;
  resolveExecutionBundle: (
    job: GenerationJobRecord
  ) => ExecutionCompilationBundle | Promise<ExecutionCompilationBundle>;
  live_gate1: LiveGate1Evidence;
  coordinator_principal: DurableCoordinatorPrincipalEvidence;
  dispatcher?: ProductionDispatcher;
  previous_job?: {
    status: string;
    submission_unknown?: boolean;
    provider_job_id?: string;
  };
  /** Fixture/stub outcome override for known-non-submission / unknown paths. */
  force_outcome?: "success" | "known-non-submission" | "submission_unknown";
  now?: Date;
  issued_at?: string;
};

export type ActivePaidRegenerationResult =
  | {
      status: "committed";
      authorization_digest: string;
      reservation_id: string;
      completion: GenerationCompletionRef;
      job: GenerationJobRecord;
      adapter_invokes: number;
      submitted_compilation_digest: string;
    }
  | {
      status: "released";
      authorization_digest: string;
      reservation_id: string;
      adapter_invokes: number;
      reason: "known-non-submission";
    }
  | {
      status: "quarantined";
      authorization_digest: string;
      reservation_id: string;
      adapter_invokes: number;
      reason: "submission_unknown";
    }
  | {
      status: "awaiting_human";
      reason_code: string;
      public_reason: string;
      adapter_invokes: number;
      /** Snapshot of sibling statuses at stop time (unchanged). */
      sibling_statuses?: Record<string, string | undefined>;
    };

/**
 * Live paid regeneration controller entry — production call graph, not helper-only.
 * Reachable only via explicit Coordinator recovery command / library entry.
 * Never auto-invoked from silent run/resume paths.
 */
export async function runActivePaidRegeneration(
  input: ActivePaidRegenerationInput
): Promise<ActivePaidRegenerationResult> {
  requireActiveModeForEffect("active", "paid-regeneration");
  let adapterInvokes = 0;
  const missionState = input.mission_state
    ?? emptyMission(input.production_id, input.node_id, "failed_known");

  // Eligibility before any reserve: failed_known + known-failure only.
  if (input.failure_kind !== "known-failure") {
    const decision = selectRecoveryAction({
      mission_state: missionState,
      failed_node_id: input.node_id,
      observed_error_code: input.observed_error_code,
      failure_kind: input.failure_kind,
      policy: input.policy
    });
    if (decision.action === "awaiting_human") {
      return {
        status: "awaiting_human",
        reason_code: decision.reason_code,
        public_reason: decision.public_reason,
        adapter_invokes: 0,
        sibling_statuses: siblingSnapshot(input)
      };
    }
  }
  {
    const node = missionState.nodes[input.node_id];
    if (!node || node.status !== "failed_known") {
      return {
        status: "awaiting_human",
        reason_code: "disallowed_scope",
        public_reason: "recovery selection requires failed_known node status",
        adapter_invokes: 0,
        sibling_statuses: siblingSnapshot(input)
      };
    }
  }

  const policy = parseRegenerationPolicySpec(input.policy);
  if (!policy.execution_context.task_scope.includes(input.node_id)) {
    return {
      status: "awaiting_human",
      reason_code: "disallowed_scope",
      public_reason: "node is outside policy task_scope",
      adapter_invokes: 0,
      sibling_statuses: siblingSnapshot(input)
    };
  }
  if (!policy.allowed_error_codes.includes(input.observed_error_code)) {
    return {
      status: "awaiting_human",
      reason_code: "disallowed_error",
      public_reason: "error code is not allowed by policy",
      adapter_invokes: 0,
      sibling_statuses: siblingSnapshot(input)
    };
  }

  const store = new DurableRegenerationStore(input.productionControlRoot);
  const ledgerRoot = input.ledgerRoot ?? input.productionControlRoot;
  await mkdir(ledgerRoot, { recursive: true, mode: 0o700 });
  await mkdir(input.productionControlRoot, { recursive: true, mode: 0o700 });
  const ledger = new GrantCreditLedger(ledgerRoot);
  const budgetId = `budget-${input.production_id}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 128);
  const perAttemptCap = Math.min(
    policy.max_incremental_credits,
    Math.max(input.requested_credits, 1)
  );

  const issuedAt = input.issued_at ?? (input.now ?? new Date()).toISOString();
  let grant = input.grant;
  if (!grant) {
    grant = await issueAndPersistRegenerationGrant({
      grant_id: (input.grant_id ?? `grant-${input.run_id}-${input.node_id}`)
        .replace(/[^A-Za-z0-9._-]/g, "-")
        .slice(0, 128),
      policy,
      gate_bundle: input.gate_bundle,
      gate_1_decision: input.gate_1_decision,
      live_gate_1_subject_digest: input.live_gate_1_subject_digest,
      live_gate_1_decision_digest: input.live_gate_1_decision_digest,
      issued_at: issuedAt,
      production_id: input.production_id,
      store,
      ledger,
      now: input.now
    });
  } else {
    const identity = await ledger.captureRootIdentity();
    await store.writeGrantCreateOnly({
      grant,
      policy,
      production_id: input.production_id,
      ledger_root_identity: identity
    });
  }
  await ledger.openBudget({
    budget_id: budgetId,
    grant_digest: grant.digest,
    production_id: input.production_id,
    max_incremental_credits: policy.max_incremental_credits,
    max_attempts: policy.max_attempts_per_task,
    max_submissions: policy.max_total_new_submissions,
    per_attempt_credit_cap: perAttemptCap
  });

  const attemptKey = computeRegenerationAttemptKey({
    node_id: input.node_id,
    ordinal: input.ordinal,
    trigger_failure_digest: input.trigger_failure_ref.digest,
    base_compilation_digest: input.base_compilation_digest,
    derived_compilation_digest: input.derived_compilation_digest,
    grant_digest: grant.digest
  });

  let sealed: SealedPaidAuthorization;
  let authorizationDigest: string;
  let reservationId: string;
  try {
    const authorized = await authorizePaidRegeneration({
      policy,
      grant,
      gate_bundle: input.gate_bundle,
      ledger,
      store,
      node_id: input.node_id,
      ordinal: input.ordinal,
      attempt_key: attemptKey,
      trigger_failure_ref: input.trigger_failure_ref,
      observed_error_code: input.observed_error_code,
      base_compilation_digest: input.base_compilation_digest,
      patch_artifact_digest: input.patch_artifact_digest,
      derived_compilation_digest: input.derived_compilation_digest,
      changed_prompt_block_id: input.changed_prompt_block_id,
      parameter_changes: input.parameter_changes,
      requested_credits: input.requested_credits,
      run_id: input.run_id,
      production_id: input.production_id,
      revision_intent: input.revision_intent,
      previous_job: input.previous_job,
      now: input.now
    });
    sealed = authorized.sealed;
    authorizationDigest = authorized.authorization.digest;
    reservationId = authorized.reservation.reservation_id;
  } catch (error) {
    const code = error instanceof ProductionControlError ? error.code : "PC_RECOVERY_DENIED";
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "awaiting_human",
      reason_code: mapErrorToStopReason(code),
      public_reason: message,
      adapter_invokes: 0,
      sibling_statuses: siblingSnapshot(input)
    };
  }

  const selection = selectRecoveryAction({
    mission_state: missionState,
    failed_node_id: input.node_id,
    observed_error_code: input.observed_error_code,
    failure_kind: "known-failure",
    paid_authorization: sealed,
    policy
  });
  if (selection.action !== "paid-regeneration") {
    await terminalizeReservation(ledger, reservationId, "release");
    burnSealedPaidAuthorization(sealed);
    return {
      status: "awaiting_human",
      reason_code: selection.action === "awaiting_human" ? selection.reason_code : "awaiting_human",
      public_reason: selection.action === "awaiting_human" ? selection.public_reason : "recovery not selected",
      adapter_invokes: 0,
      sibling_statuses: siblingSnapshot(input)
    };
  }

  // Job binding includes regeneration auth + revision parent/base/derived digests.
  const jobId = `job-regen-${input.run_id}-${input.node_id}-${input.ordinal}`
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, 128);
  const attemptId = `attempt-${jobId}`;
  const approvalDigest = sha256Canonical({
    kind: "active-paid-regeneration-approval",
    job_id: jobId,
    authorization_digest: authorizationDigest,
    ...(input.revision_intent ? { revision_intent_digest: input.revision_intent.digest } : {}),
    base_compilation_digest: input.base_compilation_digest,
    derived_compilation_digest: input.derived_compilation_digest
  });

  const binding = createFullProductionJobBinding({
    production_id: input.production_id,
    run_id: input.run_id,
    node_id: input.node_id,
    attempt_id: attemptId,
    generation_job_id: jobId,
    approval_observed_revision: 0,
    approval_digest: approvalDigest,
    gate_bundle: input.gate_bundle,
    gate_1_decision_digest: input.live_gate_1_decision_digest,
    request_digest: input.job_request.digest,
    compilation_digest: input.derived_compilation_digest,
    route: policy.execution_context.route,
    pricing_binding_digest: policy.execution_context.pricing_binding_digest,
    regeneration_attempt_authorization_digest: authorizationDigest
  });

  const jobRoot = join(input.productionControlRoot, "generation-jobs-recovery");
  await mkdir(jobRoot, { recursive: true });
  const jobStore = new GenerationJobStore({ rootDir: jobRoot });
  const dispatcher = input.dispatcher ?? new ProductionDispatcher();

  await jobStore.create({
    job_id: jobId,
    connection_id: input.adapter.connection_id,
    model_id: input.job_request.model_id,
    mode: input.job_request.mode,
    request: input.job_request,
    model_profile_digest: policy.execution_context.route.model_profile_digest,
    connection_capability_digest: policy.execution_context.route.connection_digest,
    pricing: {
      status: "known",
      version: "recovery-v1",
      currency: "USD",
      amount: input.requested_credits,
      max_amount: input.requested_credits
    },
    status: "awaiting_cost_approval",
    production_binding: binding
  });

  // Fixture outcome control via adapter wrapper (production call graph still machine+T05).
  const outcomeAdapter: GenerationJobProviderAdapter = {
    ...input.adapter,
    connection_id: input.adapter.connection_id,
    adapter_id: input.adapter.adapter_id,
    capabilities: input.adapter.capabilities,
    preflight: input.adapter.preflight?.bind(input.adapter),
    async submit(request, ctx) {
      if (input.force_outcome === "known-non-submission") {
        return {
          ok: false as const,
          code: "KNOWN_NON_SUBMISSION",
          message: "fixture known non-submission",
          acceptance_possible: false,
          retryable: false
        };
      }
      if (input.force_outcome === "submission_unknown") {
        throw Object.assign(new Error("fixture network partition after POST"), {
          code: "SUBMISSION_OUTCOME_UNKNOWN"
        });
      }
      return input.adapter.submit(request, ctx);
    },
    poll: input.adapter.poll.bind(input.adapter),
    download: input.adapter.download.bind(input.adapter),
    cancel: input.adapter.cancel?.bind(input.adapter)
  };

  const machine = new GenerationJobMachine({
    store: jobStore,
    adapter: outcomeAdapter,
    orchestrationMode: "active",
    dispatcher,
    resolveExecutionBundle: input.resolveExecutionBundle,
    resolveSubmissionBinding: async (job) => {
      const bundle = await input.resolveExecutionBundle(job);
      // Authorized derived compilation must be the submitted T05/job compilation.
      if (bundle.compilation_digest !== input.derived_compilation_digest) {
        throw pcError(
          "PC_AUTHORIZATION_INVALID",
          "submitted compilation is not the authorized derived compilation"
        );
      }
      return {
        production_id: input.production_id,
        project_id: input.project_id,
        revision_id: input.revision_id,
        request_id: bundle.request_id,
        attempt_id: job.production_binding!.attempt_id,
        job_id: job.job_id,
        compilation_digest: input.derived_compilation_digest,
        effective_contract_digest: bundle.effective_contract_digest,
        asset_lineage_digest: sha256Canonical(bundle.asset_lineage),
        grammar_profile_digest: bundle.grammar_profile?.digest
      };
    },
    resolveGateBundle: async () => input.gate_bundle,
    resolveLiveGate1: async () => input.live_gate1,
    resolveCoordinatorPrincipal: async () => input.coordinator_principal,
    resolvePaidAuthorization: async () => sealed,
    activeSubmitHooks: {
      onAdapterInvoke: () => {
        adapterInvokes += 1;
      }
    }
  });

  try {
    await machine.approve(jobId, "coordinator");
    let current = await machine.submit(jobId);
    adapterInvokes = Math.max(adapterInvokes, machine.lastActiveSubmitUsedT05 ? 1 : adapterInvokes);

    if (current.status === "submission_unknown") {
      // Adapter never invoked and no provider id ⇒ pre-effect / known non-submission.
      // Do not collapse into quarantine (credits held as spent).
      if (adapterInvokes === 0 && !current.provider_job_id) {
        await terminalizeReservation(ledger, reservationId, "release");
        burnSealedPaidAuthorization(sealed);
        return {
          status: "awaiting_human",
          reason_code: "awaiting_human",
          public_reason: current.error?.message ?? "pre-effect failure before provider submit",
          adapter_invokes: 0,
          sibling_statuses: siblingSnapshot(input)
        };
      }
      await terminalizeReservation(ledger, reservationId, "quarantine");
      burnSealedPaidAuthorization(sealed);
      return {
        status: "quarantined",
        authorization_digest: authorizationDigest,
        reservation_id: reservationId,
        adapter_invokes: adapterInvokes,
        reason: "submission_unknown"
      };
    }

    if (
      current.status === "failed"
      && (
        input.force_outcome === "known-non-submission"
        || current.error?.code === "KNOWN_NON_SUBMISSION"
      )
    ) {
      await terminalizeReservation(ledger, reservationId, "release");
      burnSealedPaidAuthorization(sealed);
      return {
        status: "released",
        authorization_digest: authorizationDigest,
        reservation_id: reservationId,
        adapter_invokes: adapterInvokes,
        reason: "known-non-submission"
      };
    }

    if (current.status === "failed") {
      // Known terminal failure after effect: hold credits (no reserved leftover).
      await terminalizeReservation(
        ledger,
        reservationId,
        adapterInvokes > 0 ? "quarantine" : "release"
      );
      burnSealedPaidAuthorization(sealed);
      return {
        status: "awaiting_human",
        reason_code: "awaiting_human",
        public_reason: current.error?.message ?? "regeneration failed",
        adapter_invokes: adapterInvokes,
        sibling_statuses: siblingSnapshot(input)
      };
    }

    if (current.status === "submitted") {
      current = await machine.poll(jobId);
    }
    if (current.status === "succeeded" || current.status === "downloading") {
      current = await machine.downloadAndPin(jobId);
    }
    current = await jobStore.load(jobId);
    if (current.status !== "pinned" || !current.artifact?.pinned) {
      // Effect may have occurred; never leave reserved. Quarantine when adapter ran.
      await terminalizeReservation(
        ledger,
        reservationId,
        adapterInvokes > 0 ? "quarantine" : "release"
      );
      burnSealedPaidAuthorization(sealed);
      return {
        status: "awaiting_human",
        reason_code: "awaiting_human",
        public_reason: `job did not reach pinned (status=${current.status})`,
        adapter_invokes: adapterInvokes,
        sibling_statuses: siblingSnapshot(input)
      };
    }

    const completion = createCompletionRefFromPinnedJob({
      job: current,
      binding,
      verification_digest: sha256Canonical({
        kind: "active-paid-completion-verification",
        job_id: jobId,
        artifact: current.artifact.sha256,
        authorization_digest: authorizationDigest
      })
    });

    await ledger.commit({
      reservation_id: reservationId,
      actual_credits: input.requested_credits
    });
    burnSealedPaidAuthorization(sealed);

    return {
      status: "committed",
      authorization_digest: authorizationDigest,
      reservation_id: reservationId,
      completion,
      job: current,
      adapter_invokes: adapterInvokes,
      submitted_compilation_digest: input.derived_compilation_digest
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const postEffectUnknown = isPostEffectOutcomeUnknown(error, adapterInvokes);
    if (postEffectUnknown) {
      // Post-effect outcome unknown → quarantine (no resubmit).
      await terminalizeReservation(ledger, reservationId, "quarantine");
      burnSealedPaidAuthorization(sealed);
      return {
        status: "quarantined",
        authorization_digest: authorizationDigest,
        reservation_id: reservationId,
        adapter_invokes: adapterInvokes,
        reason: "submission_unknown"
      };
    }
    // Pre-effect exception: release reservation and surface as safe stop (not quarantine).
    await terminalizeReservation(ledger, reservationId, "release");
    burnSealedPaidAuthorization(sealed);
    const code = error instanceof ProductionControlError ? error.code : "PC_RECOVERY_DENIED";
    return {
      status: "awaiting_human",
      reason_code: mapErrorToStopReason(code),
      public_reason: message,
      adapter_invokes: adapterInvokes,
      sibling_statuses: siblingSnapshot(input)
    };
  }
}

/**
 * Resume helper: revalidate durable grant/auth + ledger before any paid continue.
 * Does not remint after terminal reservation.
 */
export async function resumePaidRegenerationContext(input: {
  productionControlRoot: string;
  ledgerRoot?: string;
  authorization_digest: string;
}): Promise<{
  sealed: SealedPaidAuthorization;
  ledger: GrantCreditLedger;
  store: DurableRegenerationStore;
}> {
  const store = new DurableRegenerationStore(input.productionControlRoot);
  const ledger = new GrantCreditLedger(input.ledgerRoot ?? input.productionControlRoot);
  const { rehydrateSealedPaidAuthorization } = await import("./recovery.js");
  const sealed = await rehydrateSealedPaidAuthorization({
    store,
    ledger,
    authorization_digest: input.authorization_digest
  });
  return { sealed, ledger, store };
}

export type ActiveLocalRecoveryInput = {
  production_id: string;
  node_id: string;
  mission_state: MissionState;
  tree_revision: number;
  task_revision: number;
  input_digest: string;
  /** Only poll/download of a known provider job id — never submit. */
  action: Extract<LocalRecoveryAction, "resume-known-job-poll" | "retry-verified-download">;
  known_job: NonNullable<LocalRecoveryPermit["known_job"]>;
  job_id: string;
  jobStore: GenerationJobStore;
  machine: GenerationJobMachine;
  issued_at?: string;
  expires_at?: string;
  max_attempts?: number;
  now?: Date;
  sibling_node_ids?: string[];
};

export type ActiveLocalRecoveryResult =
  | {
      status: "local_ok";
      action: ActiveLocalRecoveryInput["action"];
      permit_digest: string;
      job: GenerationJobRecord;
      submit_invokes: 0;
    }
  | {
      status: "awaiting_human";
      reason_code: string;
      public_reason: string;
      submit_invokes: 0;
      sibling_statuses?: Record<string, string | undefined>;
    };

/**
 * Local recovery executor. Mints and consumes LocalRecoveryPermit internally —
 * mint is not a public API surface. Poll/download only; submit count is always 0.
 */
export async function runActiveLocalRecovery(
  input: ActiveLocalRecoveryInput
): Promise<ActiveLocalRecoveryResult> {
  requireActiveModeForEffect("active", "local-recovery");
  const node = input.mission_state.nodes[input.node_id];
  if (!node || node.status !== "failed_known") {
    return {
      status: "awaiting_human",
      reason_code: "disallowed_scope",
      public_reason: "recovery selection requires failed_known node status",
      submit_invokes: 0,
      sibling_statuses: localSiblingSnapshot(input)
    };
  }
  if (!input.known_job.provider_job_id) {
    return {
      status: "awaiting_human",
      reason_code: "stale_permit",
      public_reason: "local recovery requires a known provider job id",
      submit_invokes: 0,
      sibling_statuses: localSiblingSnapshot(input)
    };
  }

  const now = input.now ?? new Date();
  const issuedAt = input.issued_at ?? now.toISOString();
  const expiresAt = input.expires_at
    ?? new Date(now.getTime() + 15 * 60_000).toISOString();

  let sealed: SealedLocalRecoveryPermit;
  let permitDigest: string;
  try {
    // Permit mint is internal to this executor (not a public package export).
    const issued = issueLocalRecoveryPermit({
      permit_id: `local-${input.production_id}-${input.node_id}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 128),
      production_id: input.production_id,
      tree_revision: input.tree_revision,
      node_id: input.node_id,
      task_revision: input.task_revision,
      input_digest: input.input_digest,
      action: input.action,
      known_job: input.known_job,
      issued_at: issuedAt,
      expires_at: expiresAt,
      max_attempts: input.max_attempts ?? 1,
      live: {
        production_id: input.production_id,
        tree_revision: input.tree_revision,
        node_id: input.node_id,
        task_revision: input.task_revision,
        input_digest: input.input_digest
      },
      now
    });
    sealed = issued.sealed;
    permitDigest = issued.permit.digest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "awaiting_human",
      reason_code: "stale_permit",
      public_reason: message,
      submit_invokes: 0,
      sibling_statuses: localSiblingSnapshot(input)
    };
  }

  const decision = selectRecoveryAction({
    mission_state: input.mission_state,
    failed_node_id: input.node_id,
    observed_error_code: "LOCAL_RECOVERY",
    failure_kind: "known-failure",
    local_permit: sealed
  });
  if (decision.action !== "local") {
    return {
      status: "awaiting_human",
      reason_code: decision.action === "awaiting_human" ? decision.reason_code : "awaiting_human",
      public_reason: decision.action === "awaiting_human" ? decision.public_reason : "local recovery not selected",
      submit_invokes: 0,
      sibling_statuses: localSiblingSnapshot(input)
    };
  }

  const job = await input.jobStore.load(input.job_id);
  if (!job.provider_job_id || job.provider_job_id !== input.known_job.provider_job_id) {
    return {
      status: "awaiting_human",
      reason_code: "stale_permit",
      public_reason: "job provider id does not match local recovery permit",
      submit_invokes: 0,
      sibling_statuses: localSiblingSnapshot(input)
    };
  }
  if (job.connection_id !== input.known_job.connection_id) {
    return {
      status: "awaiting_human",
      reason_code: "stale_permit",
      public_reason: "job connection does not match local recovery permit",
      submit_invokes: 0,
      sibling_statuses: localSiblingSnapshot(input)
    };
  }

  // Never submit on the local path — poll / download only.
  let current = job;
  if (input.action === "resume-known-job-poll") {
    current = await input.machine.poll(input.job_id);
  }
  if (
    input.action === "retry-verified-download"
    || current.status === "succeeded"
    || current.status === "downloading"
  ) {
    if (current.status === "succeeded" || current.status === "downloading" || current.status === "pinned") {
      if (current.status !== "pinned") {
        current = await input.machine.downloadAndPin(input.job_id);
      }
    }
  }
  current = await input.jobStore.load(input.job_id);
  return {
    status: "local_ok",
    action: input.action,
    permit_digest: permitDigest,
    job: current,
    submit_invokes: 0
  };
}

export type CoordinatorRecoveryPlanInput = {
  production_id: string;
  node_id: string;
  observed_error_code: string;
  failure_kind: ActivePaidRegenerationInput["failure_kind"];
  mission_state: MissionState;
  policy?: RegenerationPolicySpec;
  paid_authorization?: SealedPaidAuthorization;
  local_permit?: SealedLocalRecoveryPermit;
  /** Durable evidence digests for audit (optional). */
  evidence?: {
    gate_bundle_digest?: string;
    grant_digest?: string;
    gate_1_decision_digest?: string;
    identity_verification_digest?: string;
    job_id?: string;
  };
};

export type CoordinatorRecoveryPlan = {
  decision: RecoveryDecision;
  eligible: boolean;
  node_status: string | undefined;
  evidence: CoordinatorRecoveryPlanInput["evidence"];
  /** True when paid path would require explicit confirm (never silent). */
  requires_confirm_paid: boolean;
};

/**
 * Load selection from durable mission + optional sealed authority.
 * Never spends credits. Used by CLI dry-run and preflight.
 */
export function planCoordinatorRecovery(input: CoordinatorRecoveryPlanInput): CoordinatorRecoveryPlan {
  const node = input.mission_state.nodes[input.node_id];
  const decision = selectRecoveryAction({
    mission_state: input.mission_state,
    failed_node_id: input.node_id,
    observed_error_code: input.observed_error_code,
    failure_kind: input.failure_kind,
    policy: input.policy,
    paid_authorization: input.paid_authorization,
    local_permit: input.local_permit
  });
  return {
    decision,
    eligible: decision.action !== "awaiting_human",
    node_status: node?.status,
    evidence: input.evidence,
    requires_confirm_paid: decision.action === "paid-regeneration"
  };
}

/**
 * Explicit Coordinator paid recovery entry. Requires confirm_paid=true.
 * Silent auto-spend from run/resume is forbidden; this is the only paid gate.
 */
export async function executeCoordinatorPaidRecovery(
  input: ActivePaidRegenerationInput & { confirm_paid: true }
): Promise<ActivePaidRegenerationResult> {
  if (input.confirm_paid !== true) {
    throw pcError("PC_RECOVERY_DENIED", "paid recovery requires explicit confirm_paid");
  }
  return runActivePaidRegeneration(input);
}

/**
 * Terminalize a reserved entry. Only PC_RESERVATION_INVALID for an already-terminal
 * reservation is a no-op; lock/IO/missing/still-reserved fail closed.
 * After the transition (or already-terminal no-op), re-read durable reservation and
 * refuse success when status is still reserved or unreadable.
 * Callers must not burn seals or return terminal success until this resolves.
 */
async function terminalizeReservation(
  ledger: GrantCreditLedger,
  reservationId: string,
  mode: "release" | "quarantine"
): Promise<void> {
  let transitionError: unknown;
  try {
    if (mode === "release") {
      await ledger.release({
        reservation_id: reservationId,
        reason: "known-non-submission"
      });
    } else {
      await ledger.quarantine({ reservation_id: reservationId });
    }
  } catch (error) {
    if (isAlreadyTerminalReservationError(error, mode)) {
      // Durable verify below still required.
    } else {
      transitionError = error;
    }
  }

  let reservation;
  try {
    reservation = await ledger.readReservation(reservationId);
  } catch (readError) {
    // lock/IO during durable confirm — never report terminal success.
    throw readError;
  }

  if (!reservation || reservation.status === "reserved") {
    if (transitionError instanceof ProductionControlError) throw transitionError;
    if (transitionError instanceof Error) throw transitionError;
    throw pcError(
      "PC_LEDGER_UNSAFE",
      `reservation ${reservationId} remained reserved after terminalize (${mode})`
    );
  }
  // Terminal durable status confirmed (released | quarantined | committed).
}

/** Only already-terminal PC_RESERVATION_INVALID is a no-op candidate. */
function isAlreadyTerminalReservationError(
  error: unknown,
  mode: "release" | "quarantine"
): boolean {
  if (!(error instanceof ProductionControlError) || error.code !== "PC_RESERVATION_INVALID") {
    return false;
  }
  const message = error.message;
  // Missing reservation is not "already terminal".
  if (/reservation not found/i.test(message)) return false;
  if (mode === "release") {
    return /only reserved entries can be released|committed reservation can never be released/i.test(
      message
    );
  }
  return /only reserved entries can be quarantined/i.test(message);
}

function isPostEffectOutcomeUnknown(error: unknown, adapterInvokes: number): boolean {
  if (adapterInvokes > 0) return true;
  if (error instanceof ProductionControlError && error.code === "PC_SUBMISSION_UNKNOWN") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  return /submission_unknown|SUBMISSION_OUTCOME_UNKNOWN|outcome unknown/i.test(`${message} ${code}`);
}

function emptyMission(
  productionId: string,
  nodeId: string,
  status: "failed_known" | "ready" = "failed_known"
): MissionState {
  const base = createInitialMissionState(productionId);
  return {
    ...base,
    mission_status: "running",
    nodes: {
      [nodeId]: {
        node_id: nodeId,
        status,
        task_revision: 1,
        input_digest: "a".repeat(64),
        dependency_closure_digest: "b".repeat(64),
        stale: false
      }
    }
  };
}

function siblingSnapshot(input: ActivePaidRegenerationInput): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (!input.mission_state || !input.sibling_node_ids) return out;
  for (const id of input.sibling_node_ids) {
    out[id] = input.mission_state.nodes[id]?.status;
  }
  return out;
}

function localSiblingSnapshot(input: ActiveLocalRecoveryInput): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (!input.sibling_node_ids) return out;
  for (const id of input.sibling_node_ids) {
    out[id] = input.mission_state.nodes[id]?.status;
  }
  return out;
}

function mapErrorToStopReason(code: string): string {
  switch (code) {
    case "PC_GRANT_EXHAUSTED":
      return "grant_exhausted";
    case "PC_GRANT_EXPIRED":
      return "grant_expired";
    case "PC_POLICY_MISMATCH":
      return "policy_mismatch";
    case "PC_SUBMISSION_UNKNOWN":
      return "submission_unknown";
    case "PC_RECOVERY_DENIED":
      return "disallowed_scope";
    default:
      return "awaiting_human";
  }
}
