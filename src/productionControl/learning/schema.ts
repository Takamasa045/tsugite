/**
 * PO-7 Learning Loop schemas.
 * Design authority: docs/design/production-orchestration-v1/learning-loop.md
 * Append-only, digest-bound, secret-free. Never self-approve.
 */
import { z } from "zod";
import { sha256Canonical, withoutField } from "../canonical.js";
import {
  digestRefSchema,
  digestSchema,
  humanDecisionRefSchema,
  safeIdSchema
} from "../schema.js";

const finiteNumber = z.number().refine(Number.isFinite, "finite number required");
const nonNegativeInt = finiteNumber.int().nonnegative();
const isoDateSchema = z.string().datetime({ offset: true });
const safeText = (max: number) => z.string().trim().min(1).max(max);

export const LEARNING_LIFECYCLE_STATES = [
  "observed",
  "candidate",
  "awaiting-experiment",
  "experimenting",
  "validated",
  "rejected",
  "inconclusive",
  "awaiting-human",
  "approved",
  "declined",
  "applied",
  "monitored"
] as const;
export type LearningLifecycleState = (typeof LEARNING_LIFECYCLE_STATES)[number];

export const learningTargetKindSchema = z.enum([
  "validator",
  "compiler",
  "template",
  "prompt-guide",
  "runbook",
  "lesson"
]);
export type LearningTargetKind = z.infer<typeof learningTargetKindSchema>;

/** Exported schema version for RC revision bindings. */
export const LEARNING_CANDIDATE_SCHEMA_VERSION = 1 as const;

export const learningExperimentModeSchema = z.enum([
  "fixture",
  "replay",
  "shadow",
  "live-approved"
]);
export type LearningExperimentMode = z.infer<typeof learningExperimentModeSchema>;

export const learningExperimentResultStatusSchema = z.enum([
  "validated",
  "rejected",
  "inconclusive"
]);

export const promotionProposalStatusSchema = z.enum([
  "pending-human",
  "approved",
  "declined",
  "applied"
]);

export const learningCandidateSchema = z
  .object({
    schema_version: z.literal(1),
    candidate_id: safeIdSchema,
    feedback_keys: z.array(z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/)).min(1).max(32),
    recurrence: z
      .object({
        exact_key_count: nonNegativeInt,
        related_observation_ids: z.array(safeIdSchema).max(256),
        /** Advisory only — never promotes to exact recurrence. */
        semantic_matches_advisory: z.array(safeText(500)).max(64)
      })
      .strict(),
    observation_refs: z.array(digestRefSchema).min(1).max(256),
    symptom: safeText(2_000),
    hypothesized_cause: safeText(2_000),
    proposed_rule: z
      .object({
        target_kind: learningTargetKindSchema,
        /** Project-relative or catalog-relative ref; never absolute path. */
        target_ref: z
          .string()
          .min(1)
          .max(512)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "safe target_ref required"),
        scope: safeText(500),
        minimal_change: safeText(2_000)
      })
      .strict(),
    invariants: z.array(safeText(500)).min(1).max(64),
    experiment_requirements: z.array(safeText(500)).min(1).max(64),
    produced_by: z.literal("learning"),
    lifecycle: z.enum(LEARNING_LIFECYCLE_STATES).default("candidate"),
    digest: digestSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.feedback_keys).size !== value.feedback_keys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["feedback_keys"],
        message: "feedback keys must be unique"
      });
    }
    if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["digest"],
        message: "learning candidate digest mismatch"
      });
    }
  });
export type LearningCandidateV1 = z.infer<typeof learningCandidateSchema>;

const successCriterionSchema = z
  .object({
    metric_id: safeIdSchema,
    comparator: z.enum(["eq", "lte", "gte"]),
    threshold: finiteNumber
  })
  .strict();

