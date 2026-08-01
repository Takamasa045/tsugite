import {
  lstat,
  readdir,
  rename,
  rm
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Issue } from "../types.js";
import {
  acquireDestinationLock,
  DestinationLockedError,
  DestinationLockBoundaryError
} from "./destinationLock.js";
import {
  inspectContainedPath,
  inspectPromotionJournalPaths
} from "./promotionJournalPathSafety.js";
import {
  clearPromotionJournal,
  loadPromotionJournalAt
} from "./promotionJournalPersistence.js";
import {
  PromotionJournalError,
  errorMessage,
  isNodeError,
  promotionJournalDir,
  promotionJournalPath,
  type PromotionJournal,
  type RecoverPromotionTransactionsResult
} from "./promotionJournalShared.js";

/**
 * Resume incomplete durable promotions after a crash:
 * - switching → drop staging, restore prior destination (or remove a fresh partial)
 * - open / rolling_back → restore prior destination (or remove a fresh promotion)
 * - committing → drop leftover backup
 * - committed / rolled_back → clear journal only
 *
 * Broken or path-unsafe journals are reported and never used for rename/unlink.
 */
export type RecoverPromotionTransactionsTestHooks = {
  /**
   * Invoked after the initial journal discovery load for a pending entry and
   * before destination-lock acquisition. Test-only race injection point.
   */
  afterInitialLoadBeforeLock?: (entry: {
    journal: PromotionJournal;
    journalPath: string;
  }) => Promise<void>;
};

export async function recoverPromotionTransactions(
  projectsHome: string,
  options: {
    rm?: typeof rm;
    rename?: typeof rename;
    /** @internal test-only hooks. Never wired from CLI. */
    _testHooks?: RecoverPromotionTransactionsTestHooks;
  } = {}
): Promise<RecoverPromotionTransactionsResult> {
  const rmFn = options.rm ?? rm;
  const renameFn = options.rename ?? rename;
  const home = resolve(projectsHome);
  const dir = promotionJournalDir(home);
  const issues: Issue[] = [];
  let recovered = 0;
  let cleared = 0;

  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: true, issues: [], recovered: 0, cleared: 0 };
    }
    return {
      ok: false,
      issues: [{
        code: "promotion.journal_invalid",
        message: errorMessage(error, "promotion journal directory could not be read"),
        path: dir
      }],
      recovered: 0,
      cleared: 0
    };
  }

  // Refuse to act if the journal directory itself is a symlink escape.
  const dirIssue = await inspectContainedPath({
    root: home,
    targetPath: dir,
    requireDirectory: true,
    allowMissing: false,
    allowLeafSymlink: false,
    label: "journal_dir"
  });
  if (dirIssue) {
    return { ok: false, issues: [dirIssue], recovered: 0, cleared: 0 };
  }

  // Load first, then process in deterministic destination_root order so multi-destination
  // recovery never deadlocks against concurrent finalize (run lock → dest lock order).
  // Initial load is discovery-only (sort / lock targets); destructive work uses a
  // post-lock re-read of the same journal path.
  type LoadedOk = { journal: PromotionJournal; journalPath: string };
  const pending: LoadedOk[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const journalPath = join(dir, name);
    const loaded = await loadPromotionJournalAt(journalPath, home);
    if (loaded.status === "missing") continue;
    if (loaded.status === "invalid") {
      issues.push(...loaded.issues);
      continue;
    }
    pending.push({ journal: loaded.journal, journalPath: loaded.journalPath });
  }
  pending.sort((left, right) =>
    resolve(left.journal.destination_root).localeCompare(resolve(right.journal.destination_root))
  );

  for (const entry of pending) {
    const { journal: discovered, journalPath } = entry;
    if (options._testHooks?.afterInitialLoadBeforeLock) {
      await options._testHooks.afterInitialLoadBeforeLock({
        journal: discovered,
        journalPath
      });
    }

    let destLock;
    try {
      // Exclusive destination lock: concurrent finalize/promote waits or fails closed.
      // Lock target comes from discovery only; mutations use the post-lock re-read.
      destLock = await acquireDestinationLock(home, discovered.destination_root, { wait: true });
    } catch (error) {
      if (error instanceof DestinationLockedError || error instanceof DestinationLockBoundaryError) {
        issues.push({
          code: error.code,
          message: error.message,
          path: discovered.destination_root
        });
        continue;
      }
      issues.push({
        code: "promotion.recovery_failed",
        message: errorMessage(error, "promotion destination lock could not be acquired"),
        path: discovered.destination_root
      });
      continue;
    }

    try {
      // Always re-read after lock: concurrent promote may have advanced phase
      // (e.g. open → committing) while we waited. Never mutate from the stale snapshot.
      const current = await loadCurrentJournalAfterLock({
        home,
        journalPath,
        lockedDestinationRoot: discovered.destination_root,
        discovered
      });
      if (current.status === "fail") {
        issues.push(...current.issues);
        continue;
      }
      const journal = current.journal;

      if (journal.phase === "committed" || journal.phase === "rolled_back") {
        await clearPromotionJournal(home, journal.destination_root);
        cleared += 1;
        continue;
      }

      if (journal.phase === "committing") {
        // Switch already applied: finish commit (drop backup) and keep NEW.
        await finishCommitFromJournal(journal, home, rmFn);
        await clearPromotionJournal(home, journal.destination_root);
        recovered += 1;
        continue;
      }

      // open | switching | rolling_back → restore prior destination / drop fresh promotion
      await finishRollbackFromJournal(journal, home, rmFn, renameFn);
      await clearPromotionJournal(home, journal.destination_root);
      recovered += 1;
    } catch (error) {
      issues.push({
        code: "promotion.recovery_failed",
        message: errorMessage(error, "promotion transaction recovery failed"),
        path: discovered.destination_root
      });
    } finally {
      await destLock.release().catch(() => undefined);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    recovered,
    cleared
  };
}

