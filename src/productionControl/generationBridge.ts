/**
 * generationJobs bridge for active production control.
 * Uses T05 public authority only: adopted execution bundle + one-shot lease.
 * No T05 private WeakSet exposure, no structural fake / raw JSON authority.
 */
import { z } from "zod";
import type { GenerationJobRecord } from "../generationJobs/schema.js";
import {
  createExecutionSubmissionLease,
  consumeExecutionSubmissionLease,
  isAdoptedExecutionCompilationBundle,
  releaseExecutionSubmissionInput,
  type ExecutionCompilationBundle,
  type ExecutionSubmissionBinding,
  type ExecutionSubmissionInput,
  type ExecutionSubmissionLease
} from "../videoPromptDirector/compilationBundle.js";
import { sha256Canonical, withoutField } from "./canonical.js";
import { pcError } from "./errors.js";
import { assertGateBundleExecutable, type GateBundle } from "./gateBundle.js";
import { routeIdentitySchema, type RouteIdentity } from "./programBinding.js";
import { digestSchema, safeIdSchema } from "./schema.js";

const nonNegativeInt = z.number().int().nonnegative();

export const generationJobApprovalBindingSchema = z.object({
  production_id: safeIdSchema,
  run_id: safeIdSchema,
  node_id: safeIdSchema,
  attempt_id: safeIdSchema,
  generation_job_id: safeIdSchema,
  approval_observed_revision: nonNegativeInt,
  approval_digest: digestSchema,
  gate_bundle_digest: digestSchema,
  gate_1_decision_digest: digestSchema,
  request_digest: digestSchema,
  compilation_digest: digestSchema,
  route: routeIdentitySchema,
  pricing_binding_digest: digestSchema,
  regeneration_attempt_authorization_digest: digestSchema.optional(),
  immutable_identity_digest: digestSchema
}).strict().superRefine((value, context) => {
  const expected = computeImmutableIdentityDigest(value);
  if (value.immutable_identity_digest !== expected) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["immutable_identity_digest"],
      message: "immutable identity digest mismatch"
    });
  }
});
export type GenerationJobApprovalBinding = z.infer<typeof generationJobApprovalBindingSchema>;
export type GenerationJobApprovalBindingV1 = GenerationJobApprovalBinding;

export const generationCompletionRefSchema = z.object({
  production_id: safeIdSchema,
  run_id: safeIdSchema,
  node_id: safeIdSchema,
  attempt_id: safeIdSchema,
  generation_job_id: safeIdSchema,
  pinned_revision: nonNegativeInt,
  immutable_identity_digest: digestSchema,
  artifact_sha256: digestSchema,
  artifact_byte_length: nonNegativeInt,
  verification_digest: digestSchema,
  digest: digestSchema
}).strict().superRefine((value, context) => {
  if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "completion ref digest mismatch" });
  }
});
export type GenerationCompletionRef = z.infer<typeof generationCompletionRefSchema>;
export type GenerationCompletionRefV1 = GenerationCompletionRef;

/** Optional backward-compatible production binding on generation job records. */
export const generationJobProductionBindingSchema = z.object({
  production_id: safeIdSchema,
  run_id: safeIdSchema,
  node_id: safeIdSchema,
  attempt_id: safeIdSchema,
  gate_bundle_digest: digestSchema,
  immutable_identity_digest: digestSchema,
  approval_observed_revision: nonNegativeInt
}).strict();
export type GenerationJobProductionBinding = z.infer<typeof generationJobProductionBindingSchema>;

export type ImmutableIdentityInput = {
  production_id: string;
  run_id: string;
  node_id: string;
  attempt_id: string;
  generation_job_id: string;
  approval_digest: string;
  gate_bundle_digest: string;
  gate_1_decision_digest: string;
  request_digest: string;
  compilation_digest: string;
  route: RouteIdentity;
  pricing_binding_digest: string;
  regeneration_attempt_authorization_digest?: string;
};

