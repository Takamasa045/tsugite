/**
 * Person consistency QA schemas (PersonConsistencyReportV1 and related contracts).
 * Vendor-neutral: no face model or provider-specific terms.
 */
import { z } from "zod";

export const PERSON_CONSISTENCY_SCHEMA_VERSION = "person-consistency-report-v1" as const;
export const PERSON_CONSISTENCY_ADAPTER_CLASS = "semantic-qa" as const;

export const personConsistencyStageSchema = z.enum(["gate_2", "gate_3"]);
export type PersonConsistencyStage = z.infer<typeof personConsistencyStageSchema>;

export const personTraitSchema = z.enum(["identity", "clothing", "hairstyle"]);
export type PersonTrait = z.infer<typeof personTraitSchema>;

export const preservationLevelSchema = z.enum(["strict", "loose"]);
export type PreservationLevel = z.infer<typeof preservationLevelSchema>;

export const traitRequirementLevelSchema = z.enum(["required", "advisory"]);
export type TraitRequirementLevel = z.infer<typeof traitRequirementLevelSchema>;

export const visibilitySchema = z.enum(["visible", "partial", "occluded", "offscreen"]);
export type Visibility = z.infer<typeof visibilitySchema>;

export const faceVisibilitySchema = z.enum(["required", "optional", "not_expected"]);
export type FaceVisibility = z.infer<typeof faceVisibilitySchema>;

export const reportStatusSchema = z.enum(["ok", "review", "not_evaluable", "blocked"]);
export type ReportStatus = z.infer<typeof reportStatusSchema>;

export const evaluationBasisSchema = z.enum(["reference", "relative-only"]);
export type EvaluationBasis = z.infer<typeof evaluationBasisSchema>;

export const traitSummaryStatusSchema = z.enum(["stable", "possible-drift", "not-evaluable"]);
export type TraitSummaryStatus = z.infer<typeof traitSummaryStatusSchema>;

export const personQaHumanDecisionSchema = z.enum([
  "accept",
  "revise",
  "accept-not-evaluable"
]);
export type PersonQaHumanDecisionKind = z.infer<typeof personQaHumanDecisionSchema>;

export const normalizedRegionSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0).max(1),
    height: z.number().min(0).max(1)
  })
  .strict()
  .superRefine((region, context) => {
    if (region.x + region.width > 1 + 1e-9) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "reference_region must stay within [0,1] horizontally",
        path: ["width"]
      });
    }
    if (region.y + region.height > 1 + 1e-9) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "reference_region must stay within [0,1] vertically",
        path: ["height"]
      });
    }
  });

export type NormalizedRegion = z.infer<typeof normalizedRegionSchema>;

export const personConsistencyEvidenceSchema = z
  .object({
    sampling: z.literal("shot-boundaries-and-uniform"),
    frames_per_shot: z.number().int().min(1).max(12),
    /** Biometric embeddings must never be retained. Fixed false. */
    retain_face_embeddings: z.literal(false)
  })
  .strict();

export const personConsistencyExternalPolicySchema = z
  .object({
    allowed: z.boolean().default(false)
  })
  .strict()
  .default({ allowed: false });

/** Project policy: quality.person_consistency */
export const personConsistencyPolicySchema = z
  .object({
    enabled: z.boolean(),
    adapter: z.string().min(1),
    fallback: z.literal("fail"),
    stages: z.array(personConsistencyStageSchema).min(1),
    evidence: personConsistencyEvidenceSchema,
    external: personConsistencyExternalPolicySchema
  })
  .strict();

export type PersonConsistencyPolicyV1 = z.infer<typeof personConsistencyPolicySchema>;

export const subjectConsistencySchema = z
  .object({
    enabled: z.boolean(),
    reference_region: normalizedRegionSchema.optional()
  })
  .strict();

export type SubjectConsistencyConfig = z.infer<typeof subjectConsistencySchema>;

export const subjectExpectationSchema = z
  .object({
    subject_id: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    visibility: visibilitySchema,
    face_visibility: faceVisibilitySchema
  })
  .strict();

export type SubjectExpectation = z.infer<typeof subjectExpectationSchema>;

export const traitRequirementSchema = z
  .object({
    trait: personTraitSchema,
    level: traitRequirementLevelSchema,
    preservation: preservationLevelSchema
  })
  .strict();

export type TraitRequirement = z.infer<typeof traitRequirementSchema>;

export const samplingFrameSchema = z
  .object({
    shot_id: z.string().min(1),
    timestamp_ms: z.number().int().nonnegative(),
    role: z.enum(["boundary_start", "boundary_end", "uniform"])
  })
  .strict();

export type SamplingFrame = z.infer<typeof samplingFrameSchema>;

export const observationSchema = z
  .object({
    timestamp_ms: z.number().int().nonnegative(),
    shot_id: z.string().min(1),
    visibility: visibilitySchema,
    face_evaluable: z.boolean(),
    reason: z.string().min(1),
    bbox: normalizedRegionSchema.optional(),
    track_id: z.string().min(1).optional()
  })
  .strict();

export type PersonObservation = z.infer<typeof observationSchema>;

export const traitSummarySchema = z
  .object({
    trait: personTraitSchema,
    status: traitSummaryStatusSchema,
    level: traitRequirementLevelSchema,
    notes: z.string().min(1).optional()
  })
  .strict();

export type TraitSummary = z.infer<typeof traitSummarySchema>;

