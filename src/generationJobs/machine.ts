/**
 * Generation job lifecycle machine: plan → approve → submit → poll → download → pin.
 * Provider-neutral; adapters are injected. Never auto-resubmits after submission_unknown.
 */

import type {
  GenerationJobProviderAdapter
} from "./adapter.js";
import {
  assertApprovalAllowsSubmit,
  assertProductionBindingForMode,
  assertRequestDigestMatches,
  computeRequestDigest,
  createApproval
} from "./approval.js";
import { verifyAdapterArtifact } from "./download.js";
import {
  GJ_ADAPTER_MISSING,
  GJ_CANCEL_UNSUPPORTED,
  GJ_CATALOG_NOT_ADAPTER,
  GJ_HASH_MISMATCH,
  GJ_MODE_UNSUPPORTED,
  GJ_PREFLIGHT_ONLY,
  GJ_PRICE_UNKNOWN,
  GJ_PROVIDER_JOB_MISSING,
  GJ_RESUBMIT_FORBIDDEN,
  GJ_RETRY_EXHAUSTED,
  GJ_ROUTE_UNSUPPORTED,
  GJ_SCHEMA_INVALID,
  GJ_SUBMIT_NOT_ALLOWED,
  GJ_SUBMISSION_UNKNOWN,
  GenerationJobError
} from "./errors.js";
import { redactSecretsInString } from "./secrets.js";
import type { GenerationJobRecord, GenerationJobRequest } from "./schema.js";
import { GenerationJobStore } from "./store.js";
import { isResumableWithProviderJob } from "./transitions.js";
import {
  executeWithSubmissionAuthority,
  type ExecutionSubmitHooks
} from "../productionControl/generationBridge.js";
import {
  mintSealedCoordinatorAuthority,
  mintSealedGate1Binding,
  type DurableCoordinatorPrincipalEvidence
} from "../productionControl/authorityGuard.js";
import { ProductionDispatcher } from "../productionControl/dispatcher.js";
import { requireActiveModeForEffect } from "../productionControl/activePipeline.js";
import type { ProductionControlMode } from "../productionControl/schema.js";
import type { GateBundle } from "../productionControl/gateBundle.js";
import {
  isSealedPaidAuthorization,
  type SealedPaidAuthorization
} from "../productionControl/recovery.js";
import type {
  ExecutionSubmissionBinding,
  ExecutionSubmissionInput
} from "../videoPromptDirector/compilationBundle.js";
import {
  noteEffectBoundary,
  registerEffectBoundary,
  type EffectPolicy
} from "../productionControl/rc/effectCapability.js";

/**
 * Default durable poll budget (max adapter poll invocations per job).
 * No automatic sleep/loop here — callers invoke poll() once per attempt.
 */
export const DEFAULT_MAX_POLL_ATTEMPTS = 120;

/**
 * Default max durable download adapter invocations per job.
 * Small bounded retry budget; no automatic sleep/loop.
 */
export const DEFAULT_MAX_DOWNLOAD_ATTEMPTS = 3;

export type MachineOptions = {
  store: GenerationJobStore;
  adapter: GenerationJobProviderAdapter;
  transport?: unknown;
  now?: () => string;
  /**
   * When true, submit is never attempted (planning / dry-run / preflight path).
   */
  preflightOnly?: boolean;
  /**
   * Positive bound on durable poll adapter calls (default 120).
   * Counter is persisted before each invocation so crash/resume cannot reset budget.
   */
  maxPollAttempts?: number;
  /**
   * Positive bound on durable download adapter calls (default 3).
   * Counter is persisted before each invocation so crash/resume cannot reset budget.
   */
  maxDownloadAttempts?: number;
  /**
   * Production-control rollout mode. Active submit requires full production
   * binding and routes exclusively through T05 executeWithSubmissionAuthority.
   * Unresolved mode fails closed at the active effect boundary.
   */
  orchestrationMode?: ProductionControlMode;
  /**
   * Optional explicit effect policy (RC deny / coverage). Never ambient.
   * Registers provider_submit + network_fetch boundaries on construction.
   */
  effectPolicy?: EffectPolicy;
  /**
   * Active mode only: return a T05-adopted execution compilation bundle for the job.
   * Must be genuinely adopted (WeakSet); raw / fake JSON → adapter invoke 0.
   * Callers that load via loadExecutionAuthoritativePinnedPromptBudgetEvidence and
   * deriveExecutionCompilationBundleFromPlanningArtifact satisfy this contract.
   */
  resolveExecutionBundle?: (
    job: GenerationJobRecord
  ) => unknown | Promise<unknown>;
  /**
   * Active mode only: exact attempt/job submission binding for the T05 lease.
   */
  resolveSubmissionBinding?: (
    job: GenerationJobRecord
  ) => ExecutionSubmissionBinding | Promise<ExecutionSubmissionBinding>;
  /**
   * Active mode only (required): live GateBundle for sealed Gate1 authority + membership.
   * Missing resolver fails closed at active submit — never optional for active.
   */
  resolveGateBundle?: (
    job: GenerationJobRecord
  ) => GateBundle | Promise<GateBundle>;
  /**
   * Active mode only (required): live Gate1 evidence recomputed from durable GateBundle
   * + HumanDecisionRef body (not a free-form 64-hex pair). Missing resolver fails closed.
   */
  resolveLiveGate1?: (
    job: GenerationJobRecord
  ) => LiveGate1Evidence | Promise<LiveGate1Evidence>;
  /**
   * Active mode only (required): verified durable coordinator principal evidence.
   * Literal "coordinator" strings are not authority.
   */
  resolveCoordinatorPrincipal?: (
    job: GenerationJobRecord
  ) =>
    | DurableCoordinatorPrincipalEvidence
    | Promise<DurableCoordinatorPrincipalEvidence | undefined>
    | undefined;
  /**
   * Test/integration hooks around the active T05 submission path only.
   * Never grants authority by itself.
   */
  activeSubmitHooks?: ExecutionSubmitHooks;
  /**
   * Shared ProductionDispatcher (effectful max 1). When omitted, a private
   * dispatcher is created; active submit always routes through a dispatcher.
   */
  dispatcher?: ProductionDispatcher;
  /**
   * Active paid regeneration only: resolve a genuine sealed paid authorization
   * when production_binding includes regeneration_attempt_authorization_digest.
   * Required for paid effect; missing/forged seal fails closed.
   */
  resolvePaidAuthorization?: (
    job: GenerationJobRecord
  ) => SealedPaidAuthorization | Promise<SealedPaidAuthorization | undefined> | undefined;
};

