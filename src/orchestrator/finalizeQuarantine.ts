import { lstat, readdir, rename, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Issue } from "../types.js";
import {
  writeFinalizeJournal,
  type FinalizeFileIdentity,
  type FinalizeJournal
} from "./finalizeJournal.js";
import {
  errorMessage,
  errorMessageOr,
  isNodeError,
  pathExistsAny,
  sameFinalizeStorageIdentity
} from "./finalizeShared.js";

/** Project-local quarantine root under the approved state directory. */
export const QUARANTINE_DIR_NAME = ".tsugite-finalize-quarantine";
/** Quarantine session dirs are always a direct randomUUID() child of the run quarantine root. */
export const QUARANTINE_SESSION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type QuarantinedCandidate = {
  originalPath: string;
  quarantinePath: string;
  expected: FinalizeFileIdentity;
  size: number;
  relativePath: string;
};

export type RollbackOutcome = {
  unrestoredPaths: string[];
  issues: Issue[];
};

export type SessionDeleteProgress = {
  sessionDeletedFiles: number;
  sessionDeletedBytes: number;
  sessionDeletedPaths: string[];
};

export async function assertSameFilesystemDevice(
  projectRoot: string,
  stateDir: string,
  candidates: readonly string[],
  quarantineRoot: string
): Promise<Issue | undefined> {
  try {
    const stateStats = await lstat(stateDir);
    const projectStats = await lstat(projectRoot);
    if (stateStats.dev !== projectStats.dev) {
      return {
        code: "finalize.quarantine_cross_device",
        message: "finalize requires project root and stateDir on the same filesystem for atomic quarantine",
        path: stateDir
      };
    }
    for (const path of candidates) {
      const stats = await lstat(path);
      if (stats.dev !== stateStats.dev) {
        return {
          code: "finalize.quarantine_cross_device",
          message: "finalize cannot atomically quarantine a candidate on a different filesystem",
          path
        };
      }
    }
    // quarantineRoot is created under stateDir, so parent device matches once mkdir succeeds.
    void quarantineRoot;
    return undefined;
  } catch (error) {
    return {
      code: "finalize.quarantine_failed",
      message: errorMessage(error),
      path: stateDir
    };
  }
}

export async function inspectQuarantinedIdentity(
  entry: QuarantinedCandidate
): Promise<Issue | undefined> {
  try {
    const stats = await lstat(entry.quarantinePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return {
        code: "finalize.candidate_changed",
        message: "quarantined candidate is no longer a regular file before permanent delete",
        path: entry.originalPath
      };
    }
    const live = {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      device: stats.dev,
      inode: stats.ino
    };
    if (!sameFinalizeStorageIdentity(entry.expected, live)) {
      return {
        code: "finalize.candidate_changed",
        message: "quarantined candidate identity changed before permanent delete; refusing unlink",
        path: entry.originalPath
      };
    }
    return undefined;
  } catch (error) {
    return {
      code: "finalize.candidate_changed",
      message: errorMessageOr(error, "quarantined candidate could not be revalidated"),
      path: entry.originalPath
    };
  }
}

export async function rollbackQuarantine(
  entries: readonly QuarantinedCandidate[],
  options: { verifyIdentity?: boolean } = {}
): Promise<RollbackOutcome> {
  const unrestoredPaths: string[] = [];
  const issues: Issue[] = [];
  const verifyIdentity = options.verifyIdentity === true;
  for (const entry of [...entries].reverse()) {
    try {
      // Never overwrite a recreated original path (regular file, directory, or symlink).
      try {
        await lstat(entry.originalPath);
        unrestoredPaths.push(entry.originalPath);
        issues.push({
          code: "finalize.rollback_failed",
          message: "refusing to overwrite a path that already exists at the rollback destination",
          path: entry.originalPath
        });
        continue;
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }

      const quarantineStats = await lstat(entry.quarantinePath);
      if (!quarantineStats.isFile() || quarantineStats.isSymbolicLink()) {
        unrestoredPaths.push(entry.originalPath);
        issues.push({
          code: "finalize.rollback_failed",
          message: "quarantined candidate is no longer a regular file; refusing restore",
          path: entry.quarantinePath
        });
        continue;
      }
      // Recovery renames must match the journal identity. Live mid-apply rollback restores
      // whatever we moved unless the destination is occupied (checked above).
      if (verifyIdentity && !sameFinalizeStorageIdentity(entry.expected, {
        size: quarantineStats.size,
        mtimeMs: quarantineStats.mtimeMs,
        device: quarantineStats.dev,
        inode: quarantineStats.ino
      })) {
        unrestoredPaths.push(entry.originalPath);
        issues.push({
          code: "finalize.rollback_failed",
          message: "quarantined candidate identity does not match the journal; refusing restore",
          path: entry.quarantinePath
        });
        continue;
      }

      await rename(entry.quarantinePath, entry.originalPath);
    } catch (error) {
      unrestoredPaths.push(entry.originalPath);
      issues.push({
        code: "finalize.rollback_failed",
        message: errorMessage(error),
        path: entry.originalPath
      });
    }
  }
  return { unrestoredPaths, issues };
}