export const learningExperimentSchema = z
  .object({
    schema_version: z.literal(1),
    experiment_id: safeIdSchema,
    candidate_digest: digestSchema,
    mode: learningExperimentModeSchema,
    baseline_ref: digestRefSchema,
    candidate_ref: digestRefSchema,
    fixture_refs: z.array(digestRefSchema).max(256),
    success_criteria: z.array(successCriterionSchema).min(1).max(64),
    safety_invariants: z.array(safeText(500)).min(1).max(64),
    /** Required for live-approved only. */
    authority: humanDecisionRefSchema.optional(),
    result: z
      .object({
        status: learningExperimentResultStatusSchema,
        metric_evidence_refs: z.array(digestRefSchema).max(256),
        safety_violations: z.array(safeText(500)).max(64),
        regression_refs: z.array(digestRefSchema).max(256)
      })
      .strict()
      .optional(),
    digest: digestSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "live-approved" && !value.authority) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authority"],
        message: "live-approved experiment requires human authority"
      });
    }
    if (value.mode !== "live-approved" && value.authority) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authority"],
        message: "authority is only valid for live-approved experiments"
      });
    }
    if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["digest"],
        message: "learning experiment digest mismatch"
      });
    }
  });
export type LearningExperimentV1 = z.infer<typeof learningExperimentSchema>;

export const promotionProposalSchema = z
  .object({
    schema_version: z.literal(1),
    proposal_id: safeIdSchema,
    candidate_digest: digestSchema,
    experiment_digests: z.array(digestSchema).min(1).max(32),
    proposed_patch_digest: digestSchema,
    target_ref: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "safe target_ref required"),
    compatibility_impact: z.enum(["none", "additive", "breaking"]),
    rollback_ref: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "safe rollback_ref required"),
    status: promotionProposalStatusSchema,
    decision: humanDecisionRefSchema.optional(),
    applied_rule_revision: digestRefSchema.optional(),
    digest: digestSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.experiment_digests).size !== value.experiment_digests.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["experiment_digests"],
        message: "experiment digests must be unique"
      });
    }
    if (value.status === "pending-human" && value.decision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decision"],
        message: "pending-human proposal cannot carry a decision"
      });
    }
    if ((value.status === "approved" || value.status === "declined" || value.status === "applied") && !value.decision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decision"],
        message: "decided proposal requires a human decision"
      });
    }
    if (value.status === "applied" && !value.applied_rule_revision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["applied_rule_revision"],
        message: "applied proposal requires applied_rule_revision"
      });
    }
    if (value.status !== "applied" && value.applied_rule_revision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["applied_rule_revision"],
        message: "applied_rule_revision is only valid when status is applied"
      });
    }
    if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["digest"],
        message: "promotion proposal digest mismatch"
      });
    }
  });
export type PromotionProposalV1 = z.infer<typeof promotionProposalSchema>;

export const ruleRevisionSchema = z
  .object({
    schema_version: z.literal(1),
    rule_id: safeIdSchema,
    revision: nonNegativeInt,
    target_kind: learningTargetKindSchema,
    target_ref: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "safe target_ref required"),
    change_summary: safeText(2_000),
    patch_digest: digestSchema,
    proposal_digest: digestSchema,
    decision: humanDecisionRefSchema,
    supersedes_revision: nonNegativeInt.optional(),
    created_at: isoDateSchema,
    digest: digestSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["digest"],
        message: "rule revision digest mismatch"
      });
    }
  });
export type RuleRevisionV1 = z.infer<typeof ruleRevisionSchema>;

export const ruleSetSnapshotSchema = z
  .object({
    schema_version: z.literal(1),
    rule_set_id: safeIdSchema,
    production_id: safeIdSchema.optional(),
    /** Only applied rule revisions may appear. */
    rule_revisions: z.array(digestRefSchema).max(256),
    compiled_at: isoDateSchema,
    digest: digestSchema
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.rule_revisions.map((ref) => `${ref.kind}\0${ref.id}\0${ref.digest}`);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rule_revisions"],
        message: "rule revisions must be unique"
      });
    }
    if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["digest"],
        message: "rule set snapshot digest mismatch"
      });
    }
  });
export type RuleSetSnapshotV1 = z.infer<typeof ruleSetSnapshotSchema>;

export function parseLearningCandidate(input: unknown): LearningCandidateV1 {
  return learningCandidateSchema.parse(input);
}

export function parseLearningExperiment(input: unknown): LearningExperimentV1 {
  return learningExperimentSchema.parse(input);
}

export function parsePromotionProposal(input: unknown): PromotionProposalV1 {
  return promotionProposalSchema.parse(input);
}

export function parseRuleRevision(input: unknown): RuleRevisionV1 {
  return ruleRevisionSchema.parse(input);
}

export function parseRuleSetSnapshot(input: unknown): RuleSetSnapshotV1 {
  return ruleSetSnapshotSchema.parse(input);
}
