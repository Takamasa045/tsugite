import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ExpressionShelf, resetExpressionCatalogSessionCacheForTests } from './ExpressionShelf'
import {
  EXPRESSION_PAGE_SIZE,
  type ExpressionSelection,
} from './expressionLibraryModel'
import {
  buildLargeCatalog,
  catalogResponse,
  createFetcher,
  defaultShelfProps,
  sampleSelection,
} from './expressionShelfTestFixtures'

/** HyperFrames loader max lengths (id128 / title200 / description2000 / tag64). */
const MAX_ID = 'a'.repeat(128)
const MAX_TITLE = 'T'.repeat(200)
const MAX_DESCRIPTION = 'D'.repeat(2000)
const MAX_TAG = 'tag'.padEnd(64, 'x')

function buildMaxLengthCatalog() {
  return {
    ...catalogResponse,
    summary: {
      total: 1,
      returned: 1,
      omitted: 0,
      byType: { block: 0, component: 1 },
    },
    items: [
      {
        id: MAX_ID,
        type: 'component' as const,
        title: MAX_TITLE,
        description: MAX_DESCRIPTION,
        tags: [MAX_TAG, 'caption'],
      },
    ],
  }
}

function manyExecutablePresets(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    backend: 'remotion',
    backendLabel: 'Remotion',
    id: `finish-${String(index + 1).padStart(3, '0')}`,
    label: `仕上げ候補 ${index + 1}`,
    description: `desc ${index + 1}`,
    aspectRatio: '16:9' as const,
  }))
}

