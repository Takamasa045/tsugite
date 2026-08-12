/**
 * AuthorityGuard — effect-class checks before dispatcher execution.
 * Never trusts caller booleans alone. Paid is unconditionally denied until PO-6.
 * Gate 1/3 always require sealed human decision subjects.
 *
 * Sealed objects and coordinator authority are opaque WeakSet tokens minted only
 * from live durable RunState / GateBundle / HumanDecisionRef resolvers. Free-form
 * structural copies and self-assigned coordinator strings are rejected.
 */
import { pcError } from "./errors.js";
import {
  assertGateBundleExecutable,
  gateBundleHasUnknownPrice,
  parseGateBundle,
  pricingBindingDigest,
  type GateBundle
} from "./gateBundle.js";
import { isEffectful, type EffectClass } from "./leases.js";
import { roleEffectAllowed, type ProductionControlRole } from "./schema.js";
import {
  humanDecisionRefSchema,
  type HumanDecisionRef
} from "./schema.js";
import { gateDecisionDigest } from "./gateSubjects.js";

/** Live sealed Gate 1 binding; booleans are not authority. */
export type SealedGate1Binding = {
  readonly kind: "pc-sealed-gate-1";
  readonly subject_digest: string;
  readonly decision_digest: string;
  readonly gate_bundle_digest: string;
  /** Must be exactly false for current authority. */
  readonly stale: false;
};

/** Live sealed Gate 2 binding for render authority. */
export type SealedGate2Binding = {
  readonly kind: "pc-sealed-gate-2";
  readonly subject_digest: string;
  readonly decision_digest: string;
  readonly stale: false;
};

/** Opaque coordinator actor authority — not a free-form string. */
export type SealedCoordinatorAuthority = {
  readonly kind: "pc-sealed-coordinator";
  readonly actor: string;
};

/** Opaque human decision for gate effects. */
export type SealedHumanDecision = {
  readonly kind: "pc-sealed-human-decision";
  readonly decision: HumanDecisionRef;
  readonly decision_digest: string;
  readonly gate: "gate_1" | "gate_2" | "gate_3";
};

const sealedGate1Bindings = new WeakSet<object>();
const sealedGate2Bindings = new WeakSet<object>();
const sealedCoordinatorAuthorities = new WeakSet<object>();
const sealedHumanDecisions = new WeakSet<object>();

function isObject(value: unknown): value is object {
  return Boolean(value) && typeof value === "object";
}

export function isSealedGate1Binding(value: unknown): value is SealedGate1Binding {
  return isObject(value) && sealedGate1Bindings.has(value);
}

export function isSealedGate2Binding(value: unknown): value is SealedGate2Binding {
  return isObject(value) && sealedGate2Bindings.has(value);
}

export function isSealedCoordinatorAuthority(value: unknown): value is SealedCoordinatorAuthority {
  return isObject(value) && sealedCoordinatorAuthorities.has(value);
}

export function isSealedHumanDecision(value: unknown): value is SealedHumanDecision {
  return isObject(value) && sealedHumanDecisions.has(value);
}

/**
 * Mint Gate 1 sealed authority from a live durable GateBundle + exact subject/decision.
 * Caller-constructed plain objects never pass isSealedGate1Binding.
 */
export function mintSealedGate1Binding(input: {
  gate_bundle: GateBundle;
  subject_digest: string;
  decision_digest: string;
  /** Live RunState production digests (must match exactly). */
  live_subject_digest: string;
  live_decision_digest: string;
}): SealedGate1Binding {
  const bundle = parseGateBundle(input.gate_bundle);
  if (input.subject_digest.length !== 64 || input.decision_digest.length !== 64) {
    throw pcError("PC_AUTHORITY_DENIED", "Gate 1 sealed binding requires exact 64-char digests");
  }
  if (
    input.subject_digest !== input.live_subject_digest
    || input.decision_digest !== input.live_decision_digest
  ) {
    throw pcError("PC_AUTHORITY_DENIED", "Gate 1 sealed binding does not match live RunState subjects");
  }
  if (gateBundleHasUnknownPrice(bundle)) {
    throw pcError("PC_AUTHORITY_DENIED", "unknown price cannot be sealed for execution");
  }
  assertGateBundleExecutable(bundle);
  const sealed = Object.freeze({
    kind: "pc-sealed-gate-1" as const,
    subject_digest: input.subject_digest,
    decision_digest: input.decision_digest,
    gate_bundle_digest: bundle.digest,
    stale: false as const
  });
  sealedGate1Bindings.add(sealed);
  return sealed;
}

/**
 * Mint Gate 2 sealed authority from live RunState production digests only.
 */
export function mintSealedGate2Binding(input: {
  subject_digest: string;
  decision_digest: string;
  live_subject_digest: string;
  live_decision_digest: string;
}): SealedGate2Binding {
  if (input.subject_digest.length !== 64 || input.decision_digest.length !== 64) {
    throw pcError("PC_AUTHORITY_DENIED", "Gate 2 sealed binding requires exact 64-char digests");
  }
  if (
    input.subject_digest !== input.live_subject_digest
    || input.decision_digest !== input.live_decision_digest
  ) {
    throw pcError("PC_AUTHORITY_DENIED", "Gate 2 sealed binding does not match live RunState subjects");
  }
  const sealed = Object.freeze({
    kind: "pc-sealed-gate-2" as const,
    subject_digest: input.subject_digest,
    decision_digest: input.decision_digest,
    stale: false as const
  });
  sealedGate2Bindings.add(sealed);
  return sealed;
}

