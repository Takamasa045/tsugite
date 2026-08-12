/**
 * Launcher maintenance boundary: thin adapter over canonical worktree/finalize CLI.
 * Safety decisions stay in lifecycle.ts / finalize*.ts; this module only:
 * - holds opaque review snapshots
 * - invokes pipeline via argv (no shell strings)
 * - revalidates live state before apply
 * - sanitizes CLI JSON for the UI
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  isWithinDirectory,
  resolveDurableProjectsHome
} from "../project/projectsHome.js";
import {
  labelWorktreeBlockReasons,
  MAINTENANCE_ISSUE,
  toMaintenanceIssues,
  toPublicMaintenanceIssue,
  type FinalizeApplyRequest,
  type FinalizePreviewRequest,
  type FinalizePreviewResponse,
  type FinalizeReviewSnapshot,
  type MaintenanceErrorResponse,
  type MaintenanceIssue,
  type MaintenanceJobRecord,
  type MaintenanceJobResponse,
  type PublicFinalizeDeletionSummary,
  type PublicWorktreeCandidate,
  type WorktreeApplyRequest,
  type WorktreeHeldCandidate,
  type WorktreePreviewResponse,
  type WorktreeReviewSnapshot
} from "./launcherMaintenanceTypes.js";

const REVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_REVIEWS = 32;
const MAX_JOBS = 64;
/** Bounded capture for maintenance CLI JSON (real worktrees preview is ~74KiB+). */
export const CLI_JSON_MAX_BYTES = 256 * 1024;
/** Real repos can report 90+ protected paths; keep a hard upper bound. */
const CLI_IGNORED_PROTECTED_MAX = 512;
const CLI_STATUS_ENTRIES_MAX = 512;
const FORBIDDEN_ARGV = new Set([
  "--force",
  "-f",
  "force",
  "branch",
  "stash",
  "rebase",
  "reset",
  "clean",
  "push",
  "fetch"
]);

const IssueSchema = z.object({
  code: z.string().min(1).max(200),
  message: z.string().min(1).max(2_000),
  path: z.string().max(1_000).optional()
}).strict();

const WorktreeEntrySchema = z.object({
  path: z.string().min(1).max(4_096),
  is_primary: z.boolean(),
  is_current: z.boolean(),
  branch: z.string().max(512).nullable(),
  head: z.string().min(7).max(128),
  merged_into_main: z.boolean(),
  dirty_tracked: z.boolean(),
  dirty_untracked: z.boolean(),
  locked: z.boolean(),
  missing: z.boolean(),
  removable: z.boolean(),
  block_reasons: z.array(z.string().max(128)).max(32),
  ignored_protected: z.array(z.string().max(512)).max(CLI_IGNORED_PROTECTED_MAX).optional().default([]),
  ignored_other: z.array(z.string().max(512)).max(256).optional().default([]),
  status_entries: z.array(z.unknown()).max(CLI_STATUS_ENTRIES_MAX).optional()
}).strict();

/** Full success/preview payload from `worktrees --json`. */
const WorktreeCliSchema = z.object({
  ok: z.boolean(),
  command: z.literal("worktrees").optional(),
  issues: z.array(IssueSchema).max(64).optional().default([]),
  warnings: z.array(IssueSchema).max(16).optional(),
  worktree_warning: z.object({
    active: z.boolean(),
    threshold: z.number().int().positive(),
    removable_count: z.number().int().nonnegative(),
    removable_paths: z.array(z.string()).max(256).optional()
  }).optional(),
  applied: z.boolean().optional(),
  git_common_dir: z.string().min(1).max(4_096),
  primary_path: z.string().min(1).max(4_096),
  current_path: z.string().min(1).max(4_096),
  main_branch: z.string().min(1).max(256),
  worktrees: z.array(WorktreeEntrySchema).max(256),
  targets: z.array(z.string()).max(32).optional(),
  removed: z.array(z.string()).max(32).optional()
}).passthrough();

/**
 * Minimal fail-closed error body for nonzero worktrees CLI.
 * Does not require full inventory fields; public issues stay fixed/redacted.
 */
const WorktreeCliErrorSchema = z.object({
  ok: z.literal(false),
  command: z.literal("worktrees").optional(),
  issues: z.array(IssueSchema).min(1).max(64)
}).passthrough();

const FinalizeCliSchema = z.object({
  ok: z.boolean(),
  command: z.literal("finalize").optional(),
  issues: z.array(IssueSchema).max(64).optional().default([]),
  applied: z.boolean().optional(),
  canonical_output: z.string().max(4_096).optional().nullable(),
  completion_record: z.string().max(4_096).optional().nullable(),
  /** Existence-based; path alone must not imply already finalized. */
  already_finalized: z.boolean().optional(),
  media_files: z.array(z.string().max(1_024)).max(2_048).optional().default([]),
  retained_media: z.array(z.string().max(1_024)).max(2_048).optional().default([]),
  planned_bytes: z.number().nonnegative().optional().default(0),
  deleted_files: z.number().int().nonnegative().optional().default(0),
  deleted_bytes: z.number().nonnegative().optional().default(0),
  plan_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  production_completion_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  unrestored_paths: z.array(z.string().max(1_024)).max(256).optional(),
  launcher_projects_home: z.string().max(4_096).optional().nullable(),
  launcher_project_root: z.string().max(4_096).optional().nullable(),
  launcher_already_home: z.boolean().optional(),
  promoted_to_launcher_home: z.boolean().optional(),
  launcher_config_path: z.string().max(4_096).optional().nullable(),
  launcher_visible: z.boolean().optional()
}).passthrough();

/**
 * Maintenance-only shell:false runner with capture capped at CLI_JSON_MAX_BYTES.
 * Do not reuse the general launcher job runner (16KiB); real worktrees JSON is larger.
 * Truncation is typed (`truncated: true`) and must surface as cli_too_large before parse.
 */
