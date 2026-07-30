import { ArrowLeft, Check, RefreshCw, Search, Sparkles } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import {
  HYPERFRAMES_CATALOG_ENDPOINT,
  isHyperframesCatalogSuccess,
  type HyperframesCatalogItem,
  type HyperframesCatalogLoadState,
} from '../template/hyperframesCatalogModel'
import type { PresentationPresetLoadState, PresentationPresetOption } from '../template/presentationPresetModel'
import { ExpressionPreview } from './ExpressionPreview'
import {
  EXPRESSION_PAGE_SIZE,
  EXPRESSION_SELECTION_COMBINE_NOTE,
  EXPRESSION_SELECTION_LIMITS,
  capabilityLabel,
  expressionRoleLabel,
  filterExpressionItems,
  INITIAL_EXPRESSION_FILTERS,
  isFullCompositionRole,
  normalizeHyperframesCatalogItem,
  normalizePresentationPreset,
  pageExpressionItems,
  partitionExpressionItems,
  previewFidelityLabel,
  removeExpressionSelection,
  selectionModeLabel,
  toExpressionSelection,
  tryAddExpressionSelection,
  type ExpressionFilters,
  type ExpressionItem,
  type ExpressionSelection,
  type ExpressionSelectionMode,
  type RecommendationIntentSeed,
} from './expressionLibraryModel'
import {
  recommendExpressions,
  type RecommendationIntent,
  type RecommendationResult,
} from './expressionRecommendation'

export interface ExpressionShelfProps {
  fetcher?: typeof fetch
  token?: string
  presentationPresets?: readonly PresentationPresetOption[]
  presentationPresetLoadState?: PresentationPresetLoadState
  onRetryPresentationPresets?: () => void
  presentationPresetNotice?: string | null
  selections: readonly ExpressionSelection[]
  selectionMode: ExpressionSelectionMode
  onSelectionsChange: (next: {
    selections: ExpressionSelection[]
    mode: ExpressionSelectionMode
  }) => void
  /** When opening from a template, seed the free-text intent once. */
  intentSeed?: RecommendationIntentSeed | null
  onClearIntentSeed?: () => void
  onReturnToTemplate?: () => void
  returnLabel?: string
}

type BrowseMode = 'all' | 'executable' | 'reference'

/** 棚タブ unmount 後も同一セッションで再取得しない（provider 再取得禁止） */
const catalogSessionCache: {
  items: HyperframesCatalogItem[]
  warnings: string[]
  ready: boolean
} = {
  items: [],
  warnings: [],
  ready: false,
}

/** テスト隔離用。本番 UI からは呼ばない。 */
export function resetExpressionCatalogSessionCacheForTests(): void {
  catalogSessionCache.items = []
  catalogSessionCache.warnings = []
  catalogSessionCache.ready = false
}

