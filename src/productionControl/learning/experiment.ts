/**
 * Learning experiments: fixture → replay → shadow (default auto), live-approved only with human authority.
 * validated/rejected/inconclusive never auto-apply rules.
 */
import { sha256Canonical, withoutField } from "../canonical.js";
import { pcError } from "../errors.js";
import type { DigestRef, HumanDecisionRef } from "../schema.js";
import {
  learningExperimentSchema,
  type LearningCandidateV1,
  type LearningExperimentMode,
  type LearningExperimentV1
} from "./schema.js";

export type MetricSample = {
  metric_id: string;
  /** Finite number when measured; null means unknown/not-run — never coerced to 0. */
  value: number | null;
  provenance: "fixture" | "replay" | "shadow" | "production" | "unknown";
};

export type RunLearningExperimentInput = {
  experiment_id: string;
  candidate: LearningCandidateV1;
  mode: LearningExperimentMode;
  baseline_ref: DigestRef;
  candidate_ref: DigestRef;
  fixture_refs?: DigestRef[];
  success_criteria: Array<{
    metric_id: string;
    comparator: "eq" | "lte" | "gte";
    threshold: number;
  }>;
  safety_invariants: string[];
  /** Observed metric samples for this run (fixture/replay/shadow only by default). */
  metric_samples: MetricSample[];
  /** Safety violations detected during the experiment. */
  safety_violations?: string[];
  /** Golden/regression artifact refs that failed. */
  regression_refs?: DigestRef[];
  /** Required when mode is live-approved. */
  authority?: HumanDecisionRef;
  /** Whether production metrics are mixed into samples (forbidden for auto modes). */
  includes_production_metrics?: boolean;
};

function meetsCriterion(
  sample: MetricSample | undefined,
  criterion: RunLearningExperimentInput["success_criteria"][number]
): "pass" | "fail" | "unknown" {
  if (!sample || sample.value === null || !Number.isFinite(sample.value)) return "unknown";
  const value = sample.value;
  switch (criterion.comparator) {
    case "eq":
      return value === criterion.threshold ? "pass" : "fail";
    case "lte":
      return value <= criterion.threshold ? "pass" : "fail";
    case "gte":
      return value >= criterion.threshold ? "pass" : "fail";
    default:
      return "unknown";
  }
}

/**
 * Create and evaluate a LearningExperimentV1 from measured samples.
 * - fixture/replay/shadow: automatic evaluation allowed
 * - live-approved: requires human authority and inherits normal Gate boundaries (caller enforces)
 * - unknown metric values never count as success (inconclusive)
 * - safety violations force rejected
 * - production metrics must not be mixed into fixture/replay/shadow results
 */
export function runLearningExperiment(input: RunLearningExperimentInput): LearningExperimentV1 {
  if (input.mode === "live-approved" && !input.authority) {
    throw pcError("PC_SCHEMA_INVALID", "live-approved experiment requires human authority");
  }
  if (
    input.mode !== "live-approved"
    && (input.includes_production_metrics
      || input.metric_samples.some((sample) => sample.provenance === "production"))
  ) {
    throw pcError(
      "PC_SCHEMA_INVALID",
      "fixture/replay/shadow experiments must not mix production metrics"
    );
  }

  const safety_violations = [...(input.safety_violations ?? [])];
  const regression_refs = [...(input.regression_refs ?? [])];
  const samplesById = new Map(input.metric_samples.map((sample) => [sample.metric_id, sample]));

  let anyUnknown = false;
  let anyFail = false;
  for (const criterion of input.success_criteria) {
    const outcome = meetsCriterion(samplesById.get(criterion.metric_id), criterion);
    if (outcome === "unknown") anyUnknown = true;
    if (outcome === "fail") anyFail = true;
  }

  let status: "validated" | "rejected" | "inconclusive";
  if (safety_violations.length > 0 || regression_refs.length > 0) {
    status = "rejected";
  } else if (anyFail) {
    status = "rejected";
  } else if (anyUnknown) {
    status = "inconclusive";
  } else {
    status = "validated";
  }

  const metric_evidence_refs: DigestRef[] = input.metric_samples.map((sample, index) => ({
    kind: "metric-sample",
    id: `${input.experiment_id}-metric-${index + 1}`,
    digest: sha256Canonical({
      experiment_id: input.experiment_id,
      metric_id: sample.metric_id,
      value: sample.value,
      provenance: sample.provenance
    })
  }));

  const draft = {
    schema_version: 1 as const,
    experiment_id: input.experiment_id,
    candidate_digest: input.candidate.digest,
    mode: input.mode,
    baseline_ref: input.baseline_ref,
    candidate_ref: input.candidate_ref,
    fixture_refs: input.fixture_refs ?? [],
    success_criteria: input.success_criteria,
    safety_invariants: input.safety_invariants,
    ...(input.authority ? { authority: input.authority } : {}),
    result: {
      status,
      metric_evidence_refs,
      safety_violations,
      regression_refs
    }
  };

  return learningExperimentSchema.parse({
    ...draft,
    digest: sha256Canonical(draft)
  });
}

/**
 * validated is never apply authority. Callers must still require human approval.
 */
export function isExperimentApplyEligible(experiment: LearningExperimentV1): false {
  void experiment;
  return false;
}

export function assertExperimentDigest(experiment: LearningExperimentV1): void {
  const expected = sha256Canonical(withoutField(experiment, "digest"));
  if (expected !== experiment.digest) {
    throw pcError("PC_SCHEMA_INVALID", "learning experiment digest mismatch");
  }
}