/**
 * Mint coordinator authority only when the live actor is the durable coordinator
 * principal for the effect. Free-form string equality alone is not authority.
 */
export function mintSealedCoordinatorAuthority(input: {
  actor: string;
  /** Live durable principal recorded on the active RunState / job binding path. */
  live_coordinator_actor: string;
}): SealedCoordinatorAuthority {
  if (!input.actor || input.actor !== "coordinator") {
    throw pcError("PC_AUTHORITY_DENIED", "sealed coordinator requires actor=coordinator");
  }
  if (input.live_coordinator_actor !== "coordinator") {
    throw pcError("PC_AUTHORITY_DENIED", "live coordinator principal is not sealed");
  }
  if (input.actor !== input.live_coordinator_actor) {
    throw pcError("PC_AUTHORITY_DENIED", "coordinator actor does not match live principal");
  }
  const sealed = Object.freeze({
    kind: "pc-sealed-coordinator" as const,
    actor: input.actor
  });
  sealedCoordinatorAuthorities.add(sealed);
  return sealed;
}

/**
 * Mint a human decision seal from an exact HumanDecisionRef + live subject/decision.
 * Gate 1 and Gate 3 always require human; Gate 2 may be human or narrow auto_qc source
 * but still needs exact subject membership.
 */
export function mintSealedHumanDecision(input: {
  gate: "gate_1" | "gate_2" | "gate_3";
  decision: HumanDecisionRef;
  live_subject_digest: string;
  live_decision_digest: string;
  decision_source?: "human" | "auto_qc";
}): SealedHumanDecision {
  const decision = humanDecisionRefSchema.parse(input.decision);
  if (input.gate !== "gate_2" && input.decision_source === "auto_qc") {
    throw pcError("PC_AUTHORITY_DENIED", "Gate 1 and Gate 3 always require a human decision");
  }
  if (input.gate === "gate_1" || input.gate === "gate_3") {
    if (input.decision_source && input.decision_source !== "human") {
      throw pcError("PC_AUTHORITY_DENIED", "Gate 1 and Gate 3 always require a human decision");
    }
  }
  if (decision.subject_digest !== input.live_subject_digest) {
    throw pcError("PC_AUTHORITY_DENIED", "human decision subject does not match live subject");
  }
  const decisionDigest = gateDecisionDigest(decision);
  if (decisionDigest !== input.live_decision_digest) {
    throw pcError("PC_AUTHORITY_DENIED", "human decision digest does not match live decision");
  }
  const sealed = Object.freeze({
    kind: "pc-sealed-human-decision" as const,
    decision,
    decision_digest: decisionDigest,
    gate: input.gate
  });
  sealedHumanDecisions.add(sealed);
  return sealed;
}

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
   * Opaque sealed coordinator authority. Free-form coordinator strings are rejected.
   */
  coordinator_authority?: SealedCoordinatorAuthority;
  /** Required for external-submit: verified GateBundle (not known_price boolean). */
  gate_bundle?: GateBundle;
  /** Required for external-submit: current Gate 1 binding matching the bundle digest. */
  gate_1?: SealedGate1Binding;
  /** Required for render: current Gate 2 binding. */
  gate_2?: SealedGate2Binding;
  /** Exact pricing binding digest expected from the GateBundle (all batches). */
  expected_pricing_binding_digest?: string;
  explicit_render_command?: boolean;
  /** Sealed human decision for gate effect; must match sealed subject. */
  sealed_human_decision?: SealedHumanDecision;
  /**
   * @deprecated Never grants authority. Kept only so callers that still pass
   * booleans fail closed instead of being silently trusted.
   */
  is_coordinator?: boolean;
  /**
   * @deprecated Self-assigned coordinator string is not authority.
   */
  coordinator_actor?: string;
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
   * @deprecated Free-form HumanDecisionRef is not authority; use sealed_human_decision.
   */
  human_decision_ref?: HumanDecisionRef;
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
  if (!context.coordinator_authority || !isSealedCoordinatorAuthority(context.coordinator_authority)) {
    return false;
  }
  return context.coordinator_authority.actor === context.actor
    && context.coordinator_authority.actor === "coordinator";
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
  if (!context.gate_1 || !isSealedGate1Binding(context.gate_1) || context.gate_1.stale !== false) {
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
      // Free-form coordinator_actor string must never authorize when seal is absent.
      if (context.coordinator_actor && !context.coordinator_authority) {
        return {
          allowed: false,
          reason: "external-submit requires sealed Coordinator binding",
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
      if (!context.gate_2 || !isSealedGate2Binding(context.gate_2) || context.gate_2.stale !== false) {
        return {
          allowed: false,
          reason: "render requires a current sealed Gate 2 binding",
          effect: context.effect
        };
      }
      return { allowed: true, effect: context.effect };

    case "gate": {
      const sealed = context.sealed_human_decision;
      if (!sealed || !isSealedHumanDecision(sealed)) {
        return {
          allowed: false,
          reason: "gate effect requires a sealed human decision subject",
          effect: context.effect
        };
      }
      if (sealed.gate === "gate_1" || sealed.gate === "gate_3") {
        // Gate 1/3: human only — mint already enforces, re-check here.
        if (sealed.decision.actor.length === 0) {
          return {
            allowed: false,
            reason: "gate effect requires a sealed human decision subject",
            effect: context.effect
          };
        }
      }
      if (!sealed.decision.subject_digest || sealed.decision.subject_digest.length !== 64) {
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
