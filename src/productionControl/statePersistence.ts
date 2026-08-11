import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  type FileHandle
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pcError, ProductionControlError } from "./errors.js";
import { missionStateDigest, replayProductionEvents } from "./reducer.js";
import {
  parseMissionState,
  parseSnapshot,
  snapshotSchema,
  type MissionState,
  type ProductionEvent,
  type Snapshot
} from "./schema.js";

export type SnapshotExpected = {
  applied_event_sequence: number;
  state_digest: string;
};

export type SnapshotHooks = {
  afterTempSync?: () => void | Promise<void>;
  beforeRename?: () => void | Promise<void>;
  afterRenameBeforeDirectorySync?: () => void | Promise<void>;
};

const snapshotLocks = new Map<string, Promise<void>>();

/** Mutable projection persistence; event truth remains in EventStore. */
export class SnapshotStore {
  private readonly root: string;
  private readonly snapshotPath: string;
  private readonly hooks: SnapshotHooks;

  constructor(root: string, options: { hooks?: SnapshotHooks } = {}) {
    this.root = resolve(root);
    this.snapshotPath = join(this.root, "coordination-state.json");
    this.hooks = options.hooks ?? {};
  }

  async read(): Promise<Snapshot | undefined> {
    await this.prepareRoot();
    await assertRegularOrMissing(this.snapshotPath);
    try {
      const snapshot = parseSnapshot(JSON.parse(await readSafeFile(this.snapshotPath)));
      verifySnapshotDigest(snapshot);
      return snapshot;
    } catch (error) {
      if (error instanceof ProductionControlError && error.code === "PC_PATH_UNSAFE") throw error;
      if (isNotFound(error)) return undefined;
      if (error instanceof ProductionControlError) throw error;
      throw pcError("PC_RECOVERY_INVALID", "snapshot is invalid");
    }
  }

  async compareAndSwap(state: MissionState, expected: SnapshotExpected | null): Promise<Snapshot> {
    return this.withLock(async () => {
      const nextState = parseMissionState(state);
      const nextDigest = missionStateDigest(nextState);
      const current = await this.read();
      if (expected === null) {
        if (current) throw pcError("PC_SNAPSHOT_CONFLICT", "snapshot already exists");
      } else {
        if (!current) throw pcError("PC_SNAPSHOT_CONFLICT", "snapshot is missing for the expected revision");
        if (
          current.state.applied_event_sequence !== expected.applied_event_sequence
          || current.state_digest !== expected.state_digest
        ) {
          throw pcError("PC_SNAPSHOT_CONFLICT", "snapshot expected sequence or digest is stale");
        }
      }
      const snapshot: Snapshot = { schema_version: 1, state: nextState, state_digest: nextDigest };
      snapshotSchema.parse(snapshot);
      await this.atomicWrite(snapshot);
      return snapshot;
    });
  }

  async write(state: MissionState, expected: SnapshotExpected | null): Promise<Snapshot> {
    return this.compareAndSwap(state, expected);
  }

  async writeSnapshot(state: MissionState, expected: SnapshotExpected | null): Promise<Snapshot> {
    return this.compareAndSwap(state, expected);
  }

  async recoverFromEvents(eventSource: { readAll(): Promise<ProductionEvent[]> }, productionId?: string): Promise<{ state: MissionState; snapshot_rebuilt: boolean }> {
    const events = await eventSource.readAll();
    const replayed = replayProductionEvents(events, productionId);
    let current: Snapshot | undefined;
    try {
      current = await this.read();
    } catch {
      await this.quarantineInvalidSnapshot();
    }
    if (current) {
      if (current.state.production_id !== replayed.production_id) throw pcError("PC_RECOVERY_INVALID", "snapshot production does not match event truth");
      if (current.state.applied_event_sequence > replayed.applied_event_sequence) {
        throw pcError("PC_RECOVERY_INVALID", "snapshot is ahead of event truth");
      }
      if (
        current.state.applied_event_sequence === replayed.applied_event_sequence
        && current.state_digest === missionStateDigest(replayed)
      ) {
        return { state: current.state, snapshot_rebuilt: false };
      }
      const repaired = await this.compareAndSwap(replayed, {
        applied_event_sequence: current.state.applied_event_sequence,
        state_digest: current.state_digest
      });
      return { state: repaired.state, snapshot_rebuilt: true };
    }
    const repaired = await this.compareAndSwap(replayed, null);
    return { state: repaired.state, snapshot_rebuilt: true };
  }

