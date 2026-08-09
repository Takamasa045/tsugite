import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { MaintenanceShelf } from './MaintenanceShelf'
import { MediaFinalizePanel } from './MediaFinalizePanel'
import { WorktreeCleanupPanel } from './WorktreeCleanupPanel'

function jsonResponse(input: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => input,
  } as Response
}

const worktreePreview = {
  ok: true as const,
  reviewId: 'wtr_abc',
  phase: 'reviewable' as const,
  expiresAt: '2026-08-08T12:00:00.000Z',
  mainBranch: 'main',
  removableCount: 1,
  blockedCount: 1,
  warningActive: false,
  warningThreshold: 3,
  tidy: false,
  candidates: [{
    candidateId: 'wtc_1',
    removable: true,
    isPrimary: false,
    isCurrent: false,
    branch: 'codex/clean',
    headShort: 'bbbbbbbbbbbb',
    displayName: 'clean-merged',
    blockReasons: [],
    blockReasonLabels: [],
    ignoredProtected: [],
    mergedIntoMain: true,
    dirtyTracked: false,
    dirtyUntracked: false,
    locked: false,
    missing: false,
  }],
  blocked: [{
    candidateId: 'wtc_blocked',
    removable: false,
    isPrimary: false,
    isCurrent: false,
    branch: 'codex/dirty',
    headShort: 'cccccccccccc',
    displayName: 'dirty',
    blockReasons: ['dirty_untracked'],
    blockReasonLabels: ['未保存ファイルがあります'],
    ignoredProtected: [],
    mergedIntoMain: true,
    dirtyTracked: false,
    dirtyUntracked: true,
    locked: false,
    missing: false,
  }],
}

const finalizePreview = {
  ok: true as const,
  reviewId: 'ftr_1',
  phase: 'reviewable' as const,
  expiresAt: '2026-08-08T12:00:00.000Z',
  projectId: 'p1',
  projectName: 'デモ案件',
  runId: 'demo-run',
  revision: 'a'.repeat(64),
  planDigest: 'd'.repeat(64),
  planDigestShort: 'dddddddddddd',
  canonicalOutput: 'dist/demo-run/final.mp4',
  completionRecord: null,
  alreadyFinalized: false,
  launcherVisible: true,
  launcherAlreadyHome: true,
  promotedToLauncherHome: false,
  deletion: {
    plannedFiles: 1,
    plannedBytes: 2048,
    retainedFiles: 2,
    mediaFiles: 3,
    samplePaths: ['dist/old/old.mp4'],
  },
  issues: [],
}

const projects = [
  {
    id: 'p1',
    name: 'デモ案件',
    runId: 'demo-run',
    revision: 'a'.repeat(64),
    status: 'completed',
    valid: true,
  },
  {
    id: 'p-ro',
    name: '他worktree',
    runId: 'ro-run',
    revision: 'b'.repeat(64),
    status: 'completed',
    valid: true,
    readOnly: true,
  },
]

