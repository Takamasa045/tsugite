import { useEffect, useId, useRef, useState } from 'react'

import {
  canApplyFinalize,
  finalizePhaseLabel,
  formatBytes,
  isFinalizePreviewResponse,
  isMaintenanceErrorResponse,
  isMaintenanceJobResponse,
  phaseFromJobSnapshot,
  shouldResyncApplyJob,
  shouldRetainApplyJobId,
  writableFinalizeProjects,
  type FinalizePhase,
  type FinalizePreviewResponse,
  type FinalizeProjectOption,
  type MaintenanceJob,
} from './maintenanceModel'
import { useDialogBackgroundInert } from './useDialogBackgroundInert'

export type MediaFinalizePanelProps = {
  token: string
  projects: readonly FinalizeProjectOption[]
  fetcher?: typeof fetch
}

type LiveRegion = { tone: 'polite' | 'assertive'; message: string }

export function MediaFinalizePanel({
  token,
  projects,
  fetcher = fetch,
}: MediaFinalizePanelProps) {
  const titleId = useId()
  const dialogTitleId = useId()
  const dialogDescId = useId()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null)
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const writable = writableFinalizeProjects(projects)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    writable[0]?.id ?? null,
  )
  const [phase, setPhase] = useState<FinalizePhase>(
    writable.length > 0 ? 'selected' : 'selected',
  )
  const [preview, setPreview] = useState<FinalizePreviewResponse | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<MaintenanceJob | null>(null)
  const [applyJobId, setApplyJobId] = useState<string | null>(null)
  const [live, setLive] = useState<LiveRegion | null>(null)
  const [completionDeclared, setCompletionDeclared] = useState(false)

  const selectedProject = writable.find((project) => project.id === selectedProjectId) ?? null
  const readOnlySelected = projects.find((project) => project.id === selectedProjectId && project.readOnly)
  const nonCompletedSelected = projects.find(
    (project) => project.id === selectedProjectId && project.status !== 'completed',
  )

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
    if (!selectedProject) return
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
        setPhase(phaseFromJobSnapshot(body.job) as FinalizePhase)
        if (body.job.status === 'succeeded') {
          setDialogOpen(false)
          setLive({
            tone: 'polite',
            message: body.job.message ?? '完成記録を残しました',
          })
        }
      } catch {
        // Keep held job id for later resync.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [applyJobId, busy, fetcher, phase, selectedProject, token])

  const declareAndPreview = async () => {
    if (!selectedProject || busy) return
    if (selectedProject.readOnly) {
      setError('他 worktree の案件はここでは整理できません')
      setLive({ tone: 'assertive', message: '他 worktree の案件はここでは整理できません' })
      return
    }
    setCompletionDeclared(true)
    setPhase('previewing')
    setBusy(true)
    setError(null)
    setJob(null)
    setLive({ tone: 'polite', message: '完成宣言を受け、整理計画を確認しています' })
    try {
      const response = await fetcher(
        `/api/projects/${encodeURIComponent(selectedProject.id)}/finalize/preview`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: window.location.origin,
            'x-tsugite-token': token,
          },
          body: JSON.stringify({
            expectedRunId: selectedProject.runId,
            revision: selectedProject.revision,
            completionDeclared: true,
          }),
        },
      )
      const body: unknown = await response.json()
      if (!response.ok || !isFinalizePreviewResponse(body)) {
        const message = isMaintenanceErrorResponse(body)
          ? body.issue.message
          : '整理計画の確認に失敗しました'
        setPhase('failed')
        setError(message)
        setLive({ tone: 'assertive', message })
        return
      }
      setPreview(body)
      setPhase(body.alreadyFinalized ? 'already_finalized' : 'reviewable')
      setLive({
        tone: 'polite',
        message: body.alreadyFinalized
          ? 'この案件は整理済みです'
          : `削除候補 ${body.deletion.plannedFiles} 件（${formatBytes(body.deletion.plannedBytes)}）`,
      })
    } catch {
      setPhase('failed')
      setError('整理計画の確認に失敗しました')
      setLive({ tone: 'assertive', message: '整理計画の確認に失敗しました' })
    } finally {
      setBusy(false)
    }
  }

  const openConfirm = () => {
    if (!preview || preview.alreadyFinalized || phase !== 'reviewable' || busy) return
    setDialogOpen(true)
  }

  const applyFinalize = async () => {
    if (!selectedProject || !preview || busy) return
    if (
      applyJobId
      && (job?.status === 'succeeded' || job?.status === 'applied_unverified' || job?.sideEffectConfirmed)
    ) {
      setError('この整理は実行済みです。再実行はしません。preview のみ再取得してください。')
      setLive({
        tone: 'assertive',
        message: 'この整理は実行済みです。再実行はしません。preview のみ再取得してください。',
      })
      return
    }
    if (!canApplyFinalize({
      phase,
      reviewId: preview.reviewId,
      planDigest: preview.planDigest,
      dialogOpen: true,
      alreadyFinalized: preview.alreadyFinalized,
      sideEffectConfirmed: job?.sideEffectConfirmed === true,
    })) return

    setBusy(true)
    setError(null)
    setPhase('applying')
    setLive({ tone: 'polite', message: '表示されたメディアだけを整理しています' })
    try {
      const response = await fetcher(
        `/api/projects/${encodeURIComponent(selectedProject.id)}/finalize/apply`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: window.location.origin,
            'x-tsugite-token': token,
          },
          body: JSON.stringify({
            reviewId: preview.reviewId,
            planDigest: preview.planDigest,
            confirmed: true,
            ...(typeof preview.productionCompletionDigest === 'string'
              ? { productionCompletionDigest: preview.productionCompletionDigest }
              : {}),
          }),
        },
      )
      const body: unknown = await response.json()
      if (isMaintenanceJobResponse(body)) {
        setJob(body.job)
        if (shouldRetainApplyJobId({ phase: body.job.phase, jobId: body.job.id })) {
          setApplyJobId(body.job.id)
        }
        if (body.job.status === 'succeeded') {
          setDialogOpen(false)
          setPhase('completion_recorded')
          setLive({
            tone: 'polite',
            message: body.job.message ?? '完成記録を残しました',
          })
          return
        }
        if (body.job.status === 'running') {
          setPhase(phaseFromJobSnapshot(body.job) as FinalizePhase)
          return
        }
        setPhase(phaseFromJobSnapshot(body.job) as FinalizePhase)
        setError(body.job.message ?? 'メディア整理に失敗しました')
        setDialogOpen(false)
        setLive({
          tone: 'assertive',
          message: body.job.message ?? 'メディア整理に失敗しました',
        })
        return
      }
      if (isMaintenanceErrorResponse(body)) {
        if (body.job) setJob(body.job)
        if (body.job?.id) setApplyJobId(body.job.id)
        const stale = body.issue.code === 'maintenance.plan_stale'
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
          setPreview(null)
        }
        return
      }
      setPhase('failed')
      setError('メディア整理に失敗しました')
      setLive({ tone: 'assertive', message: 'メディア整理に失敗しました' })
    } catch {
      setPhase('failed')
      setError('メディア整理に失敗しました')
      setLive({ tone: 'assertive', message: 'メディア整理に失敗しました' })
    } finally {
      setBusy(false)
      triggerRef.current?.focus()
    }
  }

  return (
    <section
      aria-labelledby={titleId}
      className="maintenance-panel maintenance-panel--finalize"
      data-phase={phase}
    >
      <header className="maintenance-panel__header">
        <div>
          <h3 id={titleId}>完成作品のメディア</h3>
          <p>
            人間が完成と宣言した案件だけ、旧ラン・未使用素材を整理します。
            Gate 3 承認だけでは実行しません。
          </p>
        </div>
        <p className="maintenance-panel__phase" aria-live="polite">
          {finalizePhaseLabel(phase)}
        </p>
      </header>

      {writable.length === 0 ? (
        <p className="maintenance-panel__empty">
          このランチャーから整理できる案件がありません。
          他 worktree の案件は読み取り専用です。
        </p>
      ) : (
        <label className="maintenance-field">
          <span>対象案件</span>
          <select
            disabled={busy}
            onChange={(event) => {
              setSelectedProjectId(event.target.value)
              setPreview(null)
              setCompletionDeclared(false)
              setPhase('selected')
              setJob(null)
              setError(null)
            }}
            value={selectedProjectId ?? ''}
          >
            {writable.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}（{project.runId}）
              </option>
            ))}
          </select>
        </label>
      )}

      {readOnlySelected && (
        <p className="maintenance-panel__error" role="status">
          他 worktree の案件は変更できません。対象 worktree からランチャーを開いてください。
        </p>
      )}

      {nonCompletedSelected && !readOnlySelected && (
        <p className="maintenance-panel__error" role="status">
          status が completed の案件だけ整理できます（完成宣言は別途必須です）。
        </p>
      )}

      <div className="maintenance-panel__actions">
        <button
          disabled={
            !selectedProject
            || busy
            || Boolean(readOnlySelected)
            || selectedProject.status !== 'completed'
          }
          onClick={() => void declareAndPreview()}
          type="button"
        >
          {busy && phase === 'previewing'
            ? '確認中…'
            : 'この案件を完成版として確定し、整理計画を確認する'}
        </button>
      </div>

      {!completionDeclared && phase === 'selected' && (
        <p className="maintenance-panel__hint" data-testid="finalize-declaration-hint">
          上のボタンが明示的な完成宣言です。押すまで preview は走りません。
        </p>
      )}

      {error && (
        <p className="maintenance-panel__error" role="alert">{error}</p>
      )}

      {preview && (
        <div className="maintenance-review" data-testid="finalize-review">
          <h4>{preview.alreadyFinalized ? '整理済み' : '整理計画'}</h4>
          <dl>
            <div><dt>案件</dt><dd>{preview.projectName}</dd></div>
            <div><dt>run</dt><dd>{preview.runId}</dd></div>
            <div><dt>正本</dt><dd><code>{preview.canonicalOutput ?? '—'}</code></dd></div>
            <div><dt>plan digest</dt><dd><code>{preview.planDigestShort}</code></dd></div>
            <div>
              <dt>削除候補</dt>
              <dd>
                {preview.deletion.plannedFiles} 件 / {formatBytes(preview.deletion.plannedBytes)}
              </dd>
            </div>
            <div><dt>保持</dt><dd>{preview.deletion.retainedFiles} 件</dd></div>
            <div>
              <dt>launcher</dt>
              <dd>
                {preview.launcherVisible ? '表示対象' : '要確認'}
                {preview.launcherAlreadyHome ? ' · durable home 済み' : ''}
              </dd>
            </div>
            {preview.completionRecord && (
              <div>
                <dt>{preview.alreadyFinalized ? '完成記録' : '記録予定'}</dt>
                <dd data-testid="finalize-completion-path">
                  <code>{preview.completionRecord}</code>
                </dd>
              </div>
            )}
          </dl>
          {preview.deletion.samplePaths.length > 0 && (
            <ul className="maintenance-sample-paths" aria-label="削除候補の例">
              {preview.deletion.samplePaths.map((path) => (
                <li key={path}><code>{path}</code></li>
              ))}
            </ul>
          )}

          {preview.alreadyFinalized ? (
            <p className="maintenance-panel__success" data-testid="finalize-already">
              候補 0 件で完成記録があります。追加の整理は不要です。
            </p>
          ) : (
            <button
              ref={triggerRef}
              disabled={busy || phase !== 'reviewable'}
              onClick={openConfirm}
              type="button"
            >
              表示されたメディアだけを整理…
            </button>
          )}
        </div>
      )}

      {job?.status === 'succeeded' && (
        <p className="maintenance-panel__success" data-testid="finalize-success">
          {job.message}
          {typeof job.finalize?.deletedFiles === 'number'
            && `（削除 ${job.finalize.deletedFiles} 件 / ${formatBytes(job.finalize.deletedBytes ?? 0)}）`}
        </p>
      )}

      {dialogOpen && preview && (
        <div
          aria-labelledby={dialogTitleId}
          aria-describedby={dialogDescId}
          aria-modal="true"
          className="maintenance-dialog"
          data-testid="finalize-confirm-dialog"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              event.preventDefault()
            }
          }}
          ref={dialogRef}
          role="dialog"
        >
          <div className="maintenance-dialog__card">
            <h4 id={dialogTitleId}>表示されたメディアだけを整理しますか？</h4>
            <p id={dialogDescId}>
              {preview.projectName} の削除候補 {preview.deletion.plannedFiles} 件
              （{formatBytes(preview.deletion.plannedBytes)}）を整理し、
              正本と完成記録を残します。digest <code>{preview.planDigestShort}</code> が一致するときだけ実行します。
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
                onClick={() => void applyFinalize()}
                type="button"
              >
                {busy ? '整理中…' : '整理する'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div
        aria-live={live?.tone ?? 'polite'}
        className="sr-only"
        data-testid="finalize-live"
      >
        {live?.message}
      </div>
    </section>
  )
}
