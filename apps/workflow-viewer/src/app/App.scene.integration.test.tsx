import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

import { videoWorkflow } from '../data'
import { useWorkflowStore } from '../store/workflow-store'
import { App } from './App'

describe('App scene fallback integration', () => {
  beforeEach(() => {
    useWorkflowStore.getState().clearWorkflow()
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the eight-node DTO visible and synchronizes fallback, timeline, and side panel selection', async () => {
    const user = userEvent.setup()
    render(<App samples={[{ id: 'eight-stage', label: '8工程', data: videoWorkflow }]} />)

    const fallback = await screen.findByTestId('workflow-scene-fallback', undefined, { timeout: 5000 })
    const fallbackNodes = within(fallback).getAllByRole('button', { name: /詳細を表示$/ })
    expect(fallbackNodes).toHaveLength(8)

    const thirdNode = videoWorkflow.nodes[2]!
    await user.click(fallbackNodes[2]!)
    expect(screen.getByRole('heading', { name: thirdNode.name })).toBeVisible()
    expect(screen.getByRole('button', {
      name: `${thirdNode.name}の工程詳細を表示`,
    })).toHaveAttribute('aria-pressed', 'true')

    const secondNode = videoWorkflow.nodes[1]!
    const timelineButtons = screen.getAllByRole('button', {
      name: `${secondNode.name}の工程詳細を表示`,
    })
    await user.click(timelineButtons.at(-1)!)
    expect(within(fallback).getByRole('button', {
      name: `${secondNode.name}の詳細を表示`,
    })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('heading', { name: secondNode.name })).toBeVisible()
    expect(useWorkflowStore.getState().workflow?.nodes).toHaveLength(8)
  })
})