function positiveBound(value: number | undefined, fallback: number, label: string): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1) {
    throw new GenerationJobError(
      GJ_SCHEMA_INVALID,
      `${label} must be a positive integer`
    );
  }
  return n;
}

export type PlanJobInput = {
  request: GenerationJobRequest;
  model_profile_digest: string;
  connection_capability_digest: string;
  pricing: GenerationJobRecord["pricing"];
  adapter_id?: string;
  job_id?: string;
  /**
   * Exact model/mode must be supported by the adapter's connection;
   * callers pass route validation result.
   */
  route_ok: boolean;
  mode_ok?: boolean;
  adapter_present: boolean;
  catalog_present_without_adapter?: boolean;
};

/** Live Gate1 evidence for sealed authority mint (recomputed, not forged digests). */
export type LiveGate1Evidence = {
  subject_digest: string;
  decision_digest: string;
  production_id: string;
  run_id: string;
  legacy_approved_input_digest: string;
  decision: {
    decision_id: string;
    decision: string;
    actor: string;
    decided_at: string;
    reason?: string;
  };
};

function safeErrorMessage(message: string): string {
  return redactSecretsInString(message).slice(0, 2_000);
}

export class GenerationJobMachine {
  private readonly store: GenerationJobStore;
  private readonly adapter: GenerationJobProviderAdapter;
  private readonly transport: unknown;
  private readonly now: () => string;
  private readonly preflightOnly: boolean;
  private readonly maxPollAttempts: number;
  private readonly maxDownloadAttempts: number;
  private readonly orchestrationMode: ProductionControlMode | undefined;
  private readonly resolveExecutionBundle?: MachineOptions["resolveExecutionBundle"];
  private readonly resolveSubmissionBinding?: MachineOptions["resolveSubmissionBinding"];
  private readonly resolveGateBundle?: MachineOptions["resolveGateBundle"];
  private readonly resolveLiveGate1?: MachineOptions["resolveLiveGate1"];
  private readonly resolveCoordinatorPrincipal?: MachineOptions["resolveCoordinatorPrincipal"];
  private readonly activeSubmitHooks?: ExecutionSubmitHooks;
  private readonly dispatcher: ProductionDispatcher;
  private readonly resolvePaidAuthorization?: MachineOptions["resolvePaidAuthorization"];
  private readonly effectPolicy?: EffectPolicy;
  /** Tracks whether the active path invoked adapter.submit via T05 only. */
  private activeSubmitUsedT05 = false;

  constructor(options: MachineOptions) {
    this.store = options.store;
    this.adapter = options.adapter;
    this.transport = options.transport;
    this.now = options.now ?? (() => new Date().toISOString());
    this.preflightOnly = options.preflightOnly ?? false;
    this.maxPollAttempts = positiveBound(
      options.maxPollAttempts,
      DEFAULT_MAX_POLL_ATTEMPTS,
      "maxPollAttempts"
    );
    this.maxDownloadAttempts = positiveBound(
      options.maxDownloadAttempts,
      DEFAULT_MAX_DOWNLOAD_ATTEMPTS,
      "maxDownloadAttempts"
    );
    this.orchestrationMode = options.orchestrationMode;
    this.resolveExecutionBundle = options.resolveExecutionBundle;
    this.resolveSubmissionBinding = options.resolveSubmissionBinding;
    this.resolveGateBundle = options.resolveGateBundle;
    this.resolveLiveGate1 = options.resolveLiveGate1;
    this.resolveCoordinatorPrincipal = options.resolveCoordinatorPrincipal;
    this.activeSubmitHooks = options.activeSubmitHooks;
    this.dispatcher = options.dispatcher ?? new ProductionDispatcher();
    this.resolvePaidAuthorization = options.resolvePaidAuthorization;
    this.effectPolicy = options.effectPolicy;
    // Actual boundary wrappers register at construction time only.
    registerEffectBoundary(this.effectPolicy, "provider_submit");
    registerEffectBoundary(this.effectPolicy, "network_fetch");
  }

