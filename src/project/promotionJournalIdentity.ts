import { basename, resolve } from "node:path";
import type { Issue } from "../types.js";
import {
  PROMOTION_BACKUP_PREFIX,
  PROMOTION_IDENTITY_SEPARATOR,
  PROMOTION_IDENTITY_TOKEN,
  PROMOTION_STAGING_PREFIX,
  PROMOTION_JOURNAL_PHASES,
  PromotionJournalError,
  promotionJournalPath,
  type PromotionJournal,
  type PromotionJournalPhase
} from "./promotionJournalShared.js";

/**
 * Build the exact backup directory basename for a bound promotion.
 * Format: `.tsugite-promote-backup-<destSlug>--<transactionId>`
 */
export function promotionBackupBaseName(destSlug: string, transactionId: string): string {
  assertIdentityToken(destSlug, "destination slug");
  assertIdentityToken(transactionId, "transaction_id");
  return `${PROMOTION_BACKUP_PREFIX}${destSlug}${PROMOTION_IDENTITY_SEPARATOR}${transactionId}`;
}

/**
 * Build the mkdtemp prefix for a bound staging directory (trailing `-` required by mkdtemp).
 * Format: `.promote-<destSlug>--<transactionId>-`
 */
export function promotionStagingBasePrefix(destSlug: string, transactionId: string): string {
  assertIdentityToken(destSlug, "destination slug");
  assertIdentityToken(transactionId, "transaction_id");
  return `${PROMOTION_STAGING_PREFIX}${destSlug}${PROMOTION_IDENTITY_SEPARATOR}${transactionId}-`;
}

