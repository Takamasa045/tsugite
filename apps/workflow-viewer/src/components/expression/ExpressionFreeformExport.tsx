import { Copy } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import {
  EXPRESSION_CLIPBOARD_TIMEOUT_MS,
  LOCAL_CLIPBOARD_COPY_MESSAGES,
  writeLocalClipboardText,
  type LocalClipboardCopyState,
} from './localClipboardCopy'

/** @deprecated Use EXPRESSION_CLIPBOARD_TIMEOUT_MS */
export const FREEFORM_CLIPBOARD_TIMEOUT_MS = EXPRESSION_CLIPBOARD_TIMEOUT_MS

export type FreeformCopyState = LocalClipboardCopyState

export interface ExpressionFreeformExportProps {
  exportText: string
  /** Optional parent status line (aria-live elsewhere). Never receives raw errors/tokens. */
  onStatusMessage?: (message: string) => void
  /** Heading for the preview block. */
  heading?: string
  /** Description under the heading. */
  description?: string
  /** aria-label / accessible name for the readonly preview. */
  previewLabel?: string
  /** Visible copy button label. */
  copyLabel?: string
}

/**
 * Expression prompt export: preview text + explicit-click clipboard only.
 * No auto-copy, no external send. On click, writeLocalClipboardText tries
 * hidden-textarea execCommand first (OS clipboard), then navigator.clipboard.
 * Always available (including when returning to a template with copy candidates).
 */
export function ExpressionFreeformExport({
  exportText,
  onStatusMessage: _onStatusMessage,
  heading = '選んだ表現のプロンプト',
  description = 'コピー候補として選んだ表現を、別の表現プロンプトとして表示します。制作依頼本文には自動では入りません。コピーは下のボタンを押したときだけ行います（自動ではコピーしません）。',
  previewLabel = '選んだ表現のプロンプト',
  copyLabel = 'まとめてプロンプトをコピー',
}: ExpressionFreeformExportProps) {
  // Copy feedback is intentionally local (role=status/alert below). Do not
  // mirror into parent aria-live — that double-announces the same copy message.
  // Parent selection status is never cleared here (exportText change → local idle only).
  void _onStatusMessage
  const freeformExportId = useId()
  const [copyState, setCopyState] = useState<FreeformCopyState>('idle')
  const copyGenerationRef = useRef(0)

  // Selection / text change must never auto-copy. Invalidate in-flight generations
  // so a stale writeText resolve cannot restore "copied" on new text.
  useEffect(() => {
    copyGenerationRef.current += 1
    setCopyState('idle')
  }, [exportText])

  useEffect(() => () => {
    copyGenerationRef.current += 1
  }, [])

  async function copyFreeformExport() {
    const generation = ++copyGenerationRef.current
    const result = await writeLocalClipboardText(exportText, {
      timeoutMs: EXPRESSION_CLIPBOARD_TIMEOUT_MS,
      signal: {
        generation,
        current: () => copyGenerationRef.current,
      },
    })
    if (generation !== copyGenerationRef.current) return
    if (result === 'stale') return
    if (result === 'ok') {
      setCopyState('copied')
      return
    }
    if (result === 'unsupported') {
      setCopyState('unsupported')
      return
    }
    setCopyState('failed')
  }

  return (
    <div className="launcher-expression-freeform-export">
      <h4>{heading}</h4>
      <p>{description}</p>
      <textarea
        aria-label={previewLabel}
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
        {copyLabel}
      </button>
      {copyState === 'copied' && (
        <p className="launcher-expression-state" role="status">
          {LOCAL_CLIPBOARD_COPY_MESSAGES.copied}
        </p>
      )}
      {copyState === 'unsupported' && (
        <p className="launcher-expression-state is-error" role="alert">
          {LOCAL_CLIPBOARD_COPY_MESSAGES.unsupported}
        </p>
      )}
      {copyState === 'failed' && (
        <p className="launcher-expression-state is-error" role="alert">
          {LOCAL_CLIPBOARD_COPY_MESSAGES.failed}
        </p>
      )}
    </div>
  )
}
