import { execFile } from "node:child_process";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Issue, Result } from "../types.js";

const execFileAsync = promisify(execFile);

export type GitCommandResult = {
  stdout: string;
  stderr: string;
  status: number;
};

export type GitCommandRunner = (
  args: readonly string[],
  options: { cwd: string }
) => Promise<GitCommandResult>;

export type WorktreeStatusEntry = {
  kind: "tracked" | "untracked" | "ignored";
  path: string;
  status: string;
};

export type WorktreeReport = {
  path: string;
  is_primary: boolean;
  is_current: boolean;
  branch: string | null;
  head: string;
  merged_into_main: boolean;
  dirty_tracked: boolean;
  dirty_untracked: boolean;
  locked: boolean;
  missing: boolean;
  removable: boolean;
  block_reasons: string[];
  ignored_protected: string[];
  ignored_other: string[];
  status_entries: WorktreeStatusEntry[];
};

export type WorktreeLifecycleResult = {
  applied: boolean;
  removed: string[];
  targets: string[];
  main_branch: string;
  git_common_dir: string;
  primary_path: string;
  current_path: string;
  worktrees: WorktreeReport[];
};

export const WORKTREE_CLEANUP_WARNING_THRESHOLD = 3;

export type WorktreeCleanupWarning = {
  active: boolean;
  threshold: number;
  removable_count: number;
  removable_paths: string[];
};

export type AuditAndCleanupWorktreesOptions = {
  cwd?: string;
  apply?: boolean;
  paths?: readonly string[];
  runGit?: GitCommandRunner;
};

const PROTECTED_IGNORED_PREFIXES = [
  "projects/",
  "media/",
  "output/",
  "tmp/",
  "templates/"
] as const;

const PROTECTED_ROOT_NAMES = [
  "projects",
  "media",
  "output",
  "tmp",
  "templates"
] as const;

const PROTECTED_IGNORED_NAMES = new Set([".env"]);

export function summarizeWorktreeCleanupWarning(
  worktrees: readonly WorktreeReport[],
  threshold = WORKTREE_CLEANUP_WARNING_THRESHOLD
): WorktreeCleanupWarning {
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error("worktree cleanup warning threshold must be a positive integer");
  }
  const removablePaths = uniqueSorted(
    worktrees.filter((worktree) => worktree.removable).map((worktree) => worktree.path)
  );
  return {
    active: removablePaths.length >= threshold,
    threshold,
    removable_count: removablePaths.length,
    removable_paths: removablePaths
  };
}

