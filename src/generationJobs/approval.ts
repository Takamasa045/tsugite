/**
 * Cost-approval digests bind request, model profile, connection capability, and pricing.
 * Unknown price / digest mismatch / cap exceeded → fail-closed before submit.
 */

import { sha256Canonical } from "../integrity/canonical.js";
import {
  GJ_APPROVAL_DIGEST_MISMATCH,
  GJ_APPROVAL_MISSING,
  GJ_PRICE_CAP_EXCEEDED,
  GJ_PRICE_UNKNOWN,
  GenerationJobError
} from "./errors.js";
import type {
  GenerationJobApproval,
  GenerationJobPricing,
  GenerationJobRecord,
  GenerationJobRequest
} from "./schema.js";

export type ApprovalDigestInput = {
  request_digest: string;
  model_profile_digest: string;
  connection_capability_digest: string;
  pricing_version: string | null;
  pricing_currency: string | null;
  pricing_max_amount: number | null;
  pricing_status: GenerationJobPricing["status"];
  pricing_amount: number | null;
};

/**
 * Canonical request digest from content fields only.
 * Caller-supplied opaque digests are not trusted unless they match this.
 */
export function computeRequestDigest(
  request: Pick<
    GenerationJobRequest,
    "model_id" | "mode" | "connection_id" | "auth_env_names" | "asset_paths" | "params"
  >
): string {
  return sha256Canonical({
    kind: "generation-job-request",
    schema_version: 1,
    model_id: request.model_id,
    mode: request.mode,
    connection_id: request.connection_id,
    auth_env_names: request.auth_env_names ?? [],
    asset_paths: request.asset_paths ?? [],
    params: request.params ?? {}
  });
}

export function assertRequestDigestMatches(request: GenerationJobRequest): void {
  const expected = computeRequestDigest(request);
  if (request.digest !== expected) {
    throw new GenerationJobError(
      GJ_APPROVAL_DIGEST_MISMATCH,
      "request digest does not match canonical model/mode/connection/auth/assets/params content"
    );
  }
}

export function buildApprovalDigestInput(
  job: Pick<
    GenerationJobRecord,
    | "request"
    | "model_profile_digest"
    | "connection_capability_digest"
    | "pricing"
  >
): ApprovalDigestInput {
  // Always recompute request digest from content; do not trust stored opaque digest alone.
  const request_digest = computeRequestDigest(job.request);
  return {
    request_digest,
    model_profile_digest: job.model_profile_digest,
    connection_capability_digest: job.connection_capability_digest,
    pricing_version: job.pricing.version,
    pricing_currency: job.pricing.currency,
    pricing_max_amount: job.pricing.max_amount,
    pricing_status: job.pricing.status,
    pricing_amount: job.pricing.amount
  };
}

export function approvalDigest(input: ApprovalDigestInput): string {
  return sha256Canonical({
    kind: "generation-job-cost-approval",
    schema_version: 1,
    request_digest: input.request_digest,
    model_profile_digest: input.model_profile_digest,
    connection_capability_digest: input.connection_capability_digest,
    pricing_version: input.pricing_version,
    pricing_currency: input.pricing_currency,
    pricing_max_amount: input.pricing_max_amount,
    pricing_status: input.pricing_status,
    pricing_amount: input.pricing_amount
  });
}

export function createApproval(
  job: Pick<
    GenerationJobRecord,
    | "request"
    | "model_profile_digest"
    | "connection_capability_digest"
    | "pricing"
  >,
  actor: string,
  approvedAt = new Date().toISOString()
): GenerationJobApproval {
  assertPriceKnownForApproval(job.pricing);
  assertAmountWithinCap(job.pricing);
  assertRequestDigestMatches(job.request);
  const input = buildApprovalDigestInput(job);
  return {
    approved_at: approvedAt,
    actor,
    digest: approvalDigest(input),
    request_digest: input.request_digest,
    model_profile_digest: input.model_profile_digest,
    connection_capability_digest: input.connection_capability_digest,
    pricing_version: input.pricing_version,
    pricing_currency: input.pricing_currency,
    pricing_max_amount: input.pricing_max_amount
  };
}

export function assertPriceKnownForApproval(pricing: GenerationJobPricing): void {
  if (pricing.status === "unknown") {
    throw new GenerationJobError(
      GJ_PRICE_UNKNOWN,
      "cannot approve or submit generation job while pricing_status is unknown"
    );
  }
  if (pricing.status === "known") {
    if (pricing.version === null || pricing.currency === null || pricing.amount === null) {
      throw new GenerationJobError(
        GJ_PRICE_UNKNOWN,
        "known pricing requires version, currency, and amount"
      );
    }
    if (pricing.max_amount === null) {
      throw new GenerationJobError(
        GJ_PRICE_UNKNOWN,
        "known pricing requires pricing_max_amount for approval binding"
      );
    }
  }
}

/** Fail-closed at approve time (and again at submit). */
export function assertAmountWithinCap(pricing: GenerationJobPricing): void {
  if (pricing.status === "known") {
    const amount = pricing.amount;
    const max = pricing.max_amount;
    if (amount != null && max != null && amount > max) {
      throw new GenerationJobError(
        GJ_PRICE_CAP_EXCEEDED,
        `pricing amount ${amount} exceeds approved max_amount ${max}`
      );
    }
  }
}

/**
 * Fail-closed pre-submit checks: approval present, digests match current job,
 * price known, amount within max cap.
 */
export function assertApprovalAllowsSubmit(job: GenerationJobRecord): void {
  if (!job.approval) {
    throw new GenerationJobError(
      GJ_APPROVAL_MISSING,
      "generation job has no cost approval"
    );
  }

  assertPriceKnownForApproval(job.pricing);
  assertAmountWithinCap(job.pricing);
  assertRequestDigestMatches(job.request);

  const expected = approvalDigest(buildApprovalDigestInput(job));
  if (job.approval.digest !== expected) {
    throw new GenerationJobError(
      GJ_APPROVAL_DIGEST_MISMATCH,
      "approval digest does not match current request/profile/connection/pricing"
    );
  }

  const contentDigest = computeRequestDigest(job.request);
  // Bound fields must still match approval snapshot (defense in depth).
  if (
    job.approval.request_digest !== contentDigest
    || job.request.digest !== contentDigest
    || job.approval.model_profile_digest !== job.model_profile_digest
    || job.approval.connection_capability_digest !== job.connection_capability_digest
    || job.approval.pricing_version !== job.pricing.version
    || job.approval.pricing_currency !== job.pricing.currency
    || job.approval.pricing_max_amount !== job.pricing.max_amount
  ) {
    throw new GenerationJobError(
      GJ_APPROVAL_DIGEST_MISMATCH,
      "approval bound fields no longer match job record"
    );
  }
}

/**
 * Active production mode requires the optional production_binding.
 * Disabled/shadow/legacy jobs without the binding remain submit-eligible via
 * the existing approval digest checks alone.
 */
export function assertProductionBindingForMode(
  job: GenerationJobRecord,
  mode: "disabled" | "shadow" | "active" | undefined
): void {
  if (mode !== "active") return;
  if (!job.production_binding) {
    throw new GenerationJobError(
      GJ_APPROVAL_MISSING,
      "active production mode requires generation job production_binding"
    );
  }
  if (
    job.production_binding.production_id.length < 1
    || job.production_binding.immutable_identity_digest.length !== 64
    || job.production_binding.gate_bundle_digest.length !== 64
  ) {
    throw new GenerationJobError(
      GJ_APPROVAL_DIGEST_MISMATCH,
      "production_binding digests are incomplete"
    );
  }
}
