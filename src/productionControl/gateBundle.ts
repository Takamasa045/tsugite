/**
 * GateBundleV1 — hierarchical plan binding for Gate 1 approval and execution.
 * Pure contract: no network, Gate mutation, or provider traffic.
 */
import { z } from "zod";
import { assertSafeJsonValue, sha256Canonical, withoutField } from "./canonical.js";
import { pcError } from "./errors.js";
import { routeIdentitySchema, type RouteIdentity } from "./programBinding.js";
import { digestSchema, safeIdSchema } from "./schema.js";

const finiteNumber = z.number().refine(Number.isFinite, "finite number required");
const nonNegativeInt = finiteNumber.int().nonnegative();

export const gatePricingSchema = z.object({
  status: z.enum(["known", "unknown", "not-applicable"]),
  version: z.string().min(1).max(128).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  amount: finiteNumber.nonnegative().nullable(),
  max_amount: finiteNumber.nonnegative().nullable(),
  /**
   * Explicit zero-cost policy id. Required when known amount=0 and max_amount=0.
   * Bound into pricing_binding_digest so silent 0/0 cannot forge membership.
   */
  zero_cost_policy_id: z.string().min(1).max(128).optional()
}).strict().superRefine((pricing, context) => {
  if (pricing.status === "known") {
    if (pricing.version === null || pricing.currency === null || pricing.amount === null || pricing.max_amount === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "known pricing requires version, currency, amount, and max_amount" });
    }
    if (pricing.amount === 0 && pricing.max_amount === 0 && !pricing.zero_cost_policy_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["zero_cost_policy_id"],
        message: "known amount=0 and max_amount=0 requires zero_cost_policy_id"
      });
    }
  }
  if (pricing.status === "unknown") {
    if (pricing.amount !== null || pricing.max_amount !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "unknown pricing must not claim amount or max_amount" });
    }
    if (pricing.zero_cost_policy_id !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["zero_cost_policy_id"],
        message: "unknown pricing must not claim zero_cost_policy_id"
      });
    }
  }
  if (pricing.status === "not-applicable") {
    if (pricing.version !== null || pricing.currency !== null || pricing.amount !== null || pricing.max_amount !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "not-applicable pricing must null all money fields" });
    }
    if (pricing.zero_cost_policy_id !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["zero_cost_policy_id"],
        message: "not-applicable pricing must not claim zero_cost_policy_id"
      });
    }
  }
});
export type GatePricing = z.infer<typeof gatePricingSchema>;

export const gateOrderedUnitSchema = z.object({
  ordinal: nonNegativeInt,
  generation_unit_digest: digestSchema,
  base_compilation_digest: digestSchema,
  /** Exact batch route digest this unit is bound to; required for mixed-route rejection. */
  route_digest: digestSchema.optional(),
  program_start_ms: nonNegativeInt.optional(),
  program_end_ms: finiteNumber.int().positive().optional()
}).strict().superRefine((unit, context) => {
  if (unit.program_start_ms !== undefined && unit.program_end_ms !== undefined && unit.program_end_ms <= unit.program_start_ms) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["program_end_ms"], message: "program end must be after start" });
  }
  if ((unit.program_start_ms === undefined) !== (unit.program_end_ms === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "program range must provide both start and end or neither" });
  }
});
export type GateOrderedUnit = z.infer<typeof gateOrderedUnitSchema>;

export const generationBatchSchema = z.object({
  batch_id: safeIdSchema,
  route: routeIdentitySchema,
  ordered_units: z.array(gateOrderedUnitSchema).min(1).max(256),
  pricing: gatePricingSchema,
  pricing_binding_digest: digestSchema,
  estimated_credits: finiteNumber.nonnegative().optional(),
  regeneration_policy_spec_digest: digestSchema.optional()
}).strict().superRefine((batch, context) => {
  const ordinals = batch.ordered_units.map((unit) => unit.ordinal);
  if (new Set(ordinals).size !== ordinals.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["ordered_units"], message: "batch ordinals must be unique" });
  }
  for (let index = 1; index < batch.ordered_units.length; index += 1) {
    if (batch.ordered_units[index]!.ordinal <= batch.ordered_units[index - 1]!.ordinal) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ordered_units", index, "ordinal"],
        message: "ordered_units must be strictly ascending by ordinal"
      });
    }
  }
  const expectedPricingDigest = pricingBindingDigest(batch.pricing, batch.route);
  if (batch.pricing_binding_digest !== expectedPricingDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["pricing_binding_digest"], message: "pricing binding digest mismatch" });
  }
  if (batch.pricing.status === "known"
    && batch.pricing.amount !== null
    && batch.pricing.max_amount !== null
    && batch.pricing.amount > batch.pricing.max_amount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pricing", "amount"],
      message: "known pricing amount must be <= max_amount"
    });
  }
  for (let index = 0; index < batch.ordered_units.length; index += 1) {
    const unit = batch.ordered_units[index]!;
    if (unit.route_digest !== undefined && unit.route_digest !== batch.route.route_digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ordered_units", index, "route_digest"],
        message: "generation batch cannot mix RouteIdentity values"
      });
    }
  }
});
export type GenerationBatch = z.infer<typeof generationBatchSchema>;

