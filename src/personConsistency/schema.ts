import { sha256Bytes, sha256Canonical, withoutField } from "../productionControl/canonical.js";
import {
  digestRefSchema,
  digestSchema,
  humanDecisionRefSchema,
  safeIdSchema,
  type DigestRef,
  type HumanDecisionRef
} from "../productionControl/schema.js";
import { z } from "zod";

export const lockedTextSchema = z.object({
  text: z.string().min(1),
  sha256: digestSchema
}).strict().superRefine((value, context) => {
  if (sha256Bytes(new TextEncoder().encode(value.text)) !== value.sha256) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sha256"], message: "locked text sha256 mismatch" });
  }
});
export type LockedText = z.infer<typeof lockedTextSchema>;

const identityVariantSchema = z.object({
  id: safeIdSchema,
  source_asset_id: safeIdSchema,
  asset_digest: digestSchema
}).strict();

const identitySubjectSchema = z.object({
  id: safeIdSchema,
  locked_blocks: z.object({
    voice: lockedTextSchema.optional(),
    appearance: lockedTextSchema.optional(),
    manner: lockedTextSchema.optional()
  }).strict(),
  variants: z.array(identityVariantSchema).max(64)
}).strict();

const identitySceneSchema = z.object({
  id: safeIdSchema,
  location_map: lockedTextSchema.optional(),
  palette: lockedTextSchema.optional(),
  wardrobe: lockedTextSchema.optional(),
  props: z.array(z.string().min(1).max(500)).max(256),
  time_of_day: z.string().min(1).max(120).optional(),
  screen_direction: z.string().min(1).max(120).optional(),
  active_subjects: z.array(safeIdSchema).max(256)
}).strict();

const verificationConditionSchema = z.object({
  condition_id: safeIdSchema,
  description: z.string().min(1).max(1_000),
  subject_ids: z.array(safeIdSchema).min(1).max(256),
  variant_ids: z.array(safeIdSchema).max(256).optional(),
  scene_ids: z.array(safeIdSchema).max(256).optional()
}).strict();

const identityVerificationRequirementsSchema = z.object({
  risk_class: z.enum(["low", "medium", "high"]),
  conditions: z.array(verificationConditionSchema).min(1).max(256),
  minimum_distinct_outputs: z.number().int().positive(),
  minimum_distinct_conditions: z.number().int().positive()
}).strict();
export type IdentityVerificationRequirements = z.infer<typeof identityVerificationRequirementsSchema>;

const identityDefinitionContentSchema = z.object({
  schema_version: z.literal(1),
  contract_id: safeIdSchema,
  revision: z.number().int().nonnegative(),
  subjects: z.array(identitySubjectSchema).max(256),
  scenes: z.array(identitySceneSchema).max(256),
  verification_requirements: identityVerificationRequirementsSchema,
  definition_digest: digestSchema
}).strict();

export const identityDefinitionSchema = z.object({
  ...identityDefinitionContentSchema.shape,
  definition_status: z.enum(["draft", "awaiting_human", "confirmed"]),
  definition_confirmation: humanDecisionRefSchema.optional(),
  digest: digestSchema
}).strict().superRefine((value, context) => {
  const definitionPayload = withoutField(value, "definition_digest");
  const { definition_confirmation: _confirmation, ...withoutConfirmation } = definitionPayload;
  const withoutEnvelope = withoutField(withoutConfirmation, "digest");
  if (sha256Canonical(withoutEnvelope) !== value.definition_digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["definition_digest"], message: "identity definition digest mismatch" });
  }
  const expected = sha256Canonical(withoutField(value, "digest"));
  if (expected !== value.digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "identity definition envelope digest mismatch" });
  }
  if (value.definition_status === "confirmed") {
    if (!value.definition_confirmation) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["definition_confirmation"], message: "confirmed identity definition requires a human decision" });
    } else if (value.definition_confirmation.subject_digest !== value.definition_digest) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["definition_confirmation", "subject_digest"], message: "definition confirmation subject does not match definition digest" });
    }
  } else if (value.definition_confirmation) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["definition_confirmation"], message: "unconfirmed identity definition cannot carry a confirmation" });
  }
});
export type IdentityDefinition = z.infer<typeof identityDefinitionSchema>;
export type IdentityDefinitionContractV1 = IdentityDefinition;

