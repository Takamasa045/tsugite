import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { dirname, resolve, join } from "node:path";

export type ProductionControlErrorCode =
  | "PC_SCHEMA_INVALID"
  | "PC_SECRET_OR_PATH"
  | "PC_CANONICAL_INVALID"
  | "PC_PATH_UNSAFE"
  | "PC_ARTIFACT_DUPLICATE"
  | "PC_ARTIFACT_MISMATCH"
  | "PC_ARTIFACT_NOT_FOUND"
  | "PC_EVENT_CHAIN"
  | "PC_EVENT_CONFLICT"
  | "PC_EVENT_TAMPERED"
  | "PC_INVALID_TRANSITION"
  | "PC_SNAPSHOT_CONFLICT"
  | "PC_LOCK_CONFLICT"
  | "PC_LOCK_UNSAFE"
  | "PC_RECOVERY_INVALID"
  | "PC_CONTRACT_INVALID"
  | "PC_FRAGMENT_INVALID"
  | "PC_TREE_INVALID"
  | "PC_ROLE_FORBIDDEN"
  | "PC_PROGRAM_BINDING_INVALID"
  | "PC_INVALIDATION_INVALID"
  | "PC_GATE_BUNDLE_INVALID"
  | "PC_GATE_SUBJECT_STALE"
  | "PC_AUTHORITY_DENIED"
  | "PC_LEASE_CONFLICT"
  | "PC_LEASE_EXPIRED"
  | "PC_DISPATCH_LIMIT"
  | "PC_GENERATION_BINDING_INVALID"
  | "PC_GENERATION_IDENTITY_DRIFT"
  | "PC_GENERATION_REVISION_ROLLBACK"
  | "PC_COMPLETION_NOT_PINNED"
  | "PC_SUBMISSION_UNKNOWN"
  | "PC_RESUME_INVALID"
  | "PC_MODE_INACTIVE"
  | "PC_MODE_UNSAFE_UNKNOWN"
  | "PC_GRANT_INVALID"
  | "PC_GRANT_EXHAUSTED"
  | "PC_GRANT_EXPIRED"
  | "PC_LEDGER_CONFLICT"
  | "PC_LEDGER_UNSAFE"
  | "PC_RESERVATION_INVALID"
  | "PC_AUTHORIZATION_INVALID"
  | "PC_PERMIT_INVALID"
  | "PC_REVISION_INTENT_INVALID"
  | "PC_RECOVERY_DENIED"
  | "PC_POLICY_MISMATCH";

/** Error boundary for the production-control shadow foundation. */
export class ProductionControlError extends Error {
  readonly code: ProductionControlErrorCode;
  readonly details?: Readonly<Record<string, string | number | boolean>>;

  constructor(
    code: ProductionControlErrorCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean>>
  ) {
    super(message);
    this.name = "ProductionControlError";
    this.code = code;
    this.details = details;
  }
}

export function pcError(
  code: ProductionControlErrorCode,
  message: string,
  details?: Readonly<Record<string, string | number | boolean>>
): ProductionControlError {
  return new ProductionControlError(code, message, details);
}

export type ProductionControlRootLockHooks = {
  afterLockCreatedBeforeValidate?: () => void | Promise<void>;
  afterRootLockAcquired?: () => void | Promise<void>;
};

type RootIdentity = { device: number; inode: number; real_path: string };
type LockIdentity = { device: number; inode: number };
type LockOwner = {
  schema_version: 1;
  pid: number;
  token: string;
  acquired_at: string;
};

/**
 * Cross-process root-local serialization for the shadow stores. Existing
 * locks are never guessed away: live, stale, malformed, or replaced owners
 * all fail closed. Recovery must explicitly remove a known-safe lock.
 */
