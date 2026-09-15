/**
 * Neutral authoring-engine run records.
 * Adapter-specific names stay out of this module. Paid execution stays fail-closed.
 */
import { z } from "zod";
import { sha256Canonical, withoutField } from "./canonical.js";
import { pcError } from "./errors.js";
import {
  digestSchema,
  humanDecisionRefSchema,
  safeIdSchema,
  type HumanDecisionRef
} from "./schema.js";

const isoDateSchema = z.string().datetime({ offset: true });
const nonNegativeInt = z.number().int().nonnegative();

export const AUTHORING_ENGINE_SCHEMA_VERSION = 1 as const;
export const AUTHORING_APPROVE_DECISIONS = ["approve-plan", "approve-local-render"] as const;
export const AUTHORING_REJECT_DECISIONS = ["reject", "abort"] as const;
export const AUTHORING_INTENT_STATUSES = ["pending", "consumed", "unknown"] as const;

export const authoringFileRefSchema = z.object({
  relative_path: z.string().min(1).max(500),
  sha256: digestSchema,
  bytes: nonNegativeInt
}).strict();
export type AuthoringFileRef = z.infer<typeof authoringFileRefSchema>;

export const authoringCostSchema = z.object({
  status: z.enum(["unknown", "local-only", "known"]),
  amount: z.number().finite().nonnegative().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  request_count: nonNegativeInt,
  notes: z.array(z.string().min(1).max(500)).max(32)
}).strict().superRefine((value, context) => {
  if (value.status !== "known" && value.amount !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["amount"],
      message: "non-known cost must keep amount null"
    });
  }
  if (value.status === "known" && (value.amount === null || value.currency === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "known cost requires amount and currency"
    });
  }
});
export type AuthoringCost = z.infer<typeof authoringCostSchema>;

export const authoringPlanBindingSchema = z.object({
  plan_output_digest: digestSchema,
  import_allowlist_digest: digestSchema,
  runtime_digest: digestSchema.nullable(),
  distribution_digest: digestSchema.nullable(),
  runtime_pointer_digest: digestSchema.nullable(),
  runtime_profile_digest: digestSchema.nullable(),
  package_manifest_digest: digestSchema.nullable(),
  source_files: z.array(authoringFileRefSchema).max(256),
  asset_files: z.array(authoringFileRefSchema).max(256)
}).strict();
export type AuthoringPlanBinding = z.infer<typeof authoringPlanBindingSchema>;

export const authoringExecutionBindingSchema = z.object({
  plan_digest: digestSchema,
  argv_digest: digestSchema,
  import_allowlist_digest: digestSchema,
  runtime_digest: digestSchema.nullable(),
  distribution_digest: digestSchema.nullable(),
  runtime_pointer_digest: digestSchema.nullable(),
  runtime_profile_digest: digestSchema.nullable(),
  package_manifest_digest: digestSchema.nullable(),
  source_files: z.array(authoringFileRefSchema).max(256),
  asset_files: z.array(authoringFileRefSchema).max(256)
}).strict();
export type AuthoringExecutionBinding = z.infer<typeof authoringExecutionBindingSchema>;

export const authoringSubmissionIntentSchema = z.object({
  schema_version: z.literal(1),
  production_id: safeIdSchema,
  plan_digest: digestSchema,
  approval_digest: digestSchema,
  argv_digest: digestSchema,
  execution_binding: authoringExecutionBindingSchema,
  status: z.enum(AUTHORING_INTENT_STATUSES),
  created_at: isoDateSchema,
  auto_resubmit: z.literal(false),
  // Optional and unset by default so legacy signed intents keep their original digest.
  attempt_identity: safeIdSchema.optional(),
  digest: digestSchema
}).strict().superRefine((value, context) => {
  if (sha256Canonical(intentCanonicalBody(value)) !== value.digest) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["digest"],
      message: "submission intent digest mismatch"
    });
  }
});
export type AuthoringSubmissionIntent = z.infer<typeof authoringSubmissionIntentSchema>;

export const authoringBuildRecordSchema = z.object({
  build_id: safeIdSchema.optional(),
  outcome: z.enum(["pending", "complete", "failed", "unknown", "blocked", "accepted"]),
  blocked_reason: z.string().min(1).max(2_000).optional()
}).strict().superRefine((value, context) => {
  if ((value.outcome === "pending" || value.outcome === "complete" || value.outcome === "accepted")
    && !value.build_id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["build_id"],
      message: "terminal/pending success requires a real build_id"
    });
  }
});
export type AuthoringBuildRecord = z.infer<typeof authoringBuildRecordSchema>;

