import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { sha256Bytes } from "./canonical.js";
import { ProductionControlError, pcError } from "./errors.js";
import { parseArtifactEnvelope, type ArtifactEnvelope } from "./schema.js";
import { z } from "zod";

export type ArtifactStoreHooks = {
  afterTempWriteBeforeSync?: () => void | Promise<void>;
  afterTempSync?: () => void | Promise<void>;
  beforePublish?: () => void | Promise<void>;
  afterReserveBeforeRename?: () => void | Promise<void>;
  afterFinalCheckBeforePublish?: () => void | Promise<void>;
  afterPublishBeforeDirectorySync?: () => void | Promise<void>;
  afterDirectorySync?: () => void | Promise<void>;
};

export type ArtifactCreateInput = {
  artifact_id: string;
  bytes: Uint8Array | string;
  expected_sha256?: string;
  expected_size?: number;
  envelope?: ArtifactEnvelope;
};

export type StoredArtifact = {
  artifact_id: string;
  sha256: string;
  byte_size: number;
  relative_path: string;
};

type DirectoryIdentity = { device: number; inode: number; real_path: string };
type FileIdentity = { device: number; inode: number };

const artifactCreateInputSchema = z.object({
  artifact_id: z.string().min(1).max(128),
  bytes: z.union([z.string(), z.instanceof(Uint8Array)]),
  expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  expected_size: z.number().int().nonnegative().finite().optional(),
  envelope: z.unknown().optional()
}).strict();

const artifactLocks = new Map<string, Promise<void>>();

/** Create-only, containment-checked artifact persistence for the shadow plane. */
export class ArtifactStore {
  private readonly root: string;
  private readonly hooks: ArtifactStoreHooks;

  constructor(root: string, options: { hooks?: ArtifactStoreHooks } = {}) {
    this.root = resolve(root);
    this.hooks = options.hooks ?? {};
  }

  async create(input: ArtifactCreateInput): Promise<StoredArtifact> {
    return withArtifactLock(this.root, () => this.createInternal(input));
  }

