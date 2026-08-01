import { Copy } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

/** Clipboard wait upper bound; never hang on unresolved writeText. */
export const FREEFORM_CLIPBOARD_TIMEOUT_MS = 1500

export type FreeformCopyState = 'idle' | 'copied' | 'unsupported' | 'failed'

export interface ExpressionFreeformExportProps {
  exportText: string
  /** Optional parent status line (aria-live elsewhere). Never receives raw errors/tokens. */
  onStatusMessage?: (message: string) => void
}

/**
 * Freeform production export: preview text + explicit-click clipboard only.
 * No auto-copy, no execCommand fallback, no external send.
 */
export function ExpressionFreeformExport({
  exportText,
  onStatusMessage: _onStatusMessage,
}: ExpressionFreeformExportProps) {
  // Copy feedback is intentionally local (role=status/alert below). Do not
  // mirror into parent aria-live — that double-announces the same copy message.
  // Parent selection status is never cleared here (exportText change → local idle only).
  void _onStatusMessage
  const freeformExportId = useId()
  const [copyState, setCopyState] = useState<FreeformCopyState>('idle')
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyGenerationRef = useRef(0)

  function clearPendingTimeout() {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }

  // Selection / text change must never auto-copy. Invalidate in-flight generations
  // and timers so a stale writeText resolve cannot restore "copied" on new text.
  // Local copy UI only — do not clear parent selection status via onStatusMessage('').
  useEffect(() => {
    copyGenerationRef.current += 1
    clearPendingTimeout()
    setCopyState('idle')
  }, [exportText])

  useEffect(() => () => {
    clearPendingTimeout()
    copyGenerationRef.current += 1
  }, [])

  async function copyFreeformExport() {
    const text = exportText
    if (typeof navigator === 'undefined'
      || !navigator.clipboard
      || typeof navigator.clipboard.writeText !== 'function') {
      // Copy feedback stays in the child live region only — do not mirror into
      // the parent aria-live (would double-announce the same message).
      setCopyState('unsupported')
      return
    }

    clearPendingTimeout()
    const generation = ++copyGenerationRef.current

    // Normalize sync throws from writeText into Promise rejections so they
    // follow the same generic failure path as async rejects (never uncaught).
    const writePromise = Promise.resolve().then(() => navigator.clipboard.writeText(text))
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null
        resolve('timeout')
      }, FREEFORM_CLIPBOARD_TIMEOUT_MS)
    })

    try {
      const result = await Promise.race([
        writePromise.then(() => 'ok' as const).catch(() => 'failed' as const),
        timeoutPromise,
      ])
      if (generation !== copyGenerationRef.current) return
      clearPendingTimeout()
      if (result === 'ok') {
        setCopyState('copied')
        return
      }
      // reject or timeout → generic failure only (no raw error / token)
      setCopyState('failed')
    } catch {
      if (generation !== copyGenerationRef.current) return
      clearPendingTimeout()
      setCopyState('failed')
    }
  }

  return (
    <div className="launcher-expression-freeform-export">
      <h4>自由制作に貼り付ける表現指定</h4>
      <p>
        選択した表現を、制作依頼へ貼り付けられる形で表示します。
        コピーは下のボタンを押したときだけ行います（自動ではコピーしません）。
      </p>
      <textarea
        aria-label="自由制作に貼り付ける表現指定"
        className="launcher-expression-freeform-export-text"
        id={freeformExportId}
        readOnly
        rows={8}
        value={exportText}
      />
      <button
        className="launcher-primary"
        onClick={() => void copyFreeformExport()}
        type="button"
      >
        <Copy aria-hidden="true" size={16} />
        表現指定をコピー
      </button>
      {copyState === 'copied' && (
        <p className="launcher-expression-state" role="status">
          コピー済みです。まだ送信していません。
        </p>
      )}
      {copyState === 'unsupported' && (
        <p className="launcher-expression-state is-error" role="alert">
          この環境ではコピーできません。表示中の文言を手動で選んでコピーしてください。
        </p>
      )}
      {copyState === 'failed' && (
        <p className="launcher-expression-state is-error" role="alert">
          コピーに失敗しました。表示中の文言を手動で選んでコピーしてください。
        </p>
      )}
    </div>
  )
}
