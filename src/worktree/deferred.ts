import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Issue } from "../types.js";
import {
  auditAndCleanupWorktrees,
  defaultGitRunner,
  type GitCommandRunner,
  type WorktreeReport
} from "./lifecycle.js";

const execFileAsync = promisify(execFile);
const QUEUE_SCHEMA_VERSION = 1;
const MAX_QUEUE_BYTES = 1024 * 1024;
const MAX_QUEUE_ENTRIES = 128;

export type DeferredWorktreeEntry = {
  id: string;
  path: string;
  branch: string;
  head: string;
  main_branch: string;
  authorized_at: string;
  status: "pending";
};

export type DeferredWorktreeQueueResult = {
  ok: boolean;
  issues: Issue[];
  queue_path: string;
  entries: readonly DeferredWorktreeEntry[];
};

export type DeferredVerificationResult = {
  ok: boolean;
  checks: string[];
  message?: string;
};

export type DeferredCandidateVerifier = (
  candidatePath: string,
  primaryPath: string
) => Promise<DeferredVerificationResult>;

export type DeferWorktreeOptions = {
  cwd?: string;
  path: string;
  apply?: boolean;
  now?: string;
  runGit?: GitCommandRunner;
};

export type DeferWorktreeResult = DeferredWorktreeQueueResult & {
  applied: boolean;
  queued: boolean;
  entry?: DeferredWorktreeEntry;
};

export type ReconcileDeferredWorktreesOptions = {
  cwd?: string;
  apply?: boolean;
  now?: string;
  runGit?: GitCommandRunner;
  verifyCandidate?: DeferredCandidateVerifier;
};

export type ReconcileDeferredWorktreesResult = DeferredWorktreeQueueResult & {
  applied: boolean;
  status: "empty" | "waiting" | "blocked" | "ready" | "reconciled";
  waiting_reason?: string;
  processed?: DeferredWorktreeEntry;
  integration_commit?: string;
  removed: string[];
  checks: string[];
};

type QueueFile = {
  schema_version: 1;
  entries: readonly DeferredWorktreeEntry[];
};

export async function readDeferredWorktreeQueue(
  options: { cwd?: string; runGit?: GitCommandRunner } = {}
): Promise<DeferredWorktreeQueueResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const runGit = options.runGit ?? defaultGitRunner;
  const location = await resolveQueueLocation(cwd, runGit);
  if (!location.ok) return { ok: false, issues: location.issues, queue_path: "", entries: [] };
  return readQueueFile(location.queuePath);
}

export async function deferWorktreeIntegration(
  options: DeferWorktreeOptions
): Promise<DeferWorktreeResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const runGit = options.runGit ?? defaultGitRunner;
  const audit = await auditAndCleanupWorktrees({
    cwd,
    paths: [options.path],
    runGit
  });
  const base = {
    ok: false,
    issues: audit.issues,
    queue_path: audit.git_common_dir ? queuePathFor(audit.git_common_dir) : "",
    entries: [] as DeferredWorktreeEntry[],
    applied: false,
    queued: false
  };
  if (!audit.ok) return base;

  const target = findTarget(audit.worktrees, audit.targets[0] ?? options.path);
  if (!target) {
    return {
      ...base,
      issues: [{
        code: "worktrees.not_registered",
        message: `path is not a registered git worktree: ${options.path}`,
        path: options.path
      }]
    };
  }
  const targetIssue = deferredTargetIssue(target);
  if (targetIssue) return { ...base, issues: [targetIssue] };

  const queue = await readQueueFile(base.queue_path);
  if (!queue.ok) return { ...base, issues: queue.issues };
  const existing = queue.entries.find((entry) => samePath(entry.path, target.path));
  if (existing) {
    if (existing.head !== target.head || existing.branch !== target.branch) {
      return {
        ...base,
        entries: queue.entries,
        issues: [{
          code: "worktrees.deferred_identity_changed",
          message: "queued worktree HEAD or branch changed; explicit queue replacement is required",
          path: target.path
        }]
      };
    }
    return {
      ...base,
      ok: true,
      issues: [],
      entries: queue.entries,
      entry: existing
    };
  }
  if (queue.entries.length >= MAX_QUEUE_ENTRIES) {
    return {
      ...base,
      entries: queue.entries,
      issues: [{
        code: "worktrees.deferred_queue_full",
        message: `deferred worktree queue is limited to ${MAX_QUEUE_ENTRIES} entries`,
        path: base.queue_path
      }]
    };
  }

  const entry: DeferredWorktreeEntry = {
    id: randomUUID(),
    path: target.path,
    branch: target.branch!,
    head: target.head,
    main_branch: audit.main_branch,
    authorized_at: options.now ?? new Date().toISOString(),
    status: "pending"
  };
  const entries = [...queue.entries, entry];
  if (options.apply !== true) {
    return {
      ...base,
      ok: true,
      issues: [],
      entries,
      entry
    };
  }
  const written = await writeQueueFile(base.queue_path, entries);
  return {
    ...base,
    ok: written.ok,
    issues: written.issues,
    entries: written.ok ? entries : queue.entries,
    applied: written.ok,
    queued: written.ok,
    entry
  };
}

