import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Issue } from "../types.js";
import {
  captureDirectoryIdentity,
  hasSymlinkAlongPath,
  isWithinPath,
  sameDirectoryIdentity,
  type DirectoryIdentity
} from "./finalizePersistence.js";

export type FinalizeStateDirIdentity = DirectoryIdentity;
export type FinalizeRunDirIdentity = DirectoryIdentity;

/** Pinned project-local finalize directories captured at preflight / apply start. */
export type FinalizePinnedDirs = {
  projectRoot: string;
  stateDir: string;
  runDir: string;
  stateDirIdentity: FinalizeStateDirIdentity;
  /** Present once runDir exists as a real directory. */
  runDirIdentity?: FinalizeRunDirIdentity;
};

export type InspectPathCodes = {
  outsideCode: string;
  symlinkCode: string;
  unsafeCode: string;
  requireDirectory: boolean;
  allowMissing?: boolean;
};

/**
 * Validate that the requested stateDir equals the project dist_dir root, is a real
 * directory under the project, and has no symlink ancestors.
 */
export async function inspectApprovedStateDir(
  projectRoot: string,
  allowedStateDir: string,
  requestedStateDir: string
): Promise<Issue | undefined> {
  if (requestedStateDir !== allowedStateDir) {
    return {
      code: "finalize.state_dir_unapproved",
      message: "finalize stateDir must be the project dist_dir state root only",
      path: requestedStateDir
    };
  }
  if (allowedStateDir === projectRoot) {
    return {
      code: "finalize.state_dir_unsafe",
      message: "finalize cannot use the whole project directory as its state cleanup root",
      path: allowedStateDir
    };
  }
  if (!isWithinPath(projectRoot, allowedStateDir)) {
    return {
      code: "finalize.state_dir_outside_project",
      message: "finalize requires the state directory to stay inside the project directory",
      path: allowedStateDir
    };
  }

  try {
    if (await hasSymlinkAlongPath(projectRoot, allowedStateDir)) {
      return {
        code: "finalize.state_dir_symlink",
        message: "finalize stateDir must not be a symbolic link or have a symbolic-link ancestor",
        path: allowedStateDir
      };
    }
    const stats = await lstat(allowedStateDir);
    if (stats.isSymbolicLink()) {
      return {
        code: "finalize.state_dir_symlink",
        message: "finalize stateDir must not be a symbolic link or have a symbolic-link ancestor",
        path: allowedStateDir
      };
    }
    if (!stats.isDirectory()) {
      return {
        code: "finalize.state_dir_unsafe",
        message: "finalize stateDir must be a real directory under the project",
        path: allowedStateDir
      };
    }
    const [realProjectRoot, realStateDir] = await Promise.all([
      realpath(projectRoot),
      realpath(allowedStateDir)
    ]);
    if (!isWithinPath(realProjectRoot, realStateDir)) {
      return {
        code: "finalize.state_dir_outside_project",
        message: "finalize stateDir realpath escaped the project directory",
        path: allowedStateDir
      };
    }
  } catch (error) {
    return {
      code: "finalize.state_dir_unsafe",
      message: error instanceof Error
        ? `finalize stateDir is not a usable dedicated state root: ${error.message}`
        : "finalize stateDir is not a usable dedicated state root",
      path: allowedStateDir
    };
  }
  return undefined;
}

/**
 * Capture canonical stateDir identity for lock-time revalidation.
 * Call only after inspectApprovedStateDir succeeds.
 */
export async function captureApprovedStateDirIdentity(
  stateDir: string
): Promise<FinalizeStateDirIdentity> {
  return captureDirectoryIdentity(stateDir);
}

/**
 * Capture runDir identity when it exists as a real non-symlink directory.
 * Returns undefined when missing (allowed before lock mkdir).
 */
export async function captureOptionalRunDirIdentity(
  runDir: string
): Promise<FinalizeRunDirIdentity | undefined> {
  try {
    return await captureDirectoryIdentity(runDir);
  } catch {
    return undefined;
  }
}

