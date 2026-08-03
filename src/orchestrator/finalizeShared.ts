import { lstat } from "node:fs/promises";
import { relative, sep } from "node:path";
import type { FinalizeFileIdentity } from "./finalizeJournal.js";

export function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorMessageOr(error: unknown, fallback: string): string {
  return error instanceof Error ? `${fallback}: ${error.message}` : fallback;
}

export function toProjectRelative(projectRoot: string, path: string): string {
  return relative(projectRoot, path).split(sep).join("/");
}

export function comparePath(left: string, right: string): number {
  return left.localeCompare(right);
}

export function basenameSafe(path: string): string {
  const parts = path.split(sep).filter(Boolean);
  return parts[parts.length - 1] ?? "media.bin";
}

export function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export async function pathExistsAny(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export async function captureStorageIdentityAt(
  path: string
): Promise<Pick<FinalizeFileIdentity, "size" | "mtimeMs" | "device" | "inode"> | undefined> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return undefined;
    return {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      device: stats.dev,
      inode: stats.ino
    };
  } catch {
    return undefined;
  }
}

export function sameFinalizeIdentity(
  left: FinalizeFileIdentity,
  right: FinalizeFileIdentity
): boolean {
  return left.path === right.path
    && sameFinalizeStorageIdentity(left, right);
}

/** Compare device/inode/size/mtime only (path may differ after quarantine rename). */
export function sameFinalizeStorageIdentity(
  left: Pick<FinalizeFileIdentity, "size" | "mtimeMs" | "device" | "inode">,
  right: Pick<FinalizeFileIdentity, "size" | "mtimeMs" | "device" | "inode">
): boolean {
  return left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.device === right.device
    && left.inode === right.inode;
}
