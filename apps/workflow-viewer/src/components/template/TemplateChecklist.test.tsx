/**
 * Phase 3 目標契約（RED）:
 * - export: TemplateChecklist
 * - props: template, choices（axisId → optionId）
 * - 必須/任意の振り分け（requiredInputDetails[].required）
 * - notFor 警告、ブリーフ Markdown、コピーボタン
 * - 生成・実行ボタンは置かない（閲覧専用）
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TemplateChecklist } from './TemplateChecklist'

const template = {
  id: 'blog-dialogue-60s',
  name: 'ブログ掛け合い 60秒',
  summary: 'ブログ記事を初心者役と解説役の会話で伝える動画です。',
  category: '記事を動画化',
  useCases: ['ブログ記事'],
  duration: '60秒',
  aspectRatio: '16:9',
  requiredInputs: ['記事本文と出典', '2人分のキャラクター画像'],
  requiredInputDetails: [
    { type: 'text' as const, label: '記事本文と出典', required: true },
    { type: 'image' as const, label: '2人分のキャラクター画像', required: true },
    { type: 'audio' as const, label: '任意のBGM', required: false },
    { type: 'data' as const, label: '参考リンク一覧', required: false },
  ],
  notFor: ['実演だけで魅力が伝わる商品', '無言の商品イメージ映像'],
  direction: {
    pacing: '冒頭2秒以内にフック',
    camera: '1ショット1カメラベクトル',
  },
  variants: [
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
          directionAdd: { motif: '同じ問いを3回まで' },
          examples: {
            good: ['0.5秒で問いを出し答えの輪郭を見せる'],
            monotonous: ['全カット同じズームを3連続'],
          },
          requiredInputsAdd: ['任意のBGM'],
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
  ],
  audio: '音声とBGMは任意です。',
  valid: true as const,
}

const choices = {
  cast: 'peer-dialogue',
  background: 'ui-window',
} as const

async function openDetails(user: ReturnType<typeof userEvent.setup>) {
  const summary = screen.getByText('素材・演出の詳細を見る')
  const details = summary.closest('details')
  if (details && !details.open) {
    await user.click(summary)
  }
}

describe('TemplateChecklist', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('見出しと主操作を制作プロンプト導線にする', () => {
    render(<TemplateChecklist template={template} choices={choices} />)

    expect(screen.getByRole('heading', { name: '制作プロンプトができました' })).toBeVisible()
    const primaryCopy = screen.getAllByRole('button', { name: 'プロンプトをコピー' })[0]
    expect(primaryCopy).toBeVisible()
    expect(primaryCopy).toHaveClass('launcher-primary')
    expect(screen.getByText(/この画面では生成・実行・Gate更新はしません/)).toBeVisible()
    expect(screen.getByText('素材・演出の詳細を見る')).toBeVisible()
  })

  it('初期状態で制作プロンプト本文が見え、詳細 details を開かなくても確認できる', () => {
    render(<TemplateChecklist template={template} choices={choices} />)

    const brief = screen.getByLabelText('プロンプト本文')
    expect(brief).toBeVisible()
    expect(brief.textContent).toMatch(/ブログ掛け合い 60秒/)
    expect(brief.textContent).toMatch(/同僚同士/)

    const details = screen.getByText('素材・演出の詳細を見る').closest('details')
    expect(details).toBeTruthy()
    expect(details).not.toHaveAttribute('open')
    // 折りたたみ対象は補助情報だけで、本文は details の外にある
    expect(details?.contains(brief)).toBe(false)
    expect(details?.textContent).toMatch(/選択内容|必須|向かない用途/)
  })

  it('必須と任意の入力を振り分けて表示する', async () => {
    const user = userEvent.setup()
    render(<TemplateChecklist template={template} choices={{ cast: 'beginner-expert', background: 'ui-window' }} />)
    await openDetails(user)

    const requiredSection = screen.getByRole('region', { name: /必須/ })
    expect(within(requiredSection).getByText('記事本文と出典')).toBeVisible()
    expect(within(requiredSection).getByText('2人分のキャラクター画像')).toBeVisible()
    expect(within(requiredSection).queryByText('任意のBGM')).not.toBeInTheDocument()
    expect(within(requiredSection).queryByText('参考リンク一覧')).not.toBeInTheDocument()

    const optionalSection = screen.getByRole('region', { name: /任意/ })
    expect(within(optionalSection).getByText('任意のBGM')).toBeVisible()
    expect(within(optionalSection).getByText('参考リンク一覧')).toBeVisible()
    expect(within(optionalSection).queryByText('記事本文と出典')).not.toBeInTheDocument()
  })

  it('option の requiredInputsAdd で任意素材を必須へ昇格して表示する', async () => {
    const user = userEvent.setup()
    render(<TemplateChecklist template={template} choices={choices} />)
    await openDetails(user)

    const requiredSection = screen.getByRole('region', { name: /必須/ })
    expect(within(requiredSection).getByText('任意のBGM')).toBeVisible()
    const optionalSection = screen.getByRole('region', { name: /任意/ })
    expect(within(optionalSection).queryByText('任意のBGM')).not.toBeInTheDocument()
  })

  it('演出指針と具体例をコピー前に表示する', async () => {
    const user = userEvent.setup()
    render(<TemplateChecklist template={template} choices={choices} />)
    await openDetails(user)

    const direction = screen.getByRole('region', { name: '演出指針' })
    expect(direction).toBeVisible()
    expect(within(direction).getByText('冒頭2秒以内にフック')).toBeVisible()
    expect(within(direction).getByText('同じ問いを3回まで')).toBeVisible()

    const examples = screen.getByRole('region', { name: '具体例' })
    expect(examples).toBeVisible()
    expect(within(examples).getByText(/0\.5秒で問いを出し/)).toBeVisible()
    expect(within(examples).getByText(/全カット同じズーム/)).toBeVisible()
  })

  it('notFor 警告を表示する', async () => {
    const user = userEvent.setup()
    render(<TemplateChecklist template={template} choices={choices} />)
    await openDetails(user)

    const warning =
      screen.queryByRole('status', { name: /向かない|注意|警告/ })
      ?? screen.getByText(/向かない用途|向いていません|避けてください/)

    expect(warning).toBeVisible()
    expect(screen.getByText('実演だけで魅力が伝わる商品')).toBeVisible()
    expect(screen.getByText('無言の商品イメージ映像')).toBeVisible()
  })

  it('プロンプト Markdown に型名・各軸・用意するものを含める', () => {
    render(<TemplateChecklist template={template} choices={choices} />)

    const brief = screen.getByLabelText('プロンプト本文')
    const text = brief.textContent ?? ''
    expect(brief).toBeVisible()
    expect(text).toMatch(/ブログ掛け合い 60秒/)
    expect(text).toMatch(/キャラクター構成/)
    expect(text).toMatch(/同僚同士/)
    expect(text).toMatch(/背景/)
    expect(text).toMatch(/画面デモ/)
    expect(text).toMatch(/記事本文と出典/)
    expect(text).toMatch(/2人分のキャラクター画像/)
    // Markdown らしい見出し記号か、少なくとも構造化されたプレーンテキスト
    expect(text).toMatch(/^#|##|\*\*|型|用意/m)
  })

  it('コピーボタンがあり、クリックでプロンプトを clipboard に渡す', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(<TemplateChecklist template={template} choices={choices} />)

    const copyButton = screen.getAllByRole('button', { name: 'プロンプトをコピー' })[0]
    await user.click(copyButton)

    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = String(writeText.mock.calls[0][0])
    expect(copied).toMatch(/ブログ掛け合い 60秒/)
    expect(copied).toMatch(/同僚同士/)
    expect(copied).toMatch(/画面デモ/)
    expect(copied).toMatch(/記事本文と出典/)
    expect(screen.getAllByText(/プロンプトをコピーしました/).length).toBeGreaterThan(0)
  })

  it('writeText が reject しても閉じた details に依存せず本文選択の導線を示す', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(<TemplateChecklist template={template} choices={choices} />)

    const details = screen.getByText('素材・演出の詳細を見る').closest('details')
    expect(details).not.toHaveAttribute('open')

    await user.click(screen.getAllByRole('button', { name: 'プロンプトをコピー' })[0])

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/本文を選択して手動でコピー/)
    const brief = screen.getByLabelText('プロンプト本文')
    expect(brief).toBeVisible()
    expect(details?.contains(brief)).toBe(false)
    expect(details).not.toHaveAttribute('open')
  })

  it('生成・実行ボタンを置かない（閲覧専用）', () => {
    render(<TemplateChecklist template={template} choices={choices} />)

    expect(screen.queryByRole('button', { name: /生成|実行|run|render|はじめる|作成する/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Gate|ゲート/i })).not.toBeInTheDocument()
  })
})
