import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Issue } from "../types.js";
import {
  clearFinalizeJournal,
  finalizeJournalPath,
  loadFinalizeJournalSchema,
  writeFinalizeJournal,
  type FinalizeJournal,
  type FinalizeJournalCandidate
} from "./finalizeJournal.js";
import { hasSymlinkAlongPath, isWithinPath } from "./finalizePathSafety.js";
import { restoreCompletionRecordFromJournal } from "./finalizeCompletionRecord.js";
import {
  QUARANTINE_DIR_NAME,
  QUARANTINE_SESSION_UUID_RE,
  persistJournalAfterRollback,
  removeQuarantineRoot,
  rollbackQuarantine,
  type QuarantinedCandidate
} from "./finalizeQuarantine.js";
import {
  captureStorageIdentityAt,
  isNodeError,
  pathExistsAny,
  sameFinalizeStorageIdentity,
  toProjectRelative
} from "./finalizeShared.js";

const isWithin = isWithinPath;

const CLEANUP_ROOT_NAMES = ["media", "qa", "references"] as const;

export type PriorCleanupProgress = {
  deletedFiles: number;
  deletedBytes: number;
  deletedPaths: string[];
};

function fixedCleanupRoots(projectRoot: string, stateDir: string): string[] {
  return [
    stateDir,
    ...CLEANUP_ROOT_NAMES.map((name) => join(projectRoot, name))
  ];
}

/**
 * Ensure journal absolute paths stay inside the canonical project and fixed cleanup roots.
 * Validates string containment, direct UUID quarantine session dirs, symlink ancestors,
 * and realpath boundaries. Never rename using unvalidated journal paths.
 */
export async function inspectJournalPathContainment(
  journal: FinalizeJournal,
  projectRoot: string,
  stateDir: string,
  runId: string
): Promise<Issue | undefined> {
  const journalPath = finalizeJournalPath(stateDir, runId);
  const cleanupRoots = fixedCleanupRoots(projectRoot, stateDir);
  const expectedQuarantineParent = resolve(join(stateDir, QUARANTINE_DIR_NAME, runId));
  const quarantineRoot = resolve(journal.quarantine_root);

  if (!isAbsolute(journal.quarantine_root)) {
    return {
      code: "finalize.journal_path_unsafe",
      message: "finalize journal quarantine_root must be an absolute path",
      path: journal.quarantine_root
    };
  }
  if (!isWithin(projectRoot, quarantineRoot) || !isWithin(stateDir, quarantineRoot)) {
    return {
      code: "finalize.journal_path_unsafe",
      message: "finalize journal quarantine_root escaped the approved stateDir/project root",
      path: quarantineRoot
    };
  }
  // Limit to a direct UUID directory under stateDir/.tsugite-finalize-quarantine/<runId>/.
  if (
    dirname(quarantineRoot) !== expectedQuarantineParent
    || !QUARANTINE_SESSION_UUID_RE.test(basename(quarantineRoot))
  ) {
    return {
      code: "finalize.journal_path_unsafe",
      message: "finalize journal quarantine_root must be a direct UUID directory under the run quarantine root",
      path: quarantineRoot
    };
  }

  const quarantineRootBoundary = await inspectJournalPathBoundary({
    projectRoot,
    container: expectedQuarantineParent,
    targetPath: quarantineRoot,
    requireDirectory: true,
    allowMissing: true,
    label: "quarantine_root"
  });
  if (quarantineRootBoundary) return quarantineRootBoundary;

  for (const candidate of journal.candidates) {
    const originalPath = resolve(candidate.original_path);
    if (!isAbsolute(candidate.original_path) || !isWithin(projectRoot, originalPath)) {
      return {
        code: "finalize.journal_path_unsafe",
        message: "finalize journal original_path escaped the project root",
        path: candidate.original_path
      };
    }
    const cleanupRoot = cleanupRoots.find((root) => isWithin(root, originalPath));
    if (!cleanupRoot) {
      return {
        code: "finalize.journal_path_unsafe",
        message: "finalize journal original_path is outside fixed cleanup roots",
        path: candidate.original_path
      };
    }
    if (toProjectRelative(projectRoot, originalPath) !== candidate.original_relative) {
      return {
        code: "finalize.journal_invalid",
        message: "finalize journal original_relative does not match original_path",
        path: candidate.original_path
      };
    }
    if (candidate.identity.path !== candidate.original_relative) {
      return {
        code: "finalize.journal_invalid",
        message: "finalize journal identity.path does not match original_relative",
        path: candidate.original_path
      };
    }
    const originalBoundary = await inspectJournalPathBoundary({
      projectRoot,
      container: cleanupRoot,
      targetPath: originalPath,
      requireDirectory: false,
      allowMissing: true,
      label: "original_path"
    });
    if (originalBoundary) return originalBoundary;

    if (candidate.quarantine_path !== undefined) {
      const quarantinePath = resolve(candidate.quarantine_path);
      if (!isAbsolute(candidate.quarantine_path) || !isWithin(quarantineRoot, quarantinePath)) {
        return {
          code: "finalize.journal_path_unsafe",
          message: "finalize journal quarantine_path escaped quarantine_root",
          path: candidate.quarantine_path
        };
      }
      const quarantinePathBoundary = await inspectJournalPathBoundary({
        projectRoot,
        container: quarantineRoot,
        targetPath: quarantinePath,
        requireDirectory: false,
        allowMissing: true,
        label: "quarantine_path"
      });
      if (quarantinePathBoundary) return quarantinePathBoundary;
    }
  }

  for (const relativePath of journal.deleted_paths) {
    if (relativePath.includes("\0") || relativePath.startsWith("/") || relativePath.includes("\\")) {
      return {
        code: "finalize.journal_invalid",
        message: "finalize journal deleted_paths must be project-relative POSIX paths",
        path: journalPath
      };
    }
    const absolute = resolve(projectRoot, relativePath);
    if (!isWithin(projectRoot, absolute)) {
      return {
        code: "finalize.journal_path_unsafe",
        message: "finalize journal deleted_paths escaped the project root",
        path: relativePath
      };
    }
  }
  return undefined;
}

