import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLayoutEffect, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ExpressionShelf, resetExpressionCatalogSessionCacheForTests } from './ExpressionShelf'
import { EXPRESSION_PAGE_SIZE } from './expressionLibraryModel'
import {
  expressionCatalogSessionCache,
  startOrJoinExpressionCatalogFetch,
} from './expressionShelfSession'
import {
  buildLargeCatalog,
  catalogResponse,
  createFetcher,
  defaultShelfProps,
} from './expressionShelfTestFixtures'

describe('ExpressionShelf catalog / filter / empty boundaries', () => {
  beforeEach(() => {
    resetExpressionCatalogSessionCacheForTests()
  })

  it('filters by role and reports result counts without extra fetch', async () => {
    const user = userEvent.setup()
    const fetcher = createFetcher()
    render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    }))
    expect(await screen.findByText('Data Chart')).toBeVisible()
    const callsBefore = fetcher.mock.calls.length

    await user.selectOptions(screen.getByLabelText('役割'), 'data-viz')
    expect(screen.getByText('Data Chart')).toBeVisible()
    expect(screen.queryByText('Typewriter')).not.toBeInTheDocument()
    expect(screen.getAllByRole('status').some((node) => /件/.test(node.textContent ?? ''))).toBe(true)
    expect(fetcher.mock.calls.length).toBe(callsBefore)
  })

  it('pages 138 catalog fixtures by 12 and does not re-fetch on search or role filter', async () => {
    const user = userEvent.setup()
    const large = buildLargeCatalog(138)
    const fetcher = createFetcher(large)
    render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    }))
    expect(await screen.findByText('Catalog Item 1')).toBeVisible()

    // initial page: literal 12 reference cards
    expect(EXPRESSION_PAGE_SIZE).toBe(12)
    const referenceRegion = screen.getByRole('region', { name: 'アイデアとして参照する表現' })
    expect(within(referenceRegion).getAllByText(/Catalog Item/).length).toBe(12)
    expect(within(referenceRegion).queryByText('Catalog Item 13')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '参考表現をさらに表示' }))
    expect(within(referenceRegion).getAllByText(/Catalog Item/).length).toBe(EXPRESSION_PAGE_SIZE * 2)
    expect(within(referenceRegion).getByText('Catalog Item 13')).toBeVisible()

    const callsAfterLoad = fetcher.mock.calls.filter(([url]) => String(url).includes('reference-catalogs')).length
    await user.type(screen.getByRole('searchbox'), 'Catalog Item 1')
    await user.selectOptions(screen.getByLabelText('役割'), 'all')
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes('reference-catalogs')),
    ).toHaveLength(callsAfterLoad)
    // pagination resets to 12 after filter change
    expect(within(referenceRegion).getAllByText(/Catalog Item/).length).toBeLessThanOrEqual(EXPRESSION_PAGE_SIZE)
  })

  it('clears stale recommendations after catalog load and asks to re-filter', async () => {
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

    await user.click(screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    }))
    expect(await screen.findByText('Data Chart')).toBeVisible()
    expect(screen.queryByRole('region', { name: '絞り込んだ候補' })).not.toBeInTheDocument()
    expect(screen.getByText(/もう一度「入力内容から候補を絞り込む」/)).toBeVisible()
  })

  it('treats successful empty catalog as loaded (no 未読込) and does not auto-refetch on explore filter', async () => {
    const user = userEvent.setup()
    const emptyCatalog = {
      ...catalogResponse,
      summary: {
        total: 0,
        returned: 0,
        omitted: 0,
        byType: { block: 0, component: 0 },
      },
      items: [] as typeof catalogResponse.items,
      warnings: [] as string[],
    }
    const fetcher = createFetcher(emptyCatalog)
    render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
      />,
    )

    // Explicit load once → 0 items success is still "loaded"
    expect(fetcher).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    }))
    expect(await screen.findByText(/条件に合う参考表現はありません/)).toBeVisible()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/参考一覧はまだ読み込んでいません/)).not.toBeInTheDocument()
    expect(screen.queryByText(/いま参考一覧は未読込/)).not.toBeInTheDocument()

    // アイデアも含めて探す is default; filter must not claim 未読込 / 読み込む必要
    expect(screen.getByLabelText('探す範囲')).toHaveDisplayValue('アイデアも含めて探す')
    await user.type(screen.getByLabelText('どんな動画を作りたいですか'), '記事を会話で解説する横型')
    await user.click(screen.getByRole('button', { name: '入力内容から候補を絞り込む' }))

    const recommendRegion = await screen.findByRole('region', { name: '絞り込んだ候補' })
    expect(within(recommendRegion).queryByText(/未読込/)).not.toBeInTheDocument()
    expect(within(recommendRegion).queryByText(/読み込む必要/)).not.toBeInTheDocument()
    expect(within(recommendRegion).queryByText(/今検索できる範囲は、この環境の仕上げ候補だけ/))
      .not.toBeInTheDocument()
    // intent note also must not show unread copy after successful empty load
    expect(screen.queryByText(/いま参考一覧は未読込/)).not.toBeInTheDocument()
    // no automatic second fetch on recommend / explore filter
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('keeps finish candidates when catalog fails after explicit load', async () => {
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
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
      />,
    )

    expect(screen.getByText('横型・会話で解説')).toBeVisible()
    expect(fetcher).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/参考一覧を読み込めませんでした/)
    expect(screen.getByRole('region', { name: 'この環境の仕上げ候補' })).toBeVisible()

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
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    }))
    expect(await screen.findByText('Data Chart')).toBeVisible()
    expect(screen.getByRole('button', { name: /参考一覧を再読み込み/ })).toBeVisible()

    await user.click(screen.getByRole('button', { name: /参考一覧を再読み込み/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/再読み込みに失敗|参考一覧を読み込めませんでした/)
    expect(screen.queryByRole('button', { name: /参考一覧を再読み込み/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    })).toHaveLength(1)
    expect(screen.getByText('Data Chart')).toBeVisible()
  })

  it('remount during in-flight joins the same Promise (1 GET) and updates UI on resolve', async () => {
    const user = userEvent.setup()
    let resolveFetch: ((value: Response) => void) | null = null
    const fetcher = vi.fn((_input: RequestInfo | URL) => new Promise<Response>((resolve) => {
      resolveFetch = resolve
    }))

    const props = {
      ...defaultShelfProps,
      fetcher,
      onSelectionsChange: vi.fn(),
    }
    const first = render(<ExpressionShelf {...props} />)
    expect(fetcher).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    }))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/参考表現を読み込んでいます/)).toBeVisible()

    // Leave tab (unmount) while still in-flight
    first.unmount()

    // Return to tab (remount) — must follow existing in-flight, not idle, no second GET
    render(<ExpressionShelf {...props} />)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/参考表現を読み込んでいます/)).toBeVisible()
    expect(screen.queryByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    })).not.toBeInTheDocument()

    await act(async () => {
      resolveFetch?.({
        ok: true,
        json: async () => catalogResponse,
      } as Response)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(await screen.findByText('Data Chart')).toBeVisible()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('remount alone does not start catalog fetch when never explicitly loaded', () => {
    const fetcher = createFetcher()
    const props = {
      ...defaultShelfProps,
      fetcher,
      onSelectionsChange: vi.fn(),
    }
    const first = render(<ExpressionShelf {...props} />)
    expect(fetcher).not.toHaveBeenCalled()
    first.unmount()

    render(<ExpressionShelf {...props} />)
    expect(fetcher).not.toHaveBeenCalled()
    expect(screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    })).toBeVisible()
    expect(screen.queryByText(/参考表現を読み込んでいます/)).not.toBeInTheDocument()
  })

  it('hides expanded old cards during reload loading, keeps action focus, resets to 12 on success (1 extra fetch)', async () => {
    const user = userEvent.setup()
    const large = buildLargeCatalog(13)
    let resolveReload: ((value: Response) => void) | null = null
    let calls = 0
    const fetcher = vi.fn((_input: RequestInfo | URL) => {
      calls += 1
      if (calls === 1) {
        return Promise.resolve({
          ok: true,
          json: async () => large,
        } as Response)
      }
      return new Promise<Response>((resolve) => {
        resolveReload = resolve
      })
    })

    render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    }))
    expect(await screen.findByText('Catalog Item 1')).toBeVisible()
    expect(fetcher).toHaveBeenCalledTimes(1)

    const referenceRegion = screen.getByRole('region', { name: 'アイデアとして参照する表現' })
    expect(within(referenceRegion).getAllByText(/Catalog Item/).length).toBe(EXPRESSION_PAGE_SIZE)
    await user.click(screen.getByRole('button', { name: '参考表現をさらに表示' }))
    expect(within(referenceRegion).getByText('Catalog Item 13')).toBeVisible()
    expect(within(referenceRegion).getAllByText(/Catalog Item/).length).toBe(13)

    const reloadButton = screen.getByRole('button', { name: /参考一覧を再読み込み/ })
    reloadButton.focus()
    await user.click(reloadButton)

    const busy = screen.getByRole('button', { name: /参考表現を読み込んでいます/ })
    expect(busy).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
    // Old cards + pagination are not rendered / not focusable during loading
    expect(within(referenceRegion).queryByText('Catalog Item 1')).not.toBeInTheDocument()
    expect(within(referenceRegion).queryByText('Catalog Item 13')).not.toBeInTheDocument()
    expect(within(referenceRegion).queryByRole('button', { name: '参考表現をさらに表示' }))
      .not.toBeInTheDocument()
    expect(within(referenceRegion).queryByRole('button', { name: /コピー候補に追加|選択中/ }))
      .not.toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(2)

    await act(async () => {
      resolveReload?.({
        ok: true,
        json: async () => large,
      } as Response)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(await screen.findByText('Catalog Item 1')).toBeVisible()
    expect(within(referenceRegion).getAllByText(/Catalog Item/).length).toBe(EXPRESSION_PAGE_SIZE)
    expect(within(referenceRegion).queryByText('Catalog Item 13')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /参考一覧を再読み込み/ })).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  /**
   * Race: deferred GET start → old unmount → new mount first paint (loading) →
   * parent layout queueMicrotask settles session ready/inFlight=null before the new
   * hook's passive effect joins. Without snapshot re-sync, UI sticks at loading:0.
   */
  it('remount: session ready settle before passive effect still syncs items (no loading stick)', async () => {
    let resolveFetch: ((value: Response) => void) | null = null
    const fetcher = vi.fn((_input: RequestInfo | URL) => new Promise<Response>((resolve) => {
      resolveFetch = resolve
    }))

    const props = {
      ...defaultShelfProps,
      fetcher,
      onSelectionsChange: vi.fn(),
    }
    const first = render(<ExpressionShelf {...props} />)
    await userEvent.setup().click(screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    }))
    expect(fetcher).toHaveBeenCalledTimes(1)
    first.unmount()

    function SettleBeforePassive({ children }: { children: ReactNode }) {
      useLayoutEffect(() => {
        queueMicrotask(() => {
          resolveFetch?.({
            ok: true,
            json: async () => catalogResponse,
          } as Response)
        })
      }, [])
      return children
    }

    render(
      <SettleBeforePassive>
        <ExpressionShelf {...props} />
      </SettleBeforePassive>,
    )

    // Flush microtasks from layout + async session settle
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(await screen.findByText('Data Chart')).toBeVisible()
    expect(screen.queryByText(/参考表現を読み込んでいます/)).not.toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(expressionCatalogSessionCache.ready).toBe(true)
    expect(expressionCatalogSessionCache.inFlight).toBeNull()
  })

  /**
   * Race (Sol review): ready OLD → keepPrevious reload starts (request gen bumps, items stay OLD)
   * → unmount while inFlight → remount (UI loading:OLD; seen must be readyGeneration not request gen)
   * → reload settles NEW. UI must leave loading and show NEW (not stick on loading:OLD).
   */
  it('ready OLD + reload NEW success + unmount/remount mid-flight applies NEW ready', async () => {
    const user = userEvent.setup()
    const oldCatalog = catalogResponse
    const newCatalog = {
      ...catalogResponse,
      items: [
        {
          id: 'new-chart',
          type: 'component' as const,
          title: 'New Chart After Reload',
          description: 'Reloaded item',
          tags: ['data'],
        },
      ],
      summary: {
        total: 1,
        returned: 1,
        omitted: 0,
        byType: { block: 0, component: 1 },
      },
    }
    let resolveReload: ((value: Response) => void) | null = null
    let calls = 0
    const fetcher = vi.fn((_input: RequestInfo | URL) => {
      calls += 1
      if (calls === 1) {
        return Promise.resolve({
          ok: true,
          json: async () => oldCatalog,
        } as Response)
      }
      return new Promise<Response>((resolve) => {
        resolveReload = resolve
      })
    })

    const props = {
      ...defaultShelfProps,
      fetcher,
      onSelectionsChange: vi.fn(),
    }
    const first = render(<ExpressionShelf {...props} />)
    await user.click(screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    }))
    expect(await screen.findByText('Data Chart')).toBeVisible()
    expect(expressionCatalogSessionCache.ready).toBe(true)
    const readyGenBeforeReload = expressionCatalogSessionCache.readyGeneration
    const requestGenBeforeReload = expressionCatalogSessionCache.generation
    expect(readyGenBeforeReload).toBe(requestGenBeforeReload)

    await user.click(screen.getByRole('button', { name: /参考一覧を再読み込み/ }))
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(expressionCatalogSessionCache.inFlight).not.toBeNull()
    expect(expressionCatalogSessionCache.generation).toBe(requestGenBeforeReload + 1)
    // Request gen advanced; committed ready snapshot is still OLD.
    expect(expressionCatalogSessionCache.readyGeneration).toBe(readyGenBeforeReload)
    expect(expressionCatalogSessionCache.items[0]?.title).toBe('Data Chart')
    expect(screen.getByText(/参考表現を読み込んでいます/)).toBeVisible()

    first.unmount()

    render(<ExpressionShelf {...props} />)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/参考表現を読み込んでいます/)).toBeVisible()
    // Previous ready items may still be in session cache during keepPrevious reload.
    expect(expressionCatalogSessionCache.ready).toBe(true)
    expect(expressionCatalogSessionCache.items[0]?.title).toBe('Data Chart')

    await act(async () => {
      resolveReload?.({
        ok: true,
        json: async () => newCatalog,
      } as Response)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(await screen.findByText('New Chart After Reload')).toBeVisible()
    expect(screen.queryByText(/参考表現を読み込んでいます/)).not.toBeInTheDocument()
    expect(screen.queryByText('Data Chart')).not.toBeInTheDocument()
    expect(expressionCatalogSessionCache.ready).toBe(true)
    expect(expressionCatalogSessionCache.inFlight).toBeNull()
    expect(expressionCatalogSessionCache.readyGeneration).toBe(
      expressionCatalogSessionCache.generation,
    )
    expect(expressionCatalogSessionCache.lastSettled?.ok).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  /**
   * Same remount order as success race, but reload fails: UI must not stick on loading:OLD.
   * Keep previous list + show reload-failure guidance.
   */
  it('ready OLD + reload failure + unmount/remount mid-flight keeps OLD and shows reload error', async () => {
    const user = userEvent.setup()
    let resolveReload: ((value: Response) => void) | null = null
    let calls = 0
    const fetcher = vi.fn((_input: RequestInfo | URL) => {
      calls += 1
      if (calls === 1) {
        return Promise.resolve({
          ok: true,
          json: async () => catalogResponse,
        } as Response)
      }
      return new Promise<Response>((resolve) => {
        resolveReload = resolve
      })
    })

    const props = {
      ...defaultShelfProps,
      fetcher,
      onSelectionsChange: vi.fn(),
    }
    const first = render(<ExpressionShelf {...props} />)
    await user.click(screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    }))
    expect(await screen.findByText('Data Chart')).toBeVisible()
    const readyGenBeforeReload = expressionCatalogSessionCache.readyGeneration

    await user.click(screen.getByRole('button', { name: /参考一覧を再読み込み/ }))
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(expressionCatalogSessionCache.inFlight).not.toBeNull()
    expect(screen.getByText(/参考表現を読み込んでいます/)).toBeVisible()

    first.unmount()

    render(<ExpressionShelf {...props} />)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/参考表現を読み込んでいます/)).toBeVisible()

    await act(async () => {
      resolveReload?.({
        ok: false,
        json: async () => ({ ok: false, issue: { code: 'busy', message: 'busy' } }),
      } as Response)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(await screen.findByText('Data Chart')).toBeVisible()
    expect(screen.queryByText(/参考表現を読み込んでいます/)).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/再読み込みに失敗/)
    expect(expressionCatalogSessionCache.ready).toBe(true)
    expect(expressionCatalogSessionCache.readyGeneration).toBe(readyGenBeforeReload)
    expect(expressionCatalogSessionCache.inFlight).toBeNull()
    expect(expressionCatalogSessionCache.lastSettled?.ok).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('sync throw fetcher clears inFlight; second load succeeds with generation bump (calls=2)', async () => {
    let calls = 0
    const fetcher = vi.fn((_input: RequestInfo | URL) => {
      calls += 1
      if (calls === 1) {
        throw new Error('sync network failure')
      }
      return Promise.resolve({
        ok: true,
        json: async () => catalogResponse,
      } as Response)
    })

    const genBefore = expressionCatalogSessionCache.generation
    const first = await startOrJoinExpressionCatalogFetch({ fetcher: fetcher as typeof fetch, token: 't' })
    expect(first.ok).toBe(false)
    expect(expressionCatalogSessionCache.inFlight).toBeNull()
    expect(expressionCatalogSessionCache.generation).toBe(genBefore + 1)

    // Retry must start a new Promise (not re-return the settled first)
    const second = await startOrJoinExpressionCatalogFetch({ fetcher: fetcher as typeof fetch, token: 't' })
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.items.length).toBeGreaterThan(0)
    }
    expect(calls).toBe(2)
    expect(expressionCatalogSessionCache.generation).toBe(genBefore + 2)
    expect(expressionCatalogSessionCache.ready).toBe(true)
    expect(expressionCatalogSessionCache.inFlight).toBeNull()
  })

  it('concurrent startOrJoin joins the same in-flight Promise (single-flight)', async () => {
    let resolveFetch: ((value: Response) => void) | null = null
    const fetcher = vi.fn((_input: RequestInfo | URL) => new Promise<Response>((resolve) => {
      resolveFetch = resolve
    }))

    const a = startOrJoinExpressionCatalogFetch({ fetcher: fetcher as typeof fetch, token: 't' })
    const b = startOrJoinExpressionCatalogFetch({ fetcher: fetcher as typeof fetch, token: 't' })
    expect(fetcher).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFetch?.({
        ok: true,
        json: async () => catalogResponse,
      } as Response)
    })

    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toBe(rb)
    expect(ra.ok).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
