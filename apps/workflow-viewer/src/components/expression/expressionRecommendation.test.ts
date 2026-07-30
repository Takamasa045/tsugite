import { describe, expect, it } from 'vitest'
import type { HyperframesCatalogItem } from '../template/hyperframesCatalogModel'
import type { PresentationPresetOption } from '../template/presentationPresetModel'
import {
  normalizeHyperframesCatalogItem,
  normalizePresentationPreset,
  type ExpressionItem,
} from './expressionLibraryModel'
import {
  LEXICON_VERSION,
  recommendExpressions,
  type RecommendationIntent,
} from './expressionRecommendation'

const presets: PresentationPresetOption[] = [
  {
    backend: 'remotion',
    backendLabel: 'Remotion',
    id: 'article-dialogue-16x9',
    label: '横型・会話で解説',
    description: '記事やテーマを会話のやりとりでわかりやすく伝える',
    aspectRatio: '16:9',
  },
  {
    backend: 'remotion',
    backendLabel: 'Remotion',
    id: 'street-dialogue-16x9',
    label: '横型・テンポ重視の会話解説',
    description: 'テンポよく会話が進む解説',
    aspectRatio: '16:9',
  },
  {
    backend: 'remotion',
    backendLabel: 'Remotion',
    id: 'miraichi-lastcall-9x16',
    label: '縦型・締切／申込案内',
    description: '締切や申込案内など縦型SNS向け',
    aspectRatio: '9:16',
  },
  {
    backend: 'remotion',
    backendLabel: 'Remotion',
    id: 'orbital-showreel-16x9',
    label: '横型・作品ダイジェスト',
    description: '作品や事例をダイジェストで見せる',
    aspectRatio: '16:9',
  },
  {
    backend: 'remotion',
    backendLabel: 'Remotion',
    id: 'tsugite-summer-camp-generated-16x9',
    label: '横型・イベント／サービス告知',
    description: 'イベントやサービスの告知募集',
    aspectRatio: '16:9',
  },
  {
    backend: 'hyperframes',
    backendLabel: 'HyperFrames',
    id: 'article-explainer-16x9',
    label: '横型・資料付き解説',
    description: '資料や図解を交えて解説する横型',
    aspectRatio: '16:9',
  },
  {
    backend: 'hyperframes',
    backendLabel: 'HyperFrames',
    id: 'article-explainer-9x16',
    label: '縦型・資料付き解説',
    description: '資料や図解を交えて解説する縦型',
    aspectRatio: '9:16',
  },
]

const catalog: HyperframesCatalogItem[] = [
  {
    id: 'data-chart',
    type: 'component',
    title: 'Data Chart',
    description: 'Animated statistics chart',
    tags: ['data', 'chart', 'statistics'],
  },
  {
    id: 'code-terminal',
    type: 'component',
    title: 'Code Terminal',
    description: 'Developer terminal overlay',
    tags: ['code', 'terminal', 'dev'],
  },
  {
    id: 'typewriter',
    type: 'component',
    title: 'Typewriter',
    description: 'Subtitle typewriter text',
    tags: ['text', 'subtitle', 'caption'],
  },
  {
    id: 'shader-burst',
    type: 'block',
    title: 'Shader Burst',
    description: 'Flashy 3d shader particle burst',
    tags: ['3d', 'shader', 'particle', 'flashy', 'cinematic'],
  },
  {
    id: 'social-chat',
    type: 'component',
    title: 'Social Chat',
    description: 'Live chat stream overlay',
    tags: ['social', 'stream', 'chat'],
  },
  {
    id: 'brand-lock-badge',
    type: 'component',
    title: 'Brand Lock Badge',
    description: 'Fixed brand badge watermark',
    tags: ['brand', 'logo', 'fixed', 'watermark'],
  },
]

function library(): ExpressionItem[] {
  return [
    ...presets.map(normalizePresentationPreset),
    ...catalog.map(normalizeHyperframesCatalogItem),
  ]
}