  /** True after an active-mode submit that consumed a T05 lease. */
  get lastActiveSubmitUsedT05(): boolean {
    return this.activeSubmitUsedT05;
  }

  private ctx(job: GenerationJobRecord) {
    return { job, now: this.now, transport: this.transport };
  }

  async plan(input: PlanJobInput): Promise<GenerationJobRecord> {
    // Bind request digest to canonical content before any durable write.
    assertRequestDigestMatches(input.request);
    // Ensure stored digest matches content (recompute if needed is caller's duty; we only assert).
    const contentDigest = computeRequestDigest(input.request);
    if (input.request.digest !== contentDigest) {
      throw new GenerationJobError(
        GJ_ROUTE_UNSUPPORTED,
        "request digest binding failed before plan"
      );
    }

    if (input.catalog_present_without_adapter && !input.adapter_present) {
      const job = await this.store.create({
        ...(input.job_id ? { job_id: input.job_id } : {}),
        connection_id: input.request.connection_id,
        ...(input.adapter_id ? { adapter_id: input.adapter_id } : {}),
        model_id: input.request.model_id,
        mode: input.request.mode,
        request: input.request,
        model_profile_digest: input.model_profile_digest,
        connection_capability_digest: input.connection_capability_digest,
        pricing: input.pricing,
        status: "blocked",
        error: {
          code: GJ_CATALOG_NOT_ADAPTER,
          message: "catalog presence is not adapter implementation",
          retryable: false
        }
      });
      return job;
    }

    if (!input.adapter_present) {
      throw new GenerationJobError(
        GJ_ADAPTER_MISSING,
        `no adapter for connection '${input.request.connection_id}'`
      );
    }

    if (input.mode_ok === false) {
      throw new GenerationJobError(
        GJ_MODE_UNSUPPORTED,
        `mode '${input.request.mode}' is not supported for model '${input.request.model_id}'`
      );
    }

    if (!input.route_ok) {
      throw new GenerationJobError(
        GJ_ROUTE_UNSUPPORTED,
        `exact model/mode route unsupported for connection '${input.request.connection_id}'`
      );
    }

    if (input.request.connection_id !== this.adapter.connection_id) {
      throw new GenerationJobError(
        GJ_ROUTE_UNSUPPORTED,
        "connection_id does not match injected adapter (no silent switch)"
      );
    }

    const job = await this.store.create({
      ...(input.job_id ? { job_id: input.job_id } : {}),
      connection_id: input.request.connection_id,
      adapter_id: this.adapter.adapter_id,
      model_id: input.request.model_id,
      mode: input.request.mode,
      request: input.request,
      model_profile_digest: input.model_profile_digest,
      connection_capability_digest: input.connection_capability_digest,
      pricing: input.pricing
    });

    // Move to awaiting_cost_approval after preflight.
    const preflight = await this.adapter.preflight(job.request, this.ctx(job));
    if (!preflight.ok) {
      return this.store.transition(
        job.job_id,
        "blocked",
        (j) => ({
          ...j,
          error: {
            code: preflight.code,
            message: safeErrorMessage(preflight.message),
            retryable: false
          }
        }),
        { preflight: preflight }
      );
    }

    if (!preflight.execution_ready || this.preflightOnly) {
      return this.store.transition(
        job.job_id,
        "blocked",
        (j) => ({
          ...j,
          error: {
            code: GJ_PREFLIGHT_ONLY,
            message: safeErrorMessage(
              preflight.reason ?? "adapter reports preflight-only / not execution-ready"
            ),
            retryable: false
          }
        }),
        { preflight }
      );
    }

    if (job.pricing.status === "unknown") {
      return this.store.transition(
        job.job_id,
        "blocked",
        (j) => ({
          ...j,
          error: {
            code: GJ_PRICE_UNKNOWN,
            message: "pricing unknown; submit is fail-closed",
            retryable: false
          }
        })
      );
    }

    return this.store.transition(job.job_id, "awaiting_cost_approval");
  }

