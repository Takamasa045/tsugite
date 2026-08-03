/**
 * Mutating apply preflight: pinned-dir revalidation, same-device quarantine check,
 * prior durable completion-record capture, and initial finalize journal write.
 */
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  readPriorDurableCompletionRecordText,
  resolveCompletionRecordPaths
} from "./finalizeCompletionRecord.js";
import { QUARANTINE_DIR_NAME, assertSameFilesystemDevice } from "./finalizeQuarantine.js";
import type { FinalizeJournal } from "./finalizeJournal.js";
import {
  failClosed,
  writeJournal,
  type MutatingApplyContext,
  type MutatingApplyResult
} from "./finalizeApplyMutatingShared.js";

export type MutatingPreflightOk = {
  kind: "ok";
  quarantineRoot: string;
  journal: FinalizeJournal;
};

export type MutatingPreflightResult = MutatingPreflightOk | { kind: "failed"; result: MutatingApplyResult };

/**
 * Boundary checks and WAL bootstrap before any quarantine rename.
 */
export async function prepareMutatingApplyPreflight(
  ctx: MutatingApplyContext
): Promise<MutatingPreflightResult> {
  const {
    projectRoot,
    stateDir,
    runId,
    candidates,
    identities,
    mediaFiles,
    priorCleanup,
    launcherPlan,
    recordPath,
    existingRecordText,
    now,
    base,
    testHooks,
    revalidatePinnedDirs
  } = ctx;

  const quarantineRoot = join(stateDir, QUARANTINE_DIR_NAME, runId, randomUUID());
  const preJournalBoundary = await revalidatePinnedDirs();
  if (preJournalBoundary) return { kind: "failed", result: failClosed(base, preJournalBoundary) };

  const quarantineDeviceIssue = await assertSameFilesystemDevice(
    projectRoot,
    stateDir,
    candidates,
    quarantineRoot
  );
  if (quarantineDeviceIssue) {
    return { kind: "failed", result: failClosed(base, quarantineDeviceIssue) };
  }

  // Capture source and durable prior audits separately before any provisional rewrite.
  // Durable prior is read from the planned launcher destination (if distinct) so rollback
  // can restore each boundary without overwriting durable-specific history with source text.
  const plannedRecordPaths = resolveCompletionRecordPaths(
    projectRoot,
    recordPath,
    launcherPlan.destinationRoot
  );
  let previousDurableCompletionRecord: string | null | undefined;
  if (resolve(plannedRecordPaths.source) !== resolve(plannedRecordPaths.durable)) {
    previousDurableCompletionRecord = await readPriorDurableCompletionRecordText(
      plannedRecordPaths.durable,
      launcherPlan.projectsHome
    );
  }

  const nowIso = now ?? new Date().toISOString();
  const journal = await writeJournal({
    stateDir,
    runId,
    journal: {
      schema_version: 1,
      run_id: runId,
      plan_digest: ctx.planDigest,
      phase: "planned",
      quarantine_root: quarantineRoot,
      candidates: candidates.map((path, index) => ({
        original_path: path,
        original_relative: mediaFiles[index]!,
        identity: identities[index]!,
        permanently_deleted: false
      })),
      deleted_files: priorCleanup.deletedFiles,
      deleted_bytes: priorCleanup.deletedBytes,
      deleted_paths: [...priorCleanup.deletedPaths],
      // Source prior before any provisional rewrite (crash recovery / rollback).
      previous_completion_record: existingRecordText ?? null,
      // Durable prior only when paths differ; omitted for already-home (same path).
      ...(previousDurableCompletionRecord !== undefined
        ? { previous_durable_completion_record: previousDurableCompletionRecord }
        : {}),
      created_at: nowIso,
      updated_at: nowIso
    },
    hooks: testHooks
  });

  return { kind: "ok", quarantineRoot, journal };
}
