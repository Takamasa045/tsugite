/**
 * runDir/lock-leaf path guards and ownership-safe cleanup for run locks.
 */
import { type Stats } from "node:fs";
import {
  lstat,
  rmdir,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { resolve } from "node:path";
import {
  captureDirectoryIdentity,
  hasSymlinkAlongPath,
  type DirectoryIdentity
} from "./finalizePersistence.js";
import { revalidatePinnedStateDir } from "./stateRunLockIdentity.js";
import {
  RunLockBoundaryError,
  type ExpectedStateDirIdentity
} from "./stateTypes.js";

export async function captureRunDirIdentityForLock(
  runDir: string,
  containWithin: string
): Promise<DirectoryIdentity> {
  try {
    const identity = await captureDirectoryIdentity(runDir);
    if (await hasSymlinkAlongPath(containWithin, runDir)) {
      throw new RunLockBoundaryError({
        code: "finalize.run_dir_symlink",
        message: "finalize runDir path contains a symbolic-link ancestor at lock acquire",
        path: runDir
      });
    }
    return identity;
  } catch (error) {
    if (error instanceof RunLockBoundaryError) throw error;
    throw new RunLockBoundaryError({
      code: "finalize.run_dir_unsafe",
      message: error instanceof Error
        ? `finalize runDir identity could not be captured: ${error.message}`
        : "finalize runDir identity could not be captured",
      path: runDir
    });
  }
}

export async function assertPostLockIdentities(input: {
  stateDirHandle: FileHandle;
  distDir: string;
  expectedStateDir: ExpectedStateDirIdentity;
  runDir: string;
  runDirIdentity: DirectoryIdentity;
  lockPath: string;
  lockHandle: FileHandle;
  containWithin?: string;
}): Promise<void> {
  await revalidatePinnedStateDir(
    input.stateDirHandle,
    input.distDir,
    input.expectedStateDir,
    input.containWithin
  );

  let liveRunDir: DirectoryIdentity;
  try {
    liveRunDir = await captureDirectoryIdentity(input.runDir);
  } catch (error) {
    throw new RunLockBoundaryError({
      code: "finalize.run_dir_changed",
      message: error instanceof Error
        ? `finalize runDir identity changed after lock create: ${error.message}`
        : "finalize runDir identity changed after lock create",
      path: input.runDir
    });
  }
  if (
    liveRunDir.device !== input.runDirIdentity.device
    || liveRunDir.inode !== input.runDirIdentity.inode
    || liveRunDir.realPath !== input.runDirIdentity.realPath
  ) {
    throw new RunLockBoundaryError({
      code: "finalize.run_dir_changed",
      message: "finalize runDir identity changed after lock create",
      path: input.runDir
    });
  }

  const container = input.containWithin ? resolve(input.containWithin) : input.distDir;
  if (await hasSymlinkAlongPath(container, input.runDir)) {
    throw new RunLockBoundaryError({
      code: "finalize.run_dir_symlink",
      message: "finalize runDir path contains a symbolic-link ancestor after lock create",
      path: input.runDir
    });
  }

  let lockHandleStats: Stats;
  try {
    lockHandleStats = await input.lockHandle.stat();
  } catch (error) {
    throw new RunLockBoundaryError({
      code: "finalize.lock_changed",
      message: error instanceof Error
        ? `finalize lock handle became unusable: ${error.message}`
        : "finalize lock handle became unusable",
      path: input.lockPath
    });
  }
  if (!lockHandleStats.isFile() || lockHandleStats.isSymbolicLink()) {
    throw new RunLockBoundaryError({
      code: "finalize.lock_unsafe",
      message: "finalize run lock must be a regular file",
      path: input.lockPath
    });
  }

  let lockPathStats: Stats;
  try {
    lockPathStats = await lstat(input.lockPath);
  } catch (error) {
    throw new RunLockBoundaryError({
      code: "finalize.lock_changed",
      message: error instanceof Error
        ? `finalize lock path is no longer usable: ${error.message}`
        : "finalize lock path is no longer usable",
      path: input.lockPath
    });
  }
  if (lockPathStats.isSymbolicLink()) {
    throw new RunLockBoundaryError({
      code: "finalize.state_dir_symlink",
      message: "finalize run lock leaf must not be a symbolic link",
      path: input.lockPath
    });
  }
  if (
    lockPathStats.dev !== lockHandleStats.dev
    || lockPathStats.ino !== lockHandleStats.ino
  ) {
    throw new RunLockBoundaryError({
      code: "finalize.lock_changed",
      message: "finalize run lock path no longer refers to the created lock file",
      path: input.lockPath
    });
  }
}

/**
 * Unlink a just-created lock only when path still points at the same runDir and
 * the same lock inode we created. Avoids deleting a lock under a replaced ancestor.
 */
export async function safeUnlinkCreatedLock(
  lockPath: string,
  runDir: string,
  expectedRunDir: DirectoryIdentity,
  createdLock: { device: number; inode: number }
): Promise<void> {
  try {
    const runLive = await captureDirectoryIdentity(runDir);
    if (
      runLive.device !== expectedRunDir.device
      || runLive.inode !== expectedRunDir.inode
      || runLive.realPath !== expectedRunDir.realPath
    ) {
      return;
    }
    const lockStats = await lstat(lockPath);
    if (lockStats.isSymbolicLink()) return;
    if (lockStats.dev !== createdLock.device || lockStats.ino !== createdLock.inode) return;
    await unlink(lockPath);
  } catch {
    // Best-effort cleanup only; prefer leaving an orphan lock over external damage.
  }
}

export async function safeRmdirRunDirIfOwned(
  runDir: string,
  expectedRunDir: DirectoryIdentity
): Promise<void> {
  try {
    const runLive = await captureDirectoryIdentity(runDir);
    if (
      runLive.device !== expectedRunDir.device
      || runLive.inode !== expectedRunDir.inode
      || runLive.realPath !== expectedRunDir.realPath
    ) {
      return;
    }
    await rmdir(runDir);
  } catch {
    // ignore non-empty or replaced runDir
  }
}

export async function assertLockLeafSafe(
  runDir: string,
  lockPath: string,
  containWithin: string
): Promise<void> {
  // runDir may be missing (mkdir just created it) or exist; refuse symlink leaves.
  try {
    const runStats = await lstat(runDir);
    if (runStats.isSymbolicLink()) {
      throw new RunLockBoundaryError({
        code: "finalize.run_dir_symlink",
        message: "finalize runDir must not be a symbolic link at lock acquire",
        path: runDir
      });
    }
  } catch (error) {
    if (error instanceof RunLockBoundaryError) throw error;
    // ENOENT is fine before mkdir; after mkdir it should exist.
  }

  if (await hasSymlinkAlongPath(containWithin, runDir).catch(() => true)) {
    // If runDir is brand new under a swapped stateDir, containment already failed above.
    // Re-check only when path is fully present under containWithin.
    try {
      await lstat(runDir);
      if (await hasSymlinkAlongPath(containWithin, runDir)) {
        throw new RunLockBoundaryError({
          code: "finalize.run_dir_symlink",
          message: "finalize runDir path contains a symbolic-link ancestor at lock acquire",
          path: runDir
        });
      }
    } catch (error) {
      if (error instanceof RunLockBoundaryError) throw error;
    }
  }

  try {
    const lockStats = await lstat(lockPath);
    if (lockStats.isSymbolicLink()) {
      throw new RunLockBoundaryError({
        code: "finalize.state_dir_symlink",
        message: "finalize run lock leaf must not be a symbolic link",
        path: lockPath
      });
    }
  } catch (error) {
    if (error instanceof RunLockBoundaryError) throw error;
    // Missing lock leaf is the normal create path.
  }
}
