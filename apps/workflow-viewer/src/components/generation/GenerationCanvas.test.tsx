import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GenerationCanvas } from './GenerationCanvas'

const projects = [
  {
    id: 'project-alpha',
    name: '北アルプス映像',
    slug: 'northern-alps',
    runId: 'northern-alps-r2',
    status: 'awaiting_gate_1',
    valid: true,
    refreshable: true,
  },
  {
    id: 'project-beta',
    name: '里山映像',
    slug: 'satoyama',
    runId: 'satoyama-r1',
    status: 'planned',
    valid: true,
    refreshable: true,
  },
]

const canvasResponse = {
  ok: true,
  canvas: {
    project: projects[0],
    generation: {
      connection: 'pixverse',
      adapter: 'pixverse',
      requests: [{
        id: 'arrival-shot',
        prompt: '雪山の稜線へゆっくり近づく',
        model: 'seedance-1.5-pro',
        duration: 5,
        aspect: '16:9',
        inputMode: 'image-to-video',
        firstFrame: 'assets/alps.png',
        referenceImageCount: 0,
      }],
    },
    connections: [{
      id: 'pixverse',
      displayName: 'PixVerseサブスク',
      transport: 'cli',
      authKind: 'subscription',
      capabilities: ['image.generate', 'video.text-to-video', 'video.image-to-video', 'audio.text-to-speech', 'audio.music'],
      automatedCapabilities: ['video.text-to-video', 'video.image-to-video'],
      routeNote: 'PixVerse契約でGemini、Kling、Grok等を使います。',
      modelPolicy: 'runtime',
      setupStatus: 'ready',
      executionMode: 'pipeline-adapter',
    }, {
      id: 'topview',
      displayName: 'TopView MCP',
      transport: 'mcp',
      authKind: 'subscription',
      capabilities: ['image.generate', 'image.image-to-image', 'video.text-to-video', 'video.image-to-video', 'video.reference-to-video', 'audio.text-to-speech', 'audio.music'],
      automatedCapabilities: ['image.generate', 'image.image-to-image', 'video.text-to-video', 'video.image-to-video', 'video.reference-to-video', 'audio.text-to-speech', 'audio.music'],
      routeNote: 'TopView公式MCPとTopViewサブスクを使います。',
      modelPolicy: 'runtime',
      setupStatus: 'needs-verification',
      executionMode: 'pipeline-adapter',
    }, {
      id: 'kling-direct',
      displayName: 'Kling直契約',
      transport: 'cli',
      authKind: 'subscription',
      capabilities: ['image.generate', 'image.image-to-image', 'video.text-to-video', 'video.image-to-video'],
      automatedCapabilities: ['image.generate', 'image.image-to-image', 'video.text-to-video', 'video.image-to-video'],
      routeNote: 'Kling直契約とKling CLIを使います。',
      modelPolicy: 'runtime',
      setupStatus: 'ready',
      executionMode: 'pipeline-adapter',
    }],
    issues: [],
  },
}

function createFetcher() {
  return vi.fn().mockImplementation((url: string) => Promise.resolve({
    ok: true,
    json: async () => url.includes('project-beta')
      ? {
          ok: true,
          canvas: {
            project: projects[1],
            generation: { requests: [] },
            issues: [],
          },
        }
      : canvasResponse,
  } as Response))
}

