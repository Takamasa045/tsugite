/**
 * Provider-neutral durable async generation job schema.
 * No provider-specific names, endpoints, or credentials.
 */

import { z } from "zod";

export const GENERATION_JOB_SCHEMA_VERSION = 1 as const;

export const GENERATION_JOB_STATUSES = [
  "planned",
  "awaiting_cost_approval",
  "approved",
  "submitting",
  "submitted",
  "polling",
  "succeeded",
  "downloading",
  "verified",
  "pinned",
  "cancel_requested",
  "cancelled",
  "retry_wait",
  "blocked",
  "failed",
  "submission_unknown"
] as const;

export type GenerationJobStatus = (typeof GENERATION_JOB_STATUSES)[number];

const safeId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a safe id");

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

const isoDate = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value,
  "must be an ISO 8601 UTC timestamp"
);

/** Environment variable *names* only — never secret values. */
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

export const generationJobPricingSchema = z
  .object({
    status: z.enum(["known", "unknown", "not-applicable"]),
    version: z.string().min(1).max(128).nullable().default(null),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable()
      .default(null),
    /** Estimated or quoted amount in minor-unit-agnostic decimal number. */
    amount: z.number().nonnegative().nullable().default(null),
    /** Max amount the approver authorized (same currency). */
    max_amount: z.number().nonnegative().nullable().default(null)
  })
  .strict();

export const generationJobApprovalSchema = z
  .object({
    approved_at: isoDate,
    actor: z.string().min(1).max(128),
    /**
     * Digest binding request + model profile + connection capability + pricing.
     * Submit must recompute and match fail-closed.
     */
    digest: sha256Hex,
    request_digest: sha256Hex,
    model_profile_digest: sha256Hex,
    connection_capability_digest: sha256Hex,
    pricing_version: z.string().min(1).max(128).nullable(),
    pricing_currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    pricing_max_amount: z.number().nonnegative().nullable()
  })
  .strict();

export const generationJobArtifactSchema = z
  .object({
    /** Relative path under the job root (never absolute provider URL as sole pin). */
    relative_path: z.string().min(1).max(512),
    sha256: sha256Hex,
    byte_length: z.number().int().nonnegative(),
    content_type: z.string().min(1).max(128).optional(),
    pinned: z.boolean()
  })
  .strict();

export const generationJobErrorSchema = z
  .object({
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(2_000),
    retryable: z.boolean().default(false)
  })
  .strict();

/** Durable error body on a job record (not the thrown Error class). */
export type GenerationJobErrorBody = z.infer<typeof generationJobErrorSchema>;

export const generationJobRequestSchema = z
  .object({
    /** Opaque request body digest (canonical SHA-256 of request payload without secrets). */
    digest: sha256Hex,
    model_id: safeId,
    mode: z.string().min(1).max(64),
    connection_id: safeId,
    /** Auth env *names* declared for this request — never values. */
    auth_env_names: z.array(envName).default([]),
    /** Optional local asset relative paths (already pinned by caller). */
    asset_paths: z.array(z.string().min(1).max(512)).default([]),
    /** Non-secret request params (prompt text, duration, aspect, etc.). */
    params: z.record(z.string(), z.unknown()).default({})
  })
  .strict();

export const generationJobRecordSchema = z
  .object({
    schema_version: z.literal(GENERATION_JOB_SCHEMA_VERSION),
    job_id: safeId,
    status: z.enum(GENERATION_JOB_STATUSES),
    connection_id: safeId,
    adapter_id: safeId.optional(),
    model_id: safeId,
    mode: z.string().min(1).max(64),
    request: generationJobRequestSchema,
    model_profile_digest: sha256Hex,
    connection_capability_digest: sha256Hex,
    pricing: generationJobPricingSchema,
    approval: generationJobApprovalSchema.optional(),
    /** Provider-side job id once known. Resume poll/download requires this. */
    provider_job_id: z.string().min(1).max(256).optional(),
    /** Number of successful *acceptance* submits (increments only on confirmed accept). */
    submit_attempts: z.number().int().nonnegative().default(0),
    /** True after a submit where acceptance is possible but unconfirmed. Blocks resubmit. */
    submission_unknown: z.boolean().default(false),
    artifact: generationJobArtifactSchema.optional(),
    error: generationJobErrorSchema.optional(),
    cancel_requested: z.boolean().default(false),
    created_at: isoDate,
    updated_at: isoDate,
    identity_token: z.string().min(1).max(128).optional()
  })
  .strict();

export type GenerationJobPricing = z.infer<typeof generationJobPricingSchema>;
export type GenerationJobApproval = z.infer<typeof generationJobApprovalSchema>;
export type GenerationJobArtifact = z.infer<typeof generationJobArtifactSchema>;
export type GenerationJobRequest = z.infer<typeof generationJobRequestSchema>;
export type GenerationJobRecord = z.infer<typeof generationJobRecordSchema>;

export function parseGenerationJobRecord(raw: unknown): GenerationJobRecord {
  return generationJobRecordSchema.parse(raw);
}

export function safeParseGenerationJobRecord(raw: unknown) {
  return generationJobRecordSchema.safeParse(raw);
}