export async function auditAndCleanupWorktrees(
  options: AuditAndCleanupWorktreesOptions = {}
): Promise<Result<WorktreeLifecycleResult>> {
  const cwd = normalizeOsPath(options.cwd ?? process.cwd());
  const runGit = options.runGit ?? defaultGitRunner;
  const apply = options.apply === true;
  const requestedPaths = dedupeResolvedPaths(
    (options.paths ?? []).map((path) => resolveRequestedPath(path, cwd))
  );

  const commonDirResult = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd }
  );
  if (commonDirResult.status !== 0) {
    return failure(requestedPaths, [{
      code: "worktrees.git_unavailable",
      message: commonDirResult.stderr.trim() || "unable to resolve git common dir"
    }]);
  }

  const gitCommonDir = await canonicalizePath(commonDirResult.stdout.trim());
  const toplevelResult = await runGit(
    ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    { cwd }
  );
  const currentPath = toplevelResult.status === 0
    ? await canonicalizePath(toplevelResult.stdout.trim())
    : cwd;

  const mainBranch = await resolveMainBranch(runGit, cwd);
  const listed = await listRegisteredWorktrees(runGit, cwd, gitCommonDir, currentPath, mainBranch);
  const primaryPath = listed.find((entry) => entry.is_primary)?.path ?? currentPath;
  const byResolved = new Map(listed.map((entry) => [entry.path, entry]));

  if (!apply) {
    return {
      ok: true,
      issues: [],
      applied: false,
      removed: [],
      targets: requestedPaths,
      main_branch: mainBranch,
      git_common_dir: gitCommonDir,
      primary_path: primaryPath,
      current_path: currentPath,
      worktrees: listed
    };
  }

  if (requestedPaths.length === 0) {
    return {
      ok: false,
      issues: [{
        code: "worktrees.path_required",
        message: "--path is required when applying worktree cleanup",
        path: "--path"
      }],
      applied: false,
      removed: [],
      targets: requestedPaths,
      main_branch: mainBranch,
      git_common_dir: gitCommonDir,
      primary_path: primaryPath,
      current_path: currentPath,
      worktrees: listed
    };
  }

  const issues: Issue[] = [];
  const targets: WorktreeReport[] = [];

  for (const requested of requestedPaths) {
    const exists = await pathExists(requested);
    const registered = findRegistered(byResolved, requested);

    if (!registered) {
      issues.push({
        code: exists ? "worktrees.not_registered" : "worktrees.target_missing",
        message: exists
          ? `path is not a registered git worktree: ${requested}`
          : `worktree path does not exist: ${requested}`,
        path: requested
      });
      continue;
    }

    if (registered.missing) {
      issues.push({
        code: "worktrees.target_missing",
        message: `worktree path does not exist: ${registered.path}`,
        path: registered.path
      });
      continue;
    }

    if (!registered.removable) {
      issues.push({
        code: "worktrees.not_removable",
        message: `worktree is not safely removable (${registered.block_reasons.join(", ") || "blocked"}): ${registered.path}`,
        path: registered.path
      });
      continue;
    }

    targets.push(registered);
  }

  if (issues.length > 0) {
    return {
      ok: false,
      issues,
      applied: false,
      removed: [],
      targets: requestedPaths,
      main_branch: mainBranch,
      git_common_dir: gitCommonDir,
      primary_path: primaryPath,
      current_path: currentPath,
      worktrees: listed
    };
  }

  const removed: string[] = [];
  for (const target of targets) {
    const revalidated = await revalidateTargetBeforeRemove(runGit, {
      target,
      cwd,
      commonDir: gitCommonDir,
      currentPath,
      mainBranch,
      primaryPath
    });
    if (!revalidated.ok) {
      return {
        ok: false,
        issues: revalidated.issues,
        applied: removed.length > 0,
        removed,
        targets: requestedPaths,
        main_branch: mainBranch,
        git_common_dir: gitCommonDir,
        primary_path: primaryPath,
        current_path: currentPath,
        worktrees: listed
      };
    }

    const removeArgs = ["worktree", "remove", target.path] as const;
    assertNonForceRemove(removeArgs);
    const result = await runGit([...removeArgs], { cwd: primaryPath });
    if (result.status !== 0) {
      return {
        ok: false,
        issues: [{
          code: "worktrees.remove_failed",
          message: result.stderr.trim() || `failed to remove worktree ${target.path}`,
          path: target.path
        }],
        applied: removed.length > 0,
        removed,
        targets: requestedPaths,
        main_branch: mainBranch,
        git_common_dir: gitCommonDir,
        primary_path: primaryPath,
        current_path: currentPath,
        worktrees: listed
      };
    }
    removed.push(target.path);
  }

  const refreshed = await listRegisteredWorktrees(
    runGit,
    primaryPath,
    gitCommonDir,
    currentPath,
    mainBranch
  );
  return {
    ok: true,
    issues: [],
    applied: true,
    removed,
    targets: requestedPaths,
    main_branch: mainBranch,
    git_common_dir: gitCommonDir,
    primary_path: primaryPath,
    current_path: currentPath,
    worktrees: refreshed
  };
}

function assertNonForceRemove(args: readonly string[]): void {
  if (args.includes("--force") || args.includes("-f")) {
    throw new Error("git worktree remove must never use --force");
  }
}

