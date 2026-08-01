/**
 * Promotion switch / open transaction / commit / rollback.
 * Lock and journal order is intentional: never relax lstat/realpath/containment/lock/journal sequencing.
 */

import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdtemp,
  rename,
  rm
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  acquireDestinationLock,
  DestinationLockedError,
  DestinationLockBoundaryError,
  type DestinationLock
} from "./destinationLock.js";
import {
  clearPromotionJournal,
  loadPromotionJournal,
  PROMOTION_BACKUP_PREFIX,
  PROMOTION_JOURNAL_DIR_NAME,
  PROMOTION_STAGING_PREFIX,
  promotionBackupBaseName,
  promotionDestinationSlug,
  promotionStagingBasePrefix,
  recoverPromotionTransactions,
  writePromotionJournal,
  type PromotionJournal
} from "./promotionJournal.js";
import {
  assertSafePromotion,
  writePromotionMarker
} from "./projectsHomePromotionSafety.js";
import { planLauncherHome } from "./projectsHomeResolve.js";
import {
  isNodeError,
  LAUNCHER_HOME_MARKER_NAME,
  pathIsDirOrSymlink,
  type EnsureLauncherHomeOptions,
  type EnsureLauncherHomeResult,
  type PromotionTransaction,
  type PromotionTransactionTestHooks
} from "./projectsHomeShared.js";

type DirectorySwitchResult = {
  backupPath?: string;
  createdFresh: boolean;
  journal: PromotionJournal;
};

/**
 * After finalize, ensure the completed project is present under the durable
 * launcher projects home so feature-worktree cleanup cannot hide it.
 */
export async function ensureFinalizedProjectInLauncherHome(
  options: EnsureLauncherHomeOptions
): Promise<EnsureLauncherHomeResult> {
  const plan = await planLauncherHome(options.configPath, options.projectSlug, {
    cwd: options.cwd,
    env: options.env
  });
  const base: EnsureLauncherHomeResult = {
    ok: true,
    issues: [],
    projectsHome: plan.projectsHome,
    projectRoot: plan.projectRoot,
    destinationRoot: plan.destinationRoot,
    alreadyHome: plan.alreadyHome,
    promoted: false,
    destinationConfigPath: options.configPath
  };

  // Resume incomplete promotions for this durable home before planning a new switch.
  const recovery = await recoverPromotionTransactions(plan.projectsHome, {
    rm: options._testHooks?.rm,
    rename: options._testHooks?.rename
  });
  if (!recovery.ok) {
    return {
      ...base,
      ok: false,
      issues: recovery.issues,
      destinationConfigPath: options.apply
        ? join(plan.destinationRoot, basename(resolve(options.configPath)))
        : options.configPath
    };
  }

  if (plan.alreadyHome) {
    return {
      ...base,
      destinationConfigPath: resolve(options.configPath)
    };
  }

  if (!options.apply) {
    return {
      ...base,
      destinationConfigPath: join(plan.destinationRoot, basename(resolve(options.configPath)))
    };
  }

  // Destination lock order: after any project-local run lock (CLI), before mutating the
  // shared durable destination. acquireDestinationLock is the first shared destination
  // mutation boundary (safe mkdir of home/journal under real parents only). Never
  // recursive-mkdir projectsHome before the lock — an ancestor symlink to an external
  // directory would otherwise write outside the durable boundary.
  // Held through switch and until promotionTransaction commit/rollback fully settles
  // (including exception paths). A live holder blocks concurrent recovery/promote
  // fail-closed; a crashed holder is reclaimed via stale lock recovery (dead pid).
  let destinationLock: DestinationLock | undefined;
  try {
    destinationLock = await acquireDestinationLock(plan.projectsHome, plan.destinationRoot);
    // Re-check destination containment / slug conflict under the held lock.
    await assertSafePromotion(plan.projectRoot, plan.destinationRoot, plan.projectsHome, options.projectSlug);
    // Replace the destination from a staging tree. Write-ahead journal (phase=switching)
    // is persisted before the first rename so crash recovery never loses the prior tree.
    // Keep the prior destination backup until completion-record is confirmed.
    const now = options.now ?? new Date().toISOString();
    const switchResult = await replaceDirectoryWithCopy({
      sourceRoot: plan.projectRoot,
      destinationRoot: plan.destinationRoot,
      projectsHome: plan.projectsHome,
      projectSlug: options.projectSlug,
      now,
      hooks: options._testHooks
    });
    const destinationConfigPath = join(
      plan.destinationRoot,
      basename(resolve(options.configPath))
    );
    const journal = switchResult.journal;
    try {
      await writePromotionMarker(plan.destinationRoot, {
        sourceProjectRoot: plan.projectRoot,
        projectsHome: plan.projectsHome,
        projectSlug: options.projectSlug,
        promotedAt: now
      });
    } catch (markerError) {
      // Marker failure: roll back the open promotion before returning the error.
      // Keep the switch lock held through same-process rollback (no re-acquire race).
      const tx = createPromotionTransaction(
        plan.projectsHome,
        plan.destinationRoot,
        switchResult,
        journal,
        options._testHooks,
        { heldLock: destinationLock }
      );
      destinationLock = undefined;
      await tx.rollback().catch(() => undefined);
      throw markerError;
    }
    // Transfer the destination lock into the open transaction. Ownership moves to
    // commit/rollback (exactly-once release); the outer finally must not release again.
    const promotionTransaction = createPromotionTransaction(
      plan.projectsHome,
      plan.destinationRoot,
      switchResult,
      journal,
      options._testHooks,
      { heldLock: destinationLock }
    );
    destinationLock = undefined;
    return {
      ...base,
      promoted: true,
      destinationConfigPath,
      promotionTransaction
    };
  } catch (error) {
    const code = error instanceof DestinationLockedError
      ? error.code
      : error instanceof DestinationLockBoundaryError
        ? error.code
        : "finalize.launcher_home_promote_failed";
    return {
      ...base,
      ok: false,
      issues: [{
        code,
        message: error instanceof Error ? error.message : String(error),
        path: plan.destinationRoot
      }]
    };
  } finally {
    if (destinationLock) {
      await destinationLock.release().catch(() => undefined);
    }
  }
}

