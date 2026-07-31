import { useCallback, useEffect, useRef, useState } from 'react'

import type { HyperframesCatalogItem, HyperframesCatalogLoadState } from '../template/hyperframesCatalogModel'
import {
  expressionCatalogSessionCache,
  isExpressionCatalogSessionLoading,
  startOrJoinExpressionCatalogFetch,
  subscribeExpressionCatalogSession,
  type ExpressionCatalogSessionResult,
} from './expressionShelfSession'

export interface UseExpressionCatalogOptions {
  fetcher?: typeof fetch
  token?: string
  onStatusMessage?: (message: string) => void
  /** Called after a successful catalog load (including empty). */
  onCatalogLoaded?: () => void
}

export interface UseExpressionCatalogResult {
  catalogState: HyperframesCatalogLoadState
  catalogItems: HyperframesCatalogItem[]
  catalogError: string | null
  catalogWarning: string | null
  hasLoadedCatalog: boolean
  loadCatalog: (options?: { keepPrevious?: boolean }) => Promise<void>
}

function initialCatalogState(): HyperframesCatalogLoadState {
  if (expressionCatalogSessionCache.ready) return 'ready'
  if (isExpressionCatalogSessionLoading()) return 'loading'
  return 'idle'
}

function warningFromSession(): string | null {
  return expressionCatalogSessionCache.warnings.length > 0
    ? `一部の項目を省略しました（${expressionCatalogSessionCache.warnings.length}件の注意）。`
    : null
}

function keepPreviousFromSession(catalogItemCount: number): boolean {
  return expressionCatalogSessionCache.ready || catalogItemCount > 0
}

/**
 * Explicit-click HyperFrames catalog fetch/cache/state only.
 * Never auto-fetches — callers must invoke loadCatalog from a button.
 * Remount joins an existing session in-flight Promise and does not start a new GET.
 *
 * Request `generation` advances when a fetch starts; `readyGeneration` advances only
 * when a ready snapshot is committed. Mount initializes seen from readyGeneration so a
 * mid-reload remount does not treat the in-flight request generation as already applied.
 * Session `lastSettled` delivers both success and failure after unmount/remount races.
 */