  async approve(jobId: string, actor: string): Promise<GenerationJobRecord> {
    const job = await this.store.load(jobId);
    assertRequestDigestMatches(job.request);
    // Active mode: full production binding required before approve (not length-only).
    assertProductionBindingForMode(job, this.orchestrationMode);
    // createApproval also checks amount > max_amount → GJ_PRICE_CAP_EXCEEDED
    const approval = createApproval(job, actor, this.now());
    return this.store.transition(
      jobId,
      "approved",
      (j) => ({ ...j, approval }),
      { actor }
    );
  }

  /**
   * Attempt submit. On possible-acceptance timeout or throw → submission_unknown.
   * Never increments submit_attempts unless accepted=true.
   * Fail-closed: durable status must be exactly approved and provider_job_id absent.
   * Never resubmits from submission_unknown, retry_wait, or any post-submit status.
   */
  async submit(jobId: string): Promise<GenerationJobRecord> {
    const job = await this.store.load(jobId);

    if (job.submission_unknown || job.status === "submission_unknown") {
      throw new GenerationJobError(
        GJ_RESUBMIT_FORBIDDEN,
        "automatic resubmit is forbidden after submission_unknown"
      );
    }

    if (job.status === "submitting") {
      // Concurrent submit or crash mid-flight: never call adapter again.
      // Crash recovery is resume() → submission_unknown when provider_job_id is missing.
      throw new GenerationJobError(
        GJ_RESUBMIT_FORBIDDEN,
        "job is already submitting; use resume after crash (no automatic resubmit)"
      );
    }

    // Fail-closed: any known provider job id means accept already happened or is unknown.
    if (job.provider_job_id) {
      throw new GenerationJobError(
        GJ_RESUBMIT_FORBIDDEN,
        "provider_job_id already present; automatic resubmit is forbidden"
      );
    }

    // Only the durable approved state may enter submit (no retry_wait → submitting).
    if (job.status !== "approved") {
      throw new GenerationJobError(
        GJ_SUBMIT_NOT_ALLOWED,
        `submit requires durable status 'approved' with no provider_job_id; got '${job.status}'`
      );
    }

    if (this.preflightOnly) {
      throw new GenerationJobError(GJ_PREFLIGHT_ONLY, "preflight-only machine cannot submit");
    }

    assertApprovalAllowsSubmit(job);
    // Active mode requires full production binding before any adapter effect.
    assertProductionBindingForMode(job, this.orchestrationMode);

    if (!this.adapter.capabilities.submit) {
      throw new GenerationJobError(GJ_ROUTE_UNSUPPORTED, "adapter does not support submit");
    }

    // Shadow never falls through to legacy direct adapter.submit.
    if (this.orchestrationMode === "shadow") {
      requireActiveModeForEffect("shadow", "external-submit");
    }

    // Effect policy hook after existing authority checks (production no-op when undefined).
    noteEffectBoundary(this.effectPolicy, "provider_submit", "generationJobs.machine.submit");

    // Durable transition before adapter call. Crash after this → submission_unknown on resume.
    const submitting = await this.store.transition(jobId, "submitting");
    this.activeSubmitUsedT05 = false;

    let result: Awaited<ReturnType<GenerationJobProviderAdapter["submit"]>>;
    try {
      if (this.orchestrationMode === "active") {
        // Active: machine direct adapter.submit is impossible — T05 lease only.
        // Authority failures before adapter effect fail closed without submission_unknown
        // (adapter was never invoked; acceptance is known-impossible).
        result = await this.submitViaT05(submitting);
      } else if (this.orchestrationMode === "shadow") {
        // Unreachable when requireActiveModeForEffect throws; keep fail-closed.
        throw new GenerationJobError(
          GJ_SUBMIT_NOT_ALLOWED,
          "shadow mode forbids provider submit; direct adapter.submit is closed"
        );
      } else {
        // Legacy / disabled only: existing direct adapter path.
        result = await this.adapter.submit(submitting.request, this.ctx(submitting));
      }
    } catch (error) {
      if (
        this.orchestrationMode === "active"
        && error instanceof GenerationJobError
        && error.code === GJ_SUBMIT_NOT_ALLOWED
        && !this.activeSubmitUsedT05
      ) {
        // T05 rejected before any adapter effect — durable fail, not submission_unknown.
        return this.store.transition(
          jobId,
          "failed",
          (j) => ({
            ...j,
            error: {
              code: error.code,
              message: safeErrorMessage(error.message),
              retryable: false
            }
          })
        );
      }
      // Adapter throw after durable submitting = acceptance unknown (fail-closed).
      const message = safeErrorMessage(
        error instanceof Error ? error.message : "adapter submit threw"
      );
      return this.markSubmissionUnknown(
        submitting.job_id,
        `adapter submit threw; acceptance unknown: ${message}`
      );
    }

    if (result.ok) {
      return this.store.transition(
        jobId,
        "submitted",
        (j) => ({
          ...j,
          provider_job_id: result.provider_job_id,
          submit_attempts: j.submit_attempts + 1,
          submission_unknown: false,
          error: undefined
        }),
        { provider_job_id: result.provider_job_id }
      );
    }

    if (result.acceptance_possible) {
      return this.markSubmissionUnknown(jobId, result.message, GJ_SUBMISSION_UNKNOWN, result.code);
    }

    return this.store.transition(
      jobId,
      "failed",
      (j) => ({
        ...j,
        error: {
          code: result.code,
          message: safeErrorMessage(result.message),
          retryable: result.retryable ?? false
        }
      })
    );
  }