/**
 * Re-load and re-validate the journal at the same path after the destination lock
 * is held. Fail closed on missing, invalid, foreign destination, or identity swap.
 *
 * loadPromotionJournalAt already enforces schema, path safety, and identity binding;
 * this layer additionally pins the post-lock snapshot to the destination/transaction
 * discovered before the wait.
 */
async function loadCurrentJournalAfterLock(input: {
  home: string;
  journalPath: string;
  lockedDestinationRoot: string;
  discovered: PromotionJournal;
}): Promise<
  | { status: "ok"; journal: PromotionJournal }
  | { status: "fail"; issues: Issue[] }
> {
  const { home, journalPath, lockedDestinationRoot, discovered } = input;
  const reloaded = await loadPromotionJournalAt(journalPath, home);

  if (reloaded.status === "missing") {
    return {
      status: "fail",
      issues: [{
        code: "promotion.journal_invalid",
        message: "promotion journal disappeared after destination lock was acquired",
        path: journalPath
      }]
    };
  }
  if (reloaded.status === "invalid") {
    // Covers schema/path/identity failures after a mid-wait replace (foreign, unsafe).
    return { status: "fail", issues: reloaded.issues };
  }

  const journal = reloaded.journal;

  // Pin to the locked destination even if a same-file rewrite somehow revalidated.
  if (resolve(journal.destination_root) !== resolve(lockedDestinationRoot)) {
    return {
      status: "fail",
      issues: [{
        code: "promotion.journal_identity_mismatch",
        message: "promotion journal destination_root changed after destination lock was acquired",
        path: journalPath
      }]
    };
  }

  // transaction_id binds backup/staging basenames; a mid-wait swap is fail-closed.
  if (discovered.transaction_id !== journal.transaction_id) {
    return {
      status: "fail",
      issues: [{
        code: "promotion.journal_identity_mismatch",
        message: "promotion journal transaction_id changed after destination lock was acquired",
        path: journalPath
      }]
    };
  }

  return { status: "ok", journal };
}

