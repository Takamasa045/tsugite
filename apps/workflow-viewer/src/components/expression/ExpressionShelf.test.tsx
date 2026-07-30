import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ExpressionShelf, resetExpressionCatalogSessionCacheForTests } from './ExpressionShelf'
import type { ExpressionSelection } from './expressionLibraryModel'

const catalogResponse = {
  ok: true as const,
  schemaVersion: 1 as const,
  source: 'hyperframes' as const,
  advisoryOnly: true as const,
  capabilityVerified: false as const,
  summary: {
    total: 3,
    returned: 3,
    omitted: 0,
    byType: { block: 1, component: 2 },
  },
  items: [
    {
      id: 'data-chart',
      type: 'component' as const,
      title: 'Data Chart',
      description: 'Animated chart',
      tags: ['data', 'chart'],
    },
    {
      id: 'typewriter',
      type: 'component' as const,
      title: 'Typewriter',
      description: 'Text effect',
      tags: ['text', 'caption'],
    },
    {
      id: 'shader-mesh',
      type: 'block' as const,
      title: 'Shader Mesh',
      description: '3D mesh',
      tags: ['3d', 'shader'],
    },
  ],
  warnings: [] as string[],
}

const presentationPresets = [
  {
    backend: 'remotion',
    backendLabel: 'Remotion',
    id: 'article-dialogue-16x9',
    label: '横型・会話で解説',
    description: '記事を会話で伝える',
    aspectRatio: '16:9' as const,
  },
  {
    backend: 'remotion',
    backendLabel: 'Remotion',
    id: 'miraichi-lastcall-9x16',
    label: '縦型・締切／申込案内',
    description: '縦型案内',
    aspectRatio: '9:16' as const,
  },
  {
    backend: 'hyperframes',
    backendLabel: 'HyperFrames',
    id: 'article-explainer-16x9',
    label: '横型・資料付き解説',
    description: '資料付き',
    aspectRatio: '16:9' as const,
  },
]

function createFetcher(catalog: unknown = catalogResponse) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/reference-catalogs/hyperframes')) {
      return {
        ok: true,
        json: async () => catalog,
      } as Response
    }
    return {
      ok: false,
      json: async () => ({ ok: false }),
    } as Response
  })
}