  /**
   * Active-mode submit: ProductionDispatcher effectful max-1 + one-shot T05 lease only.
   * Direct adapter.submit is unreachable. Same-FD ExecutionSubmissionInput is passed to
   * the adapter/transport; path reopen / void input is forbidden. Fake/raw/mismatched
   * bundles yield adapter invocation 0. Expiry never resubmits.
   */
  private async submitViaT05(
    submitting: GenerationJobRecord
  ): Promise<Awaited<ReturnType<GenerationJobProviderAdapter["submit"]>>> {
    requireActiveModeForEffect(this.orchestrationMode, "external-submit");
    if (!this.resolveExecutionBundle || !this.resolveSubmissionBinding) {
      throw new GenerationJobError(
        GJ_SUBMIT_NOT_ALLOWED,
        "active submit requires execution bundle and submission binding resolvers"
      );
    }
    // Active requires GateBundle + live Gate1 + coordinator principal + dispatcher.
    // Optional resolvers fail closed (never skip sealed authority).
    if (!this.resolveGateBundle || !this.resolveLiveGate1 || !this.resolveCoordinatorPrincipal) {
      throw new GenerationJobError(
        GJ_SUBMIT_NOT_ALLOWED,
        "active submit requires resolveGateBundle, resolveLiveGate1, and resolveCoordinatorPrincipal"
      );
    }
    const binding = await this.resolveSubmissionBinding(submitting);
    if (
      !binding
      || binding.job_id !== submitting.job_id
      || binding.attempt_id !== submitting.production_binding?.attempt_id
    ) {
      throw new GenerationJobError(
        GJ_SUBMIT_NOT_ALLOWED,
        "active submit binding must match exact attempt_id and job_id"
      );
    }
    const productionBinding = submitting.production_binding;
    if (!productionBinding) {
      throw new GenerationJobError(
        GJ_SUBMIT_NOT_ALLOWED,
        "active submit requires full generation job production binding"
      );
    }

    // Sealed authority from live durable resolvers only — free-form copies rejected.
    // ProductionDispatcher (effectful max1) always gates active submit.
    let slot: ReturnType<ProductionDispatcher["acquire"]> | undefined;
    try {
      const gateBundle = await this.resolveGateBundle(submitting);
      const liveGate1 = await this.resolveLiveGate1(submitting);
      if (
        !liveGate1
        || liveGate1.subject_digest.length !== 64
        || liveGate1.decision_digest.length !== 64
        || !liveGate1.production_id
        || !liveGate1.run_id
        || !liveGate1.legacy_approved_input_digest
        || !liveGate1.decision?.decision_id
        || !liveGate1.decision?.actor
        || !liveGate1.decision?.decided_at
      ) {
        throw new GenerationJobError(
          GJ_SUBMIT_NOT_ALLOWED,
          "active submit requires recomputed live Gate 1 evidence (subject, decision body, legacy digest)"
        );
      }
      const durablePrincipal = await this.resolveCoordinatorPrincipal(submitting);
      if (!durablePrincipal) {
        throw new GenerationJobError(
          GJ_SUBMIT_NOT_ALLOWED,
          "active submit requires verified durable coordinator principal evidence"
        );
      }
      const coordinator = mintSealedCoordinatorAuthority({
        actor: "coordinator",
        durable_principal: durablePrincipal,
        live_gate_1_decision_digest: liveGate1.decision_digest
      });
      // Mint re-verifies subject/decision from durable GateBundle + decision body.
      // Free-form matching 64-hex pairs are rejected inside mintSealedGate1Binding.
      const sealedGate1 = mintSealedGate1Binding({
        gate_bundle: gateBundle,
        production_id: liveGate1.production_id,
        run_id: liveGate1.run_id,
        legacy_approved_input_digest: liveGate1.legacy_approved_input_digest,
        decision: {
          decision_id: liveGate1.decision.decision_id,
          decision: liveGate1.decision.decision,
          actor: liveGate1.decision.actor,
          decided_at: liveGate1.decision.decided_at,
          ...(liveGate1.decision.reason ? { reason: liveGate1.decision.reason } : {})
        },
        live_subject_digest: liveGate1.subject_digest,
        live_decision_digest: liveGate1.decision_digest
      });
      // Paid regeneration: binding carries regeneration_attempt_authorization_digest
      // and requires a genuine sealed paid authorization (effect=paid). Base PO-5
      // first submit remains external-submit without that digest.
      const regenAuthDigest = productionBinding.regeneration_attempt_authorization_digest;
      let sealedPaid: SealedPaidAuthorization | undefined;
      if (regenAuthDigest) {
        const resolved = this.resolvePaidAuthorization
          ? await this.resolvePaidAuthorization(submitting)
          : undefined;
        if (!resolved || !isSealedPaidAuthorization(resolved)) {
          throw new GenerationJobError(
            GJ_SUBMIT_NOT_ALLOWED,
            "paid regeneration requires genuine sealed paid authorization"
          );
        }
        if (resolved.authorization_digest !== regenAuthDigest) {
          throw new GenerationJobError(
            GJ_SUBMIT_NOT_ALLOWED,
            "sealed paid authorization digest does not match production binding"
          );
        }
        if (resolved.derived_compilation_digest !== productionBinding.compilation_digest) {
          throw new GenerationJobError(
            GJ_SUBMIT_NOT_ALLOWED,
            "sealed paid authorization derived compilation does not match binding"
          );
        }
        sealedPaid = resolved;
      }
      slot = this.dispatcher.acquire({
        node_id: productionBinding.node_id,
        attempt_id: productionBinding.attempt_id,
        task_revision: productionBinding.approval_observed_revision,
        input_digest: productionBinding.immutable_identity_digest,
        role: "generator",
        effect: sealedPaid ? "paid" : "external-submit",
        authority: {
          mode: "active",
          actor: "coordinator",
          coordinator_authority: coordinator,
          gate_bundle: gateBundle,
          gate_1: sealedGate1,
          expected_pricing_binding_digest: productionBinding.pricing_binding_digest,
          ...(sealedPaid ? { sealed_paid_authorization: sealedPaid } : {})
        }
      });
    } catch (error) {
      if (error instanceof GenerationJobError) throw error;
      throw new GenerationJobError(
        GJ_SUBMIT_NOT_ALLOWED,
        `active submit authority/dispatch failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const bundle = await this.resolveExecutionBundle(submitting);
    let adapterResult: Awaited<ReturnType<GenerationJobProviderAdapter["submit"]>> | undefined;
    try {
      const authority = await executeWithSubmissionAuthority({
        bundle,
        binding,
        hooks: {
          onAdapterInvoke: () => {
            this.activeSubmitUsedT05 = true;
            this.activeSubmitHooks?.onAdapterInvoke?.();
          },
          submitEffect: async (input: ExecutionSubmissionInput) => {
            // Same-FD input must be consumed by adapter/transport — never voided.
            // Prove the token is live by touching the public T05 API surface; zero-asset
            // bundles still require the input object identity to reach the adapter.
            if (!input || typeof input !== "object") {
              throw new GenerationJobError(
                GJ_SUBMIT_NOT_ALLOWED,
                "active submit requires same-FD ExecutionSubmissionInput"
              );
            }
            // Forbid path reopen: active adapter receives request without project asset paths.
            // submission_input / same-FD bytes are the only authoritative asset source.
            const activeRequest = {
              ...submitting.request,
              asset_paths: [] as string[]
            };
            const result = await this.adapter.submit(activeRequest, {
              ...this.ctx(submitting),
              submission_input: input
            });
            adapterResult = result;
            const hookResult = await this.activeSubmitHooks?.submitEffect?.(input);
            return hookResult ?? result;
          }
        }
      });
      if (!authority.ok) {
        throw new GenerationJobError(
          GJ_SUBMIT_NOT_ALLOWED,
          `active submit T05 authority failed: ${authority.error}`
        );
      }
      if (!adapterResult) {
        throw new GenerationJobError(
          GJ_SUBMIT_NOT_ALLOWED,
          "active submit did not reach adapter through T05 lease"
        );
      }
      return adapterResult;
    } finally {
      if (slot) {
        try {
          this.dispatcher.release(slot.lease.lease_id);
        } catch {
          // release is best-effort; lease expiry never resubmits
        }
      }
    }
  }

  private async markSubmissionUnknown(
    jobId: string,
    message: string,
    code: string = GJ_SUBMISSION_UNKNOWN,
    providerCode?: string
  ): Promise<GenerationJobRecord> {
    const current = await this.store.load(jobId);
    // Already terminal / unknown — preserve submit_attempts.
    if (current.status === "submission_unknown") {
      return current;
    }
    return this.store.transition(
      jobId,
      "submission_unknown",
      (j) => ({
        ...j,
        submission_unknown: true,
        // Do NOT increment submit_attempts — acceptance unconfirmed.
        error: {
          code: GJ_SUBMISSION_UNKNOWN,
          message: safeErrorMessage(message),
          retryable: false
        }
      }),
      {
        acceptance_possible: true,
        code,
        ...(providerCode ? { provider_code: providerCode } : {})
      }
    );
  }

  /**
   * Resume poll for submitted / polling / submission_unknown (only with provider_job_id).
   */
  async poll(jobId: string): Promise<GenerationJobRecord> {
    let job = await this.store.load(jobId);

    if (!job.provider_job_id) {
      if (job.status === "submission_unknown" || job.submission_unknown) {
        throw new GenerationJobError(
          GJ_SUBMISSION_UNKNOWN,
          "cannot poll submission_unknown without provider_job_id; resubmit forbidden"
        );
      }
      if (job.status === "submitting") {
        throw new GenerationJobError(
          GJ_SUBMISSION_UNKNOWN,
          "cannot poll submitting without provider_job_id; use resume"
        );
      }
      throw new GenerationJobError(GJ_PROVIDER_JOB_MISSING, "provider_job_id required to poll");
    }

    if (job.status === "submitted" || job.status === "retry_wait" || job.status === "submission_unknown") {
      job = await this.store.transition(jobId, "polling", (j) => j, { resume: true });
    } else if (job.status !== "polling" && job.status !== "cancel_requested") {
      job = await this.store.transition(jobId, "polling");
    }

    const pollAttempts = job.poll_attempts ?? 0;
    if (pollAttempts >= this.maxPollAttempts) {
      return this.store.transition(
        jobId,
        "failed",
        (j) => ({
          ...j,
          error: {
            code: GJ_RETRY_EXHAUSTED,
            message: safeErrorMessage(
              `poll attempts exhausted (${pollAttempts}/${this.maxPollAttempts})`
            ),
            retryable: false
          }
        })
      );
    }

    // Persist budget consumption before adapter call so crash/resume cannot reset it.
    job = await this.store.save(
      {
        ...job,
        poll_attempts: pollAttempts + 1,
        updated_at: this.now()
      },
      {
        expectedIdentity: job.identity_token,
        expectedRevision: job.revision,
        eventType: "poll_attempt",
        detail: {
          poll_attempts: pollAttempts + 1,
          max_poll_attempts: this.maxPollAttempts
        }
      }
    );

    noteEffectBoundary(this.effectPolicy, "network_fetch", "generationJobs.machine.poll");
    const result = await this.adapter.poll(job.provider_job_id!, this.ctx(job));
    if (!result.ok) {
      return this.store.transition(
        jobId,
        result.retryable ? "retry_wait" : "failed",
        (j) => ({
          ...j,
          error: {
            code: result.code,
            message: safeErrorMessage(result.message),
            retryable: result.retryable ?? false
          }
        })
      );
    }

    if (result.status === "queued" || result.status === "running") {
      // Stay in polling; record event via save with same status (self-loop allowed).
      return this.store.save(
        { ...job, status: "polling", updated_at: this.now() },
        {
          expectedIdentity: job.identity_token,
          expectedRevision: job.revision,
          eventType: "poll",
          detail: { provider_status: result.status }
        }
      );
    }

    // Cancel race: cancel_requested + provider succeeded → explicit safe terminal (succeeded).
    if (result.status === "succeeded") {
      if (job.status === "cancel_requested" || job.cancel_requested) {
        return this.store.transition(
          jobId,
          "succeeded",
          (j) => ({
            ...j,
            cancel_requested: true,
            error: undefined
          }),
          { cancel_race: "provider_succeeded_after_cancel_requested" }
        );
      }
      return this.store.transition(jobId, "succeeded");
    }

    if (result.status === "cancelled") {
      return this.store.transition(jobId, "cancelled");
    }

    return this.store.transition(
      jobId,
      "failed",
      (j) => ({
        ...j,
        error: {
          code: "provider_failed",
          message: safeErrorMessage(result.error ?? "provider reported failure"),
          retryable: false
        }
      })
    );
  }

  async downloadAndPin(
    jobId: string,
    options: { expectedSha256?: string; relativeName?: string } = {}
  ): Promise<GenerationJobRecord> {
    let job = await this.store.load(jobId);
    if (job.status === "succeeded") {
      job = await this.store.transition(jobId, "downloading");
    } else if (job.status !== "downloading") {
      job = await this.store.transition(jobId, "downloading");
    }

    if (!job.provider_job_id) {
      throw new GenerationJobError(GJ_PROVIDER_JOB_MISSING, "provider_job_id required to download");
    }

    const downloadAttempts = job.download_attempts ?? 0;
    if (downloadAttempts >= this.maxDownloadAttempts) {
      return this.store.transition(
        jobId,
        "failed",
        (j) => ({
          ...j,
          error: {
            code: GJ_RETRY_EXHAUSTED,
            message: safeErrorMessage(
              `download attempts exhausted (${downloadAttempts}/${this.maxDownloadAttempts})`
            ),
            retryable: false
          }
        })
      );
    }

    // Persist budget consumption before adapter call so crash/resume cannot reset it.
    job = await this.store.save(
      {
        ...job,
        download_attempts: downloadAttempts + 1,
        updated_at: this.now()
      },
      {
        expectedIdentity: job.identity_token,
        expectedRevision: job.revision,
        eventType: "download_attempt",
        detail: {
          download_attempts: downloadAttempts + 1,
          max_download_attempts: this.maxDownloadAttempts
        }
      }
    );

    const dest = this.store.artifactsDir(jobId);
    noteEffectBoundary(this.effectPolicy, "network_fetch", "generationJobs.machine.download");
    const result = await this.adapter.download(job.provider_job_id!, dest, this.ctx(job));
    if (!result.ok) {
      return this.store.transition(
        jobId,
        result.retryable ? "retry_wait" : "failed",
        (j) => ({
          ...j,
          error: {
            code: result.code,
            message: safeErrorMessage(result.message),
            retryable: result.retryable ?? false
          }
        })
      );
    }

    // Core re-verifies path containment, regular file, size, and SHA-256.
    // Adapter self-reported hash/path alone is never enough for verified/pinned.
    let verifiedArtifact;
    try {
      verifiedArtifact = await verifyAdapterArtifact(dest, {
        absolute_path: result.absolute_path,
        sha256: result.sha256,
        byte_length: result.byte_length,
        content_type: result.content_type
      });
    } catch (error) {
      const code =
        error instanceof GenerationJobError ? error.code : GJ_HASH_MISMATCH;
      return this.store.transition(
        jobId,
        "failed",
        (j) => ({
          ...j,
          error: {
            code,
            message: safeErrorMessage(
              error instanceof Error ? error.message : "artifact verification failed"
            ),
            retryable: false
          },
          artifact: undefined
        })
      );
    }

    if (options.expectedSha256 && options.expectedSha256 !== verifiedArtifact.sha256) {
      return this.store.transition(
        jobId,
        "failed",
        (j) => ({
          ...j,
          error: {
            code: GJ_HASH_MISMATCH,
            message: `download hash mismatch: expected ${options.expectedSha256}, got ${verifiedArtifact.sha256}`,
            retryable: false
          },
          artifact: undefined
        })
      );
    }

    const verified = await this.store.transition(
      jobId,
      "verified",
      (j) => ({
        ...j,
        artifact: {
          relative_path: verifiedArtifact.relative_path,
          sha256: verifiedArtifact.sha256,
          byte_length: verifiedArtifact.byte_length,
          content_type: verifiedArtifact.content_type,
          pinned: false
        },
        error: undefined
      }),
      { sha256: verifiedArtifact.sha256, byte_length: verifiedArtifact.byte_length }
    );

    return this.store.transition(
      verified.job_id,
      "pinned",
      (j) => ({
        ...j,
        artifact: j.artifact ? { ...j.artifact, pinned: true } : j.artifact
      })
    );
  }

  async requestCancel(jobId: string): Promise<GenerationJobRecord> {
    const job = await this.store.load(jobId);
    if (!this.adapter.capabilities.cancel || !this.adapter.cancel) {
      // Fail-closed: mark failed with cancel unsupported rather than silent ignore.
      return this.store.transition(
        jobId,
        job.status === "approved" || job.status === "planned" || job.status === "awaiting_cost_approval"
          ? "cancelled"
          : "failed",
        (j) => ({
          ...j,
          cancel_requested: true,
          error: {
            code: GJ_CANCEL_UNSUPPORTED,
            message: "cancel is not supported by this adapter",
            retryable: false
          }
        })
      );
    }

    const marked = await this.store.transition(
      jobId,
      "cancel_requested",
      (j) => ({ ...j, cancel_requested: true })
    );

    if (!marked.provider_job_id) {
      return this.store.transition(jobId, "cancelled");
    }

    const result = await this.adapter.cancel(marked.provider_job_id, this.ctx(marked));
    if (!result.ok) {
      if (result.unsupported) {
        return this.store.transition(
          jobId,
          "failed",
          (j) => ({
            ...j,
            error: {
              code: GJ_CANCEL_UNSUPPORTED,
              message: safeErrorMessage(result.message),
              retryable: false
            }
          })
        );
      }
      return this.store.transition(
        jobId,
        "failed",
        (j) => ({
          ...j,
          error: {
            code: result.code,
            message: safeErrorMessage(result.message),
            retryable: false
          }
        })
      );
    }

    return this.store.transition(jobId, "cancelled");
  }

  /**
   * Resume after crash:
   * - submitting without provider_job_id → submission_unknown (no resubmit)
   * - provider_job_id exists → continue poll/download
   * - submission_unknown without provider_job_id → resubmit forbidden
   */
  async resume(jobId: string): Promise<GenerationJobRecord> {
    const job = await this.store.load(jobId);

    if (job.status === "submitting" && !job.provider_job_id) {
      return this.markSubmissionUnknown(
        jobId,
        "resume after crash: submitting with no provider_job_id"
      );
    }

    if (job.provider_job_id && isResumableWithProviderJob(job.status)) {
      if (job.status === "succeeded" || job.status === "downloading") {
        return this.downloadAndPin(jobId);
      }
      return this.poll(jobId);
    }

    if (
      (job.status === "submission_unknown" || job.submission_unknown)
      && !job.provider_job_id
    ) {
      // Durable unknown without provider id: return as-is. Resubmit remains forbidden on submit().
      return job;
    }

    return job;
  }
}
