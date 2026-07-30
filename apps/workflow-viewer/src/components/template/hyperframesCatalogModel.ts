/**
 * HyperFrames 公式 catalog の UI 契約。
 * 実行 preset とは別。参考情報であり、利用可能・導入済み・render 可能を保証しない。
 */

export type HyperframesCatalogLoadState = 'idle' | 'loading' | 'ready' | 'error'

export type HyperframesCatalogItemType = 'block' | 'component'

export type HyperframesCatalogItem = {
  id: string
  type: HyperframesCatalogItemType
  title: string
  description: string
  tags: string[]
  dimensions?: { width: number; height: number }
  durationSeconds?: number
}

export type HyperframesCatalogSuccess = {
  ok: true
  schemaVersion: 1
  source: 'hyperframes'
  advisoryOnly: true
  capabilityVerified: false
  summary: {
    total: number
    returned: number
    omitted: number
    byType: {
      block: number
      component: number
    }
  }
  items: HyperframesCatalogItem[]
  warnings: string[]
}

export type HyperframesCatalogFailure = {
  ok: false
  issue: {
    code: string
    message: string
  }
}

export type HyperframesHintCategory =
  | 'データ・図表'
  | 'コード・開発画面'
  | '文字・字幕'
  | '切り替え'
  | '補助表示'
  | '3D・シェーダー'
  | 'SNS・配信'
  | 'その他'

export const HYPERFRAMES_HINT_CATEGORIES: readonly HyperframesHintCategory[] = [
  'データ・図表',
  'コード・開発画面',
  '文字・字幕',
  '切り替え',
  '補助表示',
  '3D・シェーダー',
  'SNS・配信',
  'その他',
] as const

export const HYPERFRAMES_CATALOG_PAGE_SIZE = 12

export const HYPERFRAMES_CATALOG_ADVISORY_NOTE =
  '参考情報で、利用可能・導入済み・render可能を保証しません'

export const HYPERFRAMES_CATALOG_CATEGORY_NOTE =
  'Tsugite推定分類（公式categoryではありません。tagsから推定）'

export const HYPERFRAMES_CATALOG_ENDPOINT = '/api/reference-catalogs/hyperframes'

const CATEGORY_TAG_MATCHERS: ReadonlyArray<{
  category: Exclude<HyperframesHintCategory, 'その他'>
  tags: readonly string[]
}> = [
  {
    category: 'データ・図表',
    tags: ['data', 'chart', 'statistics', 'map', 'diagram', 'flowchart', 'graph', 'table'],
  },
  {
    category: 'コード・開発画面',
    tags: ['code', 'terminal', 'dev', 'developer', 'ide', 'syntax', 'editor', 'console'],
  },
  {
    category: '文字・字幕',
    tags: ['text', 'subtitle', 'caption', 'typography', 'typewriter', 'title', 'type', 'karaoke'],
  },
  {
    category: '切り替え',
    tags: ['transition', 'wipe', 'fade', 'switch', 'cut', 'morph'],
  },
  {
    category: '補助表示',
    tags: ['overlay', 'hud', 'badge', 'lower-third', 'lowerthird', 'grain', 'texture', 'watermark', 'bug'],
  },
  {
    category: '3D・シェーダー',
    tags: ['3d', 'shader', 'webgl', 'three', 'mesh', 'particle'],
  },
  {
    category: 'SNS・配信',
    tags: ['social', 'sns', 'stream', 'live', 'youtube', 'tiktok', 'broadcast', 'chat'],
  },
]

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && Number.isFinite(value)
    && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && Number.isFinite(value)
    && value > 0
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isHyperframesCatalogItem(input: unknown): input is HyperframesCatalogItem {
  if (typeof input !== 'object' || input === null) return false
  const item = input as Record<string, unknown>
  if (typeof item.id !== 'string' || item.id.length === 0) return false
  if (item.type !== 'block' && item.type !== 'component') return false
  if (typeof item.title !== 'string' || item.title.length === 0) return false
  if (typeof item.description !== 'string') return false
  if (!Array.isArray(item.tags) || !item.tags.every((tag) => typeof tag === 'string')) return false
  if (item.dimensions !== undefined) {
    if (typeof item.dimensions !== 'object' || item.dimensions === null) return false
    const dimensions = item.dimensions as Record<string, unknown>
    if (!isPositiveInteger(dimensions.width) || !isPositiveInteger(dimensions.height)) return false
  }
  if (item.durationSeconds !== undefined && !isPositiveFiniteNumber(item.durationSeconds)) {
    return false
  }
  return true
}

