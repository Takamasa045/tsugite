import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export class SafePathError extends Error {
  readonly code: string;
  readonly path?: string;

  constructor(issue: { code: string; message: string; path?: string }) {
    super(issue.message);
    this.name = "SafePathError";
    this.code = issue.code;
    if (issue.path !== undefined) this.path = issue.path;
  }
}

export async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function existingDirectory(path: string, code: string): Promise<string> {
  try {
    const resolved = await realpath(resolve(path));
    if (!(await stat(resolved)).isDirectory()) fail(code, "directory is required", path);
    return resolved;
  } catch (error) {
    if (error instanceof SafePathError) throw error;
    fail(code, "directory was not found", path);
  }
}

export async function containedDirectory(candidate: string, root: string, code: string): Promise<string> {
  const resolved = await existingDirectory(candidate, code);
  if (!isWithin(resolved, root)) fail(code, "directory escapes its allowed root", candidate);
  return resolved;
}

export async function containedFile(candidate: string, root: string, code: string): Promise<string> {
  try {
    const [resolvedRoot, resolvedFile] = await Promise.all([realpath(root), realpath(candidate)]);
    if (!isWithin(resolvedFile, resolvedRoot)) fail(code, "file escapes its allowed root", candidate);
    if (!(await stat(resolvedFile)).isFile()) fail(code, "regular file is required", candidate);
    return resolvedFile;
  } catch (error) {
    if (error instanceof SafePathError) throw error;
    fail(code, "file was not found", candidate);
  }
}

export function isWithin(candidate: string, root: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

export function portableRelative(from: string, to: string): string {
  return relative(from, to).split("\\").join("/");
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function fail(code: string, message: string, path?: string): never {
  throw new SafePathError({ code, message, ...(path ? { path } : {}) });
}