describe('GenerationCanvas', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('選択案件のproject.yamlにある生成要求と接続状態を表示する', async () => {
    render(<GenerationCanvas fetcher={createFetcher()} projects={projects} selectedProjectId="project-alpha" />)

    expect(await screen.findByRole('button', { name: 'arrival-shot' })).toBeVisible()
    expect(screen.getAllByText('雪山の稜線へゆっくり近づく')[0]).toBeVisible()
    expect(screen.getAllByText('PixVerseサブスク')[0]).toBeVisible()
    expect(screen.getByText('画像・動画・音声')).toBeVisible()
    expect(screen.getByText('動画')).toBeVisible()
    expect(screen.getByText('Gate 1 確認待ち')).toBeVisible()
    expect(screen.queryByText('assets/alps.png')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '生成に使う接続を選択' })).toHaveValue('pixverse')
    expect(screen.getByText('モデル一覧はCLIから取得')).toBeVisible()
  })

  it('同じKlingでもPixVerse経由とKling直契約を区別して案内する', async () => {
    const user = userEvent.setup()
    render(<GenerationCanvas fetcher={createFetcher()} projects={projects} selectedProjectId="project-alpha" />)
    await screen.findByRole('button', { name: 'arrival-shot' })
    await user.selectOptions(screen.getByRole('combobox', { name: '生成に使う接続を選択' }), 'kling-direct')
    expect(screen.getByText('Kling直契約とKling CLIを使います。')).toBeVisible()
    expect(screen.getByText(/project.yaml の connection は kling-direct/)).toBeVisible()
  })

  it('TopView MCPを選び、案件の生成接続として設定できる', async () => {
    const user = userEvent.setup()
    const fetcher = createFetcher()
    render(<GenerationCanvas fetcher={fetcher} projects={projects} selectedProjectId="project-alpha" />)

    await screen.findByRole('button', { name: 'arrival-shot' })
    await user.selectOptions(screen.getByRole('combobox', { name: '生成に使う接続を選択' }), 'topview')

    expect(screen.getByText('TopView公式MCPとTopViewサブスクを使います。')).toBeVisible()
    expect(screen.getByText('モデル一覧はMCPから取得')).toBeVisible()
    expect(screen.getByText(/Tsugiteから実行可能/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'この接続を案件に設定' }))

    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledWith('/api/projects/project-alpha/generation-connection', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ connection: 'topview' }),
      }))
    })
  })

  it('案件を切り替えると、その案件の生成要求へ切り替わる', async () => {
    const user = userEvent.setup()
    const fetcher = createFetcher()
    render(<GenerationCanvas fetcher={fetcher} projects={projects} selectedProjectId="project-alpha" />)

    await screen.findByRole('button', { name: 'arrival-shot' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'キャンバスの制作案件' }), 'project-beta')

    expect(await screen.findByText('この案件には生成要求がありません')).toBeVisible()
    expect(fetcher).toHaveBeenCalledWith('/api/projects/project-beta/generation-canvas', expect.any(Object))
  })

  it('ノードをドラッグして案件別の配置を端末に保存する', async () => {
    render(<GenerationCanvas fetcher={createFetcher()} projects={projects} selectedProjectId="project-alpha" />)
    const node = await screen.findByRole('button', { name: 'arrival-shot' })

    const initialLeft = Number.parseFloat(node.style.left)
    const initialTop = Number.parseFloat(node.style.top)
    fireEvent.pointerDown(node, { pointerId: 7, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(node, { pointerId: 7, clientX: 162, clientY: 131 })
    fireEvent.pointerUp(node, { pointerId: 7, clientX: 162, clientY: 131 })

    expect(Number.parseFloat(node.style.left)).toBeGreaterThan(initialLeft)
    expect(Number.parseFloat(node.style.top)).toBeGreaterThan(initialTop)
    await waitFor(() => {
      expect(window.localStorage.getItem('tsugite-generation-canvas:northern-alps:northern-alps-r2')).toContain('arrival-shot')
    })
  })

  it('ズーム操作と表示リセットを利用できる', async () => {
    const user = userEvent.setup()
    render(<GenerationCanvas fetcher={createFetcher()} projects={projects} selectedProjectId="project-alpha" />)

    await screen.findByRole('button', { name: 'arrival-shot' })
    expect(screen.getByRole('status', { name: 'キャンバス倍率' })).toHaveTextContent('62%')
    await user.click(screen.getByRole('button', { name: '拡大' }))
    expect(screen.getByRole('status', { name: 'キャンバス倍率' })).toHaveTextContent('72%')
    await user.click(screen.getByRole('button', { name: '表示をリセット' }))
    expect(screen.getByRole('status', { name: 'キャンバス倍率' })).toHaveTextContent('62%')
  })
})
