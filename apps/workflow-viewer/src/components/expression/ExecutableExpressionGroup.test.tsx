import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { PresentationPresetLoadState } from '../template/presentationPresetModel'
import { ExecutableExpressionGroup } from './ExecutableExpressionGroup'
import { normalizePresentationPreset } from './expressionLibraryModel'

const sampleItem = normalizePresentationPreset({
  backend: 'remotion',
  backendLabel: 'Remotion',
  id: 'finish-001',
  label: '仕上げ候補 1',
  description: 'desc',
  aspectRatio: '16:9',
})

/** Stateful harness: state buttons must not steal focus (mousedown preventDefault). */
function RetryFocusHarness({
  readyItems = true,
}: {
  readyItems?: boolean
}) {
  const [state, setState] = useState<PresentationPresetLoadState>('error')
  const items = state === 'ready' && readyItems ? [sampleItem] : []
  return (
    <div>
      <ExecutableExpressionGroup
        presentationPresetLoadState={state}
        onRetryPresentationPresets={() => setState('loading')}
        executableCandidates={items}
        visibleItems={items}
        visibleCount={items.length}
        selections={[]}
        onSelect={vi.fn()}
        onShowMore={vi.fn()}
      />
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setState('ready')}
      >
        complete-load
      </button>
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setState('error')}
      >
        fail-load
      </button>
      <button type="button">other-control</button>
    </div>
  )
}