export const subjectReportSchema = z
  .object({
    subject_id: z.string().min(1),
    basis: evaluationBasisSchema,
    traits: z.array(traitSummarySchema).min(1),
    observations: z.array(observationSchema),
    evaluable_coverage: z.number().min(0).max(1),
    ambiguity_codes: z.array(z.string().min(1)).default([])
  })
  .strict();

export type SubjectReport = z.infer<typeof subjectReportSchema>;

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const personConsistencyProvenanceSchema = z
  .object({
    adapter: z.string().min(1),
    adapter_class: z.literal(PERSON_CONSISTENCY_ADAPTER_CLASS),
    model: z.string().min(1),
    version: z.string().min(1),
    weights_sha256: sha256HexSchema.optional(),
    license: z.string().min(1).optional(),
    calibration_revision: z.string().min(1).optional(),
    network_used: z.boolean(),
    network_input_scope: z.string().min(1).optional()
  })
  .strict();

export type PersonConsistencyProvenance = z.infer<typeof personConsistencyProvenanceSchema>;

export const personConsistencyArtifactRefsSchema = z
  .object({
    report_relative_path: z
      .string()
      .min(1)
      .refine(
        (value) => !value.startsWith("/") && !value.includes("..") && !value.includes("\\"),
        "must be a safe relative path"
      ),
    contact_sheet_relative_path: z
      .string()
      .min(1)
      .refine(
        (value) => !value.startsWith("/") && !value.includes("..") && !value.includes("\\"),
        "must be a safe relative path"
      )
      .optional()
  })
  .strict();

/**
 * Strict report schema: rejects unknown fields and any biometric embedding payload.
 */
export const personConsistencyReportSchema = z
  .object({
    schema_version: z.literal(PERSON_CONSISTENCY_SCHEMA_VERSION),
    stage: personConsistencyStageSchema,
    status: reportStatusSchema,
    input_digest: sha256HexSchema,
    subject_reference_hashes: z.record(z.string(), sha256HexSchema).default({}),
    tracks: z
      .array(
        z
          .object({
            track_id: z.string().min(1),
            subject_id: z.string().min(1).optional(),
            notes: z.string().min(1).optional()
          })
          .strict()
      )
      .default([]),
    subjects: z.array(subjectReportSchema),
    sampling_plan: z.array(samplingFrameSchema),
    provenance: personConsistencyProvenanceSchema,
    artifacts: personConsistencyArtifactRefsSchema,
    ambiguities: z.array(z.string().min(1)).default([]),
    blocked_reasons: z.array(z.string().min(1)).default([]),
    report_digest: sha256HexSchema.optional()
  })
  .strict()
  .superRefine((report, context) => {
    // Fail closed on any biometric embedding field anywhere in the payload tree.
    const forbidden = findForbiddenBiometricKeys(report);
    if (forbidden) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `biometric field '${forbidden}' is forbidden in person consistency reports`,
        path: ["subjects"]
      });
    }

    // Status integrity: "ok" must not hide drift, ambiguity, or blocked reasons.
    if (report.status === "ok") {
      if (report.ambiguities.length > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "report status 'ok' cannot include ambiguities",
          path: ["ambiguities"]
        });
      }
      if (report.blocked_reasons.length > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "report status 'ok' cannot include blocked_reasons",
          path: ["blocked_reasons"]
        });
      }
      for (const [subjectIndex, subject] of report.subjects.entries()) {
        for (const [traitIndex, trait] of subject.traits.entries()) {
          if (trait.level === "required" && trait.status !== "stable") {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "report status 'ok' requires every required trait to be stable (no possible-drift / not-evaluable)",
              path: ["subjects", subjectIndex, "traits", traitIndex, "status"]
            });
          }
        }
      }
    }
  });

export type PersonConsistencyReportV1 = z.infer<typeof personConsistencyReportSchema>;

export const personQaHumanDecisionRecordSchema = z
  .object({
    decision: personQaHumanDecisionSchema,
    reason: z.string().trim().min(1),
    decided_at: z.string().min(1).optional()
  })
  .strict();

export type PersonQaHumanDecisionRecord = z.infer<typeof personQaHumanDecisionRecordSchema>;

export const personConsistencyGateBindingSchema = z
  .object({
    stage: personConsistencyStageSchema,
    report_relative_path: z.string().min(1),
    report_sha256: sha256HexSchema,
    contact_sheet_relative_path: z.string().min(1).optional(),
    contact_sheet_sha256: sha256HexSchema.optional(),
    human_decision: personQaHumanDecisionRecordSchema.optional()
  })
  .strict();

export type PersonConsistencyGateBinding = z.infer<typeof personConsistencyGateBindingSchema>;

const FORBIDDEN_BIOMETRIC_KEYS = new Set([
  "embedding",
  "embeddings",
  "face_embedding",
  "face_embeddings",
  "biometric_embedding",
  "biometric_embeddings",
  "embedding_vector",
  "embedding_vectors",
  "vector",
  "vectors"
]);

function findForbiddenBiometricKeys(value: unknown, path = ""): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const hit = findForbiddenBiometricKeys(child, `${path}[${index}]`);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_BIOMETRIC_KEYS.has(key)) return key;
    const hit = findForbiddenBiometricKeys(child, path ? `${path}.${key}` : key);
    if (hit) return hit;
  }
  return undefined;
}

export function parsePersonConsistencyReport(
  input: unknown
): { ok: true; report: PersonConsistencyReportV1 } | { ok: false; message: string } {
  const parsed = personConsistencyReportSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "invalid person consistency report"
    };
  }
  return { ok: true, report: parsed.data };
}
