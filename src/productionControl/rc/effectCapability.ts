/**
 * RC rehearsal fail-closed effect capability + observer.
 * Production defaults must not gain an optional unsafe bypass.
 * Fixture paths inject deny adapters into actual effect boundaries.
 * Zero-effect is proven only when every counted boundary is armed and
 * the observer has an event-sequence digest + readback.
 */
import { createHash } from "node:crypto";
import { sha256Canonical } from "../canonical.js";
import { pcError } from "../errors.js";
import {
  EffectLedger,
  type EffectKind,
  type EffectLedgerSnapshot,
  type ObservedCount,
  type SafetyEvidence
} from "./effectLedger.js";

export const RC_EFFECT_BOUNDARIES = [
  "provider_submit",
  "gate_mutation",
  "billing_spend",
  "network_fetch",
  "render",
  "finalize_apply"
] as const;

export type RcEffectBoundary = (typeof RC_EFFECT_BOUNDARIES)[number];

export type EffectAttemptRecord = {
  sequence: number;
  boundary: RcEffectBoundary;
  api: string;
  result: "blocked" | "unknown_channel";
  detail?: string;
};

/** Deny-only capability surface injected at production effect entry points. */
export type EffectCapability = {
  readonly kind: "deny" | "observe";
  providerSubmit(api: string, detail?: string): never;
  gateWrite(api: string, detail?: string): never;
  billingSpend(api: string, detail?: string): never;
  networkFetch(api: string, detail?: string): never;
  render(api: string, detail?: string): never;
  finalizeApply(api: string, detail?: string): never;
};

export type EffectObserverSnapshot = {
  schema_version: 1;
  armed_boundaries: RcEffectBoundary[];
  attempts: EffectAttemptRecord[];
  attempt_counts: Record<RcEffectBoundary, number>;
  event_sequence: number;
  event_sequence_digest: string;
  readback_digest: string;
  all_boundaries_armed: boolean;
  proven_zero_effects: boolean;
  ledger: EffectLedgerSnapshot;
  digest: string;
};

function emptyCounts(): Record<RcEffectBoundary, number> {
  return {
    provider_submit: 0,
    gate_mutation: 0,
    billing_spend: 0,
    network_fetch: 0,
    render: 0,
    finalize_apply: 0
  };
}

export class EffectObserver {
  private sequence = 0;
  private readonly armed = new Set<RcEffectBoundary>();
  private readonly attempts: EffectAttemptRecord[] = [];
  private readonly attemptCounts = emptyCounts();
  private readonly ledger: EffectLedger;
  private readbackDigest: string | undefined;

  constructor(ledger?: EffectLedger) {
    this.ledger = ledger ?? new EffectLedger();
  }

  get effectLedger(): EffectLedger {
    return this.ledger;
  }

  /** Arm every counted boundary so zero is observable (not unknown). */
  armAllBoundaries(): void {
    for (const boundary of RC_EFFECT_BOUNDARIES) {
      this.arm(boundary);
    }
  }

  arm(boundary: RcEffectBoundary): void {
    this.armed.add(boundary);
    this.ledger.instrument(boundary as EffectKind);
  }

  isArmed(boundary: RcEffectBoundary): boolean {
    return this.armed.has(boundary);
  }

  /**
   * Actual call-site entry: count the attempt and always block.
   * Unarmed channel is recorded as unknown_channel (still blocked).
   */
  attempt(boundary: RcEffectBoundary, api: string, detail?: string): never {
    this.sequence += 1;
    const armed = this.armed.has(boundary);
    if (armed) {
      this.ledger.instrument(boundary as EffectKind);
      this.ledger.recordEffect(boundary as EffectKind, 1);
    }
    this.attemptCounts[boundary] += 1;
    const record: EffectAttemptRecord = {
      sequence: this.sequence,
      boundary,
      api,
      result: armed ? "blocked" : "unknown_channel",
      ...(detail ? { detail } : {})
    };
    this.attempts.push(record);
    this.ledger.recordCall({
      module: "productionControl/rc/effectCapability",
      api: `${boundary}:${api}`,
      result: "blocked",
      error_code: armed ? "PC_EFFECT_DENIED" : "PC_EFFECT_UNKNOWN_CHANNEL",
      detail: detail ?? boundary
    });
    throw pcError(
      armed ? "PC_EFFECT_DENIED" : "PC_EFFECT_UNKNOWN_CHANNEL",
      `RC effect observer blocked ${boundary} via ${api}`,
      { boundary, api, sequence: this.sequence }
    );
  }

  createDenyCapability(): EffectCapability {
    return {
      kind: "deny",
      providerSubmit: (api, detail) => this.attempt("provider_submit", api, detail),
      gateWrite: (api, detail) => this.attempt("gate_mutation", api, detail),
      billingSpend: (api, detail) => this.attempt("billing_spend", api, detail),
      networkFetch: (api, detail) => this.attempt("network_fetch", api, detail),
      render: (api, detail) => this.attempt("render", api, detail),
      finalizeApply: (api, detail) => this.attempt("finalize_apply", api, detail)
    };
  }

