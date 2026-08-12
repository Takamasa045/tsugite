/**
 * Effect-aware dispatcher: pure workers max 3, effectful max 1.
 * Duplicate node/attempt leases are rejected. Expiry never restarts effectful work.
 */
import { assertAuthority, type AuthorityContext } from "./authorityGuard.js";
import { pcError } from "./errors.js";
import {
  createAttemptLease,
  createLeaseIndex,
  isEffectful,
  isPure,
  reconcileExpiredLease,
  registerLease,
  releaseLease,
  type ActiveLeaseIndex,
  type AttemptLease,
  type EffectClass
} from "./leases.js";
import { sha256Canonical } from "./canonical.js";
import type { ProductionControlRole } from "./schema.js";

export const DEFAULT_MAX_PURE_WORKERS = 3;
export const DEFAULT_MAX_EFFECTFUL_WORKERS = 1;

export type DispatchRequest = {
  node_id: string;
  attempt_id: string;
  task_revision: number;
  input_digest: string;
  role: ProductionControlRole | string;
  effect: EffectClass;
  authority: Omit<AuthorityContext, "role" | "effect">;
  lease_id?: string;
  ttl_ms?: number;
  now?: string;
};

export type DispatchSlot = {
  lease: AttemptLease;
  worker_kind: "pure" | "effectful";
};

export class ProductionDispatcher {
  readonly maxPure: number;
  readonly maxEffectful: number;
  private readonly leases: ActiveLeaseIndex;
  private pureRunning = 0;
  private effectfulRunning = 0;

  constructor(options: {
    max_pure?: number;
    max_effectful?: number;
    leases?: readonly AttemptLease[];
  } = {}) {
    this.maxPure = options.max_pure ?? DEFAULT_MAX_PURE_WORKERS;
    this.maxEffectful = options.max_effectful ?? DEFAULT_MAX_EFFECTFUL_WORKERS;
    if (this.maxPure < 1 || this.maxEffectful !== 1) {
      throw pcError("PC_DISPATCH_LIMIT", "dispatcher requires pure>=1 and effectful===1");
    }
    this.leases = createLeaseIndex(options.leases ?? []);
  }

  get activePureCount(): number {
    return this.pureRunning;
  }

  get activeEffectfulCount(): number {
    return this.effectfulRunning;
  }

  get activeLeases(): AttemptLease[] {
    return [...this.leases.by_lease_id.values()];
  }

  acquire(request: DispatchRequest): DispatchSlot {
    assertAuthority({
      ...request.authority,
      role: request.role,
      effect: request.effect
    });

    const pure = isPure(request.effect);
    const effectful = isEffectful(request.effect);
    if (!pure && !effectful) {
      throw pcError("PC_DISPATCH_LIMIT", "unknown effect class for dispatch");
    }
    if (pure && this.pureRunning >= this.maxPure) {
      throw pcError("PC_DISPATCH_LIMIT", "pure worker concurrency limit reached", { max: this.maxPure });
    }
    if (effectful && this.effectfulRunning >= this.maxEffectful) {
      throw pcError("PC_DISPATCH_LIMIT", "effectful worker concurrency limit reached", { max: this.maxEffectful });
    }

    const now = request.now ?? new Date().toISOString();
    const lease = createAttemptLease({
      lease_id: request.lease_id ?? `lease-${request.attempt_id}`,
      node_id: request.node_id,
      task_revision: request.task_revision,
      attempt_id: request.attempt_id,
      attempt_key: sha256Canonical({
        node_id: request.node_id,
        attempt_id: request.attempt_id,
        task_revision: request.task_revision,
        input_digest: request.input_digest,
        effect: request.effect
      }),
      input_digest: request.input_digest,
      role: request.role,
      effect: request.effect,
      acquired_at: now,
      ttl_ms: request.ttl_ms
    });
    registerLease(this.leases, lease);
    if (pure) this.pureRunning += 1;
    else this.effectfulRunning += 1;
    return { lease, worker_kind: pure ? "pure" : "effectful" };
  }

  release(leaseId: string): void {
    const lease = this.leases.by_lease_id.get(leaseId);
    if (!lease) throw pcError("PC_LEASE_CONFLICT", "unknown lease");
    if (isPure(lease.effect)) this.pureRunning = Math.max(0, this.pureRunning - 1);
    else this.effectfulRunning = Math.max(0, this.effectfulRunning - 1);
    releaseLease(this.leases, leaseId);
  }

  /**
   * Drop expired pure leases for requeue eligibility. Effectful expired leases
   * are observed only — never auto-requeued.
   */
  reconcileExpiries(now = new Date()): {
    expired_pure: AttemptLease[];
    expired_effectful: AttemptLease[];
  } {
    const expiredPure: AttemptLease[] = [];
    const expiredEffectful: AttemptLease[] = [];
    for (const lease of [...this.leases.by_lease_id.values()]) {
      const result = reconcileExpiredLease(lease, now);
      if (!result.expired) continue;
      if (result.may_auto_requeue) {
        expiredPure.push(lease);
        this.release(lease.lease_id);
      } else {
        expiredEffectful.push(lease);
        // Keep the lease registered until human recovery; do not re-run.
      }
    }
    return { expired_pure: expiredPure, expired_effectful: expiredEffectful };
  }
}
