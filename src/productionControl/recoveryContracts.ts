/**
 * PO-6 recovery authorization contracts — strict canonical schemas.
 * Local permit (no credits) vs paid regeneration policy/grant/attempt authorization.
 * Digests exclude issued_at/expires_at (canonical OMIT list); expiry is runtime-checked.
 */
import { z } from "zod";
import { assertSafeJsonValue, sha256Canonical, withoutField } from "./canonical.js";
import { pcError } from "./errors.js";
import { routeIdentitySchema, type RouteIdentity } from "./programBinding.js";
import {
  digestRefSchema,
  digestSchema,
  humanDecisionRefSchema,
  safeIdSchema,
  type DigestRef,
  type HumanDecisionRef
} from "./schema.js";

const nonNegativeInt = z.number().int().nonnegative();
const finiteNonNeg = z.number().refine((n) => Number.isFinite(n) && n >= 0, "non-negative finite");
const isoDateSchema = z.string().datetime({ offset: true });
const positiveInt = z.number().int().positive();

export const LOCAL_RECOVERY_ACTIONS = [
  "rerun-pure-task",
  "revalidate",
  "rebuild-same-input-artifact",
  "resume-known-job-poll",
  "retry-verified-download"
] as const;
export type LocalRecoveryAction = (typeof LOCAL_RECOVERY_ACTIONS)[number];

/** Exported schema version for RC revision bindings. */
export const RECOVERY_POLICY_SCHEMA_VERSION = 1 as const;

const knownJobSchema = z
  .object({
    generation_job_id: safeIdSchema,
    provider_job_id: z.string().min(1).max(256),
    connection_id: safeIdSchema,
    connection_digest: digestSchema
  })
  .strict();

export const localRecoveryPermitSchema = z
  .object({
    schema_version: z.literal(1),
    permit_id: safeIdSchema,
    production_id: safeIdSchema,
    tree_revision: nonNegativeInt,
    node_id: safeIdSchema,
    task_revision: nonNegativeInt,
    input_digest: digestSchema,
    action: z.enum(LOCAL_RECOVERY_ACTIONS),
    known_job: knownJobSchema.optional(),
    issued_by: z.literal("coordinator"),
    issued_at: isoDateSchema,
    expires_at: isoDateSchema,
    max_attempts: positiveInt,
    max_new_submissions: z.literal(0),
    max_new_credits: z.literal(0),
    digest: digestSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.action === "resume-known-job-poll" || value.action === "retry-verified-download")
      && !value.known_job
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["known_job"],
        message: "poll/download permit requires known_job"
      });
    }
    if (value.known_job && value.action !== "resume-known-job-poll" && value.action !== "retry-verified-download") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["known_job"],
        message: "known_job is only valid for poll/download actions"
      });
    }
    if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["digest"],
        message: "local recovery permit digest mismatch"
      });
    }
  });
export type LocalRecoveryPermit = z.infer<typeof localRecoveryPermitSchema>;
export type LocalRecoveryPermitV1 = LocalRecoveryPermit;

const baseCompilationBindingSchema = z
  .object({
    node_id: safeIdSchema,
    compilation_digest: digestSchema
  })
  .strict();

const parameterRangeSchema = z
  .object({
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    values: z.array(z.string().min(1).max(256)).max(64).optional()
  })
  .strict()
  .superRefine((range, context) => {
    if (range.min !== undefined && range.max !== undefined && range.min > range.max) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "parameter range min must be <= max"
      });
    }
  });

export const regenerationPolicyExecutionContextSchema = z
  .object({
    production_contract_digest: digestSchema,
    contract_set_digest: digestSchema,
    task_tree_digest: digestSchema,
    task_scope: z.array(safeIdSchema).min(1).max(256),
    base_compilations: z.array(baseCompilationBindingSchema).min(1).max(256),
    route: routeIdentitySchema,
    pricing_binding_digest: digestSchema
  })
  .strict()
  .superRefine((ctx, context) => {
    if (new Set(ctx.task_scope).size !== ctx.task_scope.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["task_scope"],
        message: "task_scope ids must be unique"
      });
    }
    const nodeIds = ctx.base_compilations.map((entry) => entry.node_id);
    if (new Set(nodeIds).size !== nodeIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["base_compilations"],
        message: "base_compilations node ids must be unique"
      });
    }
  });
export type RegenerationPolicyExecutionContext = z.infer<typeof regenerationPolicyExecutionContextSchema>;

