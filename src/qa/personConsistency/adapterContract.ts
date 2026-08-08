/**
 * Semantic-QA adapter capability contract (class: semantic-qa).
 * Separated from generation and editorial analysis adapters.
 */
import { z } from "zod";
import type { Issue, Result } from "../../types.js";
import {
  PERSON_CONSISTENCY_ADAPTER_CLASS,
  personTraitSchema,
  type PersonTrait
} from "./schema.js";

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const semanticQaNetworkScopeSchema = z.enum([
  "none",
  "request-metadata",
  "sampled-frames",
  "source-media"
]);
export type SemanticQaNetworkScope = z.infer<typeof semanticQaNetworkScopeSchema>;

export const semanticQaCapabilitySchema = z
  .object({
    class: z.literal(PERSON_CONSISTENCY_ADAPTER_CLASS),
    name: z.string().min(1),
    traits: z.array(personTraitSchema).min(1),
    multi_subject_tracking: z.boolean(),
    occlusion_handling: z.boolean(),
    offline: z.boolean(),
    model: z.string().min(1),
    version: z.string().min(1),
    weights_sha256: sha256HexSchema.optional(),
    license: z.string().min(1).optional(),
    calibration_revision: z.string().min(1).optional(),
    network_input_scope: semanticQaNetworkScopeSchema,
    /** Must be false for production-safe adapters in this phase. */
    retains_biometric_embeddings: z.literal(false),
    cost_estimate: z
      .object({
        currency: z.string().min(1).optional(),
        per_run: z.number().nonnegative().optional(),
        notes: z.string().min(1).optional()
      })
      .strict()
      .optional(),
    retry_policy: z
      .object({
        max_attempts: z.number().int().nonnegative(),
        retryable_codes: z.array(z.string().min(1)).default([])
      })
      .strict()
  })
  .strict();

export type SemanticQaCapability = z.infer<typeof semanticQaCapabilitySchema>;

/** Adapter input: only declared fields; embeddings rejected. */
export const semanticQaAdapterInputSchema = z
  .object({
    stage: z.enum(["gate_2", "gate_3"]),
    input_digest: sha256HexSchema,
    sampling_plan: z.array(
      z
        .object({
          shot_id: z.string().min(1),
          timestamp_ms: z.number().int().nonnegative(),
          role: z.enum(["boundary_start", "boundary_end", "uniform"])
        })
        .strict()
    ),
    subjects: z.array(
      z
        .object({
          subject_id: z.string().min(1),
          required_traits: z.array(personTraitSchema),
          advisory_traits: z.array(personTraitSchema),
          basis: z.enum(["reference", "relative-only"]),
          reference_asset_hash: sha256HexSchema.optional(),
          reference_region: z
            .object({
              x: z.number().min(0).max(1),
              y: z.number().min(0).max(1),
              width: z.number().min(0).max(1),
              height: z.number().min(0).max(1)
            })
            .strict()
            .optional()
        })
        .strict()
    ),
    media: z
      .object({
        clip_relative_path: z.string().min(1).optional(),
        final_relative_path: z.string().min(1).optional(),
        request_id: z.string().min(1).optional()
      })
      .strict()
  })
  .strict()
  .superRefine((input, context) => {
    if (hasForbiddenEmbeddingField(input)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "adapter input must not contain embedding vectors"
      });
    }
  });

export type SemanticQaAdapterInput = z.infer<typeof semanticQaAdapterInputSchema>;

export function parseSemanticQaCapability(
  input: unknown
): Result<{ capability: SemanticQaCapability }> {
  const parsed = semanticQaCapabilitySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.capability_invalid",
          message: parsed.error.issues[0]?.message ?? "invalid semantic-qa capability"
        }
      ]
    };
  }
  if (parsed.data.retains_biometric_embeddings !== false) {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.capability_invalid",
          message: "retains_biometric_embeddings must be false"
        }
      ]
    };
  }
  return { ok: true, issues: [], capability: parsed.data };
}

export function parseSemanticQaAdapterInput(
  input: unknown
): Result<{ input: SemanticQaAdapterInput }> {
  const parsed = semanticQaAdapterInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.adapter_input_invalid",
          message: parsed.error.issues[0]?.message ?? "invalid semantic-qa adapter input"
        }
      ]
    };
  }
  return { ok: true, issues: [], input: parsed.data };
}

/**
 * Required traits not declared by the adapter capability -> capability_missing.
 */
export function checkRequiredTraitsSupported(
  capability: SemanticQaCapability,
  required: readonly PersonTrait[]
): Issue[] {
  const supported = new Set(capability.traits);
  const missing = required.filter((trait) => !supported.has(trait));
  if (missing.length === 0) return [];
  return [
    {
      code: "person_qa.capability_missing",
      message: `semantic-qa adapter '${capability.name}' does not support required traits: ${missing.join(", ")}`
    }
  ];
}

const FORBIDDEN = new Set([
  "embedding",
  "embeddings",
  "face_embedding",
  "face_embeddings",
  "biometric_embedding",
  "embedding_vector",
  "vector",
  "vectors"
]);

function hasForbiddenEmbeddingField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenEmbeddingField);
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN.has(key)) return true;
    if (hasForbiddenEmbeddingField(child)) return true;
  }
  return false;
}

export interface SemanticQaAdapter {
  readonly capability: SemanticQaCapability;
  /**
   * Produce a report-shaped payload. Implementations must not call network
   * unless capability.network_input_scope !== "none" and external approval exists.
   * This phase only ships offline fixture/manual adapters.
   */
  analyze(input: SemanticQaAdapterInput): Promise<Result<{ payload: unknown }>>;
}
