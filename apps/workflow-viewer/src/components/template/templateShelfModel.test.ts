import { describe, expect, it } from 'vitest'

import {
  applyAxisChoice,
  buildTemplateBriefMarkdown,
  checklistStep,
  defaultOptionIdFor,
  fillDefaultsToChecklist,
  initialChoicesForTemplate,
  partitionRequiredInputs,
  type LauncherTemplate,
  type TemplateVariant,
} from './templateShelfModel'

const variants: TemplateVariant[] = [
  {
    id: 'cast',
    label: 'キャラクター構成',
    defaultOptionId: 'beginner-expert',
    options: [
      { id: 'beginner-expert', label: '初心者＋専門家', description: '定番' },
      { id: 'peer-dialogue', label: '同僚同士', description: '同僚' },
    ],
  },
  {
    id: 'background',
    label: '背景',
    defaultOptionId: 'paper-cutout',
    options: [
      { id: 'paper-cutout', label: '紙の切り絵', description: '紙' },
      { id: 'ui-window', label: '画面デモ', description: 'UI' },
    ],
  },
  {
    id: 'pace',
    label: 'テンポ',
    options: [
      { id: 'calm', label: '落ち着いた', description: '余白' },
      { id: 'brisk', label: 'テンポ良く', description: '早め' },
    ],
  },
]

const template = {
  name: 'ブログ掛け合い 60秒',
  summary: '記事を会話で伝える',
  variants,
  requiredInputDetails: [
    { type: 'text' as const, label: '記事本文', required: true },
    { type: 'audio' as const, label: '任意BGM', required: false },
    { type: 'image' as const, label: '画像（フラグなし）' },
  ],
  notFor: ['無言の商品映像'],
  audio: '音声は任意です。',
} satisfies Pick<
  LauncherTemplate,
  'name' | 'summary' | 'variants' | 'requiredInputDetails' | 'notFor' | 'audio'
>

describe('templateShelfModel', () => {
  it('checklistStep は軸数+1', () => {
    expect(checklistStep([])).toBe(1)
    expect(checklistStep(variants)).toBe(4)
  })

  it('defaultOptionIdFor は default がなければ先頭 option', () => {
    expect(defaultOptionIdFor(variants[0]!)).toBe('beginner-expert')
    expect(defaultOptionIdFor(variants[2]!)).toBe('calm')
  })

  it('initialChoicesForTemplate は先頭軸の default のみ事前選択', () => {
    expect(initialChoicesForTemplate({ ...template, variants } as LauncherTemplate)).toEqual({
      cast: 'beginner-expert',
    })
    expect(initialChoicesForTemplate({
      ...template,
      variants: [{ ...variants[2]! }],
    } as LauncherTemplate)).toEqual({})
  })

  it('初回の軸選択は次軸 default を事前選択し step を進める', () => {
    const result = applyAxisChoice(variants, {}, 0, 'beginner-expert')
    expect(result.step).toBe(2)
    expect(result.choices).toEqual({
      cast: 'beginner-expert',
      background: 'paper-cutout',
    })
  })

  it('同一 option 再確定でも次軸 default を付ける', () => {
    const result = applyAxisChoice(
      variants,
      { cast: 'beginner-expert' },
      0,
      'beginner-expert',
    )
    expect(result.choices.background).toBe('paper-cutout')
    expect(result.step).toBe(2)
  })

  it('上流変更で下流 choices をリセットし、次軸 default は付けない', () => {
    const result = applyAxisChoice(
      variants,
      {
        cast: 'beginner-expert',
        background: 'ui-window',
        pace: 'brisk',
      },
      0,
      'peer-dialogue',
    )
    expect(result.choices).toEqual({ cast: 'peer-dialogue' })
    expect(result.choices.background).toBeUndefined()
    expect(result.choices.pace).toBeUndefined()
    expect(result.step).toBe(2)
  })

  it('fillDefaultsToChecklist は未選択を default→先頭で埋める', () => {
    const result = fillDefaultsToChecklist(variants, { cast: 'peer-dialogue' })
    expect(result.step).toBe(4)
    expect(result.choices).toEqual({
      cast: 'peer-dialogue',
      background: 'paper-cutout',
      pace: 'calm',
    })
  })

  it('partitionRequiredInputs は required===false のみ任意、未指定は必須扱い', () => {
    const { required, optional } = partitionRequiredInputs(template.requiredInputDetails)
    expect(required.map((item) => item.label)).toEqual(['記事本文', '画像（フラグなし）'])
    expect(optional.map((item) => item.label)).toEqual(['任意BGM'])
  })

  it('buildTemplateBriefMarkdown に型名・軸・必須/任意を含める', () => {
    const md = buildTemplateBriefMarkdown(template, {
      cast: 'peer-dialogue',
      background: 'ui-window',
      pace: 'calm',
    })
    expect(md).toContain('# ブログ掛け合い 60秒')
    expect(md).toContain('キャラクター構成')
    expect(md).toContain('同僚同士')
    expect(md).toContain('記事本文')
    expect(md).toContain('任意BGM')
    expect(md).toContain('無言の商品映像')
  })
})