/**
 * Boundary check for a journal-held absolute path: no symlink ancestors inside the
 * project tree, and realpath (when present) stays inside both projectRoot and container.
 * Missing targets are allowed (recovery may run after rename/delete); existing ancestors
 * are still checked for symlink escape without requiring the missing leaf's realpath.
 */
async function inspectJournalPathBoundary(input: {
  projectRoot: string;
  container: string;
  targetPath: string;
  requireDirectory: boolean;
  allowMissing: boolean;
  label: string;
}): Promise<Issue | undefined> {
  const { projectRoot, container, targetPath, requireDirectory, allowMissing, label } = input;
  try {
    let stats;
    try {
      stats = await lstat(targetPath);
    } catch (error) {
      if (allowMissing && isNodeError(error, "ENOENT")) {
        return inspectMissingJournalPathAncestors(projectRoot, targetPath, label);
      }
      throw error;
    }

    if (await hasSymlinkAlongPath(projectRoot, targetPath)) {
      return {
        code: "finalize.journal_path_unsafe",
        message: `finalize journal ${label} path contains a symbolic-link ancestor`,
        path: targetPath
      };
    }
    if (stats.isSymbolicLink()) {
      return {
        code: "finalize.journal_path_unsafe",
        message: `finalize journal ${label} must not be a symbolic link`,
        path: targetPath
      };
    }
    if (requireDirectory && !stats.isDirectory()) {
      return {
        code: "finalize.journal_path_unsafe",
        message: `finalize journal ${label} must be a real directory`,
        path: targetPath
      };
    }

    const [realProjectRoot, realContainer, realTarget] = await Promise.all([
      realpath(projectRoot),
      realpath(container).catch(() => resolve(container)),
      realpath(targetPath)
    ]);
    if (!isWithin(realProjectRoot, realTarget)) {
      return {
        code: "finalize.journal_path_unsafe",
        message: `finalize journal ${label} realpath escaped the project root`,
        path: targetPath
      };
    }
    if (!isWithin(realContainer, realTarget) && realContainer !== realTarget) {
      return {
        code: "finalize.journal_path_unsafe",
        message: `finalize journal ${label} realpath escaped its containment root`,
        path: targetPath
      };
    }
  } catch (error) {
    return {
      code: "finalize.journal_path_unsafe",
      message: error instanceof Error
        ? `finalize journal ${label} could not be validated: ${error.message}`
        : `finalize journal ${label} could not be validated`,
      path: targetPath
    };
  }
  return undefined;
}

