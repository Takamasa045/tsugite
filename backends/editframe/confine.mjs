import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function confinedError(message, exitCode = 10) {
  return Object.assign(new Error(message), { exitCode });
}

export function isPathWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function isExternalAssetPath(value) {
  const path = String(value).trim();
  return path.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(path);
}

export async function walkDownToRoot(startPath, stopRoot) {
  const stop = resolve(stopRoot);
  const seen = new Set();
  const paths = [];
  let current = resolve(startPath);
  while (!seen.has(current)) {
    seen.add(current);
    paths.push(current);
    if (current === stop) break;
    if (!isPathWithin(stop, current) && current !== stop) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return paths;
}

export async function assertNoSymlinkBetween(targetPath, stopRoot, label) {
  for (const ancestor of await walkDownToRoot(targetPath, stopRoot)) {
    let info;
    try {
      info = await lstat(ancestor);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) {
      throw confinedError(`${label} must not use a symlink ancestor: ${ancestor}`);
    }
  }
}

export async function assertRegularFile(path, label, stopRoot = dirname(path)) {
  await assertNoSymlinkBetween(path, stopRoot, label);
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw confinedError(`${label} must reference a readable run asset`);
  }
  if (info.isSymbolicLink()) {
    throw confinedError(`${label} must not be a symlink`);
  }
  if (!info.isFile()) {
    throw confinedError(`${label} must be a regular file`);
  }
  return info;
}

export async function assertDirectory(path, label) {
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw confinedError(`${label} must be a directory`);
  }
  if (info.isSymbolicLink()) {
    throw confinedError(`${label} must not be a symlink`);
  }
  if (!info.isDirectory()) {
    throw confinedError(`${label} must be a directory`);
  }
  return info;
}

export async function fileIdentity(path) {
  const info = await lstat(path);
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs
  };
}

export function sameIdentity(left, right) {
  return (
    left &&
    right &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

export async function mkdirOwned(dir, stopRoot, label) {
  await assertNoSymlinkBetween(dir, stopRoot, label);
  try {
    const info = await lstat(dir);
    if (info.isSymbolicLink()) {
      throw confinedError(`${label} must not be a symlink`);
    }
    if (!info.isDirectory()) {
      throw confinedError(`${label} exists and is not a directory`);
    }
    return;
  } catch (error) {
    if (error && error.exitCode === 10) throw error;
    if (error && error.code !== "ENOENT") throw error;
  }
  await mkdir(dir, { recursive: true });
  await assertDirectory(dir, label);
}

export async function writeSafeFile(destination, contents, stopRoot) {
  await assertNoSymlinkBetween(destination, stopRoot, "generated file");
  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink()) {
      throw confinedError("generated destination must not be a symlink");
    }
    if (!existing.isFile()) {
      throw confinedError("generated destination exists and is not a regular file");
    }
    await unlink(destination);
  } catch (error) {
    if (error && error.exitCode === 10) throw error;
    if (error && error.code !== "ENOENT") throw error;
  }
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY;
  const destFlags = process.platform === "win32" ? flags : flags | constants.O_NOFOLLOW;
  let handle;
  try {
    handle = await open(destination, destFlags, 0o644);
  } catch (error) {
    throw confinedError(
      `generated destination is not a safe exclusive file: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
}
