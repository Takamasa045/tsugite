import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DesktopWorkspaceRecovery } from './DesktopWorkspaceRecovery'

function setWorkspaceBridge(current: unknown, select: unknown) {
  Object.defineProperty(window, 'tsugiteDesktop', {
    configurable: true,
    value: { workspace: { current, select } },
  })
}

afterEach(() => {
  delete (window as Window & { tsugiteDesktop?: unknown }).tsugiteDesktop
})

describe('DesktopWorkspaceRecovery', () => {
  it('browserでは何も表示しない', () => {
    const { container } = render(<DesktopWorkspaceRecovery />)
    expect(container).toBeEmptyDOMElement()
  })

  it('cancel・同一workspace・busy・失敗を次の行動が分かる文言で返す', async () => {
    const user = userEvent.setup()
    const select = vi.fn()
      .mockResolvedValueOnce({ status: 'canceled', workspace: { label: '制作workspace' } })
      .mockResolvedValueOnce({ status: 'unchanged', workspace: { label: '制作workspace' } })
      .mockResolvedValueOnce({ status: 'busy', workspace: { label: '制作workspace' } })
      .mockRejectedValueOnce(new Error('selection failed'))
    setWorkspaceBridge(
      vi.fn().mockResolvedValue({ label: '制作workspace' }),
      select,
    )
    render(<DesktopWorkspaceRecovery />)

    const button = await screen.findByRole('button', { name: 'workspaceを選び直す' })
    expect(await screen.findByText('現在のworkspace：制作workspace')).toBeVisible()
    await user.click(button)
    expect(screen.getByRole('status')).toHaveTextContent('workspaceの変更をキャンセルしました。')
    await user.click(button)
    expect(screen.getByRole('status')).toHaveTextContent('現在と同じworkspaceが選ばれています。')
    await user.click(button)
    expect(screen.getByRole('alert')).toHaveTextContent('AI CLIや制作処理を停止してから')
    await user.click(button)
    expect(screen.getByRole('alert')).toHaveTextContent('別の専用フォルダを選んで')
  })

  it('切替開始後は再起動中を表示して重複操作を止める', async () => {
    const user = userEvent.setup()
    const select = vi.fn().mockResolvedValue({
      status: 'restarting',
      workspace: { label: '新しいworkspace' },
    })
    setWorkspaceBridge(
      vi.fn().mockResolvedValue({ label: '古いworkspace' }),
      select,
    )
    render(<DesktopWorkspaceRecovery />)

    await user.click(await screen.findByRole('button', { name: 'workspaceを選び直す' }))

    expect(screen.getByRole('button', { name: 'Desktopを再起動しています…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Desktopを再起動しています…' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('workspaceを切り替えるためDesktopを再起動します')
    expect(select).toHaveBeenCalledOnce()
  })
})
