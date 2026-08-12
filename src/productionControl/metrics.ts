/**
 * Deterministic Mission metrics projection.
 * Design authority: observability-and-evaluation.md
 * Unknown never becomes 0. Safety SLO targets are always 0.
 * Fixture/replay metrics must not be mixed with production provenance.
 */
import { z } from "zod";
import { sha256Canonical, withoutField } from "./canonical.js";
import { pcError } from "./errors.js";
import { digestSchema, safeIdSchema } from "./schema.js";
import type { MissionState } from "./schema.js";

const finiteNumber = z.number().refine(Number.isFinite, "finite number required");
const nonNegativeInt = finiteNumber.int().nonnegative();
const nonNegativeNumber = finiteNumber.nonnegative();
const isoDateSchema = z.string().datetime({ offset: true });

export const metricProvenanceSchema = z.enum([
  "fixture",
  "replay",
  "shadow",
  "production",
  "legacy_not_recorded"
]);
export type MetricProvenance = z.infer<typeof metricProvenanceSchema>;

/** Exported schema version for RC revision bindings. */
export const MISSION_METRICS_SCHEMA_VERSION = 1 as const;

/** Nullable measured value: null = unknown / not-run / legacy_not_recorded. */
export const measuredNumberSchema = z
  .object({
    value: finiteNumber.nullable(),
    unit: z.string().min(1).max(64).optional(),
    denominator: nonNegativeNumber.nullable().optional(),
    period: z.string().min(1).max(128).optional(),
    provenance: metricProvenanceSchema,
    notes: z.array(z.string().min(1).max(200)).max(16).optional()
  })
  .strict();
export type MeasuredNumber = z.infer<typeof measuredNumberSchema>;

export const evidenceScoreSchema = z
  .object({
    value: finiteNumber.min(0).max(100).optional(),
    basis: z.enum(["human", "fixture", "local-analyzer", "external-analyzer", "not-run"]),
    evidence_artifact_ids: z.array(safeIdSchema).max(256),
    ambiguity_codes: z.array(z.string().min(1).max(120)).max(64)
  })
  .strict();
export type EvidenceScore = z.infer<typeof evidenceScoreSchema>;

export const flowMetricsSchema = z
  .object({
    mission_elapsed_ms: measuredNumberSchema,
    active_work_ms: measuredNumberSchema,
    human_wait_ms: measuredNumberSchema,
    provider_wait_ms: measuredNumberSchema,
    critical_path_ms: measuredNumberSchema,
    pause_count: measuredNumberSchema,
    resume_success_rate: measuredNumberSchema,
    resume_time_ms: measuredNumberSchema,
    stale_fan_out: measuredNumberSchema,
    branch_reuse_rate: measuredNumberSchema
  })
  .strict();

export const interventionMetricsSchema = z
  .object({
    human_interventions_total: measuredNumberSchema,
    mandatory_safety_interventions: measuredNumberSchema,
    operational_interventions: measuredNumberSchema,
    creative_interventions: measuredNumberSchema
  })
  .strict();

export const recoveryMetricsSchema = z
  .object({
    eligible_recovery_attempts: measuredNumberSchema,
    successful_recovery_attempts: measuredNumberSchema,
    automatic_recovery_success_rate: measuredNumberSchema,
    local_recovery_success: measuredNumberSchema,
    paid_regeneration_success: measuredNumberSchema,
    escalation_rate: measuredNumberSchema,
    grant_exhaustion_rate: measuredNumberSchema,
    /** submission_unknown is never in eligible denominator. */
    submission_unknown_stops: measuredNumberSchema
  })
  .strict();

export const consistencyMetricsSchema = z
  .object({
    identity: evidenceScoreSchema.optional(),
    wardrobe: evidenceScoreSchema.optional(),
    scene: evidenceScoreSchema.optional(),
    style: evidenceScoreSchema.optional(),
    tone: evidenceScoreSchema.optional(),
    coverage: z
      .object({
        evaluated_shots: nonNegativeInt,
        expected_shots: nonNegativeInt
      })
      .strict()
  })
  .strict();

