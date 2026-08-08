/**
 * Safe download verification and atomic local pin.
 * Rejects path traversal, symlinks, and oversize payloads.
 * Streams to disk; never holds the full payload in memory for stream pin.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  createWriteStream,
  lstatSync
} from "node:fs";
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
import { finished } from "node:stream/promises";
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

export type PinResult = {
  relative_path: string;
  absolute_path: string;
  sha256: string;
  byte_length: number;
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
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const stream = handle.createReadStream();
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function preparePinDestination(
  destinationDir: string,
  relativeName: string
): Promise<{ absolutePath: string; parent: string; realDest: string }> {
  assertSafeRelativeSegment(relativeName);
  await mkdir(destinationDir, { recursive: true });
  await assertNoSymlink(destinationDir);

  const absolutePath = resolveContainedPath(destinationDir, relativeName);
  await assertNoSymlink(absolutePath);
  const parent = dirname(absolutePath);
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  const realDest = await realpath(destinationDir);
  if (!realParent.startsWith(realDest + sep) && realParent !== realDest) {
    throw new GenerationJobError(GJ_PATH_UNSAFE, "parent directory escapes destination root");
  }
  return { absolutePath, parent, realDest };
}

/**
 * Write bytes atomically into destinationDir/relativeName, verify size and hash.
 */
export async function pinBytesAtomically(
  destinationDir: string,
  data: Buffer | Uint8Array,
  options: PinOptions = {}
): Promise<PinResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  if (data.byteLength > maxBytes) {
    throw new GenerationJobError(
      GJ_DOWNLOAD_OVERSIZE,
      `download size ${data.byteLength} exceeds max ${maxBytes}`
    );
  }

  const relativeName = options.relativeName ?? `artifact-${randomUUID()}.bin`;
  const { absolutePath, parent } = await preparePinDestination(destinationDir, relativeName);

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
 * Stream bounded write: incremental temp-file write + streaming SHA-256 + byte cap + fsync + atomic rename.
 * Does not retain all chunks in memory (memory does not grow proportional to payload size).
 */
export async function pinStreamAtomically(
  destinationDir: string,
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  options: PinOptions & { contentLength?: number | null } = {}
): Promise<PinResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  if (options.contentLength != null && options.contentLength > maxBytes) {
    throw new GenerationJobError(
      GJ_DOWNLOAD_OVERSIZE,
      `Content-Length ${options.contentLength} exceeds max ${maxBytes}`
    );
  }

  const relativeName = options.relativeName ?? `artifact-${randomUUID()}.bin`;
  const { absolutePath, parent } = await preparePinDestination(destinationDir, relativeName);
  const temporary = join(parent, `.${basename(absolutePath)}.${randomUUID()}.tmp`);

  const hash = createHash("sha256");
  let total = 0;

  try {
    const stream = createWriteStream(temporary, { flags: "wx" });
    try {
      for await (const chunk of chunks as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          stream.destroy();
          throw new GenerationJobError(
            GJ_DOWNLOAD_OVERSIZE,
            `stream exceeded max ${maxBytes} bytes`
          );
        }
        hash.update(chunk);
        if (!stream.write(Buffer.from(chunk))) {
          await new Promise<void>((resolveWrite, rejectWrite) => {
            stream.once("drain", () => resolveWrite());
            stream.once("error", rejectWrite);
          });
        }
      }
      stream.end();
      await finished(stream);
    } catch (error) {
      stream.destroy();
      throw error;
    }

    // fsync via reopen
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (options.contentLength != null && total !== options.contentLength) {
      throw new GenerationJobError(
        GJ_DOWNLOAD_REJECTED,
        `stream size ${total} does not match Content-Length ${options.contentLength}`
      );
    }

    const digest = hash.digest("hex");
    if (options.expectedSha256 && options.expectedSha256 !== digest) {
      throw new GenerationJobError(
        GJ_HASH_MISMATCH,
        `download hash mismatch: expected ${options.expectedSha256}, got ${digest}`
      );
    }

    const tmpStat = await lstat(temporary);
    if (tmpStat.isSymbolicLink() || !tmpStat.isFile()) {
      throw new GenerationJobError(GJ_DOWNLOAD_REJECTED, "temporary download is not a regular file");
    }
    if (tmpStat.size !== total) {
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
    sha256: (await sha256File(absolutePath)),
    byte_length: total
  };
}