async function revalidateTargetBeforeRemove(
  runGit: GitCommandRunner,
  input: {
    target: WorktreeReport;
    cwd: string;
    commonDir: string;
    currentPath: string;
    mainBranch: string;
    primaryPath: string;
  }
): Promise<{ ok: true } | { ok: false; issues: Issue[] }> {
  const listed = await listRegisteredWorktrees(
    runGit,
    input.cwd,
    input.commonDir,
    input.currentPath,
    input.mainBranch
  );
  const byResolved = new Map(listed.map((entry) => [entry.path, entry]));
  const fresh = findRegistered(byResolved, input.target.path);

  if (!fresh || fresh.missing) {
    return {
      ok: false,
      issues: [{
        code: "worktrees.target_changed",
        message: `worktree registration or path identity changed before remove: ${input.target.path}`,
        path: input.target.path
      }]
    };
  }

  if (
    !pathsEqual(fresh.path, input.target.path)
    || fresh.head !== input.target.head
    || fresh.branch !== input.target.branch
  ) {
    return {
      ok: false,
      issues: [{
        code: "worktrees.target_changed",
        message: `worktree HEAD/branch/path identity changed before remove: ${input.target.path}`,
        path: input.target.path
      }]
    };
  }

  // Re-check common-dir membership for the live worktree path.
  const commonDirCheck = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: fresh.path }
  );
  if (commonDirCheck.status !== 0) {
    return {
      ok: false,
      issues: [{
        code: "worktrees.target_changed",
        message: `worktree left repository boundary before remove: ${fresh.path}`,
        path: fresh.path
      }]
    };
  }
  const liveCommonDir = await canonicalizePath(commonDirCheck.stdout.trim());
  if (!(await samePathIdentity(liveCommonDir, input.commonDir))) {
    return {
      ok: false,
      issues: [{
        code: "worktrees.target_changed",
        message: `worktree common dir changed before remove: ${fresh.path}`,
        path: fresh.path
      }]
    };
  }

  if (fresh.is_primary || pathsEqual(fresh.path, input.primaryPath)) {
    return {
      ok: false,
      issues: [{
        code: "worktrees.not_removable",
        message: `worktree is not safely removable (primary): ${fresh.path}`,
        path: fresh.path
      }]
    };
  }

  if (fresh.is_current || pathsEqual(fresh.path, input.currentPath)) {
    return {
      ok: false,
      issues: [{
        code: "worktrees.not_removable",
        message: `worktree is not safely removable (current): ${fresh.path}`,
        path: fresh.path
      }]
    };
  }

  if (!fresh.removable) {
    const reasons = fresh.block_reasons.join(", ") || "blocked";
    const identityBroken = fresh.block_reasons.some((reason) =>
      reason === "dirty_tracked"
      || reason === "dirty_untracked"
      || reason === "protected_content"
      || reason === "locked"
      || reason === "unmerged"
      || reason === "missing"
    );
    return {
      ok: false,
      issues: [{
        code: identityBroken ? "worktrees.target_changed" : "worktrees.not_removable",
        message: `worktree is not safely removable after revalidation (${reasons}): ${fresh.path}`,
        path: fresh.path
      }]
    };
  }

  return { ok: true };
}

async function listRegisteredWorktrees(
  runGit: GitCommandRunner,
  cwd: string,
  commonDir: string,
  currentPath: string,
  mainBranch: string
): Promise<WorktreeReport[]> {
  const listed = await runGit(["worktree", "list", "--porcelain"], { cwd });
  if (listed.status !== 0) {
    throw new Error(listed.stderr.trim() || "git worktree list failed");
  }

  const entries = parseWorktreePorcelain(listed.stdout);
  const reports: WorktreeReport[] = [];
  for (const [index, entry] of entries.entries()) {
    reports.push(await inspectWorktree(runGit, {
      entry,
      isPrimary: index === 0,
      currentPath,
      commonDir,
      mainBranch,
      cwd
    }));
  }
  return reports;
}

type ParsedWorktree = {
  path: string;
  head: string;
  branch: string | null;
  locked: boolean;
};

function parseWorktreePorcelain(stdout: string): ParsedWorktree[] {
  const entries: ParsedWorktree[] = [];
  let current: ParsedWorktree | undefined;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === "") {
      if (current) {
        entries.push(current);
        current = undefined;
      }
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = {
        path: normalizeOsPath(line.slice("worktree ".length)),
        head: "",
        branch: null,
        locked: false
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
      continue;
    }
    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      continue;
    }
    if (line === "detached") {
      current.branch = null;
      continue;
    }
    if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
    }
  }

  if (current) entries.push(current);
  return entries;
}

