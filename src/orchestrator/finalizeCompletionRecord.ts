import { dirname, join, resolve } from "node:path";
import type { Issue } from "../types.js";
import {
  FinalizePersistenceError,
  captureDirectoryIdentity,
  ensureContainedParentDirs,
  readContainedRegularFileText,
  unlinkContainedRegularFile,
  writeAtomicRegularFile
} from "./finalizePersistence.js";
import { inspectProjectContainedPath, isWithinPath } from "./finalizePathSafety.js";
import type { FinalizeJournal } from "./finalizeJournal.js";
import {
  errorMessage,
  toProjectRelative
} from "./finalizeShared.js";

const isWithin = isWithinPath;

export type CompletionRecordLauncherPlan = {
  projectsHome: string;
  destinationRoot: string;
  alreadyHome: boolean;
  willPromote?: boolean;
};

/**
 * Narrow project context for completion-record writes.
 * Avoids coupling this module to the full finalize options surface.
 */
export type CompletionRecordProjectContext = {
  projectSlug: string;
  now?: string;
};

export type CompletionRecordPaths = {
  source: string;
  durable: string;
  reported: string;
};

export type WriteCompletionRecordInput = {
  recordPath: string;
  project: CompletionRecordProjectContext;
  runId: string;
  stateUpdatedAt: string;
  canonicalOutputPath: string;
  runDir: string;
  projectRoot: string;
  referencedSourceMedia: readonly string[];
  deletedFiles: number;
  deletedBytes: number;
  deletedMediaPaths: readonly string[];
  planDigest: string;
  launcherPlan: CompletionRecordLauncherPlan;
  promoted?: boolean;
  partial?: boolean;
  containWithin?: string;
};

export type WriteCompletionRecordsInput = {
  sourceRecordPath: string;
  durableRecordPath: string;
  project: CompletionRecordProjectContext;
  runId: string;
  stateUpdatedAt: string;
  canonicalOutputPath: string;
  runDir: string;
  projectRoot: string;
  referencedSourceMedia: readonly string[];
  deletedFiles: number;
  deletedBytes: number;
  deletedMediaPaths: readonly string[];
  planDigest: string;
  launcherPlan: CompletionRecordLauncherPlan;
  promoted?: boolean;
  partial?: boolean;
};

export type CorrectCompletionRecordMeasuredInput = {
  recordPaths: CompletionRecordPaths;
  project: CompletionRecordProjectContext;
  runId: string;
  stateUpdatedAt: string;
  canonicalOutputPath: string;
  runDir: string;
  projectRoot: string;
  referencedSourceMedia: readonly string[];
  deletedFiles: number;
  deletedBytes: number;
  deletedMediaPaths: readonly string[];
  planDigest: string;
  launcherPlan: CompletionRecordLauncherPlan;
  promoted?: boolean;
};

export function resolveCompletionRecordPaths(
  sourceProjectRoot: string,
  sourceRecordPath: string,
  destinationRoot: string
): CompletionRecordPaths {
  const relative = toProjectRelative(sourceProjectRoot, sourceRecordPath);
  const durable = join(destinationRoot, ...relative.split("/"));
  const same = resolve(sourceRecordPath) === resolve(durable);
  return {
    source: sourceRecordPath,
    durable,
    // Already-home keeps the historical project-relative path; promotions report the durable absolute path.
    reported: same ? relative : durable
  };
}

