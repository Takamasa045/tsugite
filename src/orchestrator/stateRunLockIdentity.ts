/**
 * stateDir identity pin and revalidation for run-lock acquire.
 */
import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  realpath,
  type FileHandle
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  assertDirectoryIdentity,
  hasSymlinkAlongPath
} from "./finalizePersistence.js";
import {
  RunLockBoundaryError,
  type ExpectedStateDirIdentity
} from "./stateTypes.js";

export async function openStateDirHandle(
  distDir: string,
  expected: ExpectedStateDirIdentity
): Promise<FileHandle> {
  const flags = constants.O_RDONLY
    | (constants.O_DIRECTORY ?? 0)
    | (constants.O_NOFOLLOW ?? 0);
  let handle: FileHandle;
  try {
    handle = await open(distDir, flags);
  } catch (error) {
    throw new RunLockBoundaryError({
      code: "finalize.state_dir_changed",
      message: error instanceof Error
        ? `finalize stateDir could not be pinned for lock acquire: ${error.message}`
        : "finalize stateDir could not be pinned for lock acquire",
      path: distDir
    });
  }
  try {
    const stats = await handle.stat();
    if (!stats.isDirectory()) {
      throw new RunLockBoundaryError({
        code: "finalize.state_dir_unsafe",
        message: "finalize stateDir must be a real directory at lock acquire",
        path: distDir
      });
    }
    if (
      stats.dev !== expected.device
      || stats.ino !== expected.inode
    ) {
      throw new RunLockBoundaryError({
        code: "finalize.state_dir_changed",
        message: "finalize stateDir identity changed after preflight",
        path: distDir
      });
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Re-check path identity against the pinned directory handle.
 * Detects stateDir path replacement even when the original inode remains open.
 */
export async function revalidatePinnedStateDir(
  stateDirHandle: FileHandle | undefined,
  distDir: string,
  expected: ExpectedStateDirIdentity,
  containWithin?: string
): Promise<void> {
  await assertSafeStateDirForLock(distDir, expected, containWithin);
  if (!stateDirHandle) return;
  let handleStats: Stats;
  try {
    handleStats = await stateDirHandle.stat();
  } catch (error) {
    throw new RunLockBoundaryError({
      code: "finalize.state_dir_changed",
      message: error instanceof Error
        ? `finalize stateDir handle became unusable: ${error.message}`
        : "finalize stateDir handle became unusable",
      path: distDir
    });
  }
  if (
    handleStats.dev !== expected.device
    || handleStats.ino !== expected.inode
  ) {
    throw new RunLockBoundaryError({
      code: "finalize.state_dir_changed",
      message: "finalize stateDir handle identity no longer matches preflight",
      path: distDir
    });
  }
  let pathStats: Stats;
  try {
    pathStats = await lstat(distDir);
  } catch (error) {
    throw new RunLockBoundaryError({
      code: "finalize.state_dir_changed",
      message: error instanceof Error
        ? `finalize stateDir is no longer usable: ${error.message}`
        : "finalize stateDir is no longer usable",
      path: distDir
    });
  }
  if (
    pathStats.isSymbolicLink()
    || !pathStats.isDirectory()
    || pathStats.dev !== handleStats.dev
    || pathStats.ino !== handleStats.ino
  ) {
    throw new RunLockBoundaryError({
      code: "finalize.state_dir_changed",
      message: "finalize stateDir path no longer refers to the pinned directory",
      path: distDir
    });
  }
}

export async function assertSafeStateDirForLock(
  distDir: string,
  expected: ExpectedStateDirIdentity,
  containWithin?: string
): Promise<void> {
  const resolved = resolve(distDir);
  if (resolve(expected.path) !== resolved) {
    throw new RunLockBoundaryError({
      code: "finalize.state_dir_changed",
      message: "finalize stateDir path no longer matches the preflight path",
      path: resolved
    });
  }

  let stats;
  try {
    stats = await lstat(resolved);
  } catch (error) {
    throw new RunLockBoundaryError({
      code: "finalize.state_dir_changed",
      message: error instanceof Error
        ? `finalize stateDir is no longer usable: ${error.message}`
        : "finalize stateDir is no longer usable",
      path: resolved
    });
  }
  if (stats.isSymbolicLink()) {
    throw new RunLockBoundaryError({
      code: "finalize.state_dir_symlink",
      message: "finalize stateDir must not be a symbolic link at lock acquire",
      path: resolved
    });
  }
  if (!stats.isDirectory()) {
    throw new RunLockBoundaryError({
      code: "finalize.state_dir_unsafe",
      message: "finalize stateDir must be a real directory at lock acquire",
      path: resolved
    });
  }

  try {
    await assertDirectoryIdentity(resolved, expected);
  } catch (error) {
    throw new RunLockBoundaryError({
      code: "finalize.state_dir_changed",
      message: error instanceof Error ? error.message : "finalize stateDir identity changed after preflight",
      path: resolved
    });
  }

  const container = containWithin ? resolve(containWithin) : dirname(resolved);
  if (await hasSymlinkAlongPath(container, resolved)) {
    throw new RunLockBoundaryError({
      code: "finalize.state_dir_symlink",
      message: "finalize stateDir path contains a symbolic-link ancestor at lock acquire",
      path: resolved
    });
  }

  // Parent directory of stateDir must also remain a real, non-symlink directory.
  const parent = dirname(resolved);
  try {
    const parentStats = await lstat(parent);
    if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
      throw new RunLockBoundaryError({
        code: "finalize.state_dir_symlink",
        message: "finalize stateDir parent must be a real directory at lock acquire",
        path: parent
      });
    }
  } catch (error) {
    if (error instanceof RunLockBoundaryError) throw error;
    throw new RunLockBoundaryError({
      code: "finalize.state_dir_changed",
      message: "finalize stateDir parent is not usable at lock acquire",
      path: parent
    });
  }

  // realpath must still match the preflight capture.
  try {
    const liveReal = await realpath(resolved);
    if (liveReal !== expected.realPath) {
      throw new RunLockBoundaryError({
        code: "finalize.state_dir_changed",
        message: "finalize stateDir realpath changed after preflight",
        path: resolved
      });
    }
  } catch (error) {
    if (error instanceof RunLockBoundaryError) throw error;
    throw new RunLockBoundaryError({
      code: "finalize.state_dir_changed",
      message: "finalize stateDir realpath could not be revalidated",
      path: resolved
    });
  }
}