/**
 * Immutable identity excludes the job record's monotonically mutable revision.
 * approval_observed_revision is recorded for observation only and is NOT part
 * of the immutable digest subject.
 */
export function computeImmutableIdentityDigest(input: ImmutableIdentityInput): string {
  return sha256Canonical({
    kind: "generation-job-immutable-identity",
    schema_version: 1,
    production_id: input.production_id,
    run_id: input.run_id,
    node_id: input.node_id,
    attempt_id: input.attempt_id,
    generation_job_id: input.generation_job_id,
    approval_digest: input.approval_digest,
    gate_bundle_digest: input.gate_bundle_digest,
    gate_1_decision_digest: input.gate_1_decision_digest,
    request_digest: input.request_digest,
    compilation_digest: input.compilation_digest,
    route: input.route,
    pricing_binding_digest: input.pricing_binding_digest,
    ...(input.regeneration_attempt_authorization_digest
      ? { regeneration_attempt_authorization_digest: input.regeneration_attempt_authorization_digest }
      : {})
  });
}

export function createGenerationJobApprovalBinding(input: ImmutableIdentityInput & {
  approval_observed_revision: number;
}): GenerationJobApprovalBinding {
  const immutable = computeImmutableIdentityDigest(input);
  return generationJobApprovalBindingSchema.parse({
    ...input,
    immutable_identity_digest: immutable
  });
}

export function createGenerationCompletionRef(input: {
  production_id: string;
  run_id: string;
  node_id: string;
  attempt_id: string;
  generation_job_id: string;
  pinned_revision: number;
  immutable_identity_digest: string;
  artifact_sha256: string;
  artifact_byte_length: number;
  verification_digest: string;
}): GenerationCompletionRef {
  const base = {
    production_id: input.production_id,
    run_id: input.run_id,
    node_id: input.node_id,
    attempt_id: input.attempt_id,
    generation_job_id: input.generation_job_id,
    pinned_revision: input.pinned_revision,
    immutable_identity_digest: input.immutable_identity_digest,
    artifact_sha256: input.artifact_sha256,
    artifact_byte_length: input.artifact_byte_length,
    verification_digest: input.verification_digest
  };
  return generationCompletionRefSchema.parse({ ...base, digest: sha256Canonical(base) });
}

/**
 * Revision may increase; immutable identity must never drift.
 * Revision rollback is always rejected.
 */
export function assertJobRevisionAndIdentity(input: {
  previous_revision: number;
  next_revision: number;
  previous_immutable_identity_digest: string;
  next_immutable_identity_digest: string;
}): void {
  if (input.next_revision < input.previous_revision) {
    throw pcError("PC_GENERATION_REVISION_ROLLBACK", "generation job revision cannot roll back", {
      previous: input.previous_revision,
      next: input.next_revision
    });
  }
  if (input.next_immutable_identity_digest !== input.previous_immutable_identity_digest) {
    throw pcError("PC_GENERATION_IDENTITY_DRIFT", "generation job immutable identity drifted", {
      previous: input.previous_immutable_identity_digest,
      next: input.next_immutable_identity_digest
    });
  }
}

/** Pin-only: completion refs require durable status=pinned with pinned artifact. */
export function assertPinnedCompletion(job: Pick<GenerationJobRecord, "status" | "artifact" | "revision">): {
  sha256: string;
  byte_length: number;
  revision: number;
} {
  if (job.status !== "pinned" || !job.artifact || job.artifact.pinned !== true) {
    throw pcError("PC_COMPLETION_NOT_PINNED", "completion ref requires pinned generation job");
  }
  return {
    sha256: job.artifact.sha256,
    byte_length: job.artifact.byte_length,
    revision: job.revision
  };
}

