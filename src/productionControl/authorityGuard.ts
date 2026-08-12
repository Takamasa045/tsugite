/**
 * AuthorityGuard — effect-class checks before dispatcher execution.
 * Paid remains denied until PO-6 authorization. Gate 1/3 always human.
 */
import { pcError } from "./errors.js";
import { assertGateBundleExecutable, gateBundleHasUnknownPrice, type GateBundle } from "./gateBundle.js";
import { isEffectful, type EffectClass } from "./leases.js";
import { roleEffectAllowed, type ProductionControlRole } from "./schema.js";

export type AuthorityContext = {
  role: ProductionControlRole | string;
  effect: EffectClass;
  actor: string;
  /** Active production mode only; legacy/disabled/shadow leave authority to legacy paths. */
  mode: "disabled" | "shadow" | "active";
  is_coordinator: boolean;
  gate_1_current?: boolean;
  gate_2_current?: boolean;
  gate_bundle?: GateBundle;
  known_price?: boolean;
  explicit_render_command?: boolean;
  human_gate_decision?: boolean;
  /** PO-6 grant/authorization present. Always false in T06. */
  paid_authorization?: boolean;
};

export type AuthorityDecision = {
  allowed: boolean;
  reason?: string;
  effect: EffectClass;
};

export function checkAuthority(context: AuthorityContext): AuthorityDecision {
  if (context.mode !== "active") {
    return { allowed: false, reason: "production control authority applies only in active mode", effect: context.effect };
  }
  if (!roleEffectAllowed(context.role, context.effect)) {
    return { allowed: false, reason: "role-effect matrix forbids this effect", effect: context.effect };
  }

  switch (context.effect) {
    case "read":
    case "propose":
      return { allowed: true, effect: context.effect };

    case "local-write":
      if (!context.is_coordinator) {
        return { allowed: false, reason: "local-write requires Coordinator", effect: context.effect };
      }
      return { allowed: true, effect: context.effect };

    case "external-observe":
      return { allowed: true, effect: context.effect };

    case "external-submit": {
      if (!context.is_coordinator) {
        return { allowed: false, reason: "external-submit requires Coordinator", effect: context.effect };
      }
      if (!context.gate_1_current) {
        return { allowed: false, reason: "external-submit requires current Gate 1", effect: context.effect };
      }
      if (context.gate_bundle) {
        if (gateBundleHasUnknownPrice(context.gate_bundle)) {
          return { allowed: false, reason: "unknown price cannot be executed", effect: context.effect };
        }
        try {
          assertGateBundleExecutable(context.gate_bundle);
        } catch {
          return { allowed: false, reason: "gate bundle is not executable", effect: context.effect };
        }
      } else if (context.known_price !== true) {
        return { allowed: false, reason: "external-submit requires known price", effect: context.effect };
      }
      return { allowed: true, effect: context.effect };
    }

    case "paid":
      // PO-6 owns grants/credits. T06 always denies paid execution.
      if (!context.paid_authorization) {
        return { allowed: false, reason: "paid execution denied until PO-6 authorization", effect: context.effect };
      }
      if (!context.is_coordinator || !context.gate_1_current) {
        return { allowed: false, reason: "paid requires Coordinator and current Gate 1", effect: context.effect };
      }
      return { allowed: true, effect: context.effect };

    case "render":
      if (!context.is_coordinator) {
        return { allowed: false, reason: "render requires Coordinator", effect: context.effect };
      }
      if (!context.explicit_render_command) {
        return { allowed: false, reason: "render requires an explicit command", effect: context.effect };
      }
      if (!context.gate_2_current) {
        return { allowed: false, reason: "render requires current Gate 2", effect: context.effect };
      }
      return { allowed: true, effect: context.effect };

    case "gate":
      if (!context.human_gate_decision) {
        return { allowed: false, reason: "gate effect requires a human decision subject", effect: context.effect };
      }
      return { allowed: true, effect: context.effect };

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