export const regenerationPolicySpecSchema = z
  .object({
    schema_version: z.literal(1),
    policy_spec_id: safeIdSchema,
    execution_context: regenerationPolicyExecutionContextSchema,
    allowed_error_codes: z.array(safeIdSchema).min(1).max(256),
    allowed_prompt_block_ids: z.array(safeIdSchema).max(64),
    allowed_parameter_ranges: z.record(safeIdSchema, parameterRangeSchema).default({}),
    max_changed_prompt_blocks_per_attempt: z.literal(1),
    max_attempts_per_task: positiveInt,
    max_total_new_submissions: positiveInt,
    max_incremental_credits: finiteNonNeg,
    expires_at: isoDateSchema,
    digest: digestSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.allowed_error_codes).size !== value.allowed_error_codes.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowed_error_codes"],
        message: "allowed_error_codes must be unique"
      });
    }
    if (new Set(value.allowed_prompt_block_ids).size !== value.allowed_prompt_block_ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowed_prompt_block_ids"],
        message: "allowed_prompt_block_ids must be unique"
      });
    }
    if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["digest"],
        message: "regeneration policy spec digest mismatch"
      });
    }
  });
export type RegenerationPolicySpec = z.infer<typeof regenerationPolicySpecSchema>;
export type RegenerationPolicySpecV1 = RegenerationPolicySpec;

export const regenerationGrantSchema = z
  .object({
    schema_version: z.literal(1),
    grant_id: safeIdSchema,
    policy_spec_digest: digestSchema,
    gate_bundle_digest: digestSchema,
    gate_1_decision: humanDecisionRefSchema,
    execution_context_digest: digestSchema,
    issued_at: isoDateSchema,
    expires_at: isoDateSchema,
    digest: digestSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["digest"],
        message: "regeneration grant digest mismatch"
      });
    }
  });
export type RegenerationGrant = z.infer<typeof regenerationGrantSchema>;
export type RegenerationGrantV1 = RegenerationGrant;

export const regenerationAttemptAuthorizationSchema = z
  .object({
    schema_version: z.literal(1),
    grant_digest: digestSchema,
    node_id: safeIdSchema,
    ordinal: nonNegativeInt,
    attempt_key: digestSchema,
    trigger_failure_ref: digestRefSchema,
    observed_error_code: safeIdSchema,
    base_compilation_digest: digestSchema,
    patch_artifact_digest: digestSchema,
    changed_prompt_block_id: safeIdSchema.optional(),
    parameter_changes: z.record(safeIdSchema, z.unknown()).default({}),
    derived_compilation_digest: digestSchema,
    pricing_binding_digest: digestSchema,
    credit_ledger_reservation_id: safeIdSchema,
    credit_ledger_reservation_digest: digestSchema,
    digest: digestSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["digest"],
        message: "regeneration attempt authorization digest mismatch"
      });
    }
    if (value.derived_compilation_digest === value.base_compilation_digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["derived_compilation_digest"],
        message: "derived compilation must differ from base compilation"
      });
    }
  });
export type RegenerationAttemptAuthorization = z.infer<typeof regenerationAttemptAuthorizationSchema>;
export type RegenerationAttemptAuthorizationV1 = RegenerationAttemptAuthorization;

export function executionContextDigest(
  context: RegenerationPolicyExecutionContext
): string {
  return sha256Canonical({
    kind: "regeneration-policy-execution-context",
    schema_version: 1,
    ...regenerationPolicyExecutionContextSchema.parse(context)
  });
}

export function createLocalRecoveryPermit(input: {
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
}): LocalRecoveryPermit {
  const candidate = {
    schema_version: 1 as const,
    permit_id: input.permit_id,
    production_id: input.production_id,
    tree_revision: input.tree_revision,
    node_id: input.node_id,
    task_revision: input.task_revision,
    input_digest: input.input_digest,
    action: input.action,
    ...(input.known_job ? { known_job: input.known_job } : {}),
    issued_by: "coordinator" as const,
    issued_at: input.issued_at,
    expires_at: input.expires_at,
    max_attempts: input.max_attempts,
    max_new_submissions: 0 as const,
    max_new_credits: 0 as const
  };
  assertSafeJsonValue(candidate, "local recovery permit");
  return localRecoveryPermitSchema.parse({
    ...candidate,
    digest: sha256Canonical(candidate)
  });
}

export function parseLocalRecoveryPermit(input: unknown): LocalRecoveryPermit {
  return localRecoveryPermitSchema.parse(input);
}

