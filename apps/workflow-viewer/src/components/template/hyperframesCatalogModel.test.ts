import { describe, expect, it } from 'vitest'

import {
  collectHyperframesCatalogTags,
  estimateHyperframesHintCategory,
  filterHyperframesCatalogItems,
  formatHyperframesCatalogDimensions,
  formatHyperframesCatalogDuration,
  HYPERFRAMES_CATALOG_PAGE_SIZE,
  isHyperframesCatalogSuccess,
  pageHyperframesCatalogItems,
  type HyperframesCatalogItem,
} from './hyperframesCatalogModel'

const items: HyperframesCatalogItem[] = [
  {
    id: 'data-chart',
    type: 'block',
    title: 'Data Chart',
    description: 'Animated bar chart',
    tags: ['data', 'chart'],
    dimensions: { width: 1920, height: 1080 },
    durationSeconds: 15,
  },
  {
    id: 'code-typewriter',
    type: 'component',
    title: 'Code Typewriter',
    description: 'Typing code on screen',
    tags: ['code', 'syntax'],
  },
  {
    id: 'subtitle-bar',
    type: 'component',
    title: 'Subtitle Bar',
    description: 'Lower third style caption',
    tags: ['subtitle', 'overlay'],
  },
  {
    id: 'logo-outro',
    type: 'block',
    title: 'Logo Outro',
    description: 'Brand outro',
    tags: ['branding', 'logo'],
  },
]

const validSuccess = {
  ok: true as const,
  schemaVersion: 1 as const,
  source: 'hyperframes' as const,
  advisoryOnly: true as const,
  capabilityVerified: false as const,
  summary: {
    total: 1,
    returned: 1,
    omitted: 0,
    byType: { block: 1, component: 0 },
  },
  items: [items[0]!],
  warnings: [] as string[],
}

describe('hyperframesCatalogModel', () => {
  it('accepts only advisory success payloads with full summary and warnings', () => {
    expect(isHyperframesCatalogSuccess(validSuccess)).toBe(true)

    expect(isHyperframesCatalogSuccess({
      ...validSuccess,
      advisoryOnly: false,
    })).toBe(false)

    expect(isHyperframesCatalogSuccess({
      ...validSuccess,
      summary: { total: 1, returned: 1, omitted: 0 },
    })).toBe(false)

    expect(isHyperframesCatalogSuccess({
      ...validSuccess,
      summary: {
        total: 1,
        returned: 1,
        omitted: 0,
        byType: { block: '1', component: 0 },
      },
    })).toBe(false)

    expect(isHyperframesCatalogSuccess({
      ...validSuccess,
      warnings: undefined,
    })).toBe(false)
  })

  it('rejects malformed items without throwing', () => {
    expect(isHyperframesCatalogSuccess({
      ...validSuccess,
      items: [{
        id: 'bad',
        type: 'block',
        title: 'Bad',
        description: 'x',
        tags: ['data'],
        dimensions: { width: -1, height: 1080 },
      }],
    })).toBe(false)

    expect(isHyperframesCatalogSuccess({
      ...validSuccess,
      items: [{
        id: 'bad',
        type: 'block',
        title: 'Bad',
        description: 'x',
        tags: ['data'],
        durationSeconds: 0,
      }],
    })).toBe(false)

    expect(isHyperframesCatalogSuccess({
      ...validSuccess,
      items: [null],
    })).toBe(false)

    expect(isHyperframesCatalogSuccess(null)).toBe(false)
    expect(isHyperframesCatalogSuccess(undefined)).toBe(false)
    expect(isHyperframesCatalogSuccess('nope')).toBe(false)
  })

  it('estimates Tsugite categories from tags without treating them as official categories', () => {
    expect(estimateHyperframesHintCategory(['data', 'chart'])).toBe('データ・図表')
    expect(estimateHyperframesHintCategory(['code'])).toBe('コード・開発画面')
    expect(estimateHyperframesHintCategory(['subtitle'])).toBe('文字・字幕')
    expect(estimateHyperframesHintCategory(['transition'])).toBe('切り替え')
    expect(estimateHyperframesHintCategory(['overlay'])).toBe('補助表示')
    expect(estimateHyperframesHintCategory(['shader'])).toBe('3D・シェーダー')
    expect(estimateHyperframesHintCategory(['tiktok'])).toBe('SNS・配信')
    expect(estimateHyperframesHintCategory(['branding'])).toBe('その他')
  })

  it('filters by query, type, estimated category, and tag', () => {
    const filtered = filterHyperframesCatalogItems(items, {
      query: 'chart',
      type: 'block',
      category: 'データ・図表',
      tag: 'data',
    })
    expect(filtered.map((item) => item.id)).toEqual(['data-chart'])

    const byCategory = filterHyperframesCatalogItems(items, {
      query: '',
      type: 'all',
      category: '文字・字幕',
      tag: null,
    })
    expect(byCategory.map((item) => item.id)).toEqual(['subtitle-bar'])
  })

  it('pages results and formats optional metadata', () => {
    expect(HYPERFRAMES_CATALOG_PAGE_SIZE).toBe(12)
    expect(pageHyperframesCatalogItems(items, 2).map((item) => item.id)).toEqual([
      'data-chart',
      'code-typewriter',
    ])
    expect(collectHyperframesCatalogTags(items)).toEqual([
      'branding',
      'chart',
      'code',
      'data',
      'logo',
      'overlay',
      'subtitle',
      'syntax',
    ])
    expect(formatHyperframesCatalogDimensions(items[0]?.dimensions)).toBe('1920×1080')
    expect(formatHyperframesCatalogDuration(15)).toBe('15秒')
    expect(formatHyperframesCatalogDuration(undefined)).toBeNull()
  })
})