export const authoringEngineRunSchema = z.object({
  schema_version: z.literal(AUTHORING_ENGINE_SCHEMA_VERSION),
  production_id: safeIdSchema,
  adapter_id: safeIdSchema,
  brief_digest: digestSchema,
  reference_digest: digestSchema.nullable(),
  source_files: z.array(authoringFileRefSchema).max(256),
  import_allowlist_digest: digestSchema,
  runtime_digest: digestSchema.nullable(),
  plan_binding: authoringPlanBindingSchema.nullable(),
  plan_digest: digestSchema.nullable(),
  cost: authoringCostSchema,
  approval: humanDecisionRefSchema.optional(),
  submission_intent: authoringSubmissionIntentSchema.optional(),
  intent_history: z.array(authoringSubmissionIntentSchema).max(64),
  build: authoringBuildRecordSchema.optional(),
  accepted_build_ids: z.array(safeIdSchema).max(64),
  revision_count: nonNegativeInt,
  digest: digestSchema
}).strict().superRefine((value, context) => {
  if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["digest"],
      message: "authoring engine run digest mismatch"
    });
  }
  if (value.plan_binding && value.plan_digest !== sha256Canonical(value.plan_binding)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["plan_digest"],
      message: "plan_digest must equal canonical plan_binding"
    });
  }
});
export type AuthoringEngineRun = z.infer<typeof authoringEngineRunSchema>;

export function unknownAuthoringCost(requestCount = 0, notes: string[] = ["cost unknown; not defaulted to zero"]): AuthoringCost {
  return {
    status: "unknown",
    amount: null,
    currency: null,
    request_count: requestCount,
    notes
  };
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)) as T;
}

function intentCanonicalBody(
  value: AuthoringSubmissionIntent | Omit<AuthoringSubmissionIntent, "digest">
): Record<string, unknown> {
  return omitUndefined(withoutField(value, "digest") as Record<string, unknown>);
}

function bindAttemptIdentity(run: AuthoringEngineRun): string {
  return `rev-${run.revision_count}`;
}

export function digestAuthoringRun(value: Omit<AuthoringEngineRun, "digest">): AuthoringEngineRun {
  const body = omitUndefined({
    ...value,
    plan_binding: value.plan_binding ?? null,
    intent_history: value.intent_history ?? []
  });
  const digest = sha256Canonical(body);
  return authoringEngineRunSchema.parse({ ...body, digest });
}

export function digestPlanBinding(binding: AuthoringPlanBinding): string {
  return sha256Canonical(authoringPlanBindingSchema.parse(binding));
}

export function createAuthoringEngineRun(input: {
  production_id: string;
  adapter_id: string;
  brief_digest: string;
  reference_digest?: string | null;
  import_allowlist_digest: string;
}): AuthoringEngineRun {
  return digestAuthoringRun({
    schema_version: AUTHORING_ENGINE_SCHEMA_VERSION,
    production_id: input.production_id,
    adapter_id: input.adapter_id,
    brief_digest: input.brief_digest,
    reference_digest: input.reference_digest ?? null,
    source_files: [],
    import_allowlist_digest: input.import_allowlist_digest,
    runtime_digest: null,
    plan_binding: null,
    plan_digest: null,
    cost: unknownAuthoringCost(),
    intent_history: [],
    accepted_build_ids: [],
    revision_count: 0
  });
}

export function bindAuthoringPlan(
  run: AuthoringEngineRun,
  input: {
    source_files: AuthoringFileRef[];
    asset_files?: AuthoringFileRef[];
    plan_output_digest: string;
    cost: AuthoringCost;
    runtime_digest?: string | null;
    distribution_digest?: string | null;
    runtime_pointer_digest?: string | null;
    runtime_profile_digest?: string | null;
    package_manifest_digest?: string | null;
    import_allowlist_digest?: string;
  }
): AuthoringEngineRun {
  const cost = authoringCostSchema.parse(input.cost);
  const plan_binding = authoringPlanBindingSchema.parse({
    plan_output_digest: input.plan_output_digest,
    import_allowlist_digest: input.import_allowlist_digest ?? run.import_allowlist_digest,
    runtime_digest: input.runtime_digest ?? null,
    distribution_digest: input.distribution_digest ?? input.runtime_digest ?? null,
    runtime_pointer_digest: input.runtime_pointer_digest ?? null,
    runtime_profile_digest: input.runtime_profile_digest ?? null,
    package_manifest_digest: input.package_manifest_digest ?? null,
    source_files: input.source_files,
    asset_files: input.asset_files ?? []
  });
  return digestAuthoringRun({
    ...resetApprovalOnly(run),
    source_files: input.source_files,
    import_allowlist_digest: plan_binding.import_allowlist_digest,
    runtime_digest: plan_binding.runtime_digest,
    plan_binding,
    plan_digest: digestPlanBinding(plan_binding),
    cost
  });
}

