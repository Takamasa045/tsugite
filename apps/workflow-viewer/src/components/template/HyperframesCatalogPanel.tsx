import { Check, ClipboardCopy, RefreshCw, Search } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import {
  collectHyperframesCatalogTags,
  estimateHyperframesHintCategory,
  filterHyperframesCatalogItems,
  formatHyperframesCatalogDimensions,
  formatHyperframesCatalogDuration,
  HYPERFRAMES_CATALOG_ADVISORY_NOTE,
  HYPERFRAMES_CATALOG_CATEGORY_NOTE,
  HYPERFRAMES_CATALOG_ENDPOINT,
  HYPERFRAMES_CATALOG_PAGE_SIZE,
  HYPERFRAMES_HINT_CATEGORIES,
  INITIAL_HYPERFRAMES_CATALOG_FILTERS,
  isHyperframesCatalogSuccess,
  pageHyperframesCatalogItems,
  type HyperframesCatalogFilters,
  type HyperframesCatalogItem,
  type HyperframesCatalogLoadState,
  type HyperframesHintCategory,
} from './hyperframesCatalogModel'

export interface HyperframesCatalogPanelProps {
  fetcher?: typeof fetch
  /** Launcher session token; required by the authenticated catalog endpoint. */
  token?: string
}

const CLIPBOARD_WRITE_TIMEOUT_MS = 1_500

