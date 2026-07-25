import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'

import {
  isCharacterUseResponse,
  isWritableTargetProject,
  type CharacterUsePhase,
  type CharacterUseTargetProject,
  type LauncherCharacter,
  type LauncherCharacterSource,
} from './characterShelfModel'

export interface UseCharacterDialogProps {
  open: boolean
  character: LauncherCharacter
  source: LauncherCharacterSource
  projects: CharacterUseTargetProject[]
  token: string
  fetcher?: typeof fetch
  onClose: () => void
  onUsed?: (result: { added: boolean; alreadyPresent: boolean; speakerId: string }) => void
}

const defaultFetcher: typeof fetch = (...args) => window.fetch(...args)

export function UseCharacterDialog({
  open,
  character,
  source,
  projects,
  token,
  fetcher = defaultFetcher,
  onClose,
  onUsed,
}: UseCharacterDialogProps) {
  const titleId = useId()
  const descId = useId()
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const writableProjects = useMemo(
    () => projects.filter(isWritableTargetProject),
    [projects],
  )
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [phase, setPhase] = useState<CharacterUsePhase>('selecting')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [resultSpeakerId, setResultSpeakerId] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setPhase('selecting')
    setErrorMessage(null)
    setResultSpeakerId(null)
    setSelectedProjectId((current) => {
      if (current && writableProjects.some((project) => project.id === current)) return current
      return writableProjects[0]?.id ?? null
    })
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open, writableProjects])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && phase !== 'submitting') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open, phase])

  if (!open) return null

  const selectedProject = writableProjects.find((project) => project.id === selectedProjectId) ?? null
  const isResultPhase = phase === 'success-added'
    || phase === 'success-already'
    || phase === 'error-conflict'
    || phase === 'error'

  async function handleConfirm() {
    if (!selectedProject || phase === 'submitting') return
    setPhase('submitting')
    setErrorMessage(null)
    try {
      const response = await fetcher('/api/characters/use', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-tsugite-token': token,
        },
        body: JSON.stringify({
          sourceKey: source.sourceKey,
          speakerId: source.speakerId,
          targetProjectId: selectedProject.id,
          expectedRunId: selectedProject.runId,
          revision: selectedProject.revision,
        }),
      })
      const payload: unknown = await response.json()
      if (!isCharacterUseResponse(payload)) {
        setPhase('error')
        setErrorMessage('応答の形式を確認できませんでした。もう一度お試しください。')
        return
      }
      if (!payload.ok) {
        if (response.status === 409 || payload.issue.code.includes('conflict') || payload.issue.code.includes('stale')) {
          setPhase('error-conflict')
        } else {
          setPhase('error')
        }
        setErrorMessage(payload.issue.message)
        return
      }
      setResultSpeakerId(payload.speakerId)
      setPhase(payload.alreadyPresent ? 'success-already' : 'success-added')
      onUsed?.({
        added: payload.added,
        alreadyPresent: payload.alreadyPresent,
        speakerId: payload.speakerId,
      })
    } catch {
      setPhase('error')
      setErrorMessage('通信に失敗しました。接続を確認してもう一度お試しください。')
    }
  }

  return (
    <div className="launcher-character-dialog-backdrop" role="presentation">
      <div
        aria-describedby={descId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="launcher-character-dialog"
        role="dialog"
      >
        <header className="launcher-character-dialog-header">
          <div>
            <span className="eyebrow">既存の案件へ追加</span>
            <h2 id={titleId}>{character.displayName}</h2>
          </div>
          <button
            aria-label="閉じる"
            className="launcher-secondary"
            disabled={phase === 'submitting'}
            onClick={onClose}
            ref={closeRef}
            type="button"
          >
            <X aria-hidden="true" size={16} />
          </button>
        </header>

        <p id={descId} className="launcher-character-dialog-summary">
          制作前の本筋は詳細画面の依頼メモコピーです。ここは、すでに書込可能な制作案件があるときの補助です。
          元: {source.label}（{source.speakerId}）
        </p>

        {!isResultPhase && (
          <>
            {writableProjects.length === 0 ? (
              <div className="launcher-character-dialog-empty" role="status">
                <strong>書込できる制作案件がありません。</strong>
                <p>別worktreeの閲覧のみ案件や無効な案件には追加できません。</p>
              </div>
            ) : (
              <fieldset className="launcher-character-dialog-projects" disabled={phase === 'submitting'}>
                <legend>追加先の制作案件</legend>
                <ul>
                  {writableProjects.map((project) => (
                    <li key={project.id}>
                      <label className="launcher-character-dialog-project">
                        <input
                          checked={selectedProjectId === project.id}
                          name="character-use-target"
                          onChange={() => setSelectedProjectId(project.id)}
                          type="radio"
                          value={project.id}
                        />
                        <span>
                          <strong>{project.name}</strong>
                          <small>{project.id}</small>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            )}

            <div className="launcher-character-dialog-actions">
              <button
                className="launcher-secondary"
                disabled={phase === 'submitting'}
                onClick={onClose}
                type="button"
              >
                キャンセル
              </button>
              <button
                className="launcher-primary"
                disabled={!selectedProject || phase === 'submitting' || writableProjects.length === 0}
                onClick={() => void handleConfirm()}
                type="button"
              >
                {phase === 'submitting' ? '追加しています…' : 'この案件へ追加する'}
              </button>
            </div>
          </>
        )}

        {isResultPhase && (
          <div
            className="launcher-character-dialog-result"
            data-phase={phase}
            role={phase.startsWith('error') ? 'alert' : 'status'}
          >
            {phase === 'success-added' && (
              <>
                <strong>キャラクターを追加しました。</strong>
                <p>speakerId: {resultSpeakerId ?? source.speakerId}</p>
              </>
            )}
            {phase === 'success-already' && (
              <>
                <strong>すでに同じキャラクターが入っています。</strong>
                <p>speakerId: {resultSpeakerId ?? source.speakerId}（変更はありません）</p>
              </>
            )}
            {phase === 'error-conflict' && (
              <>
                <strong>競合のため追加できませんでした。</strong>
                <p>{errorMessage ?? '同名speakerが別内容で存在するか、案件の状態が変わっています。'}</p>
              </>
            )}
            {phase === 'error' && (
              <>
                <strong>追加に失敗しました。</strong>
                <p>{errorMessage ?? 'もう一度お試しください。'}</p>
              </>
            )}
            <div className="launcher-character-dialog-actions">
              <button className="launcher-primary" onClick={onClose} type="button">
                閉じる
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
