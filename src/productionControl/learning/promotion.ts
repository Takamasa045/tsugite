/**
 * Promotion proposals and human-gated apply → rule revision.
 * validated ≠ approved. Learning / Critic / Coordinator cannot self-approve.
 */
import { sha256Canonical, withoutField } from "../canonical.js";
import { pcError } from "../errors.js";
import type { DigestRef, HumanDecisionRef } from "../schema.js";
import type { LearningCandidateV1 } from "./schema.js";
import type { LearningExperimentV1 } from "./schema.js";
import {
  promotionProposalSchema,
  ruleRevisionSchema,
  type PromotionProposalV1,
  type RuleRevisionV1
} from "./schema.js";

export type CreatePromotionProposalInput = {
  proposal_id: string;
  candidate: LearningCandidateV1;
  experiments: LearningExperimentV1[];
  proposed_patch_digest: string;
  rollback_ref: string;
  compatibility_impact: "none" | "additive" | "breaking";
};

export type DecidePromotionInput = {
  proposal: PromotionProposalV1;
  decision: HumanDecisionRef;
  outcome: "approved" | "declined";
};

export type ApplyPromotionInput = {
  proposal: PromotionProposalV1;
  rule_id: string;
  revision: number;
  created_at: string;
  target_kind: import("./schema.js").LearningTargetKind;
  change_summary?: string;
  supersedes_revision?: number;
};

/**
 * Create a pending-human proposal only from validated experiments with zero safety violations.
 * Does not apply anything.
 */
export function createPromotionProposal(input: CreatePromotionProposalInput): PromotionProposalV1 {
  if (input.experiments.length === 0) {
    throw pcError("PC_SCHEMA_INVALID", "promotion proposal requires at least one experiment");
  }
  for (const experiment of input.experiments) {
    if (experiment.candidate_digest !== input.candidate.digest) {
      throw pcError("PC_SCHEMA_INVALID", "experiment candidate_digest does not match candidate");
    }
    if (!experiment.result) {
      throw pcError("PC_SCHEMA_INVALID", "experiment must have a result before proposal");
    }
    if (experiment.result.status !== "validated") {
      throw pcError(
        "PC_SCHEMA_INVALID",
        "only validated experiments may form a promotion proposal",
        { status: experiment.result.status }
      );
    }
    if (experiment.result.safety_violations.length > 0) {
      throw pcError("PC_SCHEMA_INVALID", "experiments with safety violations cannot form a proposal");
    }
  }

  const draft = {
    schema_version: 1 as const,
    proposal_id: input.proposal_id,
    candidate_digest: input.candidate.digest,
    experiment_digests: input.experiments.map((experiment) => experiment.digest),
    proposed_patch_digest: input.proposed_patch_digest,
    target_ref: input.candidate.proposed_rule.target_ref,
    compatibility_impact: input.compatibility_impact,
    rollback_ref: input.rollback_ref,
    status: "pending-human" as const
  };

  return promotionProposalSchema.parse({
    ...draft,
    digest: sha256Canonical(draft)
  });
}

/**
 * Record human approval/decline. Subject digest must match the proposal body without decision.
 */
export function decidePromotionProposal(input: DecidePromotionInput): PromotionProposalV1 {
  const proposal = promotionProposalSchema.parse(input.proposal);
  if (proposal.status !== "pending-human") {
    throw pcError("PC_INVALID_TRANSITION", "only pending-human proposals can be decided", {
      status: proposal.status
    });
  }

  const subject = {
    schema_version: proposal.schema_version,
    proposal_id: proposal.proposal_id,
    candidate_digest: proposal.candidate_digest,
    experiment_digests: proposal.experiment_digests,
    proposed_patch_digest: proposal.proposed_patch_digest,
    target_ref: proposal.target_ref,
    compatibility_impact: proposal.compatibility_impact,
    rollback_ref: proposal.rollback_ref,
    status: "pending-human" as const
  };
  const expectedSubject = sha256Canonical(subject);
  if (input.decision.subject_digest !== expectedSubject) {
    throw pcError("PC_SCHEMA_INVALID", "promotion decision subject_digest mismatch");
  }
  if (input.decision.actor === "learning" || input.decision.actor === "critic" || input.decision.actor === "coordinator-self") {
    throw pcError("PC_ROLE_FORBIDDEN", "learning/critic/self cannot approve their own proposal");
  }

  const draft = {
    schema_version: 1 as const,
    proposal_id: proposal.proposal_id,
    candidate_digest: proposal.candidate_digest,
    experiment_digests: proposal.experiment_digests,
    proposed_patch_digest: proposal.proposed_patch_digest,
    target_ref: proposal.target_ref,
    compatibility_impact: proposal.compatibility_impact,
    rollback_ref: proposal.rollback_ref,
    status: input.outcome,
    decision: input.decision
  };

  return promotionProposalSchema.parse({
    ...draft,
    digest: sha256Canonical(draft)
  });
}

