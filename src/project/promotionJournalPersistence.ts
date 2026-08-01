import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parsePromotionJournalSchema } from "./promotionJournalIdentity.js";
import {
  hasSymlinkAlongPath,
  inspectContainedPath,
  inspectPromotionJournalPaths,
  isWithinDirectory
} from "./promotionJournalPathSafety.js";
import {
  PromotionJournalError,
  errorMessage,
  isNodeError,
  promotionJournalDir,
  promotionJournalPath,
  type PromotionJournal,
  type PromotionJournalLoadResult
} from "./promotionJournalShared.js";

export async function loadPromotionJournal(
  projectsHome: string,
  destinationRoot: string
): Promise<PromotionJournalLoadResult> {
  const journalPath = promotionJournalPath(projectsHome, destinationRoot);
  return loadPromotionJournalAt(journalPath, projectsHome);
}

export async function loadPromotionJournalAt(
  journalPath: string,
  projectsHome: string
): Promise<PromotionJournalLoadResult> {
  let rawText: string;
  try {
    rawText = await readFile(journalPath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { status: "missing" };
    return {
      status: "invalid",
      issues: [{
        code: "promotion.journal_invalid",
        message: errorMessage(error, "promotion journal could not be read"),
        path: journalPath
      }]
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (error) {
    return {
      status: "invalid",
      issues: [{
        code: "promotion.journal_invalid",
        message: errorMessage(error, "promotion journal is not valid JSON"),
        path: journalPath
      }]
    };
  }

  const parsed = parsePromotionJournalSchema(raw, journalPath);
  if (!parsed.ok) return { status: "invalid", issues: parsed.issues };

  const safety = await inspectPromotionJournalPaths(parsed.journal, projectsHome, journalPath);
  if (safety) return { status: "invalid", issues: [safety] };

  return { status: "ok", journal: parsed.journal, journalPath };
}

export async function writePromotionJournal(input: {
  projectsHome: string;
  journal: PromotionJournal;
}): Promise<PromotionJournal> {
  const projectsHome = resolve(input.projectsHome);
  const journalPath = promotionJournalPath(projectsHome, input.journal.destination_root);
  const journal: PromotionJournal = {
    ...input.journal,
    projects_home: projectsHome,
    destination_root: resolve(input.journal.destination_root),
    backup_path: input.journal.backup_path == null
      ? null
      : resolve(input.journal.backup_path),
    staging_path: input.journal.staging_path == null
      ? null
      : resolve(input.journal.staging_path),
    updated_at: input.journal.updated_at
  };

  const safety = await inspectPromotionJournalPaths(journal, projectsHome, journalPath);
  if (safety) {
    throw new PromotionJournalError(safety);
  }

  await mkdir(promotionJournalDir(projectsHome), { recursive: true });
  // Re-check journal dir after create: refuse symlink journal roots.
  const journalDirIssue = await inspectContainedPath({
    root: projectsHome,
    targetPath: promotionJournalDir(projectsHome),
    requireDirectory: true,
    allowMissing: false,
    allowLeafSymlink: false,
    label: "journal_dir"
  });
  if (journalDirIssue) throw new PromotionJournalError(journalDirIssue);

  await writeAtomicRegularFile({
    path: journalPath,
    contents: `${JSON.stringify(journal, null, 2)}\n`,
    containWithin: projectsHome
  });
  return journal;
}

export async function clearPromotionJournal(
  projectsHome: string,
  destinationRoot: string
): Promise<void> {
  const journalPath = promotionJournalPath(projectsHome, destinationRoot);
  const projectsHomeResolved = resolve(projectsHome);
  if (!isWithinDirectory(projectsHomeResolved, journalPath)) {
    throw new PromotionJournalError({
      code: "promotion.journal_path_unsafe",
      message: "refusing to clear promotion journal outside projects home",
      path: journalPath
    });
  }
  if (await hasSymlinkAlongPath(projectsHomeResolved, journalPath)) {
    throw new PromotionJournalError({
      code: "promotion.journal_path_unsafe",
      message: "refusing to clear promotion journal through a symbolic-link ancestor",
      path: journalPath
    });
  }
  try {
    const stats = await lstat(journalPath);
    if (stats.isSymbolicLink()) {
      throw new PromotionJournalError({
        code: "promotion.journal_path_unsafe",
        message: "refusing to follow a leaf symbolic link when clearing promotion journal",
        path: journalPath
      });
    }
    if (!stats.isFile()) {
      throw new PromotionJournalError({
        code: "promotion.journal_path_unsafe",
        message: "promotion journal path is not a regular file",
        path: journalPath
      });
    }
    await unlink(journalPath);
  } catch (error) {
    if (error instanceof PromotionJournalError) throw error;
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
}

/**
 * Atomic regular-file write: O_EXCL temp, fsync, rename, refuse leaf symlink.
 * Containment root is the durable projects home (not a finalize stateDir).
 */
async function writeAtomicRegularFile(input: {
  path: string;
  contents: string;
  containWithin: string;
}): Promise<void> {
  const targetPath = resolve(input.path);
  const parentPath = dirname(targetPath);
  const container = resolve(input.containWithin);
  const nofollow = constants.O_NOFOLLOW ?? 0;

  if (!isWithinDirectory(container, targetPath) || !isWithinDirectory(container, parentPath)) {
    throw new PromotionJournalError({
      code: "promotion.journal_path_unsafe",
      message: "promotion journal write escaped projects home",
      path: targetPath
    });
  }
  if (await hasSymlinkAlongPath(container, parentPath)) {
    throw new PromotionJournalError({
      code: "promotion.journal_path_unsafe",
      message: "promotion journal parent path contains a symbolic-link ancestor",
      path: parentPath
    });
  }

  try {
    const leaf = await lstat(targetPath);
    if (leaf.isSymbolicLink()) {
      throw new PromotionJournalError({
        code: "promotion.journal_path_unsafe",
        message: "refusing to follow or replace a leaf symbolic link for promotion journal",
        path: targetPath
      });
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT") && !(error instanceof PromotionJournalError)) throw error;
    if (error instanceof PromotionJournalError) throw error;
  }

  const temporaryName = `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`;
  const temporaryPath = join(parentPath, temporaryName);
  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow,
      0o600
    );
    await handle.writeFile(input.contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (await hasSymlinkAlongPath(container, parentPath)) {
      throw new PromotionJournalError({
        code: "promotion.journal_path_unsafe",
        message: "promotion journal parent path changed to include a symbolic link before rename",
        path: parentPath
      });
    }
    try {
      const leafAfter = await lstat(targetPath);
      if (leafAfter.isSymbolicLink()) {
        throw new PromotionJournalError({
          code: "promotion.journal_path_unsafe",
          message: "refusing to replace a leaf symbolic link for promotion journal",
          path: targetPath
        });
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT") && !(error instanceof PromotionJournalError)) throw error;
      if (error instanceof PromotionJournalError) throw error;
    }

    await rename(temporaryPath, targetPath);
    await fsyncDirectory(parentPath);
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // preserve original error
    }
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directoryPath, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