export function ExpressionShelf({
  fetcher = fetch,
  token = '',
  presentationPresets = [],
  presentationPresetLoadState = 'idle',
  onRetryPresentationPresets,
  presentationPresetNotice = null,
  selections,
  selectionMode,
  onSelectionsChange,
  intentSeed = null,
  onClearIntentSeed,
  onReturnToTemplate,
  returnLabel = 'テンプレートへ戻る',
}: ExpressionShelfProps) {
  const headingId = useId()
  const freeTextId = useId()
  const aspectId = useId()
  const purposeId = useId()
  const readinessId = useId()
  const searchId = useId()

  const [catalogState, setCatalogState] = useState<HyperframesCatalogLoadState>(
    catalogSessionCache.ready ? 'ready' : 'idle',
  )
  const [catalogItems, setCatalogItems] = useState<HyperframesCatalogItem[]>(
    () => catalogSessionCache.items,
  )
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [catalogWarning, setCatalogWarning] = useState<string | null>(
    () => (catalogSessionCache.warnings.length > 0
      ? `一部の項目を省略しました（${catalogSessionCache.warnings.length}件の注意）。`
      : null),
  )
  const [hasLoadedCatalog, setHasLoadedCatalog] = useState(catalogSessionCache.ready)
  const catalogItemsRef = useRef(catalogItems)
  catalogItemsRef.current = catalogItems

  const [freeText, setFreeText] = useState(intentSeed?.freeText ?? '')
  const [aspect, setAspect] = useState<RecommendationIntent['aspect']>(intentSeed?.aspect ?? 'any')
  const [purpose, setPurpose] = useState(intentSeed?.purpose ?? '')
  const [readiness, setReadiness] = useState<RecommendationIntent['readiness']>(
    intentSeed?.readiness ?? 'explore',
  )
  const [reducedMotion, setReducedMotion] = useState(false)
  const [recommendation, setRecommendation] = useState<RecommendationResult | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [filters, setFilters] = useState<ExpressionFilters>(INITIAL_EXPRESSION_FILTERS)
  const [browseMode, setBrowseMode] = useState<BrowseMode>('all')
  const [visibleExecutable, setVisibleExecutable] = useState(EXPRESSION_PAGE_SIZE)
  const [visibleReference, setVisibleReference] = useState(EXPRESSION_PAGE_SIZE)
  const seededRef = useRef(false)

  useEffect(() => {
    if (!intentSeed || seededRef.current) return
    seededRef.current = true
    setFreeText(intentSeed.freeText)
    setAspect(intentSeed.aspect ?? 'any')
    setPurpose(intentSeed.purpose ?? '')
    setReadiness(intentSeed.readiness ?? 'explore')
    onClearIntentSeed?.()
  }, [intentSeed, onClearIntentSeed])

  const loadCatalog = async ({ keepPrevious = false }: { keepPrevious?: boolean } = {}) => {
    setCatalogState('loading')
    setCatalogError(null)
    setCatalogWarning(null)
    setStatusMessage('参考表現を読み込んでいます…')
    try {
      const response = await fetcher(HYPERFRAMES_CATALOG_ENDPOINT, {
        headers: {
          accept: 'application/json',
          'x-tsugite-token': token,
        },
      })
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        throw new Error('invalid catalog')
      }
      if (!response.ok || !isHyperframesCatalogSuccess(payload)) {
        throw new Error('invalid catalog')
      }
      setCatalogItems(payload.items)
      catalogSessionCache.items = payload.items
      catalogSessionCache.warnings = payload.warnings
      catalogSessionCache.ready = true
      setCatalogState('ready')
      setHasLoadedCatalog(true)
      setVisibleReference(EXPRESSION_PAGE_SIZE)
      setStatusMessage(`${payload.items.length}件の参考表現を表示できます。`)
      if (payload.warnings.length > 0) {
        setCatalogWarning(`一部の項目を省略しました（${payload.warnings.length}件の注意）。`)
      }
    } catch {
      if (!keepPrevious || catalogItemsRef.current.length === 0) {
        setCatalogState('error')
        setCatalogError('参考表現を読み込めませんでした。実行候補と制作依頼はそのまま使えます。')
        setStatusMessage('参考表現を読み込めませんでした。')
        return
      }
      setCatalogState('ready')
      setCatalogError('再読み込みに失敗しました。前回の一覧を表示しています。')
      setStatusMessage('再読み込みに失敗したため、前回の一覧を表示しています。')
    }
  }

  // HyperFrames 公式 catalog は外部 registry 通信があるため、明示ボタンでのみ取得する

  const executableItems = useMemo(
    () => presentationPresets.map(normalizePresentationPreset),
    [presentationPresets],
  )
  const referenceItems = useMemo(
    () => catalogItems.map(normalizeHyperframesCatalogItem),
    [catalogItems],
  )
  const allItems = useMemo(
    () => [...executableItems, ...referenceItems],
    [executableItems, referenceItems],
  )

  const activeFilters: ExpressionFilters = {
    ...filters,
    group: browseMode === 'all' ? filters.group : browseMode === 'executable' ? 'executable' : 'reference',
  }

  const filteredAll = useMemo(
    () => filterExpressionItems(allItems, activeFilters),
    [activeFilters, allItems],
  )
  const { executableCandidates, referenceExpressions } = useMemo(
    () => partitionExpressionItems(filteredAll),
    [filteredAll],
  )
  const visibleExecutableItems = useMemo(
    () => pageExpressionItems(executableCandidates, visibleExecutable),
    [executableCandidates, visibleExecutable],
  )
  const visibleReferenceItems = useMemo(
    () => pageExpressionItems(referenceExpressions, visibleReference),
    [referenceExpressions, visibleReference],
  )

  function runRecommendation() {
    const intent: RecommendationIntent = {
      freeText,
      aspect: aspect ?? 'any',
      purpose: purpose || null,
      readiness: readiness ?? 'explore',
      reducedMotion,
      brandFixed: false,
      avoid: [],
    }
    const result = recommendExpressions(allItems, intent)
    setRecommendation(result)
    setStatusMessage(
      result.recommendations.length > 0
        ? `おすすめ ${result.recommendations.length}件を表示しました。`
        : result.clarification ?? '条件に合う候補がありません。',
    )
  }

  function handleSelect(item: ExpressionItem, reason: string) {
    const result = tryAddExpressionSelection(selections, toExpressionSelection(item, reason))
    if (!result.ok) {
      setStatusMessage(result.reason)
      return
    }
    onSelectionsChange({ selections: result.selections, mode: 'explicit' })
    const roleNote = isFullCompositionRole(item.role)
      ? '全体構成として追加（補助表現と組み合わせ可）'
      : '補助表現として追加（全体構成と組み合わせ可）'
    setStatusMessage(`${item.title} を制作依頼候補に追加しました（${roleNote}）`)
  }

  function handleRemove(key: string) {
    const next = removeExpressionSelection(selections, key)
    onSelectionsChange({
      selections: next,
      mode: next.length === 0 ? 'unset' : 'explicit',
    })
    setStatusMessage('候補を外しました')
  }

  function updateFilter<K extends keyof ExpressionFilters>(key: K, value: ExpressionFilters[K]) {
    setFilters((current) => ({ ...current, [key]: value }))
    setVisibleExecutable(EXPRESSION_PAGE_SIZE)
    setVisibleReference(EXPRESSION_PAGE_SIZE)
  }

  return (
    <section
      aria-labelledby="launcher-expressions-tab"
      className="launcher-expression-shelf"
      id="launcher-expressions-panel"
      role="tabpanel"
    >
      <header className="launcher-expression-heading">
        <div>
          <span className="eyebrow">表現の棚</span>
          <h2 id={headingId}>動きの見本札から選ぶ</h2>
          <p>
            テンプレートを使わない自由制作でも使えます。実行候補（未検証）と参考表現は分けて表示します。
            生成・install・render・Gate更新はしません。
          </p>
        </div>
        <div className="launcher-expression-heading-meta">
          <span className="launcher-count">
            実行候補（未検証） {executableItems.length}件 / 参考 {referenceItems.length}件
          </span>
          {onReturnToTemplate && (
            <button className="launcher-secondary" onClick={onReturnToTemplate} type="button">
              <ArrowLeft aria-hidden="true" size={16} />
              {returnLabel}
            </button>
          )}
        </div>
      </header>

      <section aria-label="どんな動画を作りたいか" className="launcher-expression-intent" role="region">
        <label className="launcher-expression-intent-free" htmlFor={freeTextId}>
          <span>どんな動画を作りたいですか</span>
          <textarea
            id={freeTextId}
            onChange={(event) => setFreeText(event.target.value)}
            placeholder="例: 記事を会話でわかりやすく解説する横型60秒"
            rows={2}
            value={freeText}
          />
        </label>
        <div className="launcher-expression-intent-grid">
          <label htmlFor={aspectId}>
            <span>比率</span>
            <select
              id={aspectId}
              onChange={(event) => setAspect(event.target.value as RecommendationIntent['aspect'])}
              value={aspect ?? 'any'}
            >
              <option value="any">指定なし</option>
              <option value="16:9">16:9 横型</option>
              <option value="9:16">9:16 縦型</option>
            </select>
          </label>
          <label htmlFor={purposeId}>
            <span>目的</span>
            <select
              id={purposeId}
              onChange={(event) => setPurpose(event.target.value)}
              value={purpose}
            >
              <option value="">指定なし</option>
              <option value="explainer">解説</option>
              <option value="dialogue">会話</option>
              <option value="promo">告知・募集</option>
              <option value="showreel">ダイジェスト</option>
              <option value="data">データ</option>
              <option value="dev">開発・コード</option>
              <option value="social">SNS・配信</option>
            </select>
          </label>
          <label htmlFor={readinessId}>
            <span>準備段階</span>
            <select
              id={readinessId}
              onChange={(event) => setReadiness(event.target.value as RecommendationIntent['readiness'])}
              value={readiness ?? 'explore'}
            >
              <option value="explore">参考から探す</option>
              <option value="ready">実行候補（未検証）</option>
            </select>
          </label>
          <label className="launcher-expression-check">
            <input
              checked={reducedMotion}
              onChange={(event) => setReducedMotion(event.target.checked)}
              type="checkbox"
            />
            <span>動きを抑える</span>
          </label>
        </div>
        <button className="launcher-primary" onClick={runRecommendation} type="button">
          <Sparkles aria-hidden="true" size={16} />
          ローカルでおすすめを出す
        </button>
        <p className="launcher-expression-intent-note">
          外部AI通信は使いません。用意済みの日本語・英語の語彙表と表現一覧の情報だけで、毎回同じ結果になるように採点します。
        </p>
      </section>

      {recommendation && (
        <section aria-label="おすすめ候補" className="launcher-expression-recommendations" role="region">
          <div className="launcher-expression-section-heading">
            <h3>おすすめ候補</h3>
            <p>
              1〜3件は見比べ用の代替提案です。制作依頼へ入れる候補は下のトレイで明示選択してください。
              全体構成1件と補助表現最大2件は組み合わせできます。
            </p>
          </div>
          {recommendation.clarification && recommendation.recommendations.length === 0 && (
            <p className="launcher-expression-state" role="status">{recommendation.clarification}</p>
          )}
          <ul className="launcher-expression-recommend-list">
            {recommendation.recommendations.map((entry) => {
              const selected = selections.some((item) => item.key === entry.item.key)
              return (
                <li className="launcher-expression-card" key={`rec-${entry.item.key}`}>
                  <ExpressionPreview item={entry.item} />
                  <div className="launcher-expression-card-body">
                    <div className="launcher-expression-card-topline">
                      <strong>{entry.item.title}</strong>
                      <small>{entry.band === 'recommend' ? '推薦' : '参考候補'}</small>
                      <small>{entry.score}点</small>
                    </div>
                    <p>{entry.item.description || '説明なし'}</p>
                    <ul className="launcher-expression-reasons">
                      {entry.reasons.map((reason) => <li key={reason}>合う理由: {reason}</li>)}
                      {entry.cautions.map((caution) => <li key={caution}>注意: {caution}</li>)}
                    </ul>
                    <div className="launcher-expression-card-meta">
                      <span>{capabilityLabel(entry.item.capability)}</span>
                      <span>{previewFidelityLabel(entry.previewFidelity)}</span>
                      <span>{entry.executable ? '実行可否: 候補' : '実行可否: 参考のみ'}</span>
                    </div>
                    <button
                      aria-pressed={selected}
                      className="launcher-secondary"
                      onClick={() => handleSelect(entry.item, entry.reasons[0] ?? 'おすすめ一致')}
                      type="button"
                    >
                      {selected ? (
                        <><Check aria-hidden="true" size={14} />選択中</>
                      ) : '制作依頼へ追加'}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <div className="launcher-expression-toolbar">
        <label className="launcher-expression-search" htmlFor={searchId}>
          <span>検索</span>
          <span className="launcher-expression-search-field">
            <Search aria-hidden="true" size={14} />
            <input
              id={searchId}
              onChange={(event) => updateFilter('query', event.target.value)}
              placeholder="名前・説明・タグ"
              type="search"
              value={filters.query}
            />
          </span>
        </label>
        <div aria-label="表示グループ" className="launcher-expression-group-toggle" role="group">
          {(
            [
              ['all', 'すべて'],
              ['executable', '実行候補（未検証）'],
              ['reference', '参考から探す'],
            ] as const
          ).map(([id, label]) => (
            <button
              aria-pressed={browseMode === id}
              key={id}
              onClick={() => {
                setBrowseMode(id)
                setVisibleExecutable(EXPRESSION_PAGE_SIZE)
                setVisibleReference(EXPRESSION_PAGE_SIZE)
              }}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {(browseMode === 'all' || browseMode === 'executable') && (
        <section aria-label="実行候補（未検証）" className="launcher-expression-group" role="region">
          <div className="launcher-expression-section-heading">
            <h3>実行候補（未検証）</h3>
            <p>Remotion / HyperFrames が宣言している仕上げ構成です。検証済みの実行保証ではありません。</p>
          </div>
          {presentationPresetLoadState === 'loading' && (
            <div aria-busy="true" aria-live="polite" className="launcher-expression-state">
              <RefreshCw aria-hidden="true" className="is-spinning" size={16} />
              <strong>実行候補（未検証）を読み込んでいます…</strong>
            </div>
          )}
          {presentationPresetLoadState === 'error' && (
            <div className="launcher-expression-state is-error" role="alert">
              <strong>実行候補（未検証）を読み込めませんでした。</strong>
              {onRetryPresentationPresets && (
                <button className="launcher-secondary" onClick={onRetryPresentationPresets} type="button">
                  <RefreshCw aria-hidden="true" size={14} />
                  もう一度読み込む
                </button>
              )}
            </div>
          )}
          {presentationPresetNotice && presentationPresetLoadState === 'ready' && (
            <p className="launcher-expression-state" role="status">{presentationPresetNotice}</p>
          )}
          {presentationPresetLoadState === 'ready' && executableCandidates.length === 0 && (
            <p className="launcher-expression-state" role="status">表示できる実行候補（未検証）はありません。</p>
          )}
          <ul className="launcher-expression-grid">
            {visibleExecutableItems.map((item) => (
              <ExpressionCard
                key={item.key}
                item={item}
                selected={selections.some((entry) => entry.key === item.key)}
                onSelect={() => handleSelect(item, '実行候補（未検証）として明示選択')}
              />
            ))}
          </ul>
          {visibleExecutable < executableCandidates.length && (
            <button
              className="launcher-secondary"
              onClick={() => setVisibleExecutable((count) => count + EXPRESSION_PAGE_SIZE)}
              type="button"
            >
              実行候補（未検証）をさらに表示
            </button>
          )}
        </section>
      )}

      {(browseMode === 'all' || browseMode === 'reference') && (
        <section aria-label="参考表現" className="launcher-expression-group" role="region">
          <div className="launcher-expression-section-heading">
            <div>
              <h3>参考表現（HyperFrames 公式 catalog）</h3>
              <p>
                実行候補（未検証）と混同しない参考一覧です。利用可能・導入済み・書き出し可能を保証しません。
                読み込み時のみ公式カタログへ外部通信します。実行候補（未検証）は通信なしで表示します。
              </p>
            </div>
            {hasLoadedCatalog && !catalogError && (
              <button
                className="launcher-secondary"
                disabled={catalogState === 'loading'}
                onClick={() => void loadCatalog({ keepPrevious: catalogItems.length > 0 })}
                type="button"
              >
                <RefreshCw
                  aria-hidden="true"
                  className={catalogState === 'loading' ? 'is-spinning' : undefined}
                  size={14}
                />
                参考一覧を再読み込み（外部通信あり）
              </button>
            )}
          </div>
          {!hasLoadedCatalog && catalogState === 'idle' && (
            <div className="launcher-expression-state">
              <p>
                HyperFrames の参考一覧はまだ読み込んでいません。
                ボタンを押すと公式カタログへ外部通信します。
              </p>
              <button
                className="launcher-primary"
                onClick={() => void loadCatalog()}
                type="button"
              >
                HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）
              </button>
            </div>
          )}
          {catalogState === 'loading' && catalogItems.length === 0 && (
            <div aria-busy="true" aria-live="polite" className="launcher-expression-state">
              <RefreshCw aria-hidden="true" className="is-spinning" size={16} />
              <strong>参考表現を読み込んでいます…</strong>
            </div>
          )}
          {catalogError && (
            <div className="launcher-expression-state is-error" role="alert">
              <strong>{catalogError}</strong>
              <button
                className="launcher-secondary"
                onClick={() => void loadCatalog({ keepPrevious: catalogItems.length > 0 })}
                type="button"
              >
                HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）
              </button>
            </div>
          )}
          {catalogWarning && catalogState === 'ready' && (
            <p className="launcher-expression-state" role="status">{catalogWarning}</p>
          )}
          {catalogState === 'ready' && referenceExpressions.length === 0 && hasLoadedCatalog && (
            <p className="launcher-expression-state" role="status">条件に合う参考表現はありません。</p>
          )}
          <ul className="launcher-expression-grid">
            {visibleReferenceItems.map((item) => (
              <ExpressionCard
                key={item.key}
                item={item}
                selected={selections.some((entry) => entry.key === item.key)}
                onSelect={() => handleSelect(item, '参考表現として明示選択')}
              />
            ))}
          </ul>
          {visibleReference < referenceExpressions.length && (
            <button
              className="launcher-secondary"
              onClick={() => setVisibleReference((count) => count + EXPRESSION_PAGE_SIZE)}
              type="button"
            >
              参考表現をさらに表示
            </button>
          )}
        </section>
      )}

      <aside aria-label="選んだ候補" className="launcher-expression-tray" role="complementary">
        <div className="launcher-expression-section-heading">
          <h3>選んだ候補</h3>
          <p>
            最大{EXPRESSION_SELECTION_LIMITS.maxTotal}件
            （全体構成{EXPRESSION_SELECTION_LIMITS.maxFullComposition}・補助
            {EXPRESSION_SELECTION_LIMITS.maxAuxiliary}）。
            {EXPRESSION_SELECTION_COMBINE_NOTE}
          </p>
        </div>
        <p className="launcher-expression-tray-mode" role="status">
          状態: {selectionModeLabel(selectionMode)}
        </p>
        {selections.length === 0 ? (
          <p className="launcher-expression-state">まだ選んでいません。</p>
        ) : (
          <ul className="launcher-expression-tray-list">
            {selections.map((selection) => (
              <li key={selection.key}>
                <div>
                  <strong>{selection.title}</strong>
                  <small>{expressionRoleLabel(selection.role)}</small>
                  <small>{selection.provider} / {selection.nativeId}</small>
                  <small>{capabilityLabel(selection.capability)}</small>
                </div>
                <button
                  className="launcher-secondary"
                  onClick={() => handleRemove(selection.key)}
                  type="button"
                >
                  外す
                </button>
              </li>
            ))}
          </ul>
        )}
        {onReturnToTemplate && (
          <button className="launcher-primary" onClick={onReturnToTemplate} type="button">
            制作依頼へ反映して戻る
          </button>
        )}
      </aside>

      {statusMessage && (
        <p aria-live="polite" className="launcher-expression-status">
          {statusMessage}
        </p>
      )}
    </section>
  )
}

function ExpressionCard({
  item,
  selected,
  onSelect,
}: {
  item: ExpressionItem
  selected: boolean
  onSelect: () => void
}) {
  return (
    <li className="launcher-expression-card" data-selected={selected || undefined}>
      <ExpressionPreview item={item} />
      <div className="launcher-expression-card-body">
        <div className="launcher-expression-card-topline">
          <strong>{item.title}</strong>
          <small>{item.source === 'presentation-preset' ? '実行候補（未検証）' : '参考表現'}</small>
          <small>{item.category}</small>
          {item.brandLock && <small>ブランド固定</small>}
        </div>
        <p>{item.description || '説明なし'}</p>
        <div className="launcher-expression-card-meta">
          <span>{capabilityLabel(item.capability)}</span>
          <span>{previewFidelityLabel(item.previewFidelity)}</span>
        </div>
        <div className="launcher-expression-tags">
          {item.tags.slice(0, 4).map((tag) => (
            <span key={`${item.key}-${tag}`}>{tag}</span>
          ))}
        </div>
        <button
          aria-pressed={selected}
          className="launcher-secondary"
          onClick={onSelect}
          type="button"
        >
          {selected ? (
            <><Check aria-hidden="true" size={14} />選択中</>
          ) : '制作依頼へ追加'}
        </button>
      </div>
    </li>
  )
}
