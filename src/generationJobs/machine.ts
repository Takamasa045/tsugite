/**
 * Generation job lifecycle machine: plan → approve → submit → poll → download → pin.
 * Provider-neutral; adapters are injected. Never auto-resubmits after submission_unknown.
 */

import type {
  GenerationJobProviderAdapter
} from "./adapter.js";
import {
  assertApprovalAllowsSubmit,
  createApproval
} from "./approval.js";
import {
  GJ_ADAPTER_MISSING,
  GJ_CANCEL_UNSUPPORTED,
  GJ_HASH_MISMATCH,
  GJ_MODE_UNSUPPORTED,
  GJ_PREFLIGHT_ONLY,
  GJ_PRICE_UNKNOWN,
  GJ_PROVIDER_JOB_MISSING,
  GJ_RESUBMIT_FORBIDDEN,
  GJ_ROUTE_UNSUPPORTED,
  GJ_SUBMISSION_UNKNOWN,
  GenerationJobError
} from "./errors.js";
import type { GenerationJobRecord, GenerationJobRequest } from "./schema.js";
import { GenerationJobStore } from "./store.js";
import { isResumableWithProviderJob } from "./transitions.js";

export type MachineOptions = {
  store: GenerationJobStore;
  adapter: GenerationJobProviderAdapter;
  transport?: unknown;
  now?: () => string;
  /**
   * When true, submit is never attempted (planning / dry-run / preflight path).
   */
  preflightOnly?: boolean;
};

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

export class GenerationJobMachine {
  private readonly store: GenerationJobStore;
  private readonly adapter: GenerationJobProviderAdapter;
  private readonly transport: unknown;
  private readonly now: () => string;
  private readonly preflightOnly: boolean;

  constructor(options: MachineOptions) {
    this.store = options.store;
    this.adapter = options.adapter;
    this.transport = options.transport;
    this.now = options.now ?? (() => new Date().toISOString());
    this.preflightOnly = options.preflightOnly ?? false;
  }

  private ctx(job: GenerationJobRecord) {
    return { job, now: this.now, transport: this.transport };
  }

  async plan(input: PlanJobInput): Promise<GenerationJobRecord> {
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
          code: "GJ-E014",
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
          error: { code: preflight.code, message: preflight.message, retryable: false }
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
            message: preflight.reason ?? "adapter reports preflight-only / not execution-ready",
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
    const approval = createApproval(job, actor, this.now());
    return this.store.transition(
      jobId,
      "approved",
      (j) => ({ ...j, approval }),
      { actor }
    );
  }

  /**
   * Attempt submit. On possible-acceptance timeout → submission_unknown.
   * Never increments submit_attempts unless accepted=true.
   * Never resubmits when submission_unknown or provider_job_id already set from unknown path.
   */
  async submit(jobId: string): Promise<GenerationJobRecord> {
    const job = await this.store.load(jobId);

    if (job.submission_unknown || job.status === "submission_unknown") {
      throw new GenerationJobError(
        GJ_RESUBMIT_FORBIDDEN,
        "automatic resubmit is forbidden after submission_unknown"
      );
    }

    if (this.preflightOnly) {
      throw new GenerationJobError(GJ_PREFLIGHT_ONLY, "preflight-only machine cannot submit");
    }

    assertApprovalAllowsSubmit(job);

    if (!this.adapter.capabilities.submit) {
      throw new GenerationJobError(GJ_ROUTE_UNSUPPORTED, "adapter does not support submit");
    }

    const submitting = await this.store.transition(jobId, "submitting");

    const result = await this.adapter.submit(submitting.request, this.ctx(submitting));
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
      return this.store.transition(
        jobId,
        "submission_unknown",
        (j) => ({
          ...j,
          submission_unknown: true,
          // Do NOT increment submit_attempts — acceptance unconfirmed.
          error: {
            code: GJ_SUBMISSION_UNKNOWN,
            message: result.message,
            retryable: false
          }
        }),
        { acceptance_possible: true, code: result.code }
      );
    }

    return this.store.transition(
      jobId,
      "failed",
      (j) => ({
        ...j,
        error: {
          code: result.code,
          message: result.message,
          retryable: result.retryable ?? false
        }
      })
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
      throw new GenerationJobError(GJ_PROVIDER_JOB_MISSING, "provider_job_id required to poll");
    }

    if (!isResumableWithProviderJob(job.status) && job.status !== "cancel_requested") {
      // Allow starting poll from submitted.
      if (job.status !== "submitted" && job.status !== "polling") {
        // Try transition into polling when allowed.
      }
    }

    if (job.status === "submitted" || job.status === "retry_wait" || job.status === "submission_unknown") {
      job = await this.store.transition(jobId, "polling", (j) => j, { resume: true });
    } else if (job.status !== "polling" && job.status !== "cancel_requested") {
      // already in polling or other — store.transition will validate
      job = await this.store.transition(jobId, "polling");
    }

    const result = await this.adapter.poll(job.provider_job_id!, this.ctx(job));
    if (!result.ok) {
      return this.store.transition(
        jobId,
        result.retryable ? "retry_wait" : "failed",
        (j) => ({
          ...j,
          error: {
            code: result.code,
            message: result.message,
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
          eventType: "poll",
          detail: { provider_status: result.status }
        }
      );
    }

    if (result.status === "succeeded") {
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
          message: result.error ?? "provider reported failure",
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

    const dest = this.store.artifactsDir(jobId);
    const result = await this.adapter.download(job.provider_job_id, dest, this.ctx(job));
    if (!result.ok) {
      return this.store.transition(
        jobId,
        result.retryable ? "retry_wait" : "failed",
        (j) => ({
          ...j,
          error: {
            code: result.code,
            message: result.message,
            retryable: result.retryable ?? false
          }
        })
      );
    }

    if (options.expectedSha256 && options.expectedSha256 !== result.sha256) {
      return this.store.transition(
        jobId,
        "failed",
        (j) => ({
          ...j,
          error: {
            code: GJ_HASH_MISMATCH,
            message: `download hash mismatch: expected ${options.expectedSha256}, got ${result.sha256}`,
            retryable: false
          },
          artifact: undefined
        })
      );
    }

    // relative path under job artifacts
    const relative_path = result.absolute_path.includes(dest)
      ? result.absolute_path.slice(dest.length).replace(/^[/\\]+/, "").split("\\").join("/")
      : options.relativeName ?? "artifact.bin";

    const verified = await this.store.transition(
      jobId,
      "verified",
      (j) => ({
        ...j,
        artifact: {
          relative_path,
          sha256: result.sha256,
          byte_length: result.byte_length,
          content_type: result.content_type,
          pinned: false
        },
        error: undefined
      }),
      { sha256: result.sha256, byte_length: result.byte_length }
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
              message: result.message,
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
          error: { code: result.code, message: result.message, retryable: false }
        })
      );
    }

    return this.store.transition(jobId, "cancelled");
  }

  /**
   * Resume after crash: if provider_job_id exists, continue from poll (never resubmit).
   */
  async resume(jobId: string): Promise<GenerationJobRecord> {
    const job = await this.store.load(jobId);
    if (job.provider_job_id && isResumableWithProviderJob(job.status)) {
      if (job.status === "succeeded" || job.status === "downloading") {
        return this.downloadAndPin(jobId);
      }
      return this.poll(jobId);
    }
    if (job.status === "submission_unknown" && !job.provider_job_id) {
      throw new GenerationJobError(
        GJ_RESUBMIT_FORBIDDEN,
        "cannot resume submit after submission_unknown without provider_job_id"
      );
    }
    return job;
  }
}