/**
 * For a missing journal path, walk to the nearest existing ancestor under the project
 * and refuse symlink ancestors / realpath escapes there. Does not invent a realpath for
 * the missing leaf (string containment was already enforced by the caller).
 */
async function inspectMissingJournalPathAncestors(
  projectRoot: string,
  targetPath: string,
  label: string
): Promise<Issue | undefined> {
  let current = resolve(targetPath);
  const resolvedProjectRoot = resolve(projectRoot);
  while (true) {
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
    // Stop once we leave the project tree (string-wise); caller already enforced leaf containment.
    if (!isWithin(resolvedProjectRoot, current) && current !== resolvedProjectRoot) {
      return undefined;
    }
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        return {
          code: "finalize.journal_path_unsafe",
          message: `finalize journal ${label} path contains a symbolic-link ancestor`,
          path: targetPath
        };
      }
      if (await hasSymlinkAlongPath(resolvedProjectRoot, current)) {
        return {
          code: "finalize.journal_path_unsafe",
          message: `finalize journal ${label} path contains a symbolic-link ancestor`,
          path: targetPath
        };
      }
      const [realProjectRoot, realAncestor] = await Promise.all([
        realpath(resolvedProjectRoot),
        realpath(current)
      ]);
      if (!isWithin(realProjectRoot, realAncestor) && realProjectRoot !== realAncestor) {
        return {
          code: "finalize.journal_path_unsafe",
          message: `finalize journal ${label} ancestor realpath escaped the project root`,
          path: targetPath
        };
      }
      return undefined;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) continue;
      return {
        code: "finalize.journal_path_unsafe",
        message: error instanceof Error
          ? `finalize journal ${label} could not be validated: ${error.message}`
          : `finalize journal ${label} could not be validated`,
        path: targetPath
      };
    }
  }
}

export async function inspectIncompleteFinalizeTransaction(
  stateDir: string,
  runId: string
): Promise<Issue | undefined> {
  const loaded = await loadFinalizeJournalSchema(stateDir, runId);
  if (loaded.status === "invalid") return loaded.issues[0];
  if (loaded.status === "ok" && loaded.journal.phase !== "completed") {
    return {
      code: "finalize.incomplete_journal",
      message: `incomplete finalize journal in phase '${loaded.journal.phase}' must be recovered via apply`,
      path: finalizeJournalPath(stateDir, runId)
    };
  }
  const orphan = await findOrphanQuarantineRoot(stateDir, runId);
  if (orphan) {
    return {
      code: "finalize.orphan_quarantine",
      message: "orphan finalize quarantine directory detected; apply recovery is required",
      path: orphan
    };
  }
  return undefined;
}

/**
 * Reconcile one journal candidate against the live filesystem.
 * Returns whether the candidate is permanently deleted, still quarantined, already restored,
 * or ambiguous (fail-closed).
 */
export async function reconcileJournalCandidate(candidate: FinalizeJournalCandidate): Promise<
  | { status: "permanently_deleted" }
  | { status: "restored" }
  | { status: "quarantined"; entry: QuarantinedCandidate }
  | { status: "ambiguous"; issue: Issue }
  | { status: "pending_move_intent" }