export function approveAuthoringPlan(
  run: AuthoringEngineRun,
  decision: HumanDecisionRef
): AuthoringEngineRun {
  if (!run.plan_digest || !run.plan_binding) throw pcError("PC_AUTHORITY_DENIED", "authoring plan is missing");
  if (decision.subject_digest !== run.plan_digest) {
    throw pcError("PC_AUTHORITY_DENIED", "approval subject_digest must equal plan_digest");
  }
  if ((AUTHORING_REJECT_DECISIONS as readonly string[]).includes(decision.decision)) {
    throw pcError("PC_AUTHORITY_DENIED", "reject/abort is not an approval");
  }
  if (!(AUTHORING_APPROVE_DECISIONS as readonly string[]).includes(decision.decision)) {
    throw pcError("PC_AUTHORITY_DENIED", "approval requires approve-plan or approve-local-render");
  }
  if (decision.decision === "approve-local-render" && run.cost.status !== "local-only") {
    throw pcError("PC_AUTHORITY_DENIED", "local render approval requires verified local-only plan");
  }
  if (decision.decision === "approve-plan" && run.cost.status === "known" && run.cost.amount === null) {
    throw pcError("PC_AUTHORITY_DENIED", "known cost requires amount");
  }
  return digestAuthoringRun({
    ...withoutDigest(run),
    approval: humanDecisionRefSchema.parse(decision)
  });
}

function planSlice(binding: AuthoringExecutionBinding | AuthoringPlanBinding) {
  return {
    import_allowlist_digest: binding.import_allowlist_digest,
    runtime_digest: binding.runtime_digest,
    distribution_digest: binding.distribution_digest ?? null,
    runtime_pointer_digest: binding.runtime_pointer_digest ?? null,
    runtime_profile_digest: binding.runtime_profile_digest ?? null,
    package_manifest_digest: binding.package_manifest_digest ?? null,
    source_files: binding.source_files,
    asset_files: binding.asset_files
  };
}

export function assertLiveMatchesPlanBinding(run: AuthoringEngineRun, live: AuthoringExecutionBinding): void {
  if (!run.plan_binding || !run.plan_digest) {
    throw pcError("PC_AUTHORITY_DENIED", "missing plan-time source/runtime/asset binding");
  }
  if (digestPlanBinding(run.plan_binding) !== run.plan_digest) {
    throw pcError("PC_AUTHORITY_DENIED", "stored plan_binding does not match plan_digest");
  }
  if (live.plan_digest !== run.plan_digest) {
    throw pcError("PC_AUTHORITY_DENIED", "live plan_digest does not match approved plan");
  }
  const expected = sha256Canonical(planSlice(run.plan_binding));
  const actual = sha256Canonical(planSlice(live));
  if (expected !== actual) {
    throw pcError("PC_AUTHORITY_DENIED", "live source/import/runtime/asset/plan binding drifted from approved plan");
  }
}

export function persistAuthoringSubmissionIntent(
  run: AuthoringEngineRun,
  input: { argv_digest: string; created_at: string; execution_binding: AuthoringExecutionBinding }
): AuthoringEngineRun {
  if (run.submission_intent) {
    throw pcError("PC_SUBMISSION_UNKNOWN", "pending, unknown, or consumed intent cannot spawn again");
  }
  if (!run.plan_digest || !run.approval || !run.plan_binding) {
    throw pcError("PC_AUTHORITY_DENIED", "submission intent requires approved plan");
  }
  const binding = authoringExecutionBindingSchema.parse(input.execution_binding);
  if (binding.plan_digest !== run.plan_digest || binding.argv_digest !== input.argv_digest) {
    throw pcError("PC_AUTHORITY_DENIED", "execution binding does not match current plan");
  }
  assertLiveMatchesPlanBinding(run, binding);
  const unsigned = intentCanonicalBody({
    schema_version: 1 as const,
    production_id: run.production_id,
    plan_digest: run.plan_digest,
    approval_digest: run.approval.subject_digest,
    argv_digest: input.argv_digest,
    execution_binding: binding,
    status: "pending" as const,
    created_at: input.created_at,
    auto_resubmit: false as const,
    attempt_identity: bindAttemptIdentity(run)
  });
  const intent = authoringSubmissionIntentSchema.parse({
    ...unsigned,
    digest: sha256Canonical(unsigned)
  });
  return digestAuthoringRun({
    ...withoutDigest(run),
    submission_intent: intent
  });
}