export function createMaintenancePipelineRunner(options: {
  nodePath?: string;
  pipelineEntry: string;
  cwd: string;
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
}): MaintenancePipelineRunner {
  const maxBytes = options.maxBytes ?? CLI_JSON_MAX_BYTES;
  if (
    !Number.isSafeInteger(maxBytes)
    || maxBytes <= 0
    || maxBytes > CLI_JSON_MAX_BYTES
  ) {
    throw new Error(`maintenance runner maxBytes must be a safe integer in 1..${CLI_JSON_MAX_BYTES}`);
  }
  const nodePath = options.nodePath ?? process.execPath;
  return async (args) => {
    assertSafeArgv(args);
    return await new Promise((resolveProcess, reject) => {
      const child = spawn(nodePath, [options.pipelineEntry, ...args], {
        cwd: options.cwd,
        ...(options.env ? { env: options.env } : {}),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      const collect = (chunks: Buffer[], chunk: Buffer, currentBytes: number) => {
        const remaining = Math.max(0, maxBytes - currentBytes);
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        return {
          bytes: currentBytes + Math.min(chunk.length, remaining),
          truncated: chunk.length > remaining
        };
      };
      child.stdout.on("data", (chunk: Buffer) => {
        const result = collect(stdout, chunk, stdoutBytes);
        stdoutBytes = result.bytes;
        stdoutTruncated ||= result.truncated;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const result = collect(stderr, chunk, stderrBytes);
        stderrBytes = result.bytes;
        stderrTruncated ||= result.truncated;
      });
      child.once("error", reject);
      child.once("close", (code) => {
        resolveProcess({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          truncated: stdoutTruncated || stderrTruncated
        });
      });
    });
  };
}

/** Bounded CLI capture result. `truncated` is a typed contract, not a string marker. */
export type MaintenancePipelineResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when collector hit the byte cap (do not parse as success JSON). */
  truncated?: boolean;
};

/**
 * Runs `node bin/pipeline <args...>` via the launcher process runner.
 * Args are pipeline subcommand argv only (no shell, no node binary).
 */
export type MaintenancePipelineRunner = (
  args: readonly string[]
) => Promise<MaintenancePipelineResult>;

export type MaintenanceProjectLookup = {
  id: string;
  name: string;
  configPath: string;
  readOnly: boolean;
  valid: boolean;
  runId: string;
  revision: string;
  status: string;
  identityKey?: string;
  /** Full identity fingerprint (realpath + device/inode + run/revision). */
  identityFingerprint?: string;
  realConfigPath?: string;
  realProjectDir?: string;
  configDevice?: number;
  configInode?: number;
  projectDevice?: number;
  projectInode?: number;
};

/** Filesystem presence after worktree remove. ENOENT only → absent. */
export type RemovedPathInspection = "absent" | "present" | "error";

export type LauncherMaintenanceController = {
  previewWorktrees: () => Promise<WorktreePreviewResponse | MaintenanceErrorResponse>;
  applyWorktree: (
    body: unknown
  ) => Promise<MaintenanceJobResponse | MaintenanceErrorResponse>;
  previewFinalize: (
    project: MaintenanceProjectLookup,
    body: unknown
  ) => Promise<FinalizePreviewResponse | MaintenanceErrorResponse>;
  applyFinalize: (
    project: MaintenanceProjectLookup,
    body: unknown
  ) => Promise<MaintenanceJobResponse | MaintenanceErrorResponse>;
  getJob: (jobId: string) => MaintenanceJobResponse | MaintenanceErrorResponse;
  hasBlockingWork: () => boolean;
  /** Drop a finalize review (orphan cleanup after route post-check failure). */
  dropFinalizeReview: (reviewId: string) => void;
  /** Test seam: last argv arrays passed to the pipeline runner. */
  lastPipelineArgv: () => readonly (readonly string[])[];
  /** Test seam: clear review/job stores. */
  resetForTests: () => void;
};

export type CreateLauncherMaintenanceControllerOptions = {
  runPipeline: MaintenancePipelineRunner;
  now?: () => number;
  reviewTtlMs?: number;
  /**
   * Canonical durable projects home (real, non-symlink preferred).
   * When set, post-durable resolver and finalize containment use this home only.
   * Desktop must pass the selected workspace projectsDir; never a readOnly shelf.
   */
  durableProjectsHome?: string;
  /**
   * Route-level full project identity revalidation. Called after live CLI preview
   * and immediately before apply argv. Must not trust client paths.
   * Production contract: omit → fail-closed on finalize apply. Tests must pass
   * an explicit callback (even a constant true) rather than relying on default.
   */
  revalidateProjectIdentity?: (project: MaintenanceProjectLookup) => Promise<boolean>;
  /**
   * Inspect a removed worktree path. Default uses lstat; ENOENT → absent.
   * Symlink / permission / other errors → error (fail-closed). Tests inject this.
   */
  inspectRemovedPath?: (path: string) => Promise<RemovedPathInspection>;
  /**
   * Validate durable launcher_config_path at preview and pre-mutation apply.
   * Default: realpath + durable projects home containment; symlink/repo-out rejected.
   */
  resolveLauncherConfigPath?: (
    configPath: string
  ) => Promise<{ ok: true; path: string } | { ok: false; issue: MaintenanceIssue }>;
};

export function createLauncherMaintenanceController(
  options: CreateLauncherMaintenanceControllerOptions
): LauncherMaintenanceController {
  const now = options.now ?? (() => Date.now());
  const reviewTtlMs = options.reviewTtlMs ?? REVIEW_TTL_MS;
  const inspectRemovedPath = options.inspectRemovedPath ?? defaultInspectRemovedPath;
  const durableProjectsHome = options.durableProjectsHome
    ? resolve(options.durableProjectsHome)
    : undefined;
  const resolveLauncherConfigPath = options.resolveLauncherConfigPath
    ?? ((configPath: string) => defaultResolveLauncherConfigPath(configPath, {
      durableProjectsHome
    }));
  const worktreeReviews = new Map<string, WorktreeReviewSnapshot>();
  const finalizeReviews = new Map<string, FinalizeReviewSnapshot>();
  const jobs = new Map<string, MaintenanceJobRecord>();
  let applyInFlight: string | null = null;
  const argvLog: string[][] = [];

  const runPipeline = async (args: readonly string[]) => {
    assertSafeArgv(args);
    argvLog.push([...args]);
    return options.runPipeline(args);
  };

  const prune = (at: number) => {
    for (const [id, review] of worktreeReviews) {
      if (review.expiresAtMs <= at) worktreeReviews.delete(id);
    }
    for (const [id, review] of finalizeReviews) {
      if (review.expiresAtMs <= at) finalizeReviews.delete(id);
    }
    while (worktreeReviews.size > MAX_REVIEWS) {
      const oldest = [...worktreeReviews.entries()].sort((a, b) => a[1].createdAtMs - b[1].createdAtMs)[0];
      if (!oldest) break;
      worktreeReviews.delete(oldest[0]);
    }
    while (finalizeReviews.size > MAX_REVIEWS) {
      const oldest = [...finalizeReviews.entries()].sort((a, b) => a[1].createdAtMs - b[1].createdAtMs)[0];
      if (!oldest) break;
      finalizeReviews.delete(oldest[0]);
    }
    while (jobs.size > MAX_JOBS) {
      const oldest = [...jobs.entries()].sort(
        (a, b) => Date.parse(a[1].startedAt) - Date.parse(b[1].startedAt)
      )[0];
      if (!oldest) break;
      jobs.delete(oldest[0]);
    }
  };

  const parseCliJson = <T>(
    raw: string,
    schema: z.ZodType<T>,
    options: { truncated?: boolean } = {}
  ): { ok: true; value: T } | { ok: false; issue: MaintenanceIssue } => {
    // H4: typed truncation / byte-cap before JSON parse → cli_too_large (not cli_invalid).
    if (options.truncated) {
      return { ok: false, issue: MAINTENANCE_ISSUE.cliTooLarge };
    }
    const bytes = Buffer.byteLength(raw, "utf8");
    if (bytes > CLI_JSON_MAX_BYTES) {
      return { ok: false, issue: MAINTENANCE_ISSUE.cliTooLarge };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, issue: MAINTENANCE_ISSUE.cliInvalid };
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      return { ok: false, issue: MAINTENANCE_ISSUE.cliInvalid };
    }
    return { ok: true, value: result.data };
  };

  const nonzeroFailureFromSource = (
    source: string,
    truncated: boolean | undefined,
    kind: "worktree" | "finalize"
  ): { ok: false; issue: MaintenanceIssue; issues?: MaintenanceIssue[] } => {
    if (truncated || Buffer.byteLength(source, "utf8") > CLI_JSON_MAX_BYTES) {
      return { ok: false, issue: MAINTENANCE_ISSUE.cliTooLarge };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      return { ok: false, issue: MAINTENANCE_ISSUE.cliInvalid };
    }
    // M2: minimal `{ok:false,issues}` stays fail-closed without collapsing to cli_invalid.
    if (kind === "worktree") {
      const minimal = WorktreeCliErrorSchema.safeParse(parsed);
      if (minimal.success) {
        const issues = toMaintenanceIssues(minimal.data.issues);
        return {
          ok: false,
          issue: toPublicMaintenanceIssue(issues[0] ?? MAINTENANCE_ISSUE.cliNonZeroExit),
          issues
        };
      }
    }
    const full = kind === "worktree"
      ? WorktreeCliSchema.safeParse(parsed)
      : FinalizeCliSchema.safeParse(parsed);
    if (full.success) {
      const issues = toMaintenanceIssues(full.data.issues);
      return {
        ok: false,
        issue: toPublicMaintenanceIssue(issues[0] ?? MAINTENANCE_ISSUE.cliNonZeroExit),
        ...(issues.length > 0 ? { issues } : {})
      };
    }
    // Unknown shape on nonzero: still fail-closed as nonzero, not generic parse success.
    return { ok: false, issue: MAINTENANCE_ISSUE.cliNonZeroExit };
  };

  const failClosedPreview = <T extends { issues?: { code: string; message: string; path?: string }[] }>(
    result: MaintenancePipelineResult,
    schema: z.ZodType<T>,
    kind: "worktree" | "finalize"
  ): { ok: true; value: T } | { ok: false; issue: MaintenanceIssue; issues?: MaintenanceIssue[] } => {
    const source = result.exitCode === 0
      ? result.stdout
      : (result.stdout.trim() ? result.stdout : result.stderr);
    // exitCode !== 0 always fail-closes; structured issues are display-only.
    if (result.exitCode !== 0) {
      return nonzeroFailureFromSource(source, result.truncated, kind);
    }
    const parsed = parseCliJson(source, schema, { truncated: result.truncated });
    if (!parsed.ok) return { ok: false, issue: parsed.issue };
    return { ok: true, value: parsed.value };
  };

  const runWorktreePreviewCli = async () => {
    const result = await runPipeline(["worktrees", "--json"]);
    return failClosedPreview(result, WorktreeCliSchema, "worktree");
  };

  const runFinalizePreviewCli = async (configPath: string) => {
    const result = await runPipeline(["finalize", "--config", configPath, "--json"]);
    return failClosedPreview(result, FinalizeCliSchema, "finalize");
  };

  const parseApplyCli = <T extends { issues?: { code: string; message: string; path?: string }[] }>(
    result: MaintenancePipelineResult,
    schema: z.ZodType<T>,
    kind: "worktree" | "finalize"
  ): { ok: true; value: T } | { ok: false; issue: MaintenanceIssue; issues?: MaintenanceIssue[] } => {
    // Fail-closed: exitCode !== 0 is never success, even if body claims ok/applied.
    const source = result.exitCode === 0
      ? result.stdout
      : (result.stdout.trim() ? result.stdout : result.stderr);
    if (result.exitCode !== 0) {
      return nonzeroFailureFromSource(source, result.truncated, kind);
    }
    const parsed = parseCliJson(source, schema, { truncated: result.truncated });
    if (!parsed.ok) return { ok: false, issue: parsed.issue };
    return { ok: true, value: parsed.value };
  };

  const previewWorktrees = async (): Promise<WorktreePreviewResponse | MaintenanceErrorResponse> => {
    const at = now();
    prune(at);
    const cli = await runWorktreePreviewCli();
    if (!cli.ok) return { ok: false, issue: cli.issue };
    if (cli.value.applied === true) {
      return { ok: false, issue: MAINTENANCE_ISSUE.cliInvalid };
    }

    const reviewId = opaqueId("wtr");
    const candidates = new Map<string, WorktreeHeldCandidate>();
    const publicRemovable: PublicWorktreeCandidate[] = [];
    const publicBlocked: PublicWorktreeCandidate[] = [];

    for (const entry of cli.value.worktrees) {
      const candidateId = opaqueId("wtc");
      const held: WorktreeHeldCandidate = {
        candidateId,
        path: entry.path,
        head: entry.head,
        branch: entry.branch,
        removable: entry.removable,
        isPrimary: entry.is_primary,
        isCurrent: entry.is_current,
        displayName: basename(entry.path) || entry.path,
        blockReasons: [...entry.block_reasons],
        ignoredProtected: [...(entry.ignored_protected ?? [])],
        mergedIntoMain: entry.merged_into_main,
        dirtyTracked: entry.dirty_tracked,
        dirtyUntracked: entry.dirty_untracked,
        locked: entry.locked,
        missing: entry.missing
      };
      candidates.set(candidateId, held);
      const pub = toPublicWorktreeCandidate(held);
      if (held.removable) publicRemovable.push(pub);
      else publicBlocked.push(pub);
    }

    const expiresAtMs = at + reviewTtlMs;
    worktreeReviews.set(reviewId, {
      reviewId,
      createdAtMs: at,
      expiresAtMs,
      gitCommonDir: cli.value.git_common_dir,
      mainBranch: cli.value.main_branch,
      primaryPath: cli.value.primary_path,
      currentPath: cli.value.current_path,
      candidates
    });

    const tidy = publicRemovable.length === 0;
    // M3: zero removable is tidy/idle-class — not "recorded" (that is post-apply only).
    const phase: WorktreePreviewResponse["phase"] = publicRemovable.length > 0
      ? "reviewable"
      : "blocked";
    return {
      ok: true,
      reviewId,
      phase,
      expiresAt: new Date(expiresAtMs).toISOString(),
      mainBranch: cli.value.main_branch,
      removableCount: publicRemovable.length,
      blockedCount: publicBlocked.length,
      warningActive: cli.value.worktree_warning?.active === true,
      warningThreshold: cli.value.worktree_warning?.threshold
        ?? Math.max(3, publicRemovable.length || 3),
      candidates: publicRemovable,
      blocked: publicBlocked,
      tidy
    };
  };

  const applyWorktree = async (
    body: unknown
  ): Promise<MaintenanceJobResponse | MaintenanceErrorResponse> => {
    const at = now();
    prune(at);
    const parsed = parseWorktreeApplyBody(body);
    if (!parsed.ok) return parsed;

    if (applyInFlight) {
      return { ok: false, issue: MAINTENANCE_ISSUE.applyBusy };
    }

    const review = worktreeReviews.get(parsed.value.reviewId);
    if (!review || review.expiresAtMs <= at) {
      return { ok: false, issue: MAINTENANCE_ISSUE.reviewMissing };
    }
    const candidate = review.candidates.get(parsed.value.candidateId);
    if (!candidate) {
      return { ok: false, issue: MAINTENANCE_ISSUE.candidateMissing };
    }
    if (!candidate.removable) {
      return { ok: false, issue: MAINTENANCE_ISSUE.candidateBlocked };
    }

    const jobId = opaqueId("job");
    const job: MaintenanceJobRecord = {
      id: jobId,
      kind: "worktree",
      status: "running",
      phase: "applying",
      startedAt: new Date(at).toISOString()
    };
    jobs.set(jobId, job);
    applyInFlight = jobId;

    try {
      job.phase = "revalidating";
      const live = await runWorktreePreviewCli();
      if (!live.ok) {
        return failJob(job, live.issue, "failed");
      }
      const match = live.value.worktrees.find((entry) => entry.path === candidate.path);
      if (
        !match
        || match.head !== candidate.head
        || match.branch !== candidate.branch
        || live.value.git_common_dir !== review.gitCommonDir
        || match.removable !== true
      ) {
        job.phase = "stale";
        return failJob(job, MAINTENANCE_ISSUE.snapshotStale, "stale");
      }

      job.phase = "applying";
      const applyResult = await runPipeline([
        "worktrees",
        "--apply",
        "--actor", "coordinator",
        "--path", candidate.path,
        "--json"
      ]);
      const applied = parseApplyCli(applyResult, WorktreeCliSchema, "worktree");
      if (!applied.ok) {
        // Mutation started: exit0 truncated/corrupt JSON cannot deny side effects.
        if (applyResult.exitCode === 0) {
          worktreeReviews.delete(review.reviewId);
          return failJob(
            job,
            applied.issue,
            "applied_unverified",
            [applied.issue, MAINTENANCE_ISSUE.appliedUnverified]
          );
        }
        return failJob(job, applied.issue, "failed", applied.issues);
      }
      if (!applied.value.ok || applied.value.applied !== true) {
        const issues = toMaintenanceIssues(applied.value.issues);
        return failJob(
          job,
          issues[0] ?? {
            code: "maintenance.worktree_apply_failed",
            message: "Worktree cleanup was refused by the canonical CLI"
          },
          "failed",
          issues
        );
      }

      // H2: removed must be exactly one entry equal to the server-held target path.
      // applied:true already claimed mutation — consume review even when removed mismatches.
      const removedPaths = applied.value.removed ?? [];
      if (!isExactSingleRemovedTarget(removedPaths, candidate.path)) {
        worktreeReviews.delete(review.reviewId);
        return failJob(
          job,
          MAINTENANCE_ISSUE.worktreeRemoveUnconfirmed,
          "applied_unverified",
          [MAINTENANCE_ISSUE.worktreeRemoveUnconfirmed, MAINTENANCE_ISSUE.appliedUnverified]
        );
      }

      // Mutating CLI confirmed exact removal — review is consumed; post-verify may only
      // yield applied_unverified (never re-applyable success path with same review).
      worktreeReviews.delete(review.reviewId);
      job.sideEffectConfirmed = true;

      job.phase = "verifying";
      const post = await runWorktreePreviewCli();
      if (!post.ok) {
        return failJob(job, post.issue, "applied_unverified", [post.issue, MAINTENANCE_ISSUE.appliedUnverified]);
      }
      const stillPresent = post.value.worktrees.some(
        (entry) => maintenancePathsEqual(entry.path, candidate.path)
      );
      if (stillPresent) {
        return failJob(job, MAINTENANCE_ISSUE.worktreeStillPresent, "applied_unverified");
      }

      // Exact-path lstat: ENOENT only succeeds; symlink/permission/other → applied_unverified.
      const pathState = await inspectRemovedPath(candidate.path);
      if (pathState === "present") {
        return failJob(job, MAINTENANCE_ISSUE.worktreeStillPresent, "applied_unverified");
      }
      if (pathState === "error") {
        return failJob(job, MAINTENANCE_ISSUE.worktreePathInspectFailed, "applied_unverified");
      }

      job.status = "succeeded";
      job.phase = "recorded";
      job.completedAt = new Date(now()).toISOString();
      job.message = `作業場所「${candidate.displayName}」を整理しました（ブランチは残ります）`;
      job.worktree = {
        removedDisplayName: candidate.displayName,
        postPreviewTidy: post.value.worktrees.every((entry) => !entry.removable),
        removableCount: post.value.worktrees.filter((entry) => entry.removable).length
      };
      return { ok: true, job: publicJob(job) };
    } catch {
      // After side effects or review consumption, never report re-applyable failed.
      const reviewConsumed = !worktreeReviews.has(review.reviewId);
      const status = job.sideEffectConfirmed || reviewConsumed
        ? "applied_unverified"
        : "failed";
      if (status === "applied_unverified") {
        worktreeReviews.delete(review.reviewId);
      }
      return failJob(job, MAINTENANCE_ISSUE.internal, status);
    } finally {
      if (applyInFlight === jobId) applyInFlight = null;
    }
  };

  const previewFinalize = async (
    project: MaintenanceProjectLookup,
    body: unknown
  ): Promise<FinalizePreviewResponse | MaintenanceErrorResponse> => {
    const at = now();
    prune(at);

    if (project.readOnly) {
      return { ok: false, issue: MAINTENANCE_ISSUE.readOnlyProject };
    }
    if (!project.valid) {
      return {
        ok: false,
        issue: {
          code: "maintenance.project_invalid",
          message: "Project is invalid and cannot be finalized"
        }
      };
    }
    if (project.status !== "completed") {
      return { ok: false, issue: MAINTENANCE_ISSUE.projectNotCompleted };
    }

    const parsed = parseFinalizePreviewBody(body);
    if (!parsed.ok) return parsed;
    if (parsed.value.completionDeclared !== true) {
      return { ok: false, issue: MAINTENANCE_ISSUE.completionRequired };
    }
    if (
      parsed.value.expectedRunId !== project.runId
      || parsed.value.revision !== project.revision
    ) {
      return { ok: false, issue: MAINTENANCE_ISSUE.projectMismatch };
    }

    const cli = await runFinalizePreviewCli(project.configPath);
    if (!cli.ok) return { ok: false, issue: cli.issue };
    if (cli.value.applied === true) {
      return { ok: false, issue: MAINTENANCE_ISSUE.cliInvalid };
    }

    const issues = toMaintenanceIssues(cli.value.issues);
    if (!cli.value.ok || !cli.value.plan_digest) {
      return {
        ok: false,
        issue: issues[0] ?? {
          code: "maintenance.finalize_preview_failed",
          message: "Finalize preview was refused by the canonical CLI"
        },
        issues
      };
    }

    const deletion = summarizeDeletion(cli.value);
    // Prefer explicit existence-based flag from core/CLI. Never infer from path alone.
    // Remaining candidates must keep already_finalized false even if a path is reported.
    const alreadyFinalized = cli.value.already_finalized === true && deletion.plannedFiles === 0;
    const identityKey = project.identityKey
      ?? maintenanceIdentityKey({
        configPath: project.configPath,
        runId: project.runId,
        revision: project.revision
      });
    const identityFingerprint = project.identityFingerprint
      ?? maintenanceIdentityFingerprint({
        configPath: project.configPath,
        runId: project.runId,
        revision: project.revision,
        identityKey,
        realConfigPath: project.realConfigPath,
        realProjectDir: project.realProjectDir,
        configDevice: project.configDevice,
        configInode: project.configInode,
        projectDevice: project.projectDevice,
        projectInode: project.projectInode
      });

    // Preview must resolve durable launcher_config_path before issuing a review.
    // Active-home containment / existence / symlink escape are fail-closed here.
    const rawLauncherConfig = typeof cli.value.launcher_config_path === "string"
      ? cli.value.launcher_config_path.trim()
      : "";
    if (!rawLauncherConfig) {
      return { ok: false, issue: MAINTENANCE_ISSUE.launcherConfigRequired };
    }
    const resolvedLauncherConfig = await resolveLauncherConfigPath(rawLauncherConfig);
    if (!resolvedLauncherConfig.ok) {
      return { ok: false, issue: resolvedLauncherConfig.issue };
    }

    const reviewId = opaqueId("ftr");
    const expiresAtMs = at + reviewTtlMs;
    // Planned path is always reported for UX; label differs when not yet finalized (M5).
    const completionRecordPath = cli.value.completion_record
      ? (sanitizeProjectRelative(cli.value.completion_record) ?? null)
      : null;
    finalizeReviews.set(reviewId, {
      reviewId,
      createdAtMs: at,
      expiresAtMs,
      projectId: project.id,
      projectName: project.name,
      configPath: project.configPath,
      runId: project.runId,
      revision: project.revision,
      planDigest: cli.value.plan_digest,
      productionCompletionDigest: cli.value.production_completion_digest,
      identityKey,
      identityFingerprint,
      alreadyFinalized,
      canonicalOutput: sanitizeProjectRelative(cli.value.canonical_output ?? undefined),
      completionRecord: completionRecordPath,
      deletion,
      launcherVisible: cli.value.launcher_visible === true
        || Boolean(cli.value.launcher_project_root),
      launcherAlreadyHome: cli.value.launcher_already_home === true,
      promotedToLauncherHome: cli.value.promoted_to_launcher_home === true,
      // Store resolved real canonical path only (never the raw CLI string).
      launcherConfigPath: resolvedLauncherConfig.path
    });

    return {
      ok: true,
      reviewId,
      phase: alreadyFinalized ? "already_finalized" : "reviewable",
      expiresAt: new Date(expiresAtMs).toISOString(),
      projectId: project.id,
      projectName: project.name,
      runId: project.runId,
      revision: project.revision,
      planDigest: cli.value.plan_digest,
      planDigestShort: shortDigest(cli.value.plan_digest),
      ...(cli.value.production_completion_digest
        ? {
            productionCompletionDigest: cli.value.production_completion_digest,
            productionCompletionDigestShort: shortDigest(cli.value.production_completion_digest)
          }
        : {}),
      canonicalOutput: sanitizeProjectRelative(cli.value.canonical_output ?? undefined),
      completionRecord: completionRecordPath,
      alreadyFinalized,
      launcherVisible: cli.value.launcher_visible === true
        || Boolean(cli.value.launcher_project_root),
      launcherAlreadyHome: cli.value.launcher_already_home === true,
      promotedToLauncherHome: cli.value.promoted_to_launcher_home === true,
      deletion,
      issues
    };
  };

  const applyFinalize = async (
    project: MaintenanceProjectLookup,
    body: unknown
  ): Promise<MaintenanceJobResponse | MaintenanceErrorResponse> => {
    const at = now();
    prune(at);
    if (project.readOnly) {
      return { ok: false, issue: MAINTENANCE_ISSUE.readOnlyProject };
    }
    const parsed = parseFinalizeApplyBody(body);
    if (!parsed.ok) return parsed;

    if (applyInFlight) {
      return { ok: false, issue: MAINTENANCE_ISSUE.applyBusy };
    }

    const review = finalizeReviews.get(parsed.value.reviewId);
    if (!review || review.expiresAtMs <= at) {
      return { ok: false, issue: MAINTENANCE_ISSUE.reviewMissing };
    }
    // H3/M3: full identity match before status so swaps always surface as project_mismatch.
    if (review.projectId !== project.id) {
      return { ok: false, issue: MAINTENANCE_ISSUE.projectMismatch };
    }
    const liveIdentityKey = project.identityKey
      ?? maintenanceIdentityKey({
        configPath: project.configPath,
        runId: project.runId,
        revision: project.revision
      });
    const liveFingerprint = project.identityFingerprint
      ?? maintenanceIdentityFingerprint({
        configPath: project.configPath,
        runId: project.runId,
        revision: project.revision,
        identityKey: liveIdentityKey,
        realConfigPath: project.realConfigPath,
        realProjectDir: project.realProjectDir,
        configDevice: project.configDevice,
        configInode: project.configInode,
        projectDevice: project.projectDevice,
        projectInode: project.projectInode
      });
    if (
      review.runId !== project.runId
      || review.revision !== project.revision
      || review.configPath !== project.configPath
      || review.identityKey !== liveIdentityKey
      || review.identityFingerprint !== liveFingerprint
    ) {
      return { ok: false, issue: MAINTENANCE_ISSUE.projectMismatch };
    }
    if (project.status !== "completed") {
      return { ok: false, issue: MAINTENANCE_ISSUE.projectNotCompleted };
    }
    if (review.alreadyFinalized) {
      return {
        ok: false,
        issue: {
          code: "maintenance.already_finalized",
          message: "This project is already finalized; no media cleanup is needed"
        }
      };
    }
    if (parsed.value.planDigest !== review.planDigest) {
      return { ok: false, issue: MAINTENANCE_ISSUE.planStale };
    }
    // Additive production_completion_digest: when held on review, client must match exactly.
    if (review.productionCompletionDigest) {
      if (
        !parsed.value.productionCompletionDigest
        || parsed.value.productionCompletionDigest !== review.productionCompletionDigest
      ) {
        return { ok: false, issue: MAINTENANCE_ISSUE.planStale };
      }
    } else if (parsed.value.productionCompletionDigest) {
      return { ok: false, issue: MAINTENANCE_ISSUE.planStale };
    }
    // Preview-held durable launcher_config_path is required before any mutating apply.
    // Never fall back to apply-report-only paths (prevents borrowing another finalized state).
    const reviewHeldLauncherConfig = typeof review.launcherConfigPath === "string"
      ? review.launcherConfigPath.trim()
      : "";
    if (!reviewHeldLauncherConfig) {
      return { ok: false, issue: MAINTENANCE_ISSUE.launcherConfigRequired };
    }

    const jobId = opaqueId("job");
    const job: MaintenanceJobRecord = {
      id: jobId,
      kind: "finalize",
      status: "running",
      phase: "applying",
      startedAt: new Date(at).toISOString()
    };
    jobs.set(jobId, job);
    applyInFlight = jobId;

    try {
      job.phase = "revalidating";
      const live = await runFinalizePreviewCli(project.configPath);
      if (!live.ok) {
        return failJob(job, live.issue, "failed");
      }
      if (
        !live.value.ok
        || !live.value.plan_digest
        || live.value.plan_digest !== review.planDigest
        || live.value.plan_digest !== parsed.value.planDigest
        || (review.productionCompletionDigest
          ? live.value.production_completion_digest !== review.productionCompletionDigest
          : Boolean(live.value.production_completion_digest))
      ) {
        job.phase = "stale";
        return failJob(job, MAINTENANCE_ISSUE.planStale, "stale");
      }
      // Do not skip apply when plannedFiles===0 and record is only a path.
      if (live.value.already_finalized === true) {
        return failJob(job, {
          code: "maintenance.already_finalized",
          message: "This project is already finalized; no media cleanup is needed"
        }, "failed");
      }

      // M6: production contract — omit revalidateProjectIdentity → fail-closed.
      if (!options.revalidateProjectIdentity) {
        finalizeReviews.delete(review.reviewId);
        return failJob(job, MAINTENANCE_ISSUE.projectMismatch, "failed");
      }
      // After live CLI preview and immediately before apply argv, re-check FS identity.
      const stillSame = await options.revalidateProjectIdentity({
        ...project,
        identityKey: liveIdentityKey,
        identityFingerprint: liveFingerprint
      });
      if (!stillSame) {
        finalizeReviews.delete(review.reviewId);
        return failJob(job, MAINTENANCE_ISSUE.projectMismatch, "failed");
      }

      // Re-resolve review-held durable path immediately before mutation.
      // Fail closed without applying when path was swapped / vanished after preview.
      const heldResolved = await resolveLauncherConfigPath(reviewHeldLauncherConfig);
      if (!heldResolved.ok) {
        return failJob(job, heldResolved.issue, "failed");
      }

      job.phase = "applying";
      const applyArgv = [
        "finalize",
        "--config", project.configPath,
        "--apply",
        "--actor", "coordinator",
        "--expected-plan-digest", review.planDigest,
        ...(review.productionCompletionDigest
          ? [
              "--expected-production-completion-digest",
              review.productionCompletionDigest
            ]
          : []),
        "--json"
      ];
      const applyResult = await runPipeline(applyArgv);
      const applied = parseApplyCli(applyResult, FinalizeCliSchema, "finalize");
      if (!applied.ok) {
        const code = applied.issue.code ?? "";
        if (code === "finalize.plan_stale") {
          job.phase = "stale";
          return failJob(job, MAINTENANCE_ISSUE.planStale, "stale", applied.issues);
        }
        // Mutation started: exit0 truncated/corrupt JSON cannot deny side effects.
        if (applyResult.exitCode === 0) {
          finalizeReviews.delete(review.reviewId);
          return failJob(
            job,
            applied.issue,
            "applied_unverified",
            [applied.issue, MAINTENANCE_ISSUE.appliedUnverified]
          );
        }
        return failJob(job, applied.issue, "failed", applied.issues);
      }
      if (!applied.value.ok || applied.value.applied !== true) {
        const issues = toMaintenanceIssues(applied.value.issues);
        const code = issues[0]?.code ?? "";
        if (code === "finalize.plan_stale") {
          job.phase = "stale";
          return failJob(job, MAINTENANCE_ISSUE.planStale, "stale", issues);
        }
        return failJob(
          job,
          issues[0] ?? {
            code: "maintenance.finalize_apply_failed",
            message: "Finalize was refused by the canonical CLI"
          },
          "failed",
          issues
        );
      }

      // Mutating apply confirmed — consume review; post failures are applied_unverified.
      finalizeReviews.delete(review.reviewId);
      job.sideEffectConfirmed = true;

      job.phase = "verifying";
      // Post-preview uses pre-mutation resolved path only (no apply-path fallback).
      // Apply report must resolve to the same real path as the review-held canonical.
      const applyReportedConfig = typeof applied.value.launcher_config_path === "string"
        ? applied.value.launcher_config_path.trim()
        : "";
      const applyResolved = applyReportedConfig
        ? await resolveLauncherConfigPath(applyReportedConfig)
        : { ok: false as const, issue: MAINTENANCE_ISSUE.postVerifyFailed };
      if (
        !applyResolved.ok
        || !maintenancePathsEqual(heldResolved.path, applyResolved.path)
      ) {
        // Adversarial swap / missing apply report — cannot borrow another finalized state.
        return failJob(
          job,
          MAINTENANCE_ISSUE.postVerifyFailed,
          "applied_unverified",
          [MAINTENANCE_ISSUE.postVerifyFailed, MAINTENANCE_ISSUE.appliedUnverified]
        );
      }
      const verifyConfigPath = heldResolved.path;

      const post = await runFinalizePreviewCli(verifyConfigPath);
      if (!post.ok) {
        return failJob(
          job,
          post.issue,
          "applied_unverified",
          [post.issue, MAINTENANCE_ISSUE.appliedUnverified]
        );
      }
      // Trust CLI already_finalized; refuse if CLI claims finalized while still listing deletions.
      const postDeletion = summarizeDeletion(post.value);
      if (post.value.already_finalized !== true || postDeletion.plannedFiles > 0) {
        return failJob(
          job,
          MAINTENANCE_ISSUE.postVerifyFailed,
          "applied_unverified",
          [MAINTENANCE_ISSUE.postVerifyFailed, MAINTENANCE_ISSUE.appliedUnverified]
        );
      }
      if (!post.value.completion_record && !applied.value.completion_record) {
        return failJob(job, {
          code: "maintenance.completion_record_missing",
          message: "Finalize reported success without a completion record"
        }, "applied_unverified");
      }

      job.status = "succeeded";
      job.phase = "completion_recorded";
      job.completedAt = new Date(now()).toISOString();
      job.message = `案件「${project.name}」の旧メディアを整理し、完成記録を残しました`;
      job.finalize = {
        deletedFiles: applied.value.deleted_files ?? 0,
        deletedBytes: applied.value.deleted_bytes ?? 0,
        completionRecord: sanitizeProjectRelative(
          post.value.completion_record ?? applied.value.completion_record ?? undefined
        ) ?? null,
        planDigestShort: shortDigest(review.planDigest),
        launcherVisible: post.value.launcher_visible === true
          || applied.value.launcher_visible === true
          || Boolean(post.value.launcher_project_root)
          || Boolean(applied.value.launcher_project_root)
      };
      return { ok: true, job: publicJob(job) };
    } catch {
      // After side effects or review consumption, never report re-applyable failed.
      const reviewConsumed = !finalizeReviews.has(review.reviewId);
      const status = job.sideEffectConfirmed || reviewConsumed
        ? "applied_unverified"
        : "failed";
      if (status === "applied_unverified") {
        finalizeReviews.delete(review.reviewId);
      }
      return failJob(job, MAINTENANCE_ISSUE.internal, status);
    } finally {
      if (applyInFlight === jobId) applyInFlight = null;
    }
  };

  const getJob = (jobId: string): MaintenanceJobResponse | MaintenanceErrorResponse => {
    if (!/^[a-z0-9_-]{8,64}$/i.test(jobId)) {
      return { ok: false, issue: MAINTENANCE_ISSUE.notFound };
    }
    const job = jobs.get(jobId);
    if (!job) return { ok: false, issue: MAINTENANCE_ISSUE.notFound };
    return { ok: true, job: publicJob(job) };
  };

  return {
    previewWorktrees,
    applyWorktree,
    previewFinalize,
    applyFinalize,
    getJob,
    hasBlockingWork: () => applyInFlight !== null,
    dropFinalizeReview: (reviewId: string) => {
      finalizeReviews.delete(reviewId);
    },
    lastPipelineArgv: () => argvLog,
    resetForTests: () => {
      worktreeReviews.clear();
      finalizeReviews.clear();
      jobs.clear();
      applyInFlight = null;
      argvLog.length = 0;
    }
  };
}

