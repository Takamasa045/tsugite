/**
 * Safe download verification and atomic local pin.
 * Rejects path traversal, symlinks, and oversize payloads.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  GJ_DOWNLOAD_OVERSIZE,
  GJ_DOWNLOAD_REJECTED,
  GJ_HASH_MISMATCH,
  GJ_PATH_UNSAFE,
  GenerationJobError
} from "./errors.js";

export const DEFAULT_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024; // 512 MiB

export type PinOptions = {
  maxBytes?: number;
  expectedSha256?: string;
  relativeName?: string;
};

function assertSafeRelativeSegment(name: string): void {
  if (
    !name
    || name.includes("\0")
    || name.includes("\\")
    || name.includes("..")
    || name.startsWith("/")
    || isAbsolute(name)
    || name.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new GenerationJobError(
      GJ_PATH_UNSAFE,
      `unsafe relative path rejected: ${name}`
    );
  }
}

export function resolveContainedPath(root: string, relativePath: string): string {
  assertSafeRelativeSegment(relativePath);
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, relativePath);
  const rel = relative(resolvedRoot, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new GenerationJobError(
      GJ_PATH_UNSAFE,
      `path escapes job root: ${relativePath}`
    );
  }
  return candidate;
}

/**
 * Reject destination if it is a symlink or would follow a symlink parent.
 */
export async function assertNoSymlink(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new GenerationJobError(GJ_PATH_UNSAFE, `symlink rejected: ${path}`);
    }
  } catch (error) {
    if (error instanceof GenerationJobError) throw error;
    // missing is ok for new writes
  }
}

export async function sha256Buffer(data: Buffer | Uint8Array): Promise<string> {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  return sha256Buffer(await readFile(path));
}

/**
 * Write bytes atomically into destinationDir/relativeName, verify size and hash.
 */
export async function pinBytesAtomically(
  destinationDir: string,
  data: Buffer | Uint8Array,
  options: PinOptions = {}
): Promise<{ relative_path: string; absolute_path: string; sha256: string; byte_length: number }> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  if (data.byteLength > maxBytes) {
    throw new GenerationJobError(
      GJ_DOWNLOAD_OVERSIZE,
      `download size ${data.byteLength} exceeds max ${maxBytes}`
    );
  }

  const relativeName = options.relativeName ?? `artifact-${randomUUID()}.bin`;
  assertSafeRelativeSegment(relativeName);
  await mkdir(destinationDir, { recursive: true });
  await assertNoSymlink(destinationDir);

  const absolutePath = resolveContainedPath(destinationDir, relativeName);
  await assertNoSymlink(absolutePath);
  // Ensure parent is still under destinationDir and not a symlink chain.
  const parent = dirname(absolutePath);
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  const realDest = await realpath(destinationDir);
  if (!realParent.startsWith(realDest + sep) && realParent !== realDest) {
    throw new GenerationJobError(GJ_PATH_UNSAFE, "parent directory escapes destination root");
  }

  const digest = await sha256Buffer(data);
  if (options.expectedSha256 && options.expectedSha256 !== digest) {
    throw new GenerationJobError(
      GJ_HASH_MISMATCH,
      `download hash mismatch: expected ${options.expectedSha256}, got ${digest}`
    );
  }

  const temporary = join(parent, `.${basename(absolutePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { flag: "wx" });
    const tmpStat = await lstat(temporary);
    if (tmpStat.isSymbolicLink() || !tmpStat.isFile()) {
      throw new GenerationJobError(GJ_DOWNLOAD_REJECTED, "temporary download is not a regular file");
    }
    if (tmpStat.size !== data.byteLength) {
      throw new GenerationJobError(GJ_DOWNLOAD_REJECTED, "temporary download size mismatch");
    }
    const writtenHash = await sha256File(temporary);
    if (writtenHash !== digest) {
      throw new GenerationJobError(GJ_HASH_MISMATCH, "written file hash mismatch");
    }
    await rename(temporary, absolutePath);
  } finally {
    await rm(temporary, { force: true });
  }

  return {
    relative_path: relativeName.split(sep).join("/"),
    absolute_path: absolutePath,
    sha256: digest,
    byte_length: data.byteLength
  };
}

/**
 * Stream-like bounded write from an async iterable of chunks (for adapters).
 */
export async function pinStreamAtomically(
  destinationDir: string,
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  options: PinOptions & { contentLength?: number | null } = {}
): Promise<{ relative_path: string; absolute_path: string; sha256: string; byte_length: number }> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  if (options.contentLength != null && options.contentLength > maxBytes) {
    throw new GenerationJobError(
      GJ_DOWNLOAD_OVERSIZE,
      `Content-Length ${options.contentLength} exceeds max ${maxBytes}`
    );
  }

  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of chunks as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new GenerationJobError(
        GJ_DOWNLOAD_OVERSIZE,
        `stream exceeded max ${maxBytes} bytes`
      );
    }
    parts.push(Buffer.from(chunk));
  }
  if (options.contentLength != null && total !== options.contentLength) {
    throw new GenerationJobError(
      GJ_DOWNLOAD_REJECTED,
      `stream size ${total} does not match Content-Length ${options.contentLength}`
    );
  }
  return pinBytesAtomically(destinationDir, Buffer.concat(parts), options);
}

/**
 * Open a regular file for reading under root; reject symlink.
 */
export async function openContainedFile(root: string, relativePath: string) {
  const absolute = resolveContainedPath(root, relativePath);
  const handle = await open(absolute, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new GenerationJobError(GJ_PATH_UNSAFE, "not a regular file");
    }
    const linkInfo = await lstat(absolute);
    if (linkInfo.isSymbolicLink()) {
      throw new GenerationJobError(GJ_PATH_UNSAFE, "symlink rejected");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}