export function markAuthoringIntentUnknown(run: AuthoringEngineRun): AuthoringEngineRun {
  if (!run.submission_intent) throw pcError("PC_SUBMISSION_UNKNOWN", "no submission intent to mark unknown");
  return digestAuthoringRun({
    ...withoutDigest(run),
    submission_intent: signIntent({ ...run.submission_intent, status: "unknown" }),
    build: { outcome: "unknown" }
  });
}

export function recordAuthoringBuildOutcome(
  run: AuthoringEngineRun,
  build: AuthoringBuildRecord
): AuthoringEngineRun {
  if (!run.submission_intent && build.outcome !== "blocked") {
    throw pcError("PC_AUTHORITY_DENIED", "build outcome requires a persisted submission intent");
  }
  if (build.outcome === "complete" || build.outcome === "accepted" || build.outcome === "pending" || build.outcome === "failed" || build.outcome === "unknown") {
    if (!run.submission_intent) throw pcError("PC_AUTHORITY_DENIED", "spawned outcome requires intent");
  }
  const intentStatus = build.outcome === "unknown" ? "unknown" : "consumed";
  return digestAuthoringRun({
    ...withoutDigest(run),
    ...(run.submission_intent
      ? { submission_intent: signIntent({ ...run.submission_intent, status: intentStatus }) }
      : {}),
    build: authoringBuildRecordSchema.parse(build)
  });
}

export function acceptAuthoringBuild(run: AuthoringEngineRun, buildId: string): AuthoringEngineRun {
  if (run.build?.outcome !== "complete" || run.build.build_id !== buildId) {
    throw pcError("PC_AUTHORITY_DENIED", "human acceptance requires a completed real build_id");
  }
  const accepted = run.accepted_build_ids.includes(buildId)
    ? run.accepted_build_ids
    : [...run.accepted_build_ids, buildId];
  return digestAuthoringRun({
    ...withoutDigest(run),
    accepted_build_ids: accepted,
    build: { build_id: buildId, outcome: "accepted" }
  });
}

function isTerminalBuild(run: AuthoringEngineRun): boolean {
  const outcome = run.build?.outcome;
  return outcome === "complete" || outcome === "failed" || outcome === "accepted";
}

export function assertAuthoringRunIdle(run: AuthoringEngineRun | undefined, action: string): void {
  const intentStatus = run?.submission_intent?.status;
  if (intentStatus === "pending" || intentStatus === "unknown") {
    throw pcError(
      "PC_SUBMISSION_UNKNOWN",
      `${action} is blocked while submission intent is ${intentStatus}`
    );
  }
  const outcome = run?.build?.outcome;
  if (outcome === "pending" || outcome === "unknown") {
    throw pcError(
      "PC_SUBMISSION_UNKNOWN",
      `${action} is blocked while build outcome is ${outcome}`
    );
  }
}

export function invalidateAuthoringPlan(run: AuthoringEngineRun): AuthoringEngineRun {
  assertAuthoringRunIdle(run, "invalidate plan");
  if (run.submission_intent?.status === "consumed" && isTerminalBuild(run)) {
    throw pcError(
      "PC_AUTHORITY_DENIED",
      "terminal accepted or completed run must use revise"
    );
  }
  if (!run.plan_digest && !run.approval && !run.plan_binding) return run;
  return digestAuthoringRun({
    ...resetApprovalOnly(run),
    plan_binding: null,
    plan_digest: null,
    cost: unknownAuthoringCost(run.cost.request_count, ["instruction change invalidated approval and plan"])
  });
}