  private async createInternal(input: ArtifactCreateInput): Promise<StoredArtifact> {
    try {
      artifactCreateInputSchema.parse(input);
    } catch (error) {
      if (error instanceof ProductionControlError) throw error;
      throw pcError("PC_SCHEMA_INVALID", "artifact input is invalid");
    }
    if (!isSafeArtifactId(input.artifact_id)) throw pcError("PC_PATH_UNSAFE", "artifact id is not a safe id");
    const bytes = typeof input.bytes === "string" ? Buffer.from(input.bytes, "utf8") : Buffer.from(input.bytes);
    const digest = sha256Bytes(bytes);
    if (input.expected_sha256 !== undefined && input.expected_sha256 !== digest) {
      throw pcError("PC_ARTIFACT_MISMATCH", "artifact digest mismatch");
    }
    if (input.expected_size !== undefined && (!Number.isSafeInteger(input.expected_size) || input.expected_size !== bytes.byteLength)) {
      throw pcError("PC_ARTIFACT_MISMATCH", "artifact size mismatch");
    }
    if (input.envelope) {
      const envelope = parseArtifactEnvelope(input.envelope);
      if (envelope.artifact_id !== input.artifact_id) throw pcError("PC_ARTIFACT_MISMATCH", "artifact envelope id mismatch");
    }

    const layout = await this.prepareLayout();
    const finalPath = join(layout.artifactDir, `${input.artifact_id}.json`);
    assertContained(finalPath, layout.rootPath);
    const reservationPath = `${finalPath}.reserve`;

    const temporaryPath = join(layout.artifactDir, `.${input.artifact_id}.${process.pid}.${randomSuffix()}.tmp`);
    let handle: FileHandle | undefined;
    let published = false;
    let reserved = false;
    let reservationIdentity: FileIdentity | undefined;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      await handle.writeFile(bytes);
      await this.hooks.afterTempWriteBeforeSync?.();
      await handle.sync();
      await handle.close();
      handle = undefined;

      await this.hooks.afterTempSync?.();
      await assertLayoutIdentity(layout);
      await verifyRegularFile(temporaryPath, bytes.byteLength, digest);
      await this.hooks.beforePublish?.();
      await assertLayoutIdentity(layout);
      await assertFinalLeafAvailable(finalPath);

      // Reserve a sibling leaf with O_EXCL so cooperating writers retain
      // create-only semantics, then publish the fsynced temp atomically.
      reservationIdentity = await reserveLeaf(finalPath, reservationPath);
      reserved = true;
      await this.hooks.afterReserveBeforeRename?.();
      await assertLayoutIdentity(layout);
      await assertFinalLeafAvailable(finalPath);
      await assertFileIdentity(reservationPath, reservationIdentity);
      await this.hooks.afterFinalCheckBeforePublish?.();
      // `rename` replaces an existing destination on POSIX. A hard-link
      // publication is the atomic no-replace primitive available here, so an
      // external writer can only make this create fail, never overwrite data.
      try {
        await link(temporaryPath, finalPath);
      } catch (error) {
        if (isAlreadyExists(error)) {
          const live = await lstat(finalPath).catch(() => undefined);
          if (live?.isSymbolicLink()) throw pcError("PC_PATH_UNSAFE", "artifact leaf must not be a symbolic link");
          throw pcError("PC_ARTIFACT_DUPLICATE", "artifact already exists");
        }
        throw pcError("PC_PATH_UNSAFE", "artifact publication failed");
      }
      published = true;
      await verifyRegularFile(finalPath, bytes.byteLength, digest);
      await this.hooks.afterPublishBeforeDirectorySync?.();
      await fsyncDirectory(layout.artifactDir);
      await this.hooks.afterDirectorySync?.();
      await assertLayoutIdentity(layout);
      return {
        artifact_id: input.artifact_id,
        sha256: digest,
        byte_size: bytes.byteLength,
        relative_path: `artifacts/${input.artifact_id}.json`
      };
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (reserved && reservationIdentity) await safeRemoveReservation(reservationPath, reservationIdentity);
      if (!published) await assertLayoutIdentity(layout).catch(() => undefined);
    }
  }

  async createArtifact(input: ArtifactCreateInput): Promise<StoredArtifact> {
    return this.create(input);
  }

  async read(artifactId: string): Promise<Buffer> {
    return this.readBounded(artifactId, 64 * 1024 * 1024);
  }

  /**
   * Identity-safe bounded read for typed JSON artifacts. The checked leaf and
   * opened descriptor are the same object; no pathname is reopened after the
   * bytes have been read.
   */
  async readBounded(artifactId: string, maxBytes: number): Promise<Buffer> {
    if (!isSafeArtifactId(artifactId)) throw pcError("PC_PATH_UNSAFE", "artifact id is not a safe id");
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw pcError("PC_SCHEMA_INVALID", "artifact read bound is invalid");
    const layout = await this.prepareLayout(false);
    const finalPath = join(layout.artifactDir, `${artifactId}.json`);
    try {
      const expected = await lstat(finalPath);
      if (expected.isSymbolicLink() || !expected.isFile() || expected.size > maxBytes || expected.dev === 0 || expected.ino === 0) {
        throw pcError("PC_PATH_UNSAFE", "artifact leaf is not a bounded regular file with stable identity");
      }
      const handle = await open(finalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.dev === 0 || stats.ino === 0 || stats.dev !== expected.dev || stats.ino !== expected.ino || stats.size > maxBytes) {
          throw pcError("PC_PATH_UNSAFE", "artifact leaf identity changed");
        }
        const bytes = Buffer.alloc(stats.size);
        let offset = 0;
        while (offset < stats.size) {
          const result = await handle.read(bytes, offset, stats.size - offset, offset);
          if (result.bytesRead <= 0) throw pcError("PC_PATH_UNSAFE", "artifact short read");
          offset += result.bytesRead;
        }
        const after = await handle.stat();
        if (after.dev !== stats.dev || after.ino !== stats.ino || after.size !== stats.size || after.mtimeMs !== stats.mtimeMs) {
          throw pcError("PC_PATH_UNSAFE", "artifact leaf identity changed during read");
        }
        await assertLayoutIdentity(layout);
        return bytes;
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof ProductionControlError) throw error;
      if (isNotFound(error)) throw pcError("PC_ARTIFACT_NOT_FOUND", "artifact is not available");
      throw pcError("PC_PATH_UNSAFE", "artifact leaf could not be opened safely");
    }
  }

  async readArtifact(artifactId: string): Promise<Buffer> {
    return this.read(artifactId);
  }

  async has(artifactId: string): Promise<boolean> {
    try {
      await this.read(artifactId);
      return true;
    } catch (error) {
      if (error instanceof ProductionControlError && error.code === "PC_ARTIFACT_NOT_FOUND") return false;
      throw error;
    }
  }

  async recover(): Promise<{ removed_temp_files: number }> {
    const layout = await this.prepareLayout(false);
    let removed = 0;
    for (const name of await readdir(layout.artifactDir)) {
      if (!name.startsWith(".") || (!name.endsWith(".tmp") && !name.endsWith(".reserve"))) continue;
      const candidate = join(layout.artifactDir, name);
      try {
        const stats = await lstat(candidate);
        if (stats.isSymbolicLink() || !stats.isFile()) throw pcError("PC_PATH_UNSAFE", "unsafe artifact recovery leaf");
        await unlink(candidate);
        removed += 1;
      } catch (error) {
        if (error instanceof ProductionControlError) throw error;
        throw pcError("PC_PATH_UNSAFE", "artifact recovery encountered an unsafe temporary leaf");
      }
    }
    return { removed_temp_files: removed };
  }

  public async ensureReady(): Promise<void> {
    await this.prepareLayout(true);
  }

  private async prepareLayout(createArtifactDir = true): Promise<{ rootPath: string; artifactDir: string; root: DirectoryIdentity; artifact: DirectoryIdentity }> {
    const rootPath = await assertRealDirectory(this.root);
    const artifactDir = join(rootPath, "artifacts");
    assertContained(artifactDir, rootPath);
    if (createArtifactDir) {
      try {
        await mkdir(artifactDir, { mode: 0o700 });
      } catch (error) {
        if (!isAlreadyExists(error)) throw pcError("PC_PATH_UNSAFE", "artifact directory could not be created");
      }
    }
    const root = await captureDirectory(rootPath);
    const artifact = await captureDirectory(artifactDir);
    return { rootPath, artifactDir, root, artifact };
  }
}

