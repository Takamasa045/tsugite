import { Check } from 'lucide-react'

import { ExpressionPreview } from './ExpressionPreview'
import { LocalClipboardCopyButton } from './LocalClipboardCopyButton'
import {
  capabilityLabel,
  expressionSelectionHint,
  expressionStatusLabel,
  formatExpressionItemPrompt,
  previewFidelityLabel,
  type ExpressionItem,
  type ExpressionSelection,
} from './expressionLibraryModel'
import type { RecommendationResult } from './expressionRecommendation'

export interface ExpressionRecommendationsProps {
  recommendation: RecommendationResult
  selections: readonly ExpressionSelection[]
  onSelect: (item: ExpressionItem, reason: string) => void
}

export function ExpressionRecommendations({
  recommendation,
  selections,
  onSelect,
}: ExpressionRecommendationsProps) {
  return (
    <section aria-label="絞り込んだ候補" className="launcher-expression-recommendations" role="region">
      <div className="launcher-expression-section-heading">
        <h3>絞り込んだ候補</h3>
        <p>
          1〜3件は見比べ用の提案です。コピー候補に入るのは下のトレイで追加したものだけです。
          全体構成1件と補助表現最大2件は組み合わせできます。各カードから単体のプロンプトもコピーできます。
        </p>
      </div>
      {recommendation.clarification && (
        <p className="launcher-expression-state" role="status">{recommendation.clarification}</p>
      )}
      <ul className="launcher-expression-recommend-list">
        {recommendation.recommendations.map((entry) => {
          const selected = selections.some((item) => item.key === entry.item.key)
          return (
            <li className="launcher-expression-card" key={`rec-${entry.item.key}`}>
              <ExpressionPreview item={entry.item} listContextLabel="絞り込んだ候補" />
              <div className="launcher-expression-card-body">
                <div className="launcher-expression-card-topline">
                  <strong>{entry.item.title}</strong>
                  <span className="launcher-expression-badge" data-kind="status">
                    {expressionStatusLabel(entry.item)}
                  </span>
                  <small>{entry.band === 'recommend' ? '提案' : '参考候補'}</small>
                  <small>{entry.score}点</small>
                </div>
                <p>{entry.item.description || '説明なし'}</p>
                <p className="launcher-expression-destination">
                  {expressionSelectionHint(entry.item)}
                </p>
                <ul className="launcher-expression-reasons">
                  {entry.reasons.map((reason) => <li key={reason}>合う理由: {reason}</li>)}
                  {entry.cautions.map((caution) => <li key={caution}>注意: {caution}</li>)}
                </ul>
                <div className="launcher-expression-card-meta">
                  <span className="launcher-expression-badge" data-kind="fidelity">
                    {previewFidelityLabel(entry.previewFidelity)}
                  </span>
                  <span className="launcher-expression-badge" data-kind="capability">
                    {capabilityLabel(entry.item.capability)}
                  </span>
                </div>
                <div className="launcher-expression-card-actions">
                  <button
                    aria-label={selected
                      ? `絞り込んだ候補の${entry.item.title}は選択中`
                      : `絞り込んだ候補の${entry.item.title}をコピー候補に追加`}
                    aria-disabled={selected || undefined}
                    className="launcher-secondary"
                    onClick={() => {
                      // Soft-disable while selected so Chromium keeps focus on this control.
                      if (selected) return
                      onSelect(entry.item, entry.reasons[0] ?? '候補一致')
                    }}
                    type="button"
                  >
                    {selected ? (
                      <><Check aria-hidden="true" size={14} />選択中</>
                    ) : 'コピー候補に追加'}
                  </button>
                  <LocalClipboardCopyButton
                    ariaLabel={`絞り込んだ候補の${entry.item.title}のプロンプトをコピー`}
                    text={formatExpressionItemPrompt(entry.item)}
                  />
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
