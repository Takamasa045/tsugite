/**
 * Phase 2 目標契約（RED）:
 * - export: TemplateShelf, TemplateWizardState
 * - props: templates, onStateChange?, initialState?
 * - step: 0=型選択, 1..n=各軸, n+1=チェックリスト
 * - Step 0 に検索ボックス・カテゴリチップは置かない
 * - 軸選択は自動で次へ / おすすめのまま進む / パンくずで戻る
 * - 上流変更で下流 choices をリセット、戻るだけでは保持
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { TemplateShelf, type TemplateWizardState } from './TemplateShelf'

type WizardTemplate = {
  id: string
  name: string
  summary: string
  category: string
  useCases: string[]
  duration: string
  aspectRatio: string
  speakers?: number
  requiredInputs: string[]
  requiredInputDetails: Array<{
    type: 'text' | 'image' | 'audio' | 'video' | 'data' | 'other'
    label: string
    required: boolean
  }>
  preview: {
    frames: Array<{ kind: 'text' | 'person' | 'interface'; label: string }>
    flow: string[]
  } | null
  notFor: string[]
  variants: Array<{
    id: string
    label: string
    defaultOptionId?: string
    options: Array<{ id: string; label: string; description: string }>
  }>
  tags: string[]
  audio: string
  status: 'stable' | 'experimental' | 'deprecated' | 'unknown'
  distribution: 'bundled' | 'local-only' | 'unknown'
  valid: boolean
  issue?: { code: string; message: string }
}

const validTemplate: WizardTemplate = {
  id: 'blog-dialogue-60s',
  name: 'ブログ掛け合い 60秒',
  summary: 'ブログ記事を初心者役と解説役の会話で伝える動画です。',
  category: '記事を動画化',
  useCases: ['ブログ記事', '初心者向け解説'],
  duration: '60秒',
  aspectRatio: '16:9',
  speakers: 2,
  requiredInputs: ['記事本文と出典', '2人分のキャラクター画像'],
  requiredInputDetails: [
    { type: 'text', label: '記事本文と出典', required: true },
    { type: 'image', label: '2人分のキャラクター画像', required: true },
    { type: 'audio', label: '任意のBGM', required: false },
  ],
  preview: {
    frames: [
      { kind: 'text', label: '記事の要点' },
      { kind: 'person', label: '初心者の質問' },
      { kind: 'interface', label: '解説とまとめ' },
    ],
    flow: ['記事の要点', '疑問を代弁', '専門家が解説', '要点を回収'],
  },
  notFor: ['実演だけで魅力が伝わる商品'],
  variants: [
    {
      id: 'cast',
      label: 'キャラクター構成',
      defaultOptionId: 'beginner-expert',
      options: [
        {
          id: 'beginner-expert',
          label: '初心者＋専門家',
          description: '初心者が問い、専門家が答える定番構成です。',
        },
        {
          id: 'peer-dialogue',
          label: '同僚同士',
          description: '同じ目線の二人で事例を整理します。',
        },
      ],
    },
    {
      id: 'background',
      label: '背景',
      defaultOptionId: 'paper-cutout',
      options: [
        {
          id: 'paper-cutout',
          label: '紙の切り絵',
          description: '紙素材と柔らかな陰影で見せます。',
        },
        {
          id: 'ui-window',
          label: '画面デモ',
          description: '製品画面や操作例を背景に表示します。',
        },
      ],
    },
    {
      id: 'pace',
      label: 'テンポ',
      // defaultOptionId なし → 事前選択なし
      options: [
        {
          id: 'calm',
          label: '落ち着いた',
          description: '余白多めの説明調です。',
        },
        {
          id: 'brisk',
          label: 'テンポよく',
          description: '要点を短く畳みます。',
        },
      ],
    },
  ],
  tags: ['掛け合い', '記事', '60秒'],
  audio: '音声とBGMは任意です。',
  status: 'stable',
  distribution: 'local-only',
  valid: true,
}

const invalidTemplate: WizardTemplate = {
  id: 'broken-template',
  name: 'broken-template',
  summary: '',
  category: '',
  useCases: [],
  duration: '',
  aspectRatio: '',
  requiredInputs: [],
  requiredInputDetails: [],
  preview: null,
  notFor: [],
  variants: [],
  tags: [],
  audio: '',
  status: 'unknown',
  distribution: 'unknown',
  valid: false,
  issue: {
    code: 'template_metadata.invalid',
    message: 'template.yamlの形式が正しくありません。',
  },
}

const templates = [validTemplate, invalidTemplate]

function latestState(onStateChange: ReturnType<typeof vi.fn>): TemplateWizardState {
  const calls = onStateChange.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][0] as TemplateWizardState
}

function progressNav() {
  return screen.getByRole('navigation', { name: 'ウィザードの進捗' })
}

describe('TemplateShelf', () => {
  it('初期は Step 0: 型カードだけを示し、検索ボックスとカテゴリチップは置かない', () => {
    const onStateChange = vi.fn()
    render(<TemplateShelf templates={templates} onStateChange={onStateChange} />)

    expect(screen.getByRole('heading', { name: /型を選ぶ|テンプレートを選ぶ/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /ブログ掛け合い 60秒を選ぶ/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /broken-template/ })).toBeVisible()

    expect(screen.queryByRole('searchbox', { name: 'テンプレートを検索' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('用途で絞り込む')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'すべての用途を表示' })).not.toBeInTheDocument()

    // 軸・チェックリストはまだ出さない
    expect(screen.queryByRole('heading', { name: 'キャラクター構成' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /チェックリスト|用意するもの/ })).not.toBeInTheDocument()

    expect(latestState(onStateChange)).toMatchObject({
      templateId: null,
      choices: {},
      step: 0,
    })
  })

  it('型選択 → 軸1 → 軸2 → 軸3 → チェックリストとナビできる', async () => {
    const user = userEvent.setup()
    const onStateChange = vi.fn()
    render(<TemplateShelf templates={templates} onStateChange={onStateChange} />)

    await user.click(screen.getByRole('button', { name: /ブログ掛け合い 60秒を選ぶ/ }))
    expect(await screen.findByRole('heading', { name: 'キャラクター構成' })).toBeVisible()
    expect(latestState(onStateChange)).toMatchObject({
      templateId: 'blog-dialogue-60s',
      step: 1,
    })

    await user.click(screen.getByRole('button', { name: /同僚同士/ }))
    expect(await screen.findByRole('heading', { name: '背景' })).toBeVisible()
    expect(latestState(onStateChange)).toMatchObject({
      step: 2,
      choices: expect.objectContaining({ cast: 'peer-dialogue' }),
    })

    await user.click(screen.getByRole('button', { name: /画面デモ/ }))
    expect(await screen.findByRole('heading', { name: 'テンポ' })).toBeVisible()
    expect(latestState(onStateChange)).toMatchObject({
      step: 3,
      choices: expect.objectContaining({
        cast: 'peer-dialogue',
        background: 'ui-window',
      }),
    })

    await user.click(screen.getByRole('button', { name: /落ち着いた/ }))
    expect(await screen.findByRole('heading', { name: /チェックリスト/ })).toBeVisible()
    expect(latestState(onStateChange)).toMatchObject({
      step: 4,
      choices: {
        cast: 'peer-dialogue',
        background: 'ui-window',
        pace: 'calm',
      },
    })
  })

  it('defaultOptionId がある軸は推奨が事前選択される', async () => {
    const user = userEvent.setup()
    const onStateChange = vi.fn()
    render(<TemplateShelf templates={templates} onStateChange={onStateChange} />)

    await user.click(screen.getByRole('button', { name: /ブログ掛け合い 60秒を選ぶ/ }))
    expect(await screen.findByRole('heading', { name: 'キャラクター構成' })).toBeVisible()

    const recommended = screen.getByRole('button', { name: /初心者＋専門家/ })
    expect(within(recommended).getByText('推奨')).toBeVisible()
    expect(recommended).toHaveAttribute('aria-pressed', 'true')
    expect(latestState(onStateChange).choices).toMatchObject({ cast: 'beginner-expert' })

    // 次の軸（背景）も default あり
    await user.click(recommended)
    expect(await screen.findByRole('heading', { name: '背景' })).toBeVisible()
    const bgRecommended = screen.getByRole('button', { name: /紙の切り絵/ })
    expect(within(bgRecommended).getByText('推奨')).toBeVisible()
    expect(bgRecommended).toHaveAttribute('aria-pressed', 'true')
    expect(latestState(onStateChange).choices).toMatchObject({
      cast: 'beginner-expert',
      background: 'paper-cutout',
    })

    // default なしの軸は未選択
    await user.click(bgRecommended)
    expect(await screen.findByRole('heading', { name: 'テンポ' })).toBeVisible()
    expect(screen.getByRole('button', { name: /落ち着いた/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: /テンポよく/ })).toHaveAttribute('aria-pressed', 'false')
    expect(latestState(onStateChange).choices.pace).toBeUndefined()
  })

  it('「おすすめのまま進む」で全軸デフォルトを確定しチェックリストへ進む', async () => {
    const user = userEvent.setup()
    const onStateChange = vi.fn()
    render(<TemplateShelf templates={templates} onStateChange={onStateChange} />)

    await user.click(screen.getByRole('button', { name: /ブログ掛け合い 60秒を選ぶ/ }))
    expect(await screen.findByRole('heading', { name: 'キャラクター構成' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'おすすめのまま進む' }))

    expect(await screen.findByRole('heading', { name: /チェックリスト/ })).toBeVisible()
    expect(latestState(onStateChange)).toMatchObject({
      templateId: 'blog-dialogue-60s',
      step: 4,
      choices: {
        cast: 'beginner-expert',
        background: 'paper-cutout',
        // default なし軸は最初の option を採用する契約
        pace: 'calm',
      },
    })
  })

  it('軸を選ぶと自動で次ステップへ進む', async () => {
    const user = userEvent.setup()
    const onStateChange = vi.fn()
    render(<TemplateShelf templates={templates} onStateChange={onStateChange} />)

    await user.click(screen.getByRole('button', { name: /ブログ掛け合い 60秒を選ぶ/ }))
    await screen.findByRole('heading', { name: 'キャラクター構成' })

    await user.click(screen.getByRole('button', { name: /同僚同士/ }))
    expect(await screen.findByRole('heading', { name: '背景' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'キャラクター構成' })).not.toBeInTheDocument()
    expect(latestState(onStateChange).step).toBe(2)
  })

  it('戻ると下流の選択は保持し、上流を変更したら下流をリセットする', async () => {
    const user = userEvent.setup()
    const onStateChange = vi.fn()
    render(<TemplateShelf templates={templates} onStateChange={onStateChange} />)

    await user.click(screen.getByRole('button', { name: /ブログ掛け合い 60秒を選ぶ/ }))
    await screen.findByRole('heading', { name: 'キャラクター構成' })
    await user.click(screen.getByRole('button', { name: /同僚同士/ }))
    await screen.findByRole('heading', { name: '背景' })
    await user.click(screen.getByRole('button', { name: /画面デモ/ }))
    await screen.findByRole('heading', { name: 'テンポ' })
    await user.click(screen.getByRole('button', { name: /テンポよく/ }))
    await screen.findByRole('heading', { name: /チェックリスト/ })

    expect(latestState(onStateChange).choices).toEqual({
      cast: 'peer-dialogue',
      background: 'ui-window',
      pace: 'brisk',
    })

    // パンくずで軸2（背景）へ戻る → 下流 pace は保持
    await user.click(within(progressNav()).getByRole('button', { name: /背景/ }))
    expect(await screen.findByRole('heading', { name: '背景' })).toBeVisible()
    expect(latestState(onStateChange)).toMatchObject({
      step: 2,
      choices: {
        cast: 'peer-dialogue',
        background: 'ui-window',
        pace: 'brisk',
      },
    })

    // 上流（軸1: キャラクター構成）へ戻り別 option を選ぶ → background / pace をリセット
    await user.click(within(progressNav()).getByRole('button', { name: /キャラクター構成/ }))
    expect(await screen.findByRole('heading', { name: 'キャラクター構成' })).toBeVisible()
    expect(latestState(onStateChange).step).toBe(1)
    // 戻っただけでは下流を消さない
    expect(latestState(onStateChange).choices).toMatchObject({
      cast: 'peer-dialogue',
      background: 'ui-window',
      pace: 'brisk',
    })

    await user.click(screen.getByRole('button', { name: /初心者＋専門家/ }))
    expect(await screen.findByRole('heading', { name: '背景' })).toBeVisible()

    const state = latestState(onStateChange)
    expect(state.choices.cast).toBe('beginner-expert')
    expect(state.choices.background).toBeUndefined()
    expect(state.choices.pace).toBeUndefined()
    expect(state.step).toBe(2)
  })

  it('valid: false のテンプレートは選択不可、またはエラー表示のまま進めない', async () => {
    const user = userEvent.setup()
    const onStateChange = vi.fn()
    render(<TemplateShelf templates={templates} onStateChange={onStateChange} />)

    const invalidCard = screen.getByRole('button', { name: /broken-template/ })
    expect(invalidCard).toHaveAttribute('data-invalid', 'true')

    if (invalidCard.hasAttribute('disabled') || invalidCard.getAttribute('aria-disabled') === 'true') {
      expect(invalidCard).toBeDisabled()
      return
    }

    await user.click(invalidCard)
    expect(
      screen.getByText(/template\.yamlの形式が正しくありません|表示情報を確認できません|選択できません/),
    ).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'キャラクター構成' })).not.toBeInTheDocument()
    expect(latestState(onStateChange).step).toBe(0)
  })

  it('キーボードのみで完走できる（見出し focus / aria-pressed / roving tabIndex）', async () => {
    const user = userEvent.setup()
    const onStateChange = vi.fn()
    render(<TemplateShelf templates={templates} onStateChange={onStateChange} />)

    const typeCard = screen.getByRole('button', { name: /ブログ掛け合い 60秒を選ぶ/ })
    typeCard.focus()
    expect(typeCard).toHaveFocus()
    await user.keyboard('{Enter}')

    const axisHeading = await screen.findByRole('heading', { name: 'キャラクター構成' })
    expect(axisHeading).toHaveFocus()

    const options = screen.getAllByRole('button', { name: /初心者＋専門家|同僚同士/ })
    expect(options.length).toBeGreaterThanOrEqual(2)

    // roving tabIndex: 選択中（または先頭）だけ tabIndex=0、他は -1
    const tabIndexes = options.map((el) => el.getAttribute('tabindex'))
    expect(tabIndexes.filter((v) => v === '0')).toHaveLength(1)
    expect(tabIndexes.every((v) => v === '0' || v === '-1')).toBe(true)

    const active = options.find((el) => el.getAttribute('tabindex') === '0')
    expect(active).toBeTruthy()
    active!.focus()
    await user.keyboard('{ArrowRight}')
    const afterArrow = options.find((el) => el.getAttribute('tabindex') === '0')
    expect(afterArrow).toBeTruthy()
    expect(afterArrow).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(await screen.findByRole('heading', { name: '背景' })).toBeVisible()
    expect(latestState(onStateChange).choices.cast).toMatch(/beginner-expert|peer-dialogue/)

    // 残りは「おすすめのまま進む」でチェックリストまで
    await user.click(screen.getByRole('button', { name: 'おすすめのまま進む' }))
    expect(await screen.findByRole('heading', { name: /チェックリスト/ })).toBeVisible()
    expect(latestState(onStateChange).step).toBe(4)
  })

  it('パンくず/進捗チップで過去ステップに戻れる', async () => {
    const user = userEvent.setup()
    const onStateChange = vi.fn()
    render(<TemplateShelf templates={templates} onStateChange={onStateChange} />)

    await user.click(screen.getByRole('button', { name: /ブログ掛け合い 60秒を選ぶ/ }))
    await screen.findByRole('heading', { name: 'キャラクター構成' })
    await user.click(screen.getByRole('button', { name: 'おすすめのまま進む' }))
    await screen.findByRole('heading', { name: /チェックリスト/ })

    const nav = progressNav()
    const chips = within(nav).getAllByRole('button')
    expect(chips.length).toBeGreaterThanOrEqual(2)

    // 型選択（step 0）へ
    await user.click(
      within(nav).getByRole('button', { name: /型|テンプレート|ブログ掛け合い/ }),
    )
    expect(await screen.findByRole('heading', { name: /型を選ぶ|テンプレートを選ぶ/ })).toBeVisible()
    expect(latestState(onStateChange).step).toBe(0)

    // 再度進めて軸ステップのチップへ戻れること
    await user.click(screen.getByRole('button', { name: /ブログ掛け合い 60秒を選ぶ/ }))
    await screen.findByRole('heading', { name: 'キャラクター構成' })
    await user.click(screen.getByRole('button', { name: 'おすすめのまま進む' }))
    await screen.findByRole('heading', { name: /チェックリスト/ })

    await user.click(within(progressNav()).getByRole('button', { name: /背景/ }))
    expect(await screen.findByRole('heading', { name: '背景' })).toBeVisible()
    expect(latestState(onStateChange).step).toBe(2)
  })
})
