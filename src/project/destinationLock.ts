import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep
} from "node:path";

/**
 * Injectable path surface for trusted-anchor selection.
 * Production uses the host platform path API; Windows regression tests inject path.win32.
 */
export type TrustedPathAnchorPathApi = {
  resolve: (...paths: string[]) => string;
  relative: (from: string, to: string) => string;
  isAbsolute: (path: string) => boolean;
  parse: (path: string) => { root: string };
  sep: string;
};

const platformPathApi: TrustedPathAnchorPathApi = {
  resolve,
  relative,
  isAbsolute,
  parse,
  sep
};

/**
 * Must match promotionJournal.PROMOTION_JOURNAL_DIR_NAME. Duplicated here to keep
 * the lock module free of a circular import with promotionJournal recovery.
 */
const PROMOTION_JOURNAL_DIR_NAME = ".tsugite-promote-journal";

/**
 * Destination-scoped exclusive lock for durable promotion / recovery.
 *
 * Held while a shared launcher destination (or its backup/journal) is mutated so
 * concurrent finalize/recovery cannot interleave journal, backup, or
 * completion-record writes for the same destination.
 *
 * Lock files live under the projects-home journal directory:
 *   <projectsHome>/.tsugite-promote-journal/<dest-basename>.lock
 *
 * Acquisition order contract (deadlock avoidance):
 * 1. project-local run lock (if any)
 * 2. destination lock(s), always by resolved destination_root ascending
 * Never acquire a run lock while holding a destination lock.
 */

export type DestinationLock = {
  projectsHome: string;
  destinationRoot: string;
  token: string;
  release: () => Promise<void>;
};

export type AcquireDestinationLockOptions = {
  /**
   * When true, wait briefly for a live holder to release (best-effort).
   * When false/omitted, fail immediately with DestinationLockedError.
   */
  wait?: boolean;
  /** Max wait budget when wait=true (default 2000ms). */
  waitMs?: number;
  /** Poll interval when wait=true (default 50ms). */
  pollMs?: number;
  /** @internal test-only hooks. Never wired from CLI. */
  _testHooks?: {
    afterIdentityCheckBeforeOpen?: () => Promise<void>;
    afterLockCreatedBeforeValidate?: () => Promise<void>;
  };
};

type NodeIdentity = {
  device: number;
  inode: number;
};

export class DestinationLockedError extends Error {
  readonly code = "promotion.destination_locked";
  readonly path?: string;

  constructor(destinationRoot: string) {
    super(`durable destination is locked by another process: ${destinationRoot}`);
    this.name = "DestinationLockedError";
    this.path = destinationRoot;
  }
}

export class DestinationLockBoundaryError extends Error {
  readonly code: string;
  readonly path?: string;

  constructor(issue: { code: string; message: string; path?: string }) {
    super(issue.message);
    this.name = "DestinationLockBoundaryError";
    this.code = issue.code;
    if (issue.path !== undefined) this.path = issue.path;
  }
}

export function destinationLockPath(projectsHome: string, destinationRoot: string): string {
  const name = sanitizeLockFileName(basename(resolve(destinationRoot)));
  return join(resolve(projectsHome), PROMOTION_JOURNAL_DIR_NAME, `${name}.lock`);
}

/**
 * Acquire an exclusive destination lock. Fails closed on symlink journal roots
 * and on a live lock holder (unless wait=true and the holder releases in time).
 */
export async function acquireDestinationLock(
  projectsHome: string,
  destinationRoot: string,
  options: AcquireDestinationLockOptions = {}
): Promise<DestinationLock> {
  const home = resolve(projectsHome);
  const dest = resolve(destinationRoot);
  const lockPath = destinationLockPath(home, dest);
  const journalDir = join(home, PROMOTION_JOURNAL_DIR_NAME);
  const wait = options.wait === true;
  const waitMs = options.waitMs ?? 2000;
  const pollMs = options.pollMs ?? 50;
  const deadline = Date.now() + waitMs;

  // Ensure journal dir exists as a real directory (never through a symlink leaf).
  await ensureRealJournalDir(home, journalDir);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await tryAcquireDestinationLockOnce(home, dest, lockPath, journalDir, options);
    } catch (error) {
      if (!(error instanceof DestinationLockedError)) throw error;
      if (!wait || Date.now() >= deadline) throw error;
      await sleep(pollMs);
    }
  }
}

