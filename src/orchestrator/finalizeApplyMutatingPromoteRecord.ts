/**
 * Mutating apply promotion + completion-record phase.
 * Promote only after quarantine; commit promotion only after durable record write.
 */
import type { EnsureLauncherHomeResult, PromotionTransaction } from "../project/projectsHome.js";
import type { Issue } from "../types.js";
import {
  assertWritableProjectRecordPath,
  resolveCompletionRecordPaths,
  restoreCompletionRecordFromJournal,
  writeCompletionRecords
} from "./finalizeCompletionRecord.js";
import {
  clearFinalizeJournal,
  type FinalizeJournal
} from "./finalizeJournal.js";
import {
  commitPromotionTransaction,
  promoteIfNeeded,
  rollbackPromotionTransaction
} from "./finalizePromotion.js";
import {
  persistJournalAfterRollback,
  removeQuarantineRoot,
  rollbackQuarantine,
  type QuarantinedCandidate
} from "./finalizeQuarantine.js";
import { errorMessage } from "./finalizeShared.js";
import { failAfterQuarantineRollback } from "./finalizeApplyMutatingFailure.js";
import {
  updatePhase,
  type MutatingApplyContext,
  type PhaseFailed,
  type PhaseOk,
  type RecordPaths
} from "./finalizeApplyMutatingShared.js";

export async function promoteAndWriteCompletionRecord(input: {
  ctx: MutatingApplyContext;
  journal: FinalizeJournal;
  quarantineRoot: string;
  quarantined: QuarantinedCandidate[];
  setJournal: (journal: FinalizeJournal) => void;
  setOpenPromotionTransaction: (tx: PromotionTransaction | undefined) => void;
}): Promise<
  | PhaseOk<{
    journal: FinalizeJournal;
    launcherHome: EnsureLauncherHomeResult;
    recordPaths: RecordPaths;
    promotionCommitIssues: Issue[];
  }>
  | PhaseFailed
