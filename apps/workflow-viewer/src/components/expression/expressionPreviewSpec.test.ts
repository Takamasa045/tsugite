import { describe, expect, it } from 'vitest'

import type { ExpressionItem } from './expressionLibraryModel'
import { normalizeHyperframesCatalogItem, normalizePresentationPreset } from './expressionLibraryModel'
import {
  buildExpressionPreviewSpec,
  EXPRESSION_PREVIEW_SAMPLE_TEXT,
  previewSpecCssVars,
  stableHash,
} from './expressionPreviewSpec'

function baseItem(overrides: Partial<ExpressionItem> = {}): ExpressionItem {
  return {
    key: 'reference-catalog::hyperframes::unknown::sample',
    provider: 'hyperframes',
    nativeId: 'sample',
    title: 'Sample',
    description: 'A sample expression',
    tags: [],
    role: 'other',
    category: 'その他',
    aspect: '16:9',
    durationSeconds: null,
    capability: 'reference-only',
    availability: 'reference-catalog',
    previewFidelity: 'motion-hint',
    family: 'sample',
    tone: [],
    pace: [],
    features: [],
    brandLock: false,
    source: 'reference-catalog',
    ...overrides,
  }
}

describe('expressionPreviewSpec', () => {
  it('keeps keyword rule order stable across many resolves (module-level rules)', () => {
    const items = Array.from({ length: 24 }, (_, index) => baseItem({
      nativeId: `batch-${index}`,
      title: index % 2 === 0 ? 'Typewriter caption 文字' : 'Data chart 図表',
      description: index % 2 === 0 ? 'text overlay' : 'statistics bars',
      tags: index % 2 === 0 ? ['text', 'caption'] : ['data', 'chart'],
      role: index % 2 === 0 ? 'text-overlay' : 'data-viz',
    }))
    const families = items.map((item) => buildExpressionPreviewSpec(item).family)
    expect(families.filter((family) => family === 'typewriter').length).toBe(12)
    expect(families.filter((family) => family === 'bars').length).toBe(12)
    // Same metadata still matches the same family after many builds
    expect(buildExpressionPreviewSpec(items[0]!).family).toBe('typewriter')
    expect(buildExpressionPreviewSpec(items[1]!).family).toBe('bars')
  })

  it('is deterministic for the same metadata', () => {
    const item = baseItem({
      nativeId: 'typewriter-caption',
      title: 'Typewriter Caption',
      description: 'Text typewriter effect',
      tags: ['text', 'caption'],
      role: 'text-overlay',
    })
    const a = buildExpressionPreviewSpec(item)
    const b = buildExpressionPreviewSpec(item)
    expect(a).toEqual(b)
    expect(a.signature).toBe(b.signature)
    expect(a.sampleText).toBe(EXPRESSION_PREVIEW_SAMPLE_TEXT)
    expect(a.conceptualOnly).toBe(true)
  })

  it('gives different signatures for different nativeIds even with the same role', () => {
    const a = buildExpressionPreviewSpec(baseItem({
      nativeId: 'fade-soft-a',
      title: 'Soft Fade A',
      role: 'auxiliary',
      tags: ['fade'],
    }))
    const b = buildExpressionPreviewSpec(baseItem({
      nativeId: 'fade-soft-b',
      title: 'Soft Fade B',
      role: 'auxiliary',
      tags: ['fade'],
    }))
    expect(a.role).toBe(b.role)
    expect(a.signature).not.toBe(b.signature)
  })

  it('maps metadata keywords to expected motion families', () => {
    expect(buildExpressionPreviewSpec(baseItem({
      nativeId: 'tw-1',
      title: 'Typewriter',
      tags: ['typewriter', 'text'],
      role: 'text-overlay',
    })).family).toBe('typewriter')

    expect(buildExpressionPreviewSpec(baseItem({
      nativeId: 'chart-1',
      title: 'Bar Chart',
      tags: ['data', 'chart'],
      role: 'data-viz',
    })).family).toBe('bars')

    expect(buildExpressionPreviewSpec(baseItem({
      nativeId: 'wipe-1',
      title: 'Wipe Transition',
      tags: ['wipe', 'transition'],
      role: 'transition',
    })).family).toBe('wipe')

    expect(buildExpressionPreviewSpec(baseItem({
      nativeId: 'shader-1',
      title: 'Shader Mesh',
      tags: ['3d', 'shader'],
      role: '3d-shader',
    })).family).toBe('orbit')

    expect(buildExpressionPreviewSpec(baseItem({
      nativeId: 'glitch-1',
      title: 'Glitch Hit',
      tags: ['glitch'],
      role: 'other',
    })).family).toBe('glitch')

    expect(buildExpressionPreviewSpec(baseItem({
      nativeId: 'code-1',
      title: 'Terminal Lines',
      tags: ['code', 'dev'],
      role: 'code-dev',
    })).family).toBe('line-draw')
  })

  it('does not treat executable-candidate as cut / wipe via partial English match', () => {
    const item = baseItem({
      nativeId: 'article-dialogue-16x9',
      title: '横型・会話で解説',
      description: '記事を会話で伝える',
      tags: ['remotion', '16:9', 'presentation-preset', 'executable-candidate'],
      features: ['remotion', '16:9', 'presentation-preset', 'executable-candidate'],
      role: 'full-composition',
      source: 'presentation-preset',
      capability: 'declared-executable-candidate',
      previewFidelity: 'composition-storyboard',
    })
    const spec = buildExpressionPreviewSpec(item)
    // "cut" inside executable-candidate must not force wipe
    expect(spec.family).not.toBe('wipe')
    // full-composition falls through to hash pick among stack/slide/fade/scale
    expect(['stack', 'slide', 'fade', 'scale']).toContain(spec.family)
  })

  it('matches whole-token cut as wipe but not substrings of other English words', () => {
    expect(buildExpressionPreviewSpec(baseItem({
      nativeId: 'hard-cut',
      title: 'Hard Cut',
      description: 'A hard cut transition',
      tags: ['cut'],
      role: 'transition',
    })).family).toBe('wipe')

    expect(buildExpressionPreviewSpec(baseItem({
      nativeId: 'shortcut-hint',
      title: 'Shortcut Panel',
      description: 'UI shortcut list for operators',
      tags: ['shortcut', 'panel'],
      role: 'other',
    })).family).not.toBe('wipe')
  })

  it('does not collapse real presentation presets to a single motion family', () => {
    const presets = [
      normalizePresentationPreset({
        backend: 'remotion',
        backendLabel: 'Remotion',
        id: 'article-dialogue-16x9',
        label: '横型・会話で解説',
        description: '記事を会話で伝える',
        aspectRatio: '16:9',
      }),
      normalizePresentationPreset({
        backend: 'remotion',
        backendLabel: 'Remotion',
        id: 'street-dialogue-16x9',
        label: '横型・テンポ重視の会話解説',
        description: 'テンポよく',
        aspectRatio: '16:9',
      }),
      normalizePresentationPreset({
        backend: 'remotion',
        backendLabel: 'Remotion',
        id: 'miraichi-lastcall-9x16',
        label: '縦型・締切／申込案内',
        description: '縦型案内',
        aspectRatio: '9:16',
      }),
      normalizePresentationPreset({
        backend: 'remotion',
        backendLabel: 'Remotion',
        id: 'tsugite-summer-camp-generated-16x9',
        label: '横型・ブランド固定キャンプ',
        description: 'ブランド固定',
        aspectRatio: '16:9',
      }),
      normalizePresentationPreset({
        backend: 'remotion',
        backendLabel: 'Remotion',
        id: 'orbital-showreel-16x9',
        label: '横型・作品ダイジェスト',
        description: 'ダイジェスト',
        aspectRatio: '16:9',
      }),
      normalizePresentationPreset({
        backend: 'hyperframes',
        backendLabel: 'HyperFrames',
        id: 'article-explainer-16x9',
        label: '横型・資料付き解説',
        description: '資料付き',
        aspectRatio: '16:9',
      }),
      normalizePresentationPreset({
        backend: 'hyperframes',
        backendLabel: 'HyperFrames',
        id: 'article-explainer-9x16',
        label: '縦型・資料付き解説',
        description: '縦型資料',
        aspectRatio: '9:16',
      }),
    ]
    expect(presets).toHaveLength(7)
    const families = presets.map((preset) => buildExpressionPreviewSpec(preset).family)
    // Regression: previously 6/7 collapsed to wipe via executable-candidate ⊆ cut
    expect(families.filter((family) => family === 'wipe').length).toBeLessThan(presets.length)
    expect(new Set(families).size).toBeGreaterThan(1)
    // Catalog metadata only — do not claim faithful official demos
    for (const preset of presets) {
      const note = buildExpressionPreviewSpec(preset).fidelityNote
      expect(note).toMatch(/概念見本/)
      expect(note).toMatch(/実際の構成・動きの再現ではありません/)
    }
  })

  it('marks catalog items as conceptual-only fidelity notes, not official reproductions', () => {
    const catalog = normalizeHyperframesCatalogItem({
      id: 'data-chart',
      type: 'component',
      title: 'Data Chart',
      description: 'Animated chart',
      tags: ['data', 'chart'],
      dimensions: { width: 1920, height: 1080 },
      durationSeconds: 8,
    })
    const spec = buildExpressionPreviewSpec(catalog)
    expect(spec.fidelityNote).toMatch(/概念見本/)
    expect(spec.fidelityNote).toMatch(/公式実装の再現ではありません/)
    expect(spec.fidelity).toBe('motion-hint')
    // dimensions / duration must not upgrade fidelity
    expect(spec.fidelity).not.toBe('media-preview')
  })

  it('marks presentation presets as conceptual samples from name/description, not composition reproduction', () => {
    const preset = normalizePresentationPreset({
      backend: 'remotion',
      backendLabel: 'Remotion',
      id: 'article-dialogue-16x9',
      label: '横型・会話で解説',
      description: '記事を会話で伝える',
      aspectRatio: '16:9',
    })
    const spec = buildExpressionPreviewSpec(preset)
    expect(spec.fidelityNote).toMatch(/候補名や説明から作った概念見本/)
    expect(spec.fidelityNote).toMatch(/実際の構成・動きの再現ではありません/)
    expect(spec.fidelityNote).not.toMatch(/画面構成の概略/)
    expect(spec.fidelity).toBe('composition-storyboard')
  })

  it('exposes transform/opacity oriented CSS vars from the signature', () => {
    const spec = buildExpressionPreviewSpec(baseItem({
      nativeId: 'slide-left',
      title: 'Slide',
      tags: ['slide'],
    }))
    const vars = previewSpecCssVars(spec)
    expect(vars['--expr-preview-duration']).toMatch(/ms$/)
    expect(vars['--expr-preview-delay']).toMatch(/ms$/)
    expect(vars['--expr-preview-distance']).toMatch(/px$/)
    expect(Number(vars['--expr-preview-intensity'])).toBeGreaterThan(0)
  })

  it('stableHash is pure and sensitive to input', () => {
    expect(stableHash('abc')).toBe(stableHash('abc'))
    expect(stableHash('abc')).not.toBe(stableHash('abd'))
  })
})