> {
  const originalIdentity = await captureStorageIdentityAt(candidate.original_path);
  const quarantineIdentity = candidate.quarantine_path
    ? await captureStorageIdentityAt(candidate.quarantine_path)
    : undefined;
  const originalExists = await pathExistsAny(candidate.original_path);
  const quarantineExists = candidate.quarantine_path
    ? await pathExistsAny(candidate.quarantine_path)
    : false;

  if (candidate.permanently_deleted) {
    if (quarantineExists || (originalExists && originalIdentity
      && sameFinalizeStorageIdentity(candidate.identity, originalIdentity))) {
      // Already-deleted claim conflicts with live evidence.
      return {
        status: "ambiguous",
        issue: {
          code: "finalize.journal_recovery_ambiguous",
          message: "journal marks candidate permanently deleted but matching content still exists",
          path: candidate.original_path
        }
      };
    }
    return { status: "permanently_deleted" };
  }

  // Write-ahead delete intent: decide deleted vs still present from both sides.
  if (candidate.delete_intent) {
    if (quarantineIdentity && sameFinalizeStorageIdentity(candidate.identity, quarantineIdentity)) {
      return {
        status: "quarantined",
        entry: {
          originalPath: candidate.original_path,
          quarantinePath: candidate.quarantine_path!,
          expected: candidate.identity,
          size: candidate.identity.size,
          relativePath: candidate.original_relative
        }
      };
    }
    if (!quarantineExists && !originalExists) {
      return { status: "permanently_deleted" };
    }
    if (
      originalIdentity
      && sameFinalizeStorageIdentity(candidate.identity, originalIdentity)
      && !quarantineExists
    ) {
      return { status: "restored" };
    }
    return {
      status: "ambiguous",
      issue: {
        code: "finalize.journal_recovery_ambiguous",
        message: "delete intent cannot be reconciled from original/quarantine presence",
        path: candidate.original_path
      }
    };
  }

  if (candidate.quarantine_path) {
    if (quarantineIdentity && sameFinalizeStorageIdentity(candidate.identity, quarantineIdentity)) {
      // Matching content at both sides is truly ambiguous. Occupied-but-different original
      // (recreated file/dir) is handled by rollback refusing to overwrite.
      if (
        originalIdentity
        && sameFinalizeStorageIdentity(candidate.identity, originalIdentity)
      ) {
        return {
          status: "ambiguous",
          issue: {
            code: "finalize.journal_recovery_ambiguous",
            message: "both original and quarantine paths hold the journal candidate identity",
            path: candidate.original_path
          }
        };
      }
      return {
        status: "quarantined",
        entry: {
          originalPath: candidate.original_path,
          quarantinePath: candidate.quarantine_path,
          expected: candidate.identity,
          size: candidate.identity.size,
          relativePath: candidate.original_relative
        }
      };
    }
    // Write-ahead move intent recorded, but rename never happened.
    if (
      originalIdentity
      && sameFinalizeStorageIdentity(candidate.identity, originalIdentity)
      && !quarantineExists
    ) {
      return { status: "pending_move_intent" };
    }
    if (!originalExists && !quarantineExists) {
      // Possibly deleted without delete_intent (legacy crash). Treat as ambiguous unless
      // deleted_files already accounts for it via permanently_deleted.
      return {
        status: "ambiguous",
        issue: {
          code: "finalize.journal_recovery_ambiguous",
          message: "journal candidate is missing from both original and quarantine locations",
          path: candidate.original_path
        }
      };
    }
    return {
      status: "ambiguous",
      issue: {
        code: "finalize.journal_recovery_ambiguous",
        message: "journal candidate identity no longer matches original or quarantine path",
        path: candidate.original_path
      }
    };
  }

  if (
    originalIdentity
    && sameFinalizeStorageIdentity(candidate.identity, originalIdentity)
  ) {
    return { status: "restored" };
  }
  if (!originalExists) {
    return {
      status: "ambiguous",
      issue: {
        code: "finalize.journal_recovery_ambiguous",
        message: "journal candidate has no quarantine_path and original is missing",
        path: candidate.original_path
      }
    };
  }
  return {
    status: "ambiguous",
    issue: {
      code: "finalize.journal_recovery_ambiguous",
      message: "journal candidate original path identity does not match the journal",
      path: candidate.original_path
    }
  };
}

