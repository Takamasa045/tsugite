/**
 * Authoritative GateBundle pricing evidence.
 * Never invent amount/currency from pricing_status alone.
 * Zero-cost requires explicit authoritative amount=0 + max_amount=0 + version + currency.
 */
import { z } from "zod";
import { sha256Canonical } from "./canonical.js";
import type { GatePricing } from "./gateBundle.js";

const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const versionSchema = z.string().min(1).max(128);
const nonNeg = z.number().refine(Number.isFinite, "finite").nonnegative();

/** Exact versioned price body used for GateBundle known pricing. */
export const authoritativePricingBodySchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("authoritative-pricing"),
  version: versionSchema,
  currency: currencySchema,
  amount: nonNeg,
  max_amount: nonNeg,
  /**
   * Optional policy id for explicit zero-cost routes.
   * Required when amount and max_amount are both 0 (not a default invent).
   */
  zero_cost_policy_id: z.string().min(1).max(128).optional()
}).strict().superRefine((value, context) => {
  if (value.amount > value.max_amount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["amount"],
      message: "known pricing amount must be <= max_amount"
    });
  }
  if (value.amount === 0 && value.max_amount === 0 && !value.zero_cost_policy_id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["zero_cost_policy_id"],
      message: "genuine zero-cost pricing requires explicit zero_cost_policy_id evidence"
    });
  }
});
export type AuthoritativePricingBody = z.infer<typeof authoritativePricingBodySchema>;

export type AuthoritativePricingArtifact = AuthoritativePricingBody & {
  digest: string;
};

export function authoritativePricingDigest(body: AuthoritativePricingBody): string {
  return sha256Canonical(body);
}

export function parseAuthoritativePricingArtifact(input: unknown): AuthoritativePricingArtifact | undefined {
  const parsed = authoritativePricingBodySchema.safeParse(input);
  if (!parsed.success) return undefined;
  const digest = authoritativePricingDigest(parsed.data);
  if (
    input
    && typeof input === "object"
    && !Array.isArray(input)
    && "digest" in input
    && typeof (input as { digest: unknown }).digest === "string"
    && (input as { digest: string }).digest !== digest
  ) {
    return undefined;
  }
  return { ...parsed.data, digest };
}

/**
 * Resolve GatePricing from authoritative evidence only.
 * - Complete known artifact/profile fields → known
 * - not-applicable status with no money fields → not-applicable
 * - pricing_status=known without exact amounts → unknown (never invent 0)
 * - incomplete / absent → unknown
 */
export function resolveAuthoritativeGatePricing(input: {
  /** Advisory status from connection profile; never invents amounts. */
  pricing_status?: string | null;
  /**
   * Exact versioned pricing artifact/profile fields.
   * Must include version, currency, amount, max_amount for known status.
   */
  authoritative?: {
    version?: string | null;
    currency?: string | null;
    amount?: number | null;
    max_amount?: number | null;
    zero_cost_policy_id?: string | null;
    digest?: string | null;
  } | null;
}): GatePricing {
  const auth = input.authoritative;
  if (auth) {
    const candidate = {
      schema_version: 1 as const,
      kind: "authoritative-pricing" as const,
      version: auth.version ?? undefined,
      currency: auth.currency ?? undefined,
      amount: auth.amount ?? undefined,
      max_amount: auth.max_amount ?? undefined,
      ...(auth.zero_cost_policy_id ? { zero_cost_policy_id: auth.zero_cost_policy_id } : {})
    };
    const parsed = authoritativePricingBodySchema.safeParse(candidate);
    if (parsed.success) {
      const digest = authoritativePricingDigest(parsed.data);
      if (auth.digest && auth.digest !== digest) {
        return unknownPricing();
      }
      return {
        status: "known",
        version: parsed.data.version,
        currency: parsed.data.currency,
        amount: parsed.data.amount,
        max_amount: parsed.data.max_amount,
        ...(parsed.data.zero_cost_policy_id
          ? { zero_cost_policy_id: parsed.data.zero_cost_policy_id }
          : {})
      };
    }
  }

  if (input.pricing_status === "not-applicable") {
    return {
      status: "not-applicable",
      version: null,
      currency: null,
      amount: null,
      max_amount: null
    };
  }

  // pricing_status=known alone is incomplete — never invent USD amount0/max0.
  return unknownPricing();
}

function unknownPricing(): GatePricing {
  return {
    status: "unknown",
    version: null,
    currency: null,
    amount: null,
    max_amount: null
  };
}

/**
 * Extract optional authoritative pricing fields from a connection profile-like object.
 * Additive fields only; missing fields → undefined (fail closed to unknown).
 */
export function extractAuthoritativePricingFromProfile(
  profile: unknown
): {
  pricing_status?: string;
  authoritative?: {
    version?: string | null;
    currency?: string | null;
    amount?: number | null;
    max_amount?: number | null;
    zero_cost_policy_id?: string | null;
    digest?: string | null;
  };
} {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return {};
  }
  const p = profile as Record<string, unknown>;
  const status = typeof p.pricing_status === "string" ? p.pricing_status : undefined;
  // Nested authoritative_pricing object (preferred).
  const nested = p.authoritative_pricing;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const n = nested as Record<string, unknown>;
    return {
      ...(status ? { pricing_status: status } : {}),
      authoritative: {
        version: typeof n.version === "string" ? n.version : null,
        currency: typeof n.currency === "string" ? n.currency : null,
        amount: typeof n.amount === "number" ? n.amount : null,
        max_amount: typeof n.max_amount === "number" ? n.max_amount : null,
        zero_cost_policy_id: typeof n.zero_cost_policy_id === "string" ? n.zero_cost_policy_id : null,
        digest: typeof n.digest === "string" ? n.digest : null
      }
    };
  }
  // Flat additive fields on the profile.
  const hasFlat =
    typeof p.pricing_version === "string"
    || typeof p.pricing_currency === "string"
    || typeof p.pricing_amount === "number"
    || typeof p.pricing_max_amount === "number";
  if (hasFlat) {
    return {
      ...(status ? { pricing_status: status } : {}),
      authoritative: {
        version: typeof p.pricing_version === "string" ? p.pricing_version : null,
        currency: typeof p.pricing_currency === "string" ? p.pricing_currency : null,
        amount: typeof p.pricing_amount === "number" ? p.pricing_amount : null,
        max_amount: typeof p.pricing_max_amount === "number" ? p.pricing_max_amount : null,
        zero_cost_policy_id:
          typeof p.pricing_zero_cost_policy_id === "string" ? p.pricing_zero_cost_policy_id : null,
        digest: typeof p.pricing_digest === "string" ? p.pricing_digest : null
      }
    };
  }
  return status ? { pricing_status: status } : {};
}
