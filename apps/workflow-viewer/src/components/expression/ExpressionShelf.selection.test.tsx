import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ExpressionShelf, resetExpressionCatalogSessionCacheForTests } from './ExpressionShelf'
import type { ExpressionSelection } from './expressionLibraryModel'
import {
  formatExpressionCandidatesPromptSection,
  formatExpressionItemPrompt,
  normalizePresentationPreset,
} from './expressionLibraryModel'
import {
  catalogResponse,
  createFetcher,
  defaultShelfProps,
  presentationPresets,
  sampleSelection,
} from './expressionShelfTestFixtures'

describe('ExpressionShelf selection / freeform export', () => {
  beforeEach(() => {
    resetExpressionCatalogSessionCacheForTests()
  })

  it('treats same-id preset and catalog cards as distinct selections', async () => {
    const user = userEvent.setup()
    const sharedIdPresets = [
      {
        backend: 'hyperframes',
        backendLabel: 'HyperFrames',
        id: 'shared-id',
        label: 'HyperFrames仕上げ shared-id',
        description: 'preset side',
        aspectRatio: '16:9' as const,
      },
    ]
    const sharedCatalog = {
      ...catalogResponse,
      items: [
        {
          id: 'shared-id',
          type: 'component' as const,
          title: 'Catalog shared-id',
          description: 'catalog side',
          tags: ['data', 'caption'],
        },
      ],
      summary: {
        total: 1,
        returned: 1,
        omitted: 0,
        byType: { block: 0, component: 1 },
      },
    }
    const fetcher = createFetcher(sharedCatalog)
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
          presentationPresets={sharedIdPresets}
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
        presentationPresets={sharedIdPresets}
        selectionMode="unset"
        selections={[]}
      />,
    )

    await user.click(screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    }))
    expect(await screen.findByText('Catalog shared-id')).toBeVisible()
    expect(screen.getByText('HyperFrames仕上げ shared-id')).toBeVisible()

    await user.click(screen.getByRole('button', {
      name: '一覧のHyperFrames仕上げ shared-idをコピー候補に追加',
    }))
    expect(selections).toHaveLength(1)
    expect(selections[0]?.key).toBe('presentation-preset::hyperframes::shared-id')
    expect(selections[0]?.provider).toBe('hyperframes')
    expect(selections[0]?.nativeId).toBe('shared-id')

    await user.click(screen.getByRole('button', {
      name: '一覧のCatalog shared-idをコピー候補に追加',
    }))
    expect(selections).toHaveLength(2)
    expect(selections.map((entry) => entry.key)).toEqual([
      'presentation-preset::hyperframes::shared-id',
      'reference-catalog::hyperframes::component::shared-id',
    ])
    expect(selections.every((entry) => entry.nativeId === 'shared-id')).toBe(true)
  })

  it('copies a single card prompt on explicit click without auto-copy or selecting', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const onSelectionsChange = vi.fn()
    const item = normalizePresentationPreset(presentationPresets[0]!)
    const expected = formatExpressionItemPrompt(item)

    render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={createFetcher()}
        onSelectionsChange={onSelectionsChange}
        selectionMode="unset"
        selections={[]}
      />,
    )

    expect(writeText).toHaveBeenCalledTimes(0)
    await user.click(screen.getByRole('button', {
      name: '一覧の横型・会話で解説のプロンプトをコピー',
    }))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(expected)
    expect(expected).toContain('## 表現プロンプト')
    expect(expected).toContain(JSON.stringify('横型・会話で解説'))
    expect(expected).toContain('Remotion')
    expect(expected).toMatch(/実装・導入済み|利用可能|render可能|保証しません/)
    expect(onSelectionsChange).not.toHaveBeenCalled()
    expect(await screen.findByText(/コピー済みです。まだ送信していません/)).toBeVisible()
  })

  it('allows single-card prompt copy even when already selected as a copy candidate', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const item = normalizePresentationPreset(presentationPresets[0]!)

    render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={createFetcher()}
        onSelectionsChange={vi.fn()}
        selectionMode="explicit"
        selections={[sampleSelection]}
      />,
    )

    expect(writeText).toHaveBeenCalledTimes(0)
    await user.click(screen.getByRole('button', {
      name: '一覧の横型・会話で解説のプロンプトをコピー',
    }))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(formatExpressionItemPrompt(item))
    expect(screen.getByRole('button', { name: '一覧の横型・会話で解説は選択中' })).toBeVisible()
  })

  it('previews freeform expression export and copies only on explicit click', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const fetcher = createFetcher()
    const selections: ExpressionSelection[] = [sampleSelection]
    const expected = formatExpressionCandidatesPromptSection({
      mode: 'explicit',
      selections,
    })

    render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={fetcher}
        onSelectionsChange={vi.fn()}
        selectionMode="explicit"
        selections={selections}
      />,
    )

    expect(screen.getByRole('heading', { name: '選んだ表現のプロンプト' })).toBeVisible()
    const exportArea = screen.getByRole('textbox', { name: '選んだ表現のプロンプト' })
    expect(exportArea).toHaveValue(expected)
    expect(exportArea).toHaveAttribute('readonly')
    // mount / selection 時は clipboard 0
    expect(writeText).toHaveBeenCalledTimes(0)
    expect(fetcher).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'まとめてプロンプトをコピー' }))
    // 明示クリック時だけ 1
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(expected)
    expect(await screen.findByText(/コピー済みです。まだ送信していません/)).toBeVisible()
    expect(fetcher).not.toHaveBeenCalled()
    // raw error / token を出さない
    expect(screen.queryByText(/session-token/)).not.toBeInTheDocument()
  })

  it('freeform clipboard reject は generic 失敗表示のみ（raw error なし）', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => {
      throw new Error('secret-clipboard-denied-token')
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(
      <ExpressionShelf
        {...defaultShelfProps}
        fetcher={createFetcher()}
        onSelectionsChange={vi.fn()}
        selectionMode="explicit"
        selections={[sampleSelection]}
      />,
    )

    expect(writeText).toHaveBeenCalledTimes(0)
    await user.click(screen.getByRole('button', { name: 'まとめてプロンプトをコピー' }))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /コピーに失敗しました。表示中の文言を手動で選んでコピーしてください/,
    )
    expect(screen.queryByText(/secret-clipboard-denied-token/)).not.toBeInTheDocument()
    expect(screen.queryByText(/session-token/)).not.toBeInTheDocument()
  })

  it('freeform clipboard 未解決 promise は約1500msで timeout し generic 失敗表示へ移る', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(() => new Promise<void>(() => {}))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    try {
      const view = render(
        <ExpressionShelf
          {...defaultShelfProps}
          fetcher={createFetcher()}
          onSelectionsChange={vi.fn()}
          selectionMode="explicit"
          selections={[sampleSelection]}
        />,
      )
      expect(writeText).toHaveBeenCalledTimes(0)
      fireEvent.click(screen.getByRole('button', { name: 'まとめてプロンプトをコピー' }))
      // writeText is scheduled via Promise.resolve().then (sync-throw normalization)
      await act(async () => {
        await Promise.resolve()
      })
      expect(writeText).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500)
      })
      expect(screen.getByRole('alert')).toHaveTextContent(
        /コピーに失敗しました。表示中の文言を手動で選んでコピーしてください/,
      )
      // unmount cleans pending timer without throwing
      view.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('copy success then add keeps selection status (exportText must not clear parent live)', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const fetcher = createFetcher()
    let selections: ExpressionSelection[] = [sampleSelection]
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
        selectionMode="explicit"
        selections={selections}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'まとめてプロンプトをコピー' }))
    expect(await screen.findByText(/コピー済みです。まだ送信していません/)).toBeVisible()
    expect(writeText).toHaveBeenCalledTimes(1)

    // Load catalog and add an auxiliary reference (not another full-composition)
    await user.click(screen.getByRole('button', {
      name: 'HyperFrames参考一覧を読み込む（公式カタログへの外部通信あり）',
    }))
    expect(await screen.findByText('Data Chart')).toBeVisible()
    await user.click(screen.getByRole('button', {
      name: '一覧のData Chartをコピー候補に追加',
    }))
    expect(onSelectionsChange).toHaveBeenCalled()
    expect(selections).toHaveLength(2)
    // Parent selection status must remain (not wiped by exportText effect)
    expect(screen.getByText(/Data Chart をコピー候補に追加しました/)).toBeVisible()
    expect(screen.queryByText(/コピー済み/)).not.toBeInTheDocument()
  })

  it('copy failure then remove keeps remove status (exportText must not clear parent live)', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => {
      throw new Error('clipboard-denied-for-test')
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    let selections: ExpressionSelection[] = [sampleSelection]
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

    await user.click(screen.getByRole('button', { name: 'まとめてプロンプトをコピー' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/コピーに失敗しました/)
    expect(screen.queryByText(/clipboard-denied-for-test/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '横型・会話で解説を外す' }))
    expect(selections).toHaveLength(0)
    expect(screen.getByText(/をコピー候補から外しました/)).toBeVisible()
  })

  it('never uses stale selections when adding a second full-composition (全体構成1件契約)', async () => {
    const user = userEvent.setup()
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
        selectionMode="unset"
        selections={[]}
      />,
    )

    await user.click(screen.getByRole('button', {
      name: '一覧の横型・会話で解説をコピー候補に追加',
    }))
    expect(selections).toHaveLength(1)
    expect(selections[0]?.role).toBe('full-composition')

    // If handleSelect closed over stale [], this would incorrectly become 2 full-compositions.
    await user.click(screen.getByRole('button', {
      name: '一覧の縦型・締切／申込案内をコピー候補に追加',
    }))
    expect(selections).toHaveLength(1)
    const live = document.querySelector('.launcher-expression-status')
    expect(live?.textContent ?? '').toMatch(/同じ役割の候補がすでに選ばれています/)
  })
})