export async function reconcileDeferredWorktrees(
  options: ReconcileDeferredWorktreesOptions = {}
): Promise<ReconcileDeferredWorktreesResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const runGit = options.runGit ?? defaultGitRunner;
  const audit = await auditAndCleanupWorktrees({ cwd, runGit });
  const base = {
    ok: false,
    issues: audit.issues,
    queue_path: audit.git_common_dir ? queuePathFor(audit.git_common_dir) : "",
    entries: [] as DeferredWorktreeEntry[],
    applied: false,
    status: "blocked" as const,
    removed: [] as string[],
    checks: [] as string[]
  };
  if (!audit.ok) return base;

  const queue = await readQueueFile(base.queue_path);
  if (!queue.ok) return { ...base, issues: queue.issues };
  if (queue.entries.length === 0) {
    return { ...base, ok: true, issues: [], entries: [], status: "empty" };
  }

  const primary = audit.worktrees.find((entry) => entry.is_primary);
  if (!primary || !samePath(audit.current_path, audit.primary_path) || primary.branch !== audit.main_branch) {
    return {
      ...base,
      ok: true,
      issues: [],
      entries: queue.entries,
      status: "waiting",
      waiting_reason: "run_from_primary_main"
    };
  }
  if (primary.dirty_tracked || primary.dirty_untracked) {
    return {
      ...base,
      ok: true,
      issues: [],
      entries: queue.entries,
      status: "waiting",
      waiting_reason: "main_dirty"
    };
  }

  const entry = queue.entries[0]!;
  if (entry.main_branch !== audit.main_branch) {
    return blocked(
      { ...base, entries: queue.entries, processed: entry },
      "worktrees.deferred_main_changed",
      `queued main branch '${entry.main_branch}' does not match current main branch '${audit.main_branch}'`,
      audit.primary_path
    );
  }
  const target = findTarget(audit.worktrees, entry.path);
  if (!target) {
    const alreadyIntegrated = await runGit(
      ["merge-base", "--is-ancestor", entry.head, audit.main_branch],
      { cwd: audit.primary_path }
    );
    if (alreadyIntegrated.status === 0) {
      if (options.apply !== true) {
        return {
          ...base,
          ok: true,
          issues: [],
          entries: queue.entries,
          status: "ready",
          processed: entry
        };
      }
      const remaining = queue.entries.slice(1);
      const written = await writeQueueFile(base.queue_path, remaining);
      return {
        ...base,
        ok: written.ok,
        issues: written.issues,
        entries: written.ok ? remaining : queue.entries,
        applied: written.ok,
        status: written.ok ? "reconciled" : "blocked",
        processed: entry
      };
    }
  }
  const identityIssue = queuedIdentityIssue(target, entry);
  if (identityIssue) {
    return {
      ...base,
      entries: queue.entries,
      processed: entry,
      issues: [identityIssue]
    };
  }
  if (options.apply !== true) {
    return {
      ...base,
      ok: true,
      issues: [],
      entries: queue.entries,
      status: "ready",
      processed: entry
    };
  }

  if (target!.merged_into_main) {
    const cleanup = await auditAndCleanupWorktrees({
      cwd: audit.primary_path,
      apply: true,
      paths: [target!.path],
      runGit
    });
    if (!cleanup.ok) {
      return {
        ...base,
        entries: queue.entries,
        processed: entry,
        issues: cleanup.issues
      };
    }
    const remaining = queue.entries.slice(1);
    const written = await writeQueueFile(base.queue_path, remaining);
    return {
      ...base,
      ok: written.ok,
      issues: written.issues,
      entries: written.ok ? remaining : queue.entries,
      applied: written.ok,
      status: written.ok ? "reconciled" : "blocked",
      processed: entry,
      removed: cleanup.removed,
      checks: []
    };
  }

  return integrateQueuedWorktree({
    audit,
    queue,
    entry,
    target: target!,
    runGit,
    verifier: options.verifyCandidate ?? defaultCandidateVerifier,
    now: options.now
  });
}