function assertIdentityToken(value: string, label: string): void {
  if (!PROMOTION_IDENTITY_TOKEN.test(value)) {
    throw new PromotionJournalError({
      code: "promotion.journal_identity_mismatch",
      message: `promotion ${label} is not a safe identity token`
    });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Destination slug used for path binding: basename of destination_root.
 * Must be a direct child name under projects home (already enforced elsewhere).
 */
export function promotionDestinationSlug(destinationRoot: string): string {
  return basename(resolve(destinationRoot));
}

/**
 * Fail-closed identity binding for backup basenames.
 * - With transaction_id: exact `.tsugite-promote-backup-<slug>--<id>`
 * - Legacy (no transaction_id): `.tsugite-promote-backup-<slug>-<digits only>`
 *   (timestamp-style suffix; rejects sibling-slug prefixes like job vs job-a)
 */
export function isPromotionBackupBoundToIdentity(
  backupBaseName: string,
  destSlug: string,
  transactionId: string | undefined
): boolean {
  if (!PROMOTION_IDENTITY_TOKEN.test(destSlug)) return false;
  if (transactionId !== undefined) {
    if (!PROMOTION_IDENTITY_TOKEN.test(transactionId)) return false;
    return backupBaseName === promotionBackupBaseName(destSlug, transactionId);
  }
  // Legacy recoverable shape only: numeric suffix after exact slug.
  const legacy = new RegExp(
    `^${escapeRegExp(PROMOTION_BACKUP_PREFIX + destSlug)}-[0-9]+$`
  );
  return legacy.test(backupBaseName);
}

/**
 * Fail-closed identity binding for staging basenames.
 * - With transaction_id: `.promote-<slug>--<id>` or `.promote-<slug>--<id>-<alnum>`
 * - Legacy: `.promote-<slug>-<alnum>` (no hyphens in suffix → job cannot claim job-a staging)
 */
export function isPromotionStagingBoundToIdentity(
  stagingBaseName: string,
  destSlug: string,
  transactionId: string | undefined
): boolean {
  if (!PROMOTION_IDENTITY_TOKEN.test(destSlug)) return false;
  if (transactionId !== undefined) {
    if (!PROMOTION_IDENTITY_TOKEN.test(transactionId)) return false;
    const exact = `${PROMOTION_STAGING_PREFIX}${destSlug}${PROMOTION_IDENTITY_SEPARATOR}${transactionId}`;
    if (stagingBaseName === exact) return true;
    const withSuffix = new RegExp(
      `^${escapeRegExp(exact)}-[A-Za-z0-9]+$`
    );
    return withSuffix.test(stagingBaseName);
  }
  const legacy = new RegExp(
    `^${escapeRegExp(PROMOTION_STAGING_PREFIX + destSlug)}-[A-Za-z0-9]+$`
  );
  return legacy.test(stagingBaseName);
}

/**
 * Validate that journal path, destination, backup, and staging share one promotion identity.
 * Returns an Issue when binding fails (caller must not rename/rm/clear).
 */
export function inspectPromotionIdentityBinding(
  journal: PromotionJournal,
  journalPath: string
): Issue | undefined {
  const destSlug = promotionDestinationSlug(journal.destination_root);
  const expectedJournalPath = promotionJournalPath(
    journal.projects_home,
    journal.destination_root
  );
  if (resolve(journalPath) !== resolve(expectedJournalPath)) {
    return {
      code: "promotion.journal_identity_mismatch",
      message: "promotion journal file name is not bound to destination_root identity",
      path: journalPath
    };
  }

  if (journal.transaction_id !== undefined) {
    if (
      typeof journal.transaction_id !== "string"
      || !PROMOTION_IDENTITY_TOKEN.test(journal.transaction_id)
    ) {
      return {
        code: "promotion.journal_identity_mismatch",
        message: "promotion journal transaction_id is missing or not a safe identity token",
        path: journalPath
      };
    }
  }

  // Odd destination basenames (spaces etc.) only appear in legacy/edge journals.
  // Without backup/staging there is nothing foreign to bind; still refuse mutation of
  // unbindable backup/staging trees rather than guessing a slug encoding.
  const destSlugSafe = PROMOTION_IDENTITY_TOKEN.test(destSlug);
  if (!destSlugSafe && (journal.backup_path !== null || journal.staging_path !== null)) {
    return {
      code: "promotion.journal_identity_mismatch",
      message: "promotion destination basename cannot safely bind backup/staging identity",
      path: journal.destination_root
    };
  }

  if (journal.backup_path !== null) {
    const backupBase = basename(resolve(journal.backup_path));
    if (!isPromotionBackupBoundToIdentity(backupBase, destSlug, journal.transaction_id)) {
      return {
        code: "promotion.journal_identity_mismatch",
        message: journal.transaction_id
          ? "promotion backup_path is not bound to destination slug and transaction_id"
          : "promotion backup_path is not bound to destination slug (legacy numeric suffix required)",
        path: journal.backup_path
      };
    }
  }

  if (journal.staging_path !== null) {
    const stagingBase = basename(resolve(journal.staging_path));
    if (!isPromotionStagingBoundToIdentity(stagingBase, destSlug, journal.transaction_id)) {
      return {
        code: "promotion.journal_identity_mismatch",
        message: journal.transaction_id
          ? "promotion staging_path is not bound to destination slug and transaction_id"
          : "promotion staging_path is not bound to destination slug (legacy alnum suffix required)",
        path: journal.staging_path
      };
    }
  }

  return undefined;
}

export function parsePromotionJournalSchema(
  raw: unknown,
  journalPath: string
): { ok: true; journal: PromotionJournal } | { ok: false; issues: Issue[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      issues: [{
        code: "promotion.journal_invalid",
        message: "promotion journal root must be an object",
        path: journalPath
      }]
    };
  }
  const value = raw as Record<string, unknown>;
  if (value.schema_version !== 1) {
    return {
      ok: false,
      issues: [{
        code: "promotion.journal_invalid",
        message: "promotion journal schema_version must be 1",
        path: journalPath
      }]
    };
  }
  if (typeof value.projects_home !== "string" || value.projects_home.length === 0) {
    return {
      ok: false,
      issues: [{
        code: "promotion.journal_invalid",
        message: "promotion journal projects_home must be a non-empty string",
        path: journalPath
      }]
    };
  }
  if (typeof value.destination_root !== "string" || value.destination_root.length === 0) {
    return {
      ok: false,
      issues: [{
        code: "promotion.journal_invalid",
        message: "promotion journal destination_root must be a non-empty string",
        path: journalPath
      }]
    };
  }
  if (
    value.backup_path !== null
    && value.backup_path !== undefined
    && typeof value.backup_path !== "string"
  ) {
    return {
      ok: false,
      issues: [{
        code: "promotion.journal_invalid",
        message: "promotion journal backup_path must be a string or null",
        path: journalPath
      }]
    };
  }
  if (
    value.staging_path !== null
    && value.staging_path !== undefined
    && typeof value.staging_path !== "string"
  ) {
    return {
      ok: false,
      issues: [{
        code: "promotion.journal_invalid",
        message: "promotion journal staging_path must be a string or null",
        path: journalPath
      }]
    };
  }
  if (typeof value.created_fresh !== "boolean") {
    return {
      ok: false,
      issues: [{
        code: "promotion.journal_invalid",
        message: "promotion journal created_fresh must be a boolean",
        path: journalPath
      }]
    };
  }
  if (typeof value.phase !== "string" || !PROMOTION_JOURNAL_PHASES.has(value.phase as PromotionJournalPhase)) {
    return {
      ok: false,
      issues: [{
        code: "promotion.journal_invalid",
        message: "promotion journal phase is unknown or missing",
        path: journalPath
      }]
    };
  }
  if (typeof value.created_at !== "string" || typeof value.updated_at !== "string") {
    return {
      ok: false,
      issues: [{
        code: "promotion.journal_invalid",
        message: "promotion journal timestamps must be strings",
        path: journalPath
      }]
    };
  }
  if (
    value.project_slug !== undefined
    && (typeof value.project_slug !== "string" || value.project_slug.length === 0)
  ) {
    return {
      ok: false,
      issues: [{
        code: "promotion.journal_invalid",
        message: "promotion journal project_slug must be a non-empty string when set",
        path: journalPath
      }]
    };
  }
  if (value.transaction_id !== undefined) {
    if (
      typeof value.transaction_id !== "string"
      || value.transaction_id.length === 0
      || !PROMOTION_IDENTITY_TOKEN.test(value.transaction_id)
    ) {
      return {
        ok: false,
        issues: [{
          code: "promotion.journal_invalid",
          message: "promotion journal transaction_id must be a safe non-empty identity token when set",
          path: journalPath
        }]
      };
    }
  }

  const backupPath = value.backup_path === undefined || value.backup_path === null
    ? null
    : value.backup_path;
  // Legacy journals written before staging_path existed omit the field; treat as null.
  const stagingPath = value.staging_path === undefined || value.staging_path === null
    ? null
    : value.staging_path;
  if (value.created_fresh === true && backupPath !== null) {
    return {
      ok: false,
      issues: [{
        code: "promotion.journal_invalid",
        message: "promotion journal created_fresh cannot pair with a backup_path",
        path: journalPath
      }]
    };
  }
  if (value.created_fresh === false && backupPath === null) {
    return {
      ok: false,
      issues: [{
        code: "promotion.journal_invalid",
        message: "promotion journal with created_fresh=false requires backup_path",
        path: journalPath
      }]
    };
  }
  if (value.phase === "switching" && stagingPath === null) {
    return {
      ok: false,
      issues: [{
        code: "promotion.journal_invalid",
        message: "promotion journal phase=switching requires staging_path",
        path: journalPath
      }]
    };
  }

  return {
    ok: true,
    journal: {
      schema_version: 1,
      projects_home: value.projects_home,
      destination_root: value.destination_root,
      backup_path: backupPath,
      staging_path: stagingPath,
      created_fresh: value.created_fresh,
      phase: value.phase as PromotionJournalPhase,
      ...(typeof value.project_slug === "string" ? { project_slug: value.project_slug } : {}),
      ...(typeof value.transaction_id === "string" ? { transaction_id: value.transaction_id } : {}),
      created_at: value.created_at,
      updated_at: value.updated_at
    }
  };
}
