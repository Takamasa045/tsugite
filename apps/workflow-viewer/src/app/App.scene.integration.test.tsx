import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

import { videoWorkflow } from '../data'
import { useWorkflowStore } from '../store/workflow-store'
import type { WorkflowData } from '../types/workflow'
import { App } from './App'

const activeMissionTreeWorkflow: WorkflowData = {
  id: 'mission-active',
  name: 'Active Mission Tree',
  description: 'current decision: 人間の判断待ちです',
  status: 'waiting_approval',
  duration: 40,
  nodes: [
    {
      id: 'mission-root',
      name: 'mission-root',
      technicalName: 'mission-root',
      type: 'group',
      description: 'ready',
      status: 'queued',
      progress: 0,
      startedAt: 0,
      position: { layer: 0, order: 0 },
      inputs: [],
      outputs: ['task-a', 'task-b'],
      logs: [],
      details: {
        purpose: 'Mission Tree（読み取り専用）',
        activity: 'ready',
        outcome: 'ready',
        inputs: [],
        outputs: [],
      },
    },
    {
      id: 'task-a',
      name: 'edit-and-compose',
      technicalName: 'task-a',
      type: 'task',
      agent: 'editor',
      description: 'completed',
      status: 'completed',
      progress: 100,
      startedAt: 10,
      position: { layer: 1, order: 1 },
      inputs: ['mission-root'],
      outputs: ['task-b'],
      logs: [],
      details: {
        purpose: 'Mission Tree（読み取り専用）',
        activity: 'completed',
        outcome: 'completed',
        inputs: [],
        outputs: [],
      },
    },
    {
      id: 'task-b',
      name: 'output-qa',
      technicalName: 'task-b',
      type: 'approval',
      agent: 'critic',
      description: 'task.awaiting_human',
      status: 'waiting_approval',
      progress: 0,
      startedAt: 20,
      position: { layer: 1, order: 2 },
      inputs: ['task-a'],
      outputs: [],
      logs: [],
      details: {
        purpose: 'Mission Tree（読み取り専用）',
        activity: 'awaiting_human',
        outcome: 'task.awaiting_human',
        inputs: [],
        outputs: [],
      },
    },
  ],
  edges: [
    { id: 'edge-mission-root-task-a', source: 'mission-root', target: 'task-a' },
    { id: 'edge-mission-root-task-b', source: 'mission-root', target: 'task-b' },
    { id: 'dep-task-a-task-b', source: 'task-a', target: 'task-b' },
  ],
  events: [
    { time: 0, nodeId: 'mission-root', status: 'queued', progress: 0 },
    { time: 10, nodeId: 'task-a', status: 'completed', progress: 100 },
    { time: 20, nodeId: 'task-b', status: 'waiting_approval', progress: 0 },
  ],
  missionTree: {
    productionId: 'prod-active-browser',
    mode: 'active',
    missionStatus: 'ready',
    treeRevision: 1,
    sourceEventSequence: 1,
    currentDecision: {
      kind: 'awaiting_human',
      summary: '人間の判断待ちです',
      reasonCode: 'task.awaiting_human',
      nodeId: 'task-b',
    },
    recovery: { active: false, attempts: 0, limit: 2 },
    taskTreeReadOnly: true,
    legacyWorkflowPreserved: true,
    digest: 'e'.repeat(64),
  },
}

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
    // Lazy WorkflowScene + WebGL mock can exceed the default 5s under full suite load.
    const user = userEvent.setup()
    render(<App samples={[{ id: 'eight-stage', label: '8工程', data: videoWorkflow }]} />)

    const fallback = await screen.findByTestId('workflow-scene-fallback', undefined, { timeout: 15_000 })
    const fallbackNodes = within(fallback).getAllByRole('treeitem', { name: /詳細を表示$/ })
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
    expect(within(fallback).getByRole('treeitem', {
      name: `${secondNode.name}の詳細を表示`,
    })).toHaveAttribute('aria-selected', 'true')
    expect(within(fallback).getByRole('treeitem', {
      name: `${secondNode.name}の詳細を表示`,
    })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('heading', { name: secondNode.name })).toBeVisible()
    expect(useWorkflowStore.getState().workflow?.nodes).toHaveLength(8)
  }, 20_000)

  it('passes active Mission Tree DTO through App→WorkflowScene→DOM-SVG fallback without blank center', async () => {
    const user = userEvent.setup()
    render(
      <App
        samples={[{ id: 'mission-tree', label: 'Mission Tree', data: activeMissionTreeWorkflow }]}
      />,
    )

    const fallback = await screen.findByTestId('workflow-scene-fallback', undefined, { timeout: 15_000 })
    expect(fallback).toBeVisible()
    expect(fallback.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    expect(screen.getByTestId('scene-fallback-reason')).toHaveTextContent(
      'viewer.scene.webgl_unavailable',
    )

    const fallbackNodes = within(fallback).getAllByRole('treeitem', { name: /詳細を表示$/ })
    expect(fallbackNodes).toHaveLength(3)
    expect(fallback.querySelectorAll('[data-edge-id]').length).toBe(3)

    // decision strip + mission status
    expect(screen.getByTestId('mission-tree-status')).toBeVisible()
    expect(screen.getByTestId('mission-tree-decision-kind')).toHaveTextContent('awaiting_human')
    expect(screen.getByTestId('mission-tree-decision')).toHaveTextContent('人間の判断待ちです')
    expect(screen.getByTestId('scene-fallback-mission-decision')).toHaveTextContent(
      '人間の判断待ちです',
    )

    // keyboard-equivalent selection + SidePanel sync
    await user.click(fallbackNodes[2]!)
    expect(screen.getByRole('heading', { name: 'output-qa' })).toBeVisible()
    expect(
      within(fallback).getByRole('treeitem', { name: 'output-qaの詳細を表示' }),
    ).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'output-qaの工程詳細を表示' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    // Arrow keys move selection inside fallback
    await user.keyboard('{ArrowDown}')
    const selectedId = useWorkflowStore.getState().selectedNodeId
    expect(selectedId).toBeTruthy()
    expect(within(fallback).getByRole('treeitem', { selected: true })).toBeVisible()

    expect(document.body.textContent).not.toMatch(/subject_digest|decision_digest/)
    expect(document.body.textContent).not.toContain('/Users/')
    expect(useWorkflowStore.getState().workflow?.missionTree?.taskTreeReadOnly).toBe(true)
    expect(useWorkflowStore.getState().workflow?.nodes).toHaveLength(3)
  }, 20_000)
})
