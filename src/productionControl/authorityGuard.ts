/**
 * AuthorityGuard — effect-class checks before dispatcher execution.
 * Never trusts caller booleans alone. Paid is unconditionally denied until PO-6.
 * Gate 1/3 always require sealed human decision subjects.
 */
import { pcError } from "./errors.js";
import {
  assertGateBundleExecutable,
  gateBundleHasUnknownPrice,
  pricingBindingDigest,
  type GateBundle
} from "./gateBundle.js";
import { isEffectful, type EffectClass } from "./leases.js";
import { roleEffectAllowed, type ProductionControlRole } from "./schema.js";
import type { HumanDecisionRef } from "./schema.js";

/** Live sealed Gate 1 binding; booleans are not authority. */
export type SealedGate1Binding = {
  subject_digest: string;
  decision_digest: string;
  gate_bundle_digest: string;
  /** Must be exactly false for current authority. */
  stale: false;
};

/** Live sealed Gate 2 binding for render authority. */
export type SealedGate2Binding = {
  subject_digest: string;
  decision_digest: string;
  stale: false;
};

/**
 * Active-mode authority context. Caller role strings and boolean flags are not
 * trusted without matching sealed/live bindings.
 */
export type AuthorityContext = {
  role: ProductionControlRole | string;
  effect: EffectClass;
  actor: string;
  /** Active production mode only; legacy/disabled/shadow leave authority to legacy paths. */
  mode: "disabled" | "shadow" | "active";
  /**
   * Sealed coordinator actor identity. External-submit / local-write / render / paid
   * require this to equal `actor`. Arbitrary role payload alone is insufficient.
   */
  coordinator_actor?: string;
  /** Required for external-submit: verified GateBundle (not known_price boolean). */
  gate_bundle?: GateBundle;
  /** Required for external-submit: current Gate 1 binding matching the bundle digest. */
  gate_1?: SealedGate1Binding;
  /** Required for render: current Gate 2 binding. */
  gate_2?: SealedGate2Binding;
  /** Exact pricing binding digest expected from the GateBundle (all batches). */
  expected_pricing_binding_digest?: string;
  explicit_render_command?: boolean;
  /** Human decision subject for gate effect; must match sealed subject. */
  human_decision_ref?: HumanDecisionRef;
  /**
   * @deprecated Never grants authority. Kept only so callers that still pass
   * booleans fail closed instead of being silently trusted.
   */
  is_coordinator?: boolean;
  /**
   * @deprecated known_price alone is forbidden for external-submit.
   */
  known_price?: boolean;
  /**
   * @deprecated gate_1_current / gate_2_current booleans are not authority.
   */
  gate_1_current?: boolean;
  gate_2_current?: boolean;
  human_gate_decision?: boolean;
  /**
   * PO-6 grant/authorization. T06 unconditionally denies paid even when true.
   */
  paid_authorization?: boolean;
};

export type AuthorityDecision = {
  allowed: boolean;
  reason?: string;
  effect: EffectClass;
};

function isSealedCoordinator(context: AuthorityContext): boolean {
  return Boolean(
    context.coordinator_actor
    && context.coordinator_actor === context.actor
    && context.coordinator_actor.length > 0
  );
}

