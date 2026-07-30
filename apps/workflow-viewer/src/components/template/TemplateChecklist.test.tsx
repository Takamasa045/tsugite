/**
 * Phase 3 目標契約（RED）:
 * - export: TemplateChecklist
 * - props: template, choices（axisId → optionId）
 * - 必須/任意の振り分け（requiredInputDetails[].required）
 * - notFor 警告、制作依頼 Markdown、コピーボタン
 * - 生成・実行ボタンは置かない（閲覧専用）
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
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

  it('見出しと主操作を制作依頼だけのコピー導線にする', () => {
    render(<TemplateChecklist template={template} choices={choices} />)

    expect(screen.getByRole('heading', { name: '制作依頼ができました' })).toBeVisible()
    const primaryCopy = screen.getByRole('button', { name: '制作依頼だけをコピー' })
    expect(primaryCopy).toBeVisible()
    expect(primaryCopy).toHaveClass('launcher-primary')
    expect(screen.getAllByRole('button', { name: '制作依頼だけをコピー' })).toHaveLength(1)
    expect(screen.getByText(/任意素材や「向かない用途」はコピーしません/)).toBeVisible()
    expect(
      screen.getByText((content) => content.includes('この画面では生成・実行・Gate更新をしません')),
    ).toBeVisible()
    expect(screen.getByText('素材・演出の詳細を見る')).toBeVisible()
  })

  it('初期状態でそのまま貼れる制作依頼が見え、詳細 details を開かなくても確認できる', () => {
    render(<TemplateChecklist template={template} choices={choices} />)

    const brief = screen.getByLabelText('制作依頼本文')
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

  it('コピー前に必須素材と画像の渡し方を常時表示する', () => {
    render(
      <TemplateChecklist
        template={{
          ...template,
          id: 'commerce-showcase',
          name: '商品紹介',
          requiredInputDetails: [
            {
              type: 'image',
              label: '商品写真、利用画面、商品ロゴ',
              required: true,
            },
            {
              type: 'data',
              label: '価格、仕様、販売条件の正本',
              required: true,
            },
          ],
        }}
        choices={choices}
      />,
    )

    const materials = screen.getByRole('region', { name: 'コピー前に用意する必須素材' })
    expect(materials).toBeVisible()
    expect(within(materials).getByText('商品写真、利用画面、商品ロゴ')).toBeVisible()
    expect(within(materials).getByText(/画像を添付するか、参照できるファイルパス/)).toBeVisible()
    expect(within(materials).getByText(/ロゴの文字・形・配色・余白を変更しないでください/)).toBeVisible()
  })

  it('必須と任意の入力を振り分けて表示する', async () => {
    const user = userEvent.setup()
    render(<TemplateChecklist template={template} choices={{ cast: 'beginner-expert', background: 'ui-window' }} />)
    await openDetails(user)

    const requiredSection = screen.getByRole('region', { name: '必須の用意するもの' })
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

    const requiredSection = screen.getByRole('region', { name: '必須の用意するもの' })
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

  it('制作依頼 Markdown に型名・各軸・必須素材を含め、補助情報を除外する', () => {
    render(<TemplateChecklist template={template} choices={choices} />)

    const brief = screen.getByLabelText('制作依頼本文')
    const text = brief.textContent ?? ''
    expect(brief).toBeVisible()
    expect(text).toMatch(/ブログ掛け合い 60秒/)
    expect(text).toMatch(/キャラクター構成/)
    expect(text).toMatch(/同僚同士/)
    expect(text).toMatch(/背景/)
    expect(text).toMatch(/画面デモ/)
    expect(text).toMatch(/記事本文と出典/)
    expect(text).toMatch(/2人分のキャラクター画像/)
    expect(text).not.toMatch(/参考リンク一覧|向かない用途|無言の商品イメージ映像/)
    expect(text).toMatch(/^# 制作依頼/m)
  })

  it('コピーボタンが制作依頼だけを clipboard に渡す', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(<TemplateChecklist template={template} choices={choices} />)

    const copyButton = screen.getByRole('button', { name: '制作依頼だけをコピー' })
    await user.click(copyButton)

    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = String(writeText.mock.calls[0][0])
    expect(copied).toMatch(/ブログ掛け合い 60秒/)
    expect(copied).toMatch(/同僚同士/)
    expect(copied).toMatch(/画面デモ/)
    expect(copied).toMatch(/記事本文と出典/)
    expect(copied).toMatch(/未提供の素材や事実を推測・生成で補わない/)
    expect(copied).not.toMatch(/参考リンク一覧|向かない用途|無言の商品イメージ映像/)
    expect(screen.getAllByText(/制作依頼をコピーしました/).length).toBeGreaterThan(0)
  })

  it('標準 clipboard が使えない環境では選択コピーへフォールバックする', async () => {
    const user = userEvent.setup()
    const previousExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')
    const execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })

    try {
      render(<TemplateChecklist template={template} choices={choices} />)
      await user.click(screen.getByRole('button', { name: '制作依頼だけをコピー' }))

      expect(execCommand).toHaveBeenCalledWith('copy')
      expect(screen.getByRole('button', { name: '制作依頼をコピーしました' })).toBeVisible()
      expect(document.querySelector('textarea[aria-hidden="true"]')).not.toBeInTheDocument()
    } finally {
      if (previousExecCommand) {
        Object.defineProperty(document, 'execCommand', previousExecCommand)
      } else {
        Reflect.deleteProperty(document, 'execCommand')
      }
    }
  })

  it('clipboard が応答しない場合は手動コピーの案内へ切り替える', async () => {
    vi.useFakeTimers()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => new Promise<void>(() => {})) },
    })

    try {
      render(<TemplateChecklist template={template} choices={choices} />)
      fireEvent.click(screen.getByRole('button', { name: '制作依頼だけをコピー' }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500)
      })

      expect(screen.getByRole('alert')).toHaveTextContent(/本文を選択して手動でコピー/)
      expect(screen.getByLabelText('制作依頼本文')).toBeVisible()
    } finally {
      vi.useRealTimers()
    }
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

    await user.click(screen.getByRole('button', { name: '制作依頼だけをコピー' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/本文を選択して手動でコピー/)
    const brief = screen.getByLabelText('制作依頼本文')
    expect(brief).toBeVisible()
    expect(details?.contains(brief)).toBe(false)
    expect(details).not.toHaveAttribute('open')
  })

  it('生成・実行ボタンを置かない（閲覧専用）', () => {
    render(<TemplateChecklist template={template} choices={choices} />)

    expect(screen.queryByRole('button', { name: /生成|実行|run|render|はじめる|作成する/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Gate|ゲート/i })).not.toBeInTheDocument()
  })

  it('ブランド固定 preset 4件を視覚とスクリーンリーダー双方に明示する', () => {
    render(
      <TemplateChecklist
        choices={choices}
        presentationPresetLoadState="ready"
        presentationPresets={[
          {
            backend: 'remotion',
            backendLabel: 'Remotion',
            id: 'street-dialogue-16x9',
            label: '横型・テンポ重視の会話解説',
            description: 'テンポよく',
            aspectRatio: '16:9',
          },
          {
            backend: 'remotion',
            backendLabel: 'Remotion',
            id: 'tsugite-summer-camp-generated-16x9',
            label: '横型・イベント／サービス告知',
            description: '告知',
            aspectRatio: '16:9',
          },
          {
            backend: 'remotion',
            backendLabel: 'Remotion',
            id: 'miraichi-lastcall-9x16',
            label: '縦型・締切／申込案内',
            description: '締切',
            aspectRatio: '9:16',
          },
          {
            backend: 'remotion',
            backendLabel: 'Remotion',
            id: 'orbital-showreel-16x9',
            label: '横型・作品ダイジェスト',
            description: 'ダイジェスト',
            aspectRatio: '16:9',
          },
          {
            backend: 'remotion',
            backendLabel: 'Remotion',
            id: 'article-dialogue-16x9',
            label: '横型・会話で解説',
            description: '一般向け',
            aspectRatio: '16:9',
          },
        ]}
        template={template}
      />,
    )

    const section = screen.getByRole('region', { name: '仕上げ構成（実行候補）' })
    for (const name of [
      '横型・テンポ重視の会話解説、Remotion、16:9、ブランド固定',
      '横型・イベント／サービス告知、Remotion、16:9、ブランド固定',
      '縦型・締切／申込案内、Remotion、9:16、ブランド固定',
      '横型・作品ダイジェスト、Remotion、16:9、ブランド固定',
    ]) {
      expect(within(section).getByRole('button', { name })).toBeVisible()
    }
    expect(within(section).getAllByText('ブランド固定')).toHaveLength(4)
    // 一般 preset も label / backend / aspect を保つ（ブランド固定は付けない）
    expect(within(section).getByRole('button', {
      name: '横型・会話で解説、Remotion、16:9',
    })).toBeVisible()
    expect(within(section).queryByRole('button', {
      name: /横型・会話で解説、Remotion、16:9、ブランド固定/,
    })).not.toBeInTheDocument()
  })

  it('仕上げの動きをコピー直前に表示し、未選択はおすすめに任せる', () => {
    render(
      <TemplateChecklist
        choices={choices}
        presentationPresetLoadState="ready"
        presentationPresets={[
          {
            backend: 'remotion',
            backendLabel: 'Remotion',
            id: 'article-dialogue-16x9',
            label: '横型・会話で解説',
            description: '記事やテーマを、会話のやりとりでわかりやすく伝える向きです。',
            aspectRatio: '16:9',
          },
          {
            backend: 'hyperframes',
            backendLabel: 'HyperFrames',
            id: 'article-explainer-9x16',
            label: '縦型・資料付き解説',
            description: '資料や図解を交えて解説する縦型向けです。',
            aspectRatio: '9:16',
          },
          {
            backend: 'remotion',
            backendLabel: 'Remotion',
            id: 'brand-new-unlisted-preset',
            label: 'brand-new-unlisted-preset',
            description: null,
            aspectRatio: null,
          },
        ]}
        template={template}
      />,
    )

    const section = screen.getByRole('region', { name: '仕上げ構成（実行候補）' })
    expect(section).toBeVisible()
    expect(within(section).getByRole('heading', { name: '仕上げ構成（実行候補）' })).toBeVisible()
    expect(within(section).getByText(/ここでは制作依頼に追加するだけ/)).toBeVisible()

    const recommended = within(section).getByRole('button', { name: /おすすめに任せる/ })
    expect(recommended).toHaveAttribute('aria-pressed', 'true')
    expect(within(section).getAllByText('Remotion').length).toBeGreaterThan(0)
    expect(within(section).getByText('HyperFrames')).toBeVisible()
    expect(within(section).getByText('16:9')).toBeVisible()
    expect(within(section).getByText('9:16')).toBeVisible()
    expect(within(section).getByText('横型・会話で解説')).toBeVisible()
    expect(within(section).getByText(/会話のやりとりでわかりやすく/)).toBeVisible()
    // 未知 ID も隠さず表示（見出しと code の両方に出る）
    expect(within(section).getAllByText('brand-new-unlisted-preset').length).toBeGreaterThan(0)
    // 埋め込み catalog は置かず、選んだ表現セクションへ
    expect(screen.queryByText('表現のヒントを探す')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '選んだ表現' })).toBeVisible()
    expect(screen.getByText(/状態: おすすめ候補を未選択/)).toBeVisible()

    const brief = screen.getByLabelText('制作依頼本文')
    expect(brief.textContent).toMatch(/おすすめ候補を未選択/)
    expect(brief.textContent).not.toMatch(/article-dialogue-16x9/)

    // コピーボタンより前に配置（DOM 順）
    const primary = screen.getByRole('button', { name: '制作依頼だけをコピー' })
    expect(
      (section.compareDocumentPosition(primary) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ).toBe(true)
  })

  it('仕上げ構成（実行候補）と制作依頼本文とコピー内容へ反映する', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(
      <TemplateChecklist
        choices={choices}
        presentationPresetLoadState="ready"
        presentationPresets={[
          {
            backend: 'remotion',
            backendLabel: 'Remotion',
            id: 'article-dialogue-16x9',
            label: '横型・会話で解説',
            description: '記事やテーマを、会話のやりとりでわかりやすく伝える向きです。',
            aspectRatio: '16:9',
          },
        ]}
        template={template}
      />,
    )

    await user.click(screen.getByRole('button', { name: /横型・会話で解説/ }))
    const brief = screen.getByLabelText('制作依頼本文')
    expect(brief.textContent).toMatch(/仕上げの動き（実行候補）/)
    expect(brief.textContent).toMatch(/remotion/)
    expect(brief.textContent).toMatch(/article-dialogue-16x9/)
    expect(brief.textContent).toMatch(/validate|Gate 1/)

    await user.click(screen.getByRole('button', { name: '制作依頼だけをコピー' }))
    const copied = String(writeText.mock.calls[0][0])
    expect(copied).toMatch(/article-dialogue-16x9/)
    expect(copied).toMatch(/勝手に別presetへ変えず確認/)

    await user.click(screen.getByRole('button', { name: /おすすめに任せる/ }))
    expect(screen.getByLabelText('制作依頼本文').textContent).not.toMatch(/article-dialogue-16x9/)
  })

  it('仕上げの動きの loading / error / empty を壊さず表示する', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    const { rerender } = render(
      <TemplateChecklist
        choices={choices}
        presentationPresetLoadState="loading"
        presentationPresets={[]}
        template={template}
      />,
    )
    expect(screen.getByText(/仕上げの動きを読み込んでいます/)).toBeVisible()

    rerender(
      <TemplateChecklist
        choices={choices}
        onRetryPresentationPresets={onRetry}
        presentationPresetLoadState="error"
        presentationPresets={[]}
        template={template}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/仕上げの動きを読み込めませんでした/)
    await user.click(screen.getByRole('button', { name: '仕上げの動きをもう一度読み込む' }))
    expect(onRetry).toHaveBeenCalledTimes(1)

    rerender(
      <TemplateChecklist
        choices={choices}
        presentationPresetLoadState="ready"
        presentationPresets={[]}
        template={template}
      />,
    )
    expect(screen.getByText(/表示できる仕上げの動きはまだありません/)).toBeVisible()
  })
})