async function inspectWorktree(
  runGit: GitCommandRunner,
  input: {
    entry: ParsedWorktree;
    isPrimary: boolean;
    currentPath: string;
    commonDir: string;
    mainBranch: string;
    cwd: string;
  }
): Promise<WorktreeReport> {
  const path = await canonicalizePath(input.entry.path);
  const blockReasons = new Set<string>();
  let missing = false;
  let dirtyTracked = false;
  let dirtyUntracked = false;
  let locked = input.entry.locked;
  let mergedIntoMain = false;
  let ignoredProtected: string[] = [];
  let ignoredOther: string[] = [];
  let statusEntries: WorktreeStatusEntry[] = [];

  if (input.isPrimary) blockReasons.add("primary");
  if (await samePathIdentity(path, input.currentPath)) blockReasons.add("current");

  const existence = await inspectPathSafety(path, input.commonDir, runGit);
  if (existence.missing) {
    missing = true;
    blockReasons.add("missing");
  } else {
    for (const reason of existence.blockReasons) blockReasons.add(reason);
  }

  if (locked) blockReasons.add("locked");

  if (!missing) {
    // --ignored=matching reports matched ignored directories as a unit (e.g. node_modules/)
    // instead of listing every nested file. Keep --untracked-files=all so nested untracked
    // dirt still surfaces path-by-path for remove safety.
    const status = await runGit(
      ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
      { cwd: path }
    );
    if (status.status === 0) {
      const parsed = parseStatusPorcelain(status.stdout);
      statusEntries = parsed.entries;
      dirtyTracked = parsed.dirtyTracked;
      dirtyUntracked = parsed.dirtyUntracked;
      ignoredProtected = parsed.ignoredProtected;
      ignoredOther = parsed.ignoredOther;
      if (dirtyTracked) blockReasons.add("dirty_tracked");
      if (dirtyUntracked) blockReasons.add("dirty_untracked");
    } else {
      blockReasons.add("status_unavailable");
    }

    // Trust git status --ignored for content that would be lost. Only augment with
    // protected root symlink escapes that stay inside the worktree boundary check.
    const protectedRoots = await listProtectedPresentPaths(path, ignoredProtected);
    ignoredProtected = uniqueSorted(protectedRoots);
    if (ignoredProtected.length > 0) blockReasons.add("protected_content");

    if (input.entry.head) {
      const ancestor = await runGit(
        ["merge-base", "--is-ancestor", input.entry.head, input.mainBranch],
        { cwd: input.cwd }
      );
      mergedIntoMain = ancestor.status === 0;
    }
  }

  if (!mergedIntoMain && !input.isPrimary) blockReasons.add("unmerged");
  if (input.isPrimary) mergedIntoMain = true;

  return {
    path,
    is_primary: input.isPrimary,
    is_current: await samePathIdentity(path, input.currentPath),
    branch: input.entry.branch,
    head: input.entry.head,
    merged_into_main: mergedIntoMain,
    dirty_tracked: dirtyTracked,
    dirty_untracked: dirtyUntracked,
    locked,
    missing,
    removable: blockReasons.size === 0,
    block_reasons: [...blockReasons].sort(),
    ignored_protected: ignoredProtected,
    ignored_other: ignoredOther,
    status_entries: statusEntries
  };
}