describe('MaintenanceShelf', () => {
  it('keeps worktree and finalize panels separate under 安全な整理', () => {
    render(<MaintenanceShelf projects={projects} token="token" />)
    expect(screen.getByRole('heading', { name: '安全な整理' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Git 作業場所' })).toBeVisible()
    expect(screen.getByRole('heading', { name: '完成作品のメディア' })).toBeVisible()
  })
})

describe('WorktreeCleanupPanel', () => {
  it('does not call apply without preview + confirm dialog; Escape restores focus', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/preview')) return jsonResponse(worktreePreview)
      if (url.includes('/apply')) {
        return jsonResponse({
          ok: true,
          job: {
            id: 'job_1',
            kind: 'worktree',
            status: 'succeeded',
            phase: 'recorded',
            startedAt: '2026-08-08T00:00:00.000Z',
            completedAt: '2026-08-08T00:00:01.000Z',
            message: '作業場所を整理しました',
            worktree: { removedDisplayName: 'clean-merged', removableCount: 0, postPreviewTidy: true },
          },
        })
      }
      return jsonResponse({ ok: false, issue: { code: 'x', message: 'no' } }, 500)
    })

    render(<WorktreeCleanupPanel fetcher={fetcher as typeof fetch} token="tok" />)

    // No apply before preview
    expect(fetcher).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '安全状態を確認' }))
    await screen.findByTestId('worktree-review')
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes('/apply'))).toBe(false)

    // blocked reasons are readable
    expect(screen.getByText('未保存ファイルがあります')).toBeVisible()

    const openDialog = screen.getByRole('button', { name: 'この作業場所だけを削除…' })
    await user.click(openDialog)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-describedby')
    expect(within(dialog).getByRole('heading', { name: /この作業場所だけを削除/ })).toBeVisible()

    // Escape cancels and restores trigger focus
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes('/apply'))).toBe(false)
    expect(openDialog).toHaveFocus()

    // Confirm path
    await user.click(screen.getByRole('button', { name: 'この作業場所だけを削除…' }))
    await user.click(screen.getByRole('button', { name: '削除する' }))
    await waitFor(() => {
      expect(fetcher.mock.calls.some((call) => String(call[0]).includes('/apply'))).toBe(true)
    })
    const applyCall = fetcher.mock.calls.find((call) => String(call[0]).includes('/apply'))
    const body = JSON.parse(String(applyCall?.[1]?.body ?? '{}')) as Record<string, unknown>
    expect(body).toEqual({
      reviewId: 'wtr_abc',
      candidateId: 'wtc_1',
      confirmed: true,
    })
    expect(body.path).toBeUndefined()
  })

  it('traps focus in confirm dialog and restores trigger after cancel', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/preview')) return jsonResponse(worktreePreview)
      return jsonResponse({ ok: false, issue: { code: 'x', message: 'no' } }, 500)
    })
    render(<WorktreeCleanupPanel fetcher={fetcher as typeof fetch} token="tok" />)
    await user.click(screen.getByRole('button', { name: '安全状態を確認' }))
    const trigger = await screen.findByRole('button', { name: 'この作業場所だけを削除…' })
    await user.click(trigger)
    const dialog = screen.getByTestId('worktree-confirm-dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-describedby')
    const cancel = within(dialog).getByRole('button', { name: 'やめる' })
    const confirm = within(dialog).getByRole('button', { name: '削除する' })
    expect(confirm).toHaveFocus()
    await user.tab()
    expect(cancel).toHaveFocus()
    await user.tab()
    expect(confirm).toHaveFocus()
    await user.click(cancel)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('M3: tidy preview (0 candidates) is 削除対象なし, not 整理済み', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/preview')) {
        return jsonResponse({
          ...worktreePreview,
          candidates: [],
          removableCount: 0,
          tidy: true,
          blocked: worktreePreview.blocked,
        })
      }
      return jsonResponse({ ok: false, issue: { code: 'x', message: 'no' } }, 500)
    })
    render(<WorktreeCleanupPanel fetcher={fetcher as typeof fetch} token="tok" />)
    await user.click(screen.getByRole('button', { name: '安全状態を確認' }))
    await screen.findByTestId('worktree-tidy')
    expect(screen.getAllByText('削除対象なし').length).toBeGreaterThan(0)
    expect(screen.queryByText('整理済み')).not.toBeInTheDocument()
    expect(screen.getByTestId('worktree-tidy')).toHaveTextContent('削除対象はありません')
  })

  it('M4: worktree dialog returns focus on escape outside and wraps Shift+Tab', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/preview')) return jsonResponse(worktreePreview)
      return jsonResponse({ ok: false, issue: { code: 'x', message: 'no' } }, 500)
    })
    render(<WorktreeCleanupPanel fetcher={fetcher as typeof fetch} token="tok" />)
    await user.click(screen.getByRole('button', { name: '安全状態を確認' }))
    await user.click(await screen.findByRole('button', { name: 'この作業場所だけを削除…' }))
    const dialog = screen.getByTestId('worktree-confirm-dialog')
    const cancel = within(dialog).getByRole('button', { name: 'やめる' })
    const confirm = within(dialog).getByRole('button', { name: '削除する' })
    expect(confirm).toHaveFocus()
    await user.tab({ shift: true })
    expect(cancel).toHaveFocus()
    // Focus escape via body-level control (outside #root inert siblings).
    const outside = document.createElement('button')
    outside.type = 'button'
    outside.textContent = 'outside-body'
    document.body.appendChild(outside)
    outside.focus()
    await waitFor(() => expect(confirm).toHaveFocus())
    outside.remove()
  })

  it('does not auto-apply on stale; announces via aria-live', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/preview')) return jsonResponse(worktreePreview)
      return jsonResponse({
        ok: false,
        issue: { code: 'maintenance.snapshot_stale', message: '状態が変わりました' },
      }, 409)
    })
    render(<WorktreeCleanupPanel fetcher={fetcher as typeof fetch} token="tok" />)
    await user.click(screen.getByRole('button', { name: '安全状態を確認' }))
    await screen.findByTestId('worktree-review')
    await user.click(screen.getByRole('button', { name: 'この作業場所だけを削除…' }))
    await user.click(screen.getByRole('button', { name: '削除する' }))
    await waitFor(() => {
      expect(screen.getAllByText('状態が変わりました').length).toBeGreaterThan(0)
    })
    expect(screen.getByTestId('worktree-live')).toHaveTextContent('状態が変わりました')
    // only one apply attempt
    expect(fetcher.mock.calls.filter((call) => String(call[0]).includes('/apply'))).toHaveLength(1)
  })

  it('handles worktree apply network failure', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/preview')) return jsonResponse(worktreePreview)
      throw new Error('network')
    })
    render(<WorktreeCleanupPanel fetcher={fetcher as typeof fetch} token="tok" />)
    await user.click(screen.getByRole('button', { name: '安全状態を確認' }))
    await screen.findByTestId('worktree-review')
    await user.click(screen.getByRole('button', { name: 'この作業場所だけを削除…' }))
    await user.click(screen.getByRole('button', { name: '削除する' }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('作業場所の削除に失敗しました')
    })
  })

  it('handles worktree preview network failure and invalid apply body', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/preview') && !url.includes('/apply')) {
        if (fetcher.mock.calls.length === 1) throw new Error('preview down')
        return jsonResponse(worktreePreview)
      }
      return jsonResponse({ ok: true, unexpected: true })
    })
    render(<WorktreeCleanupPanel fetcher={fetcher as typeof fetch} token="tok" />)
    await user.click(screen.getByRole('button', { name: '安全状態を確認' }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('作業場所の確認に失敗しました')
    })
    await user.click(screen.getByRole('button', { name: '安全状態を確認' }))
    await screen.findByTestId('worktree-review')
    await user.click(screen.getByRole('button', { name: 'この作業場所だけを削除…' }))
    await user.click(screen.getByRole('button', { name: '削除する' }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('作業場所の削除に失敗しました')
    })
  })

  it('handles worktree job failed status body', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/preview')) return jsonResponse(worktreePreview)
      return jsonResponse({
        ok: true,
        job: {
          id: 'job_w_fail',
          kind: 'worktree',
          status: 'failed',
          phase: 'failed',
          startedAt: '2026-08-08T00:00:00.000Z',
          message: '削除を拒否しました',
        },
      })
    })
    render(<WorktreeCleanupPanel fetcher={fetcher as typeof fetch} token="tok" />)
    await user.click(screen.getByRole('button', { name: '安全状態を確認' }))
    await screen.findByTestId('worktree-review')
    await user.click(screen.getByRole('button', { name: 'この作業場所だけを削除…' }))
    await user.click(screen.getByRole('button', { name: '削除する' }))
    await waitFor(() => {
      expect(screen.getAllByText('削除を拒否しました').length).toBeGreaterThan(0)
    })
  })

  it('resyncs held worktree job id after disconnect', async () => {
    const user = userEvent.setup()
    let applyCalls = 0
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/preview') && !url.includes('/jobs/')) return jsonResponse(worktreePreview)
      if (url.includes('/apply')) {
        applyCalls += 1
        return jsonResponse({
          ok: true,
          job: {
            id: 'job_w_held',
            kind: 'worktree',
            status: 'running',
            phase: 'applying',
            startedAt: '2026-08-08T00:00:00.000Z',
          },
        })
      }
      if (url.includes('/jobs/job_w_held')) {
        return jsonResponse({
          ok: true,
          job: {
            id: 'job_w_held',
            kind: 'worktree',
            status: 'succeeded',
            phase: 'recorded',
            startedAt: '2026-08-08T00:00:00.000Z',
            message: '作業場所を整理しました',
            worktree: { removableCount: 0 },
          },
        })
      }
      return jsonResponse({ ok: false, issue: { code: 'x', message: 'no' } }, 500)
    })
    render(<WorktreeCleanupPanel fetcher={fetcher as typeof fetch} token="tok" />)
    await user.click(screen.getByRole('button', { name: '安全状態を確認' }))
    await screen.findByTestId('worktree-review')
    await user.click(screen.getByRole('button', { name: 'この作業場所だけを削除…' }))
    await user.click(screen.getByRole('button', { name: '削除する' }))
    await waitFor(() => expect(applyCalls).toBe(1))
    await waitFor(() => {
      expect(screen.getByTestId('worktree-success')).toBeVisible()
    })
    expect(applyCalls).toBe(1)
  })

  it('disables double-click while applying', async () => {
    const user = userEvent.setup()
    let resolveApply!: (value: Response) => void
    const applyPromise = new Promise<Response>((resolve) => {
      resolveApply = resolve
    })
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/preview')) return jsonResponse(worktreePreview)
      return applyPromise
    })
    render(<WorktreeCleanupPanel fetcher={fetcher as typeof fetch} token="tok" />)
    await user.click(screen.getByRole('button', { name: '安全状態を確認' }))
    await screen.findByTestId('worktree-review')
    await user.click(screen.getByRole('button', { name: 'この作業場所だけを削除…' }))
    const confirm = screen.getByRole('button', { name: '削除する' })
    await user.click(confirm)
    expect(confirm).toBeDisabled()
    await user.click(confirm)
    expect(fetcher.mock.calls.filter((call) => String(call[0]).includes('/apply'))).toHaveLength(1)
    resolveApply(jsonResponse({
      ok: true,
      job: {
        id: 'job_1',
        kind: 'worktree',
        status: 'succeeded',
        phase: 'recorded',
        startedAt: '2026-08-08T00:00:00.000Z',
        message: 'done',
      },
    }))
  })
})