export function isHyperframesCatalogSuccess(input: unknown): input is HyperframesCatalogSuccess {
  if (typeof input !== 'object' || input === null) return false
  const payload = input as Record<string, unknown>
  if (payload.ok !== true) return false
  if (payload.schemaVersion !== 1) return false
  if (payload.source !== 'hyperframes') return false
  if (payload.advisoryOnly !== true) return false
  if (payload.capabilityVerified !== false) return false
  if (!Array.isArray(payload.items)) return false
  if (!payload.items.every((entry) => isHyperframesCatalogItem(entry))) return false
  if (!Array.isArray(payload.warnings) || !payload.warnings.every((entry) => typeof entry === 'string')) {
    return false
  }
  if (typeof payload.summary !== 'object' || payload.summary === null) return false
  const summary = payload.summary as Record<string, unknown>
  if (
    !isNonNegativeInteger(summary.total)
    || !isNonNegativeInteger(summary.returned)
    || !isNonNegativeInteger(summary.omitted)
  ) {
    return false
  }
  if (typeof summary.byType !== 'object' || summary.byType === null) return false
  const byType = summary.byType as Record<string, unknown>
  if (!isNonNegativeInteger(byType.block) || !isNonNegativeInteger(byType.component)) return false
  return true
}

export function estimateHyperframesHintCategory(
  tags: readonly string[],
): HyperframesHintCategory {
  const normalized = new Set(tags.map((tag) => tag.toLowerCase()))
  for (const matcher of CATEGORY_TAG_MATCHERS) {
    if (matcher.tags.some((tag) => normalized.has(tag))) {
      return matcher.category
    }
  }
  return 'その他'
}

export type HyperframesCatalogFilters = {
  query: string
  type: 'all' | HyperframesCatalogItemType
  category: 'all' | HyperframesHintCategory
  tag: string | null
}

export const INITIAL_HYPERFRAMES_CATALOG_FILTERS: HyperframesCatalogFilters = {
  query: '',
  type: 'all',
  category: 'all',
  tag: null,
}

export function collectHyperframesCatalogTags(
  items: readonly HyperframesCatalogItem[],
): string[] {
  const tags = new Set<string>()
  for (const item of items) {
    for (const tag of item.tags) tags.add(tag)
  }
  return [...tags].sort((left, right) => left.localeCompare(right))
}

export function filterHyperframesCatalogItems(
  items: readonly HyperframesCatalogItem[],
  filters: HyperframesCatalogFilters,
): HyperframesCatalogItem[] {
  const query = filters.query.trim().toLowerCase()
  return items.filter((item) => {
    if (filters.type !== 'all' && item.type !== filters.type) return false
    if (filters.tag && !item.tags.includes(filters.tag)) return false
    if (filters.category !== 'all') {
      if (estimateHyperframesHintCategory(item.tags) !== filters.category) return false
    }
    if (!query) return true
    const haystack = [
      item.id,
      item.title,
      item.description,
      ...item.tags,
      estimateHyperframesHintCategory(item.tags),
    ].join(' ').toLowerCase()
    return haystack.includes(query)
  })
}

export function pageHyperframesCatalogItems(
  items: readonly HyperframesCatalogItem[],
  visibleCount: number,
): HyperframesCatalogItem[] {
  return items.slice(0, Math.max(0, visibleCount))
}

export function formatHyperframesCatalogDimensions(
  dimensions: HyperframesCatalogItem['dimensions'],
): string | null {
  if (!dimensions) return null
  return `${dimensions.width}×${dimensions.height}`
}

export function formatHyperframesCatalogDuration(
  durationSeconds: number | undefined,
): string | null {
  if (durationSeconds === undefined) return null
  if (Number.isInteger(durationSeconds)) return `${durationSeconds}秒`
  return `${durationSeconds}秒`
}