function parseStatusPorcelain(stdout: string): {
  entries: WorktreeStatusEntry[];
  dirtyTracked: boolean;
  dirtyUntracked: boolean;
  ignoredProtected: string[];
  ignoredOther: string[];
} {
  const entries: WorktreeStatusEntry[] = [];
  const ignoredProtected: string[] = [];
  const ignoredOther: string[] = [];
  let dirtyTracked = false;
  let dirtyUntracked = false;

  for (const rawLine of stdout.split(/\r?\n/)) {
    if (!rawLine) continue;
    const status = rawLine.slice(0, 2);
    const pathPart = rawLine.slice(3);
    if (!pathPart) continue;
    const path = pathPart.includes(" -> ") ? pathPart.split(" -> ").at(-1)! : pathPart;
    const portable = path.replaceAll("\\", "/");

    if (status === "!!") {
      entries.push({ kind: "ignored", path: portable, status });
      if (isProtectedIgnoredPath(portable)) ignoredProtected.push(portable);
      else ignoredOther.push(portable);
      continue;
    }

    if (status === "??") {
      entries.push({ kind: "untracked", path: portable, status });
      dirtyUntracked = true;
      // Untracked data under protected roots is also treated as protected content
      // so callers can distinguish "would lose durable data" from generic dirt.
      if (isProtectedIgnoredPath(portable)) ignoredProtected.push(portable);
      continue;
    }

    entries.push({ kind: "tracked", path: portable, status });
    dirtyTracked = true;
  }

  return {
    entries,
    dirtyTracked,
    dirtyUntracked,
    ignoredProtected: uniqueSorted(ignoredProtected),
    ignoredOther: uniqueSorted(ignoredOther)
  };
}

function isProtectedIgnoredPath(path: string): boolean {
  const portable = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (PROTECTED_IGNORED_NAMES.has(portable)) return true;
  if (portable.startsWith(".env.")) return true;
  if (basename(portable) === ".env" || basename(portable).startsWith(".env.")) return true;
  return PROTECTED_IGNORED_PREFIXES.some(
    (prefix) => portable === prefix.slice(0, -1) || portable.startsWith(prefix)
  );
}

/**
 * Protected content is authoritative from git status --ignored (and untracked
 * protected paths). Disk exploration only detects protected root symlinks that
 * escape the worktree; it never walks into repo-external targets and never
 * treats tracked scaffold files (projects/.gitkeep, projects/README.md) as
 * protected content by mere presence.
 */
async function listProtectedPresentPaths(
  worktreePath: string,
  statusProtected: readonly string[]
): Promise<string[]> {
  const found = new Set(statusProtected);
  let worktreeReal: string | null = null;
  try {
    worktreeReal = await canonicalizePath(worktreePath);
  } catch {
    worktreeReal = normalizeOsPath(worktreePath);
  }

  for (const name of PROTECTED_ROOT_NAMES) {
    const candidate = join(worktreePath, name);
    let linkStat;
    try {
      linkStat = await lstat(candidate);
    } catch {
      continue;
    }

    if (!linkStat.isSymbolicLink()) {
      // Regular dirs/files: do not walk. Tracked scaffold alone must not block.
      // Ignored/untracked durable data is already represented in statusProtected.
      continue;
    }

    // Root symlink: never traverse outside the worktree.
    try {
      const targetReal = await canonicalizePath(candidate);
      if (!worktreeReal || !(await isPathInsideOrEqual(targetReal, worktreeReal))) {
        found.add(name);
      }
    } catch {
      found.add(name);
    }
  }

  return uniqueSorted([...found]);
}

async function isPathInsideOrEqual(candidate: string, root: string): Promise<boolean> {
  if (await samePathIdentity(candidate, root)) return true;
  const rel = relative(normalizeOsPath(root), normalizeOsPath(candidate));
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

async function inspectPathSafety(
  worktreePath: string,
  commonDir: string,
  runGit: GitCommandRunner
): Promise<{ missing: boolean; blockReasons: string[] }> {
  const blockReasons: string[] = [];
  try {
    await access(worktreePath);
  } catch {
    return { missing: true, blockReasons: ["missing"] };
  }

  try {
    const linkStat = await lstat(worktreePath);
    if (linkStat.isSymbolicLink()) blockReasons.push("symlink_worktree");
  } catch {
    blockReasons.push("invalid_path");
    return { missing: false, blockReasons };
  }

  try {
    await realpath(worktreePath);
    await realpath(commonDir);
  } catch {
    blockReasons.push("invalid_realpath");
    return { missing: false, blockReasons };
  }

  const commonDirCheck = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: worktreePath }
  );
  if (commonDirCheck.status !== 0) {
    blockReasons.push("outside_repo_boundary");
  } else {
    const liveCommonDir = await canonicalizePath(commonDirCheck.stdout.trim());
    const expectedCommonDir = await canonicalizePath(commonDir);
    // Exact identity after realpath + macOS /var normalization — not a prefix check.
    if (!(await samePathIdentity(liveCommonDir, expectedCommonDir))) {
      blockReasons.push("outside_repo_boundary");
    }
  }

  return { missing: false, blockReasons };
}