describe('MediaFinalizePanel', () => {
  it('requires completion declaration before preview and never applies without dialog', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/finalize/preview')) return jsonResponse(finalizePreview)
      if (url.includes('/finalize/apply')) {
        return jsonResponse({
          ok: true,
          job: {
            id: 'job_f',
            kind: 'finalize',
            status: 'succeeded',
            phase: 'completion_recorded',
            startedAt: '2026-08-08T00:00:00.000Z',
            message: '完成記録を残しました',
            finalize: { deletedFiles: 1, deletedBytes: 2048, launcherVisible: true },
          },
        })
      }
      return jsonResponse({ ok: false, issue: { code: 'x', message: 'no' } }, 500)
    })

    render(
      <MediaFinalizePanel
        fetcher={fetcher as typeof fetch}
        projects={projects}
        token="tok"
      />,
    )

    expect(screen.getByTestId('finalize-declaration-hint')).toBeVisible()
    expect(fetcher).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', {
      name: 'この案件を完成版として確定し、整理計画を確認する',
    }))
    await screen.findByTestId('finalize-review')
    const previewBody = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body ?? '{}')) as Record<string, unknown>
    expect(previewBody.completionDeclared).toBe(true)
    expect(previewBody.stateDir).toBeUndefined()
    expect(previewBody.configPath).toBeUndefined()

    // no apply yet
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes('/apply'))).toBe(false)
    await user.click(screen.getByRole('button', { name: '表示されたメディアだけを整理…' }))
    await user.click(screen.getByRole('button', { name: '整理する' }))
    await waitFor(() => {
      expect(fetcher.mock.calls.some((call) => String(call[0]).includes('/apply'))).toBe(true)
    })
  })

  it('shows already-finalized and excludes readOnly projects from the selector', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn(async () => jsonResponse({
      ...finalizePreview,
      phase: 'already_finalized',
      alreadyFinalized: true,
      deletion: {
        plannedFiles: 0,
        plannedBytes: 0,
        retainedFiles: 1,
        mediaFiles: 1,
        samplePaths: [],
      },
      completionRecord: 'dist/demo-run/completion-record.json',
    }))
    render(
      <MediaFinalizePanel
        fetcher={fetcher as typeof fetch}
        projects={projects}
        token="tok"
      />,
    )
    const options = screen.getAllByRole('option').map((node) => node.textContent)
    expect(options.some((text) => text?.includes('他worktree'))).toBe(false)

    await user.click(screen.getByRole('button', {
      name: 'この案件を完成版として確定し、整理計画を確認する',
    }))
    await screen.findByTestId('finalize-already')
    expect(screen.queryByRole('button', { name: '表示されたメディアだけを整理…' })).not.toBeInTheDocument()
  })

  it('announces plan stale without auto re-apply', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/preview')) return jsonResponse(finalizePreview)
      return jsonResponse({
        ok: false,
        issue: { code: 'maintenance.plan_stale', message: '計画が古くなりました' },
      }, 409)
    })
    render(
      <MediaFinalizePanel
        fetcher={fetcher as typeof fetch}
        projects={projects}
        token="tok"
      />,
    )
    await user.click(screen.getByRole('button', {
      name: 'この案件を完成版として確定し、整理計画を確認する',
    }))
    await screen.findByTestId('finalize-review')
    await user.click(screen.getByRole('button', { name: '表示されたメディアだけを整理…' }))
    await user.click(screen.getByRole('button', { name: '整理する' }))
    await waitFor(() => {
      expect(screen.getAllByText('計画が古くなりました').length).toBeGreaterThan(0)
    })
    expect(screen.getByTestId('finalize-live')).toHaveTextContent('計画が古くなりました')
    expect(fetcher.mock.calls.filter((call) => String(call[0]).includes('/apply'))).toHaveLength(1)
  })

  it('excludes non-completed projects from finalize selection', () => {
    render(
      <MediaFinalizePanel
        projects={[
          ...projects,
          {
            id: 'planned',
            name: '未完成',
            runId: 'p-run',
            revision: 'c'.repeat(64),
            status: 'planned',
            valid: true,
          },
        ]}
        token="tok"
      />,
    )
    const options = screen.getAllByRole('option').map((node) => node.textContent)
    expect(options.some((text) => text?.includes('未完成'))).toBe(false)
    expect(options.some((text) => text?.includes('デモ案件'))).toBe(true)
  })

  it('switches project selection and opens dialog backdrop without closing', async () => {
    const user = userEvent.setup()
    const multi = [
      ...projects,
      {
        id: 'p2',
        name: '別案件',
        runId: 'run-2',
        revision: 'b'.repeat(64),
        status: 'completed' as const,
        valid: true,
        readOnly: false,
      },
    ]
    const fetcher = vi.fn(async () => jsonResponse(finalizePreview))
    render(
      <MediaFinalizePanel
        fetcher={fetcher as typeof fetch}
        projects={multi}
        token="tok"
      />,
    )
    await user.selectOptions(screen.getByRole('combobox'), 'p2')
    await user.click(screen.getByRole('button', {
      name: 'この案件を完成版として確定し、整理計画を確認する',
    }))
    await user.click(await screen.findByRole('button', { name: '表示されたメディアだけを整理…' }))
    const dialog = screen.getByTestId('finalize-confirm-dialog')
    // Backdrop mousedown is swallowed (does not dismiss).
    fireEvent.mouseDown(dialog)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'やめる' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('shows finalize success with deleted bytes and empty writable message', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/preview')) return jsonResponse(finalizePreview)
      return jsonResponse({
        ok: true,
        job: {
          id: 'job_fin_ok',
          kind: 'finalize',
          status: 'succeeded',
          phase: 'completion_recorded',
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:01.000Z',
          message: '完成記録を残しました',
          finalize: { deletedFiles: 2, deletedBytes: 2048, completionRecord: 'dist/x.json' },
        },
      })
    })
    render(
      <MediaFinalizePanel
        fetcher={fetcher as typeof fetch}
        projects={projects}
        token="tok"
      />,
    )
    await user.click(screen.getByRole('button', {
      name: 'この案件を完成版として確定し、整理計画を確認する',
    }))
    await user.click(await screen.findByRole('button', { name: '表示されたメディアだけを整理…' }))
    await user.click(screen.getByRole('button', { name: '整理する' }))
    await screen.findByTestId('finalize-success')
    expect(screen.getByText(/削除 2 件/)).toBeVisible()

    render(
      <MediaFinalizePanel
        fetcher={vi.fn() as unknown as typeof fetch}
        projects={[{
          id: 'ro',
          name: '他',
          runId: 'r',
          revision: 'a'.repeat(64),
          status: 'completed',
          valid: true,
          readOnly: true,
        }]}
        token="tok"
      />,
    )
    expect(screen.getByText(/整理できる案件がありません/)).toBeVisible()
  })

  it('M5: shows planned completion path label when not yet finalized', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn(async () => jsonResponse({
      ...finalizePreview,
      alreadyFinalized: false,
      completionRecord: 'dist/demo-run/completion-record.json',
    }))
    render(
      <MediaFinalizePanel
        fetcher={fetcher as typeof fetch}
        projects={projects}
        token="tok"
      />,
    )
    await user.click(screen.getByRole('button', {
      name: 'この案件を完成版として確定し、整理計画を確認する',
    }))
    await screen.findByTestId('finalize-completion-path')
    expect(screen.getByText('記録予定')).toBeVisible()
    expect(screen.queryByText('完成記録')).not.toBeInTheDocument()
  })

  it('M4: focus escape returns to finalize dialog; Shift+Tab wraps', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/preview')) return jsonResponse(finalizePreview)
      return jsonResponse({ ok: false, issue: { code: 'x', message: 'no' } }, 500)
    })
    render(
      <MediaFinalizePanel
        fetcher={fetcher as typeof fetch}
        projects={projects}
        token="tok"
      />,
    )
    await user.click(screen.getByRole('button', {
      name: 'この案件を完成版として確定し、整理計画を確認する',
    }))
    await user.click(await screen.findByRole('button', { name: '表示されたメディアだけを整理…' }))
    const dialog = screen.getByTestId('finalize-confirm-dialog')
    const cancel = within(dialog).getByRole('button', { name: 'やめる' })
    const confirm = within(dialog).getByRole('button', { name: '整理する' })
    expect(confirm).toHaveFocus()
    await user.tab({ shift: true })
    expect(cancel).toHaveFocus()
    const outside = document.createElement('button')
    outside.type = 'button'
    outside.textContent = 'outside-body'
    document.body.appendChild(outside)
    outside.focus()
    await waitFor(() => expect(confirm).toHaveFocus())
    outside.remove()
  })

  it('traps focus in finalize confirm dialog and restores trigger after cancel', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/preview')) return jsonResponse(finalizePreview)
      return jsonResponse({ ok: false, issue: { code: 'x', message: 'no' } }, 500)
    })
    render(
      <MediaFinalizePanel
        fetcher={fetcher as typeof fetch}
        projects={projects}
        token="tok"
      />,
    )
    await user.click(screen.getByRole('button', {
      name: 'この案件を完成版として確定し、整理計画を確認する',
    }))
    const trigger = await screen.findByRole('button', { name: '表示されたメディアだけを整理…' })
    await user.click(trigger)
    const dialog = screen.getByTestId('finalize-confirm-dialog')
    expect(dialog).toHaveAttribute('aria-describedby')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const cancel = within(dialog).getByRole('button', { name: 'やめる' })
    const confirm = within(dialog).getByRole('button', { name: '整理する' })
    expect(confirm).toHaveFocus()
    await user.tab()
    expect(cancel).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('handles finalize network failure and non-succeeded job bodies', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/preview')) return jsonResponse(finalizePreview)
      if (url.includes('/apply')) {
        return jsonResponse({
          ok: true,
          job: {
            id: 'job_fail',
            kind: 'finalize',
            status: 'failed',
            phase: 'failed',
            startedAt: '2026-08-08T00:00:00.000Z',
            message: '検証に失敗しました',
          },
        })
      }
      return jsonResponse({ ok: false, issue: { code: 'x', message: 'no' } }, 500)
    })
    render(
      <MediaFinalizePanel
        fetcher={fetcher as typeof fetch}
        projects={projects}
        token="tok"
      />,
    )
    await user.click(screen.getByRole('button', {
      name: 'この案件を完成版として確定し、整理計画を確認する',
    }))
    await screen.findByTestId('finalize-review')
    await user.click(screen.getByRole('button', { name: '表示されたメディアだけを整理…' }))
    await user.click(screen.getByRole('button', { name: '整理する' }))
    await waitFor(() => {
      expect(screen.getAllByText('検証に失敗しました').length).toBeGreaterThan(0)
    })
  })

  it('handles preview fetch rejection', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn(async () => {
      throw new Error('network down')
    })
    render(
      <MediaFinalizePanel
        fetcher={fetcher as typeof fetch}
        projects={projects}
        token="tok"
      />,
    )
    await user.click(screen.getByRole('button', {
      name: 'この案件を完成版として確定し、整理計画を確認する',
    }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('整理計画の確認に失敗しました')
    })
  })

  it('handles finalize apply network failure and unexpected body', async () => {
    const user = userEvent.setup()
    let mode: 'throw' | 'bad' = 'throw'
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/preview')) return jsonResponse(finalizePreview)
      if (mode === 'throw') throw new Error('apply down')
      return jsonResponse({ ok: true, nope: true })
    })
    const { rerender } = render(
      <MediaFinalizePanel
        fetcher={fetcher as typeof fetch}
        projects={projects}
        token="tok"
      />,
    )
    await user.click(screen.getByRole('button', {
      name: 'この案件を完成版として確定し、整理計画を確認する',
    }))
    await screen.findByTestId('finalize-review')
    await user.click(screen.getByRole('button', { name: '表示されたメディアだけを整理…' }))
    await user.click(screen.getByRole('button', { name: '整理する' }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('メディア整理に失敗しました')
    })

    mode = 'bad'
    rerender(
      <MediaFinalizePanel
        fetcher={fetcher as typeof fetch}
        projects={projects}
        token="tok"
      />,
    )
  })

  it('resyncs held finalize job id after disconnect instead of re-applying', async () => {
    const user = userEvent.setup()
    let applyCalls = 0
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/finalize/preview')) return jsonResponse(finalizePreview)
      if (url.includes('/finalize/apply')) {
        applyCalls += 1
        return jsonResponse({
          ok: true,
          job: {
            id: 'job_held',
            kind: 'finalize',
            status: 'running',
            phase: 'applying',
            startedAt: '2026-08-08T00:00:00.000Z',
          },
        })
      }
      if (url.includes('/api/maintenance/jobs/job_held')) {
        return jsonResponse({
          ok: true,
          job: {
            id: 'job_held',
            kind: 'finalize',
            status: 'succeeded',
            phase: 'completion_recorded',
            startedAt: '2026-08-08T00:00:00.000Z',
            completedAt: '2026-08-08T00:00:02.000Z',
            message: '完成記録を残しました',
            finalize: { deletedFiles: 1, deletedBytes: 10, completionRecord: 'dist/x.json' },
          },
        })
      }
      return jsonResponse({ ok: false, issue: { code: 'x', message: 'no' } }, 500)
    })
    render(
      <MediaFinalizePanel
        fetcher={fetcher as typeof fetch}
        projects={projects}
        token="tok"
      />,
    )
    await user.click(screen.getByRole('button', {
      name: 'この案件を完成版として確定し、整理計画を確認する',
    }))
    await screen.findByTestId('finalize-review')
    await user.click(screen.getByRole('button', { name: '表示されたメディアだけを整理…' }))
    await user.click(screen.getByRole('button', { name: '整理する' }))
    await waitFor(() => {
      expect(applyCalls).toBe(1)
    })
    await waitFor(() => {
      expect(screen.getByTestId('finalize-success')).toBeVisible()
    })
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes('/jobs/job_held'))).toBe(true)
    expect(applyCalls).toBe(1)
  })
})
