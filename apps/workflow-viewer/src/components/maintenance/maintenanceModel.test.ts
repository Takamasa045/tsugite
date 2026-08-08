import { describe, expect, it } from 'vitest'

import {
  canApplyFinalize,
  canApplyWorktree,
  formatBytes,
  isFinalizePreviewResponse,
  isMaintenanceErrorResponse,
  isWorktreePreviewResponse,
  phaseFromJobSnapshot,
  shouldResyncApplyJob,
  shouldRetainApplyJobId,
  worktreePhaseFromPreview,
  writableFinalizeProjects,
} from './maintenanceModel'

describe('maintenanceModel', () => {
  it('guards worktree preview responses and apply preconditions', () => {
    expect(isWorktreePreviewResponse({
      ok: true,
      reviewId: 'wtr_1',
      phase: 'reviewable',
      expiresAt: '2026-08-08T00:00:00.000Z',
      mainBranch: 'main',
      removableCount: 1,
      blockedCount: 1,
      warningActive: false,
      warningThreshold: 3,
      candidates: [],
      blocked: [],
      tidy: false,
    })).toBe(true)
    expect(isWorktreePreviewResponse({ ok: false })).toBe(false)

    expect(canApplyWorktree({
      phase: 'reviewable',
      selectedCandidateId: 'c1',
      reviewId: 'r1',
      dialogOpen: true,
    })).toBe(true)
    expect(canApplyWorktree({
      phase: 'reviewable',
      selectedCandidateId: 'c1',
      reviewId: 'r1',
      dialogOpen: false,
    })).toBe(false)
    expect(canApplyWorktree({
      phase: 'previewing',
      selectedCandidateId: 'c1',
      reviewId: 'r1',
      dialogOpen: true,
    })).toBe(false)
    // M3: tidy is not recorded; apply stays off.
    expect(worktreePhaseFromPreview({ candidatesLength: 0, tidy: true })).toBe('tidy')
    expect(worktreePhaseFromPreview({
      candidatesLength: 0,
      tidy: true,
      hadSuccessfulApply: true,
    })).toBe('recorded')
    expect(canApplyWorktree({
      phase: 'tidy',
      selectedCandidateId: null,
      reviewId: 'r1',
      dialogOpen: true,
    })).toBe(false)
    // H3: applied_unverified forbids re-apply.
    expect(canApplyWorktree({
      phase: 'reviewable',
      selectedCandidateId: 'c1',
      reviewId: 'r1',
      dialogOpen: true,
      sideEffectConfirmed: true,
    })).toBe(false)
    expect(phaseFromJobSnapshot({
      id: 'job_u',
      kind: 'worktree',
      status: 'applied_unverified',
      phase: 'applied_unverified',
      startedAt: '2026-08-08T00:00:00.000Z',
      sideEffectConfirmed: true,
    })).toBe('applied_unverified')
  })

  it('guards finalize preview and filters read-only projects', () => {
    expect(isFinalizePreviewResponse({
      ok: true,
      reviewId: 'ftr_1',
      phase: 'reviewable',
      expiresAt: '2026-08-08T00:00:00.000Z',
      projectId: 'p1',
      projectName: 'demo',
      runId: 'run',
      revision: 'a'.repeat(64),
      planDigest: 'd'.repeat(64),
      planDigestShort: 'dddddddddddd',
      alreadyFinalized: false,
      launcherVisible: true,
      launcherAlreadyHome: true,
      promotedToLauncherHome: false,
      deletion: {
        plannedFiles: 1,
        plannedBytes: 10,
        retainedFiles: 2,
        mediaFiles: 3,
        samplePaths: ['dist/old.mp4'],
      },
      issues: [],
    })).toBe(true)

    expect(canApplyFinalize({
      phase: 'reviewable',
      reviewId: 'r1',
      planDigest: 'd'.repeat(64),
      dialogOpen: true,
    })).toBe(true)
    expect(canApplyFinalize({
      phase: 'already_finalized',
      reviewId: 'r1',
      planDigest: 'd'.repeat(64),
      dialogOpen: true,
    })).toBe(false)

    expect(writableFinalizeProjects([
      {
        id: 'a', name: 'A', runId: 'r', revision: 'x', status: 'completed', valid: true,
      },
      {
        id: 'b', name: 'B', runId: 'r', revision: 'x', status: 'completed', valid: true, readOnly: true,
      },
      {
        id: 'c', name: 'C', runId: 'r', revision: 'x', status: 'planned', valid: false,
      },
      {
        id: 'd', name: 'D', runId: 'r', revision: 'x', status: 'rendering', valid: true,
      },
    ]).map((p) => p.id)).toEqual(['a'])

    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(isMaintenanceErrorResponse({
      ok: false,
      issue: { code: 'x', message: 'y' },
    })).toBe(true)

    expect(shouldRetainApplyJobId({ phase: 'applying', jobId: 'job_1' })).toBe(true)
    expect(shouldResyncApplyJob({ jobId: 'job_1', phase: 'applying', busy: false })).toBe(true)
    expect(shouldResyncApplyJob({ jobId: 'job_1', phase: 'applying', busy: true })).toBe(false)
    expect(phaseFromJobSnapshot({
      id: 'job_1',
      kind: 'finalize',
      status: 'succeeded',
      phase: 'completion_recorded',
      startedAt: '2026-08-08T00:00:00.000Z',
    })).toBe('completion_recorded')
    expect(phaseFromJobSnapshot({
      id: 'job_1',
      kind: 'worktree',
      status: 'succeeded',
      phase: 'recorded',
      startedAt: '2026-08-08T00:00:00.000Z',
    })).toBe('recorded')
    expect(phaseFromJobSnapshot({
      id: 'job_1',
      kind: 'worktree',
      status: 'stale',
      phase: 'stale',
      startedAt: '2026-08-08T00:00:00.000Z',
    })).toBe('stale')
    expect(phaseFromJobSnapshot({
      id: 'job_1',
      kind: 'finalize',
      status: 'failed',
      phase: 'failed',
      startedAt: '2026-08-08T00:00:00.000Z',
    })).toBe('failed')
    expect(phaseFromJobSnapshot({
      id: 'job_1',
      kind: 'finalize',
      status: 'running',
      phase: 'revalidating',
      startedAt: '2026-08-08T00:00:00.000Z',
    })).toBe('revalidating')
    expect(shouldRetainApplyJobId({ phase: 'idle', jobId: null })).toBe(false)
    expect(shouldResyncApplyJob({ jobId: null, phase: 'applying', busy: false })).toBe(false)
  })

  it('labels phases and formats edge byte values', async () => {
    const {
      finalizePhaseLabel,
      worktreePhaseLabel,
      formatBytes,
      isMaintenanceJobResponse,
      canApplyFinalize,
    } = await import('./maintenanceModel')
    const worktreePhases = [
      'idle', 'tidy', 'previewing', 'reviewable', 'blocked', 'applying',
      'revalidating', 'verifying', 'recorded', 'applied_unverified', 'stale', 'failed',
    ] as const
    for (const phase of worktreePhases) {
      expect(worktreePhaseLabel(phase).length).toBeGreaterThan(0)
    }
    expect(worktreePhaseLabel('tidy')).toBe('削除対象なし')
    expect(worktreePhaseLabel('recorded')).toBe('整理済み')
    const finalizePhases = [
      'selected', 'completion_declaration', 'previewing', 'reviewable',
      'already_finalized', 'applying', 'revalidating', 'verifying',
      'completion_recorded', 'applied_unverified', 'stale', 'failed',
    ] as const
    for (const phase of finalizePhases) {
      expect(finalizePhaseLabel(phase).length).toBeGreaterThan(0)
    }
    expect(formatBytes(-1)).toBe('—')
    expect(formatBytes(12)).toBe('12 B')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB')
    expect(isMaintenanceJobResponse({
      ok: true,
      job: { id: 'j', status: 'succeeded' },
    })).toBe(true)
    expect(isMaintenanceJobResponse({ ok: true, job: {} })).toBe(false)
    expect(canApplyFinalize({
      phase: 'reviewable',
      reviewId: 'r',
      planDigest: 'd'.repeat(64),
      dialogOpen: true,
      alreadyFinalized: true,
    })).toBe(false)
  })
})