export const gateBundleSchema = z.object({
  schema_version: z.literal(1),
  production_id: safeIdSchema,
  run_id: safeIdSchema,
  production_contract_digest: digestSchema,
  contract_set_digest: digestSchema,
  task_tree_digest: digestSchema,
  selected_artifact_digests: z.array(digestSchema).max(256),
  composition_intent_digest: digestSchema.optional(),
  generation_batches: z.array(generationBatchSchema).max(64),
  review_artifact_digest: digestSchema,
  digest: digestSchema
}).strict().superRefine((bundle, context) => {
  const batchIds = bundle.generation_batches.map((batch) => batch.batch_id);
  if (new Set(batchIds).size !== batchIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["generation_batches"], message: "batch ids must be unique" });
  }
  // Array order is part of the approval subject; never re-sort for digest.
  if (sha256Canonical(withoutField(bundle, "digest")) !== bundle.digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "gate bundle digest mismatch" });
  }
});
export type GateBundle = z.infer<typeof gateBundleSchema>;
export type GateBundleV1 = GateBundle;

export type GateBundleInput = {
  production_id: string;
  run_id: string;
  production_contract_digest: string;
  contract_set_digest: string;
  task_tree_digest: string;
  selected_artifact_digests: string[];
  composition_intent_digest?: string;
  generation_batches: Array<Omit<GenerationBatch, "pricing_binding_digest"> & { pricing_binding_digest?: string }>;
  review_artifact_digest: string;
};

/** Exact pricing subject used by Gate approval and job immutable identity. */
export function pricingBindingDigest(pricing: GatePricing, route: RouteIdentity): string {
  return sha256Canonical({
    kind: "gate-pricing-binding",
    schema_version: 1,
    status: pricing.status,
    version: pricing.version,
    currency: pricing.currency,
    amount: pricing.amount,
    max_amount: pricing.max_amount,
    ...(pricing.zero_cost_policy_id ? { zero_cost_policy_id: pricing.zero_cost_policy_id } : {}),
    route_digest: route.route_digest
  });
}

export function createGateBundle(input: GateBundleInput): GateBundle {
  const batches = input.generation_batches.map((batch) => {
    const route = routeIdentitySchema.parse(batch.route);
    const pricing = gatePricingSchema.parse(batch.pricing);
    if (pricing.status === "known"
      && pricing.amount !== null
      && pricing.max_amount !== null
      && pricing.amount > pricing.max_amount) {
      throw pcError("PC_GATE_BUNDLE_INVALID", "known pricing amount must be <= max_amount", {
        batch_id: batch.batch_id
      });
    }
    if (
      pricing.status === "known"
      && pricing.amount === 0
      && pricing.max_amount === 0
      && !pricing.zero_cost_policy_id
    ) {
      throw pcError(
        "PC_GATE_BUNDLE_INVALID",
        "known amount=0 and max_amount=0 requires zero_cost_policy_id",
        { batch_id: batch.batch_id }
      );
    }
    const pricingDigest = batch.pricing_binding_digest ?? pricingBindingDigest(pricing, route);
    // Bind every ordered unit to this batch route digest (reject mixed routes in createGateBundle itself).
    const ordered_units = batch.ordered_units.map((unit) => {
      const routeDigest = unit.route_digest ?? route.route_digest;
      if (routeDigest !== route.route_digest) {
        throw pcError("PC_GATE_BUNDLE_INVALID", "generation batch cannot mix RouteIdentity values", {
          batch_id: batch.batch_id
        });
      }
      return { ...unit, route_digest: routeDigest };
    });
    return generationBatchSchema.parse({
      ...batch,
      route,
      pricing,
      ordered_units,
      pricing_binding_digest: pricingDigest
    });
  });
  assertHomogeneousBatchRoutes(batches);
  const hasProgramRanges = batches.some((batch) =>
    batch.ordered_units.some((unit) => unit.program_start_ms !== undefined || unit.program_end_ms !== undefined)
  );
  if (hasProgramRanges && !input.composition_intent_digest) {
    throw pcError(
      "PC_GATE_BUNDLE_INVALID",
      "MV GateBundle requires composition_intent_digest with program ranges"
    );
  }
  const candidate = {
    schema_version: 1 as const,
    production_id: input.production_id,
    run_id: input.run_id,
    production_contract_digest: input.production_contract_digest,
    contract_set_digest: input.contract_set_digest,
    task_tree_digest: input.task_tree_digest,
    selected_artifact_digests: [...input.selected_artifact_digests],
    ...(input.composition_intent_digest ? { composition_intent_digest: input.composition_intent_digest } : {}),
    generation_batches: batches,
    review_artifact_digest: input.review_artifact_digest
  };
  assertSafeJsonValue(candidate, "gate bundle");
  return gateBundleSchema.parse({
    ...candidate,
    digest: sha256Canonical(candidate)
  });
}

