/**
 * Rollback and failure recovery for the mutating finalize apply path.
 * Used by quarantine / promote / permanent-delete phases; no phase orchestration.
 */
import type { EnsureLauncherHomeResult, PromotionTransaction } from "../project/projectsHome.js";
import type { Issue } from "../types.js";
import {
  correctCompletionRecordMeasured,
  restoreCompletionRecordFromJournal
} from "./finalizeCompletionRecord.js";
import {
  clearFinalizeJournal,
  readFinalizeJournal,
  type FinalizeJournal
} from "./finalizeJournal.js";
import {
  persistJournalAfterRollback,
  reaggregateSessionDeletesFromJournal,
  removeQuarantineRoot,
  rollbackQuarantine,
  type QuarantinedCandidate,
  type RollbackOutcome
} from "./finalizeQuarantine.js";
import { rollbackPromotionTransaction } from "./finalizePromotion.js";
import { errorMessage } from "./finalizeShared.js";
import {
  writeJournal,
  type MutatingApplyContext,
  type MutatingApplyResult,
  type RecordPaths,
  type SessionCounters
} from "./finalizeApplyMutatingShared.js";

export async function failAfterQuarantineRollback(input: {
  ctx: MutatingApplyContext;
  journal: FinalizeJournal;
  quarantineRoot: string;
  quarantined: QuarantinedCandidate[];
  priorOnly: boolean;
  issues: Issue[];
}): Promise<MutatingApplyResult> {
  const { ctx, journal, quarantineRoot, quarantined, issues } = input;
  const { priorCleanup, projectRoot, runDir, stateDir, runId, base } = ctx;
  const rollback = await rollbackQuarantine(quarantined);
  await removeQuarantineRoot(quarantineRoot);
  if (rollback.issues.length === 0) {
    await restoreCompletionRecordFromJournal(projectRoot, runDir, journal);
    await clearFinalizeJournal(stateDir, runId);
  } else {
    await persistJournalAfterRollback(stateDir, journal, quarantined, rollback);
  }
  return {
    ...base,
    ok: false,
    deletedFiles: priorCleanup.deletedFiles,
    deletedBytes: priorCleanup.deletedBytes,
    unrestoredPaths: rollback.unrestoredPaths,
    issues: [...issues, ...rollback.issues]
  };
}

export async function failPartialPermanentDelete(input: {
  ctx: MutatingApplyContext;
  journal: FinalizeJournal;
  quarantineRoot: string;
  quarantined: QuarantinedCandidate[];
  launcherHome: EnsureLauncherHomeResult;
  recordPaths: RecordPaths;
  promotionCommitIssues: Issue[];
  session: SessionCounters;
  issues: Issue[];
  correctMeasured: boolean;
  setJournal: (journal: FinalizeJournal) => void;
}): Promise<MutatingApplyResult> {
  const {
    ctx,
    quarantineRoot,
    quarantined,
    launcherHome,
    recordPaths,
    session,
    issues,
    correctMeasured,
    setJournal
  } = input;
  let journal = input.journal;
  const {
    priorCleanup,
    projectRoot,
    runDir,
    stateDir,
    runId,
    canonicalOutputPath,
    referencedSourceMedia,
    planDigest,
    stateUpdatedAt,
    launcherPlan,
    project,
    now,
    base,
    testHooks
  } = ctx;

  const remaining = quarantined.slice(session.deletedFiles);
  const rollback = await rollbackQuarantine(remaining);
  await removeQuarantineRoot(quarantineRoot).catch(() => undefined);
  const totalDeletedFiles = priorCleanup.deletedFiles + session.deletedFiles;
  const totalDeletedBytes = priorCleanup.deletedBytes + session.deletedBytes;
  const totalDeletedPaths = [...priorCleanup.deletedPaths, ...session.paths];
  journal = await writeJournal({
    stateDir,
    runId,
    journal: {
      ...journal,
      phase: "deleting",
      deleted_files: totalDeletedFiles,
      deleted_bytes: totalDeletedBytes,
      deleted_paths: totalDeletedPaths,
      candidates: journal.candidates.map((candidate, candidateIndex) => ({
        ...candidate,
        permanently_deleted: candidateIndex < session.deletedFiles,
        delete_intent: candidateIndex < session.deletedFiles
          ? false
          : candidate.delete_intent
      })),
      updated_at: now ?? new Date().toISOString()
    },
    hooks: testHooks
  });
  setJournal(journal);

  const correctionIssues = correctMeasured
    ? await correctCompletionRecordMeasured({
      recordPaths,
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
    })
    : [];

  return {
    ...base,
    ok: false,
    deletedFiles: totalDeletedFiles,
    deletedBytes: totalDeletedBytes,
    unrestoredPaths: rollback.unrestoredPaths,
    issues: [...issues, ...rollback.issues, ...correctionIssues],
    promotedToLauncherHome: launcherHome.promoted,
    launcherProjectRoot: launcherHome.destinationRoot,
    launcherConfigPath: launcherHome.destinationConfigPath,
    recordPath: recordPaths.reported
  };
}

