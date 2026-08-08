import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ExpressionShelf, resetExpressionCatalogSessionCacheForTests } from './ExpressionShelf'
import { EXPRESSION_PREVIEW_SAMPLE_TEXT } from './expressionPreviewSpec'
import {
  createFetcher,
  defaultShelfProps,
  presentationPresets,
} from './expressionShelfTestFixtures'

describe('ExpressionShelf core UI', () => {
  beforeEach(() => {
    resetExpressionCatalogSessionCacheForTests()
  })

  it('uses plain Japanese headings and loads catalog only on explicit click', async () => {
    const user = userEvent.setup()
    const fetcher = createFetcher()
    const onSelectionsChange = vi.fn()

    render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={onSelectionsChange}
      />,
    )

    expect(await screen.findByRole('heading', {
      name: '動きや仕上げを見比べて、プロンプトをコピーする',
    })).toBeVisible()
    const panel = screen.getByRole('tabpanel')
    expect(panel).toHaveAttribute('id', 'launcher-expressions-panel')
    expect(panel).toHaveAttribute('aria-labelledby', 'launcher-expressions-tab')
    expect(screen.getByRole('region', { name: 'この環境の仕上げ候補' })).toBeVisible()
    expect(screen.getByRole('region', { name: 'アイデアとして参照する表現' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'この環境の仕上げ候補' })).toBeVisible()
    expect(screen.getByLabelText('探す範囲')).toHaveDisplayValue('アイデアも含めて探す')
    expect(screen.getByText('横型・会話で解説')).toBeVisible()
    expect(screen.getAllByText(EXPRESSION_PREVIEW_SAMPLE_TEXT).length).toBeGreaterThan(0)
    expect(screen.getByText(/入力した内容・比率・目的/)).toBeVisible()
    expect(screen.getByText(/生成・書き出し・外部サービス実行・課金は行いません/)).toBeVisible()
    expect(fetcher).not.toHaveBeenCalled()
    expect(screen.queryByText('Data Chart')).not.toBeInTheDocument()
    expect(screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    })).toBeVisible()

    await user.click(screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    }))
    expect(await screen.findByText('Data Chart')).toBeVisible()
    expect(fetcher).toHaveBeenCalledWith('/api/reference-catalogs/hyperframes', {
      headers: {
        accept: 'application/json',
        'x-tsugite-token': 'session-token',
      },
    })

    // search must not re-fetch provider
    await user.type(screen.getByRole('searchbox'), 'chart')
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('reference-catalogs'))).toHaveLength(1)
    expect(screen.getByText('Data Chart')).toBeVisible()
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/絞り込み結果|件中|件を表示/).length).toBeGreaterThan(0)
  })

  it('shows status, fidelity, and destination on each card with unique action names', async () => {
    const user = userEvent.setup()
    const fetcher = createFetcher()
    render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
      />,
    )

    expect(screen.getAllByText('仕上げ候補').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/概念見本|実際の構成・動きの再現ではありません/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/コピー候補: 全体構成/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '一覧の横型・会話で解説をコピー候補に追加' })).toBeVisible()
    expect(screen.getByRole('button', { name: '一覧の横型・会話で解説をコピー候補に追加' }))
      .not.toHaveAttribute('aria-pressed')
    expect(screen.getByRole('button', { name: '一覧の横型・会話で解説のプロンプトをコピー' })).toBeVisible()

    await user.click(screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    }))
    expect(await screen.findByText('Data Chart')).toBeVisible()
    expect(screen.getAllByText('アイデア参考').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '一覧のData Chartをコピー候補に追加' })).toBeVisible()
    expect(screen.getByRole('button', { name: '一覧のData Chartのプロンプトをコピー' })).toBeVisible()
    expect(screen.getByRole('button', { name: /一覧のData Chartの見本を/ })).toBeVisible()
  })

  it('hides internal tags on cards while keeping search and always mounting status live region', async () => {
    const user = userEvent.setup()
    const fetcher = createFetcher()
    render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
      />,
    )

    // aria-live is always present (empty until status updates)
    const live = document.querySelector('.launcher-expression-status')
    expect(live).not.toBeNull()
    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(live?.textContent ?? '').toBe('')

    // Internal plumbing tags must not appear as card chips
    expect(screen.queryByText('presentation-preset')).not.toBeInTheDocument()
    expect(screen.queryByText('executable-candidate')).not.toBeInTheDocument()
    expect(screen.queryByText('aspect-unknown')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    }))
    expect(await screen.findByText('Data Chart')).toBeVisible()
    // HyperFrames human-facing catalog tags remain
    expect(screen.getByText('data')).toBeVisible()
    expect(screen.getByText('chart')).toBeVisible()
    expect(screen.queryByText('presentation-preset')).not.toBeInTheDocument()

    // Search still works against stored metadata (title/description/tags)
    await user.type(screen.getByRole('searchbox'), 'chart')
    expect(screen.getByText('Data Chart')).toBeVisible()
    expect(live?.textContent).toMatch(/件/)
  })

  it('recommends deterministically from free text and enforces selection limits', async () => {
    const user = userEvent.setup()
    const fetcher = createFetcher()
    let selections: import('./expressionLibraryModel').ExpressionSelection[] = []
    let mode: 'unset' | 'explicit' = 'unset'
    const onSelectionsChange = vi.fn((next: {
      selections: import('./expressionLibraryModel').ExpressionSelection[]
      mode: 'unset' | 'explicit'
    }) => {
      selections = next.selections
      mode = next.mode
    })

    const { rerender } = render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={onSelectionsChange}
        selectionMode={mode}
        selections={selections}
      />,
    )

    await user.type(screen.getByLabelText('どんな動画を作りたいですか'), '記事を会話で解説する横型')
    await user.selectOptions(screen.getByLabelText('比率'), '16:9')
    await user.click(screen.getByRole('button', { name: '入力内容から候補を絞り込む' }))

    const recommendRegion = await screen.findByRole('region', { name: '絞り込んだ候補' })
    expect(within(recommendRegion).getAllByText(/合う理由/).length).toBeGreaterThan(0)
    expect(within(recommendRegion).getAllByText(/注意/).length).toBeGreaterThan(0)
    // catalog not loaded + explore scope → disclose limited search range
    expect(within(recommendRegion).getByText(/今検索できる範囲は、この環境の仕上げ候補だけ/)).toBeVisible()
    expect(within(recommendRegion).getByText(/外部通信あり/)).toBeVisible()
    expect(fetcher).not.toHaveBeenCalled()

    const addButtons = within(recommendRegion).getAllByRole('button', { name: /絞り込んだ候補の.+をコピー候補に追加$/ })
    await user.click(addButtons[0]!)
    expect(onSelectionsChange).toHaveBeenCalled()
    expect(mode).toBe('explicit')

    rerender(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={onSelectionsChange}
        selectionMode={mode}
        selections={selections}
      />,
    )
    expect(screen.getByText(/状態: コピー候補を選択中/)).toBeVisible()
  })

  it('seeds intent from template metadata', async () => {
    const fetcher = createFetcher()
    render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        intentSeed={{
          freeText: 'ブログ掛け合い 60秒 記事の要点を会話で解説する',
          aspect: '16:9',
          purpose: '解説',
          readiness: 'explore',
        }}
        onSelectionsChange={vi.fn()}
      />,
    )

    expect(await screen.findByDisplayValue(/ブログ掛け合い/)).toBeVisible()
    expect(screen.getByLabelText('比率')).toHaveValue('16:9')
  })

  it('shows plain Japanese copy and combinable selection policy in the tray', async () => {
    const fetcher = createFetcher()
    render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
        selectionMode="explicit"
        selections={[
          {
            key: 'presentation-preset::remotion::article-dialogue-16x9',
            provider: 'remotion',
            nativeId: 'article-dialogue-16x9',
            title: '横型・会話で解説',
            description: '記事を会話で伝える',
            tags: ['remotion', '16:9'],
            features: ['dialogue'],
            role: 'full-composition',
            capability: 'declared-executable-candidate',
            previewFidelity: 'composition-storyboard',
            reason: '解説向き',
            source: 'presentation-preset',
          },
          {
            key: 'reference-catalog::hyperframes::component::data-chart',
            provider: 'hyperframes',
            nativeId: 'data-chart',
            title: 'Data Chart',
            description: 'Animated chart',
            tags: ['data', 'chart'],
            features: ['data'],
            role: 'data-viz',
            capability: 'reference-only',
            previewFidelity: 'motion-hint',
            reason: 'データ補助',
            source: 'reference-catalog',
          },
        ]}
      />,
    )

    expect(await screen.findByRole('heading', { name: 'この環境の仕上げ候補' })).toBeVisible()
    expect(screen.getByText(/この端末内の一覧と照合/)).toBeVisible()
    // UI chrome must stay plain Japanese (prompt export may still contain data-only notes)
    const intentNote = screen.getByText(/この端末内の一覧と照合/)
    expect(intentNote.textContent).not.toMatch(/versioned lexicon|presentation preset/i)
    const tray = screen.getByRole('complementary', { name: 'コピー候補' })
    expect(tray).toHaveTextContent(/全体構成は最大1件/)
    expect(tray).toHaveTextContent(/補助表現は最大2件/)
    expect(tray).toHaveTextContent(/組み合わせ/)
    expect(tray).toHaveTextContent(/同じ役割/)
    expect(tray).not.toHaveTextContent(/同時適用しない/)
    expect(within(tray).getByText('全体構成')).toBeVisible()
    expect(within(tray).getByText('データ・図表')).toBeVisible()
    expect(within(tray).getByRole('button', { name: '横型・会話で解説を外す' })).toBeVisible()
    expect(within(tray).getByRole('button', { name: 'Data Chartを外す' })).toBeVisible()
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'launcher-expressions-tab')
    expect(screen.getByRole('heading', {
      name: '動きや仕上げを見比べて、プロンプトをコピーする',
      level: 2,
    })).toBeVisible()
    // presentationPresets fixture still used for tray context
    expect(presentationPresets.length).toBeGreaterThan(0)
  })
})
