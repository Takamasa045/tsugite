import { useLayoutEffect, useRef } from 'react'

import { ExpressionFreeformExport } from './ExpressionFreeformExport'
import {
  EXPRESSION_SELECTION_COMBINE_NOTE,
  EXPRESSION_SELECTION_LIMITS,
  capabilityLabel,
  expressionDestinationLabel,
  expressionRoleLabel,
  selectionModeLabel,
  type ExpressionSelection,
  type ExpressionSelectionMode,
} from './expressionLibraryModel'

export interface ExpressionSelectionTrayProps {
  selections: readonly ExpressionSelection[]
  selectionMode: ExpressionSelectionMode
  freeformExportText: string
  onRemove: (key: string, title: string) => void
  onStatusMessage: (message: string) => void
  onReturnToTemplate?: () => void
}

export function ExpressionSelectionTray({
  selections,
  selectionMode,
  freeformExportText,
  onRemove,
  onStatusMessage,
  onReturnToTemplate,
}: ExpressionSelectionTrayProps) {
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const emptyStateRef = useRef<HTMLParagraphElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  /** After remove, focus the same-index next 外す, previous if last, or empty/heading. */
  const pendingRemoveFocusIndexRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    const pending = pendingRemoveFocusIndexRef.current
    if (pending === null) return
    pendingRemoveFocusIndexRef.current = null

    if (selections.length === 0) {
      // Last item removed: allow browser scroll so the target is visible after a tall
      // (max-length) tray item. Prefer empty state at the list position; heading is fallback.
      const empty = emptyStateRef.current
      if (empty) {
        empty.focus()
        return
      }
      headingRef.current?.focus()
      return
    }

    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>(
      'button[data-expression-remove="true"]',
    )
    if (!buttons || buttons.length === 0) {
      // Unexpected empty list UI: allow scroll to heading.
      headingRef.current?.focus()
      return
    }
    const index = Math.min(Math.max(pending, 0), buttons.length - 1)
    // Next/previous 外す stays near the previous control — suppress scroll jump.
    buttons[index]?.focus({ preventScroll: true })
  }, [selections])

  function handleRemove(key: string, title: string, index: number) {
    // Same position next item after delete; last item → previous.
    const nextFocusIndex = index < selections.length - 1 ? index : index - 1
    pendingRemoveFocusIndexRef.current = nextFocusIndex
    onRemove(key, title)
  }

  return (
    <aside aria-label="コピー候補" className="launcher-expression-tray" role="complementary">
      <div className="launcher-expression-section-heading">
        <h3 ref={headingRef} tabIndex={-1}>コピー候補</h3>
        <p>
          最大{EXPRESSION_SELECTION_LIMITS.maxTotal}件
          （全体構成{EXPRESSION_SELECTION_LIMITS.maxFullComposition}・補助
          {EXPRESSION_SELECTION_LIMITS.maxAuxiliary}）。
          {EXPRESSION_SELECTION_COMBINE_NOTE}
          制作依頼本文へは自動では入りません。
        </p>
      </div>
      <p className="launcher-expression-tray-mode" role="status">
        状態: {selectionModeLabel(selectionMode)}
      </p>
      {selections.length === 0 ? (
        <p
          ref={emptyStateRef}
          className="launcher-expression-state"
          tabIndex={-1}
        >
          まだ選んでいません。追加したものだけがコピー候補に入り、まとめてプロンプトをコピーできます。
        </p>
      ) : (
        <ul className="launcher-expression-tray-list" ref={listRef}>
          {selections.map((selection, index) => (
            <li key={selection.key}>
              <div className="launcher-expression-tray-item-copy">
                <strong>{selection.title}</strong>
                <small>{expressionRoleLabel(selection.role)}</small>
                <small>{selection.provider} / {selection.nativeId}</small>
                <small>{capabilityLabel(selection.capability)}</small>
                <small>{expressionDestinationLabel(selection)}</small>
              </div>
              <button
                aria-label={`${selection.title}を外す`}
                className="launcher-secondary"
                data-expression-remove="true"
                onClick={() => handleRemove(selection.key, selection.title, index)}
                type="button"
              >
                外す
              </button>
            </li>
          ))}
        </ul>
      )}
      <ExpressionFreeformExport
        exportText={freeformExportText}
        onStatusMessage={onStatusMessage}
      />
      {onReturnToTemplate ? (
        <button className="launcher-primary" onClick={onReturnToTemplate} type="button">
          コピー候補を保持してテンプレートへ戻る
        </button>
      ) : null}
    </aside>
  )
}
