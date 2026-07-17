import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowData, WorkflowNode } from '../../types/workflow'
import { AppHeader } from './AppHeader'
import { SidePanel } from './SidePanel'
import { TimelinePanel } from './TimelinePanel'

afterEach(cleanup)

const nodes: WorkflowNode[] = [
  {
    id: 'plan', name: '企画作成', type: 'task', agent: 'planner-agent', description: '企画を組み立てる',
    status: 'completed', progress: 100, startedAt: 0, completedAt: 20,
    inputs: ['依頼文'], outputs: ['企画書'],
    logs: [{ time: 20, level: 'success', message: '企画書を生成' }],
  },
  {
    id: 'render', name: '完成動画を作る', technicalName: '最終レンダリング', type: 'agent', agent: 'render-agent', description: '映像を書き出す',
    status: 'error', progress: 42, startedAt: 21,
    inputs: ['企画書'], outputs: ['動画'],
    details: {
      purpose: '承認済みの企画を、視聴できる最終動画に仕上げるための工程です。',
      activity: '企画書の構成に沿って映像と音声を合成し、動画ファイルを書き出しました。',
      outcome: '書き出し中にGPUメモリが不足したため、最終動画はまだ完成していません。',
      inputs: [{
        label: '承認済みの企画書',
        description: '映像の順番、尺、演出方針が確定した制作設計です。',
        reference: '企画書',
        facts: ['全体尺: 60秒', '構成: 8シーン'],
      }],
      outputs: [{
        label: '最終動画',
        description: '視聴・納品に使うMP4動画です。今回はエラーのため未完成です。',
        reference: '動画',
        href: './review/index.html',
      }],
      previews: [
        { id: 'final-video', role: 'final', kind: 'video', label: '完成動画', description: '確認用の完成版です。', src: './previews/final.mp4' },
        { id: 'keyframe', role: 'material', kind: 'image', label: '完成イメージ', description: '制作に使った画像です。', src: './previews/keyframe.jpg' },
        { id: 'narration', role: 'material', kind: 'audio', label: 'ナレーション', description: '制作に使った音声です。', src: './previews/narration.mp3' },
      ],
    },
    logs: [{ time: 38, level: 'error', message: 'GPUメモリが不足' }],
  },
]

const workflow: WorkflowData = {
  id: 'video', name: 'AI動画制作', description: 'エージェントによる動画制作フロー', status: 'running',
  startedAt: '2026-07-13T09:00:00+09:00', duration: 120, nodes,
  edges: [{ id: 'plan-render', source: 'plan', target: 'render' }],
  events: [
    { time: 0, nodeId: 'plan', status: 'running' },
    { time: 20, nodeId: 'plan', status: 'completed' },
    { time: 21, nodeId: 'render', status: 'running' },
  ],
}

describe('AppHeader', () => {
  it('現在のフローと進捗を表示し、サンプル切替とリセットを通知する', async () => {
    const user = userEvent.setup()
    const onResetView = vi.fn()
    const onSampleChange = vi.fn()
    render(<AppHeader workflow={workflow} currentNodes={nodes} onResetView={onResetView}
      samples={[{ id: 'video', label: '動画制作' }, { id: 'web', label: 'Web開発' }]}
      activeSampleId="video" onSampleChange={onSampleChange} />)

    expect(screen.getByRole('heading', { name: 'AI動画制作' })).toBeInTheDocument()
    expect(screen.getByText('71%')).toBeInTheDocument()
    expect(screen.getByText('2工程中 1工程完了')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('サンプルを切り替える'), 'web')
    await user.click(screen.getByRole('button', { name: '表示をリセット' }))
    expect(onSampleChange).toHaveBeenCalledWith('web')
    expect(onResetView).toHaveBeenCalledOnce()
  })

  it('ノードがない場合も0%として表示する', () => {
    render(<AppHeader workflow={workflow} currentNodes={[]} onResetView={vi.fn()}
      samples={[]} activeSampleId="" onSampleChange={vi.fn()} />)
    expect(screen.getByText('0%')).toBeInTheDocument()
  })

  it('ランチャーから開いたViewerでは制作案件へ戻る導線を表示する', () => {
    render(<AppHeader workflow={workflow} currentNodes={nodes} onResetView={vi.fn()}
      samples={[]} activeSampleId="" onSampleChange={vi.fn()} launcherHref="/" />)

    expect(screen.getByRole('link', { name: '制作案件へ戻る' })).toHaveAttribute('href', '/')
  })
})

