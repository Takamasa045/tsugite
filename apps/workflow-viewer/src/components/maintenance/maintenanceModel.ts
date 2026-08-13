/**
 * Client-side guards, labels, and reducers for the 「安全な整理」 shelf.
 * Worktree cleanup and media finalize keep separate phase machines.
 */

export type WorktreePhase =
  | 'idle'
  | 'tidy'
  | 'previewing'
  | 'reviewable'
  | 'blocked'
  | 'applying'
  | 'revalidating'
  | 'verifying'
  | 'recorded'
  | 'applied_unverified'
  | 'stale'
  | 'failed'

export type FinalizePhase =
  | 'selected'
  | 'completion_declaration'
  | 'previewing'
  | 'reviewable'
  | 'already_finalized'
  | 'applying'
  | 'revalidating'
  | 'verifying'
  | 'completion_recorded'
  | 'applied_unverified'
  | 'failed'
  | 'stale'

export type MaintenanceIssue = {
  code: string
  message: string
  path?: string
}

export type PublicWorktreeCandidate = {
  candidateId: string
  removable: boolean
  isPrimary: boolean
  isCurrent: boolean
  branch: string | null
  headShort: string
  displayName: string
  blockReasons: string[]
  blockReasonLabels: string[]
  ignoredProtected: string[]
  mergedIntoMain: boolean
  dirtyTracked: boolean
  dirtyUntracked: boolean
  locked: boolean
  missing: boolean
}

export type WorktreePreviewResponse = {
  ok: true
  reviewId: string
  phase: 'reviewable' | 'blocked'
  expiresAt: string
  mainBranch: string
  removableCount: number
  blockedCount: number
  warningActive: boolean
  warningThreshold: number
  candidates: PublicWorktreeCandidate[]
  blocked: PublicWorktreeCandidate[]
  tidy: boolean
}

export type FinalizeDeletionSummary = {
  plannedFiles: number
  plannedBytes: number
  retainedFiles: number
  mediaFiles: number
  samplePaths: string[]
}

export type FinalizePreviewResponse = {
  ok: true
  reviewId: string
  phase: 'reviewable' | 'already_finalized'
  expiresAt: string
  projectId: string
  projectName: string
  runId: string
  revision: string
  planDigest: string
  planDigestShort: string
  productionCompletionDigest?: string
  productionCompletionDigestShort?: string
  canonicalOutput?: string
  completionRecord?: string | null
  alreadyFinalized: boolean
  launcherVisible: boolean
  launcherAlreadyHome: boolean
  promotedToLauncherHome: boolean
  deletion: FinalizeDeletionSummary
  issues: MaintenanceIssue[]
}

export type MaintenanceJob = {
  id: string
  kind: 'worktree' | 'finalize'
  status: 'running' | 'succeeded' | 'failed' | 'stale' | 'applied_unverified'
  phase: WorktreePhase | FinalizePhase
  startedAt: string
  completedAt?: string
  message?: string
  issues?: MaintenanceIssue[]
  /** True when CLI apply/remove confirmed; re-apply must stay disabled. */
  sideEffectConfirmed?: boolean
  worktree?: {
    removedDisplayName?: string
    postPreviewTidy?: boolean
    removableCount?: number
  }
  finalize?: {
    deletedFiles?: number
    deletedBytes?: number
    completionRecord?: string | null
    planDigestShort?: string
    launcherVisible?: boolean
  }
}

export type MaintenanceJobResponse = {
  ok: true
  job: MaintenanceJob
}

export type MaintenanceErrorResponse = {
  ok: false
  issue: MaintenanceIssue
  issues?: MaintenanceIssue[]
  job?: MaintenanceJob
}

export type FinalizeProjectOption = {
  id: string
  name: string
  runId: string
  revision: string
  status: string
  readOnly?: boolean
  valid: boolean
}

export function isWorktreePreviewResponse(input: unknown): input is WorktreePreviewResponse {
  if (!isRecord(input) || input.ok !== true) return false
  if (typeof input.reviewId !== 'string') return false
  if (!Array.isArray(input.candidates) || !Array.isArray(input.blocked)) return false
  return typeof input.mainBranch === 'string'
}

export function isFinalizePreviewResponse(input: unknown): input is FinalizePreviewResponse {
  if (!isRecord(input) || input.ok !== true) return false
  if (typeof input.reviewId !== 'string' || typeof input.planDigest !== 'string') return false
  if (!isRecord(input.deletion)) return false
  return typeof input.deletion.plannedFiles === 'number'
}

export function isMaintenanceJobResponse(input: unknown): input is MaintenanceJobResponse {
  if (!isRecord(input) || input.ok !== true || !isRecord(input.job)) return false
  return typeof input.job.id === 'string' && typeof input.job.status === 'string'
}

