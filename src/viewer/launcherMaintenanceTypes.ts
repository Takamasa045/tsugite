/**
 * Server-side DTOs and issue codes for the launcher "安全な整理" shelf.
 * Worktree cleanup and media finalize stay separate operations.
 */

import type { Issue } from "../types.js";

export type WorktreeMaintenancePhase =
  | "idle"
  | "tidy"
  | "previewing"
  | "reviewable"
  | "blocked"
  | "applying"
  | "revalidating"
  | "verifying"
  | "recorded"
  | "applied_unverified"
  | "stale"
  | "failed";

export type FinalizeMaintenancePhase =
  | "selected"
  | "completion_declaration"
  | "previewing"
  | "reviewable"
  | "already_finalized"
  | "applying"
  | "revalidating"
  | "verifying"
  | "completion_recorded"
  | "applied_unverified"
  | "failed"
  | "stale";

export type MaintenanceJobKind = "worktree" | "finalize";

export type MaintenanceJobStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "stale"
  /** CLI apply/remove succeeded; post-verify did not confirm. Re-apply forbidden. */
  | "applied_unverified";

export type MaintenanceIssue = {
  code: string;
  message: string;
  path?: string;
};

export type PublicWorktreeCandidate = {
  candidateId: string;
  removable: boolean;
  isPrimary: boolean;
  isCurrent: boolean;
  branch: string | null;
  headShort: string;
  /** Basename-only display label; full path stays server-held. */
  displayName: string;
  blockReasons: string[];
  blockReasonLabels: string[];
  ignoredProtected: string[];
  mergedIntoMain: boolean;
  dirtyTracked: boolean;
  dirtyUntracked: boolean;
  locked: boolean;
  missing: boolean;
};

export type WorktreePreviewResponse = {
  ok: true;
  reviewId: string;
  phase: Extract<WorktreeMaintenancePhase, "reviewable" | "blocked">;
  expiresAt: string;
  mainBranch: string;
  removableCount: number;
  blockedCount: number;
  warningActive: boolean;
  warningThreshold: number;
  candidates: PublicWorktreeCandidate[];
  blocked: PublicWorktreeCandidate[];
  tidy: boolean;
};

export type WorktreeApplyRequest = {
  reviewId: string;
  candidateId: string;
  confirmed: true;
};

export type FinalizePreviewRequest = {
  expectedRunId: string;
  revision: string;
  completionDeclared: true;
};

export type FinalizeApplyRequest = {
  reviewId: string;
  planDigest: string;
  confirmed: true;
};

export type PublicFinalizeDeletionSummary = {
  plannedFiles: number;
  plannedBytes: number;
  retainedFiles: number;
  mediaFiles: number;
  samplePaths: string[];
};

export type FinalizePreviewResponse = {
  ok: true;
  reviewId: string;
  phase: Extract<FinalizeMaintenancePhase, "reviewable" | "already_finalized">;
  expiresAt: string;
  projectId: string;
  projectName: string;
  runId: string;
  revision: string;
  planDigest: string;
  planDigestShort: string;
  canonicalOutput?: string;
  completionRecord?: string | null;
  alreadyFinalized: boolean;
  launcherVisible: boolean;
  launcherAlreadyHome: boolean;
  promotedToLauncherHome: boolean;
  deletion: PublicFinalizeDeletionSummary;
  issues: MaintenanceIssue[];
};

export type MaintenanceJobResponse = {
  ok: true;
  job: {
    id: string;
    kind: MaintenanceJobKind;
    status: MaintenanceJobStatus;
    phase: WorktreeMaintenancePhase | FinalizeMaintenancePhase;
    startedAt: string;
    completedAt?: string;
    message?: string;
    issues?: MaintenanceIssue[];
    /**
     * True when the mutating CLI step confirmed apply/remove.
     * When status is applied_unverified, UI must forbid re-apply and only re-fetch preview.
     */
    sideEffectConfirmed?: boolean;
    /** Worktree-only post-state. */
    worktree?: {
      removedDisplayName?: string;
      postPreviewTidy?: boolean;
      removableCount?: number;
    };
    /** Finalize-only post-state. */
    finalize?: {
      deletedFiles?: number;
      deletedBytes?: number;
      completionRecord?: string | null;
      planDigestShort?: string;
      launcherVisible?: boolean;
    };
  };
};

