import { RefreshCw } from 'lucide-react'

import type { HyperframesCatalogLoadState } from '../template/hyperframesCatalogModel'
import { ExpressionCard } from './ExpressionCard'
import {
  EXPRESSION_PAGE_SIZE,
  expressionGroupDescription,
  expressionGroupHeading,
  type ExpressionItem,
  type ExpressionSelection,
} from './expressionLibraryModel'

export interface ReferenceExpressionGroupProps {
  catalogState: HyperframesCatalogLoadState
  catalogError: string | null
  catalogWarning: string | null
  hasLoadedCatalog: boolean
  catalogItemCount: number
  referenceExpressions: readonly ExpressionItem[]
  visibleItems: readonly ExpressionItem[]
  visibleCount: number
  selections: readonly ExpressionSelection[]
  onSelect: (item: ExpressionItem, reason: string) => void
  onLoadCatalog: (options?: { keepPrevious?: boolean }) => void
  onShowMore: () => void
}

/**
 * Persistent catalog action control: same button DOM across idle/loading/error/ready
 * so keyboard focus does not fall to body when status text swaps.
 *
 * Loading / final-page use aria-disabled (not native disabled) so Chromium keeps
 * focus on this control; onClick is guarded against re-entry side effects.
 */
function catalogActionLabel(input: {
  catalogState: HyperframesCatalogLoadState
  hasLoadedCatalog: boolean
  catalogError: string | null
}): string {
  if (input.catalogState === 'loading') {
    return '参考表現を読み込んでいます…'
  }
  // Successful ready (no error): reload control. Error / idle / failed-reload: load label.
  if (input.hasLoadedCatalog && !input.catalogError) {
    return '参考一覧を再読み込み（外部通信あり）'
  }
  return 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）'
}

export function ReferenceExpressionGroup({
  catalogState,
  catalogError,
  catalogWarning,
  hasLoadedCatalog,
  catalogItemCount,
  referenceExpressions,
  visibleItems,
  visibleCount,
  selections,
  onSelect,
  onLoadCatalog,
  onShowMore,
}: ReferenceExpressionGroupProps) {
  const isLoading = catalogState === 'loading'
  const actionLabel = catalogActionLabel({ catalogState, hasLoadedCatalog, catalogError })
  // During loading, hide old grid/pagination so keyboard/pointer cannot land on
  // cards that will unmount or reset (12-item page) when reload succeeds.
  // Items stay in parent state for keepPrevious failure restore.
  const showCatalogResults = !isLoading
  const showPaginationControl =
    showCatalogResults && referenceExpressions.length > EXPRESSION_PAGE_SIZE
  const allVisible = visibleCount >= referenceExpressions.length

  return (
    <section
      aria-label={expressionGroupHeading('reference-catalog')}
      className="launcher-expression-group"
      role="region"
    >
      <div className="launcher-expression-section-heading">
        <div>
          <h3>{expressionGroupHeading('reference-catalog')}</h3>
          <p>{expressionGroupDescription('reference-catalog')}</p>
        </div>
        {/* Persistent catalog control lives here for all states (same DOM node). */}
        <button
          aria-busy={isLoading || undefined}
          aria-disabled={isLoading || undefined}
          className={hasLoadedCatalog && !catalogError ? 'launcher-secondary' : 'launcher-primary'}
          onClick={() => {
            if (isLoading) return
            onLoadCatalog({ keepPrevious: catalogItemCount > 0 })
          }}
          type="button"
        >
          <RefreshCw
            aria-hidden="true"
            className={isLoading ? 'is-spinning' : undefined}
            size={14}
          />
          {actionLabel}
        </button>
      </div>
      {!hasLoadedCatalog && catalogState === 'idle' && (
        <div className="launcher-expression-state">
          <p>
            アイデア用の参考一覧はまだ読み込んでいません。
            ボタンを押すと公式カタログへ外部通信します。閲覧だけでは制作依頼に入りません。
          </p>
        </div>
      )}
      {isLoading && (
        <p className="launcher-expression-state" role="status">
          参考一覧を読み込んでいます。完了するまで前回のカード操作はできません。
        </p>
      )}
      {catalogError && (
        <div className="launcher-expression-state is-error" role="alert">
          <strong>{catalogError}</strong>
        </div>
      )}
      {catalogWarning && catalogState === 'ready' && (
        <p className="launcher-expression-state" role="status">{catalogWarning}</p>
      )}
      {catalogState === 'ready' && referenceExpressions.length === 0 && hasLoadedCatalog && (
        <p className="launcher-expression-state" role="status">条件に合う参考表現はありません。</p>
      )}
      {showCatalogResults && (
        <ul className="launcher-expression-grid">
          {visibleItems.map((item) => (
            <ExpressionCard
              key={item.key}
              item={item}
              listContext="一覧"
              selected={selections.some((entry) => entry.key === item.key)}
              selectReason="アイデア参考として明示選択"
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
      {showPaginationControl && (
        <button
          aria-disabled={allVisible || undefined}
          className="launcher-secondary"
          onClick={() => {
            if (allVisible) return
            onShowMore()
          }}
          type="button"
        >
          {allVisible ? 'すべて表示しました' : '参考表現をさらに表示'}
        </button>
      )}
    </section>
  )
}