export async function removeQuarantineRoot(quarantineRoot: string): Promise<void> {
  try {
    const entries = await readdir(quarantineRoot);
    if (entries.length === 0) await rmdir(quarantineRoot);
  } catch {
    // leave non-empty or missing roots alone
  }
  // Also try removing parent run-id and shared quarantine dirs when empty.
  try {
    const runQuarantine = dirname(quarantineRoot);
    if ((await readdir(runQuarantine)).length === 0) await rmdir(runQuarantine);
    const shared = dirname(runQuarantine);
    if ((await readdir(shared)).length === 0) await rmdir(shared);
  } catch {
    // ignore
  }
}

/**
 * Persist journal candidate quarantine paths after a partial rollback.
 * Keeps unrestored entries pointed at quarantine so a later apply can recover them.
 */
export async function persistJournalAfterRollback(
  stateDir: string,
  journal: FinalizeJournal,
  quarantined: readonly QuarantinedCandidate[],
  rollback: RollbackOutcome
): Promise<void> {
  if (rollback.unrestoredPaths.length === 0) return;
  const unrestored = new Set(rollback.unrestoredPaths);
  await writeFinalizeJournal({
    stateDir,
    runId: journal.run_id,
    journal: {
      ...journal,
      phase: journal.phase === "deleting" ? "deleting" : "quarantining",
      candidates: journal.candidates.map((candidate) => {
        const match = quarantined.find((entry) => entry.originalPath === candidate.original_path);
        if (!match) return candidate;
        if (unrestored.has(match.originalPath)) {
          return {
            ...candidate,
            quarantine_path: match.quarantinePath
          };
        }
        return {
          ...candidate,
          quarantine_path: undefined
        };
      }),
      updated_at: new Date().toISOString()
    }
  });
}

/**
 * Re-aggregate session delete counters from durable journal delete_intent when a crash
 * or injected failure left permanently_deleted lagging behind an already-unlinked file.
 */
export async function reaggregateSessionDeletesFromJournal(input: {
  journal: FinalizeJournal;
  quarantined: readonly QuarantinedCandidate[];
  sessionDeletedFiles: number;
  sessionDeletedBytes: number;
  sessionDeletedPaths: readonly string[];
}): Promise<SessionDeleteProgress> {
  let sessionDeletedFiles = input.sessionDeletedFiles;
  let sessionDeletedBytes = input.sessionDeletedBytes;
  const sessionDeletedPaths = [...input.sessionDeletedPaths];

  for (
    let candidateIndex = sessionDeletedFiles;
    candidateIndex < input.quarantined.length;
    candidateIndex += 1
  ) {
    const candidate = input.journal.candidates[candidateIndex];
    const entry = input.quarantined[candidateIndex];
    if (!candidate?.delete_intent || candidate.permanently_deleted || !entry) continue;
    if (await pathExistsAny(entry.quarantinePath)) continue;
    if (await pathExistsAny(entry.originalPath)) continue;
    sessionDeletedFiles += 1;
    sessionDeletedBytes += entry.size;
    sessionDeletedPaths.push(entry.relativePath);
  }

  return { sessionDeletedFiles, sessionDeletedBytes, sessionDeletedPaths };
}

export function quarantineRootForRun(stateDir: string, runId: string): string {
  return join(stateDir, QUARANTINE_DIR_NAME, runId);
}