export const costMetricsSchema = z
  .object({
    actual_generation_credits: measuredNumberSchema,
    quality_per_credit: measuredNumberSchema,
    gate2_issue_count: measuredNumberSchema,
    gate3_issue_count: measuredNumberSchema,
    rework_count: measuredNumberSchema,
    zero_credit_local: z.boolean()
  })
  .strict();

export const mvMetricsSchema = z
  .object({
    audio_video_duration_delta_ms: measuredNumberSchema,
    unit_binding_violation_count: measuredNumberSchema,
    clip_timeline_gap_count: measuredNumberSchema,
    clip_timeline_overlap_count: measuredNumberSchema,
    lyric_timing_coverage: measuredNumberSchema,
    beat_anchor_coverage: measuredNumberSchema,
    human_lyric_text_corrections: measuredNumberSchema,
    human_lyric_timing_corrections: measuredNumberSchema
  })
  .strict();

/**
 * Safety SLO counters. Target is always 0 for every field.
 * Non-zero blocks release (caller / release gate responsibility).
 */
export const safetyMetricsSchema = z
  .object({
    silent_paid_spend: measuredNumberSchema,
    unauthorized_auto_approval: measuredNumberSchema,
    unauthorized_submit: measuredNumberSchema,
    unauthorized_external_submit: measuredNumberSchema,
    over_budget_execution: measuredNumberSchema,
    duplicate_paid_submit: measuredNumberSchema,
    submission_unknown_resubmit: measuredNumberSchema,
    model_connection_silent_fallback: measuredNumberSchema,
    unknown_price_execution: measuredNumberSchema,
    stale_artifact_acceptance: measuredNumberSchema,
    gate_digest_mismatch_execution: measuredNumberSchema,
    unverified_media_pinned: measuredNumberSchema,
    secret_or_prompt_public_leak: measuredNumberSchema,
    role_direct_coordinator_write: measuredNumberSchema
  })
  .strict();

export const missionMetricsSchema = z
  .object({
    schema_version: z.literal(1),
    production_id: safeIdSchema,
    tree_revision: nonNegativeInt,
    source_event_sequence: nonNegativeInt,
    flow: flowMetricsSchema,
    intervention: interventionMetricsSchema,
    recovery: recoveryMetricsSchema,
    consistency: consistencyMetricsSchema,
    cost: costMetricsSchema,
    mv: mvMetricsSchema.optional(),
    safety: safetyMetricsSchema,
    computed_at: isoDateSchema,
    /** Denominator / evaluation window description. */
    evaluation_window: z
      .object({
        period: z.string().min(1).max(128),
        population: z.string().min(1).max(256),
        provenance: metricProvenanceSchema
      })
      .strict(),
    digest: digestSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["digest"],
        message: "mission metrics digest mismatch"
      });
    }
  });
export type MissionMetricsV1 = z.infer<typeof missionMetricsSchema>;

export function measured(
  value: number | null,
  provenance: MetricProvenance,
  options: {
    unit?: string;
    denominator?: number | null;
    period?: string;
    notes?: string[];
  } = {}
): MeasuredNumber {
  if (value !== null && !Number.isFinite(value)) {
    throw pcError("PC_SCHEMA_INVALID", "metric value must be finite or null");
  }
  return measuredNumberSchema.parse({
    value,
    provenance,
    ...(options.unit !== undefined ? { unit: options.unit } : {}),
    ...(options.denominator !== undefined ? { denominator: options.denominator } : {}),
    ...(options.period !== undefined ? { period: options.period } : {}),
    ...(options.notes !== undefined ? { notes: options.notes } : {})
  });
}

export function legacyNotRecorded(period?: string): MeasuredNumber {
  return measured(null, "legacy_not_recorded", {
    ...(period ? { period } : {}),
    notes: ["historical field missing; not estimated"]
  });
}

