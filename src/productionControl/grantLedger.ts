/**
 * Grant credit ledger — create-only append with root-local O_EXCL serialization.
 * Reserve before external effect; commit actual usage once; release only known
 * non-submission; quarantine/hold submission_unknown. No overwrite, no rollback
 * of committed usage, no negative balance, no concurrent double-reserve.
 *
 * Crash-atomic protocol (under root O_EXCL lock):
 *   1. write prepare journal (tx/<id>.prepared.json)
 *   2. write reservation leaf (reserved or terminal successor)
 *   3. replace budget (CAS revision)
 *   4. append audit entry
 *   5. write applied journal (tx/<id>.applied.json)
 * Incomplete prepare journals are recovered deterministically on next lock entry.
 * Terminal reservation leaves are preferred over the reserved predecessor leaf.
 */
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { assertSafeJsonValue, sha256Canonical, withoutField } from "./canonical.js";
import { acquireProductionControlRootLock, pcError } from "./errors.js";
import { digestSchema, safeIdSchema } from "./schema.js";
import {
  noteEffectBoundary,
  type EffectPolicy
} from "./rc/effectCapability.js";

const nonNegativeInt = z.number().int().nonnegative();
const finiteNonNeg = z.number().refine((n) => Number.isFinite(n) && n >= 0, "non-negative finite");
const isoDateSchema = z.string().datetime({ offset: true });

export const LEDGER_ENTRY_KINDS = [
  "budget-opened",
  "reserve",
  "commit",
  "release",
  "quarantine"
] as const;
export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];

export const RESERVATION_STATUSES = [
  "reserved",
  "committed",
  "released",
  "quarantined"
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

const reservationSubjectSchema = z
  .object({
    grant_digest: digestSchema,
    production_id: safeIdSchema,
    run_id: safeIdSchema,
    node_id: safeIdSchema,
    attempt_key: digestSchema,
    pricing_binding_digest: digestSchema,
    per_attempt_credit_cap: finiteNonNeg,
    requested_credits: finiteNonNeg
  })
  .strict();

export const ledgerReservationSchema = z
  .object({
    schema_version: z.literal(1),
    reservation_id: safeIdSchema,
    status: z.enum(RESERVATION_STATUSES),
    subject: reservationSubjectSchema,
    reserved_credits: finiteNonNeg,
    committed_credits: finiteNonNeg.optional(),
    ledger_revision: nonNegativeInt,
    created_at: isoDateSchema,
    updated_at: isoDateSchema,
    digest: digestSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["digest"],
        message: "reservation digest mismatch"
      });
    }
    if (value.status === "committed") {
      if (value.committed_credits === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["committed_credits"],
          message: "committed reservation requires committed_credits"
        });
      } else if (value.committed_credits > value.reserved_credits) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["committed_credits"],
          message: "committed credits cannot exceed reserved credits"
        });
      }
    }
  });
export type LedgerReservation = z.infer<typeof ledgerReservationSchema>;

export const ledgerBudgetSchema = z
  .object({
    schema_version: z.literal(1),
    budget_id: safeIdSchema,
    grant_digest: digestSchema,
    production_id: safeIdSchema,
    max_incremental_credits: finiteNonNeg,
    max_attempts: nonNegativeInt,
    max_submissions: nonNegativeInt,
    per_attempt_credit_cap: finiteNonNeg,
    reserved_credits: finiteNonNeg,
    committed_credits: finiteNonNeg,
    quarantined_credits: finiteNonNeg,
    attempt_count: nonNegativeInt,
    submission_count: nonNegativeInt,
    revision: nonNegativeInt,
    digest: digestSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["digest"],
        message: "ledger budget digest mismatch"
      });
    }
    const encumbered = value.reserved_credits + value.committed_credits + value.quarantined_credits;
    if (encumbered > value.max_incremental_credits + 1e-9) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ledger encumbrance exceeds max_incremental_credits"
      });
    }
  });
export type LedgerBudget = z.infer<typeof ledgerBudgetSchema>;

const txKindSchema = z.enum(["reserve", "commit", "release", "quarantine"]);
const ledgerTxPreparedSchema = z
  .object({
    schema_version: z.literal(1),
    tx_id: safeIdSchema,
    kind: txKindSchema,
    phase: z.literal("prepared"),
    reservation_id: safeIdSchema,
    previous_budget_revision: nonNegativeInt,
    planned_budget_revision: nonNegativeInt,
    planned_budget_digest: digestSchema,
    planned_reservation_digest: digestSchema,
    planned_budget: ledgerBudgetSchema,
    planned_reservation: ledgerReservationSchema,
    created_at: isoDateSchema,
    digest: digestSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["digest"],
        message: "ledger tx prepared digest mismatch"
      });
    }
  });
type LedgerTxPrepared = z.infer<typeof ledgerTxPreparedSchema>;

/**
 * Durable-boundary hooks for crash-injection tests.
 * Names match real publish points (not pre-write placeholders).
 */
export type GrantLedgerHooks = {
  afterTxPrepared?: () => void | Promise<void>;
  afterReservationLeafPublished?: () => void | Promise<void>;
  afterTerminalReservationPublished?: () => void | Promise<void>;
  afterBudgetPublished?: () => void | Promise<void>;
  afterEntryAppended?: () => void | Promise<void>;
  afterTxApplied?: () => void | Promise<void>;
};

export type DirectoryIdentity = { device: number; inode: number; real_path: string };
type FileIdentity = { device: number; inode: number };