export async function writeCompletionRecord(input: WriteCompletionRecordInput): Promise<void> {
  const projectRoot = input.projectRoot;
  const record = {
    schema_version: 1,
    project_slug: input.project.projectSlug,
    run_id: input.runId,
    completed_at: input.stateUpdatedAt,
    finalized_at: input.project.now ?? new Date().toISOString(),
    canonical_output: toProjectRelative(projectRoot, input.canonicalOutputPath),
    retained_run: toProjectRelative(projectRoot, input.runDir),
    retained_source_media: input.referencedSourceMedia
      .map((path) => toProjectRelative(projectRoot, path))
      .sort(),
    cleanup: {
      media_files_deleted: input.deletedFiles,
      bytes_reclaimed: input.deletedBytes,
      deleted_media_paths: [...input.deletedMediaPaths],
      plan_digest: input.planDigest,
      ...(input.partial ? { partial: true } : {})
    },
    launcher: {
      projects_home: input.launcherPlan.projectsHome,
      project_root: input.launcherPlan.destinationRoot,
      source_project_root: projectRoot,
      already_home: input.launcherPlan.alreadyHome,
      will_promote: input.launcherPlan.willPromote ?? !input.launcherPlan.alreadyHome,
      ...(input.promoted !== undefined ? { promoted: input.promoted } : {})
    }
  };
  await writeAtomicRegularFile({
    path: input.recordPath,
    contents: `${JSON.stringify(record, null, 2)}\n`,
    containWithin: input.containWithin ?? input.projectRoot
  });
}

export async function writeCompletionRecords(input: WriteCompletionRecordsInput): Promise<void> {
  await writeCompletionRecord({
    recordPath: input.sourceRecordPath,
    project: input.project,
    runId: input.runId,
    stateUpdatedAt: input.stateUpdatedAt,
    canonicalOutputPath: input.canonicalOutputPath,
    runDir: input.runDir,
    projectRoot: input.projectRoot,
    referencedSourceMedia: input.referencedSourceMedia,
    deletedFiles: input.deletedFiles,
    deletedBytes: input.deletedBytes,
    deletedMediaPaths: input.deletedMediaPaths,
    planDigest: input.planDigest,
    launcherPlan: input.launcherPlan,
    promoted: input.promoted,
    partial: input.partial,
    containWithin: input.projectRoot
  });
  if (resolve(input.sourceRecordPath) !== resolve(input.durableRecordPath)) {
    // Never recursive-mkdir through ancestor symlinks (external side effects).
    // Prefer projectsHome as the durable boundary when available; fall back to destinationRoot.
    const durableBoundary = input.launcherPlan.projectsHome || input.launcherPlan.destinationRoot;
    await ensureContainedParentDirs({
      filePath: input.durableRecordPath,
      containWithin: durableBoundary
    });
    await writeCompletionRecord({
      recordPath: input.durableRecordPath,
      project: input.project,
      runId: input.runId,
      stateUpdatedAt: input.stateUpdatedAt,
      canonicalOutputPath: input.canonicalOutputPath,
      runDir: input.runDir,
      projectRoot: input.projectRoot,
      referencedSourceMedia: input.referencedSourceMedia,
      deletedFiles: input.deletedFiles,
      deletedBytes: input.deletedBytes,
      deletedMediaPaths: input.deletedMediaPaths,
      planDigest: input.planDigest,
      launcherPlan: input.launcherPlan,
      promoted: input.promoted,
      partial: input.partial,
      // Keep durable write containment at destinationRoot (existing contract); parents already verified under projectsHome.
      containWithin: input.launcherPlan.destinationRoot
    });
  }
}

export async function correctCompletionRecordMeasured(
  input: CorrectCompletionRecordMeasuredInput
): Promise<Issue[]> {
  try {
    await writeCompletionRecords({
      sourceRecordPath: input.recordPaths.source,
      durableRecordPath: input.recordPaths.durable,
      project: input.project,
      runId: input.runId,
      stateUpdatedAt: input.stateUpdatedAt,
      canonicalOutputPath: input.canonicalOutputPath,
      runDir: input.runDir,
      projectRoot: input.projectRoot,
      referencedSourceMedia: input.referencedSourceMedia,
      deletedFiles: input.deletedFiles,
      deletedBytes: input.deletedBytes,
      deletedMediaPaths: input.deletedMediaPaths,
      planDigest: input.planDigest,
      launcherPlan: input.launcherPlan,
      promoted: input.promoted,
      partial: true
    });
    return [];
  } catch (error) {
    // Keep journal as the measured-progress truth; never invent zeros in the result.
    return [{
      code: "finalize.record_correction_failed",
      message: errorMessage(error),
      path: input.recordPaths.durable
    }];
  }
}