export function parseGateBundle(input: unknown): GateBundle {
  try {
    const parsed = gateBundleSchema.parse(input);
    assertHomogeneousBatchRoutes(parsed.generation_batches);
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    throw pcError("PC_GATE_BUNDLE_INVALID", "invalid gate bundle");
  }
}

export function gateBundleDigest(bundle: GateBundle): string {
  return parseGateBundle(bundle).digest;
}

/**
 * One batch carries exactly one RouteIdentity. Callers that collect units across
 * routes must split them into separate batches; mixing digests is rejected.
 */
export function assertHomogeneousBatchRoutes(batches: readonly GenerationBatch[]): void {
  for (const batch of batches) {
    if (sha256Canonical(withoutField(batch.route, "route_digest")) !== batch.route.route_digest) {
      throw pcError("PC_GATE_BUNDLE_INVALID", "route identity digest is stale");
    }
  }
}

/** Reject when unit routes do not all equal the batch route. */
export function assertUnitsMatchBatchRoute(
  batchRoute: RouteIdentity,
  unitRoutes: readonly RouteIdentity[]
): void {
  const expected = routeIdentityKey(batchRoute);
  for (const route of unitRoutes) {
    if (routeIdentityKey(route) !== expected) {
      throw pcError("PC_GATE_BUNDLE_INVALID", "generation batch cannot mix RouteIdentity values");
    }
  }
}

export function routeIdentityKey(route: RouteIdentity): string {
  return [
    route.ir_model,
    route.provider_model,
    route.model_profile_digest,
    route.connection_id,
    route.connection_digest,
    route.adapter_id,
    route.transport,
    route.mode_binding,
    route.route_digest
  ].join("\0");
}

/** Build batches from units; mixed routes become separate batches or reject-if-single-batch. */
export function groupUnitsByRoute<T extends { route: RouteIdentity }>(
  units: readonly T[]
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const unit of units) {
    const key = routeIdentityKey(unit.route);
    const list = groups.get(key) ?? [];
    list.push(unit);
    groups.set(key, list);
  }
  return groups;
}

/**
 * Unknown price may be shown in review, but never approved or executed.
 * Known / not-applicable batches are executable when Gate 1 is current.
 */
export function assertGateBundleExecutable(bundle: GateBundle): void {
  const parsed = parseGateBundle(bundle);
  for (const batch of parsed.generation_batches) {
    if (batch.pricing.status === "unknown") {
      throw pcError("PC_GATE_BUNDLE_INVALID", "unknown price cannot be approved or executed", {
        batch_id: batch.batch_id
      });
    }
  }
}

export function gateBundleHasUnknownPrice(bundle: GateBundle): boolean {
  return parseGateBundle(bundle).generation_batches.some((batch) => batch.pricing.status === "unknown");
}

export function requireMvCompositionIntent(bundle: GateBundle): void {
  const parsed = parseGateBundle(bundle);
  if (parsed.generation_batches.some((batch) => batch.ordered_units.some((unit) => unit.program_start_ms !== undefined))) {
    if (!parsed.composition_intent_digest) {
      throw pcError("PC_GATE_BUNDLE_INVALID", "MV GateBundle requires composition_intent_digest with program ranges");
    }
    for (const batch of parsed.generation_batches) {
      for (const unit of batch.ordered_units) {
        if (unit.program_start_ms === undefined || unit.program_end_ms === undefined) {
          throw pcError("PC_GATE_BUNDLE_INVALID", "MV ordered units require complete program ranges");
        }
      }
    }
  }
}

/** Secret-free review projection for Gate 1; never includes prompts or absolute paths. */
export function projectGateBundleForReview(bundle: GateBundle): {
  production_id: string;
  run_id: string;
  digest: string;
  batch_count: number;
  unit_count: number;
  has_unknown_price: boolean;
  composition_intent_bound: boolean;
  routes: Array<{ batch_id: string; route_digest: string; connection_id: string; adapter_id: string }>;
} {
  const parsed = parseGateBundle(bundle);
  return {
    production_id: parsed.production_id,
    run_id: parsed.run_id,
    digest: parsed.digest,
    batch_count: parsed.generation_batches.length,
    unit_count: parsed.generation_batches.reduce((sum, batch) => sum + batch.ordered_units.length, 0),
    has_unknown_price: gateBundleHasUnknownPrice(parsed),
    composition_intent_bound: Boolean(parsed.composition_intent_digest),
    routes: parsed.generation_batches.map((batch) => ({
      batch_id: batch.batch_id,
      route_digest: batch.route.route_digest,
      connection_id: batch.route.connection_id,
      adapter_id: batch.route.adapter_id
    }))
  };
}
