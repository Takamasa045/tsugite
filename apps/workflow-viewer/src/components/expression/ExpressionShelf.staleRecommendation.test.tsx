import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ExpressionShelf, resetExpressionCatalogSessionCacheForTests } from './ExpressionShelf'
import {
  createFetcher,
  defaultShelfProps,
  presentationPresets,
} from './expressionShelfTestFixtures'

describe('ExpressionShelf stale recommendation hygiene', () => {
  beforeEach(() => {
    resetExpressionCatalogSessionCacheForTests()
  })

  it('disables recommend while presentation presets are loading, then enables after ready', async () => {
    const fetcher = createFetcher()
    const { rerender } = render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
        presentationPresetLoadState="loading"
        presentationPresets={[]}
      />,
    )

    const recommendButton = screen.getByRole('button', { name: '入力内容から候補を絞り込む' })
    expect(recommendButton).toBeDisabled()
    expect(screen.getByText(/読み込み後に候補の絞り込みが操作できます/)).toBeVisible()
    expect(fetcher).not.toHaveBeenCalled()

    rerender(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
        presentationPresetLoadState="ready"
        presentationPresets={presentationPresets}
      />,
    )

    expect(screen.getByRole('button', { name: '入力内容から候補を絞り込む' })).not.toBeDisabled()
    expect(screen.queryByText(/読み込み後に候補の絞り込みが操作できます/)).not.toBeInTheDocument()
    // delayed ready must not auto-fetch catalog
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('clears recommendation when presentation preset key pool updates after recommend', async () => {
    const user = userEvent.setup()
    const fetcher = createFetcher()
    const { rerender } = render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
      />,
    )

    await user.type(screen.getByLabelText('どんな動画を作りたいですか'), '記事を会話で解説する横型')
    await user.click(screen.getByRole('button', { name: '入力内容から候補を絞り込む' }))
    expect(await screen.findByRole('region', { name: '絞り込んだ候補' })).toBeVisible()

    const updatedPresets = [
      ...presentationPresets,
      {
        backend: 'remotion',
        backendLabel: 'Remotion',
        id: 'new-preset-16x9',
        label: '新規仕上げ',
        description: '追加された仕上げ',
        aspectRatio: '16:9' as const,
      },
    ]
    rerender(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
        presentationPresets={updatedPresets}
      />,
    )

    expect(screen.queryByRole('region', { name: '絞り込んだ候補' })).not.toBeInTheDocument()
    expect(screen.getByText(/仕上げ候補の一覧が更新されたため/)).toBeVisible()
    expect(screen.getByText(/もう一度「入力内容から候補を絞り込む」/)).toBeVisible()
    // no auto re-recommend, no catalog fetch
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('clears recommendation when same-id preset label/description/aspectRatio change (metadata-only)', async () => {
    const user = userEvent.setup()
    const fetcher = createFetcher()
    const { rerender } = render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
        presentationPresets={presentationPresets}
      />,
    )

    await user.type(screen.getByLabelText('どんな動画を作りたいですか'), '記事を会話で解説する横型')
    await user.click(screen.getByRole('button', { name: '入力内容から候補を絞り込む' }))
    expect(await screen.findByRole('region', { name: '絞り込んだ候補' })).toBeVisible()
    // Recommendation cards hold the pre-update ExpressionItem snapshot
    expect(screen.getAllByText('横型・会話で解説').length).toBeGreaterThan(0)

    // Same backend/id only — label, description, aspectRatio all change.
    // List cards re-normalize from props; recommendation must not keep the old item.
    const metadataOnlyUpdate = presentationPresets.map((preset) =>
      preset.id === 'article-dialogue-16x9'
        ? {
            ...preset,
            label: '横型・会話解説（改訂）',
            description: '改訂された説明文',
            aspectRatio: '9:16' as const,
          }
        : preset,
    )
    rerender(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
        presentationPresets={metadataOnlyUpdate}
      />,
    )

    expect(screen.queryByRole('region', { name: '絞り込んだ候補' })).not.toBeInTheDocument()
    expect(screen.getByText(/仕上げ候補の一覧が更新されたため/)).toBeVisible()
    // Browse list reflects new metadata; stale recommendation entry is gone
    expect(screen.getByText('横型・会話解説（改訂）')).toBeVisible()
    expect(screen.queryByText('横型・会話で解説')).not.toBeInTheDocument()
    // no auto re-recommend, no catalog fetch, first-mount suppression still applies elsewhere
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not clear recommendation when only backendLabel changes (unused by normalize)', async () => {
    const user = userEvent.setup()
    const fetcher = createFetcher()
    const { rerender } = render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
        presentationPresets={presentationPresets}
      />,
    )

    await user.type(screen.getByLabelText('どんな動画を作りたいですか'), '記事を会話で解説する横型')
    await user.click(screen.getByRole('button', { name: '入力内容から候補を絞り込む' }))
    expect(await screen.findByRole('region', { name: '絞り込んだ候補' })).toBeVisible()

    // backendLabel is display-only on the wire option; normalizePresentationPreset ignores it.
    const backendLabelOnly = presentationPresets.map((preset) => ({
      ...preset,
      backendLabel: `${preset.backendLabel} (display)`,
    }))
    rerender(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
        presentationPresets={backendLabelOnly}
      />,
    )

    expect(screen.getByRole('region', { name: '絞り込んだ候補' })).toBeVisible()
    expect(screen.queryByText(/仕上げ候補の一覧が更新されたため/)).not.toBeInTheDocument()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('clears recommendation when intent inputs change after recommend (no auto re-run)', async () => {
    const user = userEvent.setup()
    const fetcher = createFetcher()
    render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
      />,
    )

    await user.type(screen.getByLabelText('どんな動画を作りたいですか'), '記事を会話で解説する横型')
    await user.click(screen.getByRole('button', { name: '入力内容から候補を絞り込む' }))
    expect(await screen.findByRole('region', { name: '絞り込んだ候補' })).toBeVisible()

    await user.selectOptions(screen.getByLabelText('比率'), '9:16')
    expect(screen.queryByRole('region', { name: '絞り込んだ候補' })).not.toBeInTheDocument()
    expect(screen.getByText(/条件が変わったため、以前の候補は無効です/)).toBeVisible()

    // purpose / readiness / calm motion also clear (recommend again first)
    await user.click(screen.getByRole('button', { name: '入力内容から候補を絞り込む' }))
    expect(await screen.findByRole('region', { name: '絞り込んだ候補' })).toBeVisible()
    await user.selectOptions(screen.getByLabelText('目的'), 'promo')
    expect(screen.queryByRole('region', { name: '絞り込んだ候補' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '入力内容から候補を絞り込む' }))
    expect(await screen.findByRole('region', { name: '絞り込んだ候補' })).toBeVisible()
    await user.selectOptions(screen.getByLabelText('探す範囲'), 'ready')
    expect(screen.queryByRole('region', { name: '絞り込んだ候補' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '入力内容から候補を絞り込む' }))
    expect(await screen.findByRole('region', { name: '絞り込んだ候補' })).toBeVisible()
    await user.click(screen.getByLabelText(/落ち着いた候補を優先/))
    expect(screen.queryByRole('region', { name: '絞り込んだ候補' })).not.toBeInTheDocument()

    // free text change
    await user.click(screen.getByRole('button', { name: '入力内容から候補を絞り込む' }))
    expect(await screen.findByRole('region', { name: '絞り込んだ候補' })).toBeVisible()
    await user.type(screen.getByLabelText('どんな動画を作りたいですか'), ' 追記')
    expect(screen.queryByRole('region', { name: '絞り込んだ候補' })).not.toBeInTheDocument()

    // never auto-fetched catalog; no silent re-recommend UI
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not announce stale-clear on initial mount when presets are already present', async () => {
    const fetcher = createFetcher()
    render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
      />,
    )

    const live = document.querySelector('.launcher-expression-status')
    expect(live?.textContent ?? '').toBe('')
    expect(screen.queryByText(/仕上げ候補の一覧が更新されたため/)).not.toBeInTheDocument()
    expect(screen.queryByText(/条件が変わったため/)).not.toBeInTheDocument()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('clears recommendation as soon as catalog load starts (focus stays on action; 1 fetch; no restore on fail)', async () => {
    const user = userEvent.setup()
    let resolveFetch: ((value: Response) => void) | null = null
    const fetcher = vi.fn((_input: RequestInfo | URL) => new Promise<Response>((resolve) => {
      resolveFetch = resolve
    }))

    render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
      />,
    )

    await user.type(screen.getByLabelText('どんな動画を作りたいですか'), '記事を会話で解説する横型')
    await user.click(screen.getByRole('button', { name: '入力内容から候補を絞り込む' }))
    expect(await screen.findByRole('region', { name: '絞り込んだ候補' })).toBeVisible()

    const loadButton = screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    })
    loadButton.focus()
    await user.click(loadButton)

    // Same turn as load start: recommendation gone while action still focused
    expect(screen.queryByRole('region', { name: '絞り込んだ候補' })).not.toBeInTheDocument()
    const busy = screen.getByRole('button', { name: /参考表現を読み込んでいます/ })
    expect(busy).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFetch?.({
        ok: false,
        json: async () => ({ ok: false, issue: { code: 'busy', message: 'busy' } }),
      } as Response)
      await Promise.resolve()
      await Promise.resolve()
    })

    // Failure never restores the pre-load recommendation
    expect(screen.queryByRole('region', { name: '絞り込んだ候補' })).not.toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent(/参考一覧を読み込めませんでした/)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('clears recommendation as soon as presentation preset retry starts (callback once; no auto re-recommend)', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    const fetcher = createFetcher()
    const { rerender } = render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onRetryPresentationPresets={onRetry}
        onSelectionsChange={vi.fn()}
        presentationPresetLoadState="error"
        presentationPresets={[]}
      />,
    )

    await user.type(screen.getByLabelText('どんな動画を作りたいですか'), '記事を会話で解説する横型')
    // Presets empty / error: recommend still runs over empty finish pool after error state
    // Re-enable recommend by moving to ready with presets, recommend, then re-error for retry path.
    rerender(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onRetryPresentationPresets={onRetry}
        onSelectionsChange={vi.fn()}
        presentationPresetLoadState="ready"
        presentationPresets={presentationPresets}
      />,
    )
    await user.click(screen.getByRole('button', { name: '入力内容から候補を絞り込む' }))
    expect(await screen.findByRole('region', { name: '絞り込んだ候補' })).toBeVisible()

    rerender(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onRetryPresentationPresets={onRetry}
        onSelectionsChange={vi.fn()}
        presentationPresetLoadState="error"
        presentationPresets={presentationPresets}
      />,
    )
    // Recommendation may still be visible until retry click (pool key unchanged)
    expect(screen.getByRole('region', { name: '絞り込んだ候補' })).toBeVisible()

    const retry = screen.getByRole('button', { name: 'もう一度読み込む' })
    retry.focus()
    await user.click(retry)

    expect(screen.queryByRole('region', { name: '絞り込んだ候補' })).not.toBeInTheDocument()
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(fetcher).not.toHaveBeenCalled()
    // Parent owns loading transition; click still invoked once only
  })
})