function writeClipboardText(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error('Clipboard write timed out'))
    }, CLIPBOARD_WRITE_TIMEOUT_MS)

    Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(
      () => {
        window.clearTimeout(timeout)
        resolve()
      },
      (error) => {
        window.clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

export function HyperframesCatalogPanel({
  fetcher = fetch,
  token = '',
}: HyperframesCatalogPanelProps) {
  const summaryId = useId()
  const searchId = useId()
  const typeId = useId()
  const categoryId = useId()
  const tagId = useId()
  const [open, setOpen] = useState(false)
  const [hasOpened, setHasOpened] = useState(false)
  const [loadState, setLoadState] = useState<HyperframesCatalogLoadState>('idle')
  const [items, setItems] = useState<HyperframesCatalogItem[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [filters, setFilters] = useState<HyperframesCatalogFilters>(INITIAL_HYPERFRAMES_CATALOG_FILTERS)
  const [visibleCount, setVisibleCount] = useState(HYPERFRAMES_CATALOG_PAGE_SIZE)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const itemsRef = useRef(items)
  itemsRef.current = items

  const loadCatalog = async ({ keepPrevious = false }: { keepPrevious?: boolean } = {}) => {
    setLoadState('loading')
    setErrorMessage(null)
    setStatusMessage('表現のヒントを読み込んでいます…')
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
        throw new Error('invalid hyperframes catalog')
      }
      if (!response.ok || !isHyperframesCatalogSuccess(payload)) {
        throw new Error('invalid hyperframes catalog')
      }
      setItems(payload.items)
      setWarnings(payload.warnings)
      setVisibleCount(HYPERFRAMES_CATALOG_PAGE_SIZE)
      setLoadState('ready')
      setStatusMessage(`${payload.items.length}件の表現ヒントを表示できます。`)
    } catch {
      if (!keepPrevious || itemsRef.current.length === 0) {
        setLoadState('error')
        setErrorMessage('表現のヒントを読み込めませんでした。仕上げ構成や制作依頼はそのまま使えます。')
        setStatusMessage('表現のヒントを読み込めませんでした。')
        return
      }
      // 再読込失敗時は前回成功一覧を残す
      setLoadState('ready')
      setErrorMessage('再読み込みに失敗しました。前回の一覧を表示しています。')
      setStatusMessage('再読み込みに失敗したため、前回の一覧を表示しています。')
    }
  }

  useEffect(() => {
    if (!open || hasOpened) return
    setHasOpened(true)
    void loadCatalog()
    // 初回 open 時だけ取得する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasOpened])

  useEffect(() => {
    if (!copiedId) return
    const timer = window.setTimeout(() => setCopiedId(null), 2000)
    return () => window.clearTimeout(timer)
  }, [copiedId])

  const availableTags = useMemo(() => collectHyperframesCatalogTags(items), [items])
  const filteredItems = useMemo(
    () => filterHyperframesCatalogItems(items, filters),
    [filters, items],
  )
  const visibleItems = useMemo(
    () => pageHyperframesCatalogItems(filteredItems, visibleCount),
    [filteredItems, visibleCount],
  )

  function updateFilter<K extends keyof HyperframesCatalogFilters>(
    key: K,
    value: HyperframesCatalogFilters[K],
  ) {
    setFilters((current) => ({ ...current, [key]: value }))
    setVisibleCount(HYPERFRAMES_CATALOG_PAGE_SIZE)
  }

  async function handleCopyId(id: string) {
    try {
      await writeClipboardText(id)
      setCopiedId(id)
      setStatusMessage(`${id} をコピーしました`)
    } catch {
      setStatusMessage('IDをコピーできませんでした')
    }
  }

  return (
    <details
      className="launcher-hyperframes-catalog"
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open
        setOpen(nextOpen)
      }}
    >
      <summary id={summaryId}>表現のヒントを探す</summary>
      <div
        aria-labelledby={summaryId}
        className="launcher-hyperframes-catalog-body"
      >
        <p className="launcher-hyperframes-catalog-advisory" role="note">
          {HYPERFRAMES_CATALOG_ADVISORY_NOTE}
        </p>
        <p className="launcher-hyperframes-catalog-note">
          HyperFrames公式catalogの参考一覧です。制作依頼本文へ自動追加せず、presetへ変換せず、自動installもしません。
        </p>

        <div className="launcher-hyperframes-catalog-toolbar">
          <label className="launcher-hyperframes-catalog-search" htmlFor={searchId}>
            <span>検索</span>
            <span className="launcher-hyperframes-catalog-search-field">
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

          <label htmlFor={typeId}>
            <span>type</span>
            <select
              id={typeId}
              onChange={(event) => updateFilter(
                'type',
                event.target.value as HyperframesCatalogFilters['type'],
              )}
              value={filters.type}
            >
              <option value="all">すべて</option>
              <option value="block">block</option>
              <option value="component">component</option>
            </select>
          </label>

          <label htmlFor={categoryId}>
            <span>Tsugite推定分類</span>
            <select
              id={categoryId}
              onChange={(event) => updateFilter(
                'category',
                event.target.value as 'all' | HyperframesHintCategory,
              )}
              value={filters.category}
            >
              <option value="all">すべて</option>
              {HYPERFRAMES_HINT_CATEGORIES.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>
          </label>

          <label htmlFor={tagId}>
            <span>タグ</span>
            <select
              id={tagId}
              onChange={(event) => updateFilter(
                'tag',
                event.target.value ? event.target.value : null,
              )}
              value={filters.tag ?? ''}
            >
              <option value="">すべて</option>
              {availableTags.map((tag) => (
                <option key={tag} value={tag}>{tag}</option>
              ))}
            </select>
          </label>
        </div>

        <p className="launcher-hyperframes-catalog-category-note">
          {HYPERFRAMES_CATALOG_CATEGORY_NOTE}
        </p>

        <div className="launcher-hyperframes-catalog-meta" aria-live="polite">
          <span>
            全{items.length}件 / 表示{visibleItems.length}件
            {filteredItems.length !== items.length ? `（絞り込み${filteredItems.length}件）` : ''}
          </span>
          {hasOpened && (
            <button
              aria-busy={loadState === 'loading' || undefined}
              aria-disabled={loadState === 'loading' || undefined}
              className="launcher-secondary"
              onClick={() => {
                // Soft-disable while loading so Chromium keeps focus on this control.
                if (loadState === 'loading') return
                void loadCatalog({ keepPrevious: items.length > 0 })
              }}
              type="button"
            >
              <RefreshCw aria-hidden="true" className={loadState === 'loading' ? 'is-spinning' : undefined} size={14} />
              再読み込み
            </button>
          )}
        </div>

        {statusMessage && (
          <p className="launcher-hyperframes-catalog-status" aria-live="polite">
            {statusMessage}
          </p>
        )}

        {loadState === 'loading' && items.length === 0 && (
          <div className="launcher-hyperframes-catalog-state" aria-live="polite">
            <RefreshCw aria-hidden="true" className="is-spinning" size={16} />
            <strong>表現のヒントを読み込んでいます…</strong>
          </div>
        )}

        {errorMessage && (
          <div className="launcher-hyperframes-catalog-state launcher-hyperframes-catalog-state-error" role="alert">
            <strong>{errorMessage}</strong>
          </div>
        )}

        {loadState === 'ready' && filteredItems.length === 0 && (
          <p className="launcher-hyperframes-catalog-state" role="status">
            条件に合う表現ヒントはありません。
          </p>
        )}

        {warnings.length > 0 && loadState === 'ready' && (
          <p className="launcher-hyperframes-catalog-warnings" role="status">
            一部の項目を省略しました（{warnings.length}件の注意）。
          </p>
        )}

        {visibleItems.length > 0 && (
          <ul className="launcher-hyperframes-catalog-list">
            {visibleItems.map((item) => {
              const category = estimateHyperframesHintCategory(item.tags)
              const expanded = expandedId === item.id
              const dimensions = formatHyperframesCatalogDimensions(item.dimensions)
              const duration = formatHyperframesCatalogDuration(item.durationSeconds)
              return (
                <li className="launcher-hyperframes-catalog-item" key={item.id}>
                  <div className="launcher-hyperframes-catalog-item-topline">
                    <strong>{item.title}</strong>
                    <small>{item.type}</small>
                    <small>{category}</small>
                  </div>
                  <p className="launcher-hyperframes-catalog-item-description">
                    {item.description}
                  </p>
                  <div className="launcher-hyperframes-catalog-item-tags">
                    {item.tags.map((tag) => (
                      <button
                        className={filters.tag === tag
                          ? 'launcher-hyperframes-catalog-tag is-active'
                          : 'launcher-hyperframes-catalog-tag'}
                        key={`${item.id}-${tag}`}
                        onClick={() => updateFilter('tag', filters.tag === tag ? null : tag)}
                        type="button"
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                  <div className="launcher-hyperframes-catalog-item-actions">
                    <button
                      aria-expanded={expanded}
                      aria-label={expanded ? `${item.title}の詳細を閉じる` : `${item.title}の詳細`}
                      className="launcher-secondary"
                      onClick={() => setExpandedId(expanded ? null : item.id)}
                      type="button"
                    >
                      {expanded ? '詳細を閉じる' : '詳細'}
                    </button>
                    <button
                      aria-label={`${item.id} をコピー`}
                      className="launcher-secondary"
                      onClick={() => void handleCopyId(item.id)}
                      type="button"
                    >
                      {copiedId === item.id ? (
                        <>
                          <Check aria-hidden="true" size={14} />
                          コピー済み
                        </>
                      ) : (
                        <>
                          <ClipboardCopy aria-hidden="true" size={14} />
                          IDをコピー
                        </>
                      )}
                    </button>
                  </div>
                  {expanded && (
                    <dl className="launcher-hyperframes-catalog-item-detail">
                      <div>
                        <dt>内部ID（技術情報）</dt>
                        <dd><code className="launcher-hyperframes-catalog-item-id">{item.id}</code></dd>
                      </div>
                      <div>
                        <dt>type</dt>
                        <dd>{item.type}</dd>
                      </div>
                      <div>
                        <dt>Tsugite推定分類</dt>
                        <dd>{category}</dd>
                      </div>
                      {dimensions && (
                        <div>
                          <dt>サイズ</dt>
                          <dd>{dimensions}</dd>
                        </div>
                      )}
                      {duration && (
                        <div>
                          <dt>尺</dt>
                          <dd>{duration}</dd>
                        </div>
                      )}
                    </dl>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {visibleCount < filteredItems.length && (
          <button
            className="launcher-secondary launcher-hyperframes-catalog-more"
            onClick={() => setVisibleCount((count) => count + HYPERFRAMES_CATALOG_PAGE_SIZE)}
            type="button"
          >
            さらに12件表示
          </button>
        )}
      </div>
    </details>
  )
}