/**
 * Build a staging tree, write a switching journal, then rename into place.
 *
 * Order (must match comments and crash-recovery expectations):
 * 1. Copy source into a staging directory under projects home
 * 2. Persist phase=switching with destination, backup, and staging paths
 * 3. Rename old destination → backup (if present)
 * 4. Rename staged project → destination
 * 5. Drop the (now empty) staging directory
 * 6. Persist phase=open with staging_path cleared
 *
 * A crash at (3)/(4)/(5) is recovered from the switching journal without data loss.
 */
async function replaceDirectoryWithCopy(input: {
  sourceRoot: string;
  destinationRoot: string;
  projectsHome: string;
  projectSlug: string;
  now: string;
  hooks?: PromotionTransactionTestHooks;
}): Promise<DirectorySwitchResult> {
  const projectsHome = resolve(input.projectsHome);
  const destinationRoot = resolve(input.destinationRoot);
  const destSlug = promotionDestinationSlug(destinationRoot);
  // One nonce per switch: binds journal + backup + staging so recovery cannot
  // act on another job's trees even when only the promote-backup prefix matches.
  const transactionId = randomUUID();
  // projectsHome (and journal dir) were already created safely by acquireDestinationLock.
  // Do not recursive-mkdir here — callers must hold the destination lock first.
  // Staging must be a direct child of projects home with the promote prefix (journal path safety).
  const staging = await mkdtemp(
    join(projectsHome, promotionStagingBasePrefix(destSlug, transactionId))
  );
  const stagedProject = join(staging, "project");
  const renameFn = input.hooks?.rename ?? rename;
  // Hidden backup name so launchers do not treat it as a project directory.
  const backup = join(
    projectsHome,
    promotionBackupBaseName(destSlug, transactionId)
  );

  let hadDestination = false;
  try {
    await lstat(destinationRoot);
    hadDestination = true;
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }

  try {
    await cp(input.sourceRoot, stagedProject, {
      recursive: true,
      filter: (source) => {
        const name = basename(source);
        // Keep durable promotion free of local finalize quarantine/journal staging
        // and of promotion transaction journals (never copy across project roots).
        // Never copy launcher-home.json: source may be a symlink to an external target;
        // the marker is written separately as a regular file after the switch.
        return name !== "node_modules"
          && name !== ".git"
          && name !== ".tsugite-finalize-quarantine"
          && name !== ".tsugite-finalize-journal"
          && name !== PROMOTION_JOURNAL_DIR_NAME
          && name !== LAUNCHER_HOME_MARKER_NAME
          && !name.startsWith(PROMOTION_BACKUP_PREFIX)
          && !name.startsWith(PROMOTION_STAGING_PREFIX);
      }
    });

    // 2. Write-ahead journal BEFORE the first rename so recovery can always restore.
    let journal = await writePromotionJournal({
      projectsHome,
      journal: {
        schema_version: 1,
        projects_home: projectsHome,
        destination_root: destinationRoot,
        backup_path: hadDestination ? resolve(backup) : null,
        staging_path: resolve(staging),
        created_fresh: !hadDestination,
        phase: "switching",
        project_slug: input.projectSlug,
        transaction_id: transactionId,
        created_at: input.now,
        updated_at: input.now
      }
    });
    if (input.hooks?.afterSwitchingJournal) {
      await input.hooks.afterSwitchingJournal();
    }

    // 3. Move prior destination aside (if any).
    if (hadDestination) {
      await renameFn(destinationRoot, backup);
    }

    // 4. Install the staged project at the destination.
    try {
      await renameFn(stagedProject, destinationRoot);
    } catch (error) {
      if (hadDestination) {
        try {
          await renameFn(backup, destinationRoot);
        } catch {
          // best effort same-process restore; journal remains for crash recovery
        }
      }
      throw error;
    }

    // 5. Drop empty staging before settling open so a post-switch crash leaves no orphan dir.
    await rm(staging, { recursive: true, force: true });

    // 6. Switch complete: settle journal at open and clear staging_path.
    journal = await writePromotionJournal({
      projectsHome,
      journal: {
        ...journal,
        phase: "open",
        staging_path: null,
        updated_at: new Date().toISOString()
      }
    });

    return hadDestination
      ? { backupPath: backup, createdFresh: false, journal }
      : { createdFresh: true, journal };
  } finally {
    // Failure paths: force-remove leftover staging (idempotent if already cleaned).
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Bind commit/rollback to a durable promotion journal.
 * settled is set only after every filesystem step and journal cleanup succeed;
 * failures propagate so callers can retry or surface issues. Crash recovery uses
 * the journal phase (switching/open/rolling_back → restore; committing → drop backup).
 *
 * Destination lock lifetime: held from switch (via heldLock) until commit/rollback
 * finishes — including exception paths — and released exactly once. Concurrent
 * recovery/promote against the same destination fails closed while the lock is live.
 */
function createPromotionTransaction(
  projectsHome: string,
  destinationRoot: string,
  switchResult: DirectorySwitchResult,
  initialJournal: PromotionJournal,
  hooks?: PromotionTransactionTestHooks,
  lockOptions: { heldLock?: DestinationLock } = {}
): PromotionTransaction {
  let settled = false;
  let journal = initialJournal;
  /** Lock transferred from the switch (or re-acquired on commit/rollback retry). */
  let preheldLock = lockOptions.heldLock;
  /** Ensures release runs at most once across commit/rollback success and failure. */
  let lockReleased = false;
  const rmFn = hooks?.rm ?? rm;
  const renameFn = hooks?.rename ?? rename;

  async function persistPhase(phase: PromotionJournal["phase"]): Promise<void> {
    await assertOwnsOnDiskJournal({ allowMissing: false });
    const now = new Date().toISOString();
    journal = await writePromotionJournal({
      projectsHome,
      journal: {
        ...journal,
        phase,
        // Commit/rollback settle after switch; staging is already gone.
        staging_path: null,
        updated_at: now
      }
    });
  }

  async function clearOwnedJournal(): Promise<void> {
    const loaded = await loadPromotionJournal(projectsHome, destinationRoot);
    if (loaded.status === "missing") return;
    if (loaded.status === "invalid") {
      throw new Error(
        `promotion journal invalid while clearing owned transaction (${destinationRoot})`
      );
    }
    if (!samePromotionTransactionIdentity(journal, loaded.journal)) {
      throw new Error(
        `refusing to clear foreign promotion journal (ownership/identity mismatch at ${destinationRoot})`
      );
    }
    await clearPromotionJournal(projectsHome, destinationRoot);
  }

  async function assertOwnsOnDiskJournal(options: { allowMissing: boolean }): Promise<void> {
    const loaded = await loadPromotionJournal(projectsHome, destinationRoot);
    if (loaded.status === "missing") {
      if (options.allowMissing) return;
      throw new Error(
        `promotion journal missing; cannot continue this transaction (${destinationRoot})`
      );
    }
    if (loaded.status === "invalid") {
      throw new Error(
        `promotion journal invalid; cannot continue this transaction (${destinationRoot})`
      );
    }
    if (!samePromotionTransactionIdentity(journal, loaded.journal)) {
      throw new Error(
        `refusing to mutate foreign promotion journal (ownership/identity mismatch at ${destinationRoot})`
      );
    }
  }

  async function releaseDestinationLockOnce(lock: DestinationLock | undefined): Promise<void> {
    if (!lock || lockReleased) return;
    lockReleased = true;
    await lock.release().catch(() => undefined);
  }

  async function withDestinationLock<T>(body: () => Promise<T>): Promise<T> {
    let lock = preheldLock;
    preheldLock = undefined;
    if (!lock) {
      if (lockReleased) {
        // Prior attempt already released; re-acquire for retry after a failed settle.
        lockReleased = false;
      }
      lock = await acquireDestinationLock(projectsHome, destinationRoot);
    }
    try {
      return await body();
    } finally {
      // Exactly-once release for this settle attempt (success or exception).
      await releaseDestinationLockOnce(lock);
    }
  }

  return {
    destinationRoot,
    backupPath: switchResult.backupPath,
    createdFresh: switchResult.createdFresh,
    async commit() {
      if (settled) return;
      await withDestinationLock(async () => {
        // Intent first so crash recovery finishes the commit instead of rolling back.
        await persistPhase("committing");
        if (hooks?.afterCommitPhase) await hooks.afterCommitPhase();
        if (switchResult.backupPath) {
          await rmFn(switchResult.backupPath, { recursive: true, force: true });
        }
        await clearOwnedJournal();
        settled = true;
      });
    },
    async rollback() {
      if (settled) return;
      await withDestinationLock(async () => {
        await persistPhase("rolling_back");
        if (hooks?.afterRollbackPhase) await hooks.afterRollbackPhase();

        if (switchResult.backupPath) {
          const backupPresent = await pathIsDirOrSymlink(switchResult.backupPath);
          const destinationPresent = await pathIsDirOrSymlink(destinationRoot);
          if (backupPresent) {
            // Errors must propagate (not swallowed) so settled stays false for retry.
            await rmFn(destinationRoot, { recursive: true, force: true });
            if (hooks?.afterRollbackRemoveDestination) await hooks.afterRollbackRemoveDestination();
            await renameFn(switchResult.backupPath, destinationRoot);
          } else if (!destinationPresent) {
            throw new Error(
              `promotion rollback cannot restore: backup and destination are both missing (${destinationRoot})`
            );
          }
          // backup gone + destination present ⇒ prior rename already restored the old tree
        } else {
          await rmFn(destinationRoot, { recursive: true, force: true });
        }

        await clearOwnedJournal();
        settled = true;
      });
    }
  };
}

/** Stable ownership identity for a promotion transaction (not phase/updated_at). */
function samePromotionTransactionIdentity(
  expected: PromotionJournal,
  actual: PromotionJournal
): boolean {
  const sameNullablePath = (left: string | null, right: string | null): boolean => {
    if (left == null && right == null) return true;
    if (left == null || right == null) return false;
    return resolve(left) === resolve(right);
  };
  return resolve(expected.projects_home) === resolve(actual.projects_home)
    && resolve(expected.destination_root) === resolve(actual.destination_root)
    && expected.created_at === actual.created_at
    && expected.created_fresh === actual.created_fresh
    && sameNullablePath(expected.backup_path, actual.backup_path)
    && (expected.project_slug ?? "") === (actual.project_slug ?? "")
    && (expected.transaction_id ?? "") === (actual.transaction_id ?? "");
}
