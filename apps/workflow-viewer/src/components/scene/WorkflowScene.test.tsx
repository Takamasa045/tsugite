import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { videoWorkflow } from '../../data'
import { calculateNodePositions } from '../../lib/layout-engine'
import { WorkflowScene } from './WorkflowScene'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function sceneProps() {
  return {
    currentTime: 0,
    nodesAtTime: videoWorkflow.nodes,
    onSelect: vi.fn(),
    positions: calculateNodePositions(videoWorkflow).positions,
    selectedNodeId: null,
    workflow: videoWorkflow,
  }
}

function ControlledScene({ onSelect }: { onSelect: (nodeId: string | null) => void }) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  return (
    <WorkflowScene
      {...sceneProps()}
      onSelect={(nodeId) => {
        setSelectedNodeId(nodeId)
        onSelect(nodeId)
      }}
      selectedNodeId={selectedNodeId}
    />
  )
}

describe('WorkflowScene degraded projection', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  })

  it('WebGL unavailableでも同じ8工程をDOM/SVGで表示し、keyboard相当の操作をselectionへ返す', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null as never)
    const user = userEvent.setup()
    const onSelect = vi.fn()

    render(<ControlledScene onSelect={onSelect} />)

    expect(await screen.findByTestId('workflow-scene-fallback')).toBeVisible()
    expect(screen.getByTestId('scene-fallback-reason')).toHaveTextContent(
      'viewer.scene.webgl_unavailable',
    )
    const nodeButtons = screen.getAllByRole('button', { name: /の詳細を表示$/ })
    expect(nodeButtons).toHaveLength(videoWorkflow.nodes.length)
    expect(screen.getByRole('img', { name: /ノードは8件/ })).toBeInTheDocument()

    await user.click(nodeButtons[2]!)

    expect(onSelect).toHaveBeenCalledWith(videoWorkflow.nodes[2]!.id)
    expect(nodeButtons[2]).toHaveAttribute('aria-pressed', 'true')
    expect(document.body.textContent).not.toContain('/Users/')
    expect(document.body.textContent).not.toContain('Error:')
  })

  it('selected node is reflected in the fallback focus target without changing workflow truth', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null as never)
    const props = { ...sceneProps(), selectedNodeId: videoWorkflow.nodes[4]!.id }

    render(<WorkflowScene {...props} />)

    const selected = await screen.findByRole('button', {
      name: `${videoWorkflow.nodes[4]!.name}の詳細を表示`,
    })
    expect(selected).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('scene-fallback-node-count')).toHaveTextContent('8')
    expect(props.workflow.nodes).toHaveLength(8)
  })
})
