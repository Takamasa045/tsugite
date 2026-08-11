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
import { z } from "zod";
import { pcError, ProductionControlError } from "./errors.js";
import {
  assertEventIntegrity,
  makeProductionEvent,
  type NewProductionEvent
} from "./events.js";
import { replayProductionEvents, reduceProductionEvent } from "./reducer.js";
import {
  parseProductionEvent,
  safeIdSchema,
  type ProductionEvent,
  type ProductionEventType,
  ZERO_DIGEST
} from "./schema.js";

export type EventStoreHooks = {
  afterEventFsyncBeforeCommit?: () => void | Promise<void>;
  beforeCommit?: () => void | Promise<void>;
  afterCommit?: () => void | Promise<void>;
};

const commitMarkerSchema = z.object({
  schema_version: z.literal(1),
  sequence: z.number().int().nonnegative(),
  event_digest: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
type CommitMarker = z.infer<typeof commitMarkerSchema>;

const eventLocks = new Map<string, Promise<void>>();

/** Append-only event chain with a durable commit boundary for crash recovery. */
export class EventStore {
  private readonly root: string;
  private readonly eventsPath: string;
  private readonly commitPath: string;
  private readonly hooks: EventStoreHooks;

  constructor(root: string, options: { hooks?: EventStoreHooks } = {}) {
    this.root = resolve(root);
    this.eventsPath = join(this.root, "events.jsonl");
    this.commitPath = join(this.root, "events.commit.json");
    this.hooks = options.hooks ?? {};
  }

  async append<T extends ProductionEventType>(input: NewProductionEvent<T> | ProductionEvent): Promise<ProductionEvent> {
    return this.withLock(async () => {
      await this.prepareRoot();
      const events = await this.readCommitted();
      const expectedSequence = events.length + 1;
      const candidateInput = input as NewProductionEvent<T>;
      if (candidateInput.sequence !== undefined && candidateInput.sequence !== expectedSequence) {
        throw pcError("PC_EVENT_CONFLICT", "event sequence does not match the current tail", {
          expected: expectedSequence,
          received: candidateInput.sequence
        });
      }
      const previous = events.at(-1)?.event_digest ?? ZERO_DIGEST;
      if (candidateInput.previous_event_digest !== undefined && candidateInput.previous_event_digest !== previous) {
        throw pcError("PC_EVENT_CONFLICT", "event previous digest does not match the current tail");
      }
      if (events.some((event) => event.event_id === candidateInput.event_id)) {
        throw pcError("PC_EVENT_CONFLICT", "event id is already present");
      }
      const event = makeProductionEvent({
        ...candidateInput,
        sequence: expectedSequence,
        previous_event_digest: previous
      } as NewProductionEvent<T>);
      if (events.length > 0 && event.production_id !== events[0].production_id) {
        throw pcError("PC_EVENT_CONFLICT", "event production does not match the current log");
      }
      if (events.length === 0 && event.sequence !== 1) {
        throw pcError("PC_EVENT_CHAIN", "the first event must have sequence one");
      }
      const current = events.length === 0 ? replayProductionEvents([], event.production_id) : replayProductionEvents(events);
      const next = reduceProductionEvent(current, event);
      void next;
      await this.trimUncommittedTail(events);
      await this.appendLine(event);
      await this.hooks.afterEventFsyncBeforeCommit?.();
      await this.hooks.beforeCommit?.();
      await this.writeCommit({ schema_version: 1, sequence: event.sequence, event_digest: event.event_digest });
      await this.hooks.afterCommit?.();
      return event;
    });
  }

  async appendEvent<T extends ProductionEventType>(input: NewProductionEvent<T> | ProductionEvent): Promise<ProductionEvent> {
    return this.append(input);
  }

  async readAll(): Promise<ProductionEvent[]> {
    await this.prepareRoot();
    return this.readCommitted();
  }

  async replay(productionId?: string) {
    return replayProductionEvents(await this.readAll(), productionId);
  }

  async recover(): Promise<{ events: ProductionEvent[]; uncommitted_line_count: number }> {
    await this.prepareRoot();
    const raw = await this.readLogText();
    const completeLineCount = completeLines(raw).length;
    const events = await this.readCommitted();
    const partialTail = raw.length > 0 && !raw.endsWith("\n") ? 1 : 0;
    return { events, uncommitted_line_count: Math.max(0, completeLineCount - events.length) + partialTail };
  }

  private async trimUncommittedTail(events: readonly ProductionEvent[]): Promise<void> {
    const raw = await this.readLogText();
    let offset = 0;
    for (let index = 0; index < events.length; index += 1) {
      const newline = raw.indexOf("\n", offset);
      if (newline < 0) throw pcError("PC_RECOVERY_INVALID", "committed event has no line terminator");
      offset = newline + 1;
    }
    if (offset >= raw.length) return;
    const rootIdentity = await captureDirectory(this.root);
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.eventsPath, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
      await handle.truncate(offset);
      await handle.sync();
    } catch {
      throw pcError("PC_RECOVERY_INVALID", "uncommitted event tail could not be quarantined");
    } finally {
      await handle?.close().catch(() => undefined);
    }
    const liveRoot = await captureDirectory(this.root);
    if (!sameDirectory(rootIdentity, liveRoot)) throw pcError("PC_PATH_UNSAFE", "event root identity changed");
    await fsyncDirectory(this.root);
  }

  private async appendLine(event: ProductionEvent): Promise<void> {
    const rootIdentity = await captureDirectory(this.root);
    await assertRegularOrMissing(this.eventsPath);
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        this.eventsPath,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      if (error instanceof ProductionControlError) throw error;
      throw pcError("PC_EVENT_CHAIN", "event append failed");
    } finally {
      await handle?.close().catch(() => undefined);
    }
    const liveRoot = await captureDirectory(this.root);
    if (!sameDirectory(rootIdentity, liveRoot)) throw pcError("PC_PATH_UNSAFE", "event root identity changed");
  }

  private async writeCommit(marker: CommitMarker): Promise<void> {
    const rootIdentity = await captureDirectory(this.root);
    const temporary = join(this.root, `.events.commit.${process.pid}.${Date.now().toString(36)}.tmp`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      const liveRoot = await captureDirectory(this.root);
      if (!sameDirectory(rootIdentity, liveRoot)) throw pcError("PC_PATH_UNSAFE", "event root identity changed");
      await assertRegularOrMissing(this.commitPath);
      await rename(temporary, this.commitPath);
      await fsyncDirectory(this.root);
      const syncedRoot = await captureDirectory(this.root);
      if (!sameDirectory(rootIdentity, syncedRoot)) throw pcError("PC_PATH_UNSAFE", "event root identity changed after sync");
    } catch (error) {
      if (error instanceof ProductionControlError) throw error;
      throw pcError("PC_EVENT_CHAIN", "event commit marker could not be written");
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async readCommitted(): Promise<ProductionEvent[]> {
    const raw = await this.readLogText();
    const lines = completeLines(raw);
    const marker = await this.readCommitMarker();
    // A log line is not event truth until the commit marker names it. This
    // makes an append crash between log fsync and marker publication recover
    // as an uncommitted tail instead of adopting the event.
    const count = marker?.sequence ?? 0;
    if (count > lines.length) throw pcError("PC_RECOVERY_INVALID", "event commit marker is ahead of the event log");
    if (marker && count === 0 && marker.event_digest !== ZERO_DIGEST) {
      throw pcError("PC_RECOVERY_INVALID", "empty event commit marker has a non-zero digest");
    }
    const events: ProductionEvent[] = [];
    const ids = new Set<string>();
    for (let index = 0; index < count; index += 1) {
      let event: ProductionEvent;
      try {
        event = parseProductionEvent(JSON.parse(lines[index]));
        assertEventIntegrity(event);
      } catch (error) {
        if (error instanceof ProductionControlError) throw error;
        throw pcError("PC_EVENT_TAMPERED", "event log contains invalid JSON or schema");
      }
      if (ids.has(event.event_id)) throw pcError("PC_EVENT_CHAIN", "event id is duplicated");
      ids.add(event.event_id);
      const expectedSequence = index + 1;
      const expectedPrevious = events.at(-1)?.event_digest ?? ZERO_DIGEST;
      if (event.sequence !== expectedSequence || event.previous_event_digest !== expectedPrevious) {
        throw pcError("PC_EVENT_CHAIN", "event sequence or previous digest is invalid");
      }
      if (events.length > 0 && event.production_id !== events[0].production_id) {
        throw pcError("PC_EVENT_CHAIN", "event production id changed within the chain");
      }
      events.push(event);
    }
    if (marker && marker.sequence > 0 && marker.event_digest !== events.at(-1)?.event_digest) {
      throw pcError("PC_EVENT_TAMPERED", "event commit marker digest mismatch");
    }
    return events;
  }

  private async readLogText(): Promise<string> {
    await assertRegularOrMissing(this.eventsPath);
    try {
      return await readSafeFile(this.eventsPath);
    } catch (error) {
      if (isNotFound(error)) return "";
      throw pcError("PC_PATH_UNSAFE", "event log could not be read");
    }
  }

  private async readCommitMarker(): Promise<CommitMarker | undefined> {
    await assertRegularOrMissing(this.commitPath);
    try {
      const parsed = commitMarkerSchema.parse(JSON.parse(await readSafeFile(this.commitPath)));
      if (parsed.sequence === 0 && parsed.event_digest !== ZERO_DIGEST) throw pcError("PC_RECOVERY_INVALID", "invalid empty commit marker");
      return parsed;
    } catch (error) {
      if (error instanceof ProductionControlError) throw error;
      if (isNotFound(error)) return undefined;
      throw pcError("PC_RECOVERY_INVALID", "event commit marker is invalid");
    }
  }

  private async prepareRoot(): Promise<void> {
    try {
      await lstat(this.root);
    } catch (error) {
      if (!isNotFound(error)) throw pcError("PC_PATH_UNSAFE", "event root could not be inspected");
      await captureDirectory(dirname(this.root));
      await mkdir(this.root).catch((mkdirError) => {
        if (!isAlreadyExists(mkdirError)) throw pcError("PC_PATH_UNSAFE", "event root could not be created");
      });
    }
    await captureDirectory(this.root);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const key = this.root;
    const previous = eventLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    eventLocks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (eventLocks.get(key) === current) eventLocks.delete(key);
    }
  }
}

export async function createEventStore(root: string, options?: { hooks?: EventStoreHooks }): Promise<EventStore> {
  const store = new EventStore(root, options);
  await store.readAll();
  return store;
}

function completeLines(raw: string): string[] {
  if (raw.length === 0) return [];
  const parts = raw.split("\n");
  if (parts.at(-1) === "") parts.pop();
  else parts.pop(); // The final unterminated line is a crash-partial tail.
  return parts.filter((line) => line.length > 0);
}

async function assertRegularOrMissing(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) throw pcError("PC_PATH_UNSAFE", "event store leaf must be a regular file");
  } catch (error) {
    if (error instanceof ProductionControlError) throw error;
    if (!isNotFound(error)) throw pcError("PC_PATH_UNSAFE", "event store leaf is not safe");
  }
}