export function zeroSafety(provenance: MetricProvenance, period: string): MeasuredNumber {
  return measured(0, provenance, {
    denominator: 1,
    period,
    notes: ["safety SLO target 0"]
  });
}

const SAFETY_FIELDS = [
  "silent_paid_spend",
  "unauthorized_auto_approval",
  "unauthorized_submit",
  "unauthorized_external_submit",
  "over_budget_execution",
  "duplicate_paid_submit",
  "submission_unknown_resubmit",
  "model_connection_silent_fallback",
  "unknown_price_execution",
  "stale_artifact_acceptance",
  "gate_digest_mismatch_execution",
  "unverified_media_pinned",
  "secret_or_prompt_public_leak",
  "role_direct_coordinator_write"
] as const;

/**
 * Decision events that count toward human interventions.
 * Awaiting-node counts are NOT interventions — only actual decision records.
 */
export type InterventionDecisionEvent = {
  kind: "gate" | "selection" | "identity" | "recovery" | "completion";
  decision_id: string;
  subject_digest: string;
  category?: "mandatory_safety" | "operational" | "creative";
};

/**
 * Safety SLO zeros require exact evidence digests + provenance.
 * Boolean observed:true alone never proves 0.
 */
export type SafetySloProof = {
  observed: true;
  /** Digest over EventStore evidence sequence used for the counters. */
  event_store_digest: string;
  /** Grant ledger digest when paid recovery is in scope; optional otherwise. */
  grant_ledger_digest?: string;
  /** Generation job evidence digest when jobs are in scope. */
  job_evidence_digest?: string;
  /** Gate decision evidence digest when gates are in scope. */
  gate_evidence_digest?: string;
  source_event_sequence: number;
  notes?: string[];
};

export type ProjectMissionMetricsInput = {
  production_id: string;
  tree_revision: number;
  source_event_sequence: number;
  computed_at: string;
  evaluation_window: MissionMetricsV1["evaluation_window"];
  mission_state?: MissionState;
  /** Optional observed values; omit/null keeps unknown (never coerced to 0). */
  observations?: {
    flow?: Partial<Record<keyof MissionMetricsV1["flow"], number | null>>;
    intervention?: Partial<Record<keyof MissionMetricsV1["intervention"], number | null>>;
    recovery?: Partial<Record<keyof MissionMetricsV1["recovery"], number | null>>;
    cost?: Partial<{
      actual_generation_credits: number | null;
      quality_per_credit: number | null;
      gate2_issue_count: number | null;
      gate3_issue_count: number | null;
      rework_count: number | null;
      zero_credit_local: boolean;
    }>;
    mv?: Partial<Record<keyof NonNullable<MissionMetricsV1["mv"]>, number | null>>;
    consistency?: MissionMetricsV1["consistency"];
    /** Safety counters — default 0 when provenance can prove it; otherwise null. */
    safety?: Partial<Record<(typeof SAFETY_FIELDS)[number], number | null>>;
  };
  /**
   * Human decision events (Gate/selection/identity/recovery/completion).
   * Deduped by decision_id + subject_digest. Never derived from awaiting node counts.
   */
  intervention_events?: InterventionDecisionEvent[];
  /**
   * Explicit safety proof for zero-count SLOs.
   * Requires event_store_digest + source_event_sequence; observed:true alone is insufficient.
   */
  safety_proof?: SafetySloProof | { observed: false };
};

/** True only when safety zeros are backed by exact evidence digests. */
export function isSafetyZeroProven(proof: ProjectMissionMetricsInput["safety_proof"]): proof is SafetySloProof {
  if (!proof || proof.observed !== true) return false;
  const full = proof as SafetySloProof;
  if (typeof full.source_event_sequence !== "number" || full.source_event_sequence < 0) return false;
  if (!digestSchema.safeParse(full.event_store_digest).success) return false;
  for (const optional of [
    full.grant_ledger_digest,
    full.job_evidence_digest,
    full.gate_evidence_digest
  ] as const) {
    if (optional !== undefined && !digestSchema.safeParse(optional).success) return false;
  }
  return true;
}