export type MaintenanceErrorResponse = {
  ok: false;
  issue: MaintenanceIssue;
  issues?: MaintenanceIssue[];
};

export type WorktreeReviewSnapshot = {
  reviewId: string;
  createdAtMs: number;
  expiresAtMs: number;
  gitCommonDir: string;
  mainBranch: string;
  primaryPath: string;
  currentPath: string;
  candidates: Map<string, WorktreeHeldCandidate>;
};

export type WorktreeHeldCandidate = {
  candidateId: string;
  path: string;
  head: string;
  branch: string | null;
  removable: boolean;
  isPrimary: boolean;
  isCurrent: boolean;
  displayName: string;
  blockReasons: string[];
  ignoredProtected: string[];
  mergedIntoMain: boolean;
  dirtyTracked: boolean;
  dirtyUntracked: boolean;
  locked: boolean;
  missing: boolean;
};

export type FinalizeReviewSnapshot = {
  reviewId: string;
  createdAtMs: number;
  expiresAtMs: number;
  projectId: string;
  projectName: string;
  configPath: string;
  runId: string;
  revision: string;
  planDigest: string;
  identityKey: string;
  /** Hash of full project/config realpath + device/inode + run/revision at preview time. */
  identityFingerprint: string;
  alreadyFinalized: boolean;
  canonicalOutput?: string;
  completionRecord?: string | null;
  deletion: PublicFinalizeDeletionSummary;
  launcherVisible: boolean;
  launcherAlreadyHome: boolean;
  promotedToLauncherHome: boolean;
  /** Server-held durable config from preview CLI when already under home (optional). */
  launcherConfigPath?: string | null;
};

export type MaintenanceJobRecord = {
  id: string;
  kind: MaintenanceJobKind;
  status: MaintenanceJobStatus;
  phase: WorktreeMaintenancePhase | FinalizeMaintenancePhase;
  startedAt: string;
  completedAt?: string;
  message?: string;
  issues?: MaintenanceIssue[];
  sideEffectConfirmed?: boolean;
  worktree?: MaintenanceJobResponse["job"]["worktree"];
  finalize?: MaintenanceJobResponse["job"]["finalize"];
};

/** Known block reasons from lifecycle.ts, translated for non-technical UI. */
export const WORKTREE_BLOCK_REASON_LABELS: Record<string, string> = {
  primary: "メインの作業場所です",
  current: "いま開いている作業場所です",
  dirty_tracked: "追跡中の未保存変更があります",
  dirty_untracked: "未保存ファイルがあります",
  unmerged: "main に未統合です",
  locked: "ロックされています",
  missing: "パスが見つかりません",
  // Canonical keys from lifecycle.ts (keep aliases for older labels).
  protected_content: "保護対象（projects / media など）を含みます",
  protected: "保護対象（projects / media など）を含みます",
  outside_repo_boundary: "リポジトリ外です",
  outside_repo: "リポジトリ外です",
  symlink_worktree: "シンボリックリンク先です",
  symlink: "シンボリックリンク先です",
  status_unavailable: "状態を確認できません"
};

export function labelWorktreeBlockReasons(reasons: readonly string[]): string[] {
  return reasons.map((reason) => WORKTREE_BLOCK_REASON_LABELS[reason] ?? reason);
}

