import { Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
  EXPRESSION_CLIPBOARD_TIMEOUT_MS,
  LOCAL_CLIPBOARD_COPY_MESSAGES,
  writeLocalClipboardText,
  type LocalClipboardCopyState,
} from './localClipboardCopy'

export interface LocalClipboardCopyButtonProps {
  text: string
  /** Accessible name for the button (must be unique in list contexts). */
  ariaLabel: string
  /** Visible button label. */
  label?: string
  className?: string
}

/**
 * Explicit-click local clipboard copy with local live-region feedback only.
 * Does not mirror into parent aria-live (avoids double announcements).
 * Text change invalidates in-flight generations (stale resolve ignored).
 */
export function LocalClipboardCopyButton({
  text,
  ariaLabel,
  label = 'プロンプトをコピー',
  className = 'launcher-secondary',
}: LocalClipboardCopyButtonProps) {
  const [copyState, setCopyState] = useState<LocalClipboardCopyState>('idle')
  const generationRef = useRef(0)

  useEffect(() => {
    generationRef.current += 1
    setCopyState('idle')
  }, [text])

  useEffect(() => () => {
    generationRef.current += 1
  }, [])

  async function handleCopy() {
    const generation = ++generationRef.current
    const result = await writeLocalClipboardText(text, {
      timeoutMs: EXPRESSION_CLIPBOARD_TIMEOUT_MS,
      signal: {
        generation,
        current: () => generationRef.current,
      },
    })
    if (generation !== generationRef.current) return
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
    <div className="launcher-expression-local-copy">
      <button
        aria-label={ariaLabel}
        className={className}
        onClick={() => void handleCopy()}
        type="button"
      >
        <Copy aria-hidden="true" size={14} />
        {label}
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
