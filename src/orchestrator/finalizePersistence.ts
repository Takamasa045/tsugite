import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Safe atomic persistence for finalize completion-record and journal writes.
 *
 * Contract:
 * - never follow a leaf symlink (refuse instead of writing through it)
 * - re-verify parent + leaf immediately before create and before rename
 * - create the temp file in the same directory with O_CREAT|O_EXCL|O_NOFOLLOW
 * - write + fsync(file), re-check containment/identity, atomic rename, fsync(directory)
 * - never overwrite a project-external symlink target
 * - read/unlink only after containWithin boundary + O_NOFOLLOW checks
 */

export type RegularFileIdentity = {
  path: string;
  size: number;
  mtimeMs: number;
  device: number;
  inode: number;
};

export type DirectoryIdentity = {
  path: string;
  realPath: string;
  device: number;
  inode: number;
};

export class FinalizePersistenceError extends Error {
  readonly code: string;
  readonly path?: string;

  constructor(issue: { code: string; message: string; path?: string }) {
    super(issue.message);
    this.name = "FinalizePersistenceError";
    this.code = issue.code;
    if (issue.path !== undefined) this.path = issue.path;
  }
}

export type WriteAtomicRegularFileOptions = {
  path: string;
  contents: string;
  /**
   * Optional containment root. When set, parent realpath must stay inside this root
   * both before create and before rename.
   */
  containWithin?: string;
  /** Optional mode for the temporary file (default 0o600). */
  mode?: number;
};

/**
 * Persist text to a regular-file path without ever following a leaf symlink.
 */
export async function writeAtomicRegularFile(
  options: WriteAtomicRegularFileOptions
): Promise<void> {
  const targetPath = resolve(options.path);
  const parentPath = dirname(targetPath);
  const mode = options.mode ?? 0o600;
  const nofollow = constants.O_NOFOLLOW ?? 0;

  const parentBefore = await assertWritableParent(parentPath, options.containWithin);
  await assertLeafSafeForReplace(targetPath);

  const temporaryName = `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`;
  const temporaryPath = join(parentPath, temporaryName);

  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow,
      mode
    );
    await handle.writeFile(options.contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    // Re-verify parent identity/containment and leaf safety immediately before rename.
    const parentAfter = await assertWritableParent(parentPath, options.containWithin);
    if (
      parentAfter.device !== parentBefore.device
      || parentAfter.inode !== parentBefore.inode
      || parentAfter.realPath !== parentBefore.realPath
    ) {
      throw new FinalizePersistenceError({
        code: "finalize.persist_parent_changed",
        message: "finalize atomic write parent directory identity changed before rename",
        path: parentPath
      });
    }
    await assertLeafSafeForReplace(targetPath);

    await rename(temporaryPath, targetPath);
    await fsyncDirectory(parentPath);
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // preserve original error
    }
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function captureDirectoryIdentity(path: string): Promise<DirectoryIdentity> {
  const resolved = resolve(path);
  const stats = await lstat(resolved);
  if (stats.isSymbolicLink()) {
    throw new FinalizePersistenceError({
      code: "finalize.path_symlink",
      message: "expected a real directory, found a symbolic link",
      path: resolved
    });
  }
  if (!stats.isDirectory()) {
    throw new FinalizePersistenceError({
      code: "finalize.path_not_directory",
      message: "expected a real directory",
      path: resolved
    });
  }
  const real = await realpath(resolved);
  return {
    path: resolved,
    realPath: real,
    device: stats.dev,
    inode: stats.ino
  };
}

/**
 * Read a regular file only when the path stays inside `containWithin` without symlink
 * ancestors or a leaf symlink. Uses O_NOFOLLOW and re-checks identity around the open.
 */
export async function readContainedRegularFileText(input: {
  path: string;
  containWithin: string;
}): Promise<
  | { status: "missing" }
  | { status: "ok"; text: string }
  | { status: "unsafe"; code: string; message: string; path: string }
