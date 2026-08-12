/**
 * Attempt leases for the production-control dispatcher.
 * Expiry never authorizes an effectful rerun by itself.
 */
import { z } from "zod";
import { sha256Canonical, withoutField } from "./canonical.js";
import { pcError } from "./errors.js";
import {
  digestSchema,
  effectSchema,
  PRODUCTION_CONTROL_EFFECTS,
  roleSchema,
  safeIdSchema,
  type ProductionControlEffect
} from "./schema.js";

const isoDateSchema = z.string().datetime({ offset: true });

export const attemptLeaseSchema = z.object({
  lease_id: safeIdSchema,
  node_id: safeIdSchema,
  task_revision: z.number().int().nonnegative(),
  attempt_id: safeIdSchema,
  attempt_key: digestSchema,
  input_digest: digestSchema,
  role: roleSchema,
  effect: effectSchema,
  acquired_at: isoDateSchema,
  expires_at: isoDateSchema,
  lease_digest: digestSchema
}).strict().superRefine((lease, context) => {
  if (Date.parse(lease.expires_at) <= Date.parse(lease.acquired_at)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expires_at"], message: "lease expiry must be after acquisition" });
  }
  if (sha256Canonical(withoutField(lease, "lease_digest")) !== lease.lease_digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["lease_digest"], message: "lease digest mismatch" });
  }
});
export type AttemptLease = z.infer<typeof attemptLeaseSchema>;

export type EffectClass = ProductionControlEffect;

export function isEffectful(effect: EffectClass): boolean {
  return effect === "local-write"
    || effect === "external-observe"
    || effect === "external-submit"
    || effect === "paid"
    || effect === "render"
    || effect === "gate";
}

export function isPure(effect: EffectClass): boolean {
  return effect === "read" || effect === "propose";
}

export function createAttemptLease(input: {
  lease_id: string;
  node_id: string;
  task_revision: number;
  attempt_id: string;
  attempt_key: string;
  input_digest: string;
  role: string;
  effect: EffectClass;
  acquired_at?: string;
  expires_at?: string;
  ttl_ms?: number;
}): AttemptLease {
  if (!(PRODUCTION_CONTROL_EFFECTS as readonly string[]).includes(input.effect)) {
    throw pcError("PC_SCHEMA_INVALID", "unknown effect class");
  }
  const acquired = input.acquired_at ?? new Date().toISOString();
  const expires = input.expires_at
    ?? new Date(Date.parse(acquired) + (input.ttl_ms ?? 60_000)).toISOString();
  const base = {
    lease_id: input.lease_id,
    node_id: input.node_id,
    task_revision: input.task_revision,
    attempt_id: input.attempt_id,
    attempt_key: input.attempt_key,
    input_digest: input.input_digest,
    role: input.role,
    effect: input.effect,
    acquired_at: acquired,
    expires_at: expires
  };
  return attemptLeaseSchema.parse({ ...base, lease_digest: sha256Canonical(base) });
}

export function parseAttemptLease(input: unknown): AttemptLease {
  return attemptLeaseSchema.parse(input);
}

export function leaseIsExpired(lease: AttemptLease, now = new Date()): boolean {
  return Date.parse(parseAttemptLease(lease).expires_at) <= now.getTime();
}

/**
 * Expiry alone never authorizes effectful rerun. Pure/read tasks may re-lease
 * the same input digest; effectful tasks require explicit human/recovery path.
 */
export function reconcileExpiredLease(lease: AttemptLease, now = new Date()): {
  expired: boolean;
  may_auto_requeue: boolean;
  effect: EffectClass;
} {
  const parsed = parseAttemptLease(lease);
  const expired = leaseIsExpired(parsed, now);
  return {
    expired,
    may_auto_requeue: expired && isPure(parsed.effect),
    effect: parsed.effect
  };
}

export type ActiveLeaseIndex = {
  by_lease_id: Map<string, AttemptLease>;
  by_node_id: Map<string, AttemptLease>;
  by_attempt_id: Map<string, AttemptLease>;
};

export function createLeaseIndex(leases: readonly AttemptLease[] = []): ActiveLeaseIndex {
  const index: ActiveLeaseIndex = {
    by_lease_id: new Map(),
    by_node_id: new Map(),
    by_attempt_id: new Map()
  };
  for (const lease of leases) registerLease(index, lease);
  return index;
}

export function registerLease(index: ActiveLeaseIndex, lease: AttemptLease): void {
  const parsed = parseAttemptLease(lease);
  if (index.by_lease_id.has(parsed.lease_id)) {
    throw pcError("PC_LEASE_CONFLICT", "duplicate lease id");
  }
  if (index.by_node_id.has(parsed.node_id)) {
    throw pcError("PC_LEASE_CONFLICT", "duplicate active lease for node");
  }
  if (index.by_attempt_id.has(parsed.attempt_id)) {
    throw pcError("PC_LEASE_CONFLICT", "duplicate active lease for attempt");
  }
  index.by_lease_id.set(parsed.lease_id, parsed);
  index.by_node_id.set(parsed.node_id, parsed);
  index.by_attempt_id.set(parsed.attempt_id, parsed);
}

export function releaseLease(index: ActiveLeaseIndex, leaseId: string): void {
  const lease = index.by_lease_id.get(leaseId);
  if (!lease) throw pcError("PC_LEASE_CONFLICT", "unknown lease");
  index.by_lease_id.delete(lease.lease_id);
  index.by_node_id.delete(lease.node_id);
  index.by_attempt_id.delete(lease.attempt_id);
}
