/**
 * Observed-effect ledger for RC evidence.
 * Safety claims (provider/Gate/billing/submit) are derived from recorded calls and
 * effect counts only. Unknown is never coerced to false/0.
 */
import { createHash } from "node:crypto";
import { sha256Canonical } from "../canonical.js";
import { pcError } from "../errors.js";

export type EffectKind =
  | "provider_submit"
  | "gate_mutation"
  | "billing_spend"
  | "network_fetch"
  | "render"
  | "finalize_apply"
  | "api_call";

export type LedgerCallRecord = {
  sequence: number;
  module: string;
  api: string;
  result: "ok" | "error" | "blocked";
  digests?: Record<string, string>;
  error_code?: string;
  detail?: string;
};

export type ObservedCount = number | "unknown";

export type SafetyEvidence = {
  provider_submit_count: ObservedCount;
  gate_mutation_count: ObservedCount;
  billing_spend_count: ObservedCount;
  network_fetch_count: ObservedCount;
  render_count: ObservedCount;
  finalize_apply_count: ObservedCount;
  api_call_count: number;
  sequence: number;
  digest: string;
};

export type EffectLedgerSnapshot = {
  schema_version: 1;
  calls: LedgerCallRecord[];
  effects: Partial<Record<EffectKind, number>>;
  instrumented_effects: EffectKind[];
  safety: SafetyEvidence;
  digest: string;
};

const COUNTED_EFFECTS: readonly EffectKind[] = [
  "provider_submit",
  "gate_mutation",
  "billing_spend",
  "network_fetch",
  "render",
  "finalize_apply"
] as const;

export class EffectLedger {
  private sequence = 0;
  private readonly calls: LedgerCallRecord[] = [];
  private readonly effects: Partial<Record<EffectKind, number>> = {};
  private readonly instrumented = new Set<EffectKind>();

  /** Mark an effect channel as instrumented (observed), even when count stays 0. */
  instrument(kind: EffectKind): void {
    this.instrumented.add(kind);
    if (this.effects[kind] === undefined) this.effects[kind] = 0;
  }

  recordEffect(kind: EffectKind, count = 1): void {
    this.instrument(kind);
    this.effects[kind] = (this.effects[kind] ?? 0) + count;
  }

  recordCall(input: {
    module: string;
    api: string;
    result: "ok" | "error" | "blocked";
    digests?: Record<string, string>;
    error_code?: string;
    detail?: string;
  }): LedgerCallRecord {
    this.instrument("api_call");
    this.sequence += 1;
    const record: LedgerCallRecord = {
      sequence: this.sequence,
      module: input.module,
      api: input.api,
      result: input.result,
      ...(input.digests ? { digests: input.digests } : {}),
      ...(input.error_code ? { error_code: input.error_code } : {}),
      ...(input.detail ? { detail: input.detail } : {})
    };
    this.calls.push(record);
    this.recordEffect("api_call", 1);
    return record;
  }

  /**
   * @deprecated Removed — zero-effect proof requires EffectObserver.registerBoundary()
   * from actual call-site wrappers. Do not invent instrumented zeros.
   */
  markFixtureInProcessBoundary(): void {
    throw pcError(
      "PC_CONTRACT_INVALID",
      "markFixtureInProcessBoundary is removed; use EffectObserver.registerBoundary() via actual boundary wrappers"
    );
  }

  private observed(kind: EffectKind): ObservedCount {
    if (!this.instrumented.has(kind)) return "unknown";
    return this.effects[kind] ?? 0;
  }

  safetyEvidence(): SafetyEvidence {
    const body = {
      provider_submit_count: this.observed("provider_submit"),
      gate_mutation_count: this.observed("gate_mutation"),
      billing_spend_count: this.observed("billing_spend"),
      network_fetch_count: this.observed("network_fetch"),
      render_count: this.observed("render"),
      finalize_apply_count: this.observed("finalize_apply"),
      api_call_count: this.calls.length,
      sequence: this.sequence
    };
    return {
      ...body,
      digest: sha256Canonical(body)
    };
  }

  snapshot(): EffectLedgerSnapshot {
    const safety = this.safetyEvidence();
    const body = {
      schema_version: 1 as const,
      calls: this.calls.map((call) => ({ ...call })),
      effects: { ...this.effects },
      instrumented_effects: [...this.instrumented].sort(),
      safety
    };
    return {
      ...body,
      digest: sha256Canonical(body)
    };
  }

  /** True only when every counted channel is instrumented and zero. Unknown ⇒ not zero-safe. */
  allZeroSafetyChannels(): boolean {
    for (const kind of COUNTED_EFFECTS) {
      const value = this.observed(kind);
      if (value === "unknown" || value !== 0) return false;
    }
    return true;
  }

  digestSequenceBinding(): string {
    return createHash("sha256")
      .update(JSON.stringify({ sequence: this.sequence, safety: this.safetyEvidence() }))
      .digest("hex");
  }
}

export function createEffectLedger(): EffectLedger {
  return new EffectLedger();
}