/**
 * Count unique human interventions from decision events (not awaiting node counts).
 */
export function countHumanInterventions(
  events: readonly InterventionDecisionEvent[] | undefined
): {
  total: number;
  mandatory_safety: number;
  operational: number;
  creative: number;
} | null {
  if (!events) return null;
  const seen = new Set<string>();
  let total = 0;
  let mandatory_safety = 0;
  let operational = 0;
  let creative = 0;
  for (const event of events) {
    const key = `${event.decision_id}\0${event.subject_digest}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total += 1;
    if (event.category === "mandatory_safety" || event.kind === "gate" || event.kind === "completion") {
      mandatory_safety += 1;
    } else if (event.category === "creative" || event.kind === "selection" || event.kind === "identity") {
      creative += 1;
    } else {
      operational += 1;
    }
  }
  return { total, mandatory_safety, operational, creative };
}

function pickMeasured(
  observations: Record<string, number | null> | undefined,
  key: string,
  provenance: MetricProvenance,
  period: string,
  denominator?: number | null
): MeasuredNumber {
  if (!observations || !(key in observations)) {
    return measured(null, provenance === "legacy_not_recorded" ? "legacy_not_recorded" : provenance, {
      period,
      denominator: denominator ?? null,
      notes: ["not measured"]
    });
  }
  return measured(observations[key] ?? null, provenance, {
    period,
    denominator: denominator ?? null
  });
}

/**
 * Project MissionMetricsV1 from mission state + optional observations.
 * Does not mutate Gate / task / job state.
 */
export function projectMissionMetrics(input: ProjectMissionMetricsInput): MissionMetricsV1 {
  const provenance = input.evaluation_window.provenance;
  const period = input.evaluation_window.period;
  const obs = input.observations ?? {};

  // Derive some flow facts from mission state when present (deterministic).
  const nodes = input.mission_state ? Object.values(input.mission_state.nodes) : [];
  const staleCount = nodes.filter((node) => node.status === "stale" || node.stale).length;
  const outcomeUnknown = nodes.filter((node) => node.status === "outcome_unknown").length;
  // Human interventions come from decision events only — never awaiting-node counts.
  const interventionCounts = countHumanInterventions(input.intervention_events);
  const safetyProof = isSafetyZeroProven(input.safety_proof) ? input.safety_proof : undefined;

  const flowObs = {
    stale_fan_out: obs.flow?.stale_fan_out ?? (input.mission_state ? staleCount : null),
    ...obs.flow
  };

  const safetyProvenance = provenance;
  const safety: MissionMetricsV1["safety"] = {} as MissionMetricsV1["safety"];
  for (const field of SAFETY_FIELDS) {
    const observed = obs.safety?.[field];
    if (observed !== undefined) {
      safety[field] = measured(observed, safetyProvenance, {
        period,
        denominator: 1,
        notes: ["explicit observation"]
      });
    } else if (safetyProof) {
      safety[field] = measured(0, safetyProvenance, {
        period,
        denominator: 1,
        notes: [
          "safety SLO target 0",
          `event_store_digest=${safetyProof.event_store_digest.slice(0, 12)}`,
          `source_event_sequence=${safetyProof.source_event_sequence}`
        ]
      });
    } else if (provenance === "legacy_not_recorded") {
      safety[field] = legacyNotRecorded(period);
    } else {
      // Unknown is not 0. observed:true without digests stays unknown.
      safety[field] = measured(null, safetyProvenance, {
        period,
        denominator: 1,
        notes: [
          input.safety_proof && "observed" in input.safety_proof && input.safety_proof.observed
            ? "safety observed:true without event_store_digest/provenance is not proof"
            : "safety counter not proven; left unknown"
        ]
      });
    }
  }

  // Recovery rate: unknown numerator or denominator stays unknown; never 0/0 → 100%.
  const eligible = obs.recovery?.eligible_recovery_attempts ?? null;
  const successful = obs.recovery?.successful_recovery_attempts ?? null;
  let recoveryRate: number | null = null;
  if (eligible !== null && successful !== null) {
    if (eligible === 0) {
      recoveryRate = null; // no eligible attempts → not 100%
    } else {
      recoveryRate = successful / eligible;
    }
  }

  const draft = {
    schema_version: 1 as const,
    production_id: input.production_id,
    tree_revision: input.tree_revision,
    source_event_sequence: input.source_event_sequence,
    flow: {
      mission_elapsed_ms: pickMeasured(flowObs, "mission_elapsed_ms", provenance, period),
      active_work_ms: pickMeasured(flowObs, "active_work_ms", provenance, period),
      human_wait_ms: pickMeasured(flowObs, "human_wait_ms", provenance, period),
      provider_wait_ms: pickMeasured(flowObs, "provider_wait_ms", provenance, period),
      critical_path_ms: pickMeasured(flowObs, "critical_path_ms", provenance, period),
      pause_count: pickMeasured(flowObs, "pause_count", provenance, period),
      resume_success_rate: pickMeasured(flowObs, "resume_success_rate", provenance, period),
      resume_time_ms: pickMeasured(flowObs, "resume_time_ms", provenance, period),
      stale_fan_out: pickMeasured(flowObs, "stale_fan_out", provenance, period),
      branch_reuse_rate: pickMeasured(flowObs, "branch_reuse_rate", provenance, period)
    },
    intervention: {
      human_interventions_total: pickMeasured(
        {
          human_interventions_total:
            obs.intervention?.human_interventions_total
            ?? (interventionCounts ? interventionCounts.total : null)
        },
        "human_interventions_total",
        provenance,
        period,
        interventionCounts ? interventionCounts.total : null
      ),
      mandatory_safety_interventions: pickMeasured(
        {
          mandatory_safety_interventions:
            obs.intervention?.mandatory_safety_interventions
            ?? (interventionCounts ? interventionCounts.mandatory_safety : null)
        },
        "mandatory_safety_interventions",
        provenance,
        period
      ),
      operational_interventions: pickMeasured(
        {
          operational_interventions:
            obs.intervention?.operational_interventions
            ?? (interventionCounts ? interventionCounts.operational : null)
        },
        "operational_interventions",
        provenance,
        period
      ),
      creative_interventions: pickMeasured(
        {
          creative_interventions:
            obs.intervention?.creative_interventions
            ?? (interventionCounts ? interventionCounts.creative : null)
        },
        "creative_interventions",
        provenance,
        period
      )
    },
    recovery: {
      eligible_recovery_attempts: measured(eligible, provenance, { period }),
      successful_recovery_attempts: measured(successful, provenance, {
        period,
        denominator: eligible
      }),
      automatic_recovery_success_rate: measured(recoveryRate, provenance, {
        period,
        denominator: eligible,
        notes: eligible === 0 ? ["no eligible attempts; rate undefined"] : undefined
      }),
      local_recovery_success: pickMeasured(
        obs.recovery as Record<string, number | null> | undefined,
        "local_recovery_success",
        provenance,
        period
      ),
      paid_regeneration_success: pickMeasured(
        obs.recovery as Record<string, number | null> | undefined,
        "paid_regeneration_success",
        provenance,
        period
      ),
      escalation_rate: pickMeasured(
        obs.recovery as Record<string, number | null> | undefined,
        "escalation_rate",
        provenance,
        period
      ),
      grant_exhaustion_rate: pickMeasured(
        obs.recovery as Record<string, number | null> | undefined,
        "grant_exhaustion_rate",
        provenance,
        period
      ),
      submission_unknown_stops: measured(
        obs.recovery?.submission_unknown_stops ?? (input.mission_state ? outcomeUnknown : null),
        provenance,
        { period }
      )
    },
    consistency: obs.consistency
      ?? {
          coverage: { evaluated_shots: 0, expected_shots: 0 }
        },
    cost: {
      actual_generation_credits: measured(
        obs.cost?.actual_generation_credits ?? null,
        provenance,
        { period, notes: ["unknown credits are not treated as 0"] }
      ),
      quality_per_credit: measured(obs.cost?.quality_per_credit ?? null, provenance, {
        period,
        notes:
          obs.cost?.zero_credit_local
            ? ["zero-credit-local; quality_per_credit not defined"]
            : undefined
      }),
      gate2_issue_count: measured(obs.cost?.gate2_issue_count ?? null, provenance, { period }),
      gate3_issue_count: measured(obs.cost?.gate3_issue_count ?? null, provenance, { period }),
      rework_count: measured(obs.cost?.rework_count ?? null, provenance, { period }),
      zero_credit_local: obs.cost?.zero_credit_local ?? false
    },
    ...(obs.mv
      ? {
          mv: {
            audio_video_duration_delta_ms: measured(
              obs.mv.audio_video_duration_delta_ms ?? null,
              provenance,
              { period }
            ),
            unit_binding_violation_count: measured(
              obs.mv.unit_binding_violation_count ?? null,
              provenance,
              { period }
            ),
            clip_timeline_gap_count: measured(obs.mv.clip_timeline_gap_count ?? null, provenance, {
              period
            }),
            clip_timeline_overlap_count: measured(
              obs.mv.clip_timeline_overlap_count ?? null,
              provenance,
              { period }
            ),
            lyric_timing_coverage: measured(obs.mv.lyric_timing_coverage ?? null, provenance, {
              period
            }),
            beat_anchor_coverage: measured(obs.mv.beat_anchor_coverage ?? null, provenance, {
              period
            }),
            human_lyric_text_corrections: measured(
              obs.mv.human_lyric_text_corrections ?? null,
              provenance,
              { period }
            ),
            human_lyric_timing_corrections: measured(
              obs.mv.human_lyric_timing_corrections ?? null,
              provenance,
              { period }
            )
          }
        }
      : {}),
    safety,
    computed_at: input.computed_at,
    evaluation_window: input.evaluation_window
  };

  return missionMetricsSchema.parse({
    ...draft,
    digest: sha256Canonical(draft)
  });
}

/** All safety SLOs must be explicitly 0 (not null/unknown). */
export function assertSafetySlosZero(metrics: MissionMetricsV1): void {
  const parsed = missionMetricsSchema.parse(metrics);
  for (const field of SAFETY_FIELDS) {
    const entry = parsed.safety[field];
    if (entry.value !== 0) {
      throw pcError("PC_SCHEMA_INVALID", `safety SLO ${field} must be 0`, {
        value: entry.value === null ? "null" : entry.value
      });
    }
  }
}

export function safetySloViolations(metrics: MissionMetricsV1): string[] {
  const parsed = missionMetricsSchema.parse(metrics);
  const violations: string[] = [];
  for (const field of SAFETY_FIELDS) {
    const entry = parsed.safety[field];
    if (entry.value === null) {
      violations.push(`${field}:unknown`);
    } else if (entry.value !== 0) {
      violations.push(`${field}:${entry.value}`);
    }
  }
  return violations;
}

export function parseMissionMetrics(input: unknown): MissionMetricsV1 {
  return missionMetricsSchema.parse(input);
}

/**
 * Refuse mixing fixture/replay metric windows with production windows in one report.
 */
export function assertSingleProvenanceWindow(
  metrics: readonly MissionMetricsV1[]
): MetricProvenance | null {
  if (metrics.length === 0) return null;
  const provenances = new Set(metrics.map((item) => item.evaluation_window.provenance));
  const hasFixtureFamily = [...provenances].some((item) =>
    item === "fixture" || item === "replay" || item === "shadow"
  );
  const hasProduction = provenances.has("production");
  if (hasFixtureFamily && hasProduction) {
    throw pcError(
      "PC_SCHEMA_INVALID",
      "fixture/replay/shadow metrics must not be mixed with production metrics"
    );
  }
  return metrics[0]!.evaluation_window.provenance;
}