describe('ExpressionShelf a11y / keyboard focus regressions', () => {
  beforeEach(() => {
    resetExpressionCatalogSessionCacheForTests()
  })

  it('keeps focus on the same catalog action control through deferred load success', async () => {
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

    const loadButton = screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    })
    loadButton.focus()
    expect(loadButton).toHaveFocus()
    await user.click(loadButton)

    const busyButton = screen.getByRole('button', { name: /参考表現を読み込んでいます/ })
    // DOM contract: aria-disabled (not native disabled) keeps Chromium focus on this control.
    expect(busyButton).toHaveAttribute('aria-disabled', 'true')
    expect(busyButton).not.toHaveAttribute('disabled')
    expect(busyButton).toHaveAttribute('aria-busy', 'true')
    expect(busyButton).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
    expect(fetcher).toHaveBeenCalledTimes(1)

    // aria-disabled re-entry must not start another fetch
    await user.click(busyButton)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFetch?.({
        ok: true,
        json: async () => catalogResponse,
      } as Response)
      await Promise.resolve()
      await Promise.resolve()
    })

    const reloadButton = await screen.findByRole('button', { name: /参考一覧を再読み込み/ })
    expect(reloadButton).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('keeps focus on the same catalog action control through deferred load error', async () => {
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

    const loadButton = screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    })
    loadButton.focus()
    await user.click(loadButton)
    expect(screen.getByRole('button', { name: /参考表現を読み込んでいます/ })).toHaveFocus()

    await act(async () => {
      resolveFetch?.({
        ok: false,
        json: async () => ({ ok: false, issue: { code: 'busy', message: 'busy' } }),
      } as Response)
      await Promise.resolve()
      await Promise.resolve()
    })

    const retryButton = await screen.findByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    })
    expect(retryButton).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
    expect(await screen.findByRole('alert')).toHaveTextContent(/参考一覧を読み込めませんでした/)
  })

  it('final reference page keeps focus on aria-disabled「すべて表示しました」control', async () => {
    const user = userEvent.setup()
    // 13 items → page 1 (12) then page 2 (13) is final
    const large = buildLargeCatalog(13)
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

    const more = screen.getByRole('button', { name: '参考表現をさらに表示' })
    more.focus()
    await user.click(more)

    const done = screen.getByRole('button', { name: 'すべて表示しました' })
    expect(done).toHaveAttribute('aria-disabled', 'true')
    expect(done).not.toHaveAttribute('disabled')
    expect(done).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
    // Re-click must not throw / must not change page further
    await user.click(done)
    expect(done).toHaveFocus()
  })

  it('final executable page keeps focus on aria-disabled「すべて表示しました」control', async () => {
    const user = userEvent.setup()
    const presets = manyExecutablePresets(EXPRESSION_PAGE_SIZE + 1)
    render(
      <ExpressionShelf
        {...defaultShelfProps}
        presentationPresets={presets}
        fetcher={createFetcher()}
        onSelectionsChange={vi.fn()}
      />,
    )

    // total > 12 → control present; total <= 12 would omit
    expect(screen.getByRole('button', { name: '仕上げをさらに表示' })).toBeVisible()
    const more = screen.getByRole('button', { name: '仕上げをさらに表示' })
    more.focus()
    await user.click(more)

    const done = screen.getByRole('button', { name: 'すべて表示しました' })
    expect(done).toHaveAttribute('aria-disabled', 'true')
    expect(done).not.toHaveAttribute('disabled')
    expect(done).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
    await user.click(done)
    expect(done).toHaveFocus()
  })

  /**
   * Chromium moves focus off native disabled controls (often to body).
   * jsdom keeps focus on disabled nodes — so we apply the Chromium rule explicitly:
   * if activeElement is a native-disabled button, hand focus to body.
   * aria-disabled buttons are not subject to that rule and keep focus.
   */
  it('Chromium-equivalent: native disabled drops focus; aria-disabled catalog/pagination keep it', () => {
    function applyChromiumDisabledFocusRule() {
      const active = document.activeElement
      if (active instanceof HTMLButtonElement && active.disabled) {
        // Match Chromium: disabled control is not a valid focus target.
        document.body.setAttribute('tabindex', '-1')
        document.body.focus()
      }
    }

    const native = document.createElement('button')
    native.type = 'button'
    native.textContent = 'native-disabled'
    document.body.append(native)
    native.focus()
    expect(native).toHaveFocus()
    native.disabled = true
    // Contract: after native disable, Chromium rule must leave the control
    expect(native.disabled).toBe(true)
    applyChromiumDisabledFocusRule()
    expect(document.activeElement).toBe(document.body)
    expect(document.activeElement).not.toBe(native)
    native.remove()

    const soft = document.createElement('button')
    soft.type = 'button'
    soft.textContent = 'aria-disabled'
    soft.setAttribute('aria-disabled', 'true')
    document.body.append(soft)
    soft.focus()
    expect(soft.disabled).toBe(false)
    applyChromiumDisabledFocusRule()
    expect(soft).toHaveFocus()
    soft.remove()
    document.body.removeAttribute('tabindex')
  })

  it('omits show-more control when total <= page size (reference and executable)', async () => {
    const user = userEvent.setup()
    // default fixtures: 3 catalog + 3 presets — both <= 12
    render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={createFetcher()}
        onSelectionsChange={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /さらに表示/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /すべて表示しました/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    }))
    expect(await screen.findByText('Data Chart')).toBeVisible()
    expect(screen.queryByRole('button', { name: /さらに表示/ })).not.toBeInTheDocument()
  })

  it('keyboard remove hands focus to next / previous 外す, then tray heading at 0', async () => {
    const user = userEvent.setup()
    const first: ExpressionSelection = {
      ...sampleSelection,
      key: 'presentation-preset::remotion::a',
      nativeId: 'a',
      title: '候補A',
      role: 'full-composition',
    }
    const second: ExpressionSelection = {
      ...sampleSelection,
      key: 'reference-catalog::hyperframes::component::b',
      nativeId: 'b',
      title: '候補B',
      role: 'data-viz',
      source: 'reference-catalog',
      capability: 'reference-only',
      previewFidelity: 'motion-hint',
    }
    const third: ExpressionSelection = {
      ...sampleSelection,
      key: 'reference-catalog::hyperframes::component::c',
      nativeId: 'c',
      title: '候補C',
      role: 'text-overlay',
      source: 'reference-catalog',
      capability: 'reference-only',
      previewFidelity: 'motion-hint',
    }

    let selections: ExpressionSelection[] = [first, second, third]
    let selectionMode: 'unset' | 'explicit' = 'explicit'
    const onSelectionsChange = vi.fn((next: {
      selections: ExpressionSelection[]
      mode: 'unset' | 'explicit'
    }) => {
      selections = next.selections
      selectionMode = next.mode
      rerender(
        <ExpressionShelf
          {...defaultShelfProps}
          fetcher={createFetcher()}
          onSelectionsChange={onSelectionsChange}
          selectionMode={selectionMode}
          selections={selections}
        />,
      )
    })

    const { rerender } = render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={createFetcher()}
        onSelectionsChange={onSelectionsChange}
        selectionMode="explicit"
        selections={selections}
      />,
    )

    // Remove middle (候補B) → same index lands on former next (候補C)
    const removeB = screen.getByRole('button', { name: '候補Bを外す' })
    removeB.focus()
    await user.keyboard('{Enter}')
    expect(selections.map((entry) => entry.title)).toEqual(['候補A', '候補C'])
    expect(screen.getByRole('button', { name: '候補Cを外す' })).toHaveFocus()
    expect(screen.getByText(/候補B をコピー候補から外しました/)).toBeVisible()

    // Remove last remaining at end (候補C) → previous (候補A)
    await user.keyboard('{Enter}')
    expect(selections.map((entry) => entry.title)).toEqual(['候補A'])
    expect(screen.getByRole('button', { name: '候補Aを外す' })).toHaveFocus()

    // Remove last → empty state at list position (tabIndex=-1, scroll allowed)
    await user.keyboard('{Enter}')
    expect(selections).toHaveLength(0)
    const emptyState = screen.getByText('まだ選んでいません。追加したものだけがコピー候補に入り、まとめてプロンプトをコピーできます。')
    expect(emptyState).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
    // 全体構成1・補助2契約の見出し説明と status 文言を維持
    expect(screen.getByText(/最大3件/)).toBeVisible()
    expect(screen.getByText(/全体構成1/)).toBeVisible()
    expect(screen.getByText(/補助2/)).toBeVisible()
    expect(screen.getByText(/状態:/)).toBeVisible()
  })

  it('last remove focuses empty state without preventScroll; next/prev 外す keeps preventScroll', async () => {
    const user = userEvent.setup()
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus')
    const longTitle = 'L'.repeat(200)
    const tall: ExpressionSelection = {
      ...sampleSelection,
      key: 'presentation-preset::remotion::tall',
      nativeId: 'tall',
      title: longTitle,
      role: 'full-composition',
    }
    const next: ExpressionSelection = {
      ...sampleSelection,
      key: 'reference-catalog::hyperframes::component::n',
      nativeId: 'n',
      title: '候補Next',
      role: 'data-viz',
      source: 'reference-catalog',
      capability: 'reference-only',
      previewFidelity: 'motion-hint',
    }

    let selections: ExpressionSelection[] = [tall, next]
    let selectionMode: 'unset' | 'explicit' = 'explicit'
    const onSelectionsChange = vi.fn((payload: {
      selections: ExpressionSelection[]
      mode: 'unset' | 'explicit'
    }) => {
      selections = payload.selections
      selectionMode = payload.mode
      rerender(
        <ExpressionShelf
          {...defaultShelfProps}
          fetcher={createFetcher()}
          onSelectionsChange={onSelectionsChange}
          selectionMode={selectionMode}
          selections={selections}
        />,
      )
    })

    const { rerender } = render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={createFetcher()}
        onSelectionsChange={onSelectionsChange}
        selectionMode="explicit"
        selections={selections}
      />,
    )

    // next/prev path: remove first → focus next 外す with preventScroll
    focusSpy.mockClear()
    screen.getByRole('button', { name: `${longTitle}を外す` }).focus()
    await user.keyboard('{Enter}')
    const nextRemove = screen.getByRole('button', { name: '候補Nextを外す' })
    expect(nextRemove).toHaveFocus()
    const nextRemoveFocusCalls = focusSpy.mock.calls.filter((_, index) => {
      return focusSpy.mock.instances[index] === nextRemove
    })
    expect(nextRemoveFocusCalls.length).toBeGreaterThan(0)
    expect(nextRemoveFocusCalls.some((args) => {
      const opts = args[0] as FocusOptions | undefined
      return opts?.preventScroll === true
    })).toBe(true)

    // last item path: allow scroll (no preventScroll) onto empty state
    focusSpy.mockClear()
    nextRemove.focus()
    await user.keyboard('{Enter}')
    expect(selections).toHaveLength(0)
    const emptyState = screen.getByText('まだ選んでいません。追加したものだけがコピー候補に入り、まとめてプロンプトをコピーできます。')
    expect(emptyState).toHaveFocus()
    const emptyFocusCalls = focusSpy.mock.calls.filter((_, index) => {
      return focusSpy.mock.instances[index] === emptyState
    })
    expect(emptyFocusCalls.length).toBeGreaterThan(0)
    for (const args of emptyFocusCalls) {
      const opts = args[0] as FocusOptions | undefined
      expect(opts?.preventScroll).not.toBe(true)
    }
    focusSpy.mockRestore()
  })

  it('renders max-length catalog fields in the DOM without truncation of stored data', async () => {
    const user = userEvent.setup()
    const fetcher = createFetcher(buildMaxLengthCatalog())
    let selections: ExpressionSelection[] = []
    let selectionMode: 'unset' | 'explicit' = 'unset'
    const onSelectionsChange = vi.fn((next: {
      selections: ExpressionSelection[]
      mode: 'unset' | 'explicit'
    }) => {
      selections = next.selections
      selectionMode = next.mode
      rerender(
        <ExpressionShelf
          {...defaultShelfProps}
          fetcher={fetcher}
          onSelectionsChange={onSelectionsChange}
          selectionMode={selectionMode}
          selections={selections}
        />,
      )
    })
    const { rerender } = render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={onSelectionsChange}
        selectionMode="unset"
        selections={[]}
      />,
    )

    await user.click(screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    }))
    expect(await screen.findByText(MAX_TITLE)).toBeVisible()
    expect(screen.getByText(MAX_DESCRIPTION)).toBeVisible()
    // nativeId appears in card meta path after select; title/description must stay full length
    expect(MAX_TITLE).toHaveLength(200)
    expect(MAX_DESCRIPTION).toHaveLength(2000)
    expect(MAX_ID).toHaveLength(128)
    expect(MAX_TAG).toHaveLength(64)

    await user.click(screen.getByRole('button', {
      name: `一覧の${MAX_TITLE}をコピー候補に追加`,
    }))
    expect(selections).toHaveLength(1)
    expect(selections[0]?.title).toBe(MAX_TITLE)
    expect(selections[0]?.nativeId).toBe(MAX_ID)
    const tray = screen.getByRole('complementary', { name: 'コピー候補' })
    expect(within(tray).getByText(MAX_TITLE)).toBeVisible()
    expect(
      within(tray).getAllByText((_, node) => node?.textContent?.includes(MAX_ID) ?? false).length,
    ).toBeGreaterThan(0)
  })
})