async function resolveMainBranch(runGit: GitCommandRunner, cwd: string): Promise<string> {
  for (const candidate of ["main", "master"] as const) {
    const result = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], {
      cwd
    });
    if (result.status === 0) return candidate;
  }

  const symbolic = await runGit(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { cwd });
  if (symbolic.status === 0) {
    const match = symbolic.stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
    if (match?.[1]) return match[1];
  }

  return "main";
}

function findRegistered(
  byResolved: Map<string, WorktreeReport>,
  requested: string
): WorktreeReport | undefined {
  const key = normalizeOsPath(requested);
  const direct = byResolved.get(key);
  if (direct) return direct;
  for (const entry of byResolved.values()) {
    if (pathsEqual(entry.path, requested)) return entry;
  }
  return undefined;
}

function resolveRequestedPath(path: string, cwd: string): string {
  return normalizeOsPath(isAbsolute(path) ? path : resolve(cwd, path));
}

function dedupeResolvedPaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (out.some((existing) => pathsEqual(existing, path))) continue;
    out.push(normalizeOsPath(path));
  }
  return out;
}

function pathsEqual(left: string, right: string): boolean {
  return normalizeOsPath(left) === normalizeOsPath(right);
}

/**
 * Prefer realpath identity when both sides exist. macOS /var and /private/var
 * are treated as the same location via normalizeOsPath — never via prefix match.
 */
async function samePathIdentity(left: string, right: string): Promise<boolean> {
  const normalizedLeft = normalizeOsPath(left);
  const normalizedRight = normalizeOsPath(right);
  if (normalizedLeft === normalizedRight) return true;
  try {
    const realLeft = await canonicalizePath(normalizedLeft);
    const realRight = await canonicalizePath(normalizedRight);
    return realLeft === realRight;
  } catch {
    return false;
  }
}

async function canonicalizePath(path: string): Promise<string> {
  const normalized = normalizeOsPath(path);
  try {
    return normalizeOsPath(await realpath(normalized));
  } catch {
    return normalized;
  }
}

/**
 * Git on macOS often reports `/private/var/...` while Node `tmpdir()` / `resolve()`
 * keep the logical `/var/...` form. Normalize to the logical path for stable JSON.
 */
function normalizeOsPath(path: string): string {
  const resolved = resolve(path);
  if (process.platform === "darwin" && resolved.startsWith("/private/var/")) {
    return resolved.slice("/private".length);
  }
  if (process.platform === "darwin" && resolved.startsWith("/private/tmp/")) {
    return resolved.slice("/private".length);
  }
  if (process.platform === "darwin" && resolved === "/private/tmp") {
    return "/tmp";
  }
  return resolved;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function failure(
  targets: string[],
  issues: Issue[]
): Result<WorktreeLifecycleResult> {
  return {
    ok: false,
    issues,
    applied: false,
    removed: [],
    targets,
    main_branch: "main",
    git_common_dir: "",
    primary_path: "",
    current_path: "",
    worktrees: []
  };
}

export async function defaultGitRunner(
  args: readonly string[],
  options: { cwd: string }
): Promise<GitCommandResult> {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("git commands must be executed with an argument array");
  }
  // Never shell-out a string; always pass an argv array. Force remove is forbidden.
  if (args[0] === "worktree" && args[1] === "remove") {
    if (args.includes("--force") || args.includes("-f")) {
      return {
        stdout: "",
        stderr: "git worktree remove --force is forbidden by Tsugite worktree lifecycle",
        status: 1
      };
    }
  }

  try {
    const result = await execFileAsync("git", [...args], {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: 0
    };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
      code?: number | string | null;
      status?: number | null;
    };
    const status =
      typeof failure.status === "number"
        ? failure.status
        : typeof failure.code === "number"
          ? failure.code
          : 1;
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? "git command failed",
      status
    };
  }
}