export function isMaintenanceErrorResponse(input: unknown): input is MaintenanceErrorResponse {
  if (!isRecord(input) || input.ok !== false || !isRecord(input.issue)) return false
  return typeof input.issue.code === 'string' && typeof input.issue.message === 'string'
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function worktreePhaseLabel(phase: WorktreePhase): string {
  switch (phase) {
    case 'idle': return '未確認'
    case 'tidy': return '削除対象なし'
    case 'previewing': return '確認中…'
    case 'reviewable': return '確認できます'
    case 'blocked': return '削除できる候補がありません'
    case 'applying': return '削除を実行中…'
    case 'revalidating': return '直前再確認中…'
    case 'verifying': return '結果を検証中…'
    case 'recorded': return '整理済み'
    case 'applied_unverified': return '実行済み・確認未完了'
    case 'stale': return '状態が変わりました'
    case 'failed': return '失敗'
  }
}

export function finalizePhaseLabel(phase: FinalizePhase): string {
  switch (phase) {
    case 'selected': return '案件を選んでください'
    case 'completion_declaration': return '完成宣言が必要です'
    case 'previewing': return '整理計画を確認中…'
    case 'reviewable': return '整理計画を確認できます'
    case 'already_finalized': return '整理済み'
    case 'applying': return 'メディア整理を実行中…'
    case 'revalidating': return '直前再確認中…'
    case 'verifying': return '完成記録を検証中…'
    case 'completion_recorded': return '完成記録を残しました'
    case 'applied_unverified': return '実行済み・確認未完了'
    case 'stale': return '計画が古くなりました'
    case 'failed': return '失敗'
  }
}

export function writableFinalizeProjects(
  projects: readonly FinalizeProjectOption[],
): FinalizeProjectOption[] {
  // Server also rejects non-completed; human completionDeclared is still required separately.
  return projects.filter(
    (project) => project.valid && !project.readOnly && project.status === 'completed',
  )
}

export function canApplyWorktree(input: {
  phase: WorktreePhase
  selectedCandidateId: string | null
  reviewId: string | null
  dialogOpen: boolean
  /** When true (applied_unverified / recorded), apply stays disabled. */
  sideEffectConfirmed?: boolean
}): boolean {
  if (input.sideEffectConfirmed) return false
  if (input.phase === 'applied_unverified' || input.phase === 'recorded' || input.phase === 'tidy') {
    return false
  }
  return input.phase === 'reviewable'
    && Boolean(input.selectedCandidateId)
    && Boolean(input.reviewId)
    && input.dialogOpen
}

export function canApplyFinalize(input: {
  phase: FinalizePhase
  reviewId: string | null
  planDigest: string | null
  dialogOpen: boolean
  alreadyFinalized?: boolean
  sideEffectConfirmed?: boolean
}): boolean {
  if (input.sideEffectConfirmed) return false
  if (input.phase === 'applied_unverified' || input.phase === 'completion_recorded') {
    return false
  }
  return input.phase === 'reviewable'
    && !input.alreadyFinalized
    && Boolean(input.reviewId)
    && Boolean(input.planDigest)
    && input.dialogOpen
}

/** Keep job id after apply starts so disconnects can resync via GET /jobs/:id. */
export function shouldRetainApplyJobId(input: {
  phase: WorktreePhase | FinalizePhase
  jobId: string | null
}): boolean {
  if (!input.jobId) return false
  return input.phase === 'applying'
    || input.phase === 'revalidating'
    || input.phase === 'verifying'
    || input.phase === 'recorded'
    || input.phase === 'completion_recorded'
    || input.phase === 'applied_unverified'
    || input.phase === 'failed'
    || input.phase === 'stale'
}

/** True when a held job id should be re-fetched instead of re-applying. */
export function shouldResyncApplyJob(input: {
  jobId: string | null
  phase: WorktreePhase | FinalizePhase
  busy: boolean
}): boolean {
  if (!input.jobId || input.busy) return false
  return input.phase === 'applying'
    || input.phase === 'revalidating'
    || input.phase === 'verifying'
    || input.phase === 'failed'
    || input.phase === 'applied_unverified'
}

/** Map a job snapshot into the next UI phase (prevents re-apply after success). */
export function phaseFromJobSnapshot(job: MaintenanceJob): WorktreePhase | FinalizePhase {
  if (job.status === 'succeeded') {
    return job.kind === 'finalize' ? 'completion_recorded' : 'recorded'
  }
  if (job.status === 'applied_unverified' || job.phase === 'applied_unverified') {
    return 'applied_unverified'
  }
  if (job.status === 'stale') return 'stale'
  if (job.status === 'failed') return 'failed'
  if (job.phase === 'revalidating' || job.phase === 'verifying' || job.phase === 'applying') {
    return job.phase
  }
  return job.kind === 'finalize' ? 'applying' : 'applying'
}

/** M3: map tidy preview (0 candidates) to idle/tidy — never "recorded". */
export function worktreePhaseFromPreview(input: {
  candidatesLength: number
  tidy: boolean
  preserveJob?: boolean
  hadSuccessfulApply?: boolean
}): WorktreePhase {
  if (input.hadSuccessfulApply && input.candidatesLength === 0) return 'recorded'
  if (input.candidatesLength > 0) return 'reviewable'
  if (input.tidy) return 'tidy'
  return 'blocked'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