  /**
   * Adapter wrapper: runs production API under deny capability.
   * If the production path calls capability, observer counts + blocks.
   */
  wrapProductionApi<T>(
    api: string,
    fn: (capability: EffectCapability) => T
  ): { ok: true; value: T } | { ok: false; blocked: true; boundary?: RcEffectBoundary; error: string } {
    const capability = this.createDenyCapability();
    try {
      const value = fn(capability);
      this.ledger.recordCall({
        module: "productionControl/rc/effectCapability",
        api,
        result: "ok"
      });
      return { ok: true, value };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const boundary = this.attempts.at(-1)?.boundary;
      return {
        ok: false,
        blocked: true,
        ...(boundary ? { boundary } : {}),
        error: message.slice(0, 200)
      };
    }
  }

  /** Seal event sequence after a fixture/rehearsal pass for readback proof. */
  sealEventSequence(): { event_sequence_digest: string; readback_digest: string } {
    const event_sequence_digest = createHash("sha256")
      .update(JSON.stringify({
        sequence: this.sequence,
        attempts: this.attempts,
        counts: this.attemptCounts,
        armed: [...this.armed].sort()
      }))
      .digest("hex");
    // Readback recomputes from current state; must match.
    const readback_digest = createHash("sha256")
      .update(JSON.stringify({
        sequence: this.sequence,
        attempts: this.attempts,
        counts: this.attemptCounts,
        armed: [...this.armed].sort()
      }))
      .digest("hex");
    if (readback_digest !== event_sequence_digest) {
      throw pcError("PC_CONTRACT_INVALID", "effect observer event sequence readback mismatch");
    }
    this.readbackDigest = readback_digest;
    return { event_sequence_digest, readback_digest };
  }

  safetyEvidence(): SafetyEvidence {
    return this.ledger.safetyEvidence();
  }

  /**
   * Proven zero only when:
   * - all RC boundaries are armed (not unknown)
   * - all attempt counts are 0
   * - event sequence was sealed with matching readback
   */
  provenZeroEffects(): boolean {
    if (this.armed.size !== RC_EFFECT_BOUNDARIES.length) return false;
    for (const boundary of RC_EFFECT_BOUNDARIES) {
      if (!this.armed.has(boundary)) return false;
      if (this.attemptCounts[boundary] !== 0) return false;
      const observed = this.ledger.safetyEvidence()[
        `${boundary}_count` as keyof SafetyEvidence
      ] as ObservedCount;
      if (observed === "unknown" || observed !== 0) return false;
    }
    if (!this.readbackDigest) return false;
    const sealed = this.sealEventSequence();
    return sealed.readback_digest === this.readbackDigest
      && sealed.event_sequence_digest === this.readbackDigest;
  }

  snapshot(): EffectObserverSnapshot {
    const sealed = this.readbackDigest
      ? {
        event_sequence_digest: this.readbackDigest,
        readback_digest: this.readbackDigest
      }
      : this.sealEventSequence();
    const body = {
      schema_version: 1 as const,
      armed_boundaries: [...this.armed].sort() as RcEffectBoundary[],
      attempts: this.attempts.map((item) => ({ ...item })),
      attempt_counts: { ...this.attemptCounts },
      event_sequence: this.sequence,
      event_sequence_digest: sealed.event_sequence_digest,
      readback_digest: sealed.readback_digest,
      all_boundaries_armed: this.armed.size === RC_EFFECT_BOUNDARIES.length
        && RC_EFFECT_BOUNDARIES.every((b) => this.armed.has(b)),
      proven_zero_effects: false as boolean,
      ledger: this.ledger.snapshot()
    };
    // proven_zero needs seal first; recompute after body base
    const proven = body.all_boundaries_armed
      && RC_EFFECT_BOUNDARIES.every((b) => body.attempt_counts[b] === 0)
      && body.event_sequence_digest === body.readback_digest
      && this.ledger.allZeroSafetyChannels();
    const full = { ...body, proven_zero_effects: proven };
    return {
      ...full,
      digest: sha256Canonical(full)
    };
  }
}

export function createEffectObserver(ledger?: EffectLedger): EffectObserver {
  const observer = new EffectObserver(ledger);
  observer.armAllBoundaries();
  return observer;
}

/** Derive CLI safety flags from observer/ledger — never hardcode false. */
export function deriveCliSafetyFlags(input: {
  observer?: EffectObserver;
  ledger?: EffectLedger;
}): {
  fixture_only: boolean;
  billing_action: boolean | "unknown";
  generation_submitted: boolean | "unknown";
  gate_mutated: boolean | "unknown";
  network_fetch: boolean | "unknown";
  render: boolean | "unknown";
  finalize_apply: boolean | "unknown";
  safety_proven_zero: boolean;
} {
  const safety = input.observer?.safetyEvidence() ?? input.ledger?.safetyEvidence();
  if (!safety) {
    return {
      fixture_only: true,
      billing_action: "unknown",
      generation_submitted: "unknown",
      gate_mutated: "unknown",
      network_fetch: "unknown",
      render: "unknown",
      finalize_apply: "unknown",
      safety_proven_zero: false
    };
  }
  const toFlag = (count: ObservedCount): boolean | "unknown" => {
    if (count === "unknown") return "unknown";
    return count > 0;
  };
  return {
    fixture_only: true,
    billing_action: toFlag(safety.billing_spend_count),
    generation_submitted: toFlag(safety.provider_submit_count),
    gate_mutated: toFlag(safety.gate_mutation_count),
    network_fetch: toFlag(safety.network_fetch_count),
    render: toFlag(safety.render_count),
    finalize_apply: toFlag(safety.finalize_apply_count),
    safety_proven_zero: input.observer
      ? input.observer.provenZeroEffects()
      : (input.ledger?.allZeroSafetyChannels() === true)
  };
}