export async function finishCommitFromJournal(
  journal: PromotionJournal,
  projectsHome: string,
  rmFn: typeof rm = rm
): Promise<void> {
  const safety = await inspectPromotionJournalPaths(
    journal,
    projectsHome,
    promotionJournalPath(projectsHome, journal.destination_root)
  );
  if (safety) throw new PromotionJournalError(safety);

  if (journal.backup_path) {
    // Backup may already be gone after a partial commit; force-rm is idempotent.
    // Shelf-symlink backups are unlinked as the link node only (rm does not follow).
    await assertSafeMutableTree(projectsHome, journal.backup_path, "backup_path", true, true);
    await rmFn(journal.backup_path, { recursive: true, force: true });
  }
}

export async function finishRollbackFromJournal(
  journal: PromotionJournal,
  projectsHome: string,
  rmFn: typeof rm = rm,
  renameFn: typeof rename = rename
): Promise<void> {
  const safety = await inspectPromotionJournalPaths(
    journal,
    projectsHome,
    promotionJournalPath(projectsHome, journal.destination_root)
  );
  if (safety) throw new PromotionJournalError(safety);

  const home = resolve(projectsHome);
  const destinationRoot = resolve(journal.destination_root);

  // Always drop leftover staging first so a partial switch cannot leave orphan trees.
  if (journal.staging_path) {
    const stagingPath = resolve(journal.staging_path);
    await assertSafeMutableTree(home, stagingPath, "staging_path", true, false);
    await rmFn(stagingPath, { recursive: true, force: true });
  }

  if (journal.backup_path) {
    const backupPath = resolve(journal.backup_path);
    const backupPresent = await pathIsDirOrSymlink(backupPath);
    const destinationPresent = await pathIsDirOrSymlink(destinationRoot);

    if (backupPresent) {
      // Prior tree/link still in backup: drop any partial new destination, then restore.
      // Covers switching crashes after first rename, between renames, and right after switch.
      await assertSafeMutableTree(home, destinationRoot, "destination_root", true, false);
      await rmFn(destinationRoot, { recursive: true, force: true });
      await assertSafeMutableTree(home, backupPath, "backup_path", false, true);
      const parentIssue = await inspectContainedPath({
        root: home,
        targetPath: dirname(destinationRoot),
        requireDirectory: true,
        allowMissing: false,
        allowLeafSymlink: false,
        label: "destination_parent"
      });
      if (parentIssue) throw new PromotionJournalError(parentIssue);
      await renameFn(backupPath, destinationRoot);
      return;
    }

    // Backup already consumed (rename succeeded) or crash before first rename:
    // destination still holds the prior tree (or a completed restore). Leave it.
    if (destinationPresent) {
      // Restored shelf links are allowed; new promotions are real directories.
      await assertSafeMutableTree(home, destinationRoot, "destination_root", false, true);
      return;
    }
    throw new PromotionJournalError({
      code: "promotion.recovery_failed",
      message: "promotion rollback cannot restore: backup and destination are both missing",
      path: destinationRoot
    });
  }

  // createdFresh: only the new destination must be removed (if the switch placed it).
  await assertSafeMutableTree(home, destinationRoot, "destination_root", true, false);
  await rmFn(destinationRoot, { recursive: true, force: true });
}

async function pathIsDirOrSymlink(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isSymbolicLink() || stats.isDirectory();
  } catch {
    return false;
  }
}

async function assertSafeMutableTree(
  projectsHome: string,
  targetPath: string,
  label: string,
  allowMissing = false,
  allowLeafSymlink = false
): Promise<void> {
  const issue = await inspectContainedPath({
    root: resolve(projectsHome),
    targetPath: resolve(targetPath),
    requireDirectory: true,
    allowMissing,
    allowLeafSymlink,
    label
  });
  if (issue) throw new PromotionJournalError(issue);
}