describe('expression responsive CSS contract (max-length overflow)', () => {
  it('declares min-width:0 and overflow-wrap for card / tray / checklist selection', async () => {
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
    const css = fs.readFileSync(path.resolve(cwd, 'src/styles/expression-shelf.css'), 'utf8')

    expect(css).toMatch(/\.launcher-expression-card \{[\s\S]*?min-width:\s*0/)
    expect(css).toMatch(/\.launcher-expression-card-topline strong \{[\s\S]*?overflow-wrap:\s*anywhere/)
    expect(css).toMatch(/\.launcher-expression-card-body p \{[\s\S]*?overflow-wrap:\s*anywhere/)
    expect(css).toMatch(/\.launcher-expression-tray-item-copy \{[\s\S]*?min-width:\s*0/)
    expect(css).toMatch(/\.launcher-expression-tray-list strong,[\s\S]*?overflow-wrap:\s*anywhere/)
    expect(css).toMatch(/\.launcher-expression-tray-list button \{[\s\S]*?flex-shrink:\s*0/)
    expect(css).toMatch(
      /\.launcher-template-expression-selection-list strong,[\s\S]*?overflow-wrap:\s*anywhere/,
    )
    expect(css).toMatch(/\.launcher-template-checklist-expressions \{[\s\S]*?min-width:\s*0/)
  })
})