> {
  const targetPath = resolve(input.path);
  const container = resolve(input.containWithin);
  try {
    await assertContainedRegularFilePath({
      path: targetPath,
      containWithin: container,
      allowMissing: true
    });
  } catch (error) {
    if (error instanceof FinalizePersistenceError) {
      if (error.code === "finalize.persist_leaf_missing") return { status: "missing" };
      return {
        status: "unsafe",
        code: error.code,
        message: error.message,
        path: error.path ?? targetPath
      };
    }
    throw error;
  }

  let leafBefore: RegularFileIdentity;
  try {
    leafBefore = await captureRegularFileIdentity(targetPath);
  } catch (error) {
    if (error instanceof FinalizePersistenceError && error.code === "finalize.persist_leaf_missing") {
      return { status: "missing" };
    }
    if (error instanceof FinalizePersistenceError) {
      return {
        status: "unsafe",
        code: error.code,
        message: error.message,
        path: error.path ?? targetPath
      };
    }
    throw error;
  }

  const parentBefore = await assertWritableParent(dirname(targetPath), container);
  const nofollow = constants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(targetPath, constants.O_RDONLY | nofollow);
    const leafAfterOpen = await captureRegularFileIdentity(targetPath);
    if (!sameRegularFileIdentity(leafBefore, leafAfterOpen)) {
      return {
        status: "unsafe",
        code: "finalize.persist_leaf_changed",
        message: "finalize regular-file identity changed before read",
        path: targetPath
      };
    }
    const parentAfterOpen = await assertWritableParent(dirname(targetPath), container);
    if (!sameDirectoryIdentity(parentBefore, parentAfterOpen)) {
      return {
        status: "unsafe",
        code: "finalize.persist_parent_changed",
        message: "finalize regular-file parent identity changed before read",
        path: dirname(targetPath)
      };
    }
    const text = await handle.readFile("utf8");
    return { status: "ok", text };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { status: "missing" };
    if (isNodeError(error, "ELOOP")) {
      return {
        status: "unsafe",
        code: "finalize.persist_leaf_symlink",
        message: "finalize refuses to follow a leaf symbolic link when reading",
        path: targetPath
      };
    }
    return {
      status: "unsafe",
      code: "finalize.persist_read_failed",
      message: error instanceof Error
        ? `finalize could not read regular file: ${error.message}`
        : "finalize could not read regular file",
      path: targetPath
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Unlink a regular file only when the path stays inside `containWithin` without symlink
 * ancestors or a leaf symlink. Re-checks parent/leaf identity immediately before unlink.
 * Missing files are a no-op.
 */
export async function unlinkContainedRegularFile(input: {
  path: string;
  containWithin: string;
}): Promise<void> {
  const targetPath = resolve(input.path);
  const container = resolve(input.containWithin);

  let leafBefore: RegularFileIdentity;
  try {
    await assertContainedRegularFilePath({
      path: targetPath,
      containWithin: container,
      allowMissing: true
    });
    leafBefore = await captureRegularFileIdentity(targetPath);
  } catch (error) {
    if (error instanceof FinalizePersistenceError && error.code === "finalize.persist_leaf_missing") {
      return;
    }
    throw error;
  }

  const parentBefore = await assertWritableParent(dirname(targetPath), container);

  // Re-verify immediately before unlink so a swapped parent/leaf cannot redirect the delete.
  await assertContainedRegularFilePath({
    path: targetPath,
    containWithin: container,
    allowMissing: false
  });
  const leafAfter = await captureRegularFileIdentity(targetPath);
  if (!sameRegularFileIdentity(leafBefore, leafAfter)) {
    throw new FinalizePersistenceError({
      code: "finalize.persist_leaf_changed",
      message: "finalize regular-file identity changed before unlink",
      path: targetPath
    });
  }
  const parentAfter = await assertWritableParent(dirname(targetPath), container);
  if (!sameDirectoryIdentity(parentBefore, parentAfter)) {
    throw new FinalizePersistenceError({
      code: "finalize.persist_parent_changed",
      message: "finalize regular-file parent identity changed before unlink",
      path: dirname(targetPath)
    });
  }

  try {
    await unlink(targetPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
}

/**
 * Ensure parent directories of a target file exist strictly inside `containWithin`.
 *
 * Fail closed before any mkdir when an existing path component is a symlink (or escapes).
 * Creates missing segments one-by-one (never recursive mkdir that can follow mid-path links).
 * Re-verifies boundary identity and no-symlink after each create (TOCTOU).
 */
export async function ensureContainedParentDirs(input: {
  /** Absolute or relative path to the file whose parent dirs should exist. */
  filePath: string;
  containWithin: string;
}): Promise<void> {
  const targetPath = resolve(input.filePath);
  const parentPath = dirname(targetPath);
  const container = resolve(input.containWithin);

  if (!isWithinPath(container, targetPath) || !isWithinPath(container, parentPath)) {
    throw new FinalizePersistenceError({
      code: "finalize.persist_outside_container",
      message: "finalize path escaped its containment root",
      path: targetPath
    });
  }

  // Boundary must be a real directory; refuse symlink-substituted homes before any mkdir.
  const boundaryBefore = await captureDirectoryIdentity(container);

  // Existing path components must not be symlinks — check the full parent before creating.
  if (await hasSymlinkAlongPath(container, parentPath)) {
    throw new FinalizePersistenceError({
      code: "finalize.persist_path_symlink",
      message: "finalize path must not be a symbolic link or have a symbolic-link ancestor",
      path: parentPath
    });
  }

  const relativeParent = relative(container, parentPath);
  if (relativeParent === "" || relativeParent === ".") {
    const boundaryAfter = await captureDirectoryIdentity(container);
    if (!sameDirectoryIdentity(boundaryBefore, boundaryAfter)) {
      throw new FinalizePersistenceError({
        code: "finalize.persist_container_changed",
        message: "finalize containment root identity changed during parent mkdir",
        path: container
      });
    }
    return;
  }

  let current = container;
  for (const part of relativeParent.split(sep).filter(Boolean)) {
    current = join(current, part);
    // Re-check before each step so a concurrent swap cannot redirect creation.
    if (await hasSymlinkAlongPath(container, current)) {
      throw new FinalizePersistenceError({
        code: "finalize.persist_path_symlink",
        message: "finalize path must not be a symbolic link or have a symbolic-link ancestor",
        path: current
      });
    }
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new FinalizePersistenceError({
          code: "finalize.persist_path_symlink",
          message: "finalize path must not be a symbolic link or have a symbolic-link ancestor",
          path: current
        });
      }
      if (!stats.isDirectory()) {
        throw new FinalizePersistenceError({
          code: "finalize.persist_parent_not_directory",
          message: "finalize parent path component must be a real directory",
          path: current
        });
      }
    } catch (error) {
      if (error instanceof FinalizePersistenceError) throw error;
      if (!isNodeError(error, "ENOENT")) throw error;
      // Create only this segment; recursive:false so we never traverse a mid-path link.
      try {
        await mkdir(current, { recursive: false });
      } catch (mkdirError) {
        // Concurrent create: accept only if the live path is still a real directory in-bound.
        if (!isNodeError(mkdirError, "EEXIST")) throw mkdirError;
      }
      let afterStats;
      try {
        afterStats = await lstat(current);
      } catch (afterError) {
        throw new FinalizePersistenceError({
          code: "finalize.persist_parent_missing",
          message: afterError instanceof Error
            ? `finalize parent directory missing after create: ${afterError.message}`
            : "finalize parent directory missing after create",
          path: current
        });
      }
      if (afterStats.isSymbolicLink()) {
        throw new FinalizePersistenceError({
          code: "finalize.persist_path_symlink",
          message: "finalize path must not be a symbolic link or have a symbolic-link ancestor",
          path: current
        });
      }
      if (!afterStats.isDirectory()) {
        throw new FinalizePersistenceError({
          code: "finalize.persist_parent_not_directory",
          message: "finalize parent path component must be a real directory",
          path: current
        });
      }
      if (await hasSymlinkAlongPath(container, current)) {
        throw new FinalizePersistenceError({
          code: "finalize.persist_path_symlink",
          message: "finalize path must not be a symbolic link or have a symbolic-link ancestor",
          path: current
        });
      }
      const realCurrent = await realpath(current);
      if (!isWithinPath(boundaryBefore.realPath, realCurrent)) {
        throw new FinalizePersistenceError({
          code: "finalize.persist_outside_container",
          message: "finalize parent directory realpath escaped its containment root",
          path: current
        });
      }
    }
  }

  const boundaryAfter = await captureDirectoryIdentity(container);
  if (!sameDirectoryIdentity(boundaryBefore, boundaryAfter)) {
    throw new FinalizePersistenceError({
      code: "finalize.persist_container_changed",
      message: "finalize containment root identity changed during parent mkdir",
      path: container
    });
  }
  // Final check that the full parent path is still clean and inside the container.
  if (await hasSymlinkAlongPath(container, parentPath)) {
    throw new FinalizePersistenceError({
      code: "finalize.persist_path_symlink",
      message: "finalize path must not be a symbolic link or have a symbolic-link ancestor",
      path: parentPath
    });
  }
  await assertWritableParent(parentPath, container);
}

/**
 * Validate that targetPath is a regular file (or missing) strictly inside containWithin,
 * with no symlink ancestors from the boundary root through the leaf.
 */
export async function assertContainedRegularFilePath(input: {
  path: string;
  containWithin: string;
  allowMissing: boolean;
}): Promise<void> {
  const targetPath = resolve(input.path);
  const container = resolve(input.containWithin);

  if (!isWithinPath(container, targetPath)) {
    throw new FinalizePersistenceError({
      code: "finalize.persist_outside_container",
      message: "finalize path escaped its containment root",
      path: targetPath
    });
  }

  // Boundary root itself must be a real directory; refuse symlink-substituted homes/stateDirs.
  const containerIdentity = await captureDirectoryIdentity(container);
  if (await hasSymlinkAlongPath(container, targetPath)) {
    throw new FinalizePersistenceError({
      code: "finalize.persist_path_symlink",
      message: "finalize path must not be a symbolic link or have a symbolic-link ancestor",
      path: targetPath
    });
  }

  let stats;
  try {
    stats = await lstat(targetPath);
  } catch (error) {
    if (input.allowMissing && isNodeError(error, "ENOENT")) {
      // Walk to the nearest existing ancestor under the container. Missing parents are
      // still "missing leaf" as long as no symlink ancestor exists on the live prefix.
      let current = dirname(targetPath);
      while (true) {
        if (!isWithinPath(container, current) && current !== container) {
          throw new FinalizePersistenceError({
            code: "finalize.persist_outside_container",
            message: "finalize path escaped its containment root",
            path: targetPath
          });
        }
        try {
          await assertWritableParent(current, container);
          break;
        } catch (parentError) {
          if (
            parentError instanceof FinalizePersistenceError
            && parentError.code === "finalize.persist_parent_missing"
          ) {
            if (current === container) {
              // Container exists (captured above) but nothing below does.
              break;
            }
            const parent = dirname(current);
            if (parent === current) break;
            current = parent;
            continue;
          }
          throw parentError;
        }
      }
      const liveContainer = await captureDirectoryIdentity(container);
      if (!sameDirectoryIdentity(containerIdentity, liveContainer)) {
        throw new FinalizePersistenceError({
          code: "finalize.persist_container_changed",
          message: "finalize containment root identity changed during path validation",
          path: container
        });
      }
      throw new FinalizePersistenceError({
        code: "finalize.persist_leaf_missing",
        message: "finalize path is missing",
        path: targetPath
      });
    }
    throw error;
  }

  if (stats.isSymbolicLink()) {
    throw new FinalizePersistenceError({
      code: "finalize.persist_leaf_symlink",
      message: "finalize refuses to follow or mutate a leaf symbolic link",
      path: targetPath
    });
  }
  if (!stats.isFile()) {
    throw new FinalizePersistenceError({
      code: "finalize.persist_leaf_not_file",
      message: "finalize path must be a regular file",
      path: targetPath
    });
  }

  const realTarget = await realpath(targetPath);
  if (!isWithinPath(containerIdentity.realPath, realTarget)) {
    throw new FinalizePersistenceError({
      code: "finalize.persist_outside_container",
      message: "finalize path realpath escaped its containment root",
      path: targetPath
    });
  }
}

async function captureRegularFileIdentity(path: string): Promise<RegularFileIdentity> {
  const resolved = resolve(path);
  let stats;
  try {
    stats = await lstat(resolved);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new FinalizePersistenceError({
        code: "finalize.persist_leaf_missing",
        message: "finalize path is missing",
        path: resolved
      });
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new FinalizePersistenceError({
      code: "finalize.persist_leaf_symlink",
      message: "finalize refuses to follow or mutate a leaf symbolic link",
      path: resolved
    });
  }
  if (!stats.isFile()) {
    throw new FinalizePersistenceError({
      code: "finalize.persist_leaf_not_file",
      message: "finalize path must be a regular file",
      path: resolved
    });
  }
  return {
    path: resolved,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    device: stats.dev,
    inode: stats.ino
  };
}

function sameRegularFileIdentity(left: RegularFileIdentity, right: RegularFileIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.path === right.path;
}

export function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.realPath === right.realPath
    && left.path === right.path;
}

export async function assertDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity
): Promise<DirectoryIdentity> {
  const live = await captureDirectoryIdentity(path);
  if (
    live.device !== expected.device
    || live.inode !== expected.inode
    || live.realPath !== expected.realPath
  ) {
    throw new FinalizePersistenceError({
      code: "finalize.state_dir_changed",
      message: "state directory identity changed after preflight",
      path: resolve(path)
    });
  }
  return live;
}

