import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workflowSamples } from '../data'
import { useWorkflowStore } from '../store/workflow-store'
import { App, nodeIdFromSearch } from './App'

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
    window.history.replaceState(null, '', '/')
    useWorkflowStore.getState().clearWorkflow()
  })

  it('launcher queryとnode queryを併用し、該当工程の詳細を初期表示する', async () => {
    const gateWorkflow = {
      id: 'gate-review',
      name: 'Gate review',
      status: 'waiting_approval' as const,
      duration: 10,
      nodes: [{
        id: 'gate-2',
        name: 'Gate 2 素材・構成承認',
        type: 'approval' as const,
        status: 'waiting_approval' as const,
        progress: 100,
        inputs: [],
        outputs: [],
        logs: [],
      }],
      edges: [],
      events: [],
    }
    const launcher = 'http://127.0.0.1:4173'
    window.history.replaceState(
      null,
      '',
      `/viewer/sample-project/?launcher=${encodeURIComponent(launcher)}&node=gate-2`,
    )

    render(<App samples={[{ id: 'gate-review', label: 'Gate review', data: gateWorkflow }]} />)

    expect(await screen.findByRole('heading', { name: 'Gate 2 素材・構成承認' })).toBeVisible()
    expect(await screen.findByRole('status', { name: 'カメラの焦点' })).toHaveTextContent('gate-2')
    expect(screen.getByRole('link', { name: '制作案件へ戻る' })).toHaveAttribute(
      'href',
      `${launcher}/`,
    )
    expect(useWorkflowStore.getState().selectedNodeId).toBe('gate-2')
  })

  it.each([
    ['未知のnode', '?node=unknown'],
    ['空のnode', '?node='],
    ['重複したnode', '?node=gate-2&node=other'],
  ])('%s queryは安全に無視する', async (_label, search) => {
    window.history.replaceState(null, '', `/viewer/sample-project/${search}`)

    render(<App />)

    expect(await screen.findByRole('heading', { name: '制作全体の状況' })).toBeVisible()
    expect(screen.getByRole('status', { name: 'カメラの焦点' })).toHaveTextContent('全体')
    expect(useWorkflowStore.getState().selectedNodeId).toBeNull()
  })

  it('node query parserは単一の非空値だけを返す', () => {
    expect(nodeIdFromSearch('?launcher=http%3A%2F%2F127.0.0.1%3A4173&node=gate-2')).toBe('gate-2')
    expect(nodeIdFromSearch('?node=')).toBeUndefined()
    expect(nodeIdFromSearch('?node=gate-1&node=gate-2')).toBeUndefined()
  })

  it.each([
    ['http://127.0.0.1:1', 'http://127.0.0.1:1/'],
    ['http://127.0.0.1:4173/', 'http://127.0.0.1:4173/'],
    ['http://127.0.0.1:65535', 'http://127.0.0.1:65535/'],
  ])('Viewer URLの有効なlauncher origin %s を戻り導線にする', async (launcher, expectedHref) => {
    window.history.replaceState(
      null,
      '',
      `/viewer/sample-project/?launcher=${encodeURIComponent(launcher)}`,
    )

    render(<App />)

    expect(await screen.findByRole('link', { name: '制作案件へ戻る' })).toHaveAttribute(
      'href',
      expectedHref,
    )
  })

  it.each([
    ['外部host', 'http://example.com:4173/'],
    ['localhost別名', 'http://localhost:4173/'],
    ['credentials', 'http://user:pass@127.0.0.1:4173/'],
    ['path', 'http://127.0.0.1:4173/projects'],
    ['fragment', 'http://127.0.0.1:4173/#projects'],
    ['query', 'http://127.0.0.1:4173/?project=sample'],
    ['異なるscheme', 'https://127.0.0.1:4173/'],
    ['portなし', 'http://127.0.0.1/'],
    ['port 0', 'http://127.0.0.1:0/'],
    ['数字以外のport', 'http://127.0.0.1:port/'],
    ['範囲外のport', 'http://127.0.0.1:65536/'],
  ])('Viewer URLの不正なlauncher hintは戻り導線にしない: %s', async (_label, launcher) => {
    window.history.replaceState(
      null,
      '',
      `/viewer/sample-project/?launcher=${encodeURIComponent(launcher)}`,
    )

    render(<App />)

    expect(await screen.findByRole('heading', { name: workflowSamples[0].data.name })).toBeVisible()
    expect(screen.queryByRole('link', { name: '制作案件へ戻る' })).not.toBeInTheDocument()
  })

  it('standalone Viewerは有効なlauncher hintがあっても戻り導線を表示しない', async () => {
    window.history.replaceState(
      null,
      '',
      `/?launcher=${encodeURIComponent('http://127.0.0.1:4173')}`,
    )

    render(<App />)

    expect(await screen.findByRole('heading', { name: workflowSamples[0].data.name })).toBeVisible()
    expect(screen.queryByRole('link', { name: '制作案件へ戻る' })).not.toBeInTheDocument()
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