async function integrateQueuedWorktree(input: {
  audit: Awaited<ReturnType<typeof auditAndCleanupWorktrees>>;
  queue: DeferredWorktreeQueueResult;
  entry: DeferredWorktreeEntry;
  target: WorktreeReport;
  runGit: GitCommandRunner;
  verifier: DeferredCandidateVerifier;
  now?: string;
}): Promise<ReconcileDeferredWorktreesResult> {
  const base = {
    ok: false,
    issues: [] as Issue[],
    queue_path: input.queue.queue_path,
    entries: input.queue.entries,
    applied: false,
    status: "blocked" as const,
    processed: input.entry,
    removed: [] as string[],
    checks: [] as string[]
  };
  const mainHeadResult = await input.runGit(["rev-parse", input.audit.main_branch!], {
    cwd: input.audit.primary_path!
  });
  if (mainHeadResult.status !== 0) {
    return {
      ...base,
      issues: [{
        code: "worktrees.deferred_main_unavailable",
        message: mainHeadResult.stderr.trim() || "unable to resolve main HEAD"
      }]
    };
  }
  const mainHead = mainHeadResult.stdout.trim();
  const candidatePath = await mkdtemp(join(tmpdir(), "tsugite-reconcile-"));
  let candidateRegistered = false;
  let nodeModulesLinked = false;
  try {
    const added = await input.runGit(["worktree", "add", "--detach", candidatePath, mainHead], {
      cwd: input.audit.primary_path!
    });
    if (added.status !== 0) {
      return blocked(base, "worktrees.deferred_candidate_failed", added.stderr, candidatePath);
    }
    candidateRegistered = true;

    const merged = await input.runGit(
      ["merge", "--no-ff", "--no-commit", input.entry.head],
      { cwd: candidatePath }
    );
    if (merged.status !== 0) {
      await input.runGit(["merge", "--abort"], { cwd: candidatePath });
      return blocked(
        base,
        "worktrees.deferred_merge_conflict",
        "isolated merge reported a conflict; main and queued worktree were not changed",
        input.entry.path
      );
    }

    const committed = await input.runGit(
      ["commit", "-m", `Merge branch '${input.entry.branch}' (deferred reconcile)`],
      { cwd: candidatePath }
    );
    if (committed.status !== 0) {
      return blocked(base, "worktrees.deferred_commit_failed", committed.stderr, candidatePath);
    }
    const integrationCommitResult = await input.runGit(["rev-parse", "HEAD"], { cwd: candidatePath });
    if (integrationCommitResult.status !== 0) {
      return blocked(
        base,
        "worktrees.deferred_candidate_failed",
        integrationCommitResult.stderr,
        candidatePath
      );
    }
    const integrationCommit = integrationCommitResult.stdout.trim();

    nodeModulesLinked = await linkPrimaryNodeModules(input.audit.primary_path!, candidatePath);
    const verification = await input.verifier(candidatePath, input.audit.primary_path!);
    if (!verification.ok) {
      return {
        ...blocked(
          base,
          "worktrees.deferred_verification_failed",
          verification.message ?? "isolated verification failed",
          input.entry.path
        ),
        checks: verification.checks
      };
    }

    const mainStillCurrent = await mainStillSafe(
      input.runGit,
      input.audit.primary_path!,
      input.audit.main_branch!,
      mainHead
    );
    if (!mainStillCurrent.ok) {
      return {
        ...base,
        ok: true,
        issues: [],
        status: "waiting",
        waiting_reason: mainStillCurrent.reason,
        checks: verification.checks
      };
    }
    const targetStillCurrent = await queuedTargetStillSafe(
      input.runGit,
      input.audit.primary_path!,
      input.entry
    );
    if (!targetStillCurrent.ok) {
      return blocked(
        base,
        "worktrees.deferred_target_changed",
        targetStillCurrent.message,
        input.entry.path
      );
    }

    if (nodeModulesLinked) {
      await unlink(join(candidatePath, "node_modules"));
      nodeModulesLinked = false;
    }
    const removedCandidate = await input.runGit(["worktree", "remove", candidatePath], {
      cwd: input.audit.primary_path!
    });
    if (removedCandidate.status !== 0) {
      return blocked(
        base,
        "worktrees.deferred_candidate_cleanup_failed",
        removedCandidate.stderr,
        candidatePath
      );
    }
    candidateRegistered = false;

    const fastForward = await input.runGit(["merge", "--ff-only", integrationCommit], {
      cwd: input.audit.primary_path!
    });
    if (fastForward.status !== 0) {
      return blocked(
        base,
        "worktrees.deferred_main_changed",
        fastForward.stderr,
        input.audit.primary_path!
      );
    }
    const cleanup = await auditAndCleanupWorktrees({
      cwd: input.audit.primary_path!,
      apply: true,
      paths: [input.target.path],
      runGit: input.runGit
    });
    if (!cleanup.ok) {
      return {
        ...base,
        issues: cleanup.issues,
        checks: verification.checks,
        integration_commit: integrationCommit
      };
    }
    const remaining = input.queue.entries.slice(1);
    const written = await writeQueueFile(input.queue.queue_path, remaining);
    return {
      ...base,
      ok: written.ok,
      issues: written.issues,
      entries: written.ok ? remaining : input.queue.entries,
      applied: written.ok,
      status: written.ok ? "reconciled" : "blocked",
      integration_commit: integrationCommit,
      removed: cleanup.removed,
      checks: verification.checks
    };
  } finally {
    if (nodeModulesLinked) {
      try {
        await unlink(join(candidatePath, "node_modules"));
      } catch {
        // Best-effort unlink of the temporary dependency link.
      }
    }
    if (candidateRegistered) {
      await input.runGit(["merge", "--abort"], { cwd: candidatePath });
      await input.runGit(["worktree", "remove", candidatePath], {
        cwd: input.audit.primary_path!
      });
    }
  }
}

