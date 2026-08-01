/**
 * Mutating apply quarantine phase: write-ahead move intent, rename into quarantine,
 * per-candidate revalidation, and fail-closed rollback on inspect/rename errors.
 */
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { restoreCompletionRecordFromJournal } from "./finalizeCompletionRecord.js";
import {
  clearFinalizeJournal,
  type FinalizeJournal
} from "./finalizeJournal.js";
import {
  persistJournalAfterRollback,
  removeQuarantineRoot,
  rollbackQuarantine,
  type QuarantinedCandidate
} from "./finalizeQuarantine.js";
import {
  basenameSafe,
  errorMessage,
  isNodeError
} from "./finalizeShared.js";
import { failAfterQuarantineRollback } from "./finalizeApplyMutatingFailure.js";
import {
  updatePhase,
  writeJournal,
  type MutatingApplyContext,
  type PhaseFailed,
  type PhaseOk
} from "./finalizeApplyMutatingShared.js";

export async function quarantineDeletionCandidates(input: {
  ctx: MutatingApplyContext;
  journal: FinalizeJournal;
  quarantineRoot: string;
  quarantined: QuarantinedCandidate[];
  setJournal: (journal: FinalizeJournal) => void;
}): Promise<PhaseOk<{ journal: FinalizeJournal }> | PhaseFailed> {
  const { ctx, quarantineRoot, quarantined, setJournal } = input;
  let journal = input.journal;
  const {
    candidates,
    identities,
    mediaFiles,
    priorCleanup,
    projectRoot,
    runDir,
    stateDir,
    runId,
    now,
    base,
    testHooks,
    revalidatePinnedDirs,
    inspectDeletionCandidate
  } = ctx;

  journal = await updatePhase(stateDir, journal, "quarantining", testHooks);
  setJournal(journal);

  for (let index = 0; index < candidates.length; index += 1) {
    const originalPath = candidates[index]!;
    const expected = identities[index]!;
    const boundaryIssue = await revalidatePinnedDirs();
    if (boundaryIssue) {
      return {
        kind: "failed",
        result: await failAfterQuarantineRollback({
          ctx,
          journal,
          quarantineRoot,
          quarantined,
          priorOnly: true,
          issues: [boundaryIssue]
        })
      };
    }

    const issue = await inspectDeletionCandidate(originalPath, expected);
    if (issue) {
      return {
        kind: "failed",
        result: await failAfterQuarantineRollback({
          ctx,
          journal,
          quarantineRoot,
          quarantined,
          priorOnly: true,
          issues: [issue]
        })
      };
    }

    const quarantinePath = join(
      quarantineRoot,
      `${String(index).padStart(4, "0")}-${basenameSafe(originalPath)}`
    );
    // Write-ahead move intent: persist decided quarantine path + identity before rename.
    journal = await writeJournal({
      stateDir,
      runId,
      journal: {
        ...journal,
        phase: "quarantining",
        candidates: journal.candidates.map((candidate, candidateIndex) => (
          candidateIndex === index
            ? {
                ...candidate,
                quarantine_path: quarantinePath
              }
            : candidate
        )),
        updated_at: now ?? new Date().toISOString()
      },
      hooks: testHooks
    });
    setJournal(journal);

    try {
      await rename(originalPath, quarantinePath);
    } catch (error) {
      const rollback = await rollbackQuarantine(quarantined);
      await removeQuarantineRoot(quarantineRoot);
      if (rollback.issues.length === 0) {
        await restoreCompletionRecordFromJournal(projectRoot, runDir, journal);
        await clearFinalizeJournal(stateDir, runId);
      } else {
        await persistJournalAfterRollback(stateDir, journal, quarantined, rollback);
      }
      if (isNodeError(error, "EXDEV")) {
        return {
          kind: "failed",
          result: {
            ...base,
            ok: false,
            deletedFiles: priorCleanup.deletedFiles,
            deletedBytes: priorCleanup.deletedBytes,
            unrestoredPaths: rollback.unrestoredPaths,
            issues: [{
              code: "finalize.quarantine_cross_device",
              message: "finalize cannot atomically quarantine candidates across filesystems; cleanup blocked",
              path: originalPath
            }, ...rollback.issues]
          }
        };
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
            code: "finalize.quarantine_failed",
            message: errorMessage(error),
            path: originalPath
          }, ...rollback.issues]
        }
      };
    }

    const entry: QuarantinedCandidate = {
      originalPath,
      quarantinePath,
      expected,
      size: expected.size,
      relativePath: mediaFiles[index]!
    };
    quarantined.push(entry);
    if (testHooks?.afterQuarantineIndex) {
      await testHooks.afterQuarantineIndex(index, quarantinePath);
    }
  }

  journal = await updatePhase(stateDir, journal, "quarantined", testHooks);
  setJournal(journal);
  return { kind: "ok", journal };
}
