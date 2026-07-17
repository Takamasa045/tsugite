import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkflowNode } from '../../types/workflow'
import { NodeLabel } from './NodeLabel'

vi.mock('@react-three/drei', () => ({
  Html: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

afterEach(cleanup)

const node: WorkflowNode = {
  id: 'gate-1',
  name: 'Gate 1 制作方針承認',
  type: 'approval',
  status: 'waiting_approval',
  progress: 50,
  inputs: ['creative-review.result'],
  outputs: ['gate-1.result'],
  logs: [],
}

describe('NodeLabel', () => {
  it('3Dラベルをキーボード操作可能な工程選択ボタンとして公開する', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<NodeLabel featured node={node} selected={false} onSelect={onSelect} />)

    const button = screen.getByRole('button', { name: 'Gate 1 制作方針承認の詳細を表示' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(button).toHaveAttribute('aria-current', 'step')
    expect(screen.getByText('職人があなたの確認を待っています')).toBeInTheDocument()
    await user.click(button)
    expect(onSelect).toHaveBeenCalledWith('gate-1')
  })

  it('工程単体へズーム中は未選択の工程札を画面と読み上げ対象から隠す', () => {
    render(<NodeLabel muted node={node} selected={false} onSelect={vi.fn()} />)

    expect(document.querySelector('button.scene-node-label')).toHaveAttribute('hidden')
    expect(screen.queryByRole('button', { name: 'Gate 1 制作方針承認の詳細を表示' })).not.toBeInTheDocument()
  })
})
