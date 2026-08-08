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

    const materials = screen.getByRole('region', { name: '最低限渡すもの' })
    expect(materials).toBeVisible()
    expect(within(materials).getByRole('heading', { name: '最低限渡すもの' })).toBeVisible()
    expect(within(materials).getByText('商品写真、利用画面、商品ロゴ')).toBeVisible()
    expect(within(materials).getByText(/画像を添付するか、参照できるファイルパス/)).toBeVisible()
    expect(within(materials).getByText(/ロゴの文字・形・配色・余白を変更しないでください/)).toBeVisible()
  })

  it('aiCanPropose があるとき主要画面で AIに任せられることを分離表示する', () => {
    render(
      <TemplateChecklist
        template={{
          ...template,
          aiCanPropose: ['タイトル案', 'CTA文言'],
        }}
        choices={choices}
      />,
    )

    const requiredRegion = screen.getByRole('region', { name: '最低限渡すもの' })
    const aiRegion = screen.getByRole('region', { name: 'AIに任せられること' })
    expect(requiredRegion).toBeVisible()
    expect(aiRegion).toBeVisible()
    // handoff と同等のベース枠・padding・レスポンシブを共有し、差分は modifier で持つ
    expect(requiredRegion).toHaveClass('launcher-template-checklist-handoff')
    expect(aiRegion).toHaveClass(
      'launcher-template-checklist-handoff',
      'launcher-template-checklist-ai-propose',
    )
    expect(within(aiRegion).getByRole('heading', { name: 'AIに任せられること' })).toBeVisible()
    expect(within(aiRegion).getByText('タイトル案')).toBeVisible()
    expect(within(aiRegion).getByText('CTA文言')).toBeVisible()
    expect(within(requiredRegion).queryByText('タイトル案')).not.toBeInTheDocument()

    const brief = screen.getByLabelText('制作依頼本文')
    expect(brief.textContent).toContain('## AIに任せること')
    expect(brief.textContent).toContain('タイトル案')
    expect(within(aiRegion).getByRole('heading', { name: 'AIに任せられること' })).toBeVisible()
    expect(screen.getByText(/目的・選択内容・必須素材・AIに任せること・制作条件/)).toBeVisible()
  })

  it('aiCanPropose が無いとき AIに任せられること の空セクションを出さない', () => {
    render(<TemplateChecklist template={template} choices={choices} />)

    expect(screen.queryByRole('region', { name: 'AIに任せられること' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'AIに任せられること' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('制作依頼本文').textContent).not.toContain('## AIに任せること')
  })

  it('aiCanPropose が空/未指定のときコピー範囲と閲覧専用注記に AI委任文言を出さない', () => {
    const { unmount } = render(<TemplateChecklist template={template} choices={choices} />)

    const copyScopeAbsent = document.querySelector('.launcher-template-checklist-copy-scope')
    expect(copyScopeAbsent).not.toBeNull()
    expect(copyScopeAbsent?.textContent).toMatch(/目的・選択内容・必須素材・制作条件/)
    expect(copyScopeAbsent?.textContent).not.toMatch(/AIに任せること/)

    const readonlyAbsent = document.querySelector('.launcher-readonly-note')
    expect(readonlyAbsent).not.toBeNull()
    expect(readonlyAbsent?.textContent).toMatch(/この画面では生成・実行・Gate更新をしません/)
    expect(readonlyAbsent?.textContent).not.toMatch(/AIに任せることの項目は/)
    unmount()

    // 空配列も resolve 後 length 0 として扱い、未指定と同じ文言にする
    render(
      <TemplateChecklist
        template={{
          ...template,
          aiCanPropose: [],
        }}
        choices={choices}
      />,
    )
    const copyScopeEmpty = document.querySelector('.launcher-template-checklist-copy-scope')
    expect(copyScopeEmpty?.textContent).toMatch(/目的・選択内容・必須素材・制作条件/)
    expect(copyScopeEmpty?.textContent).not.toMatch(/AIに任せること/)
    const readonlyEmpty = document.querySelector('.launcher-readonly-note')
    expect(readonlyEmpty?.textContent).not.toMatch(/AIに任せることの項目は/)
  })

  it('aiCanPropose の trim 後重複は1件だけ表示し、現在必須 label は AI 節から除外する', () => {
    render(
      <TemplateChecklist
        template={{
          ...template,
          aiCanPropose: [
            '  タイトル案  ',
            'タイトル案',
            '記事本文と出典', // base required → AI から除外
            'CTA文言',
          ],
        }}
        choices={choices}
      />,
    )

    const aiRegion = screen.getByRole('region', { name: 'AIに任せられること' })
    expect(within(aiRegion).getAllByText('タイトル案')).toHaveLength(1)
    expect(within(aiRegion).getByText('CTA文言')).toBeVisible()
    expect(within(aiRegion).queryByText('記事本文と出典')).not.toBeInTheDocument()

    const requiredRegion = screen.getByRole('region', { name: '最低限渡すもの' })
    expect(within(requiredRegion).getByText('記事本文と出典')).toBeVisible()

    const brief = screen.getByLabelText('制作依頼本文').textContent ?? ''
    const aiBrief = brief.slice(brief.indexOf('## AIに任せること'), brief.indexOf('## 最初に行うこと'))
    expect(aiBrief.match(/- タイトル案/g)).toHaveLength(1)
    expect(aiBrief).not.toMatch(/^- 記事本文と出典$/m)
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
    expect(copied).toMatch(/未提供の事実・実績・権利情報・正本素材を推測・創作しない/)
    expect(copied).not.toMatch(/参考リンク一覧|向かない用途|無言の商品イメージ映像/)
    expect(screen.getAllByText(/制作依頼をコピーしました/).length).toBeGreaterThan(0)
  })

  it('コピー範囲と閲覧専用説明に AI委任の扱いを含める', () => {
    render(
      <TemplateChecklist
        template={{
          ...template,
          aiCanPropose: ['タイトル案'],
        }}
        choices={choices}
      />,
    )

    expect(screen.getByText(/目的・選択内容・必須素材・AIに任せること・制作条件/)).toBeVisible()
    expect(
      screen.getByText((content) => (
        content.includes('この画面では生成・実行・Gate更新をしません')
        && content.includes('AIに任せること')
      )),
    ).toBeVisible()
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

  it('任意の仕上げ指定を表示・制作依頼本文・コピー内容に含めない', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(<TemplateChecklist template={template} choices={choices} />)

    expect(screen.queryByRole('heading', { name: 'この環境の仕上げ候補' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('制作依頼本文').textContent).not.toMatch(
      /この環境の仕上げ候補|article-dialogue-16x9/,
    )

    await user.click(screen.getByRole('button', { name: '制作依頼だけをコピー' }))
    expect(String(writeText.mock.calls[0]?.[0] ?? '')).not.toMatch(
      /この環境の仕上げ候補|article-dialogue-16x9/,
    )
  })

  it('選んだ表現は制作依頼本文に混ぜず、別ボタンで表現プロンプトだけコピーする', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    const expressionSelections = [
      {
        key: 'presentation-preset::remotion::article-dialogue-16x9',
        provider: 'remotion',
        nativeId: 'article-dialogue-16x9',
        title: '横型・会話で解説',
        description: '会話で解説する',
        tags: ['remotion', '16:9'],
        features: ['dialogue'],
        role: 'full-composition' as const,
        capability: 'declared-executable-candidate' as const,
        previewFidelity: 'composition-storyboard' as const,
        reason: '横型解説向き',
        source: 'presentation-preset' as const,
      },
    ]

    render(
      <TemplateChecklist
        template={template}
        choices={choices}
        expressionSelectionMode="explicit"
        expressionSelections={expressionSelections}
      />,
    )

    // mount では自動コピーしない
    expect(writeText).toHaveBeenCalledTimes(0)
    expect(screen.getByRole('heading', { name: '選んだ表現' })).toBeVisible()
    expect(screen.getByRole('heading', { name: '選んだ表現のプロンプト' })).toBeVisible()
    const expressionPreview = screen.getByRole('textbox', { name: '選んだ表現のプロンプト' })
    const expressionPreviewValue = String(
      (expressionPreview as HTMLTextAreaElement).value ?? '',
    )
    expect(expressionPreviewValue).toContain('## 表現プロンプト（コピー候補）')
    expect(expressionPreviewValue).toContain(JSON.stringify('article-dialogue-16x9'))

    const brief = screen.getByLabelText('制作依頼本文')
    expect(brief.textContent).not.toContain('## 表現プロンプト')
    expect(brief.textContent).not.toContain('article-dialogue-16x9')
    expect(brief.textContent).not.toContain('横型・会話で解説')

    await user.click(screen.getByRole('button', { name: '制作依頼だけをコピー' }))
    expect(writeText).toHaveBeenCalledTimes(1)
    const productionCopied = String(writeText.mock.calls[0]?.[0] ?? '')
    expect(productionCopied).toContain('# 制作依頼')
    expect(productionCopied).not.toContain('article-dialogue-16x9')
    expect(productionCopied).not.toContain('## 表現プロンプト')

    await user.click(screen.getByRole('button', { name: '表現プロンプトをコピー' }))
    expect(writeText).toHaveBeenCalledTimes(2)
    const expressionCopied = String(writeText.mock.calls[1]?.[0] ?? '')
    expect(expressionCopied).toContain('## 表現プロンプト（コピー候補）')
    expect(expressionCopied).toContain(JSON.stringify('article-dialogue-16x9'))
    expect(expressionCopied).toMatch(/制作依頼本文へは自動では入りません/)
  })

  it('copyWithHiddenTextarea restores focus to the copy button after fallback', async () => {
    const user = userEvent.setup()
    const previousExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')
    const execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })
    // Force fallback path: no usable clipboard API.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })

    try {
      render(<TemplateChecklist template={template} choices={choices} />)
      const copyButton = screen.getByRole('button', { name: '制作依頼だけをコピー' })
      copyButton.focus()
      await user.click(copyButton)
      expect(execCommand).toHaveBeenCalledWith('copy')
      expect(document.querySelector('textarea[aria-hidden="true"]')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '制作依頼をコピーしました' })).toHaveFocus()
      expect(document.activeElement).not.toBe(document.body)
    } finally {
      if (previousExecCommand) {
        Object.defineProperty(document, 'execCommand', previousExecCommand)
      } else {
        Reflect.deleteProperty(document, 'execCommand')
      }
    }
  })

})
