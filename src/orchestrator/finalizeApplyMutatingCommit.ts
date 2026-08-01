/**
 * Mutating apply permanent-delete (commit) phase and success-path completion.
 * Partial-delete and unexpected-failure recovery live in finalizeApplyMutatingFailure.
 */
import { lstat, unlink } from "node:fs/promises";
import type { EnsureLauncherHomeResult } from "../project/projectsHome.js";
import type { Issue } from "../types.js";
import { writeCompletionRecords } from "./finalizeCompletionRecord.js";
import {
  clearFinalizeJournal,
  readFinalizeJournal,
  type FinalizeJournal
} from "./finalizeJournal.js";
import {
  inspectQuarantinedIdentity,
  reaggregateSessionDeletesFromJournal,
  removeQuarantineRoot,
  type QuarantinedCandidate
} from "./finalizeQuarantine.js";
import { errorMessage } from "./finalizeShared.js";
import {
  failPartialPermanentDelete
} from "./finalizeApplyMutatingFailure.js";
import {
  updatePhase,
  writeJournal,
  type MutatingApplyContext,
  type MutatingApplyResult,
  type RecordPaths,
  type SessionCounters
} from "./finalizeApplyMutatingShared.js";

export async function permanentlyDeleteQuarantinedAndComplete(input: {
  ctx: MutatingApplyContext;
  journal: FinalizeJournal;
  quarantineRoot: string;
  quarantined: QuarantinedCandidate[];
  launcherHome: EnsureLauncherHomeResult;
  recordPaths: RecordPaths;
  promotionCommitIssues: Issue[];
  session: SessionCounters;
  setJournal: (journal: FinalizeJournal) => void;
}): Promise<MutatingApplyResult> {
  const {
    ctx,
    quarantineRoot,
    quarantined,
    launcherHome,
    recordPaths,
    promotionCommitIssues,
    session,
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
    testHooks,
    revalidatePinnedDirs
  } = ctx;

  journal = await updatePhase(stateDir, journal, "deleting", testHooks);
  setJournal(journal);

  for (let index = 0; index < quarantined.length; index += 1) {
    const entry = quarantined[index]!;
    try {
      if (testHooks?.beforePermanentDeleteIndex) {
        await testHooks.beforePermanentDeleteIndex(index, entry.quarantinePath);
      }
      const deleteBoundary = await revalidatePinnedDirs();
      if (deleteBoundary) {
        return await failPartialPermanentDelete({
          ctx,
          journal,
          quarantineRoot,
          quarantined,
          launcherHome,
          recordPaths,
          promotionCommitIssues,
          session,
          issues: [deleteBoundary, ...promotionCommitIssues],
          correctMeasured: false,
          setJournal
        });
      }
      const identityIssue = await inspectQuarantinedIdentity(entry);
      if (identityIssue) {
        return await failPartialPermanentDelete({
          ctx,
          journal,
          quarantineRoot,
          quarantined,
          launcherHome,
          recordPaths,
          promotionCommitIssues,
          session,
          issues: [identityIssue, ...promotionCommitIssues],
          correctMeasured: true,
          setJournal
        });
      }
      const stats = await lstat(entry.quarantinePath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`refusing to delete non-regular quarantined media: ${entry.quarantinePath}`);
      }
      // Write-ahead delete intent before unlink so post-unlink crashes keep measured progress.
      journal = await writeJournal({
        stateDir,
        runId,
        journal: {
          ...journal,
          phase: "deleting",
          candidates: journal.candidates.map((candidate, candidateIndex) => (
            candidateIndex === index
              ? { ...candidate, delete_intent: true }
              : candidate
          )),
          updated_at: now ?? new Date().toISOString()
        },
        hooks: testHooks
      });
      setJournal(journal);
      await unlink(entry.quarantinePath);
      session.deletedBytes += stats.size;
      session.deletedFiles += 1;
      session.paths.push(entry.relativePath);
      journal = await writeJournal({
        stateDir,
        runId,
        journal: {
          ...journal,
          phase: "deleting",
          deleted_files: priorCleanup.deletedFiles + session.deletedFiles,
          deleted_bytes: priorCleanup.deletedBytes + session.deletedBytes,
          deleted_paths: [...priorCleanup.deletedPaths, ...session.paths],
          candidates: journal.candidates.map((candidate, candidateIndex) => ({
            ...candidate,
            permanently_deleted: candidateIndex < session.deletedFiles,
            delete_intent: candidateIndex === index ? false : candidate.delete_intent
          })),
          updated_at: now ?? new Date().toISOString()
        },
        hooks: testHooks
      });
      setJournal(journal);
    } catch (error) {
      // Partial permanent delete: keep measured progress, restore any not-yet-deleted
      // quarantined files, and never misreport the result as zero deletes.
      // Prefer on-disk journal when a test hook threw after a durable write-ahead update.
      const durableJournal = await readFinalizeJournal(stateDir, runId);
      if (durableJournal) {
        journal = durableJournal;
        setJournal(journal);
      }
      const reaggregated = await reaggregateSessionDeletesFromJournal({
        journal,
        quarantined,
        sessionDeletedFiles: session.deletedFiles,
        sessionDeletedBytes: session.deletedBytes,
        sessionDeletedPaths: session.paths
      });
      session.deletedFiles = reaggregated.sessionDeletedFiles;
      session.deletedBytes = reaggregated.sessionDeletedBytes;
      session.paths.length = 0;
      session.paths.push(...reaggregated.sessionDeletedPaths);
      return await failPartialPermanentDelete({
        ctx,
        journal,
        quarantineRoot,
        quarantined,
        launcherHome,
        recordPaths,
        promotionCommitIssues,
        session,
        issues: [{
          code: "finalize.cleanup_failed",
          message: errorMessage(error),
          path: entry.originalPath
        }, ...promotionCommitIssues],
        correctMeasured: true,
        setJournal
      });
    }
  }

  await removeQuarantineRoot(quarantineRoot);

  const totalDeletedFiles = priorCleanup.deletedFiles + session.deletedFiles;
  const totalDeletedBytes = priorCleanup.deletedBytes + session.deletedBytes;
  const totalDeletedPaths = [...priorCleanup.deletedPaths, ...session.paths];

  // Rewrite record with measured permanent-delete totals on source and durable paths.
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

  journal = await writeJournal({
    stateDir,
    runId,
    journal: {
      ...journal,
      phase: "completed",
      deleted_files: totalDeletedFiles,
      deleted_bytes: totalDeletedBytes,
      deleted_paths: totalDeletedPaths,
      candidates: journal.candidates.map((candidate) => ({
        ...candidate,
        permanently_deleted: true
      })),
      updated_at: now ?? new Date().toISOString()
    },
    hooks: testHooks
  });
  setJournal(journal);
  await clearFinalizeJournal(stateDir, runId);

  // Deletion and completion-record progress are retained even when promotion
  // commit failed; leftover backup/journal is finished by recoverPromotionTransactions.
  if (promotionCommitIssues.length > 0) {
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

  return {
    ...base,
    recordPath: recordPaths.reported,
    deletedFiles: totalDeletedFiles,
    deletedBytes: totalDeletedBytes,
    promotedToLauncherHome: launcherHome.promoted,
    launcherProjectRoot: launcherHome.destinationRoot,
    launcherConfigPath: launcherHome.destinationConfigPath
  };
}
