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
  GenerationJobRecord
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

export function buildApprovalDigestInput(
  job: Pick<
    GenerationJobRecord,
    | "request"
    | "model_profile_digest"
    | "connection_capability_digest"
    | "pricing"
  >
): ApprovalDigestInput {
  return {
    request_digest: job.request.digest,
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

  if (job.pricing.status === "known") {
    const amount = job.pricing.amount!;
    const max = job.pricing.max_amount!;
    if (amount > max) {
      throw new GenerationJobError(
        GJ_PRICE_CAP_EXCEEDED,
        `pricing amount ${amount} exceeds approved max_amount ${max}`
      );
    }
  }

  const expected = approvalDigest(buildApprovalDigestInput(job));
  if (job.approval.digest !== expected) {
    throw new GenerationJobError(
      GJ_APPROVAL_DIGEST_MISMATCH,
      "approval digest does not match current request/profile/connection/pricing"
    );
  }

  // Bound fields must still match approval snapshot (defense in depth).
  if (
    job.approval.request_digest !== job.request.digest
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
