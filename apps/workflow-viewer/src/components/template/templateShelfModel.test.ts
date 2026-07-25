import { describe, expect, it } from 'vitest'

import {
  applyAxisChoice,
  buildTemplateBriefMarkdown,
  checklistStep,
  defaultOptionIdFor,
  fillDefaultsToChecklist,
  initialChoicesForTemplate,
  partitionRequiredInputs,
  resolveDirectionLines,
  resolveExampleLines,
  resolvePromptGuidesForBrief,
  resolveRequiredInputDetails,
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
      {
        id: 'peer-dialogue',
        label: '同僚同士',
        description: '同僚',
        directionAdd: { camera: '二人を同じ画角で並べすぎない' },
        requiredInputsAdd: ['任意BGM'],
      },
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
      {
        id: 'brisk',
        label: 'テンポ良く',
        description: '早め',
        directionAdd: { pacing: 'フックは0.5秒以内、最長カット2秒' },
        examples: {
          good: ['0.5秒で問いを出し、2秒以内に答えの輪郭を見せる'],
          monotonous: ['全カット3秒均等で同じプッシュインを繰り返す'],
        },
        promptGuideCatalog: 'pixverse',
      },
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
  direction: {
    pacing: '冒頭2秒以内にフック',
    camera: '1ショット1カメラベクトル',
  },
  promptGuides: [
    {
      catalogId: 'pixverse',
      displayName: 'PixVerse',
      disclaimer: 'カタログの存在は実行能力を証明しません。',
      checklist: [
        { id: 'one-camera-vector', instruction: 'Use one primary camera movement.' },
      ],
    },
  ],
} satisfies Pick<
  LauncherTemplate,
  | 'name'
  | 'summary'
  | 'variants'
  | 'requiredInputDetails'
  | 'notFor'
  | 'audio'
  | 'direction'
  | 'promptGuides'
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

  it('resolveRequiredInputDetails は option の requiredInputsAdd で任意を必須へ昇格する', () => {
    const base = resolveRequiredInputDetails(template, { cast: 'beginner-expert' })
    expect(base.find((item) => item.label === '任意BGM')?.required).toBe(false)

    const promoted = resolveRequiredInputDetails(template, { cast: 'peer-dialogue' })
    expect(promoted.find((item) => item.label === '任意BGM')?.required).toBe(true)
    expect(promoted.find((item) => item.label === '記事本文')?.required).toBe(true)

    const md = buildTemplateBriefMarkdown(template, { cast: 'peer-dialogue' })
    // 必須側に昇格した任意BGMが載る（任意セクションに残らない）
    expect(md).toMatch(/### 必須[\s\S]*任意BGM/)
    expect(md).not.toMatch(/### 任意[\s\S]*任意BGM/)
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

  it('buildTemplateBriefMarkdown に演出指針を含める（無い場合はセクションを出さない）', () => {
    const withDirection = buildTemplateBriefMarkdown(template, { cast: 'peer-dialogue' })
    expect(withDirection).toContain('## 演出指針')
    expect(withDirection).toContain('**テンポ**: 冒頭2秒以内にフック')
    expect(withDirection).toContain('**カメラ**: 1ショット1カメラベクトル')

    const withoutDirection = buildTemplateBriefMarkdown(
      { ...template, direction: undefined },
      { cast: 'beginner-expert' },
    )
    expect(withoutDirection).not.toContain('## 演出指針')
  })

  it('resolveDirectionLines は base と選択 option の direction_add を和集合で並べる', () => {
    const lines = resolveDirectionLines(template, {
      cast: 'peer-dialogue',
      pace: 'brisk',
    })
    expect(lines).toEqual([
      { label: 'テンポ', text: '冒頭2秒以内にフック' },
      { label: 'カメラ', text: '1ショット1カメラベクトル' },
      { label: 'カメラ', text: '二人を同じ画角で並べすぎない', source: '同僚同士' },
      { label: 'テンポ', text: 'フックは0.5秒以内、最長カット2秒', source: 'テンポ良く' },
    ])

    const md = buildTemplateBriefMarkdown(template, {
      cast: 'peer-dialogue',
      pace: 'brisk',
    })
    expect(md).toContain('**カメラ（同僚同士）**: 二人を同じ画角で並べすぎない')
    expect(md).toContain('**テンポ（テンポ良く）**: フックは0.5秒以内、最長カット2秒')
  })

  it('examples と prompt guide をブリーフへ合流する', () => {
    const examples = resolveExampleLines(template, { pace: 'brisk' })
    expect(examples).toEqual([
      {
        kind: 'good',
        optionLabel: 'テンポ良く',
        text: '0.5秒で問いを出し、2秒以内に答えの輪郭を見せる',
      },
      {
        kind: 'monotonous',
        optionLabel: 'テンポ良く',
        text: '全カット3秒均等で同じプッシュインを繰り返す',
      },
    ])

    const guides = resolvePromptGuidesForBrief(template, { pace: 'brisk' })
    expect(guides.map((guide) => guide.catalogId)).toEqual(['pixverse'])

    const md = buildTemplateBriefMarkdown(template, { pace: 'brisk' })
    expect(md).toContain('## 具体例')
    expect(md).toContain('### 良い例')
    expect(md).toContain('### 単調な例（避ける）')
    expect(md).toContain('## 生成プロンプトの書式')
    expect(md).toContain('Use one primary camera movement.')
    expect(md).toContain('カタログの存在は実行能力を証明しません。')
  })
})
