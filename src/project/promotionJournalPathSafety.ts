import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Issue } from "../types.js";
import { inspectPromotionIdentityBinding } from "./promotionJournalIdentity.js";
import {
  PROMOTION_BACKUP_PREFIX,
  PROMOTION_STAGING_PREFIX,
  isNodeError,
  type PromotionJournal
} from "./promotionJournalShared.js";

/**
 * Fail-closed path checks: projectsHome containment, no symlink ancestors,
 * realpath stays inside the durable projects home for real directories/files.
 * Destination leaf symlinks are allowed only while phase=switching (pre-production
 * shelf link still at the destination before dest→backup rename). Journal files,
 * staging, and non-switching destinations refuse leaf symlinks. Never mutates here.
 */
export async function inspectPromotionJournalPaths(
  journal: PromotionJournal,
  expectedProjectsHome: string,
  journalPath: string
): Promise<Issue | undefined> {
  const projectsHome = resolve(expectedProjectsHome);
  const journalProjectsHome = resolve(journal.projects_home);
  if (journalProjectsHome !== projectsHome) {
    return {
      code: "promotion.journal_path_unsafe",
      message: "promotion journal projects_home does not match the active durable projects home",
      path: journal.projects_home
    };
  }

  if (!isAbsolute(journal.destination_root) || !isAbsolute(journalPath)) {
    return {
      code: "promotion.journal_path_unsafe",
      message: "promotion journal paths must be absolute",
      path: journal.destination_root
    };
  }

  const destinationRoot = resolve(journal.destination_root);
  if (!isStrictProjectChild(projectsHome, destinationRoot)) {
    return {
      code: "promotion.journal_path_unsafe",
      message: "promotion journal destination_root must be a direct child of projects home",
      path: destinationRoot
    };
  }

  // Pre-production shelf registration places a directory symlink at the destination
  // until the first dest→backup rename. The write-ahead switching journal must accept
  // that leaf link without following it (no realpath escape). Later phases require a
  // real directory or missing path — open/committed never keep a symlink destination.
  // Ancestors, journal files, and staging stay closed to leaf/ancestor symlink escapes.
  const destinationBoundary = await inspectContainedPath({
    root: projectsHome,
    targetPath: destinationRoot,
    requireDirectory: true,
    allowMissing: true,
    allowLeafSymlink: journal.phase === "switching",
    label: "destination_root"
  });
  if (destinationBoundary) return destinationBoundary;

  const journalFileBoundary = await inspectContainedPath({
    root: projectsHome,
    targetPath: resolve(journalPath),
    requireDirectory: false,
    allowMissing: true,
    allowLeafSymlink: false,
    label: "journal"
  });
  if (journalFileBoundary) return journalFileBoundary;

  if (journal.backup_path !== null) {
    if (!isAbsolute(journal.backup_path)) {
      return {
        code: "promotion.journal_path_unsafe",
        message: "promotion journal backup_path must be absolute",
        path: journal.backup_path
      };
    }
    const backupPath = resolve(journal.backup_path);
    if (!isWithinDirectory(projectsHome, backupPath) || resolve(backupPath) === projectsHome) {
      return {
        code: "promotion.journal_path_unsafe",
        message: "promotion journal backup_path must stay inside projects home",
        path: backupPath
      };
    }
    if (dirname(backupPath) !== projectsHome) {
      return {
        code: "promotion.journal_path_unsafe",
        message: "promotion journal backup_path must be a direct child of projects home",
        path: backupPath
      };
    }
    if (!basename(backupPath).startsWith(PROMOTION_BACKUP_PREFIX)) {
      return {
        code: "promotion.journal_path_unsafe",
        message: "promotion journal backup_path must use the promote-backup prefix",
        path: backupPath
      };
    }
    if (backupPath === destinationRoot) {
      return {
        code: "promotion.journal_path_unsafe",
        message: "promotion journal backup_path must differ from destination_root",
        path: backupPath
      };
    }
    // Backup may be a real prior project tree or a pre-production shelf symlink
    // that was renamed aside during the switch. The link node must stay under
    // projectsHome; its target may legitimately point at a worktree outside.
    const backupBoundary = await inspectContainedPath({
      root: projectsHome,
      targetPath: backupPath,
      requireDirectory: true,
      allowMissing: true,
      allowLeafSymlink: true,
      label: "backup_path"
    });
    if (backupBoundary) return backupBoundary;
  }

  if (journal.staging_path !== null) {
    if (!isAbsolute(journal.staging_path)) {
      return {
        code: "promotion.journal_path_unsafe",
        message: "promotion journal staging_path must be absolute",
        path: journal.staging_path
      };
    }
    const stagingPath = resolve(journal.staging_path);
    if (!isWithinDirectory(projectsHome, stagingPath) || stagingPath === projectsHome) {
      return {
        code: "promotion.journal_path_unsafe",
        message: "promotion journal staging_path must stay inside projects home",
        path: stagingPath
      };
    }
    if (dirname(stagingPath) !== projectsHome) {
      return {
        code: "promotion.journal_path_unsafe",
        message: "promotion journal staging_path must be a direct child of projects home",
        path: stagingPath
      };
    }
    if (!basename(stagingPath).startsWith(PROMOTION_STAGING_PREFIX)) {
      return {
        code: "promotion.journal_path_unsafe",
        message: "promotion journal staging_path must use the promote staging prefix",
        path: stagingPath
      };
    }
    if (stagingPath === destinationRoot) {
      return {
        code: "promotion.journal_path_unsafe",
        message: "promotion journal staging_path must differ from destination_root",
        path: stagingPath
      };
    }
    if (journal.backup_path !== null && stagingPath === resolve(journal.backup_path)) {
      return {
        code: "promotion.journal_path_unsafe",
        message: "promotion journal staging_path must differ from backup_path",
        path: stagingPath
      };
    }
    const stagingBoundary = await inspectContainedPath({
      root: projectsHome,
      targetPath: stagingPath,
      requireDirectory: true,
      allowMissing: true,
      allowLeafSymlink: false,
      label: "staging_path"
    });
    if (stagingBoundary) return stagingBoundary;
  }

  // Destination slug + optional transaction_id must bind journal file, backup, and staging.
  // Fail closed before any recovery rename/rm/clear (including cross-job prefix attacks).
  const identity = inspectPromotionIdentityBinding(journal, journalPath);
  if (identity) return identity;

  return undefined;
}