export async function createArtifactStore(root: string, options?: { hooks?: ArtifactStoreHooks }): Promise<ArtifactStore> {
  const store = new ArtifactStore(root, options);
  await store.ensureReady();
  return store;
}

async function assertLayoutIdentity(layout: { rootPath: string; artifactDir: string; root: DirectoryIdentity; artifact: DirectoryIdentity }): Promise<void> {
  const root = await captureDirectory(layout.rootPath);
  const artifact = await captureDirectory(layout.artifactDir);
  if (!sameIdentity(root, layout.root) || !sameIdentity(artifact, layout.artifact)) {
    throw pcError("PC_PATH_UNSAFE", "artifact containment identity changed");
  }
}

async function assertRealDirectory(path: string): Promise<string> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw pcError("PC_PATH_UNSAFE", "artifact root must be a real directory");
    const real = await realpath(path);
    for (let current = resolve(path);; current = dirname(current)) {
      const ancestor = await lstat(current);
      if (ancestor.isSymbolicLink()) throw pcError("PC_PATH_UNSAFE", "artifact root has a symbolic-link ancestor");
      if (current === dirname(current)) break;
    }
    return real;
  } catch (error) {
    if (error instanceof ProductionControlError) throw error;
    throw pcError("PC_PATH_UNSAFE", "artifact root is not available");
  }
}

