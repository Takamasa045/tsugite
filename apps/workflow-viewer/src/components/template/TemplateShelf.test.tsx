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
import { useState } from 'react'
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

function templateCard(name: string | RegExp) {
  return screen.getByRole('heading', { level: 3, name }).closest('article') as HTMLElement
}

function detailActionName(name: string) {
  return `${name}を詳しく選ぶ`
}

function quickStartActionName(name: string) {
  return `${name}のおすすめ設定で制作依頼を作る`
}

async function chooseDetail(user: ReturnType<typeof userEvent.setup>, name: string) {
  // カード scope なしでもページ全体で一意に取れるアクセシブル名を使う
  await user.click(screen.getByRole('button', { name: detailActionName(name) }))
}

describe('TemplateShelf', () => {
  it('初期は Step 0: 型カードだけを示し、検索ボックスとカテゴリチップは置かない', () => {
    const onStateChange = vi.fn()
    render(<TemplateShelf templates={templates} onStateChange={onStateChange} />)

    expect(screen.getByRole('heading', { name: /何を作りたい/ })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'ブログ掛け合い 60秒' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'broken-template' })).toBeVisible()
    expect(screen.getByRole('button', { name: detailActionName('ブログ掛け合い 60秒') })).toBeVisible()
    expect(screen.getByRole('button', { name: quickStartActionName('ブログ掛け合い 60秒') })).toBeVisible()
    // 見た目の短い文言は維持
    expect(within(templateCard('ブログ掛け合い 60秒')).getByText('詳しく選ぶ')).toBeVisible()
    expect(within(templateCard('ブログ掛け合い 60秒')).getByText('おすすめ設定で制作依頼を作る')).toBeVisible()

    expect(screen.queryByRole('searchbox', { name: 'テンプレートを検索' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('用途で絞り込む')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'すべての用途を表示' })).not.toBeInTheDocument()

    // 軸・チェックリストはまだ出さない
    expect(screen.queryByRole('heading', { name: 'キャラクター構成' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /制作依頼ができました|チェックリスト|用意するもの/ })).not.toBeInTheDocument()

    expect(latestState(onStateChange)).toMatchObject({
      templateId: null,
      choices: {},
      step: 0,
    })
  })

  it('カード操作はページ全体でテンプレート名込みの固有名として一意に取れる', () => {
    render(<TemplateShelf templates={templates} />)

    const detailButtons = screen.getAllByRole('button', { name: /を詳しく選ぶ$/ })
    const quickButtons = screen.getAllByRole('button', { name: /のおすすめ設定で制作依頼を作る$/ })
    expect(detailButtons).toHaveLength(2)
    expect(quickButtons).toHaveLength(2)

    // card scope なしで各テンプレートを一意に取得できる
    expect(screen.getByRole('button', { name: detailActionName('ブログ掛け合い 60秒') })).toBeVisible()
    expect(screen.getByRole('button', { name: quickStartActionName('ブログ掛け合い 60秒') })).toBeVisible()
    expect(screen.getByRole('button', { name: detailActionName('broken-template（選択不可）') })).toBeDisabled()
    expect(screen.getByRole('button', { name: quickStartActionName('broken-template（選択不可）') })).toBeDisabled()
  })

  it('型選択 → 軸1 → 軸2 → 軸3 → チェックリストとナビできる', async () => {
    const user = userEvent.setup()
    const onStateChange = vi.fn()
    render(<TemplateShelf templates={templates} onStateChange={onStateChange} />)

    await chooseDetail(user, 'ブログ掛け合い 60秒')
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
    expect(await screen.findByRole('heading', { name: /制作依頼ができました/ })).toBeVisible()
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

    await chooseDetail(user, 'ブログ掛け合い 60秒')
    expect(await screen.findByRole('heading', { name: 'キャラクター構成' })).toBeVisible()

    const recommended = screen.getAllByRole('button', { name: /初心者＋専門家/ })
      .find((el) => el.classList.contains('launcher-template-axis-option'))!
    expect(within(recommended).getByText('推奨')).toBeVisible()
    expect(recommended).toHaveAttribute('aria-pressed', 'true')
    expect(latestState(onStateChange).choices).toMatchObject({ cast: 'beginner-expert' })

    // 次の軸（背景）も default あり
    await user.click(recommended)
    expect(await screen.findByRole('heading', { name: '背景' })).toBeVisible()
    const bgRecommended = screen.getAllByRole('button', { name: /紙の切り絵/ })
      .find((el) => el.classList.contains('launcher-template-axis-option'))!
    expect(within(bgRecommended).getByText('推奨')).toBeVisible()
    expect(bgRecommended).toHaveAttribute('aria-pressed', 'true')
    expect(latestState(onStateChange).choices).toMatchObject({
      cast: 'beginner-expert',
      background: 'paper-cutout',
    })

    // default なしの軸は未選択
    await user.click(bgRecommended)
    expect(await screen.findByRole('heading', { name: 'テンポ' })).toBeVisible()
    const calm = screen.getAllByRole('button', { name: /落ち着いた/ })
      .find((el) => el.classList.contains('launcher-template-axis-option'))!
    const brisk = screen.getAllByRole('button', { name: /テンポよく/ })
      .find((el) => el.classList.contains('launcher-template-axis-option'))!
    expect(calm).toHaveAttribute('aria-pressed', 'false')
    expect(brisk).toHaveAttribute('aria-pressed', 'false')
    expect(latestState(onStateChange).choices.pace).toBeUndefined()
  })

  it('「おすすめのまま進む」で全軸デフォルトを確定しチェックリストへ進む', async () => {
    const user = userEvent.setup()
    const onStateChange = vi.fn()
    render(<TemplateShelf templates={templates} onStateChange={onStateChange} />)

    await chooseDetail(user, 'ブログ掛け合い 60秒')
    expect(await screen.findByRole('heading', { name: 'キャラクター構成' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'おすすめのまま進む' }))

    expect(await screen.findByRole('heading', { name: /制作依頼ができました/ })).toBeVisible()
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

  it('カードから「おすすめ設定で制作依頼を作る」で既定値のまま最終画面へ進む', async () => {
    const user = userEvent.setup()
    const onStateChange = vi.fn()
    render(<TemplateShelf templates={templates} onStateChange={onStateChange} />)

    await user.click(screen.getByRole('button', { name: quickStartActionName('ブログ掛け合い 60秒') }))

    expect(await screen.findByRole('heading', { name: /制作依頼ができました/ })).toBeVisible()
    expect(screen.getByRole('button', { name: '制作依頼だけをコピー' })).toBeVisible()
    expect(latestState(onStateChange)).toMatchObject({
      templateId: 'blog-dialogue-60s',
      step: 4,
      choices: {
        cast: 'beginner-expert',
        background: 'paper-cutout',
        pace: 'calm',
      },
    })
  })

  it('軸を選ぶと自動で次ステップへ進む', async () => {
    const user = userEvent.setup()
    const onStateChange = vi.fn()
    render(<TemplateShelf templates={templates} onStateChange={onStateChange} />)

    await chooseDetail(user, 'ブログ掛け合い 60秒')
    await screen.findByRole('heading', { name: 'キャラクター構成' })

    await user.click(screen.getByRole('button', { name: /同僚同士/ }))
    expect(await screen.findByRole('heading', { name: '背景' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'キャラクター構成' })).not.toBeInTheDocument()
    expect(latestState(onStateChange).step).toBe(2)
  })

  it('条件を選ぶと aria-live で選択確認を出す', async () => {
    const user = userEvent.setup()
    render(<TemplateShelf templates={templates} />)

    await chooseDetail(user, 'ブログ掛け合い 60秒')
    expect(await screen.findByText(/ブログ掛け合い 60秒を選びました。戻って変更できます。/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /同僚同士/ }))
    expect(await screen.findByText(/同僚同士を選びました。戻って変更できます。/)).toBeInTheDocument()
    expect(screen.getByText(/同僚同士を選びました。戻って変更できます。/)).toHaveAttribute('aria-live', 'polite')
  })

  it('進捗は現在地と残りが分かる形で一つに統一する', async () => {
    const user = userEvent.setup()
    render(<TemplateShelf templates={templates} />)

    await chooseDetail(user, 'ブログ掛け合い 60秒')
    await screen.findByRole('heading', { name: 'キャラクター構成' })

    const nav = progressNav()
    // 3軸テンプレート = 動画 + 3軸 + 制作依頼 の5段階。軸1到達時は 2/5
    expect(within(nav).getByText(/2 \/ 5 · あと3つ/)).toBeVisible()

    await user.click(screen.getByRole('button', { name: /同僚同士/ }))
    expect(await screen.findByRole('heading', { name: '背景' })).toBeVisible()
    expect(within(progressNav()).getByText(/3 \/ 5 · あと2つ/)).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'おすすめのまま進む' }))
    expect(await screen.findByRole('heading', { name: /制作依頼ができました/ })).toBeVisible()
    expect(within(progressNav()).getByText(/5 \/ 5 · 完了/)).toBeVisible()
  })

  it('軸数に応じて totalSteps が変わり、軸なしは 2/2 完了になる', async () => {
    const user = userEvent.setup()
    const noAxisTemplate: WizardTemplate = {
      ...validTemplate,
      id: 'qa-dialogue',
      name: 'Q&A掛け合い',
      variants: [],
    }
    render(<TemplateShelf templates={[noAxisTemplate]} />)

    await chooseDetail(user, 'Q&A掛け合い')
    expect(await screen.findByRole('heading', { name: /制作依頼ができました/ })).toBeVisible()

    // 軸なし = 動画 + 制作依頼 の2段階。最終画面は 2/2 · 完了（固定5ではない）
    const nav = progressNav()
    expect(within(nav).getByText(/2 \/ 2 · 完了/)).toBeVisible()
    expect(within(nav).queryByText(/\/ 5/)).not.toBeInTheDocument()
    expect(within(nav).getAllByRole('button')).toHaveLength(2)
  })

  it('戻ると下流の選択は保持し、上流を変更したら下流をリセットする', async () => {
    const user = userEvent.setup()
    const onStateChange = vi.fn()
    render(<TemplateShelf templates={templates} onStateChange={onStateChange} />)

    await chooseDetail(user, 'ブログ掛け合い 60秒')
    await screen.findByRole('heading', { name: 'キャラクター構成' })
    await user.click(screen.getByRole('button', { name: /同僚同士/ }))
    await screen.findByRole('heading', { name: '背景' })
    await user.click(screen.getByRole('button', { name: /画面デモ/ }))
    await screen.findByRole('heading', { name: 'テンポ' })
    await user.click(screen.getByRole('button', { name: /テンポよく/ }))
    await screen.findByRole('heading', { name: /制作依頼ができました/ })

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

    const invalidCard = templateCard('broken-template')
    expect(invalidCard).toHaveAttribute('data-invalid', 'true')
    const detailButton = screen.getByRole('button', { name: detailActionName('broken-template（選択不可）') })
    const quickButton = screen.getByRole('button', { name: quickStartActionName('broken-template（選択不可）') })
    expect(detailButton).toBeDisabled()
    expect(quickButton).toBeDisabled()

    await user.click(detailButton)
    expect(screen.queryByRole('heading', { name: 'キャラクター構成' })).not.toBeInTheDocument()
    expect(latestState(onStateChange).step).toBe(0)
  })

  it('キーボードのみで完走できる（見出し focus / aria-pressed / roving tabIndex）', async () => {
    const user = userEvent.setup()
    const onStateChange = vi.fn()
    render(<TemplateShelf templates={templates} onStateChange={onStateChange} />)

    const detailButton = screen.getByRole('button', { name: detailActionName('ブログ掛け合い 60秒') })
    detailButton.focus()
    expect(detailButton).toHaveFocus()
    await user.keyboard('{Enter}')

    const axisHeading = await screen.findByRole('heading', { name: 'キャラクター構成' })
    expect(axisHeading).toHaveFocus()

    const options = screen.getAllByRole('button', { name: /初心者＋専門家|同僚同士/ })
      .filter((el) => el.classList.contains('launcher-template-axis-option'))
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
    expect(await screen.findByRole('heading', { name: /制作依頼ができました/ })).toBeVisible()
    expect(latestState(onStateChange).step).toBe(4)
  })

  it('パンくず/進捗チップで過去ステップに戻れる', async () => {
    const user = userEvent.setup()
    const onStateChange = vi.fn()
    render(<TemplateShelf templates={templates} onStateChange={onStateChange} />)

    await chooseDetail(user, 'ブログ掛け合い 60秒')
    await screen.findByRole('heading', { name: 'キャラクター構成' })
    await user.click(screen.getByRole('button', { name: 'おすすめのまま進む' }))
    await screen.findByRole('heading', { name: /制作依頼ができました/ })

    const nav = progressNav()
    const chips = within(nav).getAllByRole('button')
    expect(chips.length).toBeGreaterThanOrEqual(2)

    // 動画選択（step 0）へ
    await user.click(
      within(nav).getByRole('button', { name: /動画|ブログ掛け合い/ }),
    )
    expect(await screen.findByRole('heading', { name: /何を作りたい/ })).toBeVisible()
    expect(latestState(onStateChange).step).toBe(0)

    // 再度進めて軸ステップのチップへ戻れること
    await chooseDetail(user, 'ブログ掛け合い 60秒')
    await screen.findByRole('heading', { name: 'キャラクター構成' })
    await user.click(screen.getByRole('button', { name: 'おすすめのまま進む' }))
    await screen.findByRole('heading', { name: /制作依頼ができました/ })

    await user.click(within(progressNav()).getByRole('button', { name: /背景/ }))
    expect(await screen.findByRole('heading', { name: '背景' })).toBeVisible()
    expect(latestState(onStateChange).step).toBe(2)
  })

  it('戻るボタンで1つ前のステップへ戻れる', async () => {
    const user = userEvent.setup()
    const onStateChange = vi.fn()
    render(<TemplateShelf templates={templates} onStateChange={onStateChange} />)

    expect(screen.queryByRole('button', { name: /一覧に戻る|型一覧に戻る|戻る/ })).not.toBeInTheDocument()

    await chooseDetail(user, 'ブログ掛け合い 60秒')
    expect(await screen.findByRole('heading', { name: 'キャラクター構成' })).toBeVisible()

    const backToList = screen.getByRole('button', { name: '一覧に戻る' })
    expect(backToList).toBeVisible()
    await user.click(backToList)

    expect(await screen.findByRole('heading', { name: /何を作りたい/ })).toBeVisible()
    expect(latestState(onStateChange).step).toBe(0)
    expect(screen.queryByRole('button', { name: '一覧に戻る' })).not.toBeInTheDocument()

    await chooseDetail(user, 'ブログ掛け合い 60秒')
    await screen.findByRole('heading', { name: 'キャラクター構成' })
    await user.click(screen.getByRole('button', { name: /同僚同士/ }))
    expect(await screen.findByRole('heading', { name: '背景' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: '戻る' }))
    expect(await screen.findByRole('heading', { name: 'キャラクター構成' })).toBeVisible()
    expect(latestState(onStateChange)).toMatchObject({
      step: 1,
      choices: expect.objectContaining({ cast: 'peer-dialogue' }),
    })
  })

  it('最終画面では制作依頼コピーが主操作として見える', async () => {
    const user = userEvent.setup()
    render(<TemplateShelf templates={templates} />)

    await user.click(screen.getByRole('button', { name: quickStartActionName('ブログ掛け合い 60秒') }))
    expect(await screen.findByRole('heading', { name: /制作依頼ができました/ })).toBeVisible()
    expect(screen.getByRole('heading', { name: '確認してコピー' })).toBeVisible()

    const copyButton = screen.getByRole('button', { name: '制作依頼だけをコピー' })
    expect(copyButton).toBeVisible()
    expect(copyButton).toHaveClass('launcher-primary')
    expect(screen.getByLabelText('制作依頼本文')).toBeVisible()
    expect(
      screen.getByText((content) => content.includes('この画面では生成・実行・Gate更新をしません')),
    ).toBeVisible()
    expect(screen.getByText('素材・演出の詳細を見る')).toBeVisible()
  })

  it('catalog error retry stays mounted with aria-disabled during loading and keeps focus', async () => {
    const user = userEvent.setup()
    let loadState: 'error' | 'loading' | 'ready' = 'error'
    const onRetry = vi.fn(() => {
      loadState = 'loading'
      rerender(
        <TemplateShelf
          loadState={loadState}
          onRetry={onRetry}
          templates={[]}
        />,
      )
    })
    const { rerender } = render(
      <TemplateShelf
        loadState={loadState}
        onRetry={onRetry}
        templates={[]}
      />,
    )

    const retry = screen.getByRole('button', { name: 'テンプレートをもう一度読み込む' })
    retry.focus()
    await user.click(retry)
    expect(onRetry).toHaveBeenCalledTimes(1)

    const busy = screen.getByRole('button', { name: '読み込んでいます…' })
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).not.toHaveAttribute('disabled')
    expect(busy).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
    await user.click(busy)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(busy).toHaveFocus()
  })

  it('error→loading→ready: hands focus to first valid template action (not BODY)', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [loadState, setLoadState] = useState<'error' | 'loading' | 'ready'>('error')
      const list = loadState === 'ready' ? templates : []
      return (
        <div>
          <TemplateShelf
            loadState={loadState}
            onRetry={() => setLoadState('loading')}
            templates={list}
          />
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setLoadState('ready')}
          >
            complete-load
          </button>
        </div>
      )
    }
    render(<Harness />)

    const retry = screen.getByRole('button', { name: 'テンプレートをもう一度読み込む' })
    retry.focus()
    await user.click(retry)
    expect(screen.getByRole('button', { name: '読み込んでいます…' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'complete-load' }))

    const firstAction = screen.getByRole('button', {
      name: detailActionName('ブログ掛け合い 60秒'),
    })
    expect(firstAction).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
    expect(document.activeElement?.tagName.toLowerCase()).not.toBe('body')
    expect(screen.queryByRole('button', { name: 'テンプレートをもう一度読み込む' })).not.toBeInTheDocument()
  })

  it('error→loading→ready empty: hands focus to type heading (not BODY)', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [loadState, setLoadState] = useState<'error' | 'loading' | 'ready'>('error')
      return (
        <div>
          <TemplateShelf
            loadState={loadState}
            onRetry={() => setLoadState('loading')}
            templates={[]}
          />
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setLoadState('ready')}
          >
            complete-load
          </button>
        </div>
      )
    }
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'テンプレートをもう一度読み込む' }))
    expect(screen.getByRole('button', { name: '読み込んでいます…' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'complete-load' }))

    expect(screen.getByRole('heading', { name: /何を作りたい/ })).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
  })

  it('error→loading→error: focus remains on the same catalog retry control', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [loadState, setLoadState] = useState<'error' | 'loading' | 'ready'>('error')
      return (
        <div>
          <TemplateShelf
            loadState={loadState}
            onRetry={() => setLoadState('loading')}
            templates={[]}
          />
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setLoadState('error')}
          >
            fail-load
          </button>
        </div>
      )
    }
    render(<Harness />)

    const retry = screen.getByRole('button', { name: 'テンプレートをもう一度読み込む' })
    retry.focus()
    await user.click(retry)
    expect(screen.getByRole('button', { name: '読み込んでいます…' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'fail-load' }))
    const retryAgain = screen.getByRole('button', { name: 'テンプレートをもう一度読み込む' })
    expect(retryAgain).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
  })

  it('initial automatic loading→ready does not programmatically focus', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [loadState, setLoadState] = useState<'loading' | 'ready'>('loading')
      return (
        <div>
          <TemplateShelf loadState={loadState} onRetry={vi.fn()} templates={templates} />
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setLoadState('ready')}
          >
            complete-initial
          </button>
        </div>
      )
    }
    render(<Harness />)
    expect(screen.getByText('テンプレートを読み込んでいます…')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'テンプレートをもう一度読み込む' })).not.toBeInTheDocument()
    expect(document.activeElement).toBe(document.body)

    await user.click(screen.getByRole('button', { name: 'complete-initial' }))
    expect(screen.getByRole('heading', { name: 'ブログ掛け合い 60秒' })).toBeVisible()
    // No user-owned retry: do not steal focus to heading or first action.
    expect(document.activeElement).toBe(document.body)
    expect(screen.getByRole('heading', { name: /何を作りたい/ })).not.toHaveFocus()
  })

  it('production source keeps soft-disable catalog retry (no dynamic native disabled)', async () => {
    const nodeFs = 'node:fs'
    const nodePath = 'node:path'
    const fs = await import(/* @vite-ignore */ nodeFs) as {
      readFileSync: (path: string, encoding: string) => string
    }
    const path = await import(/* @vite-ignore */ nodePath) as {
      resolve: (...parts: string[]) => string
    }
    const cwd = (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.()
    if (!cwd) throw new Error('process.cwd is unavailable')
    const source = fs.readFileSync(
      path.resolve(cwd, 'src/components/template/TemplateShelf.tsx'),
      'utf8',
    )
    expect(source).toMatch(/aria-disabled=\{isCatalogLoading \|\| undefined\}/)
    expect(source).not.toMatch(/disabled=\{isCatalogLoading\}/)
    expect(source).toMatch(/if \(isCatalogLoading\) return/)
    expect(source).toMatch(/retryHandoffPendingRef/)
    expect(source).toMatch(/ownsRetryFocusHandoff/)
  })
})