function failJob(
  job: MaintenanceJobRecord,
  issue: MaintenanceIssue,
  status: "failed" | "stale" | "applied_unverified",
  issues?: MaintenanceIssue[]
): MaintenanceErrorResponse & { job?: MaintenanceJobResponse["job"] } {
  const publicIssue = toPublicMaintenanceIssue(
    status === "applied_unverified" && issue.code !== MAINTENANCE_ISSUE.appliedUnverified.code
      ? {
          // Prefer the concrete post-verify code while still marking applied_unverified status.
          ...issue
        }
      : issue
  );
  const publicIssues = (issues ?? [issue]).map((item) => toPublicMaintenanceIssue(item));
  job.status = status;
  if (status === "applied_unverified") {
    job.phase = "applied_unverified";
    job.sideEffectConfirmed = true;
    job.message = MAINTENANCE_ISSUE.appliedUnverified.message;
  } else if (job.phase === "applying" || job.phase === "revalidating" || job.phase === "verifying") {
    job.phase = status === "stale" ? "stale" : "failed";
    job.message = publicIssue.message;
  } else {
    job.message = publicIssue.message;
  }
  job.completedAt = new Date().toISOString();
  job.issues = publicIssues;
  return {
    ok: false,
    issue: status === "applied_unverified"
      ? toPublicMaintenanceIssue(MAINTENANCE_ISSUE.appliedUnverified)
      : publicIssue,
    ...(publicIssues.length > 0 ? { issues: publicIssues } : {}),
    job: publicJob(job)
  } as MaintenanceErrorResponse;
}