export const MAINTENANCE_ISSUE = {
  forbidden: { code: "viewer_launcher.forbidden", message: "Launcher request was not authorized" },
  workBlocked: {
    code: "viewer_launcher.work_blocked",
    message: "New work cannot start while Desktop is changing workspace or shutting down"
  },
  applyBusy: {
    code: "maintenance.apply_busy",
    message: "Another safe-cleanup operation is already running"
  },
  invalidBody: {
    code: "maintenance.invalid_body",
    message: "Request body is invalid"
  },
  clientPathRejected: {
    code: "maintenance.client_path_rejected",
    message: "Filesystem paths, config paths, and state-dir must not be sent from the browser"
  },
  reviewMissing: {
    code: "maintenance.review_missing",
    message: "Review snapshot is missing or expired. Run preview again."
  },
  candidateMissing: {
    code: "maintenance.candidate_missing",
    message: "Selected cleanup candidate is missing from the review snapshot"
  },
  candidateBlocked: {
    code: "maintenance.candidate_blocked",
    message: "Selected worktree is not safely removable"
  },
  snapshotStale: {
    code: "maintenance.snapshot_stale",
    message: "Worktree state changed after preview. Run preview again."
  },
  planStale: {
    code: "maintenance.plan_stale",
    message: "Finalize plan changed after preview. Run preview again."
  },
  completionRequired: {
    code: "maintenance.completion_declaration_required",
    message: "Explicit completion declaration is required before finalize preview"
  },
  readOnlyProject: {
    code: "maintenance.project_read_only",
    message: "Projects from other worktrees are read-only and cannot be finalized here"
  },
  projectMismatch: {
    code: "maintenance.project_mismatch",
    message: "Project identity, run, or revision no longer matches the selected project"
  },
  projectNotCompleted: {
    code: "maintenance.project_not_completed",
    message: "Only projects with status completed can be finalized"
  },
  cliInvalid: {
    code: "maintenance.cli_invalid",
    message: "Canonical cleanup CLI returned an unusable response"
  },
  cliTooLarge: {
    code: "maintenance.cli_too_large",
    message: "Canonical cleanup CLI response exceeded the size limit"
  },
  cliNonZeroExit: {
    code: "maintenance.cli_nonzero_exit",
    message: "Canonical cleanup CLI exited non-zero; refusing success"
  },
  postVerifyFailed: {
    code: "maintenance.post_verify_failed",
    message: "Post-apply live re-preview did not confirm a completed finalize state"
  },
  worktreeRemoveUnconfirmed: {
    code: "maintenance.worktree_remove_unconfirmed",
    message: "Worktree cleanup did not confirm the exact server-held path was removed"
  },
  worktreeStillPresent: {
    code: "maintenance.worktree_still_present",
    message: "Worktree was not removed; re-check the target before retrying"
  },
  worktreePathInspectFailed: {
    code: "maintenance.worktree_path_inspect_failed",
    message: "Could not verify worktree removal on the filesystem"
  },
  appliedUnverified: {
    code: "maintenance.applied_unverified",
    message:
      "Cleanup ran, but confirmation did not finish. Do not re-apply. Re-fetch preview only."
  },
  confirmedRequired: {
    code: "maintenance.confirmed_required",
    message: "Explicit confirmed:true is required to apply cleanup"
  },
  internal: {
    code: "maintenance.internal",
    message: "Safe cleanup failed due to an internal error"
  },
  notFound: { code: "viewer_launcher.not_found", message: "Not found" }
} as const;

/**
 * HTTP status for public maintenance issue codes.
 * Mutating/post-verify outcomes stay 409/422 — never collapse to generic 500.
 */