export function useExpressionCatalog({
  fetcher = fetch,
  token = '',
  onStatusMessage,
  onCatalogLoaded,
}: UseExpressionCatalogOptions = {}): UseExpressionCatalogResult {
  const [catalogState, setCatalogState] = useState<HyperframesCatalogLoadState>(initialCatalogState)
  const [catalogItems, setCatalogItems] = useState(
    () => expressionCatalogSessionCache.items,
  )
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [catalogWarning, setCatalogWarning] = useState<string | null>(warningFromSession)
  const [hasLoadedCatalog, setHasLoadedCatalog] = useState(expressionCatalogSessionCache.ready)
  const catalogItemsRef = useRef(catalogItems)
  catalogItemsRef.current = catalogItems

  const mountedRef = useRef(true)
  const onStatusMessageRef = useRef(onStatusMessage)
  onStatusMessageRef.current = onStatusMessage
  const onCatalogLoadedRef = useRef(onCatalogLoaded)
  onCatalogLoadedRef.current = onCatalogLoaded
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const tokenRef = useRef(token)
  tokenRef.current = token
  /**
   * Last applied settle generation (success or failure).
   * Initialized from readyGeneration (not request generation) so reload-in-flight remount
   * can still apply the NEW settle.
   */
  const seenGenerationRef = useRef<number | null>(
    expressionCatalogSessionCache.ready
      ? expressionCatalogSessionCache.readyGeneration
      : null,
  )
  const joinedPromiseRef = useRef<Promise<ExpressionCatalogSessionResult> | null>(null)

  const applySessionResult = useCallback((
    result: ExpressionCatalogSessionResult,
    { keepPrevious }: { keepPrevious: boolean },
  ) => {
    if (!mountedRef.current) return
    // Dedup: notify + promise then + loadCatalog await must not double-fire callbacks.
    if (seenGenerationRef.current === result.generation) return
    seenGenerationRef.current = result.generation

    if (result.ok) {
      const items = expressionCatalogSessionCache.ready
        ? expressionCatalogSessionCache.items
        : result.items
      const warnings = expressionCatalogSessionCache.ready
        ? expressionCatalogSessionCache.warnings
        : result.warnings
      setCatalogItems(items)
      setCatalogState('ready')
      setHasLoadedCatalog(true)
      setCatalogError(null)
      onCatalogLoadedRef.current?.()
      onStatusMessageRef.current?.(
        `${items.length}件の参考表現を表示できます。参考を含めた候補を出すには、もう一度「入力内容から候補を絞り込む」を押してください。`,
      )
      if (warnings.length > 0) {
        setCatalogWarning(`一部の項目を省略しました（${warnings.length}件の注意）。`)
      } else {
        setCatalogWarning(null)
      }
      return
    }

    // Failed: keep previous list only when requested and we still have items.
    if (!keepPrevious || catalogItemsRef.current.length === 0) {
      setCatalogState('error')
      setCatalogError('参考一覧を読み込めませんでした。制作依頼に指定できる仕上げと制作依頼文はそのまま使えます。')
      onStatusMessageRef.current?.('参考一覧を読み込めませんでした。')
      return
    }
    setCatalogState('ready')
    setCatalogError('再読み込みに失敗しました。前回の一覧を表示しています。')
    onStatusMessageRef.current?.('再読み込みに失敗したため、前回の一覧を表示しています。')
  }, [])

  const applyReadySnapshot = useCallback(() => {
    if (!mountedRef.current || !expressionCatalogSessionCache.ready) return
    const { readyGeneration, items } = expressionCatalogSessionCache
    if (seenGenerationRef.current === readyGeneration) return
    seenGenerationRef.current = readyGeneration
    setCatalogItems(items)
    setCatalogState('ready')
    setHasLoadedCatalog(true)
    setCatalogError(null)
    setCatalogWarning(warningFromSession())
    onCatalogLoadedRef.current?.()
    onStatusMessageRef.current?.(
      `${items.length}件の参考表現を表示できます。参考を含めた候補を出すには、もう一度「入力内容から候補を絞り込む」を押してください。`,
    )
  }, [])

  // Remount / session notify: follow in-flight or settled result — never start a new fetch.
  useEffect(() => {
    mountedRef.current = true

    const syncFromSession = () => {
      if (!mountedRef.current) return

      const inflight = expressionCatalogSessionCache.inFlight
      if (inflight) {
        setCatalogState('loading')
        setCatalogError(null)
        if (expressionCatalogSessionCache.ready) {
          setCatalogItems(expressionCatalogSessionCache.items)
          setHasLoadedCatalog(true)
          setCatalogWarning(warningFromSession())
        }
        onStatusMessageRef.current?.('アイデア用の参考一覧を読み込んでいます…')

        if (joinedPromiseRef.current !== inflight) {
          joinedPromiseRef.current = inflight
          const keepPrevious = keepPreviousFromSession(catalogItemsRef.current.length)
          void inflight.then((result) => {
            if (joinedPromiseRef.current !== inflight) return
            applySessionResult(result, { keepPrevious })
          })
        }
        return
      }

      joinedPromiseRef.current = null

      // Prefer lastSettled so reload failure (ready stays OLD) still leaves loading.
      const settled = expressionCatalogSessionCache.lastSettled
      if (settled && seenGenerationRef.current !== settled.generation) {
        applySessionResult(settled, {
          keepPrevious: keepPreviousFromSession(catalogItemsRef.current.length),
        })
        return
      }

      // Covers ready snapshot when lastSettled was already applied (or absent).
      applyReadySnapshot()
    }

    syncFromSession()
    const unsubscribe = subscribeExpressionCatalogSession(syncFromSession)
    return () => {
      mountedRef.current = false
      unsubscribe()
    }
  }, [applyReadySnapshot, applySessionResult])

  const loadCatalog = useCallback(async ({ keepPrevious = false }: { keepPrevious?: boolean } = {}) => {
    if (!mountedRef.current) return
    setCatalogState('loading')
    setCatalogError(null)
    setCatalogWarning(null)
    onStatusMessageRef.current?.('アイデア用の参考一覧を読み込んでいます…')

    const result = await startOrJoinExpressionCatalogFetch({
      fetcher: fetcherRef.current,
      token: tokenRef.current,
    })
    applySessionResult(result, { keepPrevious })
  }, [applySessionResult])

  return {
    catalogState,
    catalogItems,
    catalogError,
    catalogWarning,
    hasLoadedCatalog,
    loadCatalog,
  }
}