function publicJob(job: MaintenanceJobRecord): MaintenanceJobResponse["job"] {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    phase: job.phase,
    startedAt: job.startedAt,
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    ...(job.message ? { message: job.message } : {}),
    ...(job.issues ? { issues: job.issues } : {}),
    ...(job.sideEffectConfirmed !== undefined
      ? { sideEffectConfirmed: job.sideEffectConfirmed }
      : {}),
    ...(job.worktree ? { worktree: job.worktree } : {}),
    ...(job.finalize ? { finalize: job.finalize } : {})
  };
}

/**
 * Same-platform path equality aligned with worktree lifecycle helpers:
 * resolve() + Darwin /private/{var,tmp} normalization. No prefix match.
 */
export function maintenancePathsEqual(left: string, right: string): boolean {
  return normalizeMaintenancePath(left) === normalizeMaintenancePath(right);
}

function normalizeMaintenancePath(path: string): string {
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

/** H2: removed list must be exactly the single server-held target. */
export function isExactSingleRemovedTarget(
  removed: readonly string[] | undefined,
  target: string
): boolean {
  if (!removed || removed.length !== 1) return false;
  return maintenancePathsEqual(removed[0]!, target);
}

function toPublicWorktreeCandidate(held: WorktreeHeldCandidate): PublicWorktreeCandidate {
  return {
    candidateId: held.candidateId,
    removable: held.removable,
    isPrimary: held.isPrimary,
    isCurrent: held.isCurrent,
    branch: held.branch,
    headShort: held.head.slice(0, 12),
    displayName: held.displayName,
    blockReasons: held.blockReasons,
    blockReasonLabels: labelWorktreeBlockReasons(held.blockReasons),
    ignoredProtected: held.ignoredProtected.map((path) => basename(path) || path).slice(0, 16),
    mergedIntoMain: held.mergedIntoMain,
    dirtyTracked: held.dirtyTracked,
    dirtyUntracked: held.dirtyUntracked,
    locked: held.locked,
    missing: held.missing
  };
}

function summarizeDeletion(cli: z.infer<typeof FinalizeCliSchema>): PublicFinalizeDeletionSummary {
  const mediaFiles = cli.media_files ?? [];
  const retained = new Set(cli.retained_media ?? []);
  const planned = mediaFiles.filter((path) => !retained.has(path));
  return {
    plannedFiles: planned.length,
    plannedBytes: cli.planned_bytes ?? 0,
    retainedFiles: retained.size,
    mediaFiles: mediaFiles.length,
    samplePaths: planned.slice(0, 8).map((path) => sanitizeProjectRelative(path) ?? path)
  };
}

function parseWorktreeApplyBody(
  body: unknown
): { ok: true; value: WorktreeApplyRequest } | MaintenanceErrorResponse {
  if (!isPlainObject(body)) {
    return { ok: false, issue: MAINTENANCE_ISSUE.invalidBody };
  }
  if (hasClientPathFields(body)) {
    return { ok: false, issue: MAINTENANCE_ISSUE.clientPathRejected };
  }
  const allowed = new Set(["reviewId", "candidateId", "confirmed"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      return { ok: false, issue: MAINTENANCE_ISSUE.invalidBody };
    }
  }
  if (
    typeof body.reviewId !== "string"
    || !/^[a-z0-9_-]{8,64}$/i.test(body.reviewId)
    || typeof body.candidateId !== "string"
    || !/^[a-z0-9_-]{8,64}$/i.test(body.candidateId)
  ) {
    return { ok: false, issue: MAINTENANCE_ISSUE.invalidBody };
  }
  if (body.confirmed !== true) {
    return { ok: false, issue: MAINTENANCE_ISSUE.confirmedRequired };
  }
  return {
    ok: true,
    value: {
      reviewId: body.reviewId,
      candidateId: body.candidateId,
      confirmed: true
    }
  };
}

function parseFinalizePreviewBody(
  body: unknown
): { ok: true; value: FinalizePreviewRequest } | MaintenanceErrorResponse {
  if (!isPlainObject(body)) {
    return { ok: false, issue: MAINTENANCE_ISSUE.invalidBody };
  }
  if (hasClientPathFields(body)) {
    return { ok: false, issue: MAINTENANCE_ISSUE.clientPathRejected };
  }
  const allowed = new Set(["expectedRunId", "revision", "completionDeclared"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      return { ok: false, issue: MAINTENANCE_ISSUE.invalidBody };
    }
  }
  if (
    typeof body.expectedRunId !== "string"
    || body.expectedRunId.length === 0
    || body.expectedRunId.length > 256
    || typeof body.revision !== "string"
    || body.revision.length === 0
    || body.revision.length > 128
  ) {
    return { ok: false, issue: MAINTENANCE_ISSUE.invalidBody };
  }
  if (body.completionDeclared !== true) {
    return { ok: false, issue: MAINTENANCE_ISSUE.completionRequired };
  }
  return {
    ok: true,
    value: {
      expectedRunId: body.expectedRunId,
      revision: body.revision,
      completionDeclared: true
    }
  };
}

function parseFinalizeApplyBody(
  body: unknown
): { ok: true; value: FinalizeApplyRequest } | MaintenanceErrorResponse {
  if (!isPlainObject(body)) {
    return { ok: false, issue: MAINTENANCE_ISSUE.invalidBody };
  }
  if (hasClientPathFields(body)) {
    return { ok: false, issue: MAINTENANCE_ISSUE.clientPathRejected };
  }
  const allowed = new Set(["reviewId", "planDigest", "confirmed", "productionCompletionDigest"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      return { ok: false, issue: MAINTENANCE_ISSUE.invalidBody };
    }
  }
  if (
    typeof body.reviewId !== "string"
    || !/^[a-z0-9_-]{8,64}$/i.test(body.reviewId)
    || typeof body.planDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(body.planDigest)
  ) {
    return { ok: false, issue: MAINTENANCE_ISSUE.invalidBody };
  }
  if (
    body.productionCompletionDigest !== undefined
    && (
      typeof body.productionCompletionDigest !== "string"
      || !/^[a-f0-9]{64}$/.test(body.productionCompletionDigest)
    )
  ) {
    return { ok: false, issue: MAINTENANCE_ISSUE.invalidBody };
  }
  if (body.confirmed !== true) {
    return { ok: false, issue: MAINTENANCE_ISSUE.confirmedRequired };
  }
  return {
    ok: true,
    value: {
      reviewId: body.reviewId,
      planDigest: body.planDigest,
      confirmed: true,
      ...(typeof body.productionCompletionDigest === "string"
        ? { productionCompletionDigest: body.productionCompletionDigest }
        : {})
    }
  };
}

function hasClientPathFields(body: Record<string, unknown>): boolean {
  const banned = [
    "path",
    "paths",
    "config",
    "configPath",
    "stateDir",
    "state-dir",
    "cwd",
    "worktreePath",
    "absolutePath"
  ];
  return banned.some((key) => key in body);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeArgv(args: readonly string[]): void {
  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (FORBIDDEN_ARGV.has(lower) || FORBIDDEN_ARGV.has(arg)) {
      throw new Error(`maintenance argv rejected forbidden token: ${arg}`);
    }
    if (arg === "--state-dir" || arg.startsWith("--state-dir=")) {
      throw new Error("maintenance argv must not pass --state-dir");
    }
  }
  // Worktree apply must be single-path; no bulk.
  if (args[0] === "worktrees" && args.includes("--apply")) {
    const pathFlags = args.filter((arg, index) => arg === "--path" || (index > 0 && args[index - 1] === "--path"));
    // count of --path flags
    const pathCount = args.filter((arg) => arg === "--path").length;
    if (pathCount !== 1) {
      throw new Error("maintenance worktree apply requires exactly one --path");
    }
    void pathFlags;
  }
}

function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function shortDigest(digest: string): string {
  return digest.slice(0, 12);
}

function sanitizeProjectRelative(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replaceAll("\\", "/");
  // Prefer project-relative display; strip absolute prefixes to basename trail.
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    const parts = normalized.split("/").filter(Boolean);
    return parts.slice(-3).join("/");
  }
  return normalized;
}