export function createCompletionRefFromPinnedJob(input: {
  job: GenerationJobRecord;
  binding: GenerationJobApprovalBinding;
  verification_digest: string;
}): GenerationCompletionRef {
  if (input.job.job_id !== input.binding.generation_job_id) {
    throw pcError("PC_GENERATION_BINDING_INVALID", "completion job id does not match approval binding");
  }
  const pinned = assertPinnedCompletion(input.job);
  return createGenerationCompletionRef({
    production_id: input.binding.production_id,
    run_id: input.binding.run_id,
    node_id: input.binding.node_id,
    attempt_id: input.binding.attempt_id,
    generation_job_id: input.binding.generation_job_id,
    pinned_revision: pinned.revision,
    immutable_identity_digest: input.binding.immutable_identity_digest,
    artifact_sha256: pinned.sha256,
    artifact_byte_length: pinned.byte_length,
    verification_digest: input.verification_digest
  });
}

/**
 * submission_unknown resume policy:
 * - known provider job id → poll/download only
 * - unknown provider id → awaiting human / outcome unknown; never new submit
 */
export function resolveSubmissionUnknownAction(job: Pick<GenerationJobRecord, "status" | "submission_unknown" | "provider_job_id">): {
  action: "poll_or_download" | "awaiting_human";
  may_submit: false;
  provider_job_known: boolean;
} {
  const unknown = job.status === "submission_unknown" || job.submission_unknown;
  if (!unknown) {
    throw pcError("PC_SUBMISSION_UNKNOWN", "job is not in submission_unknown");
  }
  if (job.provider_job_id) {
    return { action: "poll_or_download", may_submit: false, provider_job_known: true };
  }
  return { action: "awaiting_human", may_submit: false, provider_job_known: false };
}

export function assertNoResubmitOnSubmissionUnknown(job: Pick<GenerationJobRecord, "status" | "submission_unknown">): void {
  if (job.status === "submission_unknown" || job.submission_unknown) {
    throw pcError("PC_SUBMISSION_UNKNOWN", "automatic resubmit is forbidden after submission_unknown");
  }
}

export type ExecutionSubmitHooks = {
  /** Counted only when a real provider submit effect would run. */
  onAdapterInvoke?: () => void;
  submitEffect?: (input: ExecutionSubmissionInput) => Promise<unknown> | unknown;
};

/**
 * Create a one-shot ExecutionSubmissionLease with exact attempt_id+job_id,
 * consume immediately before effect, same-FD asset path via T05, finally release.
 * Mismatch / fake / raw JSON → adapter invocation 0.
 *
 * The consumed ExecutionSubmissionInput is always passed to submitEffect. Adapters
 * must consume same-FD assets via readExecutionSubmissionAsset; path reopen is forbidden.
 */
export async function executeWithSubmissionAuthority(input: {
  bundle: unknown;
  binding: ExecutionSubmissionBinding;
  hooks?: ExecutionSubmitHooks;
}): Promise<{ ok: true; result: unknown } | { ok: false; error: string; adapter_invocations: number }> {
  let adapterInvocations = 0;
  let lease: ExecutionSubmissionLease | undefined;
  let submission: ExecutionSubmissionInput | undefined;
  try {
    if (!isAdoptedExecutionCompilationBundle(input.bundle)) {
      return { ok: false, error: "submission requires an adopted execution compilation bundle", adapter_invocations: 0 };
    }
    const adopted = input.bundle as ExecutionCompilationBundle;
    lease = createExecutionSubmissionLease(adopted, input.binding);
    // Consume only immediately before effect. Burns lease even on later failure.
    submission = consumeExecutionSubmissionLease(lease, input.binding);
    lease = undefined;
    if (!submission) {
      return { ok: false, error: "submission lease did not yield same-FD input", adapter_invocations: 0 };
    }
    adapterInvocations += 1;
    input.hooks?.onAdapterInvoke?.();
    // Same-FD input must reach the adapter/transport — never voided.
    const result = await input.hooks?.submitEffect?.(submission);
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "submission authority failed",
      adapter_invocations: adapterInvocations
    };
  } finally {
    if (submission) {
      try {
        releaseExecutionSubmissionInput(submission);
      } catch {
        // release is best-effort after failure; double-release is rejected by T05
      }
    }
  }
}