describe('ExpressionShelf', () => {
  beforeEach(() => {
    resetExpressionCatalogSessionCacheForTests()
  })

  it('shows executable candidates without network and loads HyperFrames catalog only on explicit click', async () => {
    const user = userEvent.setup()
    const fetcher = createFetcher()
    const onSelectionsChange = vi.fn()

    render(
      <ExpressionShelf
        fetcher={fetcher}
        onSelectionsChange={onSelectionsChange}
        presentationPresetLoadState="ready"
        presentationPresets={presentationPresets}
        selectionMode="unset"
        selections={[]}
        token="session-token"
      />,
    )

    expect(await screen.findByRole('heading', { name: '動きの見本札から選ぶ' })).toBeVisible()
    const panel = screen.getByRole('tabpanel')
    expect(panel).toHaveAttribute('id', 'launcher-expressions-panel')
    expect(panel).toHaveAttribute('aria-labelledby', 'launcher-expressions-tab')
    expect(screen.getByRole('region', { name: '実行候補（未検証）' })).toBeVisible()
    expect(screen.getByRole('region', { name: '参考表現' })).toBeVisible()
    expect(screen.getByRole('button', { name: '実行候補（未検証）' })).toBeVisible()
    expect(screen.getByLabelText('準備段階')).toHaveDisplayValue('参考から探す')
    expect(screen.getByText('横型・会話で解説')).toBeVisible()
    expect(screen.getAllByText(/動きのイメージ・実際の出力ではありません|構成イメージ/).length).toBeGreaterThan(0)
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
  })

  it('recommends deterministically from free text and enforces selection limits', async () => {
    const user = userEvent.setup()
    const fetcher = createFetcher()
    let selections: ExpressionSelection[] = []
    let mode: 'unset' | 'explicit' = 'unset'
    const onSelectionsChange = vi.fn((next: { selections: ExpressionSelection[]; mode: 'unset' | 'explicit' }) => {
      selections = next.selections
      mode = next.mode
    })

    const { rerender } = render(
      <ExpressionShelf
        fetcher={fetcher}
        onSelectionsChange={onSelectionsChange}
        presentationPresetLoadState="ready"
        presentationPresets={presentationPresets}
        selectionMode={mode}
        selections={selections}
        token="session-token"
      />,
    )

    // 実行候補だけで推薦可能（catalog 未読込でも可）
    await user.type(screen.getByLabelText('どんな動画を作りたいですか'), '記事を会話で解説する横型')
    await user.selectOptions(screen.getByLabelText('比率'), '16:9')
    await user.click(screen.getByRole('button', { name: 'ローカルでおすすめを出す' }))

    const recommendRegion = await screen.findByRole('region', { name: 'おすすめ候補' })
    expect(within(recommendRegion).getAllByText(/合う理由/).length).toBeGreaterThan(0)
    expect(within(recommendRegion).getAllByText(/注意/).length).toBeGreaterThan(0)

    const addButtons = within(recommendRegion).getAllByRole('button', { name: '制作依頼へ追加' })
    await user.click(addButtons[0]!)
    expect(onSelectionsChange).toHaveBeenCalled()
    expect(mode).toBe('explicit')

    rerender(
      <ExpressionShelf
        fetcher={fetcher}
        onSelectionsChange={onSelectionsChange}
        presentationPresetLoadState="ready"
        presentationPresets={presentationPresets}
        selectionMode={mode}
        selections={selections}
        token="session-token"
      />,
    )
    expect(screen.getByText(/状態: 明示選択/)).toBeVisible()
  })

  it('keeps executable candidates when catalog fails after explicit load', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/reference-catalogs/hyperframes')) {
        return {
          ok: false,
          json: async () => ({ ok: false, issue: { code: 'busy', message: 'busy' } }),
        } as Response
      }
      return { ok: false, json: async () => ({}) } as Response
    })

    render(
      <ExpressionShelf
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
        presentationPresetLoadState="ready"
        presentationPresets={presentationPresets}
        selectionMode="unset"
        selections={[]}
        token="session-token"
      />,
    )

    expect(screen.getByText('横型・会話で解説')).toBeVisible()
    expect(fetcher).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/参考表現を読み込めませんでした/)
    expect(screen.getByRole('region', { name: '実行候補（未検証）' })).toBeVisible()

    // 初回失敗時は未読込案内を出さず、エラー領域の再読込ボタンだけ
    expect(screen.getAllByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /参考一覧を再読み込み/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/参考一覧はまだ読み込んでいません/)).not.toBeInTheDocument()
  })

  it('hides header reload button when a later catalog reload fails (single retry control)', async () => {
    const user = userEvent.setup()
    let calls = 0
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.includes('/api/reference-catalogs/hyperframes')) {
        return { ok: false, json: async () => ({}) } as Response
      }
      calls += 1
      if (calls === 1) {
        return {
          ok: true,
          json: async () => catalogResponse,
        } as Response
      }
      return {
        ok: false,
        json: async () => ({ ok: false, issue: { code: 'busy', message: 'busy' } }),
      } as Response
    })

    render(
      <ExpressionShelf
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
        presentationPresetLoadState="ready"
        presentationPresets={presentationPresets}
        selectionMode="unset"
        selections={[]}
        token="session-token"
      />,
    )

    await user.click(screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    }))
    expect(await screen.findByText('Data Chart')).toBeVisible()
    expect(screen.getByRole('button', { name: /参考一覧を再読み込み/ })).toBeVisible()

    await user.click(screen.getByRole('button', { name: /参考一覧を再読み込み/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/再読み込みに失敗|参考表現を読み込めませんでした/)
    // 再読込失敗時は見出し側を隠し、エラー領域の1ボタンだけ
    expect(screen.queryByRole('button', { name: /参考一覧を再読み込み/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    })).toHaveLength(1)
    // 前回成功一覧は維持
    expect(screen.getByText('Data Chart')).toBeVisible()
  })

  it('seeds intent from template metadata', async () => {
    const fetcher = createFetcher()
    render(
      <ExpressionShelf
        fetcher={fetcher}
        intentSeed={{
          freeText: 'ブログ掛け合い 60秒 記事の要点を会話で解説する',
          aspect: '16:9',
          purpose: '解説',
          readiness: 'explore',
        }}
        onSelectionsChange={vi.fn()}
        presentationPresetLoadState="ready"
        presentationPresets={presentationPresets}
        selectionMode="unset"
        selections={[]}
        token="session-token"
      />,
    )

    expect(await screen.findByDisplayValue(/ブログ掛け合い/)).toBeVisible()
    expect(screen.getByLabelText('比率')).toHaveValue('16:9')
  })

  it('shows plain Japanese copy and combinable selection policy in the tray', async () => {
    const fetcher = createFetcher()
    render(
      <ExpressionShelf
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
        presentationPresetLoadState="ready"
        presentationPresets={presentationPresets}
        selectionMode="explicit"
        selections={[
          {
            key: 'remotion::article-dialogue-16x9',
            provider: 'remotion',
            nativeId: 'article-dialogue-16x9',
            title: '横型・会話で解説',
            role: 'full-composition',
            capability: 'declared-executable-candidate',
            previewFidelity: 'composition-storyboard',
            reason: '解説向き',
            source: 'presentation-preset',
          },
          {
            key: 'hyperframes::data-chart',
            provider: 'hyperframes',
            nativeId: 'data-chart',
            title: 'Data Chart',
            role: 'data-viz',
            capability: 'reference-only',
            previewFidelity: 'motion-hint',
            reason: 'データ補助',
            source: 'reference-catalog',
          },
        ]}
        token="session-token"
      />,
    )

    expect(await screen.findByRole('heading', { name: '実行候補（未検証）' })).toBeVisible()
    expect(screen.getByText(/用意済みの日本語・英語の語彙表と表現一覧/)).toBeVisible()
    expect(screen.queryByText(/versioned lexicon|catalog metadata|presentation preset/i)).not.toBeInTheDocument()
    const tray = screen.getByRole('complementary', { name: '選んだ候補' })
    expect(tray).toHaveTextContent(/全体構成は最大1件/)
    expect(tray).toHaveTextContent(/補助表現は最大2件/)
    expect(tray).toHaveTextContent(/組み合わせ/)
    expect(tray).toHaveTextContent(/同じ役割/)
    expect(tray).not.toHaveTextContent(/同時適用しない/)
    expect(within(tray).getByText('全体構成')).toBeVisible()
    expect(within(tray).getByText('データ・図表')).toBeVisible()
    // tabpanel は制御元 tab id でラベル付けし、h2 は通常見出しのまま
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'launcher-expressions-tab')
    expect(screen.getByRole('heading', { name: '動きの見本札から選ぶ', level: 2 })).toBeVisible()
  })
})
