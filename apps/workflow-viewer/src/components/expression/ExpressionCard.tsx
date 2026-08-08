import { Check } from 'lucide-react'
import { memo } from 'react'

import { ExpressionPreview } from './ExpressionPreview'
import { LocalClipboardCopyButton } from './LocalClipboardCopyButton'
import {
  capabilityLabel,
  expressionDisplayTags,
  expressionSelectionHint,
  expressionStatusLabel,
  formatExpressionItemPrompt,
  isFullCompositionRole,
  previewFidelityLabel,
  type ExpressionItem,
} from './expressionLibraryModel'

export interface ExpressionCardProps {
  item: ExpressionItem
  selected: boolean
  onSelect: (item: ExpressionItem, reason: string) => void
  selectReason: string
  listContext: string
}

export const ExpressionCard = memo(function ExpressionCard({
  item,
  selected,
  onSelect,
  selectReason,
  listContext,
}: ExpressionCardProps) {
  const promptText = formatExpressionItemPrompt(item)

  return (
    <li className="launcher-expression-card" data-selected={selected || undefined}>
      <ExpressionPreview item={item} listContextLabel={listContext} />
      <div className="launcher-expression-card-body">
        <div className="launcher-expression-card-topline">
          <strong>{item.title}</strong>
          <span className="launcher-expression-badge" data-kind="status">
            {expressionStatusLabel(item)}
          </span>
          <small>{item.category}</small>
          {item.brandLock && <small>ブランド固定</small>}
        </div>
        <p>{item.description || '説明なし'}</p>
        <p className="launcher-expression-destination">
          {expressionSelectionHint(item)}
        </p>
        <div className="launcher-expression-card-meta">
          <span className="launcher-expression-badge" data-kind="fidelity">
            {previewFidelityLabel(item.previewFidelity)}
          </span>
          <span className="launcher-expression-badge" data-kind="capability">
            {capabilityLabel(item.capability)}
          </span>
          <span className="launcher-expression-badge" data-kind="destination">
            {isFullCompositionRole(item.role) ? 'コピー候補: 全体構成' : 'コピー候補: 補助表現'}
          </span>
        </div>
        <div className="launcher-expression-tags">
          {expressionDisplayTags(item.tags).slice(0, 4).map((tag) => (
            <span key={`${item.key}-${tag}`}>{tag}</span>
          ))}
        </div>
        <div className="launcher-expression-card-actions">
          <button
            aria-label={selected
              ? `${listContext}の${item.title}は選択中`
              : `${listContext}の${item.title}をコピー候補に追加`}
            aria-disabled={selected || undefined}
            className="launcher-secondary"
            onClick={() => {
              // Soft-disable while selected so Chromium keeps focus on this control.
              if (selected) return
              onSelect(item, selectReason)
            }}
            type="button"
          >
            {selected ? (
              <><Check aria-hidden="true" size={14} />選択中</>
            ) : 'コピー候補に追加'}
          </button>
          <LocalClipboardCopyButton
            ariaLabel={`${listContext}の${item.title}のプロンプトをコピー`}
            text={promptText}
          />
        </div>
      </div>
    </li>
  )
})