const evaluationSchema = z.object({
  condition_id: safeIdSchema,
  output_refs: z.array(digestRefSchema).min(1).max(256),
  evidence_artifact_refs: z.array(digestRefSchema).min(1).max(256),
  result: z.enum(["pass", "drift", "not-evaluable"])
}).strict();

const verificationContentSchema = z.object({
  schema_version: z.literal(1),
  production_id: safeIdSchema,
  identity_definition_digest: digestSchema,
  selected_output_refs: z.array(digestRefSchema).min(1).max(256),
  required_condition_ids: z.array(safeIdSchema).min(1).max(256),
  evaluated_condition_ids: z.array(safeIdSchema).max(256),
  evaluations: z.array(evaluationSchema).max(256),
  verification_subject_digest: digestSchema,
  digest: digestSchema
}).strict();

const identityVerificationVariantSchema = z.discriminatedUnion("status", [
  verificationContentSchema.extend({
    status: z.literal("verified"),
    coverage_basis: z.enum(["multiple-shots", "multiple-conditions"]),
    distinct_output_count: z.number().int().positive(),
    distinct_condition_count: z.number().int().positive(),
    decision: humanDecisionRefSchema
  }).strict(),
  verificationContentSchema.extend({
    status: z.literal("residual-risk-accepted"),
    risk_class: z.literal("low"),
    residual_drifts: z.array(z.string().min(1).max(1_000)).min(1),
    acceptance_scope: z.string().min(1).max(1_000),
    decision: humanDecisionRefSchema
  }).strict(),
  verificationContentSchema.extend({
    status: z.literal("rejected"),
    rejection_reasons: z.array(z.string().min(1).max(1_000)).min(1),
    decision: humanDecisionRefSchema
  }).strict(),
  verificationContentSchema.extend({
    status: z.literal("not-evaluable"),
    blocking_reasons: z.array(z.string().min(1).max(1_000)).min(1),
    decision: humanDecisionRefSchema
  }).strict()
]);

function digestRefIdentity(ref: { kind: string; id: string; digest: string }): string {
  return `${ref.kind}\u0000${ref.id}\u0000${ref.digest}`;
}