/** Deterministic identity key for tests / drift checks. */
export function maintenanceIdentityKey(input: {
  configPath: string;
  runId: string;
  revision: string;
}): string {
  return createHash("sha256")
    .update(`${input.configPath}\0${input.runId}\0${input.revision}`)
    .digest("hex");
}

/** Full identity fingerprint bound into finalize reviews (H3). */
export function maintenanceIdentityFingerprint(input: {
  configPath: string;
  runId: string;
  revision: string;
  identityKey: string;
  realConfigPath?: string;
  realProjectDir?: string;
  configDevice?: number;
  configInode?: number;
  projectDevice?: number;
  projectInode?: number;
}): string {
  return createHash("sha256")
    .update([
      input.configPath,
      input.runId,
      input.revision,
      input.identityKey,
      input.realConfigPath ?? "",
      input.realProjectDir ?? "",
      String(input.configDevice ?? ""),
      String(input.configInode ?? ""),
      String(input.projectDevice ?? ""),
      String(input.projectInode ?? "")
    ].join("\0"))
    .digest("hex");
}

async function defaultInspectRemovedPath(path: string): Promise<RemovedPathInspection> {
  try {
    await lstat(path);
    return "present";
  } catch (error) {
    if (
      error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: string }).code === "ENOENT"
    ) {
      return "absent";
    }
    return "error";
  }
}