describe('SidePanel', () => {
  it('未選択時はワークフロー概要と件数を表示する', () => {
    render(<SidePanel workflow={workflow} currentNodes={nodes} selectedNodeId={null} onSelectNode={vi.fn()} />)
    expect(screen.getByRole('heading', { name: '制作全体の状況' })).toBeInTheDocument()
    expect(screen.getByText('エージェントによる動画制作フロー')).toBeInTheDocument()
    expect(screen.getByText('2 工程')).toBeInTheDocument()
    expect(screen.getByText('1 件', { selector: '[data-metric="error"] *' })).toBeInTheDocument()
  })

  it('選択中ノードの生成物、要点、詳しい記録を分けて表示して閉じられる', async () => {
    const user = userEvent.setup()
    const onSelectNode = vi.fn()
    render(<SidePanel workflow={workflow} currentNodes={nodes} selectedNodeId="render" onSelectNode={onSelectNode} />)
    expect(screen.getByRole('heading', { name: '完成動画を作る' })).toBeInTheDocument()
    expect(screen.getByText('担当: render-agent')).toBeInTheDocument()
    expect(screen.getByText('確認・修正が必要')).toBeInTheDocument()
    expect(screen.getByText('何のための工程？')).toBeInTheDocument()
    expect(screen.getByText('承認済みの企画を、視聴できる最終動画に仕上げるための工程です。')).toBeInTheDocument()
    expect(screen.getByText('行ったこと')).toBeInTheDocument()
    expect(screen.getByText('企画書の構成に沿って映像と音声を合成し、動画ファイルを書き出しました。')).toBeInTheDocument()
    expect(screen.getByText('結果')).toBeInTheDocument()
    expect(screen.getAllByText('書き出し中にGPUメモリが不足したため、最終動画はまだ完成していません。')).toHaveLength(2)
    expect(screen.getByRole('heading', { name: '受け取ったもの' })).toBeInTheDocument()
    expect(screen.getByText('承認済みの企画書')).toBeInTheDocument()
    expect(screen.getByText('映像の順番、尺、演出方針が確定した制作設計です。')).toBeInTheDocument()
    expect(screen.getByText('全体尺: 60秒')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '次へ渡したもの' })).toBeInTheDocument()
    expect(screen.getByText('最終動画')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '最終動画のプレビューHTMLを開く' })).toHaveAttribute('href', './review/index.html')
    expect(screen.getByRole('link', { name: '最終動画のプレビューHTMLを開く' })).toHaveAttribute('target', '_blank')
    expect(screen.getByRole('heading', { name: '実際に作ったもの' })).toBeInTheDocument()
    expect(document.querySelector('video[src="./previews/final.mp4"]')).toHaveAttribute('controls')
    expect(screen.getByRole('img', { name: '完成イメージ' })).toHaveAttribute('src', './previews/keyframe.jpg')
    expect(document.querySelector('audio[src="./previews/narration.mp3"]')).toHaveAttribute('controls')
    expect(screen.getByText('詳しい情報')).toBeInTheDocument()
    expect(document.querySelector('details.technical-details')).not.toHaveAttribute('open')
    expect(screen.getByText(/内部工程: 最終レンダリング/)).toBeInTheDocument()
    expect(screen.getByText('技術参照: 企画書')).toBeInTheDocument()
    expect(screen.getAllByText('GPUメモリが不足')).toHaveLength(2)
    expect(screen.getByRole('button', { name: '企画作成を選択' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '詳細を閉じる' }))
    expect(onSelectNode).toHaveBeenCalledWith(null)
  })

  it('承認工程で、承認対象・確認ポイント・現在の判断を人向けに表示する', () => {
    const approvalNode = {
      id: 'gate-2', name: 'Gate 2 素材・構成承認', type: 'approval' as const,
      status: 'waiting_approval' as const, progress: 50, startedAt: 40,
      inputs: ['assemble-manifest.result'], outputs: ['gate-2.result'], logs: [],
      details: {
        purpose: '生成素材を最終編集へ渡してよいか、人が判断する工程です。',
        activity: '素材の破損、尺、解像度、音声の有無を自動検査しました。',
        outcome: '自動検査は通過し、人の承認を待っています。',
        inputs: [],
        outputs: [],
        approval: {
          subject: '生成済み27点の素材と60秒の構成を、最終編集へ渡すこと',
          checkpoints: [
            '8本の映像、10枚の画像、9本の音声を読み込めること',
            '構成尺60.333秒が目標60秒の許容範囲内であること',
          ],
          decision: '現在は未承認です。内容を確認して進行可否を判断してください。',
        },
      },
    }
    render(<SidePanel workflow={{ ...workflow, nodes: [approvalNode], edges: [] }}
      currentNodes={[approvalNode]} selectedNodeId="gate-2" onSelectNode={vi.fn()} />)

    expect(screen.getByRole('heading', { name: '承認する内容' })).toBeInTheDocument()
    expect(screen.getByText('生成済み27点の素材と60秒の構成を、最終編集へ渡すこと')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '承認前に確認するポイント' })).toBeInTheDocument()
    expect(screen.getByText('8本の映像、10枚の画像、9本の音声を読み込めること')).toBeInTheDocument()
    expect(screen.getByText('現在は未承認です。内容を確認して進行可否を判断してください。')).toBeInTheDocument()
  })

  it('任意項目や接続のないノードを安全な空状態で表示する', () => {
    const emptyNode: WorkflowNode = {
      id: 'empty', name: '待機ノード', type: 'approval', status: 'pending', progress: 0,
      inputs: [], outputs: [], logs: [],
    }
    render(<SidePanel workflow={{ ...workflow, description: undefined, startedAt: 'invalid', duration: 3665,
      nodes: [emptyNode], edges: [] }} currentNodes={[emptyNode]} selectedNodeId="empty" onSelectNode={vi.fn()} />)

    expect(screen.getByText('担当: 自動処理')).toBeInTheDocument()
    expect(screen.getByText('次に行う作業')).toBeInTheDocument()
    expect(screen.getByText('説明は登録されていません。')).toBeInTheDocument()
    expect(screen.getAllByText('なし')).toHaveLength(2)
    expect(screen.getByText('接続されたノードはありません。')).toBeInTheDocument()
    expect(screen.getByText('この時点までの作業記録はありません。')).toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('概要の欠損時刻・空ノード・1時間超の記録を表示する', () => {
    render(<SidePanel workflow={{ ...workflow, description: undefined, startedAt: undefined, duration: 3665,
      nodes: [], edges: [] }} currentNodes={[]} selectedNodeId={null} onSelectNode={vi.fn()} />)

    expect(screen.getByText('説明は登録されていません。')).toBeInTheDocument()
    expect(screen.getByText('未記録')).toBeInTheDocument()
    expect(screen.getByText('1時間 1分')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: '全体の進み具合' })).toHaveAttribute('aria-valuenow', '0')
  })
})