export function createRegenerationPolicySpec(input: {
  policy_spec_id: string;
  execution_context: RegenerationPolicyExecutionContext;
  allowed_error_codes: string[];
  allowed_prompt_block_ids?: string[];
  allowed_parameter_ranges?: RegenerationPolicySpec["allowed_parameter_ranges"];
  max_attempts_per_task: number;
  max_total_new_submissions: number;
  max_incremental_credits: number;
  expires_at: string;
}): RegenerationPolicySpec {
  const candidate = {
    schema_version: 1 as const,
    policy_spec_id: input.policy_spec_id,
    execution_context: regenerationPolicyExecutionContextSchema.parse(input.execution_context),
    allowed_error_codes: [...input.allowed_error_codes],
    allowed_prompt_block_ids: [...(input.allowed_prompt_block_ids ?? [])],
    allowed_parameter_ranges: input.allowed_parameter_ranges ?? {},
    max_changed_prompt_blocks_per_attempt: 1 as const,
    max_attempts_per_task: input.max_attempts_per_task,
    max_total_new_submissions: input.max_total_new_submissions,
    max_incremental_credits: input.max_incremental_credits,
    expires_at: input.expires_at
  };
  assertSafeJsonValue(candidate, "regeneration policy spec");
  return regenerationPolicySpecSchema.parse({
    ...candidate,
    digest: sha256Canonical(candidate)
  });
}

export function parseRegenerationPolicySpec(input: unknown): RegenerationPolicySpec {
  return regenerationPolicySpecSchema.parse(input);
}

export function createRegenerationGrant(input: {
  grant_id: string;
  policy: RegenerationPolicySpec;
  gate_bundle_digest: string;
  gate_1_decision: HumanDecisionRef;
  issued_at: string;
  expires_at?: string;
}): RegenerationGrant {
  const policy = parseRegenerationPolicySpec(input.policy);
  const decision = humanDecisionRefSchema.parse(input.gate_1_decision);
  const contextDigest = executionContextDigest(policy.execution_context);
  const expiresAt = input.expires_at ?? policy.expires_at;
  const candidate = {
    schema_version: 1 as const,
    grant_id: input.grant_id,
    policy_spec_digest: policy.digest,
    gate_bundle_digest: input.gate_bundle_digest,
    gate_1_decision: decision,
    execution_context_digest: contextDigest,
    issued_at: input.issued_at,
    expires_at: expiresAt
  };
  assertSafeJsonValue(candidate, "regeneration grant");
  return regenerationGrantSchema.parse({
    ...candidate,
    digest: sha256Canonical(candidate)
  });
}

export function parseRegenerationGrant(input: unknown): RegenerationGrant {
  return regenerationGrantSchema.parse(input);
}

export function createRegenerationAttemptAuthorization(input: {
  grant: RegenerationGrant;
  node_id: string;
  ordinal: number;
  attempt_key: string;
  trigger_failure_ref: DigestRef;
  observed_error_code: string;
  base_compilation_digest: string;
  patch_artifact_digest: string;
  changed_prompt_block_id?: string;
  parameter_changes?: Record<string, unknown>;
  derived_compilation_digest: string;
  pricing_binding_digest: string;
  credit_ledger_reservation_id: string;
  credit_ledger_reservation_digest: string;
}): RegenerationAttemptAuthorization {
  const grant = parseRegenerationGrant(input.grant);
  const candidate = {
    schema_version: 1 as const,
    grant_digest: grant.digest,
    node_id: input.node_id,
    ordinal: input.ordinal,
    attempt_key: input.attempt_key,
    trigger_failure_ref: digestRefSchema.parse(input.trigger_failure_ref),
    observed_error_code: input.observed_error_code,
    base_compilation_digest: input.base_compilation_digest,
    patch_artifact_digest: input.patch_artifact_digest,
    ...(input.changed_prompt_block_id
      ? { changed_prompt_block_id: input.changed_prompt_block_id }
      : {}),
    parameter_changes: input.parameter_changes ?? {},
    derived_compilation_digest: input.derived_compilation_digest,
    pricing_binding_digest: input.pricing_binding_digest,
    credit_ledger_reservation_id: input.credit_ledger_reservation_id,
    credit_ledger_reservation_digest: input.credit_ledger_reservation_digest
  };
  assertSafeJsonValue(candidate, "regeneration attempt authorization");
  return regenerationAttemptAuthorizationSchema.parse({
    ...candidate,
    digest: sha256Canonical(candidate)
  });
}

export function parseRegenerationAttemptAuthorization(
  input: unknown
): RegenerationAttemptAuthorization {
  return regenerationAttemptAuthorizationSchema.parse(input);
}

export function assertNotExpired(expiresAt: string, now: Date, code: "PC_GRANT_EXPIRED" | "PC_PERMIT_INVALID" | "PC_POLICY_MISMATCH"): void {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) {
    throw pcError(code, "expiry timestamp is invalid");
  }
  if (now.getTime() > expiry) {
    throw pcError(code, "authorization or permit has expired");
  }
}

export type RouteBinding = RouteIdentity;