function budgetDigestBody(budget: Omit<LedgerBudget, "digest">): Omit<LedgerBudget, "digest"> {
  return {
    schema_version: 1,
    budget_id: budget.budget_id,
    grant_digest: budget.grant_digest,
    production_id: budget.production_id,
    max_incremental_credits: budget.max_incremental_credits,
    max_attempts: budget.max_attempts,
    max_submissions: budget.max_submissions,
    per_attempt_credit_cap: budget.per_attempt_credit_cap,
    reserved_credits: budget.reserved_credits,
    committed_credits: budget.committed_credits,
    quarantined_credits: budget.quarantined_credits,
    attempt_count: budget.attempt_count,
    submission_count: budget.submission_count,
    revision: budget.revision
  };
}

function sealBudget(budget: Omit<LedgerBudget, "digest">): LedgerBudget {
  const body = budgetDigestBody(budget);
  assertSafeJsonValue(body, "ledger budget");
  return ledgerBudgetSchema.parse({ ...body, digest: sha256Canonical(body) });
}

function sealReservation(input: Omit<LedgerReservation, "digest">): LedgerReservation {
  assertSafeJsonValue(input, "ledger reservation");
  return ledgerReservationSchema.parse({
    ...input,
    digest: sha256Canonical(input)
  });
}

function sealPreparedTx(input: Omit<LedgerTxPrepared, "digest">): LedgerTxPrepared {
  assertSafeJsonValue(input, "ledger tx prepared");
  return ledgerTxPreparedSchema.parse({
    ...input,
    digest: sha256Canonical(input)
  });
}

function availableCredits(budget: LedgerBudget): number {
  return (
    budget.max_incremental_credits
    - budget.reserved_credits
    - budget.committed_credits
    - budget.quarantined_credits
  );
}

/**
 * Durable grant credit ledger rooted under production-control.
 * Layout:
 *   <root>/grant-ledger/budget.json
 *   <root>/grant-ledger/reservations/<id>.json  (create-only reserved leaf)
 *   <root>/grant-ledger/reservations/<id>.{committed,released,quarantined}.json
 *   <root>/grant-ledger/entries/<seq>-<kind>-<id>.json
 *   <root>/grant-ledger/tx/<tx_id>.prepared.json / .applied.json
 */
export class GrantCreditLedger {
  private readonly root: string;
  private readonly hooks: GrantLedgerHooks;
  private rootIdentity: DirectoryIdentity | undefined;

  constructor(root: string, options: { hooks?: GrantLedgerHooks } = {}) {
    this.root = resolve(root);
    this.hooks = options.hooks ?? {};
  }

  get ledgerRoot(): string {
    return join(this.root, "grant-ledger");
  }

  /** Public root identity for seal binding (revalidated under lock). */
  async captureRootIdentity(): Promise<DirectoryIdentity> {
    return this.withRootLock(async () => {
      const layout = await this.prepareLayout();
      return layout.identity;
    });
  }

  async openBudget(input: {
    budget_id: string;
    grant_digest: string;
    production_id: string;
    max_incremental_credits: number;
    max_attempts: number;
    max_submissions: number;
    per_attempt_credit_cap: number;
  }): Promise<LedgerBudget> {
    return this.withRootLock(async () => {
      const layout = await this.prepareLayout();
      await this.recoverIncompleteTransactions(layout);
      const existing = await this.readBudgetUnlocked(layout);
      if (existing) {
        if (
          existing.grant_digest !== input.grant_digest
          || existing.production_id !== input.production_id
          || existing.budget_id !== input.budget_id
        ) {
          throw pcError("PC_LEDGER_CONFLICT", "budget already opened with different identity");
        }
        return existing;
      }
      if (input.max_incremental_credits < 0 || input.per_attempt_credit_cap < 0) {
        throw pcError("PC_LEDGER_CONFLICT", "credit caps must be non-negative");
      }
      if (input.per_attempt_credit_cap > input.max_incremental_credits) {
        throw pcError(
          "PC_LEDGER_CONFLICT",
          "per-attempt credit cap cannot exceed total credit cap"
        );
      }
      const budget = sealBudget({
        schema_version: 1,
        budget_id: input.budget_id,
        grant_digest: input.grant_digest,
        production_id: input.production_id,
        max_incremental_credits: input.max_incremental_credits,
        max_attempts: input.max_attempts,
        max_submissions: input.max_submissions,
        per_attempt_credit_cap: input.per_attempt_credit_cap,
        reserved_credits: 0,
        committed_credits: 0,
        quarantined_credits: 0,
        attempt_count: 0,
        submission_count: 0,
        revision: 0
      });
      await this.writeBudgetCreateOnly(layout, budget);
      await this.appendEntry(layout, {
        kind: "budget-opened",
        budget_revision: budget.revision,
        reservation_id: null,
        payload_digest: budget.digest
      });
      return budget;
    });
  }

  async readBudget(): Promise<LedgerBudget | undefined> {
    return this.withRootLock(async () => {
      const layout = await this.prepareLayout();
      await this.recoverIncompleteTransactions(layout);
      return this.readBudgetUnlocked(layout);
    });
  }

  async readReservation(reservationId: string): Promise<LedgerReservation | undefined> {
    return this.withRootLock(async () => {
      const layout = await this.prepareLayout();
      await this.recoverIncompleteTransactions(layout);
      return this.readReservationUnlocked(layout, reservationId);
    });
  }