describe('expressionRecommendation', () => {
  it('uses a versioned lexicon and returns deterministic 1-3 recommendations', () => {
    expect(LEXICON_VERSION).toMatch(/^v\d+/)
    const intent: RecommendationIntent = {
      freeText: '記事を会話でわかりやすく解説したい横型動画',
      aspect: '16:9',
      purpose: 'explainer',
      readiness: 'explore',
      reducedMotion: false,
      brandFixed: false,
      avoid: [],
    }
    const first = recommendExpressions(library(), intent)
    const second = recommendExpressions(library(), intent)
    expect(first.recommendations.length).toBeGreaterThanOrEqual(1)
    expect(first.recommendations.length).toBeLessThanOrEqual(3)
    expect(first.recommendations.map((entry) => entry.item.key)).toEqual(
      second.recommendations.map((entry) => entry.item.key),
    )
    expect(first.recommendations[0]?.score).toBeGreaterThanOrEqual(45)
    expect(first.recommendations[0]?.reasons.length).toBeGreaterThan(0)
    expect(first.recommendations[0]?.cautions.length).toBeGreaterThan(0)
    expect(first.recommendations[0]?.previewFidelity).toBeTruthy()
  })

  it('hard excludes explicit aspect mismatch', () => {
    const result = recommendExpressions(library(), {
      freeText: '縦型の申込案内',
      aspect: '9:16',
      purpose: 'promo',
      readiness: 'explore',
      reducedMotion: false,
      brandFixed: false,
      avoid: [],
    })
    expect(result.recommendations.every((entry) => (
      entry.item.aspect === '9:16' || entry.item.aspect === null || entry.item.aspect === 'unknown'
    ))).toBe(true)
    expect(result.recommendations.some((entry) => entry.item.nativeId === 'article-dialogue-16x9')).toBe(false)
  })

  it('hard excludes avoid terms and reduced-motion incompatible items', () => {
    const withAvoid = recommendExpressions(library(), {
      freeText: '静かな解説',
      aspect: '16:9',
      purpose: 'explainer',
      readiness: 'explore',
      reducedMotion: false,
      brandFixed: false,
      avoid: ['shader', '3d'],
    })
    expect(withAvoid.recommendations.every((entry) => entry.item.nativeId !== 'shader-burst')).toBe(true)

    const reduced = recommendExpressions(library(), {
      freeText: '落ち着いた解説',
      aspect: '16:9',
      purpose: 'explainer',
      readiness: 'explore',
      reducedMotion: true,
      brandFixed: false,
      avoid: [],
    })
    expect(reduced.recommendations.every((entry) => !entry.item.tags.includes('particle'))).toBe(true)
    expect(reduced.recommendations.every((entry) => entry.item.nativeId !== 'shader-burst')).toBe(true)
  })

  it('hard excludes brand lock mismatch and reference-only when readiness is ready', () => {
    const brand = recommendExpressions(library(), {
      freeText: 'brand fixed logo badge',
      aspect: 'any',
      purpose: 'other',
      readiness: 'explore',
      reducedMotion: false,
      brandFixed: true,
      avoid: [],
    })
    // brandFixed true: brandLock のない参考表現は除外。実行候補は可。
    expect(brand.recommendations.every((entry) => (
      entry.item.brandLock === true || entry.item.source === 'presentation-preset'
    ))).toBe(true)

    const ready = recommendExpressions(library(), {
      freeText: '資料付き解説をすぐ使いたい',
      aspect: '16:9',
      purpose: 'explainer',
      readiness: 'ready',
      reducedMotion: false,
      brandFixed: false,
      avoid: [],
    })
    expect(ready.recommendations.every((entry) => entry.item.capability !== 'reference-only')).toBe(true)
    expect(ready.recommendations.every((entry) => entry.executable)).toBe(true)
  })

  it('excludes brand-locked presentation presets from generic recommendations', () => {
    const generic = recommendExpressions(library(), {
      freeText: 'イベント 告知 ダイジェスト 作品 締切 申込 テンポ 会話',
      aspect: 'any',
      purpose: 'promo',
      readiness: 'explore',
      reducedMotion: false,
      brandFixed: false,
      avoid: [],
    })
    const brandIds = [
      'street-dialogue-16x9',
      'tsugite-summer-camp-generated-16x9',
      'miraichi-lastcall-9x16',
      'orbital-showreel-16x9',
    ]
    for (const id of brandIds) {
      expect(generic.recommendations.some((entry) => entry.item.nativeId === id)).toBe(false)
    }
    // 正規化上 brandLock が付いていること（ブラウズでは表示可）
    const normalized = presets.map(normalizePresentationPreset)
    for (const id of brandIds) {
      expect(normalized.find((item) => item.nativeId === id)?.brandLock).toBe(true)
    }

    // street-dialogue 単独の一般用途推薦でも出ない
    const streetOnly = recommendExpressions(library(), {
      freeText: 'テンポ重視の会話解説 street dialogue',
      aspect: '16:9',
      purpose: 'dialogue',
      readiness: 'explore',
      reducedMotion: false,
      brandFixed: false,
      avoid: [],
    })
    expect(streetOnly.recommendations.some((entry) => entry.item.nativeId === 'street-dialogue-16x9')).toBe(false)
  })

  it('penalizes excessive flashy motion and diversifies families', () => {
    const result = recommendExpressions(library(), {
      freeText: '落ち着いた記事解説 資料 chart data',
      aspect: '16:9',
      purpose: 'explainer',
      readiness: 'explore',
      reducedMotion: false,
      brandFixed: false,
      avoid: [],
    })
    const keys = result.recommendations.map((entry) => entry.item.key)
    const families = result.recommendations.map((entry) => entry.item.family)
    expect(new Set(families).size).toBe(families.length)
    // flashy shader should not outrank calm explainer matches
    if (keys.includes('hyperframes::shader-burst')) {
      const flashy = result.recommendations.find((entry) => entry.item.nativeId === 'shader-burst')
      expect(flashy?.score).toBeLessThan(60)
    }
  })

  it('returns a single clarification when nothing scores well', () => {
    const result = recommendExpressions(library(), {
      freeText: 'zzzz unknown gibberish xyzzy',
      aspect: '1:1' as RecommendationIntent['aspect'],
      purpose: 'other',
      readiness: 'ready',
      reducedMotion: true,
      brandFixed: true,
      avoid: ['dialogue', 'explainer', 'chart', 'text', 'article', 'showreel', 'event', 'social'],
    })
    expect(result.recommendations.length).toBe(0)
    expect(result.clarification).toBeTruthy()
    expect(result.clarification?.length).toBeGreaterThan(0)
  })

  it('bands scores: >=60 recommend, 45-59 reference, <45 not forced', () => {
    const result = recommendExpressions(library(), {
      freeText: '記事 会話 解説 横型',
      aspect: '16:9',
      purpose: 'explainer',
      readiness: 'explore',
      reducedMotion: false,
      brandFixed: false,
      avoid: [],
    })
    for (const entry of result.recommendations) {
      if (entry.score >= 60) expect(entry.band).toBe('recommend')
      else if (entry.score >= 45) expect(entry.band).toBe('reference')
      else expect(entry.band).toBe('insufficient')
    }
    expect(result.recommendations.every((entry) => entry.score >= 45)).toBe(true)
  })
})