> {
  const { ctx, quarantineRoot, quarantined, setJournal, setOpenPromotionTransaction } = input;
  let journal = input.journal;
  const {
    priorCleanup,
    projectRoot,
    runDir,
    stateDir,
    runId,
    recordPath,
    canonicalOutputPath,
    referencedSourceMedia,
    planDigest,
    stateUpdatedAt,
    launcherPlan,
    project,
    configPath,
    projectSlug,
    now,
    base,
    testHooks,
    revalidatePinnedDirs,
    revalidateLiveFinalizeConditions
  } = ctx;

  if (testHooks?.beforePromote) {
    await testHooks.beforePromote();
  }

  const prePromoteBoundary = await revalidatePinnedDirs();
  if (prePromoteBoundary) {
    return {
      kind: "failed",
      result: await failAfterQuarantineRollback({
        ctx,
        journal,
        quarantineRoot,
        quarantined,
        priorOnly: true,
        issues: [prePromoteBoundary]
      })
    };
  }

  // After quarantine / before promotion: re-check completion authority and retention.
  const prePromoteIssue = await revalidateLiveFinalizeConditions({
    quarantinedOriginalPaths: quarantined.map((entry) => entry.originalPath)
  });
  if (prePromoteIssue) {
    return {
      kind: "failed",
      result: await failAfterQuarantineRollback({
        ctx,
        journal,
        quarantineRoot,
        quarantined,
        priorOnly: true,
        issues: [prePromoteIssue]
      })
    };
  }

  // Promote only after quarantine so durable home never receives superseded media paths.
  // Keep durable destination backup until completion-record is confirmed (transactional).
  journal = await updatePhase(stateDir, journal, "promoting", testHooks);
  setJournal(journal);

  const launcherHome = await promoteIfNeeded(
    {
      configPath,
      projectSlug,
      now,
      promotionHooks: testHooks?.promotion
    },
    launcherPlan.alreadyHome
  );
  if (!launcherHome.ok) {
    const rollbackResult = await failAfterQuarantineRollback({
      ctx,
      journal,
      quarantineRoot,
      quarantined,
      priorOnly: true,
      issues: launcherHome.issues
    });
    return {
      kind: "failed",
      result: {
        ...rollbackResult,
        promotedToLauncherHome: false,
        launcherProjectRoot: launcherHome.destinationRoot,
        launcherConfigPath: launcherHome.destinationConfigPath
      }
    };
  }

  setOpenPromotionTransaction(launcherHome.promotionTransaction);
  journal = await updatePhase(stateDir, journal, "promoted", testHooks);
  setJournal(journal);

  if (testHooks?.afterPromote) {
    await testHooks.afterPromote();
  }

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
    const promotionIssues = await rollbackPromotionTransaction(launcherHome.promotionTransaction);
    setOpenPromotionTransaction(undefined);
    const rollbackResult = await failAfterQuarantineRollback({
      ctx,
      journal,
      quarantineRoot,
      quarantined,
      priorOnly: true,
      issues: [recordPathIssue, ...promotionIssues]
    });
    return {
      kind: "failed",
      result: {
        ...rollbackResult,
        promotedToLauncherHome: false,
        launcherProjectRoot: launcherHome.destinationRoot,
        launcherConfigPath: launcherHome.destinationConfigPath,
        recordPath: recordPaths.reported
      }
    };
  }

  // Before permanent delete: re-check state / final / retention once more.
  const preDeleteIssue = await revalidateLiveFinalizeConditions({
    quarantinedOriginalPaths: quarantined.map((entry) => entry.originalPath)
  });
  if (preDeleteIssue) {
    const promotionIssues = await rollbackPromotionTransaction(launcherHome.promotionTransaction);
    setOpenPromotionTransaction(undefined);
    const rollbackResult = await failAfterQuarantineRollback({
      ctx,
      journal,
      quarantineRoot,
      quarantined,
      priorOnly: true,
      issues: [preDeleteIssue, ...promotionIssues]
    });
    return {
      kind: "failed",
      result: {
        ...rollbackResult,
        promotedToLauncherHome: false,
        launcherProjectRoot: launcherHome.destinationRoot,
        launcherConfigPath: launcherHome.destinationConfigPath,
        recordPath: recordPaths.reported
      }
    };
  }

  if (testHooks?.beforeRecordWrite) {
    await testHooks.beforeRecordWrite(recordPaths.source);
  }

  // Commit the completion record before permanent delete. Measured counts are written
  // after permanent delete succeeds; on partial delete they are rewritten to actuals.
  // Always write the durable copy so worktree cleanup cannot drop the audit record.
  // Promotion stays transactional until this record write succeeds.
  const plannedDeletedFiles = priorCleanup.deletedFiles + quarantined.length;
  const plannedDeletedBytes = priorCleanup.deletedBytes + ctx.plannedBytes;
  const plannedDeletedPaths = [...priorCleanup.deletedPaths, ...ctx.mediaFiles];
  try {
    journal = await updatePhase(stateDir, journal, "recording", testHooks);
    setJournal(journal);
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
      deletedFiles: plannedDeletedFiles,
      deletedBytes: plannedDeletedBytes,
      deletedMediaPaths: plannedDeletedPaths,
      planDigest,
      launcherPlan: {
        ...launcherPlan,
        // destination is fixed after successful promote
        destinationRoot: launcherHome.destinationRoot,
        alreadyHome: launcherHome.alreadyHome
      },
      promoted: launcherHome.promoted
    });
    journal = await updatePhase(stateDir, journal, "recorded", testHooks);
    setJournal(journal);
  } catch (error) {
    const promotionIssues = await rollbackPromotionTransaction(launcherHome.promotionTransaction);
    setOpenPromotionTransaction(undefined);
    const rollback = await rollbackQuarantine(quarantined);
    await removeQuarantineRoot(quarantineRoot);
    // Never replace an existing completion record with a zeroed failure payload.
    // After promotion rollback the durable tree (and its audit) is already restored from
    // backup — restore source only so a source snapshot cannot overwrite durable history.
    const promotionWasOpen = launcherHome.promoted === true;
    const recordRestoreIssues = await restoreCompletionRecordFromJournal(
      projectRoot,
      runDir,
      journal,
      recordPaths,
      {
        durableContainWithin: launcherPlan.projectsHome,
        skipDurableRestore: promotionWasOpen
      }
    );
    if (rollback.issues.length === 0 && recordRestoreIssues.length === 0) {
      await clearFinalizeJournal(stateDir, runId);
    } else {
      await persistJournalAfterRollback(stateDir, journal, quarantined, rollback);
    }
    return {
      kind: "failed",
      result: {
        ...base,
        ok: false,
        deletedFiles: priorCleanup.deletedFiles,
        deletedBytes: priorCleanup.deletedBytes,
        unrestoredPaths: rollback.unrestoredPaths,
        issues: [{
          code: "finalize.record_write_failed",
          message: errorMessage(error),
          path: recordPaths.durable
        }, ...promotionIssues, ...rollback.issues, ...recordRestoreIssues],
        promotedToLauncherHome: false,
        launcherProjectRoot: launcherHome.destinationRoot,
        launcherConfigPath: launcherHome.destinationConfigPath,
        recordPath: recordPaths.reported
      }
    };
  }

  // Commit only after the completion-record is durable. Failure keeps the promotion
  // journal for restart recovery; never roll back the destination or wipe the record.
  const promotionCommitIssues = await commitPromotionTransaction(launcherHome.promotionTransaction);
  setOpenPromotionTransaction(undefined);

  return {
    kind: "ok",
    journal,
    launcherHome,
    recordPaths,
    promotionCommitIssues
  };
}