function assertSealedGate1ForSubmit(context: AuthorityContext): AuthorityDecision | null {
  if (!context.gate_bundle) {
    return {
      allowed: false,
      reason: "external-submit requires a verified GateBundle",
      effect: context.effect
    };
  }
  if (gateBundleHasUnknownPrice(context.gate_bundle)) {
    return { allowed: false, reason: "unknown price cannot be executed", effect: context.effect };
  }
  try {
    assertGateBundleExecutable(context.gate_bundle);
  } catch {
    return { allowed: false, reason: "gate bundle is not executable", effect: context.effect };
  }
  if (!context.gate_1 || context.gate_1.stale !== false) {
    return {
      allowed: false,
      reason: "external-submit requires a current sealed Gate 1 binding",
      effect: context.effect
    };
  }
  if (context.gate_1.gate_bundle_digest !== context.gate_bundle.digest) {
    return {
      allowed: false,
      reason: "Gate 1 binding does not match GateBundle digest",
      effect: context.effect
    };
  }
  // known_price boolean alone is forbidden; require exact pricing digests from the live bundle.
  for (const batch of context.gate_bundle.generation_batches) {
    const expected = pricingBindingDigest(batch.pricing, batch.route);
    if (batch.pricing_binding_digest !== expected) {
      return {
        allowed: false,
        reason: "pricing binding digest is stale or forged",
        effect: context.effect
      };
    }
    if (
      context.expected_pricing_binding_digest
      && context.expected_pricing_binding_digest !== batch.pricing_binding_digest
    ) {
      return {
        allowed: false,
        reason: "pricing binding digest does not match expected subject",
        effect: context.effect
      };
    }
  }
  return null;
}

export function checkAuthority(context: AuthorityContext): AuthorityDecision {
  if (context.mode !== "active") {
    return {
      allowed: false,
      reason: "production control authority applies only in active mode",
      effect: context.effect
    };
  }
  if (!roleEffectAllowed(context.role, context.effect)) {
    return { allowed: false, reason: "role-effect matrix forbids this effect", effect: context.effect };
  }

  switch (context.effect) {
    case "read":
    case "propose":
      return { allowed: true, effect: context.effect };

    case "local-write":
      if (!isSealedCoordinator(context)) {
        return {
          allowed: false,
          reason: "local-write requires sealed Coordinator binding",
          effect: context.effect
        };
      }
      return { allowed: true, effect: context.effect };

    case "external-observe":
      return { allowed: true, effect: context.effect };

    case "external-submit": {
      if (!isSealedCoordinator(context)) {
        return {
          allowed: false,
          reason: "external-submit requires sealed Coordinator binding",
          effect: context.effect
        };
      }
      // known_price alone is never sufficient — sealed GateBundle + Gate1 required.
      if (context.known_price === true && !context.gate_bundle) {
        return {
          allowed: false,
          reason: "known_price alone cannot authorize external-submit",
          effect: context.effect
        };
      }
      const sealed = assertSealedGate1ForSubmit(context);
      if (sealed) return sealed;
      return { allowed: true, effect: context.effect };
    }

    case "paid":
      // PO-6 owns grants/credits. T06 unconditionally denies paid execution,
      // even when paid_authorization:true is supplied by a caller.
      return {
        allowed: false,
        reason: "paid execution denied until PO-6 typed authorization exists",
        effect: context.effect
      };

    case "render":
      if (!isSealedCoordinator(context)) {
        return {
          allowed: false,
          reason: "render requires sealed Coordinator binding",
          effect: context.effect
        };
      }
      if (!context.explicit_render_command) {
        return {
          allowed: false,
          reason: "render requires an explicit command",
          effect: context.effect
        };
      }
      if (!context.gate_2 || context.gate_2.stale !== false) {
        return {
          allowed: false,
          reason: "render requires a current sealed Gate 2 binding",
          effect: context.effect
        };
      }
      return { allowed: true, effect: context.effect };

    case "gate": {
      const decision = context.human_decision_ref;
      if (!decision || !decision.subject_digest || decision.subject_digest.length !== 64) {
        return {
          allowed: false,
          reason: "gate effect requires a sealed human decision subject",
          effect: context.effect
        };
      }
      return { allowed: true, effect: context.effect };
    }

    default:
      return { allowed: false, reason: "unknown effect", effect: context.effect };
  }
}

export function assertAuthority(context: AuthorityContext): void {
  const decision = checkAuthority(context);
  if (!decision.allowed) {
    throw pcError("PC_AUTHORITY_DENIED", decision.reason ?? "authority denied", {
      effect: context.effect,
      role: String(context.role)
    });
  }
}

export function assertEffectfulAuthority(context: AuthorityContext): void {
  if (!isEffectful(context.effect)) {
    throw pcError("PC_AUTHORITY_DENIED", "expected an effectful task");
  }
  assertAuthority(context);
}