/**
 * Deterministic multi-destination lock order: sort resolved paths ascending,
 * acquire sequentially, release in reverse on failure.
 */
export async function acquireDestinationLocksOrdered(
  projectsHome: string,
  destinationRoots: readonly string[],
  options: AcquireDestinationLockOptions = {}
): Promise<DestinationLock[]> {
  const unique = [...new Set(destinationRoots.map((root) => resolve(root)))].sort((a, b) =>
    a.localeCompare(b)
  );
  const held: DestinationLock[] = [];
  try {
    for (const dest of unique) {
      held.push(await acquireDestinationLock(projectsHome, dest, options));
    }
    return held;
  } catch (error) {
    for (const lock of held.reverse()) {
      await lock.release().catch(() => undefined);
    }
    throw error;
  }
}

async function tryAcquireDestinationLockOnce(
  projectsHome: string,
  destinationRoot: string,
  lockPath: string,
  journalDir: string,
  options: AcquireDestinationLockOptions
): Promise<DestinationLock> {
  // Pin journal (lock parent) device+inode once, then re-verify the same entity
  // after hooks, after create, after write, and at release.
  const pinnedJournal = await assertRealJournalDir(projectsHome, journalDir);
  await assertLockLeafSafe(lockPath);

  if (options._testHooks?.afterIdentityCheckBeforeOpen) {
    await options._testHooks.afterIdentityCheckBeforeOpen();
  }

  // Always re-verify immediately before open (closes check→open TOCTOU).
  await revalidatePinnedJournalDir(projectsHome, journalDir, pinnedJournal);
  await assertLockLeafSafe(lockPath);

  const nofollow = constants.O_NOFOLLOW ?? 0;
  const token = randomUUID();
  let handle: FileHandle | undefined;
  let created: NodeIdentity | undefined;

  try {
    try {
      handle = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow,
        0o600
      );
    } catch (error) {
      if (
        !isAlreadyExists(error)
        || !(await recoverStaleDestinationLock(lockPath, journalDir, pinnedJournal))
      ) {
        if (isAlreadyExists(error)) throw new DestinationLockedError(destinationRoot);
        throw error;
      }
      // Stale recovery may have raced with a journal swap; re-verify before retry open.
      await revalidatePinnedJournalDir(projectsHome, journalDir, pinnedJournal);
      await assertLockLeafSafe(lockPath);
      try {
        handle = await open(
          lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow,
          0o600
        );
      } catch (retryError) {
        if (isAlreadyExists(retryError)) throw new DestinationLockedError(destinationRoot);
        throw retryError;
      }
    }

    const stats = await handle.stat();
    const lockIdentity = { device: stats.dev, inode: stats.ino };
    created = lockIdentity;

    if (options._testHooks?.afterLockCreatedBeforeValidate) {
      await options._testHooks.afterLockCreatedBeforeValidate();
    }

    // Post-create: journal parent identity + lock leaf must still be the entities we pinned.
    await revalidatePinnedJournalDir(projectsHome, journalDir, pinnedJournal);
    await assertCreatedLockIntact(lockPath, handle, lockIdentity);

    await handle.writeFile(
      `${JSON.stringify({
        pid: process.pid,
        token,
        destination_root: destinationRoot,
        projects_home: projectsHome,
        acquired_at: new Date().toISOString()
      })}\n`
    );
    await handle.sync();
    await handle.close();
    handle = undefined;

    // Final check after write/close: refuse if journal/leaf was swapped during the write window.
    await revalidatePinnedJournalDir(projectsHome, journalDir, pinnedJournal);
    await assertCreatedLockIntact(lockPath, undefined, lockIdentity);

    let released = false;
    return {
      projectsHome,
      destinationRoot,
      token,
      async release() {
        if (released) return;
        released = true;
        await safeUnlinkDestinationLock(lockPath, token, lockIdentity, pinnedJournal, journalDir);
      }
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) {
      await safeUnlinkDestinationLock(lockPath, token, created, pinnedJournal, journalDir)
        .catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Ensure the journal directory exists under a real projectsHome without ever
 * following a symlink leaf or ancestor via recursive mkdir.
 *
 * Order (fail closed, zero side effects on external targets):
 * 1. Validate projectsHome / existing ancestors with lstat (+ realpath) before any create
 * 2. Create only missing internal segments one-by-one (recursive:false), pinning each
 *    safe parent by device+inode and re-verifying after every mkdir
 * 3. Final assertRealJournalDir for the journal leaf contract
 */
async function ensureRealJournalDir(projectsHome: string, journalDir: string): Promise<void> {
  const home = resolve(projectsHome);
  const journal = resolve(journalDir);
  try {
    const homeIdentity = await ensureRealDirectoryPath(home);
    await ensureRealDirectoryChild(home, journal, homeIdentity);
  } catch (error) {
    if (error instanceof DestinationLockBoundaryError) throw error;
    throw new DestinationLockBoundaryError({
      code: "promotion.destination_lock_unsafe",
      message: `destination lock journal directory is not usable: ${errorMessage(error)}`,
      path: journal
    });
  }
  await assertRealJournalDir(home, journal);
}

/**
 * Ensure `targetPath` is a real non-symlink directory, including every
 * user-controlled component from a trusted path anchor down to the leaf.
 *
 * Why not leaf-only lstat when the path already exists?
 * POSIX path resolution follows intermediate symlinks for all but the final
 * component. So if `linked-parent -> external` and `external/nested/projects`
 * already exists as a real directory, `lstat(linked-parent/nested/projects)`
 * succeeds and misses the symlink ancestor — allowing journal/lock writes on
 * the external target.
 *
 * Strategy:
 * 1. Choose the longest trusted lexical anchor among process.cwd(),
 *    os.homedir(), and os.tmpdir() that contains the candidate (path relative
 *    containment, not string prefix). If none match, use the candidate's own
 *    path root (`parse(candidate).root`). Anchors absorb OS-default prefixes
 *    such as macOS `/var -> /private/var` for legitimate tmpdir usage.
 * 2. Pin the anchor (full-path lstat; intermediate OS prefix links ok).
 * 3. Walk each segment from anchor to target with lstat; refuse any symlink.
 * 4. Create only missing segments under a device+inode-pinned parent with
 *    recursive:false, re-validating parent identity around each create.
 */
async function ensureRealDirectoryPath(targetPath: string): Promise<NodeIdentity> {
  const resolved = resolve(targetPath);
  const anchor = chooseTrustedPathAnchor(resolved);

  let parentPath = anchor;
  let parentIdentity: NodeIdentity;
  try {
    parentIdentity = await assertRealDirectoryNode(anchor, "destination lock path anchor");
  } catch (error) {
    if (error instanceof DestinationLockBoundaryError) throw error;
    throw new DestinationLockBoundaryError({
      code: "promotion.destination_lock_unsafe",
      message: isMissing(error)
        ? "destination lock path anchor is missing"
        : `destination lock path anchor is not usable: ${errorMessage(error)}`,
      path: anchor
    });
  }

  if (resolved === anchor) {
    return parentIdentity;
  }

  const relativePath = relative(anchor, resolved);
  if (
    relativePath === ""
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw new DestinationLockBoundaryError({
      code: "promotion.destination_lock_unsafe",
      message: "destination lock path escaped its trusted path anchor",
      path: resolved
    });
  }

  for (const segment of relativePath.split(sep).filter(Boolean)) {
    const childPath = join(parentPath, segment);
    parentIdentity = await ensureRealDirectoryChild(parentPath, childPath, parentIdentity);
    parentPath = childPath;
  }
  return parentIdentity;
}

/**
 * Longest lexical path anchor among trusted bases that contains `candidate`.
 * Falls back to the candidate's own path root when outside all bases
 * (segment walk then refuses OS/user symlink ancestors before any create).
 * Production wrapper: host platform path API only.
 */
function chooseTrustedPathAnchor(candidate: string): string {
  return chooseTrustedPathAnchorWith(
    candidate,
    [process.cwd(), homedir(), tmpdir()],
    platformPathApi
  );
}

/**
 * True when `candidate` is the same path as `anchor` or a descendant, using the
 * path API's relative/isAbsolute/sep (handles Windows drive + case rules).
 * Does not use string prefix matching (avoids C:\foo vs C:\foobar collisions and
 * case-sensitive false negatives).
 */
function isPathInsideOrEqualWith(
  anchor: string,
  candidate: string,
  pathApi: TrustedPathAnchorPathApi
): boolean {
  const relativePath = pathApi.relative(anchor, candidate);
  return relativePath === ""
    || (
      relativePath !== ".."
      && !relativePath.startsWith(`..${pathApi.sep}`)
      && !pathApi.isAbsolute(relativePath)
    );
}

/**
 * Pure trusted-anchor selection with an injectable path API.
 *
 * @internal Test-only export for Windows drive/case regression coverage.
 * Never wired from the CLI. Production uses {@link chooseTrustedPathAnchor}.
 *
 * Fallback is the candidate's own root (`parse(candidate).root`), not
 * `resolve(sep)`, so a process on C: with projects on D: anchors at D:\.
 */
export function chooseTrustedPathAnchorWith(
  candidate: string,
  trustedBases: readonly string[],
  pathApi: TrustedPathAnchorPathApi
): string {
  const resolved = pathApi.resolve(candidate);
  let best: string | undefined;
  for (const base of trustedBases) {
    const anchor = pathApi.resolve(base);
    if (isPathInsideOrEqualWith(anchor, resolved, pathApi)) {
      if (best === undefined || anchor.length > best.length) {
        best = anchor;
      }
    }
  }
  // Candidate's own drive/volume root — never process-cwd drive via resolve(sep).
  return best ?? pathApi.parse(resolved).root;
}

/**
 * Create or accept `childPath` as a real directory directly under a pinned parent.
 * Never uses recursive mkdir; re-validates parent identity and realpath containment.
 */
async function ensureRealDirectoryChild(
  parentPath: string,
  childPath: string,
  parentIdentity: NodeIdentity
): Promise<NodeIdentity> {
  const parent = resolve(parentPath);
  const child = resolve(childPath);

  await assertPinnedRealDirectory(parent, parentIdentity);

  try {
    const existing = await assertRealDirectoryNode(child, "destination lock path");
    await assertPinnedRealDirectory(parent, parentIdentity);
    await assertChildRealpathUnderParent(parent, child);
    return existing;
  } catch (error) {
    if (error instanceof DestinationLockBoundaryError) throw error;
    if (!isMissing(error)) throw error;
  }

  await assertPinnedRealDirectory(parent, parentIdentity);
  try {
    await mkdir(child, { recursive: false });
  } catch (error) {
    // Concurrent create: only accept if the live node is still a real directory.
    if (!isAlreadyExists(error)) {
      throw new DestinationLockBoundaryError({
        code: "promotion.destination_lock_unsafe",
        message: `destination lock path could not be created: ${errorMessage(error)}`,
        path: child
      });
    }
  }

  await assertPinnedRealDirectory(parent, parentIdentity);
  const created = await assertRealDirectoryNode(child, "destination lock path");
  await assertChildRealpathUnderParent(parent, child);
  return created;
}

async function assertRealDirectoryNode(
  path: string,
  label: string
): Promise<NodeIdentity> {
  const resolved = resolve(path);
  // Preserve ENOENT for callers that create missing segments; other lstat errors bubble.
  const stats = await lstat(resolved);
  if (stats.isSymbolicLink()) {
    throw new DestinationLockBoundaryError({
      code: "promotion.destination_lock_symlink",
      message: `${label} must not be a symbolic link`,
      path: resolved
    });
  }
  if (!stats.isDirectory()) {
    throw new DestinationLockBoundaryError({
      code: "promotion.destination_lock_unsafe",
      message: `${label} must be a real directory`,
      path: resolved
    });
  }
  // realpath must resolve (fail closed on dangling / unreadable trees).
  // Errors bubble to ensureRealJournalDir which maps them to destination_lock_unsafe.
  await realpath(resolved);
  return { device: stats.dev, inode: stats.ino };
}

async function assertPinnedRealDirectory(
  path: string,
  expected: NodeIdentity
): Promise<void> {
  const live = await assertRealDirectoryNode(path, "destination lock path parent");
  if (live.device !== expected.device || live.inode !== expected.inode) {
    throw new DestinationLockBoundaryError({
      code: "promotion.destination_lock_changed",
      message: "destination lock path parent identity changed during mkdir",
      path: resolve(path)
    });
  }
}

async function assertChildRealpathUnderParent(
  parentPath: string,
  childPath: string
): Promise<void> {
  // Parent/child were just validated as real directories; realpath errors bubble.
  const parentReal = await realpath(parentPath);
  const childReal = await realpath(childPath);
  if (dirname(childReal) !== parentReal) {
    throw new DestinationLockBoundaryError({
      code: "promotion.destination_lock_unsafe",
      message: "destination lock path realpath escaped its parent directory",
      path: resolve(childPath)
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Journal must be a real non-symlink directory under projectsHome.
 * Returns device+inode identity for later re-verification.
 */
async function assertRealJournalDir(
  projectsHome: string,
  journalDir: string
): Promise<NodeIdentity> {
  let stats: Stats;
  try {
    stats = await lstat(journalDir);
  } catch (error) {
    throw new DestinationLockBoundaryError({
      code: "promotion.destination_lock_unsafe",
      message: error instanceof Error
        ? `destination lock journal directory is missing: ${error.message}`
        : "destination lock journal directory is missing",
      path: journalDir
    });
  }
  if (stats.isSymbolicLink()) {
    throw new DestinationLockBoundaryError({
      code: "promotion.destination_lock_symlink",
      message: "destination lock journal directory must not be a symbolic link",
      path: journalDir
    });
  }
  if (!stats.isDirectory()) {
    throw new DestinationLockBoundaryError({
      code: "promotion.destination_lock_unsafe",
      message: "destination lock journal directory must be a real directory",
      path: journalDir
    });
  }
  // Refuse when journal dir escaped projects home via a symlink ancestor of the leaf.
  // (projectsHome itself may legitimately live under /var -> /private/var on macOS.)
  if (await hasSymlinkAlongPath(projectsHome, journalDir)) {
    throw new DestinationLockBoundaryError({
      code: "promotion.destination_lock_symlink",
      message: "destination lock journal directory path contains a symbolic-link ancestor",
      path: journalDir
    });
  }
  return { device: stats.dev, inode: stats.ino };
}

/**
 * Fail closed when the journal path no longer refers to the pinned directory entity
 * (rename/replace/symlink swap) or gains a symlink ancestor. Does not create or delete.
 */
async function revalidatePinnedJournalDir(
  projectsHome: string,
  journalDir: string,
  expected: NodeIdentity
): Promise<void> {
  const live = await assertRealJournalDir(projectsHome, journalDir);
  if (live.device !== expected.device || live.inode !== expected.inode) {
    throw new DestinationLockBoundaryError({
      code: "promotion.destination_lock_changed",
      message: "destination lock journal directory identity changed (renamed, replaced, or swapped)",
      path: journalDir
    });
  }
}

/** True only when journalDir is still the same real directory entity as pinned. */
async function journalIdentityMatches(
  journalDir: string,
  expected: NodeIdentity
): Promise<boolean> {
  try {
    const stats = await lstat(journalDir);
    return !stats.isSymbolicLink()
      && stats.isDirectory()
      && stats.dev === expected.device
      && stats.ino === expected.inode;
  } catch {
    return false;
  }
}

async function hasSymlinkAlongPath(root: string, candidate: string): Promise<boolean> {
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
    if (isMissing(error)) return true;
    throw error;
  }
  for (const part of relativePath.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
  return false;
}

async function assertLockLeafSafe(lockPath: string): Promise<void> {
  try {
    const stats = await lstat(lockPath);
    if (stats.isSymbolicLink()) {
      throw new DestinationLockBoundaryError({
        code: "promotion.destination_lock_symlink",
        message: "destination lock leaf must not be a symbolic link",
        path: lockPath
      });
    }
  } catch (error) {
    if (error instanceof DestinationLockBoundaryError) throw error;
    if (isMissing(error)) return;
    throw error;
  }
}

async function assertCreatedLockIntact(
  lockPath: string,
  handle: FileHandle | undefined,
  created: NodeIdentity
): Promise<void> {
  let pathStats: Stats;
  try {
    pathStats = await lstat(lockPath);
  } catch (error) {
    throw new DestinationLockBoundaryError({
      code: "promotion.destination_lock_changed",
      message: error instanceof Error
        ? `destination lock path became unusable: ${error.message}`
        : "destination lock path became unusable",
      path: lockPath
    });
  }
  if (pathStats.isSymbolicLink()) {
    throw new DestinationLockBoundaryError({
      code: "promotion.destination_lock_symlink",
      message: "destination lock leaf must not be a symbolic link after create",
      path: lockPath
    });
  }
  if (pathStats.dev !== created.device || pathStats.ino !== created.inode) {
    throw new DestinationLockBoundaryError({
      code: "promotion.destination_lock_changed",
      message: "destination lock path no longer refers to the created lock file",
      path: lockPath
    });
  }
  if (handle) {
    const handleStats = await handle.stat();
    if (handleStats.dev !== created.device || handleStats.ino !== created.inode) {
      throw new DestinationLockBoundaryError({
        code: "promotion.destination_lock_changed",
        message: "destination lock path no longer refers to the created lock file",
        path: lockPath
      });
    }
  }
}

/**
 * Unlink only when journal parent identity, lock leaf identity, and owner token
 * still match the acquire-time pins. Prefer orphan locks over external damage.
 */
async function safeUnlinkDestinationLock(
  lockPath: string,
  token: string,
  created: NodeIdentity,
  journalIdentity: NodeIdentity,
  journalDir: string
): Promise<void> {
  try {
    // Parent first: if journal was renamed/replaced/symlinked, do not touch path.
    if (!(await journalIdentityMatches(journalDir, journalIdentity))) return;

    let owner: unknown;
    try {
      owner = JSON.parse(await readFile(lockPath, "utf8"));
    } catch {
      return;
    }
    if (!isDestinationLockRecord(owner) || owner.token !== token) return;
    const stats = await lstat(lockPath);
    if (stats.isSymbolicLink()) return;
    if (stats.dev !== created.device || stats.ino !== created.inode) return;

    // Re-check parent immediately before unlink (TOCTOU with the reads above).
    if (!(await journalIdentityMatches(journalDir, journalIdentity))) return;
    await unlink(lockPath);
  } catch {
    // Prefer orphan lock over external damage.
  }
}

async function recoverStaleDestinationLock(
  lockPath: string,
  journalDir: string,
  journalIdentity: NodeIdentity
): Promise<boolean> {
  // Never recover through a swapped journal parent (would rename/unlink external files).
  if (!(await journalIdentityMatches(journalDir, journalIdentity))) return false;

  let handle: FileHandle | undefined;
  let observedStats: Stats;
  let owner: unknown;
  try {
    handle = await open(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    observedStats = await handle.stat();
    owner = JSON.parse(await handle.readFile("utf8"));
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  if (!isDestinationLockRecord(owner) || isProcessAlive(owner.pid)) return false;
  if (!(await journalIdentityMatches(journalDir, journalIdentity))) return false;

  const recoveryPath = `${lockPath}.recovery.${process.pid}.${randomUUID()}`;
  try {
    await rename(lockPath, recoveryPath);
  } catch (error) {
    return isMissing(error);
  }
  try {
    // Recovery path must still live under the pinned journal directory.
    if (!(await journalIdentityMatches(journalDir, journalIdentity))) {
      await rename(recoveryPath, lockPath).catch(() => undefined);
      return false;
    }
    const recoveredStats = await lstat(recoveryPath);
    if (
      recoveredStats.dev !== observedStats.dev
      || recoveredStats.ino !== observedStats.ino
    ) {
      await rename(recoveryPath, lockPath).catch(() => undefined);
      return false;
    }
    await unlink(recoveryPath);
    return true;
  } catch {
    await rename(recoveryPath, lockPath).catch(() => undefined);
    return false;
  }
}

function sanitizeLockFileName(name: string): string {
  const trimmed = name.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) return trimmed;
  return `dir-${Buffer.from(trimmed).toString("hex").slice(0, 48) || "unknown"}`;
}

function isDestinationLockRecord(input: unknown): input is {
  pid: number;
  token: string;
  destination_root: string;
  projects_home: string;
  acquired_at: string;
} {
  return typeof input === "object"
    && input !== null
    && "pid" in input
    && typeof input.pid === "number"
    && Number.isSafeInteger(input.pid)
    && input.pid > 0
    && "token" in input
    && typeof input.token === "string"
    && input.token.length > 0
    && "destination_root" in input
    && typeof input.destination_root === "string"
    && "projects_home" in input
    && typeof input.projects_home === "string"
    && "acquired_at" in input
    && typeof input.acquired_at === "string";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}
