import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { memo } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ExpressionCardProps } from './ExpressionCard'
import { ExpressionShelf, resetExpressionCatalogSessionCacheForTests } from './ExpressionShelf'
import type { ExpressionSelection } from './expressionLibraryModel'
import {
  createFetcher,
  defaultShelfProps,
} from './expressionShelfTestFixtures'

const { capturedOnSelect, cardRenderCounts } = vi.hoisted(() => ({
  capturedOnSelect: [] as Array<ExpressionCardProps['onSelect']>,
  cardRenderCounts: new Map<string, number>(),
}))

vi.mock('./ExpressionCard', () => ({
  ExpressionCard: memo(function MockExpressionCard(props: ExpressionCardProps) {
    capturedOnSelect.push(props.onSelect)
    cardRenderCounts.set(
      props.item.key,
      (cardRenderCounts.get(props.item.key) ?? 0) + 1,
    )
    return (
      <li data-testid={`mock-card-${props.item.key}`}>
        <button
          aria-label={props.selected
            ? `${props.listContext}の${props.item.title}は選択中`
            : `${props.listContext}の${props.item.title}をコピー候補に追加`}
          disabled={props.selected}
          onClick={() => props.onSelect(props.item, props.selectReason)}
          type="button"
        >
          {props.selected ? '選択中' : 'コピー候補に追加'}
        </button>
      </li>
    )
  }),
}))

describe('ExpressionShelf handleSelect stability', () => {
  beforeEach(() => {
    resetExpressionCatalogSessionCacheForTests()
    capturedOnSelect.length = 0
    cardRenderCounts.clear()
  })

  it('keeps onSelect referentially stable after selections update', async () => {
    const user = userEvent.setup()
    const fetcher = createFetcher()
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

    expect(capturedOnSelect.length).toBeGreaterThan(0)
    const initialHandler = capturedOnSelect[0]
    expect(capturedOnSelect.every((handler) => handler === initialHandler)).toBe(true)

    const verticalKey = 'presentation-preset::remotion::miraichi-lastcall-9x16'
    const rendersBefore = cardRenderCounts.get(verticalKey) ?? 0

    await user.click(screen.getByRole('button', {
      name: '一覧の横型・会話で解説をコピー候補に追加',
    }))
    expect(selections).toHaveLength(1)

    // Handler identity must not change when selections change
    expect(capturedOnSelect.every((handler) => handler === initialHandler)).toBe(true)

    // Unselected card should not re-render solely because selections changed
    expect(cardRenderCounts.get(verticalKey)).toBe(rendersBefore)
  })
})
