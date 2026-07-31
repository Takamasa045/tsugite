import {
  HYPERFRAMES_CATALOG_ENDPOINT,
  isHyperframesCatalogSuccess,
  type HyperframesCatalogItem,
} from '../template/hyperframesCatalogModel'

export type ExpressionCatalogSessionResult =
  | {
    ok: true
    items: HyperframesCatalogItem[]
    warnings: string[]
    generation: number
  }
  | {
    ok: false
    generation: number
  }

type ExpressionCatalogSessionCache = {
  items: HyperframesCatalogItem[]
  warnings: string[]
  ready: boolean
  /** Shared in-flight fetch for the browser session (explicit-click only starts it). */
  inFlight: Promise<ExpressionCatalogSessionResult> | null
  /** Bumped on each new fetch start and on test reset; late writers must match. */
  generation: number
  /**
   * Generation of the last ready snapshot committed to `items`.
   * Distinct from request `generation` (which advances when a reload starts while
   * items may still be the previous ready snapshot). 0 when never ready.
   */
  readyGeneration: number
  /**
   * Last authoritative settle (success or failure) for the current generation.
   * Remount consumers read this so UI cannot stick on loading after unmount mid-reload.
   */
  lastSettled: ExpressionCatalogSessionResult | null
}

/** 棚タブ unmount 後も同一セッションで再取得しない（provider 再取得禁止） */
export const expressionCatalogSessionCache: ExpressionCatalogSessionCache = {
  items: [],
  warnings: [],
  ready: false,
  inFlight: null,
  generation: 0,
  readyGeneration: 0,
  lastSettled: null,
}

const sessionListeners = new Set<() => void>()

function notifyExpressionCatalogSessionListeners(): void {
  for (const listener of sessionListeners) listener()
}

/** Subscribe to in-flight start/settle and cache commits. */
export function subscribeExpressionCatalogSession(listener: () => void): () => void {
  sessionListeners.add(listener)
  return () => {
    sessionListeners.delete(listener)
  }
}

export function isExpressionCatalogSessionLoading(): boolean {
  return expressionCatalogSessionCache.inFlight !== null
}

/**
 * Start a catalog GET only when none is in flight; otherwise join the same Promise.
 * Must be called only from explicit user click (loadCatalog). Remount must not call this.
 *
 * inFlight is published before the async body runs so a synchronous fetcher throw cannot
 * leave a settled Promise stuck as inFlight (finally would otherwise clear before assign).
 */
export function startOrJoinExpressionCatalogFetch(options: {
  fetcher: typeof fetch
  token: string
}): Promise<ExpressionCatalogSessionResult> {
  if (expressionCatalogSessionCache.inFlight) {
    return expressionCatalogSessionCache.inFlight
  }

  const generation = expressionCatalogSessionCache.generation + 1
  expressionCatalogSessionCache.generation = generation

  let settle!: (result: ExpressionCatalogSessionResult) => void
  const fetchPromise = new Promise<ExpressionCatalogSessionResult>((resolve) => {
    settle = resolve
  })
  expressionCatalogSessionCache.inFlight = fetchPromise
  notifyExpressionCatalogSessionListeners()

  void (async (): Promise<void> => {
    try {
      const response = await options.fetcher(HYPERFRAMES_CATALOG_ENDPOINT, {
        headers: {
          accept: 'application/json',
          'x-tsugite-token': options.token,
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
      // Test reset or a newer generation must not commit stale results.
      if (generation !== expressionCatalogSessionCache.generation) {
        settle({ ok: false, generation })
        return
      }
      expressionCatalogSessionCache.items = payload.items
      expressionCatalogSessionCache.warnings = payload.warnings
      expressionCatalogSessionCache.ready = true
      expressionCatalogSessionCache.readyGeneration = generation
      const result: ExpressionCatalogSessionResult = {
        ok: true,
        items: payload.items,
        warnings: payload.warnings,
        generation,
      }
      expressionCatalogSessionCache.lastSettled = result
      settle(result)
    } catch {
      const result: ExpressionCatalogSessionResult = { ok: false, generation }
      // Only record as authoritative when this request generation is still current
      // (test reset bumps generation and must not poison a later session).
      if (generation === expressionCatalogSessionCache.generation) {
        expressionCatalogSessionCache.lastSettled = result
      }
      settle(result)
    } finally {
      if (expressionCatalogSessionCache.inFlight === fetchPromise) {
        expressionCatalogSessionCache.inFlight = null
      }
      notifyExpressionCatalogSessionListeners()
    }
  })()

  return fetchPromise
}

/** テスト隔離用。本番 UI からは呼ばない。 */
export function resetExpressionCatalogSessionCacheForTests(): void {
  expressionCatalogSessionCache.items = []
  expressionCatalogSessionCache.warnings = []
  expressionCatalogSessionCache.ready = false
  expressionCatalogSessionCache.inFlight = null
  expressionCatalogSessionCache.generation += 1
  expressionCatalogSessionCache.readyGeneration = 0
  expressionCatalogSessionCache.lastSettled = null
  sessionListeners.clear()
}

export function prefersReducedMotionInitially(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