export function statusForMaintenanceIssue(code: string): number {
  if (
    code === MAINTENANCE_ISSUE.forbidden.code
    || code === MAINTENANCE_ISSUE.readOnlyProject.code
  ) return 403;
  if (
    code === MAINTENANCE_ISSUE.invalidBody.code
    || code === MAINTENANCE_ISSUE.clientPathRejected.code
    || code === MAINTENANCE_ISSUE.confirmedRequired.code
    || code === MAINTENANCE_ISSUE.completionRequired.code
    || code === MAINTENANCE_ISSUE.projectNotCompleted.code
  ) return 400;
  if (
    code === MAINTENANCE_ISSUE.workBlocked.code
    || code === MAINTENANCE_ISSUE.applyBusy.code
    || code === MAINTENANCE_ISSUE.snapshotStale.code
    || code === MAINTENANCE_ISSUE.planStale.code
    || code === MAINTENANCE_ISSUE.projectMismatch.code
    || code === MAINTENANCE_ISSUE.worktreeStillPresent.code
    || code === MAINTENANCE_ISSUE.appliedUnverified.code
    || code === "maintenance.already_finalized"
  ) return 409;
  if (code === MAINTENANCE_ISSUE.notFound.code) return 404;
  if (
    code === MAINTENANCE_ISSUE.candidateBlocked.code
    || code === MAINTENANCE_ISSUE.candidateMissing.code
    || code === MAINTENANCE_ISSUE.reviewMissing.code
    || code === MAINTENANCE_ISSUE.cliInvalid.code
    || code === MAINTENANCE_ISSUE.cliTooLarge.code
    || code === MAINTENANCE_ISSUE.cliNonZeroExit.code
    || code === MAINTENANCE_ISSUE.postVerifyFailed.code
    || code === MAINTENANCE_ISSUE.worktreeRemoveUnconfirmed.code
    || code === MAINTENANCE_ISSUE.worktreePathInspectFailed.code
    || code === "maintenance.project_invalid"
    || code === "maintenance.completion_record_missing"
    || code === "maintenance.worktree_apply_failed"
    || code === "maintenance.finalize_apply_failed"
    || code === "maintenance.finalize_preview_failed"
    || code.startsWith("finalize.")
    || code.startsWith("worktrees.")
  ) return 422;
  return 500;
}

/** Known fixed public messages by code; unknown codes get redacted messages. */
const KNOWN_PUBLIC_MESSAGES: ReadonlyMap<string, string> = new Map(
  Object.values(MAINTENANCE_ISSUE).map((issue) => [issue.code, issue.message])
);

export function toMaintenanceIssues(issues: readonly Issue[] | undefined): MaintenanceIssue[] {
  if (!issues) return [];
  return issues.map((issue) => toPublicMaintenanceIssue({
    code: issue.code,
    message: issue.message,
    ...(issue.path ? { path: issue.path } : {})
  }));
}

export function toPublicMaintenanceIssue(issue: MaintenanceIssue): MaintenanceIssue {
  const known = KNOWN_PUBLIC_MESSAGES.get(issue.code);
  return {
    code: issue.code,
    message: known ?? redactAbsolutePaths(issue.message),
    ...(issue.path ? { path: sanitizeIssuePath(issue.path) } : {})
  };
}

export function redactAbsolutePaths(message: string): string {
  if (!message || !message.trim()) return "Safe cleanup failed";
  // file:// URLs, Unix absolute, Windows drive, and home-style paths → generic token.
  const redacted = message
    .replace(/file:\/\/\/[^\s"'`]+/gi, "[path]")
    .replace(/file:\/\/[^\s"'`]+/gi, "[path]")
    .replace(/(?:[A-Za-z]:)?(?:\/|\\)(?:Users|home|tmp|var|private)[^\s"'`]+/gi, "[path]")
    .replace(/(?:[A-Za-z]:)?(?:\/|\\)[^\s"'`]+/g, "[path]");
  if (
    redacted.includes("/Users/")
    || redacted.includes("\\Users\\")
    || /file:\/\/\/Users/i.test(redacted)
    || /file:\/\/Users/i.test(redacted)
  ) {
    return "Safe cleanup failed";
  }
  return redacted === message && /\/|\\/.test(message) && message.length > 80
    ? "Safe cleanup failed"
    : redacted;
}

function sanitizeIssuePath(path: string): string {
  if (!path || !path.trim()) return "[path]";
  if (path.startsWith("file:")) return "[path]";
  if (!path.includes("/") && !path.includes("\\")) return path;
  const parts = path.replaceAll("\\", "/").split("/");
  return parts[parts.length - 1] || "[path]";
}