  private async atomicWrite(snapshot: Snapshot): Promise<void> {
    const rootIdentity = await captureDirectory(this.root);
    await assertRegularOrMissing(this.snapshotPath);
    const temporary = join(this.root, `.coordination-state.${process.pid}.${Date.now().toString(36)}.tmp`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      await handle.writeFile(`${JSON.stringify(snapshot)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.hooks.afterTempSync?.();
      const liveRoot = await captureDirectory(this.root);
      if (!sameDirectory(rootIdentity, liveRoot)) throw pcError("PC_PATH_UNSAFE", "snapshot root identity changed");
      await assertRegularOrMissing(this.snapshotPath);
      await this.hooks.beforeRename?.();
      await assertRegularOrMissing(this.snapshotPath);
      await rename(temporary, this.snapshotPath);
      await this.hooks.afterRenameBeforeDirectorySync?.();
      await fsyncDirectory(this.root);
      const syncedRoot = await captureDirectory(this.root);
      if (!sameDirectory(rootIdentity, syncedRoot)) throw pcError("PC_PATH_UNSAFE", "snapshot root identity changed after sync");
    } catch (error) {
      if (error instanceof ProductionControlError) throw error;
      throw pcError("PC_RECOVERY_INVALID", "snapshot atomic write failed");
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async quarantineInvalidSnapshot(): Promise<void> {
    try {
      const stats = await lstat(this.snapshotPath);
      if (stats.isSymbolicLink() || !stats.isFile()) throw pcError("PC_PATH_UNSAFE", "snapshot leaf is unsafe");
      const quarantine = join(this.root, `.coordination-state.invalid.${Date.now().toString(36)}`);
      await rename(this.snapshotPath, quarantine);
      await fsyncDirectory(this.root);
    } catch (error) {
      if (error instanceof ProductionControlError) throw error;
      if (!isNotFound(error)) throw pcError("PC_RECOVERY_INVALID", "invalid snapshot could not be quarantined");
    }
  }

  private async prepareRoot(): Promise<void> {
    try {
      await lstat(this.root);
    } catch (error) {
      if (!isNotFound(error)) throw pcError("PC_PATH_UNSAFE", "snapshot root could not be inspected");
      await captureDirectory(dirname(this.root));
      await mkdir(this.root).catch((mkdirError) => {
        if (!isAlreadyExists(mkdirError)) throw pcError("PC_PATH_UNSAFE", "snapshot root could not be created");
      });
    }
    await captureDirectory(this.root);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const key = this.root;
    const previous = snapshotLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    snapshotLocks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (snapshotLocks.get(key) === current) snapshotLocks.delete(key);
    }
  }
}

export async function readSnapshot(root: string): Promise<Snapshot | undefined> {
  return new SnapshotStore(root).read();
}

export async function writeSnapshot(root: string, state: MissionState, expected: SnapshotExpected | null): Promise<Snapshot> {
  return new SnapshotStore(root).compareAndSwap(state, expected);
}

function verifySnapshotDigest(snapshot: Snapshot): void {
  const expected = missionStateDigest(snapshot.state);
  if (expected !== snapshot.state_digest) throw pcError("PC_RECOVERY_INVALID", "snapshot state digest mismatch");
}

async function assertRegularOrMissing(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) throw pcError("PC_PATH_UNSAFE", "snapshot leaf must be a regular file");
  } catch (error) {
    if (error instanceof ProductionControlError) throw error;
    if (!isNotFound(error)) throw pcError("PC_PATH_UNSAFE", "snapshot leaf is not safe");
  }
}

async function readSafeFile(path: string): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    const expected = await lstat(path);
    if (expected.isSymbolicLink() || !expected.isFile()) throw pcError("PC_PATH_UNSAFE", "snapshot leaf must be a regular file");
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stats = await handle.stat();
    if (!stats.isFile() || stats.dev !== expected.dev || stats.ino !== expected.ino) {
      throw pcError("PC_PATH_UNSAFE", "snapshot leaf identity changed");
    }
    return await handle.readFile("utf8");
  } catch (error) {
    if (error instanceof ProductionControlError) throw error;
    if (isNotFound(error)) throw error;
    throw pcError("PC_PATH_UNSAFE", "snapshot leaf could not be opened safely");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function captureDirectory(path: string): Promise<{ device: number; inode: number; real_path: string }> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw pcError("PC_PATH_UNSAFE", "snapshot root must be a real directory");
    for (let current = resolve(path);; current = dirname(current)) {
      const ancestor = await lstat(current);
      if (ancestor.isSymbolicLink()) throw pcError("PC_PATH_UNSAFE", "snapshot root has a symbolic-link ancestor");
      if (current === dirname(current)) break;
    }
    return { device: stats.dev, inode: stats.ino, real_path: await realpath(path) };
  } catch (error) {
    if (error instanceof ProductionControlError) throw error;
    throw pcError("PC_PATH_UNSAFE", "snapshot root identity could not be read");
  }
}

function sameDirectory(left: { device: number; inode: number; real_path: string }, right: { device: number; inode: number; real_path: string }): boolean {
  return left.device === right.device && left.inode === right.inode && left.real_path === right.real_path;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EEXIST");
}

async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    await handle.sync();
  } catch {
    throw pcError("PC_PATH_UNSAFE", "snapshot root could not be synced");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