export async function acquireProductionControlRootLock(
  root: string,
  hooks: ProductionControlRootLockHooks = {}
): Promise<{ release: () => Promise<void>; path: string }> {
  const rootPath = resolve(root);
  const rootIdentity = await captureRootIdentity(rootPath);
  const lockPath = join(rootPath, ".production-control.lock");
  let handle: FileHandle | undefined;
  let createdIdentity: LockIdentity | undefined;
  const owner: LockOwner = {
    schema_version: 1,
    pid: process.pid,
    token: randomUUID(),
    acquired_at: new Date().toISOString()
  };
  try {
    handle = await open(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    createdIdentity = await captureLockIdentity(lockPath);
    await hooks.afterLockCreatedBeforeValidate?.();
    await assertSameRoot(rootPath, rootIdentity);
    await assertSameLock(lockPath, createdIdentity);
    const validated = await readLockOwner(lockPath, createdIdentity);
    if (validated.token !== owner.token) throw pcError("PC_LOCK_UNSAFE", "root lock owner changed during acquisition");
    await hooks.afterRootLockAcquired?.();
    return {
      path: lockPath,
      release: async () => {
        await releaseRootLock(rootPath, rootIdentity, lockPath, createdIdentity!, owner.token);
      }
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (createdIdentity) await removeOwnedLock(rootPath, rootIdentity, lockPath, createdIdentity, owner.token);
    if (error instanceof ProductionControlError) throw error;
    if (isAlreadyExists(error)) {
      const existing = await readLockOwner(lockPath);
      const live = isProcessLive(existing.pid);
      throw pcError("PC_LOCK_CONFLICT", live ? "root lock is held by a live owner" : "root lock owner is stale; manual recovery is required", {
        pid: existing.pid
      });
    }
    throw pcError("PC_LOCK_UNSAFE", "root lock could not be acquired");
  }
}

async function releaseRootLock(
  root: string,
  rootIdentity: RootIdentity,
  lockPath: string,
  lockIdentity: LockIdentity,
  token: string
): Promise<void> {
  await assertSameRoot(root, rootIdentity);
  const current = await readLockOwner(lockPath, lockIdentity);
  if (current.token !== token) return;
  await unlink(lockPath);
  await fsyncDirectory(root);
}

async function removeOwnedLock(
  root: string,
  rootIdentity: RootIdentity,
  lockPath: string,
  lockIdentity: LockIdentity,
  token: string
): Promise<void> {
  try {
    await releaseRootLock(root, rootIdentity, lockPath, lockIdentity, token);
  } catch {
    // Never unlink a lock whose root, leaf identity, or owner is uncertain.
  }
}

async function readLockOwner(path: string, expected?: LockIdentity): Promise<LockOwner> {
  let handle: FileHandle | undefined;
  try {
    const before = await captureLockIdentity(path);
    if (expected && !sameLock(before, expected)) throw pcError("PC_LOCK_UNSAFE", "root lock identity changed");
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stats = await handle.stat();
    if (!stats.isFile() || stats.dev !== before.device || stats.ino !== before.inode) {
      throw pcError("PC_LOCK_UNSAFE", "root lock identity changed while reading");
    }
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    const owner = parseLockOwner(value);
    const after = await captureLockIdentity(path);
    if (!sameLock(before, after)) throw pcError("PC_LOCK_UNSAFE", "root lock identity changed after reading");
    return owner;
  } catch (error) {
    if (error instanceof ProductionControlError) throw error;
    throw pcError("PC_LOCK_UNSAFE", "root lock owner is invalid or unreadable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseLockOwner(value: unknown): LockOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw pcError("PC_LOCK_UNSAFE", "root lock owner is not an object");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "acquired_at,pid,schema_version,token") throw pcError("PC_LOCK_UNSAFE", "root lock owner contains unknown fields");
  if (record.schema_version !== 1 || typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid < 1) {
    throw pcError("PC_LOCK_UNSAFE", "root lock owner pid or schema is invalid");
  }
  if (typeof record.token !== "string" || !/^[0-9a-f-]{36}$/.test(record.token)) throw pcError("PC_LOCK_UNSAFE", "root lock owner token is invalid");
  if (typeof record.acquired_at !== "string" || !Number.isFinite(Date.parse(record.acquired_at))) throw pcError("PC_LOCK_UNSAFE", "root lock owner timestamp is invalid");
  return record as unknown as LockOwner;
}

function isProcessLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ESRCH")) return false;
    if (isErrorCode(error, "EPERM")) return true;
    throw pcError("PC_LOCK_UNSAFE", "root lock owner liveness is unknown");
  }
}

async function captureRootIdentity(path: string): Promise<RootIdentity> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw pcError("PC_LOCK_UNSAFE", "root lock directory is unsafe");
    for (let current = resolve(path);; current = dirname(current)) {
      const ancestor = await lstat(current);
      if (ancestor.isSymbolicLink()) throw pcError("PC_LOCK_UNSAFE", "root lock has a symbolic-link ancestor");
      if (current === dirname(current)) break;
    }
    return { device: stats.dev, inode: stats.ino, real_path: await realpath(path) };
  } catch (error) {
    if (error instanceof ProductionControlError) throw error;
    throw pcError("PC_LOCK_UNSAFE", "root lock directory identity is unavailable");
  }
}

async function assertSameRoot(path: string, expected: RootIdentity): Promise<void> {
  const actual = await captureRootIdentity(path);
  if (actual.device !== expected.device || actual.inode !== expected.inode || actual.real_path !== expected.real_path) {
    throw pcError("PC_LOCK_UNSAFE", "root identity changed while locked");
  }
}

async function captureLockIdentity(path: string): Promise<LockIdentity> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) throw pcError("PC_LOCK_UNSAFE", "root lock leaf is unsafe");
    return { device: stats.dev, inode: stats.ino };
  } catch (error) {
    if (error instanceof ProductionControlError) throw error;
    throw pcError("PC_LOCK_UNSAFE", "root lock leaf is unavailable");
  }
}

async function assertSameLock(path: string, expected: LockIdentity): Promise<void> {
  const actual = await captureLockIdentity(path);
  if (!sameLock(actual, expected)) throw pcError("PC_LOCK_UNSAFE", "root lock leaf identity changed");
}

function sameLock(left: LockIdentity, right: LockIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function isAlreadyExists(error: unknown): boolean {
  return isErrorCode(error, "EEXIST");
}

function isErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === code);
}

async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    await handle.sync();
  } catch {
    throw pcError("PC_LOCK_UNSAFE", "root lock directory could not be synced");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