/**
 * Server-held durable launcher config: realpath + projects-home containment.
 * Rejects symlinks and paths outside durable home (client never supplies this).
 * When durableProjectsHome is provided (Desktop selected workspace), that home is
 * used instead of re-resolving from process cwd / runtimeRoot.
 */
export async function defaultResolveLauncherConfigPath(
  configPath: string,
  options: { durableProjectsHome?: string } = {}
): Promise<{ ok: true; path: string } | { ok: false; issue: MaintenanceIssue }> {
  if (typeof configPath !== "string" || !configPath || !isAbsolute(configPath)) {
    return { ok: false, issue: MAINTENANCE_ISSUE.postVerifyFailed };
  }
  if (configPath.includes("\0")) {
    return { ok: false, issue: MAINTENANCE_ISSUE.postVerifyFailed };
  }
  try {
    const stats = await lstat(configPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return { ok: false, issue: MAINTENANCE_ISSUE.postVerifyFailed };
    }
    const realConfig = await realpath(configPath);
    const projectDir = dirname(realConfig);
    const projectStats = await lstat(projectDir);
    if (projectStats.isSymbolicLink() || !projectStats.isDirectory()) {
      return { ok: false, issue: MAINTENANCE_ISSUE.postVerifyFailed };
    }
    const home = options.durableProjectsHome
      ? resolve(options.durableProjectsHome)
      : await resolveDurableProjectsHome();
    let homeReal: string;
    try {
      homeReal = await realpath(home);
    } catch {
      homeReal = resolve(home);
    }
    if (!isWithinDirectory(homeReal, realConfig) || !isWithinDirectory(homeReal, projectDir)) {
      return { ok: false, issue: MAINTENANCE_ISSUE.postVerifyFailed };
    }
    return { ok: true, path: realConfig };
  } catch {
    return { ok: false, issue: MAINTENANCE_ISSUE.postVerifyFailed };
  }
}

/**
 * Resolve the canonical maintenance durable home once.
 * Explicit projectsDir / maintenanceProjectsHome wins; otherwise resolveDurableProjectsHome.
 * Callers must never pass a readOnly additional shelf as home.
 */
export async function resolveMaintenanceDurableHome(options: {
  maintenanceProjectsHome?: string;
  projectsDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const explicit = options.maintenanceProjectsHome?.trim() || options.projectsDir?.trim();
  if (explicit) {
    const resolved = resolve(explicit);
    try {
      return await realpath(resolved);
    } catch {
      return resolved;
    }
  }
  const home = await resolveDurableProjectsHome({
    cwd: options.cwd,
    env: options.env
  });
  try {
    return await realpath(home);
  } catch {
    return resolve(home);
  }
}