export async function handleUnexpectedMutatingFailure(input: {
  ctx: MutatingApplyContext;
  error: unknown;
  journal: FinalizeJournal;
  quarantineRoot: string;
  quarantined: QuarantinedCandidate[];
  openPromotionTransaction: PromotionTransaction | undefined;
  session: SessionCounters;
  setJournal: (journal: FinalizeJournal) => void;
}): Promise<MutatingApplyResult> {
  const {
    ctx,
    error,
    quarantineRoot,
    quarantined,
    openPromotionTransaction,
    session,
    setJournal
  } = input;
  let journal = input.journal;
  let sessionDeletedFiles = session.deletedFiles;
  let sessionDeletedBytes = session.deletedBytes;
  const sessionDeletedPaths = [...session.paths];
  const { priorCleanup, projectRoot, runDir, stateDir, runId, recordPath, base } = ctx;

  // Unexpected failure: preserve measured journal counters and roll back any
  // uncommitted promotion so partial durable trees are not left behind.
  const promotionIssues = await rollbackPromotionTransaction(openPromotionTransaction);
  const durableJournal = await readFinalizeJournal(stateDir, runId);
  if (durableJournal) {
    journal = durableJournal;
    setJournal(journal);
  }
  const reaggregated = await reaggregateSessionDeletesFromJournal({
    journal,
    quarantined,
    sessionDeletedFiles,
    sessionDeletedBytes,
    sessionDeletedPaths
  });
  sessionDeletedFiles = reaggregated.sessionDeletedFiles;
  sessionDeletedBytes = reaggregated.sessionDeletedBytes;
  sessionDeletedPaths.length = 0;
  sessionDeletedPaths.push(...reaggregated.sessionDeletedPaths);
  const remaining = quarantined.slice(sessionDeletedFiles);
  const rollback = await rollbackQuarantine(remaining).catch((): RollbackOutcome => ({
    unrestoredPaths: remaining.map((entry) => entry.originalPath),
    issues: [{
      code: "finalize.rollback_failed",
      message: "rollback threw unexpectedly after finalize failure"
    }]
  }));
  await removeQuarantineRoot(quarantineRoot).catch(() => undefined);
  const totalDeletedFiles = priorCleanup.deletedFiles + sessionDeletedFiles;
  const totalDeletedBytes = priorCleanup.deletedBytes + sessionDeletedBytes;
  const totalDeletedPaths = [...priorCleanup.deletedPaths, ...sessionDeletedPaths];
  const recordRestoreIssues = totalDeletedFiles === 0
    ? await restoreCompletionRecordFromJournal(projectRoot, runDir, journal).catch((): Issue[] => [{
      code: "finalize.record_restore_failed",
      message: "completion-record restore threw unexpectedly after finalize failure",
      path: recordPath
    }])
    : [];
  try {
    journal = await writeJournal({
      stateDir,
      runId,
      journal: {
        ...journal,
        phase: totalDeletedFiles > 0 || journal.phase === "deleting" ? "deleting" : journal.phase,
        deleted_files: totalDeletedFiles,
        deleted_bytes: totalDeletedBytes,
        deleted_paths: totalDeletedPaths,
        candidates: journal.candidates.map((candidate, candidateIndex) => ({
          ...candidate,
          permanently_deleted: candidateIndex < sessionDeletedFiles || candidate.permanently_deleted,
          delete_intent: candidateIndex < sessionDeletedFiles ? false : candidate.delete_intent,
          quarantine_path: candidateIndex < sessionDeletedFiles
            ? undefined
            : (quarantined.find((entry) => entry.originalPath === candidate.original_path)?.quarantinePath
              ?? candidate.quarantine_path)
        })),
        updated_at: ctx.now ?? new Date().toISOString()
      }
    });
    setJournal(journal);
  } catch {
    // Keep whatever journal is already on disk; never drop measured progress from the result.
  }
  if (
    rollback.issues.length === 0
    && recordRestoreIssues.length === 0
    && totalDeletedFiles === 0
  ) {
    await clearFinalizeJournal(stateDir, runId).catch(() => undefined);
  } else if (rollback.issues.length > 0) {
    await persistJournalAfterRollback(stateDir, journal, quarantined, rollback).catch(() => undefined);
  }
  return {
    ...base,
    ok: false,
    deletedFiles: totalDeletedFiles,
    deletedBytes: totalDeletedBytes,
    unrestoredPaths: rollback.unrestoredPaths,
    issues: [{
      code: "finalize.cleanup_failed",
      message: errorMessage(error)
    }, ...promotionIssues, ...rollback.issues, ...recordRestoreIssues]
  };
}