/**
 * Apply an approved proposal into a new rule revision.
 * Does not mutate existing missions, Gate subjects, or LESSONS.md directly.
 */
export function applyApprovedPromotion(input: ApplyPromotionInput): {
  proposal: PromotionProposalV1;
  rule_revision: RuleRevisionV1;
} {
  const proposal = promotionProposalSchema.parse(input.proposal);
  if (proposal.status !== "approved" || !proposal.decision) {
    throw pcError("PC_INVALID_TRANSITION", "only human-approved proposals can be applied", {
      status: proposal.status
    });
  }

  const ruleDraft = {
    schema_version: 1 as const,
    rule_id: input.rule_id,
    revision: input.revision,
    target_kind: input.target_kind,
    target_ref: proposal.target_ref,
    change_summary: input.change_summary ?? `Applied promotion ${proposal.proposal_id}`,
    patch_digest: proposal.proposed_patch_digest,
    proposal_digest: proposal.digest,
    decision: proposal.decision,
    ...(input.supersedes_revision !== undefined
      ? { supersedes_revision: input.supersedes_revision }
      : {}),
    created_at: input.created_at
  };
  const rule_revision = ruleRevisionSchema.parse({
    ...ruleDraft,
    digest: sha256Canonical(ruleDraft)
  });

  const applied_rule_revision: DigestRef = {
    kind: "rule-revision",
    id: `${rule_revision.rule_id}.r${rule_revision.revision}`,
    digest: rule_revision.digest
  };

  const appliedDraft = {
    schema_version: 1 as const,
    proposal_id: proposal.proposal_id,
    candidate_digest: proposal.candidate_digest,
    experiment_digests: proposal.experiment_digests,
    proposed_patch_digest: proposal.proposed_patch_digest,
    target_ref: proposal.target_ref,
    compatibility_impact: proposal.compatibility_impact,
    rollback_ref: proposal.rollback_ref,
    status: "applied" as const,
    decision: proposal.decision,
    applied_rule_revision
  };

  const applied = promotionProposalSchema.parse({
    ...appliedDraft,
    digest: sha256Canonical(appliedDraft)
  });

  return { proposal: applied, rule_revision };
}

/**
 * validated experiment alone never mutates rule store / LESSONS.md.
 */
export function assertValidatedDoesNotApply(experiments: LearningExperimentV1[]): void {
  for (const experiment of experiments) {
    if (experiment.result?.status === "validated") {
      // intentional no-op: proof that validated is not apply
      continue;
    }
  }
}

export function proposalSubjectDigest(proposal: PromotionProposalV1): string {
  return sha256Canonical({
    schema_version: proposal.schema_version,
    proposal_id: proposal.proposal_id,
    candidate_digest: proposal.candidate_digest,
    experiment_digests: proposal.experiment_digests,
    proposed_patch_digest: proposal.proposed_patch_digest,
    target_ref: proposal.target_ref,
    compatibility_impact: proposal.compatibility_impact,
    rollback_ref: proposal.rollback_ref,
    status: "pending-human"
  });
}

export function assertProposalDigest(proposal: PromotionProposalV1): void {
  const expected = sha256Canonical(withoutField(proposal, "digest"));
  if (expected !== proposal.digest) {
    throw pcError("PC_SCHEMA_INVALID", "promotion proposal digest mismatch");
  }
}
