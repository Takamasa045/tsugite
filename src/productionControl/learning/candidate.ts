/**
 * LearningCandidate construction from feedback observations.
 * Exact feedback-key recurrence only; semantic matches stay advisory.
 * Does not write feedback.jsonl / LESSONS.md (use existing feedback API).
 */
import { createHash } from "node:crypto";
import { sha256Canonical, withoutField } from "../canonical.js";
import { pcError } from "../errors.js";
import type { DigestRef } from "../schema.js";
import {
  learningCandidateSchema,
  type LearningCandidateV1,
  type LearningTargetKind
} from "./schema.js";

export type FeedbackObservation = {
  id: string;
  key: string;
  summary: string;
  stage: "observed" | "recurring" | "promoted" | "verified";
  evidence?: string[];
  /** Optional project-relative observation artifact digests. */
  observation_digest?: string;
};

export type CreateLearningCandidateInput = {
  candidate_id: string;
  observations: FeedbackObservation[];
  /** Exact keys under consideration. Semantic similarity is advisory only. */
  feedback_keys: string[];
  symptom: string;
  hypothesized_cause: string;
  proposed_rule: {
    target_kind: LearningTargetKind;
    target_ref: string;
    scope: string;
    minimal_change: string;
  };
  invariants: string[];
  experiment_requirements: string[];
  /** Advisory semantic matches; never treated as exact recurrence. */
  semantic_matches_advisory?: string[];
};

export type LearningCandidateDecision =
  | { status: "created"; candidate: LearningCandidateV1 }
  | { status: "insufficient"; reasons: string[] };

function isSafeRelativeEvidence(path: string): boolean {
  if (
    path.startsWith("/")
    || path.includes("\\")
    || path.includes("\0")
    || path.includes("..")
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)
  ) {
    return false;
  }
  return path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function observationRef(observation: FeedbackObservation): DigestRef {
  const digest = observation.observation_digest
    ?? createHash("sha256")
      .update(
        sha256Canonical({
          id: observation.id,
          key: observation.key,
          summary: observation.summary,
          stage: observation.stage,
          evidence: observation.evidence ?? []
        }),
        "utf8"
      )
      .digest("hex");
  return {
    kind: "feedback-observation",
    id: observation.id,
    digest
  };
}

/**
 * Build a LearningCandidate when exact-key observations + concrete rule target exist.
 * Returns `insufficient` (feedback-only) when promotion prerequisites are missing.
 */
export function createLearningCandidate(
  input: CreateLearningCandidateInput
): LearningCandidateDecision {
  const reasons: string[] = [];
  if (!input.candidate_id) reasons.push("candidate_id required");
  if (!input.feedback_keys.length) reasons.push("feedback_keys required");
  if (!input.observations.length) reasons.push("observation source required");
  if (!input.symptom.trim()) reasons.push("symptom required");
  if (!input.hypothesized_cause.trim()) reasons.push("hypothesized_cause required");
  if (!input.proposed_rule?.target_ref?.trim()) reasons.push("proposed_rule.target_ref required");
  if (!input.proposed_rule?.minimal_change?.trim()) reasons.push("proposed_rule.minimal_change required");
  if (!input.invariants?.length) reasons.push("invariants required");
  if (!input.experiment_requirements?.length) reasons.push("experiment_requirements required");

  const keys = [...new Set(input.feedback_keys)];
  const matching = input.observations.filter((observation) => keys.includes(observation.key));
  if (matching.length === 0) {
    reasons.push("no observations match feedback_keys exactly");
  }

  for (const observation of matching) {
    for (const evidence of observation.evidence ?? []) {
      if (!isSafeRelativeEvidence(evidence)) {
        reasons.push(`unsafe evidence path rejected: ${observation.id}`);
      }
    }
  }

  // Secret / prompt / absolute path heuristics on free text.
  const freeText = [
    input.symptom,
    input.hypothesized_cause,
    input.proposed_rule.minimal_change,
    input.proposed_rule.scope,
    ...(input.semantic_matches_advisory ?? [])
  ].join("\n");
  if (/(?:^|[\s/])(?:Users|home)\/|sk-[A-Za-z0-9]{8,}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/i.test(freeText)) {
    reasons.push("candidate text must not include secrets, absolute paths, or private keys");
  }
  if (/\braw[_-]?prompt\b|\bprovider[_-]?response\b/i.test(freeText)) {
    reasons.push("candidate text must not include raw prompt or provider response");
  }

  if (reasons.length > 0) {
    return { status: "insufficient", reasons };
  }

  // Exact-key recurrence: count distinct observation ids sharing exact keys.
  const relatedIds = [...new Set(matching.map((observation) => observation.id))];
  const exactKeyCount = matching.length;
  const observation_refs = matching.map(observationRef);

  // Exact recurrence requires at least two matching observations on the same keys.
  // Semantic advisory never upgrades this count.
  const draft = {
    schema_version: 1 as const,
    candidate_id: input.candidate_id,
    feedback_keys: keys,
    recurrence: {
      exact_key_count: exactKeyCount,
      related_observation_ids: relatedIds,
      semantic_matches_advisory: input.semantic_matches_advisory ?? []
    },
    observation_refs,
    symptom: input.symptom.trim(),
    hypothesized_cause: input.hypothesized_cause.trim(),
    proposed_rule: {
      target_kind: input.proposed_rule.target_kind,
      target_ref: input.proposed_rule.target_ref,
      scope: input.proposed_rule.scope.trim(),
      minimal_change: input.proposed_rule.minimal_change.trim()
    },
    invariants: input.invariants.map((item) => item.trim()),
    experiment_requirements: input.experiment_requirements.map((item) => item.trim()),
    produced_by: "learning" as const,
    lifecycle: "candidate" as const
  };

  const candidate: LearningCandidateV1 = learningCandidateSchema.parse({
    ...draft,
    digest: sha256Canonical(draft)
  });

  return { status: "created", candidate };
}

/** True when exact-key recurrence is at least 2 (semantic matches ignored). */
export function isExactKeyRecurring(candidate: LearningCandidateV1): boolean {
  return candidate.recurrence.exact_key_count >= 2;
}

export function candidateWithoutDigest(
  candidate: LearningCandidateV1
): Omit<LearningCandidateV1, "digest"> {
  return withoutField(candidate, "digest");
}

export function assertCandidateDigest(candidate: LearningCandidateV1): void {
  const expected = sha256Canonical(withoutField(candidate, "digest"));
  if (expected !== candidate.digest) {
    throw pcError("PC_SCHEMA_INVALID", "learning candidate digest mismatch");
  }
}