describe('TimelinePanel', () => {
  it('工程選択、再生、先頭移動、シーク、速度変更を通知する', async () => {
    const user = userEvent.setup()
    const onTogglePlaying = vi.fn()
    const onReset = vi.fn()
    const onSeek = vi.fn()
    const onSpeedChange = vi.fn()
    const onSelectNode = vi.fn()
    const props = { workflow, currentTime: 30, isPlaying: false, playbackSpeed: 1,
      currentNodes: nodes, selectedNodeId: 'render', onSelectNode,
      onTogglePlaying, onReset, onSeek, onSpeedChange }
    const { rerender } = render(<TimelinePanel {...props} />)

    expect(screen.getByText('00:30 / 02:00')).toBeInTheDocument()
    expect(screen.getAllByTestId('event-marker')).toHaveLength(3)
    expect(screen.getByRole('button', { name: '完成動画を作るの工程詳細を表示' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('heading', { name: '制作の現在地' })).toBeInTheDocument()
    expect(screen.getByText('いま確認が必要な工程：完成動画を作る')).toBeInTheDocument()
    expect(screen.getByText('工程を選ぶと、右の記録欄に内容が表示されます。')).toBeInTheDocument()
    expect(screen.getByText('詳細表示中')).toBeInTheDocument()
    expect(screen.getByText('工程 01')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '企画作成の工程詳細を表示' }))
    await user.click(screen.getByRole('button', { name: '再生' }))
    await user.click(screen.getByRole('button', { name: '先頭に戻る' }))
    fireEvent.change(screen.getByRole('slider', { name: 'タイムライン' }), { target: { value: '45' } })
    await user.selectOptions(screen.getByLabelText('再生速度'), '2')
    expect(onTogglePlaying).toHaveBeenCalledWith(true)
    expect(onSelectNode).toHaveBeenCalledWith('plan')
    expect(onReset).toHaveBeenCalledOnce()
    expect(onSeek).toHaveBeenLastCalledWith(45)
    expect(onSpeedChange).toHaveBeenCalledWith(2)

    rerender(<TimelinePanel {...props} currentTime={31} isPlaying playbackSpeed={2} />)
    expect(screen.getByRole('button', { name: '一時停止' })).toBeInTheDocument()
  })

  it('0秒のフローでもマーカーとシーク値を安全に制限する', () => {
    render(<TimelinePanel workflow={{ ...workflow, duration: 0 }} currentTime={-3} isPlaying={false}
      currentNodes={nodes} selectedNodeId={null} onSelectNode={vi.fn()}
      playbackSpeed={0.5} onTogglePlaying={vi.fn()} onReset={vi.fn()} onSeek={vi.fn()} onSpeedChange={vi.fn()} />)
    expect(screen.getByText('00:00 / 00:00')).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'タイムライン' })).toHaveValue('0')
    expect(screen.getAllByTestId('event-marker')[0]).toHaveStyle({ left: '0%' })
  })
})
