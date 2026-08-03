/**
 * Empty-candidate apply phases for finalize.
 * Handles idempotent already-home success and promotion/record when nothing remains to delete.
 */
import type { EnsureLauncherHomeResult, LauncherHomePlan } from "../project/projectsHome.js";
import type { Issue } from "../types.js";
import {
  assertWritableProjectRecordPath,
  resolveCompletionRecordPaths,
  writeCompletionRecords,
  type CompletionRecordProjectContext
} from "./finalizeCompletionRecord.js";
import { clearFinalizeJournal } from "./finalizeJournal.js";
import { isRegularFile } from "./finalizePathSafety.js";
import {
  commitPromotionTransaction,
  promoteIfNeeded,
  rollbackPromotionTransaction
} from "./finalizePromotion.js";
import type { PriorCleanupProgress } from "./finalizeRecovery.js";
import { errorMessage } from "./finalizeShared.js";

/** Minimal result surface shared with finalizeCompletedProject. */
export type EmptyApplyResultBase = {
  ok: boolean;
  issues: Issue[];
  applied: boolean;
  recordPath?: string;
  deletedFiles: number;
  deletedBytes: number;
  promotedToLauncherHome?: boolean;
  launcherProjectRoot?: string;
  launcherConfigPath?: string;
};

export type EmptyApplySharedContext = {
  projectRoot: string;
  stateDir: string;
  runId: string;
  runDir: string;
  recordPath: string;
  canonicalOutputPath: string;
  referencedSourceMedia: readonly string[];
  planDigest: string;
  priorCleanup: PriorCleanupProgress;
  stateUpdatedAt: string;
  launcherPlan: LauncherHomePlan;
  project: CompletionRecordProjectContext;
  base: EmptyApplyResultBase;
  configPath: string;
  projectSlug: string;
  now?: string;
  promotionHooks?: Parameters<typeof promoteIfNeeded>[0]["promotionHooks"];
  revalidatePinnedDirs: () => Promise<Issue | undefined>;
};

/**
 * Idempotent success when already home, a completion record exists, and no candidates remain.
 * Merges prior partial cleanup into the record once when measured progress exists.
 */
export async function applyIdempotentEmptyAlreadyHome(
  ctx: EmptyApplySharedContext
): Promise<EmptyApplyResultBase | undefined> {
  const {
    projectRoot,
    stateDir,
    runId,
    runDir,
    recordPath,
    canonicalOutputPath,
    referencedSourceMedia,
    planDigest,
    priorCleanup,
    stateUpdatedAt,
    launcherPlan,
    project,
    base
  } = ctx;

  if (!(await isRegularFile(recordPath)) || !launcherPlan.alreadyHome) {
    return undefined;
  }

  // Idempotent success: never rewrite an existing completion record as zero cleanup.
  // If prior partial progress exists with no remaining candidates, merge into record once.
  if (priorCleanup.deletedFiles > 0) {
    const recordPaths = resolveCompletionRecordPaths(
      projectRoot,
      recordPath,
      launcherPlan.destinationRoot
    );
    const recordPathIssue = await assertWritableProjectRecordPath(
      projectRoot,
      recordPaths.source,
      recordPaths.durable
    );
    if (recordPathIssue) {
      return {
        ...base,
        ok: false,
        deletedFiles: 0,
        deletedBytes: 0,
        issues: [recordPathIssue]
      };
    }
    await writeCompletionRecords({
      sourceRecordPath: recordPaths.source,
      durableRecordPath: recordPaths.durable,
      project,
      runId,
      stateUpdatedAt,
      canonicalOutputPath,
      runDir,
      projectRoot,
      referencedSourceMedia,
      deletedFiles: priorCleanup.deletedFiles,
      deletedBytes: priorCleanup.deletedBytes,
      deletedMediaPaths: priorCleanup.deletedPaths,
      planDigest,
      launcherPlan,
      promoted: false,
      partial: false
    });
    await clearFinalizeJournal(stateDir, runId);
    return {
      ...base,
      recordPath: recordPaths.reported,
      deletedFiles: priorCleanup.deletedFiles,
      deletedBytes: priorCleanup.deletedBytes
    };
  }
  await clearFinalizeJournal(stateDir, runId);
  return base;
}
/**
 * Empty-candidate path after pre-mutation checks: promote (if needed), write record, commit.
 */