/**
 * Capture pinned stateDir (+ optional runDir) identities after path inspection succeeds.
 */
export async function captureFinalizePinnedDirs(input: {
  projectRoot: string;
  stateDir: string;
  runDir: string;
}): Promise<FinalizePinnedDirs> {
  const stateDirIdentity = await captureApprovedStateDirIdentity(input.stateDir);
  const runDirIdentity = await captureOptionalRunDirIdentity(input.runDir);
  return {
    projectRoot: resolve(input.projectRoot),
    stateDir: resolve(input.stateDir),
    runDir: resolve(input.runDir),
    stateDirIdentity,
    runDirIdentity
  };
}

/**
 * Re-verify that stateDir / runDir still refer to the same real directories that
 * were inspected before lock / mutation. Fail closed on swap, symlink, or escape.
 *
 * Call immediately before each destructive finalize operation after lock acquire.
 */
export async function inspectPinnedFinalizeDirs(
  pinned: FinalizePinnedDirs
): Promise<Issue | undefined> {
  const stateIssue = await inspectPinnedDirectory({
    path: pinned.stateDir,
    expected: pinned.stateDirIdentity,
    projectRoot: pinned.projectRoot,
    changedCode: "finalize.state_dir_changed",
    symlinkCode: "finalize.state_dir_symlink",
    unsafeCode: "finalize.state_dir_unsafe",
    label: "stateDir"
  });
  if (stateIssue) return stateIssue;

  // runDir may appear after lock mkdir; once captured, it must stay fixed.
  let liveRunStats;
  try {
    liveRunStats = await lstat(pinned.runDir);
  } catch (error) {
    if (pinned.runDirIdentity) {
      return {
        code: "finalize.run_dir_changed",
        message: error instanceof Error
          ? `finalize runDir is no longer usable: ${error.message}`
          : "finalize runDir is no longer usable",
        path: pinned.runDir
      };
    }
    // Still missing and never pinned: OK (rare mid-apply).
    return undefined;
  }

  if (liveRunStats.isSymbolicLink()) {
    return {
      code: "finalize.run_dir_symlink",
      message: "finalize runDir must not be a symbolic link",
      path: pinned.runDir
    };
  }
  if (!liveRunStats.isDirectory()) {
    return {
      code: "finalize.run_dir_unsafe",
      message: "finalize runDir must be a real directory",
      path: pinned.runDir
    };
  }

  if (await hasSymlinkAlongPath(pinned.projectRoot, pinned.runDir)) {
    return {
      code: "finalize.run_dir_symlink",
      message: "finalize runDir must not have a symbolic-link ancestor",
      path: pinned.runDir
    };
  }

  try {
    const live = await captureDirectoryIdentity(pinned.runDir);
    if (pinned.runDirIdentity) {
      if (!sameDirectoryIdentity(pinned.runDirIdentity, live)) {
        return {
          code: "finalize.run_dir_changed",
          message: "finalize runDir identity changed after preflight",
          path: pinned.runDir
        };
      }
    } else {
      // First observation after create: pin for subsequent checks.
      pinned.runDirIdentity = live;
    }
  } catch (error) {
    return {
      code: "finalize.run_dir_unsafe",
      message: error instanceof Error
        ? `finalize runDir identity could not be revalidated: ${error.message}`
        : "finalize runDir identity could not be revalidated",
      path: pinned.runDir
    };
  }

  return undefined;
}