export function isWithinPath(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return relativePath === ""
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

/**
 * True when `candidate` escapes `root`, any path component is a symlink, or an intermediate
 * component is not a directory (cannot host a contained child). Fail closed on ENOTDIR.
 * Missing suffix after a clean prefix returns false (no live symlink on the existing path).
 */
export async function hasSymlinkAlongPath(root: string, candidate: string): Promise<boolean> {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const relativePath = relative(resolvedRoot, resolvedCandidate);
  if (
    relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    return true;
  }
  let current = resolvedRoot;
  try {
    if ((await lstat(current)).isSymbolicLink()) return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    throw error;
  }
  const parts = relativePath.split(sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) return true;
      const isLast = i === parts.length - 1;
      // Intermediate non-directories (e.g. a regular file where a project dir should be)
      // cannot host a contained path — treat as unsafe, same as a symlink escape.
      if (!isLast && !stats.isDirectory()) return true;
    } catch (error) {
      // Missing suffix: no further symlink components exist on this path.
      if (isNodeError(error, "ENOENT")) return false;
      // ENOTDIR when an earlier component is a non-directory file.
      if (isNodeError(error, "ENOTDIR")) return true;
      throw error;
    }
  }
  return false;
}

async function assertWritableParent(
  parentPath: string,
  containWithin?: string
): Promise<DirectoryIdentity> {
  let stats;
  try {
    stats = await lstat(parentPath);
  } catch (error) {
    throw new FinalizePersistenceError({
      code: "finalize.persist_parent_missing",
      message: error instanceof Error
        ? `finalize atomic write parent is missing: ${error.message}`
        : "finalize atomic write parent is missing",
      path: parentPath
    });
  }
  if (stats.isSymbolicLink()) {
    throw new FinalizePersistenceError({
      code: "finalize.persist_parent_symlink",
      message: "finalize atomic write parent must not be a symbolic link",
      path: parentPath
    });
  }
  if (!stats.isDirectory()) {
    throw new FinalizePersistenceError({
      code: "finalize.persist_parent_not_directory",
      message: "finalize atomic write parent must be a real directory",
      path: parentPath
    });
  }
  // Only inspect symlink ancestors inside the containment root (never walk to FS root:
  // macOS /tmp -> /private/tmp would otherwise reject every write).
  if (containWithin) {
    const container = resolve(containWithin);
    if (await hasSymlinkAlongPath(container, parentPath)) {
      throw new FinalizePersistenceError({
        code: "finalize.persist_parent_symlink",
        message: "finalize atomic write parent path contains a symbolic-link ancestor",
        path: parentPath
      });
    }
  }
  const realParent = await realpath(parentPath);
  if (containWithin) {
    const realRoot = await realpath(resolve(containWithin)).catch(() => resolve(containWithin));
    if (!isWithinPath(realRoot, realParent)) {
      throw new FinalizePersistenceError({
        code: "finalize.persist_outside_container",
        message: "finalize atomic write parent escaped its containment root",
        path: parentPath
      });
    }
  }
  return {
    path: resolve(parentPath),
    realPath: realParent,
    device: stats.dev,
    inode: stats.ino
  };
}

/**
 * Refuse to write through a leaf symlink (would replace or follow into an external target).
 * Missing leaf is OK. Regular files and non-symlink non-files (e.g. directories) are left for rename to handle.
 */
async function assertLeafSafeForReplace(targetPath: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(targetPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new FinalizePersistenceError({
      code: "finalize.persist_leaf_symlink",
      message: "finalize refuses to follow or replace a leaf symbolic link",
      path: targetPath
    });
  }
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directoryPath, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