  /**
   * Atomic reserve. Fails closed on unknown price, attempt/submission exhaustion,
   * concurrent double-reserve of the same attempt_key, or insufficient credits.
   */
  async reserve(input: {
    reservation_id: string;
    grant_digest: string;
    production_id: string;
    run_id: string;
    node_id: string;
    attempt_key: string;
    pricing_binding_digest: string;
    requested_credits: number;
    price_unknown?: boolean;
    now?: string;
    /** Optional RC effect policy (deny blocks paid reserve). */
    effect_policy?: EffectPolicy;
  }): Promise<LedgerReservation> {
    if (input.price_unknown === true) {
      throw pcError("PC_RESERVATION_INVALID", "unknown price blocks reservation before provider");
    }
    // After price-unknown fail-closed: note billing boundary for known-price reserve.
    noteEffectBoundary(input.effect_policy, "billing_spend", "grantLedger.reserve");
    if (!Number.isFinite(input.requested_credits) || input.requested_credits < 0) {
      throw pcError("PC_RESERVATION_INVALID", "requested credits must be non-negative finite");
    }

    return this.withRootLock(async () => {
      const layout = await this.prepareLayout();
      await this.recoverIncompleteTransactions(layout);
      const budget = await this.requireBudget(layout);
      if (budget.grant_digest !== input.grant_digest || budget.production_id !== input.production_id) {
        throw pcError("PC_LEDGER_CONFLICT", "reserve grant/production does not match budget");
      }
      if (budget.attempt_count >= budget.max_attempts) {
        throw pcError("PC_GRANT_EXHAUSTED", "max attempts exhausted");
      }
      if (budget.submission_count >= budget.max_submissions) {
        throw pcError("PC_GRANT_EXHAUSTED", "max submissions exhausted");
      }
      if (input.requested_credits > budget.per_attempt_credit_cap + 1e-12) {
        throw pcError("PC_RESERVATION_INVALID", "requested credits exceed per-attempt cap");
      }
      const avail = availableCredits(budget);
      if (input.requested_credits > avail + 1e-12) {
        throw pcError("PC_GRANT_EXHAUSTED", "insufficient remaining credits for reserve");
      }

      const existing = await this.readReservationUnlocked(layout, input.reservation_id);
      if (existing) {
        throw pcError("PC_LEDGER_CONFLICT", "reservation id already exists");
      }
      await this.assertAttemptKeyFree(layout, input.attempt_key);

      const now = input.now ?? new Date().toISOString();
      const nextBudget = sealBudget({
        ...budgetDigestBody(budget),
        reserved_credits: budget.reserved_credits + input.requested_credits,
        attempt_count: budget.attempt_count + 1,
        revision: budget.revision + 1
      });
      const reservation = sealReservation({
        schema_version: 1,
        reservation_id: input.reservation_id,
        status: "reserved",
        subject: {
          grant_digest: input.grant_digest,
          production_id: input.production_id,
          run_id: input.run_id,
          node_id: input.node_id,
          attempt_key: input.attempt_key,
          pricing_binding_digest: input.pricing_binding_digest,
          per_attempt_credit_cap: budget.per_attempt_credit_cap,
          requested_credits: input.requested_credits
        },
        reserved_credits: input.requested_credits,
        ledger_revision: nextBudget.revision,
        created_at: now,
        updated_at: now
      });

      await this.executeTransaction(layout, {
        kind: "reserve",
        previous_budget_revision: budget.revision,
        planned_budget: nextBudget,
        planned_reservation: reservation,
        writeReservation: async () => {
          await this.writeReservationCreateOnly(layout, reservation);
          await this.hooks.afterReservationLeafPublished?.();
        }
      });
      return reservation;
    });
  }

  /** Commit actual usage exactly once after a known provider outcome. */
  async commit(input: {
    reservation_id: string;
    actual_credits: number;
    now?: string;
    effect_policy?: EffectPolicy;
  }): Promise<LedgerReservation> {
    if (!Number.isFinite(input.actual_credits) || input.actual_credits < 0) {
      throw pcError("PC_RESERVATION_INVALID", "actual credits must be non-negative finite");
    }
    noteEffectBoundary(input.effect_policy, "billing_spend", "grantLedger.commit");
    return this.withRootLock(async () => {
      const layout = await this.prepareLayout();
      await this.recoverIncompleteTransactions(layout);
      const budget = await this.requireBudget(layout);
      const reservation = await this.requireReservation(layout, input.reservation_id);
      if (reservation.status !== "reserved") {
        throw pcError("PC_RESERVATION_INVALID", "only reserved entries can be committed");
      }
      if (input.actual_credits > reservation.reserved_credits + 1e-12) {
        throw pcError("PC_RESERVATION_INVALID", "actual credits exceed reserved amount");
      }
      const now = input.now ?? new Date().toISOString();
      const nextBudget = sealBudget({
        ...budgetDigestBody(budget),
        reserved_credits: budget.reserved_credits - reservation.reserved_credits,
        committed_credits: budget.committed_credits + input.actual_credits,
        submission_count: budget.submission_count + 1,
        revision: budget.revision + 1
      });
      const nextReservation = sealReservation({
        schema_version: 1,
        reservation_id: reservation.reservation_id,
        status: "committed",
        subject: reservation.subject,
        reserved_credits: reservation.reserved_credits,
        committed_credits: input.actual_credits,
        ledger_revision: nextBudget.revision,
        created_at: reservation.created_at,
        updated_at: now
      });
      await this.executeTransaction(layout, {
        kind: "commit",
        previous_budget_revision: budget.revision,
        planned_budget: nextBudget,
        planned_reservation: nextReservation,
        writeReservation: async () => {
          await this.writeReservationTerminal(layout, nextReservation, reservation);
          await this.hooks.afterTerminalReservationPublished?.();
        }
      });
      return nextReservation;
    });
  }