async function defaultCandidateVerifier(
  candidatePath: string,
  primaryPath: string
): Promise<DeferredVerificationResult> {
  const binRoot = join(primaryPath, "node_modules", ".bin");
  const checks = ["tsc --noEmit", "vitest run"];
  try {
    await execFileAsync(join(binRoot, "tsc"), ["-p", "tsconfig.json", "--noEmit"], {
      cwd: candidatePath,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    });
    await execFileAsync(
      join(binRoot, "vitest"),
      ["run", "--exclude=apps/**"],
      {
        cwd: candidatePath,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024
      }
    );
    return { ok: true, checks };
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string; message?: string };
    const message = (failure.stderr || failure.stdout || failure.message || "verification failed")
      .trim()
      .slice(0, 4000);
    return { ok: false, checks, message };
  }
}

async function linkPrimaryNodeModules(primaryPath: string, candidatePath: string): Promise<boolean> {
  const source = join(primaryPath, "node_modules");
  try {
    if (!(await stat(source)).isDirectory()) return false;
    await symlink(source, join(candidatePath, "node_modules"), "dir");
    return true;
  } catch {
    return false;
  }
}

async function mainStillSafe(
  runGit: GitCommandRunner,
  primaryPath: string,
  mainBranch: string,
  expectedHead: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const head = await runGit(["rev-parse", mainBranch], { cwd: primaryPath });
  if (head.status !== 0 || head.stdout.trim() !== expectedHead) {
    return { ok: false, reason: "main_changed" };
  }
  const statusResult = await runGit(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: primaryPath }
  );
  if (statusResult.status !== 0 || statusResult.stdout.trim() !== "") {
    return { ok: false, reason: "main_dirty" };
  }
  return { ok: true };
}