describe('ExecutableExpressionGroup retry focus', () => {
  it('error→loading→ready: keeps retry focus then hands off to first available control', async () => {
    const user = userEvent.setup()
    render(<RetryFocusHarness />)
    const retry = screen.getByRole('button', { name: 'もう一度読み込む' })
    retry.focus()
    await user.click(retry)

    const busy = screen.getByRole('button', { name: '読み込んでいます…' })
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).not.toHaveAttribute('disabled')
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(busy).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
    // aria-disabled re-entry must not drop focus or re-trigger side effects
    await user.click(busy)
    expect(busy).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'complete-load' }))

    const addButton = screen.getByRole('button', {
      name: '一覧の仕上げ候補 1をコピー候補に追加',
    })
    expect(addButton).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
    expect(screen.queryByRole('button', { name: 'もう一度読み込む' })).not.toBeInTheDocument()
  })

  it('error→loading→ready with empty list: hands focus to section heading', async () => {
    const user = userEvent.setup()
    render(<RetryFocusHarness readyItems={false} />)
    await user.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    expect(screen.getByRole('button', { name: '読み込んでいます…' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'complete-load' }))

    expect(screen.getByRole('heading', { name: 'この環境の仕上げ候補' })).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
  })

  it('error→loading→error: focus remains on the same retry control', async () => {
    const user = userEvent.setup()
    render(<RetryFocusHarness />)
    const retry = screen.getByRole('button', { name: 'もう一度読み込む' })
    retry.focus()
    await user.click(retry)

    const busy = screen.getByRole('button', { name: '読み込んでいます…' })
    expect(busy).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'fail-load' }))

    const retryAgain = screen.getByRole('button', { name: 'もう一度読み込む' })
    expect(retryAgain).toHaveFocus()
    expect(retryAgain).not.toBeDisabled()
    expect(document.activeElement).not.toBe(document.body)
  })

  it('loading中に別controlへ移したら ready でもそのfocusを奪わない', async () => {
    const user = userEvent.setup()
    render(<RetryFocusHarness />)
    await user.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    expect(screen.getByRole('button', { name: '読み込んでいます…' })).toHaveFocus()

    const other = screen.getByRole('button', { name: 'other-control' })
    await user.click(other)
    expect(other).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'complete-load' }))

    expect(other).toHaveFocus()
    expect(screen.getByRole('button', {
      name: '一覧の仕上げ候補 1をコピー候補に追加',
    })).not.toHaveFocus()
  })

  it('loading中に別controlへ移したら re-error でもそのfocusを奪わない', async () => {
    const user = userEvent.setup()
    render(<RetryFocusHarness />)
    await user.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    const other = screen.getByRole('button', { name: 'other-control' })
    other.focus()
    expect(other).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'fail-load' }))

    expect(other).toHaveFocus()
    expect(screen.getByRole('button', { name: 'もう一度読み込む' })).not.toHaveFocus()
  })

  it('retry 上/ body 落ちなら ready で first control へ handoff する（別controlでない）', async () => {
    const user = userEvent.setup()
    render(<RetryFocusHarness />)
    await user.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    const busy = screen.getByRole('button', { name: '読み込んでいます…' })
    expect(busy).toHaveFocus()

    // disabled 化などで body / null へ落ちた場合も所有扱い（別 interactive ではない）
    act(() => {
      busy.blur()
    })
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'other-control' }))

    await user.click(screen.getByRole('button', { name: 'complete-load' }))

    expect(screen.getByRole('button', {
      name: '一覧の仕上げ候補 1をコピー候補に追加',
    })).toHaveFocus()
  })

  it('initial loading does not mount a retry action control', () => {
    render(
      <ExecutableExpressionGroup
        presentationPresetLoadState="loading"
        onRetryPresentationPresets={vi.fn()}
        executableCandidates={[]}
        visibleItems={[]}
        visibleCount={0}
        selections={[]}
        onSelect={vi.fn()}
        onShowMore={vi.fn()}
      />,
    )
    expect(screen.getByText(/この環境の仕上げ候補を読み込んでいます/)).toBeVisible()
    expect(screen.queryByRole('button', { name: /もう一度読み込む|読み込んでいます/ })).not.toBeInTheDocument()
  })

  it('owned success handoff focuses without preventScroll; re-error keeps preventScroll', async () => {
    const user = userEvent.setup()
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus')
    const { unmount } = render(<RetryFocusHarness />)

    await user.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    focusSpy.mockClear()
    await user.click(screen.getByRole('button', { name: 'complete-load' }))

    expect(screen.getByRole('button', {
      name: '一覧の仕上げ候補 1をコピー候補に追加',
    })).toHaveFocus()
    // Success handoff must not pass preventScroll: true
    expect(
      focusSpy.mock.calls.every((call) => (call[0] as FocusOptions | undefined)?.preventScroll !== true),
    ).toBe(true)
    expect(focusSpy.mock.calls.some((call) => call.length === 0 || call[0] == null)).toBe(true)
    focusSpy.mockRestore()
    unmount()

    // Re-error path: restore same retry with preventScroll
    const focusSpy2 = vi.spyOn(HTMLElement.prototype, 'focus')
    render(<RetryFocusHarness />)
    await user.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    focusSpy2.mockClear()
    await user.click(screen.getByRole('button', { name: 'fail-load' }))
    expect(screen.getByRole('button', { name: 'もう一度読み込む' })).toHaveFocus()
    expect(
      focusSpy2.mock.calls.some((call) => (call[0] as FocusOptions | undefined)?.preventScroll === true),
    ).toBe(true)
    focusSpy2.mockRestore()
  })

  it('owned success handoff does not steal focus when user already moved to another control', async () => {
    const user = userEvent.setup()
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus')
    render(<RetryFocusHarness />)
    await user.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    const other = screen.getByRole('button', { name: 'other-control' })
    other.focus()
    focusSpy.mockClear()
    await user.click(screen.getByRole('button', { name: 'complete-load' }))
    expect(other).toHaveFocus()
    // No programmatic focus handoff when ownership lost
    expect(focusSpy).not.toHaveBeenCalled()
    focusSpy.mockRestore()
  })

  it('production source keeps soft-disable (no dynamic native disabled on retry)', async () => {
    const source = await readComponentSource('src/components/expression/ExecutableExpressionGroup.tsx')
    expect(source).toMatch(/aria-disabled=\{isLoading \|\| undefined\}/)
    expect(source).not.toMatch(/disabled=\{isLoading\}/)
    expect(source).toMatch(/if \(isLoading\) return/)
  })
})

async function readComponentSource(relativePath: string): Promise<string> {
  const nodeFs = 'node:fs'
  const nodePath = 'node:path'
  const fs = await import(/* @vite-ignore */ nodeFs) as {
    readFileSync: (path: string, encoding: string) => string
  }
  const path = await import(/* @vite-ignore */ nodePath) as {
    resolve: (...parts: string[]) => string
  }
  const cwd = (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.()
  if (!cwd) throw new Error('process.cwd is unavailable')
  return fs.readFileSync(path.resolve(cwd, relativePath), 'utf8')
}