export function reviseAuthoringRun(
  run: AuthoringEngineRun,
  input: { reuse_accepted?: boolean } = {}
): AuthoringEngineRun {
  const current = run.submission_intent;
  const archive = Boolean(current && current.status === "consumed" && isTerminalBuild(run));
  const keepIntent = Boolean(current && !archive);
  const history = [...run.intent_history];
  if (archive && current) history.push(current);
  return digestAuthoringRun({
    ...resetApprovalOnly(run, { keepBuild: keepIntent }),
    plan_binding: null,
    plan_digest: null,
    cost: unknownAuthoringCost(run.cost.request_count, ["revision invalidated approval and plan"]),
    submission_intent: keepIntent ? current : undefined,
    intent_history: history,
    accepted_build_ids: input.reuse_accepted === false ? [] : run.accepted_build_ids,
    revision_count: run.revision_count + 1
  });
}

export function assertExecutionBinding(run: AuthoringEngineRun, live: AuthoringExecutionBinding): void {
  const intent = run.submission_intent;
  if (!intent) throw pcError("PC_AUTHORITY_DENIED", "missing persisted submission intent");
  assertLiveMatchesPlanBinding(run, live);
  const expected = sha256Canonical(intent.execution_binding);
  const actual = sha256Canonical(authoringExecutionBindingSchema.parse(live));
  if (expected !== actual) {
    throw pcError("PC_AUTHORITY_DENIED", "live source/runtime/asset/plan binding mismatch");
  }
}

/**
 * Authorization after a pending intent is already persisted.
 * Do not use the pre-intent gate here: that rejects any existing intent.
 */
export function assertPostIntentDispatch(
  run: AuthoringEngineRun,
  input: { confirmPaid?: boolean; confirmLocalRender?: boolean }
): void {
  const intent = run.submission_intent;
  if (!intent) throw pcError("PC_AUTHORITY_DENIED", "persisted submission intent is missing");
  if (intent.status !== "pending") {
    throw pcError("PC_SUBMISSION_UNKNOWN", "consumed or unknown intent cannot dispatch again");
  }
  if (input.confirmPaid === true) {
    if (!run.approval || run.approval.decision !== "approve-plan") {
      throw pcError("PC_AUTHORITY_DENIED", "paid build requires approve-plan");
    }
    if (run.cost.status !== "known" || run.cost.amount === null) {
      throw pcError("PC_AUTHORITY_DENIED", "paid build blocked: cost is not known");
    }
    return;
  }
  if (input.confirmLocalRender === true) {
    if (!run.approval || run.approval.decision !== "approve-local-render") {
      throw pcError("PC_AUTHORITY_DENIED", "local render requires approve-local-render");
    }
    if (run.cost.status !== "local-only") {
      throw pcError("PC_AUTHORITY_DENIED", "local render requires verified local-only plan");
    }
    return;
  }
  throw pcError("PC_AUTHORITY_DENIED", "build requires confirm_paid or confirm_local_render");
}

export function assertPaidBuildAllowed(run: AuthoringEngineRun, confirmPaid: boolean, live: AuthoringExecutionBinding): void {
  if (!confirmPaid) throw pcError("PC_AUTHORITY_DENIED", "paid build requires explicit confirm_paid");
  assertPostIntentDispatch(run, { confirmPaid: true });
  assertExecutionBinding(run, live);
}

export function assertLocalRenderAllowed(run: AuthoringEngineRun, confirmLocal: boolean, live: AuthoringExecutionBinding): void {
  if (!confirmLocal) throw pcError("PC_AUTHORITY_DENIED", "local render requires explicit human confirm_local_render");
  assertPostIntentDispatch(run, { confirmLocalRender: true });
  assertExecutionBinding(run, live);
}

export function assertSpawnableIntent(run: AuthoringEngineRun): void {
  const status = run.submission_intent?.status;
  if (status !== "pending") {
    throw pcError("PC_SUBMISSION_UNKNOWN", "consumed or unknown intent cannot dispatch again");
  }
}

function signIntent(intent: AuthoringSubmissionIntent): AuthoringSubmissionIntent {
  const unsigned = intentCanonicalBody(intent);
  return authoringSubmissionIntentSchema.parse({
    ...unsigned,
    digest: sha256Canonical(unsigned)
  });
}

function withoutDigest(run: AuthoringEngineRun): Omit<AuthoringEngineRun, "digest"> {
  const { digest: _digest, ...rest } = run;
  return rest;
}

function resetApprovalOnly(
  run: AuthoringEngineRun,
  options: { keepBuild?: boolean } = {}
): Omit<AuthoringEngineRun, "digest" | "approval" | "build"> & {
  submission_intent?: AuthoringSubmissionIntent;
  build?: AuthoringBuildRecord;
} {
  const { digest: _digest, approval: _approval, build, ...rest } = run;
  if (options.keepBuild && build) return { ...rest, build };
  return rest;
}