  /** Release only for known non-submission (provider never accepted). */
  async release(input: {
    reservation_id: string;
    reason: "known-non-submission";
    now?: string;
  }): Promise<LedgerReservation> {
    if (input.reason !== "known-non-submission") {
      throw pcError("PC_RESERVATION_INVALID", "release requires known-non-submission reason");
    }
    return this.withRootLock(async () => {
      const layout = await this.prepareLayout();
      await this.recoverIncompleteTransactions(layout);
      const budget = await this.requireBudget(layout);
      const reservation = await this.requireReservation(layout, input.reservation_id);
      if (reservation.status === "committed") {
        throw pcError("PC_RESERVATION_INVALID", "committed reservation can never be released");
      }
      if (reservation.status !== "reserved") {
        throw pcError("PC_RESERVATION_INVALID", "only reserved entries can be released");
      }
      const now = input.now ?? new Date().toISOString();
      const nextBudget = sealBudget({
        ...budgetDigestBody(budget),
        reserved_credits: budget.reserved_credits - reservation.reserved_credits,
        revision: budget.revision + 1
      });
      const nextReservation = sealReservation({
        schema_version: 1,
        reservation_id: reservation.reservation_id,
        status: "released",
        subject: reservation.subject,
        reserved_credits: reservation.reserved_credits,
        ledger_revision: nextBudget.revision,
        created_at: reservation.created_at,
        updated_at: now
      });
      await this.executeTransaction(layout, {
        kind: "release",
        previous_budget_revision: budget.revision,
        planned_budget: nextBudget,
        planned_reservation: nextReservation,
        writeReservation: async () => {
          await this.writeReservationTerminal(layout, nextReservation, reservation);
          await this.hooks.afterTerminalReservationPublished?.();
        }
      });
      return nextReservation;
    });
  }

  /**
   * Quarantine / hold after submission_unknown — credits stay encumbered,
   * never released for automatic retry.
   */
  async quarantine(input: {
    reservation_id: string;
    now?: string;
  }): Promise<LedgerReservation> {
    return this.withRootLock(async () => {
      const layout = await this.prepareLayout();
      await this.recoverIncompleteTransactions(layout);
      const budget = await this.requireBudget(layout);
      const reservation = await this.requireReservation(layout, input.reservation_id);
      if (reservation.status !== "reserved") {
        throw pcError("PC_RESERVATION_INVALID", "only reserved entries can be quarantined");
      }
      const now = input.now ?? new Date().toISOString();
      const nextBudget = sealBudget({
        ...budgetDigestBody(budget),
        reserved_credits: budget.reserved_credits - reservation.reserved_credits,
        quarantined_credits: budget.quarantined_credits + reservation.reserved_credits,
        submission_count: budget.submission_count + 1,
        revision: budget.revision + 1
      });
      const nextReservation = sealReservation({
        schema_version: 1,
        reservation_id: reservation.reservation_id,
        status: "quarantined",
        subject: reservation.subject,
        reserved_credits: reservation.reserved_credits,
        ledger_revision: nextBudget.revision,
        created_at: reservation.created_at,
        updated_at: now
      });
      await this.executeTransaction(layout, {
        kind: "quarantine",
        previous_budget_revision: budget.revision,
        planned_budget: nextBudget,
        planned_reservation: nextReservation,
        writeReservation: async () => {
          await this.writeReservationTerminal(layout, nextReservation, reservation);
          await this.hooks.afterTerminalReservationPublished?.();
        }
      });
      return nextReservation;
    });
  }

  /**
   * Force recovery pass (also runs under every mutating call).
   * When a budget leaf exists, re-parse it so corrupt ledger state surfaces
   * on resume instead of being silently ignored until the next paid mutation.
   */
  async recover(): Promise<{ recovered_tx_ids: string[] }> {
    return this.withRootLock(async () => {
      const layout = await this.prepareLayout();
      const recovered = await this.recoverIncompleteTransactions(layout);
      // Fail closed on corrupt budget evidence when present.
      await this.readBudgetUnlocked(layout);
      return recovered;
    });
  }

  private async executeTransaction(
    layout: Layout,
    input: {
      kind: "reserve" | "commit" | "release" | "quarantine";
      previous_budget_revision: number;
      planned_budget: LedgerBudget;
      planned_reservation: LedgerReservation;
      writeReservation: () => Promise<void>;
    }
  ): Promise<void> {
    await this.recheckRootIdentity(layout);
    const txId = `tx-${randomSuffix()}`;
    const prepared = sealPreparedTx({
      schema_version: 1,
      tx_id: txId,
      kind: input.kind,
      phase: "prepared",
      reservation_id: input.planned_reservation.reservation_id,
      previous_budget_revision: input.previous_budget_revision,
      planned_budget_revision: input.planned_budget.revision,
      planned_budget_digest: input.planned_budget.digest,
      planned_reservation_digest: input.planned_reservation.digest,
      planned_budget: input.planned_budget,
      planned_reservation: input.planned_reservation,
      created_at: new Date().toISOString()
    });
    await this.writePreparedTx(layout, prepared);
    await this.hooks.afterTxPrepared?.();

    await input.writeReservation();
    await this.recheckRootIdentity(layout);

    await this.writeBudgetReplace(layout, input.planned_budget, input.previous_budget_revision);
    await this.hooks.afterBudgetPublished?.();
    await this.recheckRootIdentity(layout);

    await this.appendEntry(layout, {
      kind: input.kind,
      budget_revision: input.planned_budget.revision,
      reservation_id: input.planned_reservation.reservation_id,
      payload_digest: input.planned_reservation.digest
    });
    await this.hooks.afterEntryAppended?.();

    await this.writeAppliedTx(layout, prepared);
    await this.hooks.afterTxApplied?.();
  }