async function queuedTargetStillSafe(
  runGit: GitCommandRunner,
  primaryPath: string,
  entry: DeferredWorktreeEntry
): Promise<{ ok: true } | { ok: false; message: string }> {
  const audit = await auditAndCleanupWorktrees({
    cwd: primaryPath,
    paths: [entry.path],
    runGit
  });
  if (!audit.ok) return { ok: false, message: "queued worktree could not be re-audited" };
  const target = findTarget(audit.worktrees, entry.path);
  const issue = queuedIdentityIssue(target, entry);
  if (issue) return { ok: false, message: issue.message };
  return { ok: true };
}

function deferredTargetIssue(target: WorktreeReport): Issue | undefined {
  const blocked = target.block_reasons.filter((reason) =>
    reason !== "current" && reason !== "unmerged"
  );
  if (!target.branch) blocked.push("detached");
  if (blocked.length === 0) return undefined;
  return {
    code: "worktrees.deferred_target_unsafe",
    message: `worktree cannot be deferred (${[...new Set(blocked)].sort().join(", ")}): ${target.path}`,
    path: target.path
  };
}

function queuedIdentityIssue(
  target: WorktreeReport | undefined,
  entry: DeferredWorktreeEntry
): Issue | undefined {
  if (!target) {
    return {
      code: "worktrees.deferred_target_missing",
      message: "queued worktree is no longer registered",
      path: entry.path
    };
  }
  if (target.path !== entry.path || target.branch !== entry.branch || target.head !== entry.head) {
    return {
      code: "worktrees.deferred_target_changed",
      message: "queued worktree HEAD, branch, or path identity changed",
      path: entry.path
    };
  }
  const blocked = target.block_reasons.filter((reason) => reason !== "unmerged");
  if (blocked.length > 0) {
    return {
      code: "worktrees.deferred_target_unsafe",
      message: `queued worktree is unsafe (${blocked.join(", ")})`,
      path: entry.path
    };
  }
  return undefined;
}

function findTarget(
  reports: readonly WorktreeReport[],
  path: string
): WorktreeReport | undefined {
  return reports.find((entry) => samePath(entry.path, path));
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function blocked(
  base: ReconcileDeferredWorktreesResult,
  code: string,
  message: string,
  path?: string
): ReconcileDeferredWorktreesResult {
  return {
    ...base,
    ok: false,
    status: "blocked",
    issues: [{
      code,
      message: message.trim().slice(0, 4000) || code,
      ...(path ? { path } : {})
    }]
  };
}

async function resolveQueueLocation(
  cwd: string,
  runGit: GitCommandRunner
): Promise<{ ok: true; queuePath: string } | { ok: false; issues: Issue[] }> {
  const common = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd }
  );
  if (common.status !== 0) {
    return {
      ok: false,
      issues: [{
        code: "worktrees.git_unavailable",
        message: common.stderr.trim() || "unable to resolve git common dir"
      }]
    };
  }
  return { ok: true, queuePath: queuePathFor(common.stdout.trim()) };
}

function queuePathFor(gitCommonDir: string): string {
  return join(resolve(gitCommonDir), "tsugite", "deferred-worktrees.json");
}

