import { ArrowLeft } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'

import type { PresentationPresetLoadState, PresentationPresetOption } from '../template/presentationPresetModel'
import {
  ExpressionBrowseToolbar,
  type ExpressionBrowseMode,
} from './ExpressionBrowseToolbar'
import { ExpressionIntentPanel } from './ExpressionIntentPanel'
import { ExpressionRecommendations } from './ExpressionRecommendations'
import { ExecutableExpressionGroup } from './ExecutableExpressionGroup'
import { ReferenceExpressionGroup } from './ReferenceExpressionGroup'
import { ExpressionSelectionTray } from './ExpressionSelectionTray'
import {
  EXPRESSION_PAGE_SIZE,
  dedupeExpressionItemsByKey,
  filterExpressionItems,
  formatExpressionCandidatesPromptSection,
  INITIAL_EXPRESSION_FILTERS,
  isFullCompositionRole,
  normalizeHyperframesCatalogItem,
  normalizePresentationPreset,
  pageExpressionItems,
  partitionExpressionItems,
  removeExpressionSelection,
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
import { prefersReducedMotionInitially } from './expressionShelfSession'
import { useExpressionCatalog } from './useExpressionCatalog'

export { resetExpressionCatalogSessionCacheForTests } from './expressionShelfSession'

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

const INTENT_CHANGED_STATUS =
  '条件が変わったため、以前の候補は無効です。もう一度「入力内容から候補を絞り込む」を押してください。'
const PRESET_POOL_CHANGED_STATUS =
  '仕上げ候補の一覧が更新されたため、以前の候補は無効です。もう一度「入力内容から候補を絞り込む」を押してください。'
const PRESET_LOADING_REASON =
  'この環境の仕上げ候補を読み込んでいます。読み込み後に候補の絞り込みが操作できます。'

/**
 * Stable fingerprint of presentation presets for stale-recommendation hygiene.
 *
 * Includes every field that feeds `normalizePresentationPreset` and thus
 * recommendation scoring / display (title, description, aspect, tags derived
 * from backend/id/aspect). Order is part of the fingerprint so list reorders
 * also invalidate.
 *
 * `backendLabel` is intentionally omitted: normalizePresentationPreset never
 * reads it (provider comes from `backend`; card title from `label`). Including
 * it would only thrash recommendations when a display-only backend string
 * changes.
 */
function presentationPresetKeyPool(presets: readonly PresentationPresetOption[]): string {
  return presets
    .map((preset) => [
      preset.backend,
      preset.id,
      preset.label,
      preset.description ?? '',
      preset.aspectRatio ?? '',
    ].join('\u001f'))
    .join('\0')
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
  // Stable id so LauncherApp can restore keyboard focus after tabpanel remount.
  const headingId = 'launcher-expressions-heading'
  const freeTextId = useId()
  const aspectId = useId()
  const purposeId = useId()
  const readinessId = useId()
  const searchId = useId()
  const roleFilterId = useId()

  // Always mounted aria-live region: update from '' so announcements fire.
  const [statusMessage, setStatusMessage] = useState('')
  const [freeText, setFreeText] = useState(intentSeed?.freeText ?? '')
  const [aspect, setAspect] = useState<RecommendationIntent['aspect']>(intentSeed?.aspect ?? 'any')
  const [purpose, setPurpose] = useState(intentSeed?.purpose ?? '')
  const [readiness, setReadiness] = useState<RecommendationIntent['readiness']>(
    intentSeed?.readiness ?? 'explore',
  )
  // 推薦意図の「動きを抑える」。OS の prefers-reduced-motion を初期値に使うが、
  // 見本の再生制御とは別物。
  const [preferCalmMotion, setPreferCalmMotion] = useState(prefersReducedMotionInitially)
  const [recommendation, setRecommendation] = useState<RecommendationResult | null>(null)
  const [filters, setFilters] = useState<ExpressionFilters>(INITIAL_EXPRESSION_FILTERS)
  const [browseMode, setBrowseMode] = useState<ExpressionBrowseMode>('all')
  const [visibleExecutable, setVisibleExecutable] = useState(EXPRESSION_PAGE_SIZE)
  const [visibleReference, setVisibleReference] = useState(EXPRESSION_PAGE_SIZE)
  const seededRef = useRef(false)
  const recommendationRef = useRef(recommendation)
  recommendationRef.current = recommendation
  const presetPoolRef = useRef(presentationPresetKeyPool(presentationPresets))
  const presetPoolMountedRef = useRef(false)

  const clearStaleRecommendation = useCallback((message: string) => {
    if (!recommendationRef.current) return
    setRecommendation(null)
    setStatusMessage(message)
  }, [])

  /** Drop recommendation without status overwrite (caller sets loading status next). */
  const dropRecommendationSilently = useCallback(() => {
    if (!recommendationRef.current) return
    setRecommendation(null)
  }, [])

  const handleCatalogLoaded = useCallback(() => {
    // Success safety net + pagination reset. Start-of-load already cleared recommendation.
    setRecommendation(null)
    setVisibleReference(EXPRESSION_PAGE_SIZE)
  }, [])

  const {
    catalogState,
    catalogItems,
    catalogError,
    catalogWarning,
    hasLoadedCatalog,
    loadCatalog,
  } = useExpressionCatalog({
    fetcher,
    token,
    onStatusMessage: setStatusMessage,
    onCatalogLoaded: handleCatalogLoaded,
  })

  /**
   * Clear recommendation in the same turn as load/reload click so the focused
   * catalog action stays put and recommendation play/add controls unmount first.
   * Do not auto-recommend; failures never restore the old list.
   */
  const handleLoadCatalog = useCallback((options?: { keepPrevious?: boolean }) => {
    dropRecommendationSilently()
    void loadCatalog(options)
  }, [dropRecommendationSilently, loadCatalog])

  /**
   * Clear recommendation when presentation preset retry starts (same turn as
   * the retry click). Pool success still invalidates via presetPool effect.
   */
  const handleRetryPresentationPresets = useCallback(() => {
    dropRecommendationSilently()
    onRetryPresentationPresets?.()
  }, [dropRecommendationSilently, onRetryPresentationPresets])

  useEffect(() => {
    if (!intentSeed || seededRef.current) return
    seededRef.current = true
    setFreeText(intentSeed.freeText)
    setAspect(intentSeed.aspect ?? 'any')
    setPurpose(intentSeed.purpose ?? '')
    setReadiness(intentSeed.readiness ?? 'explore')
    onClearIntentSeed?.()
  }, [intentSeed, onClearIntentSeed])

  // Async presentationPresets key pool change → clear stale recommendation (skip first mount).
  const presetPool = useMemo(
    () => presentationPresetKeyPool(presentationPresets),
    [presentationPresets],
  )
  useEffect(() => {
    if (!presetPoolMountedRef.current) {
      presetPoolMountedRef.current = true
      presetPoolRef.current = presetPool
      return
    }
    if (presetPoolRef.current === presetPool) return
    presetPoolRef.current = presetPool
    clearStaleRecommendation(PRESET_POOL_CHANGED_STATUS)
  }, [presetPool, clearStaleRecommendation])

  // HyperFrames 公式 catalog は外部 registry 通信があるため、明示ボタンでのみ取得する

  const executableItems = useMemo(
    () => presentationPresets.map(normalizePresentationPreset),
    [presentationPresets],
  )
  const referenceItems = useMemo(
    () => dedupeExpressionItemsByKey(catalogItems.map(normalizeHyperframesCatalogItem)),
    [catalogItems],
  )
  const allItems = useMemo(
    () => [...executableItems, ...referenceItems],
    [executableItems, referenceItems],
  )

  const activeFilters = useMemo<ExpressionFilters>(() => ({
    ...filters,
    group: browseMode === 'all'
      ? filters.group
      : browseMode === 'executable'
        ? 'executable'
        : 'reference',
  }), [filters, browseMode])

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

  const freeformExportText = useMemo(
    () => formatExpressionCandidatesPromptSection({
      mode: selectionMode,
      selections,
    }),
    [selectionMode, selections],
  )

  const resultCountMessage = useMemo(() => {
    const total = executableCandidates.length + referenceExpressions.length
    const showing =
      (browseMode === 'reference' ? 0 : visibleExecutableItems.length)
      + (browseMode === 'executable' ? 0 : visibleReferenceItems.length)
    if (browseMode === 'executable') {
      return `この環境の仕上げ候補: ${executableCandidates.length}件中 ${visibleExecutableItems.length}件を表示`
    }
    if (browseMode === 'reference') {
      return `アイデアとして参照する表現: ${referenceExpressions.length}件中 ${visibleReferenceItems.length}件を表示`
    }
    return `表示中 ${showing}件 / 絞り込み結果 ${total}件（仕上げ ${executableCandidates.length}・参考 ${referenceExpressions.length}）`
  }, [
    browseMode,
    executableCandidates.length,
    referenceExpressions.length,
    visibleExecutableItems.length,
    visibleReferenceItems.length,
  ])

  const recommendDisabled = presentationPresetLoadState === 'loading'

  function runRecommendation() {
    if (recommendDisabled) return
    const intent: RecommendationIntent = {
      freeText,
      aspect: aspect ?? 'any',
      purpose: purpose || null,
      readiness: readiness ?? 'explore',
      reducedMotion: preferCalmMotion,
      brandFixed: false,
      avoid: [],
    }
    // hasLoadedCatalog is truth after a successful load (including 0 items).
    // Empty catalog ≠ unloaded: only unread catalog limits explore scope.
    const exploreWithoutCatalog = (readiness ?? 'explore') === 'explore' && !hasLoadedCatalog

    // When "ideas included" but catalog is not loaded, search only finish
    // candidates and disclose the limited scope — never auto-fetch.
    // After load (even items=[]), searchPool is allItems.
    const searchPool = exploreWithoutCatalog ? executableItems : allItems
    const result = recommendExpressions(searchPool, intent)

    if (exploreWithoutCatalog) {
      const scopeNote = [
        '今検索できる範囲は、この環境の仕上げ候補だけです。',
        '参考表現を含めるには「HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）」が必要です。',
        '自動では読み込みません。',
      ].join('')
      setRecommendation({
        ...result,
        clarification: result.clarification
          ? `${scopeNote} ${result.clarification}`
          : scopeNote,
      })
      setStatusMessage(
        result.recommendations.length > 0
          ? `仕上げ候補 ${result.recommendations.length}件を提案しました（参考一覧は未読込）。自動では選ばれません。`
          : result.clarification ?? scopeNote,
      )
      return
    }

    setRecommendation(result)
    setStatusMessage(
      result.recommendations.length > 0
        ? `候補 ${result.recommendations.length}件を提案しました。自動では選ばれません。`
        : result.clarification ?? '条件に合う候補がありません。',
    )
  }

  /** Intent field change: clear stale recommendation; never auto-recommend. */
  function updateIntentField<T>(setter: (value: T) => void, value: T) {
    clearStaleRecommendation(INTENT_CHANGED_STATUS)
    setter(value)
  }

  // Read latest selections via ref so handleSelect identity stays stable and
  // memoized ExpressionCards do not re-render when only selection set changes.
  const selectionsRef = useRef(selections)
  selectionsRef.current = selections

  const handleSelect = useCallback((item: ExpressionItem, reason: string) => {
    const result = tryAddExpressionSelection(
      selectionsRef.current,
      toExpressionSelection(item, reason),
    )
    if (!result.ok) {
      setStatusMessage(result.reason)
      return
    }
    onSelectionsChange({ selections: result.selections, mode: 'explicit' })
    const roleNote = isFullCompositionRole(item.role)
      ? '全体構成として追加（補助表現と組み合わせ可）'
      : '補助表現として追加（全体構成と組み合わせ可）'
    setStatusMessage(`${item.title} をコピー候補に追加しました（${roleNote}）`)
  }, [onSelectionsChange])

  const handleRemove = useCallback((key: string, title: string) => {
    const next = removeExpressionSelection(selectionsRef.current, key)
    onSelectionsChange({
      selections: next,
      mode: next.length === 0 ? 'unset' : 'explicit',
    })
    setStatusMessage(`${title} をコピー候補から外しました`)
  }, [onSelectionsChange])

  function resetPagination() {
    setVisibleExecutable(EXPRESSION_PAGE_SIZE)
    setVisibleReference(EXPRESSION_PAGE_SIZE)
  }

  function updateFilter<K extends keyof ExpressionFilters>(key: K, value: ExpressionFilters[K]) {
    setFilters((current) => ({ ...current, [key]: value }))
    resetPagination()
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
          <span className="eyebrow">表現</span>
          <h2 id={headingId} tabIndex={-1}>動きや仕上げを見比べて、プロンプトをコピーする</h2>
          <p>
            カタログとして閲覧し、表現プロンプトをコピーできます。
            この環境の仕上げ候補と、アイデア用の参考表現を分けて見られます。
            制作依頼本文へは自動では入りません。
          </p>
        </div>
        <div className="launcher-expression-heading-meta">
          <span className="launcher-count">
            仕上げ {executableItems.length}件 / 参考 {referenceItems.length}件
          </span>
          {onReturnToTemplate && (
            <button className="launcher-secondary" onClick={onReturnToTemplate} type="button">
              <ArrowLeft aria-hidden="true" size={16} />
              {returnLabel}
            </button>
          )}
        </div>
      </header>

      <ExpressionIntentPanel
        freeTextId={freeTextId}
        aspectId={aspectId}
        purposeId={purposeId}
        readinessId={readinessId}
        freeText={freeText}
        aspect={aspect}
        purpose={purpose}
        readiness={readiness}
        preferCalmMotion={preferCalmMotion}
        hasLoadedCatalog={hasLoadedCatalog}
        recommendDisabled={recommendDisabled}
        recommendDisabledReason={recommendDisabled ? PRESET_LOADING_REASON : null}
        onFreeTextChange={(value) => updateIntentField(setFreeText, value)}
        onAspectChange={(value) => updateIntentField(setAspect, value)}
        onPurposeChange={(value) => updateIntentField(setPurpose, value)}
        onReadinessChange={(value) => updateIntentField(setReadiness, value)}
        onPreferCalmMotionChange={(value) => updateIntentField(setPreferCalmMotion, value)}
        onRecommend={runRecommendation}
      />

      {recommendation && (
        <ExpressionRecommendations
          recommendation={recommendation}
          selections={selections}
          onSelect={handleSelect}
        />
      )}

      <ExpressionBrowseToolbar
        searchId={searchId}
        roleFilterId={roleFilterId}
        query={filters.query}
        role={filters.role}
        browseMode={browseMode}
        onQueryChange={(value) => updateFilter('query', value)}
        onRoleChange={(value) => updateFilter('role', value)}
        onBrowseModeChange={(mode) => {
          setBrowseMode(mode)
          resetPagination()
        }}
      />

      <p className="launcher-expression-result-count" role="status">
        {resultCountMessage}
      </p>

      {(browseMode === 'all' || browseMode === 'executable') && (
        <ExecutableExpressionGroup
          presentationPresetLoadState={presentationPresetLoadState}
          presentationPresetNotice={presentationPresetNotice}
          onRetryPresentationPresets={
            onRetryPresentationPresets ? handleRetryPresentationPresets : undefined
          }
          executableCandidates={executableCandidates}
          visibleItems={visibleExecutableItems}
          visibleCount={visibleExecutable}
          selections={selections}
          onSelect={handleSelect}
          onShowMore={() => setVisibleExecutable((count) => count + EXPRESSION_PAGE_SIZE)}
        />
      )}

      {(browseMode === 'all' || browseMode === 'reference') && (
        <ReferenceExpressionGroup
          catalogState={catalogState}
          catalogError={catalogError}
          catalogWarning={catalogWarning}
          hasLoadedCatalog={hasLoadedCatalog}
          catalogItemCount={catalogItems.length}
          referenceExpressions={referenceExpressions}
          visibleItems={visibleReferenceItems}
          visibleCount={visibleReference}
          selections={selections}
          onSelect={handleSelect}
          onLoadCatalog={handleLoadCatalog}
          onShowMore={() => setVisibleReference((count) => count + EXPRESSION_PAGE_SIZE)}
        />
      )}

      <ExpressionSelectionTray
        selections={selections}
        selectionMode={selectionMode}
        freeformExportText={freeformExportText}
        onRemove={handleRemove}
        onStatusMessage={setStatusMessage}
        onReturnToTemplate={onReturnToTemplate}
      />

      <p aria-live="polite" className="launcher-expression-status">
        {statusMessage}
      </p>
    </section>
  )
}