export async function recoverIncompleteFinalizeTransaction(input: {
  stateDir: string;
  runId: string;
  projectRoot: string;
}): Promise<{
  ok: boolean;
  issues: Issue[];
  unrestoredPaths?: string[];
  prior: PriorCleanupProgress;
}> {
  const emptyPrior: PriorCleanupProgress = {
    deletedFiles: 0,
    deletedBytes: 0,
    deletedPaths: []
  };
  const runDir = join(input.stateDir, input.runId);
  const loaded = await loadFinalizeJournalSchema(input.stateDir, input.runId);
  const orphanRoot = await findOrphanQuarantineRoot(input.stateDir, input.runId);

  if (loaded.status === "invalid") {
    // Fail-closed: keep the broken journal and refuse any project-external recovery renames.
    return {
      ok: false,
      issues: loaded.issues,
      prior: emptyPrior
    };
  }

  if (loaded.status === "missing") {
    if (!orphanRoot) return { ok: true, issues: [], prior: emptyPrior };
    return {
      ok: false,
      issues: [{
        code: "finalize.orphan_quarantine",
        message: "orphan finalize quarantine directory has no journal; refusing to guess original paths",
        path: orphanRoot
      }],
      prior: emptyPrior
    };
  }

  const journal = loaded.journal;
  const containmentIssue = await inspectJournalPathContainment(
    journal,
    input.projectRoot,
    input.stateDir,
    input.runId
  );
  if (containmentIssue) {
    // Fail-closed: refuse all filesystem mutation (rename/unlink) for unvalidated journals.
    return {
      ok: false,
      issues: [containmentIssue],
      prior: emptyPrior
    };
  }

  if (journal.phase === "completed") {
    await clearFinalizeJournal(input.stateDir, input.runId);
    await removeQuarantineRoot(journal.quarantine_root).catch(() => undefined);
    return { ok: true, issues: [], prior: emptyPrior };
  }

  // Reconcile every candidate from live original/quarantine presence + stored identity.
  const toRestore: QuarantinedCandidate[] = [];
  const reconciledCandidates: FinalizeJournalCandidate[] = [];
  // Start from journal measured progress, then add only unrecorded post-unlink discoveries.
  let measuredDeletedFiles = journal.deleted_files;
  let measuredDeletedBytes = journal.deleted_bytes;
  const measuredDeletedPaths = [...journal.deleted_paths];
  const measuredPathSet = new Set(measuredDeletedPaths);
  const ambiguousIssues: Issue[] = [];

  for (const candidate of journal.candidates) {
    const reconciled = await reconcileJournalCandidate(candidate);
    if (reconciled.status === "ambiguous") {
      ambiguousIssues.push(reconciled.issue);
      reconciledCandidates.push(candidate);
      continue;
    }
    if (reconciled.status === "permanently_deleted") {
      if (!measuredPathSet.has(candidate.original_relative)) {
        measuredDeletedFiles += 1;
        measuredDeletedBytes += candidate.identity.size;
        measuredDeletedPaths.push(candidate.original_relative);
        measuredPathSet.add(candidate.original_relative);
      }
      reconciledCandidates.push({
        ...candidate,
        permanently_deleted: true,
        delete_intent: false,
        quarantine_path: undefined
      });
      continue;
    }
    if (reconciled.status === "quarantined") {
      toRestore.push(reconciled.entry);
      reconciledCandidates.push({
        ...candidate,
        permanently_deleted: false,
        delete_intent: false,
        quarantine_path: reconciled.entry.quarantinePath
      });
      continue;
    }
    // restored or abandoned write-ahead move intent: original is already correct.
    reconciledCandidates.push({
      ...candidate,
      permanently_deleted: false,
      delete_intent: false,
      quarantine_path: undefined
    });
  }

  if (ambiguousIssues.length > 0) {
    // Keep journal untouched; do not rename using uncertain paths.
    return {
      ok: false,
      issues: ambiguousIssues,
      prior: {
        deletedFiles: measuredDeletedFiles,
        deletedBytes: measuredDeletedBytes,
        deletedPaths: measuredDeletedPaths
      }
    };
  }

  const prior: PriorCleanupProgress = {
    deletedFiles: measuredDeletedFiles,
    deletedBytes: measuredDeletedBytes,
    deletedPaths: measuredDeletedPaths
  };

  // Pre-delete crash: restore quarantined originals and roll provisional completion-record back.
  if (prior.deletedFiles === 0) {
    const rollback = await rollbackQuarantine(toRestore, { verifyIdentity: true });
    await removeQuarantineRoot(journal.quarantine_root).catch(() => undefined);
    if (orphanRoot && resolve(orphanRoot) !== resolve(journal.quarantine_root)) {
      await removeQuarantineRoot(orphanRoot).catch(() => undefined);
    }
    const recordRestoreIssues = await restoreCompletionRecordFromJournal(
      input.projectRoot,
      runDir,
      journal
    );
    if (rollback.issues.length > 0 || recordRestoreIssues.length > 0) {
      await persistJournalAfterRollback(input.stateDir, journal, toRestore, rollback);
      return {
        ok: false,
        issues: [...rollback.issues, ...recordRestoreIssues],
        unrestoredPaths: rollback.unrestoredPaths,
        prior: emptyPrior
      };
    }
    await clearFinalizeJournal(input.stateDir, input.runId);
    return { ok: true, issues: [], prior: emptyPrior };
  }

  // Partial permanent delete: restore only non-deleted quarantine entries, keep measured history.
  const rollback = await rollbackQuarantine(toRestore, { verifyIdentity: true });
  await removeQuarantineRoot(journal.quarantine_root).catch(() => undefined);
  if (rollback.issues.length > 0) {
    await writeFinalizeJournal({
      stateDir: input.stateDir,
      runId: input.runId,
      journal: {
        ...journal,
        phase: "deleting",
        deleted_files: prior.deletedFiles,
        deleted_bytes: prior.deletedBytes,
        deleted_paths: prior.deletedPaths,
        candidates: reconciledCandidates.map((candidate) => {
          if (rollback.unrestoredPaths.includes(candidate.original_path)) {
            return candidate;
          }
          if (toRestore.some((entry) => entry.originalPath === candidate.original_path)) {
            return { ...candidate, quarantine_path: undefined };
          }
          return candidate;
        }),
        updated_at: new Date().toISOString()
      }
    });
    return {
      ok: false,
      issues: rollback.issues,
      unrestoredPaths: rollback.unrestoredPaths,
      prior
    };
  }

  // Keep journal as truth for cumulative merge on the retry apply.
  await writeFinalizeJournal({
    stateDir: input.stateDir,
    runId: input.runId,
    journal: {
      ...journal,
      phase: "deleting",
      deleted_files: prior.deletedFiles,
      deleted_bytes: prior.deletedBytes,
      deleted_paths: prior.deletedPaths,
      candidates: reconciledCandidates.map((candidate) => ({
        ...candidate,
        quarantine_path: undefined,
        delete_intent: false
      })),
      updated_at: new Date().toISOString()
    }
  });
  return { ok: true, issues: [], prior };
}

export async function findOrphanQuarantineRoot(
  stateDir: string,
  runId: string
): Promise<string | undefined> {
  const root = join(stateDir, QUARANTINE_DIR_NAME, runId);
  try {
    const stats = await lstat(root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return undefined;
    const entries = await readdir(root);
    if (entries.length === 0) return undefined;
    // Prefer the first non-empty UUID directory.
    for (const name of entries) {
      const candidate = join(root, name);
      try {
        const childStats = await lstat(candidate);
        if (!childStats.isDirectory() || childStats.isSymbolicLink()) continue;
        if ((await readdir(candidate)).length > 0) return candidate;
      } catch {
        // continue
      }
    }
    return root;
  } catch {
    return undefined;
  }
}
