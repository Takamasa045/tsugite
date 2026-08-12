/**
 * Secret-free public projection of learning status for Launcher / Mission Tree.
 */
import { z } from "zod";
import { sha256Canonical, withoutField } from "../canonical.js";
import { digestSchema, safeIdSchema } from "../schema.js";
import type { LearningCandidateV1 } from "./schema.js";
import type { LearningExperimentV1 } from "./schema.js";
import type { PromotionProposalV1 } from "./schema.js";
import type { RuleSetSnapshotV1 } from "./schema.js";

const learningPublicStatusSchema = z.enum([
  "none",
  "candidate",
  "experimenting",
  "validated",
  "awaiting-human",
  "approved",
  "declined",
  "applied",
  "rejected",
  "inconclusive"
]);

export const learningPublicProjectionSchema = z
  .object({
    schema_version: z.literal(1),
    production_id: safeIdSchema.optional(),
    status: learningPublicStatusSchema,
    candidate_count: z.number().int().nonnegative(),
    pending_proposal_count: z.number().int().nonnegative(),
    applied_rule_count: z.number().int().nonnegative(),
    exact_key_recurrence_total: z.number().int().nonnegative(),
    latest_proposal_id: safeIdSchema.optional(),
    latest_proposal_status: z
      .enum(["pending-human", "approved", "declined", "applied"])
      .optional(),
    bound_rule_set_digest: digestSchema.optional(),
    /** Reason codes only — never raw prompts/paths/secrets. */
    notices: z.array(z.string().min(1).max(200)).max(32),
    digest: digestSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["digest"],
        message: "learning public projection digest mismatch"
      });
    }
  });
export type LearningPublicProjectionV1 = z.infer<typeof learningPublicProjectionSchema>;

export type ProjectLearningStatusInput = {
  production_id?: string;
  candidates?: LearningCandidateV1[];
  experiments?: LearningExperimentV1[];
  proposals?: PromotionProposalV1[];
  bound_rule_set?: RuleSetSnapshotV1;
};

function deriveStatus(input: ProjectLearningStatusInput): LearningPublicProjectionV1["status"] {
  const proposals = input.proposals ?? [];
  if (proposals.some((proposal) => proposal.status === "applied")) return "applied";
  if (proposals.some((proposal) => proposal.status === "approved")) return "approved";
  if (proposals.some((proposal) => proposal.status === "pending-human")) return "awaiting-human";
  if (proposals.some((proposal) => proposal.status === "declined")) return "declined";

  const experiments = input.experiments ?? [];
  if (experiments.some((experiment) => experiment.result?.status === "validated")) return "validated";
  if (experiments.some((experiment) => experiment.result?.status === "rejected")) return "rejected";
  if (experiments.some((experiment) => experiment.result?.status === "inconclusive")) return "inconclusive";
  if (experiments.some((experiment) => !experiment.result)) return "experimenting";

  if ((input.candidates?.length ?? 0) > 0) return "candidate";
  return "none";
}

/**
 * Build a strict public learning DTO. Rejects objects that still contain forbidden keys.
 */
export function projectLearningStatus(input: ProjectLearningStatusInput): LearningPublicProjectionV1 {
  const proposals = input.proposals ?? [];
  const pending = proposals.filter((proposal) => proposal.status === "pending-human");
  const applied = proposals.filter((proposal) => proposal.status === "applied");
  const latest = [...proposals].sort((left, right) => left.proposal_id.localeCompare(right.proposal_id)).at(-1);
  const exactTotal = (input.candidates ?? []).reduce(
    (sum, candidate) => sum + candidate.recurrence.exact_key_count,
    0
  );

  const notices: string[] = [];
  if (pending.length > 0) notices.push("learning.proposal_awaiting_human");
  if ((input.experiments ?? []).some((experiment) => experiment.result?.status === "validated")) {
    notices.push("learning.validated_not_applied");
  }

  const draft = {
    schema_version: 1 as const,
    ...(input.production_id ? { production_id: input.production_id } : {}),
    status: deriveStatus(input),
    candidate_count: input.candidates?.length ?? 0,
    pending_proposal_count: pending.length,
    applied_rule_count: applied.length + (input.bound_rule_set?.rule_revisions.length ?? 0),
    exact_key_recurrence_total: exactTotal,
    ...(latest
      ? {
          latest_proposal_id: latest.proposal_id,
          latest_proposal_status: latest.status
        }
      : {}),
    ...(input.bound_rule_set ? { bound_rule_set_digest: input.bound_rule_set.digest } : {}),
    notices
  };

  const projected = learningPublicProjectionSchema.parse({
    ...draft,
    digest: sha256Canonical(draft)
  });

  // Defense in depth: serialized public JSON must not contain secret-ish tokens.
  const serialized = JSON.stringify(projected);
  if (
    /sk-[A-Za-z0-9]{8,}/.test(serialized)
    || /"prompt"\s*:/.test(serialized)
    || /\/Users\//.test(serialized)
    || /provider_response/.test(serialized)
  ) {
    throw new Error("learning public projection leaked forbidden content");
  }

  return projected;
}

export function parseLearningPublicProjection(input: unknown): LearningPublicProjectionV1 {
  return learningPublicProjectionSchema.parse(input);
}
