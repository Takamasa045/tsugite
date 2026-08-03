/**
 * Run lock lifecycle: acquire, inherit, release, and stale recovery.
 */
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DirectoryIdentity } from "./finalizePersistence.js";
import { safeIdSchema } from "./statePersistence.js";
import {
  assertSafeStateDirForLock,
  openStateDirHandle,
  revalidatePinnedStateDir
} from "./stateRunLockIdentity.js";
import {
  assertLockLeafSafe,
  assertPostLockIdentities,
  captureRunDirIdentityForLock,
  safeRmdirRunDirIfOwned,
  safeUnlinkCreatedLock
} from "./stateRunLockPathGuard.js";
import {
  RunLockBoundaryError,
  RunLockedError,
  type AcquireRunLockOptions,
  type RunLock
} from "./stateTypes.js";

export async function acquireRunLock(
  distDir: string,
  runId: string,
  inheritedToken?: string,
  options: AcquireRunLockOptions = {}
): Promise<RunLock> {
  const safeRunId = safeIdSchema.parse(runId);
  const resolvedDistDir = resolve(distDir);
  const runDir = join(resolvedDistDir, safeRunId);
  const lockPath = join(runDir, ".mutation.lock");
  const containWithin = options.containWithin ?? resolvedDistDir;
  const expectedStateDir = options.expectedStateDir;
  const hooks = options._testHooks;

  // Close preflight→lock TOCTOU: re-verify stateDir parent/leaf nofollow + identity
  // before any mkdir/write/rename/unlink under distDir.
  let stateDirHandle: FileHandle | undefined;
  let runDirIdentity: DirectoryIdentity | undefined;
  try {
    if (expectedStateDir) {
      await assertSafeStateDirForLock(resolvedDistDir, expectedStateDir, options.containWithin);
      stateDirHandle = await openStateDirHandle(resolvedDistDir, expectedStateDir);
    }

    if (inheritedToken) {
      if (expectedStateDir) {
        await revalidatePinnedStateDir(
          stateDirHandle,
          resolvedDistDir,
          expectedStateDir,
          options.containWithin
        );
        runDirIdentity = await captureRunDirIdentityForLock(runDir, containWithin);
        await assertLockLeafSafe(runDir, lockPath, containWithin);
        if (hooks?.afterIdentityCheckBeforeOpen) {
          await hooks.afterIdentityCheckBeforeOpen();
        }
        await revalidatePinnedStateDir(
          stateDirHandle,
          resolvedDistDir,
          expectedStateDir,
          options.containWithin
        );
        runDirIdentity = await captureRunDirIdentityForLock(runDir, containWithin);
        await assertLockLeafSafe(runDir, lockPath, containWithin);
      }
      let handle: FileHandle | undefined;
      try {
        handle = await open(lockPath, constants.O_RDWR | constants.O_NOFOLLOW);
        if (expectedStateDir && stateDirHandle && runDirIdentity) {
          if (hooks?.afterLockCreatedBeforeValidate) {
            await hooks.afterLockCreatedBeforeValidate();
          }
          await assertPostLockIdentities({
            stateDirHandle,
            distDir: resolvedDistDir,
            expectedStateDir,
            runDir,
            runDirIdentity,
            lockPath,
            lockHandle: handle,
            containWithin: options.containWithin
          });
        }
        const owner = JSON.parse(await handle.readFile("utf8"));
        if (!isRunLockRecord(owner) || !isLockOwner(owner, inheritedToken)) {
          throw new RunLockedError();
        }
        await handle.truncate(0);
        await handle.write(`${JSON.stringify({ ...owner, delegated_pid: process.pid })}\n`, 0, "utf8");
        await handle.sync();
      } catch (error) {
        if (error instanceof RunLockBoundaryError || error instanceof RunLockedError) throw error;
        throw new RunLockedError();
      } finally {
        await handle?.close();
      }
      return { token: inheritedToken, release: async () => undefined };
    }

    const token = randomUUID();

    if (expectedStateDir) {
      await revalidatePinnedStateDir(
        stateDirHandle,
        resolvedDistDir,
        expectedStateDir,
        options.containWithin
      );
    }
    await mkdir(runDir, { recursive: true });
    if (expectedStateDir) {
      // mkdir can follow a swapped stateDir symlink; refuse before opening the lock.
      await revalidatePinnedStateDir(
        stateDirHandle,
        resolvedDistDir,
        expectedStateDir,
        options.containWithin
      );
      runDirIdentity = await captureRunDirIdentityForLock(runDir, containWithin);
      await assertLockLeafSafe(runDir, lockPath, containWithin);
      if (hooks?.afterIdentityCheckBeforeOpen) {
        await hooks.afterIdentityCheckBeforeOpen();
      }
      // Final pre-open revalidation: shrinks the check→open TOCTOU window after hooks
      // and after any concurrent path swap.
      await revalidatePinnedStateDir(
        stateDirHandle,
        resolvedDistDir,
        expectedStateDir,
        options.containWithin
      );
      runDirIdentity = await captureRunDirIdentityForLock(runDir, containWithin);
      await assertLockLeafSafe(runDir, lockPath, containWithin);
    }

    const nofollow = constants.O_NOFOLLOW ?? 0;
    let handle: FileHandle | undefined;
    let createdLockIdentity: { device: number; inode: number } | undefined;
    try {
      try {
        handle = await open(
          lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow,
          0o600
        );
      } catch (error) {
        if (!isAlreadyExists(error) || !await recoverStaleRunLock(lockPath)) {
          if (isAlreadyExists(error)) throw new RunLockedError();
          throw error;
        }
        try {
          handle = await open(
            lockPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow,
            0o600
          );
        } catch (retryError) {
          if (isAlreadyExists(retryError)) throw new RunLockedError();
          throw retryError;
        }
      }

      const lockStats = await handle.stat();
      createdLockIdentity = { device: lockStats.dev, inode: lockStats.ino };

      if (expectedStateDir && stateDirHandle && runDirIdentity) {
        if (hooks?.afterLockCreatedBeforeValidate) {
          await hooks.afterLockCreatedBeforeValidate();
        }
        try {
          await assertPostLockIdentities({
            stateDirHandle,
            distDir: resolvedDistDir,
            expectedStateDir,
            runDir,
            runDirIdentity,
            lockPath,
            lockHandle: handle,
            containWithin: options.containWithin
          });
        } catch (error) {
          await handle.close().catch(() => undefined);
          handle = undefined;
          await safeUnlinkCreatedLock(lockPath, runDir, runDirIdentity, createdLockIdentity);
          throw error;
        }
      }

      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString(), token })}\n`
        );
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        handle = undefined;
        if (expectedStateDir && runDirIdentity && createdLockIdentity) {
          await safeUnlinkCreatedLock(lockPath, runDir, runDirIdentity, createdLockIdentity);
        } else {
          await unlink(lockPath).catch(() => undefined);
        }
        throw error;
      }
      await handle.close();
      handle = undefined;

      const releaseRunDirIdentity = runDirIdentity;
      let released = false;
      return {
        token,
        async release() {
          if (released) return;

          let owner: unknown;
          try {
            owner = JSON.parse(await readFile(lockPath, "utf8"));
          } catch {
            return;
          }
          if (!isLockOwner(owner, token)) return;

          try {
            if (releaseRunDirIdentity && createdLockIdentity) {
              await safeUnlinkCreatedLock(lockPath, runDir, releaseRunDirIdentity, createdLockIdentity);
            } else {
              await unlink(lockPath);
            }
          } catch {
            return;
          }
          released = true;
          if (releaseRunDirIdentity) {
            await safeRmdirRunDirIfOwned(runDir, releaseRunDirIdentity);
          } else {
            await rmdir(runDir).catch(() => undefined);
          }
        }
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw error;
    }
  } finally {
    await stateDirHandle?.close().catch(() => undefined);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isLockOwner(input: unknown, token: string): boolean {
  return typeof input === "object" && input !== null && "token" in input && input.token === token;
}

async function recoverStaleRunLock(lockPath: string): Promise<boolean> {
  let handle;
  let observedStats: Stats;
  let owner: unknown;
  try {
    handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    observedStats = await handle.stat();
    owner = JSON.parse(await handle.readFile("utf8"));
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
  if (
    !isRunLockRecord(owner)
    || isProcessAlive(owner.pid)
    || (owner.delegated_pid !== undefined && isProcessAlive(owner.delegated_pid))
  ) return false;

  const recoveryPath = `${lockPath}.recovery.${process.pid}.${randomUUID()}`;
  try {
    await rename(lockPath, recoveryPath);
  } catch (error) {
    return isMissing(error);
  }
  try {
    const recoveredStats = await lstat(recoveryPath);
    if (!sameLockFile(observedStats, recoveredStats)) {
      await rename(recoveryPath, lockPath).catch(() => undefined);
      return false;
    }
    await unlink(recoveryPath);
    return true;
  } catch {
    await rename(recoveryPath, lockPath).catch(() => undefined);
    return false;
  }
}

function isRunLockRecord(input: unknown): input is {
  pid: number;
  delegated_pid?: number;
  token: string;
  acquired_at: string;
} {
  return typeof input === "object"
    && input !== null
    && "pid" in input
    && typeof input.pid === "number"
    && Number.isSafeInteger(input.pid)
    && input.pid > 0
    && (!("delegated_pid" in input)
      || (typeof input.delegated_pid === "number"
        && Number.isSafeInteger(input.delegated_pid)
        && input.delegated_pid > 0))
    && "token" in input
    && typeof input.token === "string"
    && input.token.length > 0
    && "acquired_at" in input
    && typeof input.acquired_at === "string";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function sameLockFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
