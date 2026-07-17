import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workflowSamples } from '../data'
import { useWorkflowStore } from '../store/workflow-store'
import { App } from './App'

vi.mock('../components/scene', () => ({
  WorkflowScene: ({ focusRequest, nodesAtTime, onSelect }: {
    focusRequest?: { nodeId: string; nonce: number } | null
    nodesAtTime: Array<{ id: string; name: string }>
    onSelect: (nodeId: string | null) => void
  }) => (
    <div aria-label="3Dワークフロー">
      <output aria-label="カメラの焦点">{focusRequest?.nodeId ?? '全体'}</output>
      {nodesAtTime.map((node) => (
        <button key={node.id} type="button" onClick={() => onSelect(node.id)}>
          {node.name}
        </button>
      ))}
    </div>
  ),
}))

describe('App', () => {
  beforeEach(() => {
    useWorkflowStore.getState().clearWorkflow()
  })

  it('サンプルを読み込み、3D選択と詳細表示を統合する', async () => {
    const user = userEvent.setup()
    render(<App />)

    expect(await screen.findByRole('heading', { name: workflowSamples[0].data.name })).toBeVisible()
    expect(screen.getByRole('region', { name: '木組みの3D制作工程' })).toBeVisible()
    expect(screen.getByRole('region', { name: '制作の現在地' })).toBeVisible()
    expect(screen.getByText('いま進めている工程')).toBeVisible()
    expect(screen.getByText(`工程 1 / ${workflowSamples[0].data.nodes.length}`)).toBeVisible()
    const firstNode = workflowSamples[0].data.nodes[0]
    await user.click(await screen.findByRole('button', { name: firstNode.name }))

    expect(screen.getByRole('heading', { name: firstNode.name })).toBeVisible()
    expect(screen.getByRole('status', { name: 'カメラの焦点' })).toHaveTextContent(firstNode.id)
    expect(screen.getByText('工程を選択してズーム · ホイールでカーソル位置へ寄る')).toBeVisible()

    await user.click(screen.getByRole('button', { name: '表示をリセット' }))
    expect(screen.getByRole('status', { name: 'カメラの焦点' })).toHaveTextContent('全体')
    expect(screen.getByRole('heading', { name: '制作全体の状況' })).toBeVisible()
  })

  it('下部の工程梁から工程を選び、右の工程台帳を開く', async () => {
    const user = userEvent.setup()
    render(<App />)

    const targetNode = workflowSamples[0].data.nodes[2]
    await user.click(await screen.findByRole('button', {
      name: `${targetNode.name}の工程詳細を表示`,
    }))

    expect(screen.getByRole('heading', { name: targetNode.name })).toBeVisible()
    expect(useWorkflowStore.getState().selectedNodeId).toBe(targetNode.id)
    expect(screen.getByRole('status', { name: 'カメラの焦点' })).toHaveTextContent(targetNode.id)
  })

  it('サンプル切替とキーボード再生を反映する', async () => {
    const user = userEvent.setup()
    render(<App />)

    const sampleSelect = screen.getByLabelText('サンプルを切り替える')
    await user.selectOptions(sampleSelect, 'web-app')
    expect(await screen.findByRole('heading', { name: workflowSamples[1].data.name })).toBeVisible()

    sampleSelect.blur()
    await user.keyboard(' ')
    expect(screen.getByRole('button', { name: '一時停止' })).toBeVisible()
  })

  it('不正なJSON相当の入力はクラッシュせずエラーパネルにする', async () => {
    render(
      <App
        samples={[
          {
            id: 'invalid',
            label: '不正データ',
            data: { id: 'broken' },
          },
        ]}
      />,
    )

    await waitFor(() => expect(screen.getByRole('alert')).toBeVisible())
    expect(screen.getByText('ワークフローを読み込めません')).toBeVisible()
    expect(screen.getByText(/nodes must be an array/)).toBeVisible()
  })

  it('生成済みスナップショットは現在時点から表示する', async () => {
    const workflow = {
      id: 'current-run',
      name: 'Current run',
      status: 'completed' as const,
      duration: 10,
      nodes: [{
        id: 'task',
        name: 'Task',
        type: 'task' as const,
        status: 'completed' as const,
        progress: 100,
        inputs: [],
        outputs: [],
        logs: [],
      }],
      edges: [],
      events: [
        { time: 0, nodeId: 'task', status: 'pending' as const, progress: 0 },
        { time: 10, nodeId: 'task', status: 'completed' as const, progress: 100 },
      ],
    }

    render(<App samples={[{ id: 'current', label: 'Current', data: workflow, initialTime: 10 }]} />)

    await waitFor(() => expect(useWorkflowStore.getState().currentTime).toBe(10))
    expect(screen.getByRole('progressbar', { name: '全体進捗' })).toHaveAttribute('aria-valuenow', '100')
  })
})