async function readSafeFile(path: string): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    const expected = await lstat(path);
    if (expected.isSymbolicLink() || !expected.isFile()) throw pcError("PC_PATH_UNSAFE", "event store leaf must be a regular file");
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stats = await handle.stat();
    if (!stats.isFile() || stats.dev !== expected.dev || stats.ino !== expected.ino) {
      throw pcError("PC_PATH_UNSAFE", "event store leaf identity changed");
    }
    return await handle.readFile("utf8");
  } catch (error) {
    if (error instanceof ProductionControlError) throw error;
    if (isNotFound(error)) throw error;
    throw pcError("PC_PATH_UNSAFE", "event store leaf could not be opened safely");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function captureDirectory(path: string): Promise<{ device: number; inode: number; real_path: string }> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw pcError("PC_PATH_UNSAFE", "event root must be a real directory");
    for (let current = resolve(path);; current = dirname(current)) {
      const ancestor = await lstat(current);
      if (ancestor.isSymbolicLink()) throw pcError("PC_PATH_UNSAFE", "event root has a symbolic-link ancestor");
      if (current === dirname(current)) break;
    }
    return { device: stats.dev, inode: stats.ino, real_path: await realpath(path) };
  } catch (error) {
    if (error instanceof ProductionControlError) throw error;
    throw pcError("PC_PATH_UNSAFE", "event root identity could not be read");
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
    throw pcError("PC_PATH_UNSAFE", "event root could not be synced");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
