import { basename, join, resolve } from "node:path";
import type { Issue } from "../types.js";

/** Sibling of durable project dirs; not a launcher project entry. */
export const PROMOTION_JOURNAL_DIR_NAME = ".tsugite-promote-journal";

/** Prefix for destination backups retained until commit/rollback settles. */
export const PROMOTION_BACKUP_PREFIX = ".tsugite-promote-backup-";

/** Prefix for per-switch staging directories under the durable projects home. */
export const PROMOTION_STAGING_PREFIX = ".promote-";

export type PromotionJournalPhase =
  | "switching"
  | "open"
  | "committing"
  | "committed"
  | "rolling_back"
  | "rolled_back";

export const PROMOTION_JOURNAL_PHASES = new Set<PromotionJournalPhase>([
  "switching",
  "open",
  "committing",
  "committed",
  "rolling_back",
  "rolled_back"
]);

/**
 * Durable promotion transaction journal under the launcher projects home.
 * Independent of finalize's project-local quarantine journal.
 *
 * Write-ahead order for a live switch:
 * 1. phase=switching with destination/backup/staging paths (before first rename)
 * 2. rename old destination → backup (if any)
 * 3. rename staging project → destination
 * 4. phase=open (switch complete; staging_path cleared)
 */
export type PromotionJournal = {
  schema_version: 1;
  projects_home: string;
  destination_root: string;
  backup_path: string | null;
  /**
   * Staging directory that holds the copied project tree during switch.
   * Required while phase=switching; null once the switch reaches open/commit/rollback.
   */
  staging_path: string | null;
  created_fresh: boolean;
  phase: PromotionJournalPhase;
  project_slug?: string;
  /**
   * Per-switch nonce that binds backup/staging basenames to this journal.
   * Present on all newly written journals. Legacy journals omit it and recover
   * only when backup/staging basenames are destination-slug-bound unambiguously.
   */
  transaction_id?: string;
  created_at: string;
  updated_at: string;
};

/** Separates destination slug from transaction_id in backup/staging basenames. */
export const PROMOTION_IDENTITY_SEPARATOR = "--";

/** Safe token for destination basenames and transaction ids embedded in path names. */
export const PROMOTION_IDENTITY_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type PromotionJournalLoadResult =
  | { status: "missing" }
  | { status: "invalid"; issues: Issue[] }
  | { status: "ok"; journal: PromotionJournal; journalPath: string };

export type RecoverPromotionTransactionsResult = {
  ok: boolean;
  issues: Issue[];
  recovered: number;
  cleared: number;
};

export class PromotionJournalError extends Error {
  readonly code: string;
  readonly path?: string;

  constructor(issue: { code: string; message: string; path?: string }) {
    super(issue.message);
    this.name = "PromotionJournalError";
    this.code = issue.code;
    if (issue.path !== undefined) this.path = issue.path;
  }
}

export function promotionJournalDir(projectsHome: string): string {
  return join(resolve(projectsHome), PROMOTION_JOURNAL_DIR_NAME);
}

export function promotionJournalPath(projectsHome: string, destinationRoot: string): string {
  const name = sanitizeJournalFileName(basename(resolve(destinationRoot)));
  return join(promotionJournalDir(projectsHome), `${name}.json`);
}

function sanitizeJournalFileName(name: string): string {
  const trimmed = name.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) return trimmed;
  // Stable fallback for odd destination basenames (never path separators).
  return `dir-${Buffer.from(trimmed).toString("hex").slice(0, 48) || "unknown"}`;
}

export function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
