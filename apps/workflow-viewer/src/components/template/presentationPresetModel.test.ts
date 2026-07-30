import { describe, expect, it } from 'vitest'

import {
  aspectRatioFromPresetId,
  formatPresentationPresetPromptSection,
  isPresentationPresetListResponse,
  labelForPresentationPreset,
  mergePresentationPresetOptions,
  PRESENTATION_PRESET_SAFETY_NOTE,
  toPresentationPresetOptions,
} from './presentationPresetModel'

describe('presentationPresetModel', () => {
  it('accepts wire responses with backend and preset ids only', () => {
    expect(isPresentationPresetListResponse({
      ok: true,
      backend: 'remotion',
      presets: ['article-dialogue-16x9', 'miraichi-lastcall-9x16'],
    })).toBe(true)

    expect(isPresentationPresetListResponse({
      ok: true,
      backend: 'remotion',
      presets: ['ok'],
      path: '/secret',
    })).toBe(true)

    expect(isPresentationPresetListResponse({ ok: false, backend: 'remotion', presets: [] })).toBe(false)
    expect(isPresentationPresetListResponse({ ok: true, backend: '', presets: [] })).toBe(false)
    expect(isPresentationPresetListResponse({ ok: true, backend: 'remotion', presets: [1] })).toBe(false)
  })

  it('derives aspect ratio and purpose labels, keeping unknown ids visible', () => {
    expect(aspectRatioFromPresetId('article-dialogue-16x9')).toBe('16:9')
    expect(aspectRatioFromPresetId('miraichi-lastcall-9x16')).toBe('9:16')
    expect(aspectRatioFromPresetId('custom-unknown')).toBeNull()

    expect(labelForPresentationPreset('article-dialogue-16x9')).toMatch(/記事|掛け合い/)
    expect(labelForPresentationPreset('brand-new-unlisted-preset')).toBe('brand-new-unlisted-preset')
  })

  it('builds UI options without dropping unknown ids', () => {
    const options = toPresentationPresetOptions('remotion', [
      'article-dialogue-16x9',
      'brand-new-unlisted-preset',
    ])
    expect(options).toEqual([
      {
        backend: 'remotion',
        backendLabel: 'Remotion',
        id: 'article-dialogue-16x9',
        label: labelForPresentationPreset('article-dialogue-16x9'),
        aspectRatio: '16:9',
      },
      {
        backend: 'remotion',
        backendLabel: 'Remotion',
        id: 'brand-new-unlisted-preset',
        label: 'brand-new-unlisted-preset',
        aspectRatio: null,
      },
    ])
  })

  it('merges remotion and hyperframes in a stable order', () => {
    const merged = mergePresentationPresetOptions([
      { ok: true, backend: 'hyperframes', presets: ['article-explainer-16x9'] },
      { ok: true, backend: 'remotion', presets: ['article-dialogue-16x9'] },
    ])
    expect(merged.map((entry) => `${entry.backend}:${entry.id}`)).toEqual([
      'remotion:article-dialogue-16x9',
      'hyperframes:article-explainer-16x9',
    ])
  })

  it('formats a safety-aware prompt section only when a preset is selected', () => {
    expect(formatPresentationPresetPromptSection(null)).toBe('')

    const section = formatPresentationPresetPromptSection({
      backend: 'remotion',
      presetId: 'article-dialogue-16x9',
    })
    expect(section).toContain('## 仕上げの動き（presentation preset）')
    expect(section).toContain('remotion')
    expect(section).toContain('article-dialogue-16x9')
    expect(section).toContain(PRESENTATION_PRESET_SAFETY_NOTE)
    expect(section).toMatch(/validate|Gate 1/)
  })
})
