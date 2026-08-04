import { RefreshCw } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'

import type { PresentationPresetLoadState } from '../template/presentationPresetModel'
import { ownsRetryFocusHandoff } from '../template/retryFocusHandoff'
import { ExpressionCard } from './ExpressionCard'
import {
  EXPRESSION_PAGE_SIZE,
  expressionGroupDescription,
  expressionGroupHeading,
  type ExpressionItem,
  type ExpressionSelection,
} from './expressionLibraryModel'

export interface ExecutableExpressionGroupProps {
  presentationPresetLoadState: PresentationPresetLoadState
  presentationPresetNotice?: string | null
  onRetryPresentationPresets?: () => void
  executableCandidates: readonly ExpressionItem[]
  visibleItems: readonly ExpressionItem[]
  visibleCount: number
  selections: readonly ExpressionSelection[]
  onSelect: (item: ExpressionItem, reason: string) => void
  onShowMore: () => void
}

/**
 * Keep the retry control mounted across error → loading so keyboard focus does not
 * fall to body when the parent swaps load state. Initial loading stays message-only.
 */
export function ExecutableExpressionGroup({
  presentationPresetLoadState,
  presentationPresetNotice = null,
  onRetryPresentationPresets,
  executableCandidates,
  visibleItems,
  visibleCount,
  selections,
  onSelect,
  onShowMore,
}: ExecutableExpressionGroupProps) {
  const showPaginationControl = executableCandidates.length > EXPRESSION_PAGE_SIZE
  const allVisible = visibleCount >= executableCandidates.length
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const retryButtonRef = useRef<HTMLButtonElement | null>(null)
  const prevLoadStateRef = useRef(presentationPresetLoadState)
  /** True only after the user starts retry; not the same as retrySurfaceActive. */
  const retryHandoffPendingRef = useRef(false)
  /** True from first error until ready/idle — keeps retry DOM through loading. */
  const [retrySurfaceActive, setRetrySurfaceActive] = useState(
    () => presentationPresetLoadState === 'error',
  )

  const isLoading = presentationPresetLoadState === 'loading'
  const isError = presentationPresetLoadState === 'error'
  const showRetryControl =
    Boolean(onRetryPresentationPresets)
    && (isError || (isLoading && retrySurfaceActive))

  useLayoutEffect(() => {
    const prev = prevLoadStateRef.current
    prevLoadStateRef.current = presentationPresetLoadState

    if (presentationPresetLoadState === 'error') {
      setRetrySurfaceActive(true)
      // Re-failure after loading: restore only if retry still owns focus.
      if (prev === 'loading') {
        if (
          retryHandoffPendingRef.current
          && ownsRetryFocusHandoff(retryButtonRef.current)
        ) {
          retryButtonRef.current?.focus({ preventScroll: true })
        } else {
          retryHandoffPendingRef.current = false
        }
      }
      return
    }

    if (presentationPresetLoadState === 'ready') {
      const pending = retryHandoffPendingRef.current
      const shouldHandoff = pending
        && (prev === 'loading' || prev === 'error')
        && ownsRetryFocusHandoff(retryButtonRef.current)
      retryHandoffPendingRef.current = false
      if (retrySurfaceActive) setRetrySurfaceActive(false)
      if (shouldHandoff) {
        // Owned success handoff: allow browser scroll into view (new DOM may be off-screen).
        // Re-error restore keeps preventScroll so the same retry control does not jump.
        const section = headingRef.current?.closest('section')
        const firstAdd = section?.querySelector<HTMLButtonElement>(
          'button[aria-label*="コピー候補に追加"]:not([disabled])',
        )
        if (firstAdd) {
          firstAdd.focus()
        } else {
          headingRef.current?.focus()
        }
      }
      return
    }

    if (presentationPresetLoadState === 'idle') {
      retryHandoffPendingRef.current = false
      setRetrySurfaceActive(false)
    }
  }, [presentationPresetLoadState, retrySurfaceActive])

  return (
    <section
      aria-label={expressionGroupHeading('presentation-preset')}
      className="launcher-expression-group"
      role="region"
    >
      <div className="launcher-expression-section-heading">
        <h3 ref={headingRef} tabIndex={-1}>
          {expressionGroupHeading('presentation-preset')}
        </h3>
        <p>{expressionGroupDescription('presentation-preset')}</p>
      </div>
      {/* Initial load only — no action control (avoids accidental retry UX). */}
      {isLoading && !retrySurfaceActive && (
        <div aria-busy="true" aria-live="polite" className="launcher-expression-state">
          <RefreshCw aria-hidden="true" className="is-spinning" size={16} />
          <strong>この環境の仕上げ候補を読み込んでいます…</strong>
        </div>
      )}
      {showRetryControl && (
        <div
          className={isError ? 'launcher-expression-state is-error' : 'launcher-expression-state'}
          role={isError ? 'alert' : undefined}
          aria-busy={isLoading || undefined}
          aria-live={isLoading ? 'polite' : undefined}
        >
          {isError && (
            <strong>この環境の仕上げ候補を読み込めませんでした。</strong>
          )}
          {isLoading && (
            <strong>この環境の仕上げ候補を読み込んでいます…</strong>
          )}
          {onRetryPresentationPresets && (
            <button
              ref={retryButtonRef}
              aria-busy={isLoading || undefined}
              aria-disabled={isLoading || undefined}
              className="launcher-secondary"
              onClick={() => {
                // Soft-disable: keep focus on this node (native disabled drops to body in Chromium).
                if (isLoading) return
                retryHandoffPendingRef.current = true
                onRetryPresentationPresets()
              }}
              type="button"
            >
              <RefreshCw
                aria-hidden="true"
                className={isLoading ? 'is-spinning' : undefined}
                size={14}
              />
              {isLoading
                ? '読み込んでいます…'
                : 'もう一度読み込む'}
            </button>
          )}
        </div>
      )}
      {presentationPresetNotice && presentationPresetLoadState === 'ready' && (
        <p className="launcher-expression-state" role="status">{presentationPresetNotice}</p>
      )}
      {presentationPresetLoadState === 'ready' && executableCandidates.length === 0 && (
        <p className="launcher-expression-state" role="status">
          表示できる仕上げ候補はありません。
        </p>
      )}
      <ul className="launcher-expression-grid">
        {visibleItems.map((item) => (
          <ExpressionCard
            key={item.key}
            item={item}
            listContext="一覧"
            selected={selections.some((entry) => entry.key === item.key)}
            selectReason="この環境の仕上げ候補として明示選択"
            onSelect={onSelect}
          />
        ))}
      </ul>
      {showPaginationControl && (
        <button
          aria-disabled={allVisible || undefined}
          className="launcher-secondary"
          onClick={() => {
            // Final page stays focusable (aria-disabled, not native disabled) so Chromium
            // does not drop keyboard focus to body after the last expand click.
            if (allVisible) return
            onShowMore()
          }}
          type="button"
        >
          {allVisible ? 'すべて表示しました' : '仕上げをさらに表示'}
        </button>
      )}
    </section>
  )
}