function isStrictProjectChild(projectsHome: string, destinationRoot: string): boolean {
  const home = resolve(projectsHome);
  const dest = resolve(destinationRoot);
  if (dest === home) return false;
  if (dirname(dest) !== home) return false;
  return isWithinDirectory(home, dest);
}

export function isWithinDirectory(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return relativePath === ""
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

/** True when any path component from root through the leaf is a symlink. */
export async function hasSymlinkAlongPath(root: string, candidate: string): Promise<boolean> {
  if (await hasSymlinkAncestor(root, candidate)) return true;
  try {
    return (await lstat(resolve(candidate))).isSymbolicLink();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    return true;
  }
}

/** True when a strict ancestor under root (not the leaf) is a symlink. */
export async function hasSymlinkAncestor(root: string, candidate: string): Promise<boolean> {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const relativePath = relative(resolvedRoot, resolvedCandidate);
  if (
    relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    return true;
  }
  let current = resolvedRoot;
  try {
    if ((await lstat(current)).isSymbolicLink()) return true;
  } catch {
    return true;
  }
  const parts = relativePath.split(sep).filter(Boolean);
  // Walk intermediate segments only; leaf is checked separately.
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = join(current, parts[index]!);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      return true;
    }
  }
  return false;
}

export async function inspectContainedPath(input: {
  root: string;
  targetPath: string;
  requireDirectory: boolean;
  allowMissing: boolean;
  allowLeafSymlink: boolean;
  label: string;
}): Promise<Issue | undefined> {
  const root = resolve(input.root);
  const targetPath = resolve(input.targetPath);
  if (!isWithinDirectory(root, targetPath)) {
    return {
      code: "promotion.journal_path_unsafe",
      message: `promotion ${input.label} must stay inside projects home`,
      path: targetPath
    };
  }

  try {
    // Intermediate symlink ancestors are always refused. Leaf symlinks are allowed
    // only when explicitly opted in (promotion backup of a shelf directory link).
    if (await hasSymlinkAncestor(root, targetPath)) {
      return {
        code: "promotion.journal_path_unsafe",
        message: `promotion ${input.label} path contains a symbolic-link ancestor`,
        path: targetPath
      };
    }

    let stats;
    try {
      stats = await lstat(targetPath);
    } catch (error) {
      if (input.allowMissing && isNodeError(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }

    if (stats.isSymbolicLink()) {
      if (!input.allowLeafSymlink) {
        return {
          code: "promotion.journal_path_unsafe",
          message: `promotion ${input.label} must not be a symbolic link`,
          path: targetPath
        };
      }
      // Do not realpath leaf symlinks: shelf backups may point outside projects home.
      return undefined;
    } else if (input.requireDirectory && !stats.isDirectory()) {
      return {
        code: "promotion.journal_path_unsafe",
        message: `promotion ${input.label} must be a real directory`,
        path: targetPath
      };
    } else if (!input.requireDirectory && !stats.isFile()) {
      return {
        code: "promotion.journal_path_unsafe",
        message: `promotion ${input.label} must be a regular file`,
        path: targetPath
      };
    }

    const [realRoot, realTarget] = await Promise.all([
      realpath(root),
      realpath(targetPath)
    ]);
    if (!isWithinDirectory(realRoot, realTarget)) {
      return {
        code: "promotion.journal_path_unsafe",
        message: `promotion ${input.label} realpath escaped projects home`,
        path: targetPath
      };
    }
  } catch (error) {
    return {
      code: "promotion.journal_path_unsafe",
      message: error instanceof Error
        ? `promotion ${input.label} could not be validated: ${error.message}`
        : `promotion ${input.label} could not be validated`,
      path: targetPath
    };
  }
  return undefined;
}