async function readQueueFile(queuePath: string): Promise<DeferredWorktreeQueueResult> {
  try {
    const fileStat = await lstat(queuePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      return queueFailure(queuePath, "worktrees.deferred_queue_unsafe", "queue must be a regular file");
    }
    if (fileStat.size > MAX_QUEUE_BYTES) {
      return queueFailure(queuePath, "worktrees.deferred_queue_too_large", "queue exceeds 1 MiB");
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      return queueFailure(
        queuePath,
        "worktrees.deferred_queue_unreadable",
        error instanceof Error ? error.message : String(error)
      );
    }
    return { ok: true, issues: [], queue_path: queuePath, entries: [] };
  }

  try {
    const raw = JSON.parse(await readFile(queuePath, "utf8")) as unknown;
    const parsed = parseQueue(raw);
    if (!parsed) {
      return queueFailure(queuePath, "worktrees.deferred_queue_invalid", "queue schema is invalid");
    }
    return { ok: true, issues: [], queue_path: queuePath, entries: parsed.entries };
  } catch {
    return queueFailure(queuePath, "worktrees.deferred_queue_invalid", "queue JSON is invalid");
  }
}

async function writeQueueFile(
  queuePath: string,
  entries: readonly DeferredWorktreeEntry[]
): Promise<{ ok: boolean; issues: Issue[] }> {
  const directory = dirname(queuePath);
  let temporary = "";
  try {
    try {
      const dirStat = await lstat(directory);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        return {
          ok: false,
          issues: [{
            code: "worktrees.deferred_queue_unsafe",
            message: "queue directory must be a real directory",
            path: directory
          }]
        };
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      await mkdir(directory, { recursive: false, mode: 0o700 });
    }
    const payload = `${JSON.stringify({
      schema_version: QUEUE_SCHEMA_VERSION,
      entries
    } satisfies QueueFile, null, 2)}\n`;
    if (Buffer.byteLength(payload) > MAX_QUEUE_BYTES) {
      return {
        ok: false,
        issues: [{
          code: "worktrees.deferred_queue_too_large",
          message: "queue exceeds 1 MiB",
          path: queuePath
        }]
      };
    }
    temporary = join(directory, `.${basename(queuePath)}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, queuePath);
    temporary = "";
    return { ok: true, issues: [] };
  } catch (error) {
    if (temporary) {
      try {
        await unlink(temporary);
      } catch {
        // Best-effort cleanup of the exact temporary queue file.
      }
    }
    return {
      ok: false,
      issues: [{
        code: "worktrees.deferred_queue_write_failed",
        message: error instanceof Error ? error.message : String(error),
        path: queuePath
      }]
    };
  }
}

function parseQueue(value: unknown): QueueFile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.schema_version !== QUEUE_SCHEMA_VERSION || !Array.isArray(record.entries)) {
    return undefined;
  }
  if (record.entries.length > MAX_QUEUE_ENTRIES) return undefined;
  const entries: DeferredWorktreeEntry[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const item of record.entries) {
    if (!item || typeof item !== "object") return undefined;
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.id !== "string"
      || entry.id.length === 0
      || entry.id.length > 128
      || typeof entry.path !== "string"
      || !isAbsolute(entry.path)
      || entry.path.length > 4096
      || typeof entry.branch !== "string"
      || !isBoundedSafeText(entry.branch, 255)
      || typeof entry.head !== "string"
      || !/^[0-9a-f]{40,64}$/i.test(entry.head)
      || typeof entry.main_branch !== "string"
      || !isBoundedSafeText(entry.main_branch, 255)
      || typeof entry.authorized_at !== "string"
      || entry.authorized_at.length > 64
      || !Number.isFinite(Date.parse(entry.authorized_at))
      || entry.status !== "pending"
    ) return undefined;
    const resolvedPath = resolve(entry.path);
    if (ids.has(entry.id) || paths.has(resolvedPath)) return undefined;
    ids.add(entry.id);
    paths.add(resolvedPath);
    entries.push({
      id: entry.id,
      path: resolvedPath,
      branch: entry.branch,
      head: entry.head,
      main_branch: entry.main_branch,
      authorized_at: entry.authorized_at,
      status: "pending"
    });
  }
  return { schema_version: 1, entries };
}

function isBoundedSafeText(value: string, maximumLength: number): boolean {
  return value.length > 0
    && value.length <= maximumLength
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT"
  );
}

function queueFailure(
  queuePath: string,
  code: string,
  message: string
): DeferredWorktreeQueueResult {
  return {
    ok: false,
    issues: [{ code, message, path: queuePath }],
    queue_path: queuePath,
    entries: []
  };
}