  private async recoverIncompleteTransactions(
    layout: Layout
  ): Promise<{ recovered_tx_ids: string[] }> {
    const recovered: string[] = [];
    let names: string[];
    try {
      names = await readdir(layout.txDir);
    } catch {
      return { recovered_tx_ids: recovered };
    }
    const preparedIds = names
      .filter((name) => name.endsWith(".prepared.json"))
      .map((name) => name.replace(/\.prepared\.json$/, ""))
      .filter((id) => isSafeId(id));

    for (const txId of preparedIds.sort()) {
      const appliedPath = join(layout.txDir, `${txId}.applied.json`);
      if (await pathExists(appliedPath)) {
        // Applied already published; prepared is historical evidence only.
        continue;
      }
      const preparedPath = join(layout.txDir, `${txId}.prepared.json`);
      let prepared: LedgerTxPrepared;
      try {
        await assertSafeRegularFile(preparedPath, layout.rootPath);
        prepared = ledgerTxPreparedSchema.parse(JSON.parse(await readFile(preparedPath, "utf8")));
      } catch {
        // Unreadable prepared journal → quarantine name by renaming aside.
        const quarantine = join(layout.txDir, `${txId}.prepared.quarantined.${randomSuffix()}.json`);
        await rename(preparedPath, quarantine).catch(() => undefined);
        continue;
      }

      const liveReservation = await this.readReservationUnlocked(layout, prepared.reservation_id);
      const liveBudget = await this.readBudgetUnlocked(layout);

      if (!liveReservation && (!liveBudget || liveBudget.revision === prepared.previous_budget_revision)) {
        // Nothing durable from this tx — safe orphan prepared marker.
        // Keep marker as evidence; do not invent reservation/budget.
        continue;
      }

      if (
        liveReservation
        && liveReservation.digest === prepared.planned_reservation_digest
        && liveBudget
        && liveBudget.revision === prepared.planned_budget_revision
        && liveBudget.digest === prepared.planned_budget_digest
      ) {
        await this.writeAppliedTx(layout, prepared);
        recovered.push(txId);
        continue;
      }

      if (
        liveReservation
        && liveReservation.digest === prepared.planned_reservation_digest
        && liveBudget
        && liveBudget.revision === prepared.previous_budget_revision
      ) {
        // Reservation published, budget not yet — complete budget + entry + applied.
        await this.writeBudgetReplace(
          layout,
          prepared.planned_budget,
          prepared.previous_budget_revision
        );
        await this.appendEntry(layout, {
          kind: prepared.kind,
          budget_revision: prepared.planned_budget.revision,
          reservation_id: prepared.reservation_id,
          payload_digest: prepared.planned_reservation_digest
        });
        await this.writeAppliedTx(layout, prepared);
        recovered.push(txId);
        continue;
      }

      if (
        liveBudget
        && liveBudget.revision === prepared.planned_budget_revision
        && liveBudget.digest === prepared.planned_budget_digest
        && (!liveReservation || liveReservation.digest !== prepared.planned_reservation_digest)
      ) {
        // Budget advanced without matching reservation — fail closed.
        throw pcError(
          "PC_LEDGER_UNSAFE",
          "incomplete ledger transaction: budget advanced without matching reservation"
        );
      }

      // Ambiguous partial — quarantine prepared for human inspection; do not invent state.
      const quarantine = join(layout.txDir, `${txId}.prepared.quarantined.${randomSuffix()}.json`);
      await rename(preparedPath, quarantine).catch(() => undefined);
    }
    return { recovered_tx_ids: recovered };
  }