/**
 * Core verification of adapter-reported download.
 * Never trusts adapter self-reported hash/path alone for verified/pinned.
 */
export async function verifyAdapterArtifact(
  artifactsDir: string,
  claimed: {
    absolute_path: string;
    sha256: string;
    byte_length: number;
    content_type?: string;
  }
): Promise<PinResult & { content_type?: string }> {
  const resolvedRoot = resolve(artifactsDir);
  let realRoot: string;
  try {
    realRoot = await realpath(resolvedRoot);
  } catch {
    throw new GenerationJobError(GJ_PATH_UNSAFE, "artifacts directory is not resolvable");
  }

  const claimedPath = claimed.absolute_path;
  if (!claimedPath || claimedPath.includes("\0")) {
    throw new GenerationJobError(GJ_PATH_UNSAFE, "adapter absolute_path is unsafe");
  }

  // Reject before realpath if relative path escapes via string checks.
  const resolvedClaimed = resolve(claimedPath);

  // Sibling-prefix attack: artifactsDir=/a/job vs /a/job-evil
  const rootPrefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  // Use path.relative after realpath of the file (regular file only).
  let linkInfo;
  try {
    linkInfo = await lstat(resolvedClaimed);
  } catch {
    throw new GenerationJobError(GJ_PATH_UNSAFE, "adapter absolute_path does not exist");
  }
  if (linkInfo.isSymbolicLink()) {
    throw new GenerationJobError(GJ_PATH_UNSAFE, "adapter absolute_path is a symlink");
  }
  if (!linkInfo.isFile()) {
    throw new GenerationJobError(GJ_PATH_UNSAFE, "adapter absolute_path is not a regular file");
  }

  let realFile: string;
  try {
    realFile = await realpath(resolvedClaimed);
  } catch {
    throw new GenerationJobError(GJ_PATH_UNSAFE, "adapter absolute_path realpath failed");
  }

  const rel = relative(realRoot, realFile);
  if (
    rel.startsWith("..")
    || isAbsolute(rel)
    || rel.includes("\0")
    || !realFile.startsWith(rootPrefix) && realFile !== realRoot
  ) {
    throw new GenerationJobError(
      GJ_PATH_UNSAFE,
      `adapter absolute_path escapes artifacts dir: ${claimedPath}`
    );
  }

  // Re-open as regular non-symlink file and recompute size + SHA-256.
  const handle = await open(realFile, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new GenerationJobError(GJ_PATH_UNSAFE, "reopened path is not a regular file");
    }
    // Confirm still not a symlink at the path we opened.
    if (lstatSync(realFile).isSymbolicLink()) {
      throw new GenerationJobError(GJ_PATH_UNSAFE, "path became a symlink");
    }
    if (info.size !== claimed.byte_length) {
      throw new GenerationJobError(
        GJ_DOWNLOAD_REJECTED,
        `size mismatch: claimed ${claimed.byte_length}, actual ${info.size}`
      );
    }
    const hash = createHash("sha256");
    const stream = handle.createReadStream();
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }
    const digest = hash.digest("hex");
    if (digest !== claimed.sha256) {
      throw new GenerationJobError(
        GJ_HASH_MISMATCH,
        `hash mismatch: claimed ${claimed.sha256}, actual ${digest}`
      );
    }
    return {
      relative_path: rel.split(sep).join("/"),
      absolute_path: realFile,
      sha256: digest,
      byte_length: info.size,
      content_type: claimed.content_type
    };
  } finally {
    await handle.close();
  }
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