/**
 * Restore a prior completion-record snapshot, or remove a provisional record when none existed.
 * `containWithin` must be the trusted boundary root (projectRoot for source records;
 * projectsHome or an explicit promotion destination root for durable records). Never use
 * the target parent alone: a substituted projectsHome symlink would pass parent-local checks.
 * Propagates all failures except ENOENT on delete so callers can keep the journal and
 * surface finalize.record_restore_failed.
 */
export async function restoreRecordText(
  recordPath: string,
  existingRecordText: string | undefined,
  containWithin: string
): Promise<void> {
  const boundary = resolve(containWithin);
  const targetPath = resolve(recordPath);
  if (!isWithin(boundary, targetPath)) {
    throw new FinalizePersistenceError({
      code: "finalize.persist_outside_container",
      message: "finalize path escaped its containment root",
      path: targetPath
    });
  }
  // Boundary root must be a real directory before any mkdir/write/unlink.
  const boundaryBefore = await captureDirectoryIdentity(boundary);

  if (existingRecordText !== undefined) {
    // Contained one-by-one parent create: refuse symlink ancestors with zero external side effects.
    await ensureContainedParentDirs({
      filePath: targetPath,
      containWithin: boundary
    });
    const boundaryAfter = await captureDirectoryIdentity(boundary);
    if (
      boundaryAfter.device !== boundaryBefore.device
      || boundaryAfter.inode !== boundaryBefore.inode
      || boundaryAfter.realPath !== boundaryBefore.realPath
    ) {
      throw new FinalizePersistenceError({
        code: "finalize.persist_container_changed",
        message: "finalize containment root identity changed before completion-record restore",
        path: boundary
      });
    }
    await writeAtomicRegularFile({
      path: targetPath,
      contents: existingRecordText,
      containWithin: boundary
    });
    return;
  }

  const boundaryAfter = await captureDirectoryIdentity(boundary);
  if (
    boundaryAfter.device !== boundaryBefore.device
    || boundaryAfter.inode !== boundaryBefore.inode
    || boundaryAfter.realPath !== boundaryBefore.realPath
  ) {
    throw new FinalizePersistenceError({
      code: "finalize.persist_container_changed",
      message: "finalize containment root identity changed before completion-record delete",
      path: boundary
    });
  }
  await unlinkContainedRegularFile({
    path: targetPath,
    containWithin: boundary
  });
}

export async function assertWritableProjectRecordPath(
  projectRoot: string,
  sourceRecordPath: string,
  durableRecordPath: string
): Promise<Issue | undefined> {
  // Source completion-record must stay inside the current project tree.
  if (!isWithin(projectRoot, sourceRecordPath)) {
    return {
      code: "finalize.record_path_outside_project",
      message: "completion-record path escaped the project directory",
      path: sourceRecordPath
    };
  }
  const sourceParentIssue = await inspectProjectContainedPath(projectRoot, dirname(sourceRecordPath), {
    outsideCode: "finalize.record_path_outside_project",
    symlinkCode: "finalize.record_path_symlink",
    unsafeCode: "finalize.record_path_unsafe",
    requireDirectory: true,
    allowMissing: true
  });
  if (sourceParentIssue) return sourceParentIssue;

  // Promoted durable copies live under the launcher destination root and are validated by the
  // promotion step, not source containment. Same-path writes already passed the source check.
  void durableRecordPath;
  return undefined;
}

/**
 * Read a completion-record only when the path stays inside projectRoot as a regular file
 * with no symlink ancestors. Uses contained no-follow open so ancestor/leaf symlinks never
 * contribute external content to journals.
 */
export async function readOptionalRegularFileText(
  path: string,
  codes: {
    outsideCode: string;
    symlinkCode: string;
    unsafeCode: string;
    projectRoot: string;
  }
): Promise<
  | { status: "missing" }
  | { status: "ok"; text: string }
  | { status: "unsafe"; issue: Issue }