  private async withRootLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = await acquireProductionControlRootLock(this.root);
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }

  private async prepareLayout(): Promise<Layout> {
    const rootPath = resolve(this.root);
    await assertSafeDirectory(rootPath);
    const ledgerDir = join(rootPath, "grant-ledger");
    const reservationsDir = join(ledgerDir, "reservations");
    const entriesDir = join(ledgerDir, "entries");
    const txDir = join(ledgerDir, "tx");
    await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
    await mkdir(reservationsDir, { recursive: true, mode: 0o700 });
    await mkdir(entriesDir, { recursive: true, mode: 0o700 });
    await mkdir(txDir, { recursive: true, mode: 0o700 });
    await assertSafeDirectory(ledgerDir);
    await assertSafeDirectory(reservationsDir);
    await assertSafeDirectory(entriesDir);
    await assertSafeDirectory(txDir);
    const identity = await captureDirIdentity(rootPath);
    if (this.rootIdentity) {
      if (
        this.rootIdentity.device !== identity.device
        || this.rootIdentity.inode !== identity.inode
        || this.rootIdentity.real_path !== identity.real_path
      ) {
        throw pcError("PC_PATH_UNSAFE", "ledger root identity changed");
      }
    } else {
      this.rootIdentity = identity;
    }
    return {
      rootPath,
      ledgerDir,
      reservationsDir,
      entriesDir,
      txDir,
      budgetPath: join(ledgerDir, "budget.json"),
      identity
    };
  }

  private async recheckRootIdentity(layout: Layout): Promise<void> {
    const live = await captureDirIdentity(layout.rootPath);
    if (
      live.device !== layout.identity.device
      || live.inode !== layout.identity.inode
      || live.real_path !== layout.identity.real_path
    ) {
      throw pcError("PC_PATH_UNSAFE", "ledger root identity changed during mutation");
    }
    if (this.rootIdentity) {
      if (
        this.rootIdentity.device !== live.device
        || this.rootIdentity.inode !== live.inode
      ) {
        throw pcError("PC_PATH_UNSAFE", "ledger root identity drift");
      }
    }
  }

  private async readBudgetUnlocked(layout: {
    budgetPath: string;
    rootPath: string;
  }): Promise<LedgerBudget | undefined> {
    try {
      await assertSafeRegularFile(layout.budgetPath, layout.rootPath);
      const raw = await readFile(layout.budgetPath, "utf8");
      return ledgerBudgetSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      if (error && typeof error === "object" && "code" in error) throw error;
      throw pcError("PC_LEDGER_UNSAFE", "budget file is unreadable or invalid");
    }
  }

  private async requireBudget(layout: {
    budgetPath: string;
    rootPath: string;
  }): Promise<LedgerBudget> {
    const budget = await this.readBudgetUnlocked(layout);
    if (!budget) throw pcError("PC_LEDGER_CONFLICT", "ledger budget is not open");
    return budget;
  }

  /**
   * Terminal leaves win over the reserved predecessor so a reserved leaf can
   * never override committed/released/quarantined truth after terminal publish.
   */
  private async readReservationUnlocked(
    layout: { reservationsDir: string; rootPath: string },
    reservationId: string
  ): Promise<LedgerReservation | undefined> {
    if (!isSafeId(reservationId)) {
      throw pcError("PC_PATH_UNSAFE", "reservation id is not a safe id");
    }
    const terminalOrder = [".committed", ".released", ".quarantined"] as const;
    for (const suffix of terminalOrder) {
      const path = join(layout.reservationsDir, `${reservationId}${suffix}.json`);
      try {
        await assertSafeRegularFile(path, layout.rootPath);
        const raw = await readFile(path, "utf8");
        const parsed = ledgerReservationSchema.parse(JSON.parse(raw));
        if (suffix === ".committed" && parsed.status === "committed") return parsed;
        if (suffix === ".released" && parsed.status === "released") return parsed;
        if (suffix === ".quarantined" && parsed.status === "quarantined") return parsed;
        throw pcError("PC_LEDGER_UNSAFE", "terminal reservation status/path mismatch");
      } catch (error) {
        if (isNotFound(error)) continue;
        if (error && typeof error === "object" && "name" in error && (error as { name?: string }).name === "ZodError") {
          throw pcError("PC_LEDGER_UNSAFE", "reservation file failed schema validation");
        }
        if (error && typeof error === "object" && "code" in error) throw error;
        throw pcError("PC_LEDGER_UNSAFE", "reservation file is unreadable");
      }
    }
    const reservedPath = join(layout.reservationsDir, `${reservationId}.json`);
    try {
      await assertSafeRegularFile(reservedPath, layout.rootPath);
      const parsed = ledgerReservationSchema.parse(JSON.parse(await readFile(reservedPath, "utf8")));
      if (parsed.status === "reserved") return parsed;
      throw pcError("PC_LEDGER_UNSAFE", "reserved leaf has non-reserved status");
    } catch (error) {
      if (isNotFound(error)) return undefined;
      if (error && typeof error === "object" && "name" in error && (error as { name?: string }).name === "ZodError") {
        throw pcError("PC_LEDGER_UNSAFE", "reservation file failed schema validation");
      }
      if (error && typeof error === "object" && "code" in error) throw error;
      throw pcError("PC_LEDGER_UNSAFE", "reservation file is unreadable");
    }
  }

  private async requireReservation(
    layout: { reservationsDir: string; rootPath: string },
    reservationId: string
  ): Promise<LedgerReservation> {
    const reservation = await this.readReservationUnlocked(layout, reservationId);
    if (!reservation) throw pcError("PC_RESERVATION_INVALID", "reservation not found");
    return reservation;
  }

  private async assertAttemptKeyFree(
    layout: { reservationsDir: string; rootPath: string },
    attemptKey: string
  ): Promise<void> {
    let names: string[];
    try {
      names = await readdir(layout.reservationsDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      // Skip terminal successor filenames for open-key scan; still read reserved leaves only.
      if (
        name.includes(".committed.")
        || name.endsWith(".committed.json")
        || name.includes(".released.")
        || name.endsWith(".released.json")
        || name.includes(".quarantined.")
        || name.endsWith(".quarantined.json")
      ) {
        continue;
      }
      const path = join(layout.reservationsDir, name);
      try {
        await assertSafeRegularFile(path, layout.rootPath);
        const parsed = ledgerReservationSchema.parse(JSON.parse(await readFile(path, "utf8")));
        // Terminal truth may coexist as sibling leaf; only open reserved blocks the key.
        const id = parsed.reservation_id;
        const terminal = await this.readReservationUnlocked(layout, id);
        if (terminal && terminal.status !== "reserved") continue;
        if (parsed.status === "reserved" && parsed.subject.attempt_key === attemptKey) {
          throw pcError("PC_LEDGER_CONFLICT", "attempt_key already has an open reservation");
        }
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "PC_LEDGER_CONFLICT") {
          throw error;
        }
        if (isNotFound(error)) continue;
      }
    }
  }

  private async writeBudgetCreateOnly(
    layout: { budgetPath: string; rootPath: string; ledgerDir: string },
    budget: LedgerBudget
  ): Promise<void> {
    await publishCreateOnlyJson(layout.budgetPath, layout.rootPath, layout.ledgerDir, budget);
  }

  private async writeBudgetReplace(
    layout: { budgetPath: string; rootPath: string; ledgerDir: string },
    budget: LedgerBudget,
    expectedPreviousRevision: number
  ): Promise<void> {
    const current = await this.readBudgetUnlocked(layout);
    if (!current || current.revision !== expectedPreviousRevision) {
      throw pcError("PC_LEDGER_CONFLICT", "budget revision CAS mismatch");
    }
    if (budget.revision !== expectedPreviousRevision + 1) {
      throw pcError("PC_LEDGER_CONFLICT", "budget revision must advance by exactly one");
    }
    const tempPath = join(layout.ledgerDir, `.budget.${process.pid}.${randomSuffix()}.tmp`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        tempPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      await handle.writeFile(`${JSON.stringify(budget)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      const recheck = await this.readBudgetUnlocked(layout);
      if (!recheck || recheck.revision !== expectedPreviousRevision) {
        throw pcError("PC_LEDGER_CONFLICT", "budget revision changed before replace");
      }
      await rename(tempPath, layout.budgetPath);
      await fsyncDirectory(layout.ledgerDir);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
      if (error && typeof error === "object" && "code" in error) throw error;
      throw pcError("PC_LEDGER_UNSAFE", "budget replace failed");
    }
  }

  private async writeReservationCreateOnly(
    layout: { reservationsDir: string; rootPath: string },
    reservation: LedgerReservation
  ): Promise<void> {
    if (!isSafeId(reservation.reservation_id)) {
      throw pcError("PC_PATH_UNSAFE", "reservation id is not a safe id");
    }
    const finalPath = join(layout.reservationsDir, `${reservation.reservation_id}.json`);
    await publishCreateOnlyJson(finalPath, layout.rootPath, layout.reservationsDir, reservation);
  }

  private async writeReservationTerminal(
    layout: { reservationsDir: string; rootPath: string },
    next: LedgerReservation,
    previous: LedgerReservation
  ): Promise<void> {
    if (previous.status !== "reserved") {
      throw pcError("PC_RESERVATION_INVALID", "terminal transition requires reserved predecessor");
    }
    const suffix =
      next.status === "committed"
        ? ".committed"
        : next.status === "released"
          ? ".released"
          : next.status === "quarantined"
            ? ".quarantined"
            : null;
    if (!suffix) throw pcError("PC_RESERVATION_INVALID", "invalid terminal reservation status");
    // Refuse if any terminal already exists (create-only terminal race).
    for (const existing of [".committed", ".released", ".quarantined"] as const) {
      const path = join(layout.reservationsDir, `${next.reservation_id}${existing}.json`);
      if (await pathExists(path)) {
        throw pcError("PC_LEDGER_CONFLICT", "terminal reservation already exists");
      }
    }
    const finalPath = join(layout.reservationsDir, `${next.reservation_id}${suffix}.json`);
    await publishCreateOnlyJson(finalPath, layout.rootPath, layout.reservationsDir, next);
  }

  private async writePreparedTx(layout: Layout, prepared: LedgerTxPrepared): Promise<void> {
    const path = join(layout.txDir, `${prepared.tx_id}.prepared.json`);
    await publishCreateOnlyJson(path, layout.rootPath, layout.txDir, prepared);
  }

  private async writeAppliedTx(layout: Layout, prepared: LedgerTxPrepared): Promise<void> {
    const body = {
      schema_version: 1 as const,
      tx_id: prepared.tx_id,
      kind: prepared.kind,
      phase: "applied" as const,
      reservation_id: prepared.reservation_id,
      planned_budget_revision: prepared.planned_budget_revision,
      planned_budget_digest: prepared.planned_budget_digest,
      planned_reservation_digest: prepared.planned_reservation_digest,
      applied_at: new Date().toISOString()
    };
    assertSafeJsonValue(body, "ledger tx applied");
    const sealed = {
      ...body,
      digest: sha256Canonical(body)
    };
    const path = join(layout.txDir, `${prepared.tx_id}.applied.json`);
    try {
      await publishCreateOnlyJson(path, layout.rootPath, layout.txDir, sealed);
    } catch (error) {
      // Idempotent recovery may race applied publish.
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "PC_LEDGER_CONFLICT") {
        return;
      }
      throw error;
    }
  }

  private async appendEntry(
    layout: { entriesDir: string; rootPath: string },
    entry: {
      kind: LedgerEntryKind;
      budget_revision: number;
      reservation_id: string | null;
      payload_digest: string;
    }
  ): Promise<void> {
    const body = {
      schema_version: 1 as const,
      entry_id: `${entry.budget_revision}-${entry.kind}-${entry.reservation_id ?? "budget"}`,
      kind: entry.kind,
      budget_revision: entry.budget_revision,
      reservation_id: entry.reservation_id,
      payload_digest: entry.payload_digest,
      created_at: new Date().toISOString()
    };
    assertSafeJsonValue(body, "ledger entry");
    const fileName = `${String(entry.budget_revision).padStart(8, "0")}-${entry.kind}-${entry.reservation_id ?? "budget"}.json`;
    if (fileName.includes("/") || fileName.includes("\\") || fileName.includes("\0")) {
      throw pcError("PC_PATH_UNSAFE", "ledger entry name is unsafe");
    }
    const finalPath = join(layout.entriesDir, fileName);
    try {
      await publishCreateOnlyJson(finalPath, layout.rootPath, layout.entriesDir, body);
    } catch (error) {
      // Recovery replay of entry is idempotent when the same revision already exists.
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "PC_LEDGER_CONFLICT") {
        return;
      }
      throw error;
    }
  }
}

type Layout = {
  rootPath: string;
  ledgerDir: string;
  reservationsDir: string;
  entriesDir: string;
  txDir: string;
  budgetPath: string;
  identity: DirectoryIdentity;
};

async function publishCreateOnlyJson(
  finalPath: string,
  rootPath: string,
  dirPath: string,
  value: unknown
): Promise<void> {
  assertContained(finalPath, rootPath);
  assertContained(finalPath, dirPath);
  await assertFinalLeafAvailable(finalPath);
  const tempPath = join(dirPath, `.${randomSuffix()}.tmp`);
  const reservePath = `${finalPath}.reserve`;
  let handle: FileHandle | undefined;
  let reserved = false;
  try {
    handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await reserveLeaf(finalPath, reservePath);
    reserved = true;
    await assertFinalLeafAvailable(finalPath);
    try {
      await link(tempPath, finalPath);
    } catch (error) {
      if (isAlreadyExists(error)) {
        const live = await lstat(finalPath).catch(() => undefined);
        if (live?.isSymbolicLink()) throw pcError("PC_PATH_UNSAFE", "ledger leaf must not be a symbolic link");
        throw pcError("PC_LEDGER_CONFLICT", "ledger leaf already exists");
      }
      throw pcError("PC_LEDGER_UNSAFE", "ledger leaf publication failed");
    }
    await fsyncDirectory(dirPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  } finally {
    await unlink(tempPath).catch(() => undefined);
    if (reserved) await unlink(reservePath).catch(() => undefined);
  }
}

async function reserveLeaf(finalPath: string, reservePath: string): Promise<FileIdentity> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      reservePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    await handle.writeFile("reserve\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const stats = await lstat(reservePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw pcError("PC_PATH_UNSAFE", "ledger reserve leaf is unsafe");
    }
    return { device: stats.dev, inode: stats.ino };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (isAlreadyExists(error)) {
      throw pcError("PC_LEDGER_CONFLICT", "ledger reserve already held");
    }
    if (error && typeof error === "object" && "code" in error) throw error;
    throw pcError("PC_LEDGER_UNSAFE", "ledger reserve failed");
  }
}

async function assertFinalLeafAvailable(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw pcError("PC_PATH_UNSAFE", "ledger leaf must not be a symbolic link");
    throw pcError("PC_LEDGER_CONFLICT", "ledger leaf already exists");
  } catch (error) {
    if (isNotFound(error)) return;
    if (error && typeof error === "object" && "code" in error) throw error;
    throw pcError("PC_LEDGER_UNSAFE", "ledger leaf availability check failed");
  }
}

async function assertSafeDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw pcError("PC_PATH_UNSAFE", "ledger directory must be a real directory");
  }
  for (let current = resolve(path);; current = dirname(current)) {
    const ancestor = await lstat(current);
    if (ancestor.isSymbolicLink()) {
      throw pcError("PC_PATH_UNSAFE", "ledger path has a symbolic-link ancestor");
    }
    if (current === dirname(current)) break;
  }
}

async function assertSafeRegularFile(path: string, root: string): Promise<void> {
  assertContained(path, root);
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw pcError("PC_PATH_UNSAFE", "ledger file must be a regular file");
  }
}

async function captureDirIdentity(path: string): Promise<DirectoryIdentity> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw pcError("PC_PATH_UNSAFE", "ledger root is unsafe");
  }
  return { device: stats.dev, inode: stats.ino, real_path: await realpath(path) };
}

/**
 * Robust containment: resolve both sides, require relative path that does not
 * escape via `..` segments (never use substring includes("..")).
 */
function assertContained(target: string, root: string): void {
  const resolvedTarget = resolve(target);
  const resolvedRoot = resolve(root);
  if (resolvedTarget === resolvedRoot) return;
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel === "" || isAbsolute(rel)) {
    throw pcError("PC_PATH_UNSAFE", "ledger path escapes root");
  }
  const segments = rel.split(/[/\\]/);
  if (segments[0] === ".." || segments.includes("..")) {
    throw pcError("PC_PATH_UNSAFE", "ledger path escapes root");
  }
  // Defense in depth for platforms where relative() is surprising.
  const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  if (!resolvedTarget.startsWith(rootPrefix)) {
    throw pcError("PC_PATH_UNSAFE", "ledger path escapes root");
  }
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value.length <= 128;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EEXIST");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function randomSuffix(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    await handle.sync();
  } catch {
    // best-effort
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