/**
 * Reject raw/fake/structural JSON that was never adopted through T05.
 * Guarantees adapter invocation remains 0.
 */
export function rejectFakeExecutionAuthority(value: unknown): never {
  if (isAdoptedExecutionCompilationBundle(value)) {
    throw pcError("PC_GENERATION_BINDING_INVALID", "adopted bundle cannot be rejected as fake");
  }
  throw pcError("PC_GENERATION_BINDING_INVALID", "raw or fake compilation is not execution authority");
}

export function assertActiveBindingRequired(
  mode: "disabled" | "shadow" | "active",
  binding: GenerationJobProductionBinding | GenerationJobApprovalBinding | undefined
): void {
  if (mode === "active" && !binding) {
    throw pcError("PC_GENERATION_BINDING_INVALID", "active mode requires generation job production binding");
  }
}

/**
 * Active approve/submit require a full GenerationJobApprovalBindingV1.
 * Recomputes immutable identity; rejects length-only / partial shells.
 */
export function assertFullApprovalBindingForActive(
  mode: "disabled" | "shadow" | "active" | undefined,
  binding: unknown
): GenerationJobApprovalBinding | undefined {
  if (mode === undefined) {
    throw pcError("PC_MODE_INACTIVE", "unresolved production control mode at generation effect boundary");
  }
  if (mode !== "active") return undefined;
  if (!binding || typeof binding !== "object") {
    throw pcError(
      "PC_GENERATION_BINDING_INVALID",
      "active mode requires full generation job production binding"
    );
  }
  return parseGenerationJobApprovalBinding(binding);
}

export function assertBindingMatchesGateBundle(
  binding: GenerationJobApprovalBinding,
  bundle: GateBundle
): void {
  assertGateBundleExecutable(bundle);
  if (binding.gate_bundle_digest !== bundle.digest) {
    throw pcError("PC_GENERATION_BINDING_INVALID", "approval binding gate bundle digest mismatch");
  }
  if (binding.production_id !== bundle.production_id || binding.run_id !== bundle.run_id) {
    throw pcError("PC_GENERATION_BINDING_INVALID", "approval binding production/run mismatch");
  }
  // Require route + pricing + Gate1-approved unit membership in the approved GateBundle.
  assertBindingMembershipInGateBundle(binding, bundle);
}

/**
 * Route, pricing binding, and base compilation must appear in an approved batch unit.
 * Membership is exact (digest equality), not presence-only.
 */
export function assertBindingMembershipInGateBundle(
  binding: GenerationJobApprovalBinding,
  bundle: GateBundle
): void {
  const matchingBatches = bundle.generation_batches.filter((batch) =>
    batch.route.route_digest === binding.route.route_digest
    && batch.pricing_binding_digest === binding.pricing_binding_digest
  );
  if (matchingBatches.length === 0) {
    throw pcError(
      "PC_GENERATION_BINDING_INVALID",
      "approval binding route/pricing is not a member of the approved GateBundle"
    );
  }
  const unitMatch = matchingBatches.some((batch) =>
    batch.ordered_units.some((unit) =>
      unit.base_compilation_digest === binding.compilation_digest
      && unit.route_digest === binding.route.route_digest
    )
  );
  if (!unitMatch) {
    throw pcError(
      "PC_GENERATION_BINDING_INVALID",
      "approval binding compilation is not a member of the approved GateBundle units"
    );
  }
}

export function parseGenerationJobApprovalBinding(input: unknown): GenerationJobApprovalBinding {
  return generationJobApprovalBindingSchema.parse(input);
}

export function parseGenerationCompletionRef(input: unknown): GenerationCompletionRef {
  return generationCompletionRefSchema.parse(input);
}
