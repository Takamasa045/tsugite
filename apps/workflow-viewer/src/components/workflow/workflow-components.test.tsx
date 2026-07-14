import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ProgressBar } from './ProgressBar'
import { StatusBadge } from './StatusBadge'

afterEach(cleanup)

describe('StatusBadge', () => {
  it.each([
    ['pending', '未着手'],
    ['queued', '待機中'],
    ['thinking', '思考中'],
    ['running', '実行中'],
    ['waiting_approval', '承認待ち'],
    ['testing', 'テスト中'],
    ['completed', '完了'],
    ['error', 'エラー'],
    ['skipped', 'スキップ'],
  ] as const)('%s を色以外のラベルでも識別できる', (status, label) => {
    render(<StatusBadge status={status} />)

    expect(screen.getByText(label)).toBeInTheDocument()
  })
})

describe('ProgressBar', () => {
  it('進捗を0〜100に補正して読み上げ可能にする', () => {
    const { rerender } = render(<ProgressBar value={140} label="全体進捗" />)

    expect(screen.getByRole('progressbar', { name: '全体進捗' })).toHaveAttribute(
      'aria-valuenow',
      '100',
    )

    rerender(<ProgressBar value={-10} label="全体進捗" />)
    expect(screen.getByRole('progressbar', { name: '全体進捗' })).toHaveAttribute(
      'aria-valuenow',
      '0',
    )
  })
})