export const identityVerificationSchema = identityVerificationVariantSchema.superRefine((value, context) => {
  const selectedOutputKeys = value.selected_output_refs.map(digestRefIdentity);
  if (new Set(selectedOutputKeys).size !== selectedOutputKeys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["selected_output_refs"], message: "selected output refs must be unique" });
  }
  if (new Set(value.required_condition_ids).size !== value.required_condition_ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["required_condition_ids"], message: "required condition ids must be unique" });
  }
  if (new Set(value.evaluated_condition_ids).size !== value.evaluated_condition_ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["evaluated_condition_ids"], message: "evaluated condition ids must be unique" });
  }
  if (value.evaluated_condition_ids.some((id) => !value.required_condition_ids.includes(id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["evaluated_condition_ids"], message: "evaluated condition ids must be declared as required" });
  }
  const evaluationIds = value.evaluations.map((evaluation) => evaluation.condition_id);
  if (new Set(evaluationIds).size !== evaluationIds.length
    || new Set(evaluationIds).size !== new Set(value.evaluated_condition_ids).size
    || !evaluationIds.every((id) => value.evaluated_condition_ids.includes(id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["evaluated_condition_ids"], message: "evaluated condition ids must exactly match evaluations" });
  }
  const selectedOutputIds = new Set(selectedOutputKeys);
  if (value.evaluations.some((evaluation) => evaluation.output_refs.some((ref) => !selectedOutputIds.has(digestRefIdentity(ref))))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["evaluations"], message: "evaluation outputs must be selected outputs" });
  }
  if (value.status === "verified") {
    const distinctOutputCount = selectedOutputIds.size;
    const distinctConditionCount = new Set(value.evaluated_condition_ids).size;
    if (value.evaluations.length === 0 || value.evaluated_condition_ids.length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["evaluations"], message: "verified reports require evaluated conditions and evidence" });
    }
    if (distinctOutputCount < 2 && distinctConditionCount < 2) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["coverage_basis"], message: "verified reports require at least two distinct outputs or conditions" });
    }
    if (value.evaluated_condition_ids.length !== value.required_condition_ids.length
      || value.required_condition_ids.some((id) => !value.evaluated_condition_ids.includes(id))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["evaluated_condition_ids"], message: "verified reports must evaluate every required condition" });
    }
    if (value.evaluations.some((evaluation) => evaluation.result !== "pass")) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["evaluations"], message: "verified reports require every evaluation to pass" });
    }
    if (value.coverage_basis === "multiple-shots" && distinctOutputCount < 2) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["coverage_basis"], message: "multiple-shots coverage requires at least two distinct outputs" });
    }
    if (value.coverage_basis === "multiple-conditions" && distinctConditionCount < 2) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["coverage_basis"], message: "multiple-conditions coverage requires at least two distinct conditions" });
    }
    if (value.distinct_output_count !== distinctOutputCount) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["distinct_output_count"], message: "distinct output count must match selected outputs" });
    }
    if (value.distinct_condition_count !== distinctConditionCount) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["distinct_condition_count"], message: "distinct condition count must match evaluated conditions" });
    }
  }
  const base = {
    schema_version: value.schema_version,
    production_id: value.production_id,
    identity_definition_digest: value.identity_definition_digest,
    selected_output_refs: value.selected_output_refs,
    required_condition_ids: value.required_condition_ids,
    evaluated_condition_ids: value.evaluated_condition_ids,
    evaluations: value.evaluations,
    status: value.status,
    ...(value.status === "verified"
      ? {
          coverage_basis: value.coverage_basis,
          distinct_output_count: value.distinct_output_count,
          distinct_condition_count: value.distinct_condition_count
        }
      : value.status === "residual-risk-accepted"
        ? { risk_class: value.risk_class, residual_drifts: value.residual_drifts, acceptance_scope: value.acceptance_scope }
        : value.status === "rejected"
          ? { rejection_reasons: value.rejection_reasons }
          : { blocking_reasons: value.blocking_reasons })
  };
  if (sha256Canonical(base) !== value.verification_subject_digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["verification_subject_digest"], message: "identity verification subject digest mismatch" });
  }
  if (value.decision.subject_digest !== value.verification_subject_digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["decision", "subject_digest"], message: "identity verification decision does not match report subject" });
  }
  if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "identity verification envelope digest mismatch" });
  }
});
export type IdentityVerification = z.infer<typeof identityVerificationSchema>;
export type IdentityVerificationReportV1 = IdentityVerification;

export function identityDefinitionSubjectDigest(definition: Omit<IdentityDefinition, "definition_digest" | "digest">): string {
  const { definition_confirmation: _confirmation, ...withoutConfirmation } = definition;
  return sha256Canonical(withoutConfirmation);
}

export function identityVerificationSubjectDigest(
  report: Omit<IdentityVerification, "verification_subject_digest" | "digest">
): string {
  const { decision: _decision, ...withoutDecision } = report as Omit<IdentityVerification, "verification_subject_digest" | "digest"> & { decision?: HumanDecisionRef };
  return sha256Canonical(withoutDecision);
}

export function buildIdentityDefinitionDigest(definition: Omit<IdentityDefinition, "definition_digest" | "digest">): string {
  return identityDefinitionSubjectDigest(definition);
}

export function buildIdentityVerificationDigest(report: Omit<IdentityVerification, "verification_subject_digest" | "digest">): string {
  return sha256Canonical(report);
}
