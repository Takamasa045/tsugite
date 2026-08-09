import { useEffect, useId, useRef, useState } from 'react'

import {
  canApplyWorktree,
  isMaintenanceErrorResponse,
  isMaintenanceJobResponse,
  isWorktreePreviewResponse,
  phaseFromJobSnapshot,
  shouldResyncApplyJob,
  shouldRetainApplyJobId,
  worktreePhaseFromPreview,
  worktreePhaseLabel,
  type MaintenanceJob,
  type PublicWorktreeCandidate,
  type WorktreePhase,
  type WorktreePreviewResponse,
} from './maintenanceModel'
import { useDialogBackgroundInert } from './useDialogBackgroundInert'

export type WorktreeCleanupPanelProps = {
  token: string
  fetcher?: typeof fetch
}

type LiveRegion = { tone: 'polite' | 'assertive'; message: string }

export function WorktreeCleanupPanel({
  token,
  fetcher = fetch,
}: WorktreeCleanupPanelProps) {
  const titleId = useId()
  const dialogTitleId = useId()
  const dialogDescId = useId()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null)
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const [phase, setPhase] = useState<WorktreePhase>('idle')
  const [preview, setPreview] = useState<WorktreePreviewResponse | null>(null)
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<MaintenanceJob | null>(null)
  const [applyJobId, setApplyJobId] = useState<string | null>(null)
  const [live, setLive] = useState<LiveRegion | null>(null)

  const selected = preview?.candidates.find((item) => item.candidateId === selectedCandidateId) ?? null

  useDialogBackgroundInert(dialogOpen, dialogRef)

  useEffect(() => {
    if (!dialogOpen) return
    let closed = false
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    confirmButtonRef.current?.focus()
    const closeDialog = () => {
      closed = true
      setDialogOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeDialog()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = [
        cancelButtonRef.current,
        confirmButtonRef.current,
      ].filter((node): node is HTMLButtonElement => Boolean(node))
      if (focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    // M4: pull focus back if it escapes the dialog (inert + focusin trap).
    const onFocusIn = (event: FocusEvent) => {
      if (closed) return
      const target = event.target
      if (!(target instanceof Node) || !dialogRef.current) return
      if (!dialogRef.current.contains(target)) {
        confirmButtonRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      closed = true
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('focusin', onFocusIn)
      // Restore trigger after listeners are gone so focusin cannot steal it back.
      triggerRef.current?.focus()
    }
  }, [dialogOpen])

  useEffect(() => {
    if (!shouldResyncApplyJob({ jobId: applyJobId, phase, busy })) return
    let cancelled = false
    void (async () => {
      try {
        const response = await fetcher(
          `/api/maintenance/jobs/${encodeURIComponent(applyJobId!)}`,
          { headers: { 'x-tsugite-token': token } },
        )
        const body: unknown = await response.json()
        if (cancelled || !isMaintenanceJobResponse(body)) return
        setJob(body.job)
        setPhase(phaseFromJobSnapshot(body.job) as WorktreePhase)
        if (body.job.status === 'succeeded') {
          setDialogOpen(false)
          setLive({
            tone: 'polite',
            message: body.job.message ?? '作業場所を整理しました',
          })
        }
      } catch {
        // Keep held job id; operator can retry resync.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [applyJobId, busy, fetcher, phase, token])

  const runPreview = async (options?: { preserveJob?: boolean }) => {
    setBusy(true)
    setError(null)
    if (!options?.preserveJob) setJob(null)
    setPhase('previewing')
    setLive({ tone: 'polite', message: '作業場所の安全状態を確認しています' })
    try {
      const response = await fetcher('/api/maintenance/worktrees/preview', {
        headers: { 'x-tsugite-token': token },
      })
      const body: unknown = await response.json()
      if (!response.ok || !isWorktreePreviewResponse(body)) {
        const message = isMaintenanceErrorResponse(body)
          ? body.issue.message
          : '作業場所の確認に失敗しました'
        setPhase('failed')
        setError(message)
        setLive({ tone: 'assertive', message })
        return
      }
      setPreview(body)
      setSelectedCandidateId(body.candidates[0]?.candidateId ?? null)
      // M3: tidy preview (0 candidates) is idle/tidy "削除対象なし", not recorded/整理済み.
      const nextPhase = worktreePhaseFromPreview({
        candidatesLength: body.candidates.length,
        tidy: body.tidy,
        preserveJob: options?.preserveJob,
        hadSuccessfulApply: options?.preserveJob === true && job?.status === 'succeeded',
      })
      setPhase(nextPhase)
      setLive({
        tone: 'polite',
        message: body.tidy || body.candidates.length === 0
          ? '削除対象はありません'
          : `削除可能な作業場所が ${body.removableCount} 件あります`,
      })
    } catch {
      setPhase('failed')
      setError('作業場所の確認に失敗しました')
      setLive({ tone: 'assertive', message: '作業場所の確認に失敗しました' })
    } finally {
      setBusy(false)
    }
  }

  const openConfirm = () => {
    if (!selected || phase !== 'reviewable' || busy) return
    setDialogOpen(true)
  }

  const applySelected = async () => {
    if (!preview || !selected || busy) return
    if (applyJobId && job?.status === 'succeeded') {
      setError('この整理は完了済みです。再実行はしません。')
      setLive({ tone: 'assertive', message: 'この整理は完了済みです。再実行はしません。' })
      return
    }
    if (!canApplyWorktree({
      phase,
      selectedCandidateId: selected.candidateId,
      reviewId: preview.reviewId,
      dialogOpen: true,
      sideEffectConfirmed: job?.sideEffectConfirmed === true,
    })) return

    setBusy(true)
    setError(null)
    setPhase('applying')
    setLive({ tone: 'polite', message: 'この作業場所だけを削除しています' })
    try {
      const response = await fetcher('/api/maintenance/worktrees/apply', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: window.location.origin,
          'x-tsugite-token': token,
        },
        body: JSON.stringify({
          reviewId: preview.reviewId,
          candidateId: selected.candidateId,
          confirmed: true,
        }),
      })
      const body: unknown = await response.json()
      if (isMaintenanceJobResponse(body)) {
        setJob(body.job)
        if (shouldRetainApplyJobId({ phase: body.job.phase, jobId: body.job.id })) {
          setApplyJobId(body.job.id)
        }
        if (body.job.status === 'succeeded') {
          setDialogOpen(false)
          setPhase('recorded')
          setLive({
            tone: 'polite',
            message: body.job.message ?? '作業場所を整理しました',
          })
          // Fresh preview after success (keep success record)
          await runPreview({ preserveJob: true })
          return
        }
        if (body.job.status === 'running') {
          setPhase(phaseFromJobSnapshot(body.job) as WorktreePhase)
          return
        }
        setPhase(phaseFromJobSnapshot(body.job) as WorktreePhase)
        setError(body.job.message ?? '作業場所の削除に失敗しました')
        setDialogOpen(false)
        setLive({
          tone: 'assertive',
          message: body.job.message ?? '作業場所の削除に失敗しました',
        })
        return
      }
      if (isMaintenanceErrorResponse(body)) {
        if (body.job) setJob(body.job)
        if (body.job?.id) setApplyJobId(body.job.id)
        const stale = body.issue.code === 'maintenance.snapshot_stale'
        const unverified = body.job?.status === 'applied_unverified'
          || body.issue.code === 'maintenance.applied_unverified'
          || body.job?.sideEffectConfirmed === true
        setPhase(
          stale
            ? 'stale'
            : unverified
              ? 'applied_unverified'
              : 'failed',
        )
        const message = unverified
          ? (body.job?.message
            ?? '実行済み・確認未完了です。再実行は禁止です。preview のみ再取得してください。')
          : body.issue.message
        setError(message)
        setDialogOpen(false)
        setLive({ tone: 'assertive', message })
        if (stale) {
          // Do not auto-apply; require a new preview.
          setPreview(null)
          setSelectedCandidateId(null)
        }
        return
      }
      setPhase('failed')
      setError('作業場所の削除に失敗しました')
      setLive({ tone: 'assertive', message: '作業場所の削除に失敗しました' })
    } catch {
      setPhase('failed')
      setError('作業場所の削除に失敗しました')
      setLive({ tone: 'assertive', message: '作業場所の削除に失敗しました' })
    } finally {
      setBusy(false)
      triggerRef.current?.focus()
    }
  }

  return (
    <section
      aria-labelledby={titleId}
      className="maintenance-panel maintenance-panel--worktree"
      data-phase={phase}
    >
      <header className="maintenance-panel__header">
        <div>
          <h3 id={titleId}>Git 作業場所</h3>
          <p>
            完了済みで安全な worktree だけを、1 件ずつ削除します。ブランチは残ります。
            一括削除はありません。
          </p>
        </div>
        <p className="maintenance-panel__phase" aria-live="polite">
          {worktreePhaseLabel(phase)}
        </p>
      </header>

      <div className="maintenance-panel__actions">
        <button
          disabled={busy}
          onClick={() => void runPreview()}
          type="button"
        >
          {busy && phase === 'previewing' ? '確認中…' : '安全状態を確認'}
        </button>
      </div>

      {error && (
        <p className="maintenance-panel__error" role="alert">{error}</p>
      )}

      {preview && (
        <div className="maintenance-panel__body">
          {preview.tidy || preview.candidates.length === 0 ? (
            <p
              className="maintenance-panel__empty"
              data-testid={phase === 'recorded' ? 'worktree-recorded' : 'worktree-tidy'}
            >
              {phase === 'recorded'
                ? '整理済みです。現在の場所と保護対象はそのまま残ります。'
                : '削除対象はありません。現在の場所と保護対象はそのまま残ります。'}
            </p>
          ) : (
            <CandidateList
              candidates={preview.candidates}
              label="削除可能な候補"
              onSelect={setSelectedCandidateId}
              selectedId={selectedCandidateId}
              selectable
            />
          )}

          {preview.blocked.length > 0 && (
            <CandidateList
              candidates={preview.blocked}
              label="いまは削除できない候補"
              selectedId={null}
              selectable={false}
            />
          )}

          {selected && phase === 'reviewable' && (
            <div className="maintenance-review" data-testid="worktree-review">
              <h4>確認</h4>
              <dl>
                <div><dt>名前</dt><dd>{selected.displayName}</dd></div>
                <div><dt>ブランチ</dt><dd>{selected.branch ?? '（detached）'}</dd></div>
                <div><dt>HEAD</dt><dd><code>{selected.headShort}</code></dd></div>
                <div><dt>main 統合</dt><dd>{selected.mergedIntoMain ? '済み' : '未統合'}</dd></div>
                <div><dt>状態</dt><dd>clean / unlocked / 保護対象なし</dd></div>
              </dl>
              <button
                ref={triggerRef}
                disabled={busy}
                onClick={openConfirm}
                type="button"
              >
                この作業場所だけを削除…
              </button>
            </div>
          )}
        </div>
      )}

      {job?.status === 'succeeded' && (
        <p className="maintenance-panel__success" data-testid="worktree-success">
          {job.message}
          {typeof job.worktree?.removableCount === 'number'
            && `（残りの削除可能候補: ${job.worktree.removableCount}）`}
        </p>
      )}

      {dialogOpen && selected && (
        <div
          aria-labelledby={dialogTitleId}
          aria-describedby={dialogDescId}
          aria-modal="true"
          className="maintenance-dialog"
          data-testid="worktree-confirm-dialog"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              event.preventDefault()
            }
          }}
          ref={dialogRef}
          role="dialog"
        >
          <div className="maintenance-dialog__card">
            <h4 id={dialogTitleId}>この作業場所だけを削除しますか？</h4>
            <p id={dialogDescId}>
              <strong>{selected.displayName}</strong>
              （{selected.branch ?? 'detached'} / <code>{selected.headShort}</code>）
              を削除します。ブランチは残ります。この操作は取り消せません。
            </p>
            <div className="maintenance-dialog__actions">
              <button
                ref={cancelButtonRef}
                disabled={busy}
                onClick={() => {
                  setDialogOpen(false)
                }}
                type="button"
              >
                やめる
              </button>
              <button
                ref={confirmButtonRef}
                className="maintenance-dialog__danger"
                disabled={busy}
                onClick={() => void applySelected()}
                type="button"
              >
                {busy ? '削除中…' : '削除する'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div
        aria-live={live?.tone ?? 'polite'}
        className="sr-only"
        data-testid="worktree-live"
      >
        {live?.message}
      </div>
    </section>
  )
}

function CandidateList({
  candidates,
  label,
  selectedId,
  onSelect,
  selectable,
}: {
  candidates: PublicWorktreeCandidate[]
  label: string
  selectedId: string | null
  onSelect?: (id: string) => void
  selectable: boolean
}) {
  return (
    <div className="maintenance-candidate-list">
      <h4>{label}</h4>
      <ul>
        {candidates.map((candidate) => {
          const selected = candidate.candidateId === selectedId
          return (
            <li key={candidate.candidateId} data-removable={candidate.removable || undefined}>
              {selectable ? (
                <button
                  aria-pressed={selected}
                  className="maintenance-candidate"
                  data-selected={selected || undefined}
                  onClick={() => onSelect?.(candidate.candidateId)}
                  type="button"
                >
                  <CandidateBody candidate={candidate} />
                </button>
              ) : (
                <div className="maintenance-candidate maintenance-candidate--static">
                  <CandidateBody candidate={candidate} />
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function CandidateBody({ candidate }: { candidate: PublicWorktreeCandidate }) {
  return (
    <>
      <strong>{candidate.displayName}</strong>
      <span>{candidate.branch ?? 'detached'} · <code>{candidate.headShort}</code></span>
      {candidate.blockReasonLabels.length > 0 && (
        <ul className="maintenance-block-reasons">
          {candidate.blockReasonLabels.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
    </>
  )
}
