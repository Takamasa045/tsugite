/**
 * Normalized generation-job error codes (provider-neutral).
 */

export class GenerationJobError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "GenerationJobError";
    this.code = code;
    this.retryable = retryable;
  }
}

export const GJ_INVALID_TRANSITION = "GJ-E001";
export const GJ_SCHEMA_INVALID = "GJ-E002";
export const GJ_LOCK_HELD = "GJ-E003";
export const GJ_IDENTITY_MISMATCH = "GJ-E004";
export const GJ_APPROVAL_MISSING = "GJ-E005";
export const GJ_APPROVAL_DIGEST_MISMATCH = "GJ-E006";
export const GJ_PRICE_UNKNOWN = "GJ-E007";
export const GJ_PRICE_CAP_EXCEEDED = "GJ-E008";
export const GJ_SUBMISSION_UNKNOWN = "GJ-E009";
export const GJ_RESUBMIT_FORBIDDEN = "GJ-E010";
export const GJ_CANCEL_UNSUPPORTED = "GJ-E011";
export const GJ_CANCEL_NOT_ALLOWED = "GJ-E012";
export const GJ_ADAPTER_MISSING = "GJ-E013";
export const GJ_CATALOG_NOT_ADAPTER = "GJ-E014";
export const GJ_ROUTE_UNSUPPORTED = "GJ-E015";
export const GJ_MODE_UNSUPPORTED = "GJ-E016";
export const GJ_HASH_MISMATCH = "GJ-E017";
export const GJ_DOWNLOAD_OVERSIZE = "GJ-E018";
export const GJ_PATH_UNSAFE = "GJ-E019";
export const GJ_DOWNLOAD_REJECTED = "GJ-E020";
export const GJ_POLL_REQUIRED = "GJ-E021";
export const GJ_PROVIDER_JOB_MISSING = "GJ-E022";
export const GJ_NOT_PINNED = "GJ-E023";
export const GJ_BLOCKED = "GJ-E024";
export const GJ_PREFLIGHT_ONLY = "GJ-E025";
export const GJ_SECRET_LEAK = "GJ-E026";
/** Submit refused because durable status is not exactly approved (fail-closed). */
export const GJ_SUBMIT_NOT_ALLOWED = "GJ-E027";
/** Poll or download attempt budget exhausted (nonretryable; no further adapter calls). */
export const GJ_RETRY_EXHAUSTED = "GJ-E028";