async function captureDirectory(path: string): Promise<DirectoryIdentity> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory() || stats.dev === 0 || stats.ino === 0) throw pcError("PC_PATH_UNSAFE", "artifact directory identity is not strong");
    return { device: stats.dev, inode: stats.ino, real_path: await realpath(path) };
  } catch (error) {
    if (error instanceof ProductionControlError) throw error;
    throw pcError("PC_PATH_UNSAFE", "artifact directory identity could not be read");
  }
}

async function verifyRegularFile(path: string, expectedSize?: number, expectedDigest?: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) throw pcError("PC_PATH_UNSAFE", "artifact leaf must be a regular file");
    if (expectedSize !== undefined && stats.size !== expectedSize) throw pcError("PC_ARTIFACT_MISMATCH", "artifact size mismatch");
    if (expectedDigest !== undefined && sha256Bytes(await readFile(path)) !== expectedDigest) throw pcError("PC_ARTIFACT_MISMATCH", "artifact digest mismatch");
  } catch (error) {
    if (error instanceof ProductionControlError) throw error;
    throw pcError("PC_ARTIFACT_NOT_FOUND", "artifact is not available");
  }
}

async function assertFinalLeafAvailable(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw pcError("PC_PATH_UNSAFE", "artifact leaf must not be a symbolic link");
    throw pcError("PC_ARTIFACT_DUPLICATE", "artifact already exists");
  } catch (error) {
    if (error instanceof ProductionControlError) throw error;
    if (!isNotFound(error)) throw pcError("PC_PATH_UNSAFE", "artifact leaf could not be inspected");
  }
}

function assertContained(candidate: string, root: string): void {
  const fromRoot = relative(resolve(root), resolve(candidate));
  if (fromRoot === "" || fromRoot.startsWith("..") || fromRoot.includes("/..") || fromRoot.includes("\\..")) {
    throw pcError("PC_PATH_UNSAFE", "artifact path escapes containment root");
  }
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.real_path === right.real_path;
}

async function reserveLeaf(finalPath: string, reservationPath: string): Promise<FileIdentity> {
  await assertFinalLeafAvailable(finalPath);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      reservationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    await handle.sync();
  } catch (error) {
    if (isAlreadyExists(error)) {
      const stats = await lstat(reservationPath).catch(() => undefined);
      if (stats?.isSymbolicLink()) throw pcError("PC_PATH_UNSAFE", "artifact reservation leaf must not be a symbolic link");
      throw pcError("PC_ARTIFACT_DUPLICATE", "artifact already exists or is being created");
    }
    throw pcError("PC_PATH_UNSAFE", "artifact reservation failed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  try {
    return await captureFile(reservationPath);
  } catch (error) {
    await unlink(reservationPath).catch(() => undefined);
    throw error;
  }
}

async function captureFile(path: string): Promise<FileIdentity> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) throw pcError("PC_PATH_UNSAFE", "artifact reservation must be a regular file");
    return { device: stats.dev, inode: stats.ino };
  } catch (error) {
    if (error instanceof ProductionControlError) throw error;
    throw pcError("PC_PATH_UNSAFE", "artifact reservation identity could not be read");
  }
}

async function assertFileIdentity(path: string, expected: FileIdentity): Promise<void> {
  const live = await captureFile(path);
  if (live.device !== expected.device || live.inode !== expected.inode) {
    throw pcError("PC_PATH_UNSAFE", "artifact reservation identity changed");
  }
}

async function safeRemoveReservation(path: string, expected: FileIdentity): Promise<void> {
  try {
    await assertFileIdentity(path, expected);
    await unlink(path);
  } catch {
    // Never remove a replaced reservation leaf.
  }
}

async function withArtifactLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = artifactLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  artifactLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (artifactLocks.get(key) === current) artifactLocks.delete(key);
  }
}

function isSafeArtifactId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes("..");
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EEXIST");
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function randomSuffix(): string {
  return randomUUID();
}

async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    await handle.sync();
  } catch {
    throw pcError("PC_PATH_UNSAFE", "artifact directory could not be synced");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
