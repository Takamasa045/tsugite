import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { WorkflowCanvas, type WorkflowCanvasNode } from './WorkflowCanvas'

const nodes: WorkflowCanvasNode[] = [
  { id: 'validate', label: '検証', status: 'completed', action: 'validate', description: '入力を検証します。' },
  { id: 'review', label: 'レビュー', status: 'waiting_approval', action: 'review' },
  { id: 'generate', label: '素材生成', status: 'running', action: 'run' },
  { id: 'render', label: '書き出し', status: 'pending' },
  { id: 'qa', label: '最終確認', status: 'error' },
]

describe('WorkflowCanvas', () => {
  it('5状態をテキストで区別し、activeActionとジョブ進捗を表示する', () => {
    render(
      <WorkflowCanvas
        nodes={nodes}
        activeAction="run"
        activeJob={{ id: 'job-1', status: 'running', progress: 42.4, message: '素材を生成中' }}
      />,
    )

    expect(screen.getByRole('region', { name: '制作工程' })).toBeVisible()
    expect(screen.getByRole('button', { name: '検証、完了' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'レビュー、確認待ち' })).toBeVisible()
    expect(screen.getByRole('button', { name: '素材生成、実行中' })).toHaveAttribute('data-active', 'true')
    expect(screen.getByRole('button', { name: '書き出し、未着手' })).toBeVisible()
    expect(screen.getByRole('button', { name: '最終確認、エラー' })).toBeVisible()
    expect(screen.getByText('素材を生成中')).toBeVisible()
    expect(screen.getByRole('progressbar', { name: 'ジョブ進捗' })).toHaveAttribute('aria-valuenow', '42')
  })

  it('クリックで詳細を選択しonSelectへ独立したview modelを渡す', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<WorkflowCanvas nodes={nodes} onSelect={onSelect} />)

    await user.click(screen.getByRole('button', { name: '検証、完了' }))

    expect(screen.getByRole('heading', { name: '検証' })).toBeVisible()
    expect(screen.getByText('入力を検証します。')).toBeVisible()
    expect(onSelect).toHaveBeenCalledWith(nodes[0])
  })

  it('矢印とHome/Endキーでノードを選択しフォーカスを移す', async () => {
    const user = userEvent.setup()
    render(<WorkflowCanvas nodes={nodes} activeAction="validate" />)
    const validate = screen.getByRole('button', { name: '検証、完了' })
    const review = screen.getByRole('button', { name: 'レビュー、確認待ち' })
    const qa = screen.getByRole('button', { name: '最終確認、エラー' })

    validate.focus()
    await user.keyboard('{ArrowRight}')
    expect(review).toHaveFocus()
    expect(review).toHaveAttribute('aria-pressed', 'true')

    await user.keyboard('{End}')
    expect(qa).toHaveFocus()
    expect(screen.getByRole('heading', { name: '最終確認' })).toBeVisible()

    await user.keyboard('{Home}')
    expect(validate).toHaveFocus()
  })

  it('空の工程と説明未設定を明示する', async () => {
    const { rerender } = render(<WorkflowCanvas nodes={[]} />)
    expect(screen.getByText('表示できる制作工程がありません。')).toBeVisible()

    rerender(<WorkflowCanvas nodes={[{ id: 'plan', label: '計画', status: 'pending' }]} />)
    expect(await screen.findByText('この工程の詳しい説明はまだありません。')).toBeVisible()
  })
})