async function inspectPinnedDirectory(input: {
  path: string;
  expected: DirectoryIdentity;
  projectRoot: string;
  changedCode: string;
  symlinkCode: string;
  unsafeCode: string;
  label: string;
}): Promise<Issue | undefined> {
  if (resolve(input.path) !== resolve(input.expected.path)) {
    return {
      code: input.changedCode,
      message: `finalize ${input.label} path no longer matches the inspected path`,
      path: input.path
    };
  }

  try {
    const stats = await lstat(input.path);
    if (stats.isSymbolicLink()) {
      return {
        code: input.symlinkCode,
        message: `finalize ${input.label} must not be a symbolic link`,
        path: input.path
      };
    }
    if (!stats.isDirectory()) {
      return {
        code: input.unsafeCode,
        message: `finalize ${input.label} must be a real directory`,
        path: input.path
      };
    }
    if (await hasSymlinkAlongPath(input.projectRoot, input.path)) {
      return {
        code: input.symlinkCode,
        message: `finalize ${input.label} must not have a symbolic-link ancestor`,
        path: input.path
      };
    }
    const live = await captureDirectoryIdentity(input.path);
    if (!sameDirectoryIdentity(input.expected, live)) {
      return {
        code: input.changedCode,
        message: `finalize ${input.label} identity changed after preflight`,
        path: input.path
      };
    }
    const [realProjectRoot, realPath] = await Promise.all([
      realpath(input.projectRoot),
      realpath(input.path)
    ]);
    if (!isWithinPath(realProjectRoot, realPath)) {
      return {
        code: input.changedCode,
        message: `finalize ${input.label} realpath escaped the project directory`,
        path: input.path
      };
    }
    if (live.realPath !== input.expected.realPath) {
      return {
        code: input.changedCode,
        message: `finalize ${input.label} realpath changed after preflight`,
        path: input.path
      };
    }
  } catch (error) {
    return {
      code: input.changedCode,
      message: error instanceof Error
        ? `finalize ${input.label} is no longer usable: ${error.message}`
        : `finalize ${input.label} is no longer usable`,
      path: input.path
    };
  }
  return undefined;
}

export async function inspectProjectContainedPath(
  projectRoot: string,
  targetPath: string,
  codes: InspectPathCodes
): Promise<Issue | undefined> {
  if (!isWithinPath(projectRoot, targetPath)) {
    return {
      code: codes.outsideCode,
      message: "path must stay inside the project directory",
      path: targetPath
    };
  }
  try {
    let stats;
    try {
      stats = await lstat(targetPath);
    } catch (error) {
      if (codes.allowMissing && isNodeError(error, "ENOENT")) {
        const parent = dirname(targetPath);
        if (parent === targetPath) return undefined;
        return inspectProjectContainedPath(projectRoot, parent, {
          ...codes,
          requireDirectory: true,
          allowMissing: false
        });
      }
      throw error;
    }
    if (await hasSymlinkAlongPath(projectRoot, targetPath)) {
      return {
        code: codes.symlinkCode,
        message: "path must not be a symbolic link or have a symbolic-link ancestor",
        path: targetPath
      };
    }
    if (stats.isSymbolicLink()) {
      return {
        code: codes.symlinkCode,
        message: "path must not be a symbolic link or have a symbolic-link ancestor",
        path: targetPath
      };
    }
    if (codes.requireDirectory && !stats.isDirectory()) {
      return {
        code: codes.unsafeCode,
        message: "path must be a real directory under the project",
        path: targetPath
      };
    }
    if (!codes.requireDirectory && !stats.isFile()) {
      return {
        code: codes.unsafeCode,
        message: "path must be a regular file under the project",
        path: targetPath
      };
    }
    const [realProjectRoot, realPath] = await Promise.all([
      realpath(projectRoot),
      realpath(targetPath)
    ]);
    if (!isWithinPath(realProjectRoot, realPath)) {
      return {
        code: codes.outsideCode,
        message: "path realpath escaped the project directory",
        path: targetPath
      };
    }
  } catch (error) {
    return {
      code: codes.unsafeCode,
      message: error instanceof Error
        ? `path is not a usable project-local location: ${error.message}`
        : "path is not a usable project-local location",
      path: targetPath
    };
  }
  return undefined;
}

export async function isRegularFile(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

export { hasSymlinkAlongPath, isWithinPath };

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

export function resolveProjectStateDir(projectRoot: string, distDir: string): string {
  return resolve(projectRoot, distDir);
}