export async function applyEmptyCandidatesPromotionAndRecord(
  ctx: EmptyApplySharedContext
): Promise<EmptyApplyResultBase> {
  const {
    projectRoot,
    stateDir,
    runId,
    runDir,
    recordPath,
    canonicalOutputPath,
    referencedSourceMedia,
    planDigest,
    priorCleanup,
    stateUpdatedAt,
    launcherPlan,
    project,
    base,
    configPath,
    projectSlug,
    now,
    promotionHooks,
    revalidatePinnedDirs
  } = ctx;

  const emptyBoundary = await revalidatePinnedDirs();
  if (emptyBoundary) {
    return {
      ...base,
      ok: false,
      deletedFiles: 0,
      deletedBytes: 0,
      issues: [emptyBoundary]
    };
  }

  const launcherHome = await promoteIfNeeded(
    { configPath, projectSlug, now, promotionHooks },
    launcherPlan.alreadyHome
  );
  if (!launcherHome.ok) {
    return failureWithPromotion(base, priorCleanup, launcherHome, launcherHome.issues);
  }

  const emptyPromotionTx = launcherHome.promotionTransaction;
  try {
    const recordPaths = resolveCompletionRecordPaths(
      projectRoot,
      recordPath,
      launcherHome.destinationRoot
    );
    const recordPathIssue = await assertWritableProjectRecordPath(
      projectRoot,
      recordPaths.source,
      recordPaths.durable
    );
    if (recordPathIssue) {
      const promotionIssues = await rollbackPromotionTransaction(emptyPromotionTx);
      return {
        ...base,
        ok: false,
        deletedFiles: priorCleanup.deletedFiles,
        deletedBytes: priorCleanup.deletedBytes,
        issues: [recordPathIssue, ...promotionIssues],
        promotedToLauncherHome: false,
        launcherProjectRoot: launcherHome.destinationRoot,
        launcherConfigPath: launcherHome.destinationConfigPath
      };
    }

    const totalDeletedFiles = priorCleanup.deletedFiles;
    const totalDeletedBytes = priorCleanup.deletedBytes;
    const totalDeletedPaths = [...priorCleanup.deletedPaths];
    if (!(await isRegularFile(recordPaths.durable)) || totalDeletedFiles > 0) {
      await writeCompletionRecords({
        sourceRecordPath: recordPaths.source,
        durableRecordPath: recordPaths.durable,
        project,
        runId,
        stateUpdatedAt,
        canonicalOutputPath,
        runDir,
        projectRoot,
        referencedSourceMedia,
        deletedFiles: totalDeletedFiles,
        deletedBytes: totalDeletedBytes,
        deletedMediaPaths: totalDeletedPaths,
        planDigest,
        launcherPlan: {
          ...launcherPlan,
          destinationRoot: launcherHome.destinationRoot,
          alreadyHome: launcherHome.alreadyHome
        },
        promoted: launcherHome.promoted
      });
    }

    const promotionCommitIssues = await commitPromotionTransaction(emptyPromotionTx);
    if (promotionCommitIssues.length > 0) {
      // Record and prior deletion progress stay; promotion journal remains for recovery.
      return {
        ...base,
        ok: false,
        recordPath: recordPaths.reported,
        deletedFiles: totalDeletedFiles,
        deletedBytes: totalDeletedBytes,
        issues: promotionCommitIssues,
        promotedToLauncherHome: launcherHome.promoted,
        launcherProjectRoot: launcherHome.destinationRoot,
        launcherConfigPath: launcherHome.destinationConfigPath
      };
    }

    await clearFinalizeJournal(stateDir, runId);
    return {
      ...base,
      recordPath: recordPaths.reported,
      deletedFiles: totalDeletedFiles,
      deletedBytes: totalDeletedBytes,
      promotedToLauncherHome: launcherHome.promoted,
      launcherProjectRoot: launcherHome.destinationRoot,
      launcherConfigPath: launcherHome.destinationConfigPath
    };
  } catch (error) {
    const promotionIssues = await rollbackPromotionTransaction(emptyPromotionTx);
    return {
      ...base,
      ok: false,
      deletedFiles: priorCleanup.deletedFiles,
      deletedBytes: priorCleanup.deletedBytes,
      issues: [{
        code: "finalize.record_write_failed",
        message: errorMessage(error)
      }, ...promotionIssues],
      promotedToLauncherHome: false,
      launcherProjectRoot: launcherHome.destinationRoot,
      launcherConfigPath: launcherHome.destinationConfigPath
    };
  }
}

function failureWithPromotion(
  base: EmptyApplyResultBase,
  priorCleanup: PriorCleanupProgress,
  launcherHome: EnsureLauncherHomeResult,
  issues: Issue[]
): EmptyApplyResultBase {
  return {
    ...base,
    ok: false,
    deletedFiles: priorCleanup.deletedFiles,
    deletedBytes: priorCleanup.deletedBytes,
    issues,
    promotedToLauncherHome: false,
    launcherProjectRoot: launcherHome.destinationRoot,
    launcherConfigPath: launcherHome.destinationConfigPath
  };
}