> {
  if (!isWithin(codes.projectRoot, path)) {
    return {
      status: "unsafe",
      issue: {
        code: codes.outsideCode,
        message: "completion-record path escaped the project directory",
        path
      }
    };
  }

  const result = await readContainedRegularFileText({
    path,
    containWithin: codes.projectRoot
  });
  if (result.status === "missing") return { status: "missing" };
  if (result.status === "ok") return { status: "ok", text: result.text };

  const mappedCode = mapContainedReadCode(result.code, codes);
  return {
    status: "unsafe",
    issue: {
      code: mappedCode,
      message: result.message,
      path: result.path
    }
  };
}

function mapContainedReadCode(
  code: string,
  codes: { outsideCode: string; symlinkCode: string; unsafeCode: string }
): string {
  if (
    code === "finalize.persist_outside_container"
  ) {
    return codes.outsideCode;
  }
  if (
    code === "finalize.persist_path_symlink"
    || code === "finalize.persist_leaf_symlink"
    || code === "finalize.persist_parent_symlink"
    || code === "finalize.path_symlink"
  ) {
    return codes.symlinkCode;
  }
  return codes.unsafeCode;
}

export type RestoreCompletionRecordOptions = {
  /**
   * Boundary root for durable completion-record restore/delete.
   * Prefer durable projectsHome; an explicit promotion destination root is also accepted.
   * Required when source and durable paths differ and durable restore is not skipped.
   */
  durableContainWithin?: string;
  /**
   * When true, only the source snapshot is restored. Use after a promotion backup has already
   * put the durable tree (and its own audit record) back so a source snapshot cannot overwrite it.
   */
  skipDurableRestore?: boolean;
};

/**
 * Read a durable-home completion-record prior snapshot only when the path stays inside
 * projectsHome as a regular file with no symlink ancestors (no-follow open).
 * Missing / non-regular / symlink-ancestor / leaf-symlink paths yield null (no prior durable audit).
 */
export async function readPriorDurableCompletionRecordText(
  durablePath: string,
  projectsHome: string
): Promise<string | null> {
  const result = await readContainedRegularFileText({
    path: durablePath,
    containWithin: projectsHome
  });
  if (result.status === "ok") return result.text;
  return null;
}

export async function restoreCompletionRecordFromJournal(
  projectRoot: string,
  runDir: string,
  journal: FinalizeJournal,
  recordPaths?: CompletionRecordPaths,
  options?: RestoreCompletionRecordOptions
): Promise<Issue[]> {
  const issues: Issue[] = [];
  const sourceRecordPath = recordPaths?.source ?? join(runDir, "completion-record.json");
  // Only restore source when the journal recorded a known prior snapshot. Legacy journals
  // without the field keep the on-disk source record untouched rather than guessing.
  if (journal.previous_completion_record !== undefined) {
    try {
      await restoreRecordText(
        sourceRecordPath,
        journal.previous_completion_record === null
          ? undefined
          : journal.previous_completion_record,
        projectRoot
      );
    } catch (error) {
      issues.push({
        code: "finalize.record_restore_failed",
        message: errorMessage(error),
        path: sourceRecordPath
      });
    }
  }

  if (!recordPaths || resolve(recordPaths.source) === resolve(recordPaths.durable)) {
    return issues;
  }
  if (options?.skipDurableRestore) {
    // Promotion backup already restored the durable tree; never re-apply a source snapshot.
    return issues;
  }

  // Durable side uses its own snapshot. Legacy journals that only have
  // previous_completion_record are ambiguous for the durable boundary: keep the
  // existing durable file (fail-closed) instead of overwriting with the source text.
  if (journal.previous_durable_completion_record === undefined) {
    return issues;
  }

  const durableBoundary = options?.durableContainWithin;
  if (!durableBoundary) {
    issues.push({
      code: "finalize.record_restore_failed",
      message: "durable completion-record restore requires projectsHome or destination root boundary",
      path: recordPaths.durable
    });
    return issues;
  }
  try {
    await restoreRecordText(
      recordPaths.durable,
      journal.previous_durable_completion_record === null
        ? undefined
        : journal.previous_durable_completion_record,
      durableBoundary
    );
  } catch (error) {
    issues.push({
      code: "finalize.record_restore_failed",
      message: errorMessage(error),
      path: recordPaths.durable
    });
  }
  return issues;
}
