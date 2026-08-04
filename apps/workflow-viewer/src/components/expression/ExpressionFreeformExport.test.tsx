import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ExpressionFreeformExport,
  FREEFORM_CLIPBOARD_TIMEOUT_MS,
} from './ExpressionFreeformExport'

function installExecCommand(
  impl: ((commandId: string) => boolean) | boolean,
): { execCommand: ReturnType<typeof vi.fn>; restore: () => void } {
  const previous = Object.getOwnPropertyDescriptor(document, 'execCommand')
  const execCommand = typeof impl === 'boolean'
    ? vi.fn().mockReturnValue(impl)
    : vi.fn(impl)
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: execCommand,
  })
  return {
    execCommand,
    restore: () => {
      if (previous) {
        Object.defineProperty(document, 'execCommand', previous)
      } else {
        Reflect.deleteProperty(document, 'execCommand')
      }
    },
  }
}

describe('ExpressionFreeformExport', () => {
  afterEach(() => {
    document.querySelectorAll('textarea[aria-hidden="true"]').forEach((node) => {
      node.remove()
    })
  })

  it('does not auto-copy on mount or exportText change', () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { execCommand, restore } = installExecCommand(true)
    const onStatusMessage = vi.fn()
    try {
      const { rerender } = render(
        <ExpressionFreeformExport
          exportText="first body"
          onStatusMessage={onStatusMessage}
        />,
      )
      expect(writeText).toHaveBeenCalledTimes(0)
      expect(execCommand).not.toHaveBeenCalled()
      expect(screen.queryByText(/コピー済み/)).not.toBeInTheDocument()

      rerender(
        <ExpressionFreeformExport
          exportText="second body"
          onStatusMessage={onStatusMessage}
        />,
      )
      expect(writeText).toHaveBeenCalledTimes(0)
      expect(execCommand).not.toHaveBeenCalled()
      expect(screen.queryByText(/コピー済み|コピーに失敗/)).not.toBeInTheDocument()
    } finally {
      restore()
    }
  })

  it('uses execCommand first and does not call navigator on success', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    // Capture only — throw inside execCommand would fall back to navigator.
    // jsdom may not move activeElement on select(); inspect the temporary node.
    const captured: { value?: string } = {}
    const { execCommand, restore } = installExecCommand((commandId) => {
      if (commandId === 'copy') {
        const area = document.querySelector('textarea[aria-hidden="true"]')
        if (area instanceof HTMLTextAreaElement) {
          captured.value = area.value
        }
      }
      return true
    })
    try {
      render(
        <ExpressionFreeformExport
          exportText="exec-first-body"
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'まとめてプロンプトをコピー' }))
      expect(await screen.findByRole('status')).toHaveTextContent(
        /コピー済みです。まだ送信していません/,
      )
      expect(execCommand).toHaveBeenCalledWith('copy')
      expect(captured.value).toBe('exec-first-body')
      expect(writeText).not.toHaveBeenCalled()
      expect(document.querySelector('textarea[aria-hidden="true"]')).not.toBeInTheDocument()
    } finally {
      restore()
    }
  })

  it('ignores stale deferred resolve after exportText change (no copied on new body)', async () => {
    let resolveWrite: (() => void) | null = null
    const writeText = vi.fn(() => new Promise<void>((resolve) => {
      resolveWrite = resolve
    }))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const onStatusMessage = vi.fn()
    const { rerender } = render(
      <ExpressionFreeformExport
        exportText="body-v1"
        onStatusMessage={onStatusMessage}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'まとめてプロンプトをコピー' }))
    // writeText is scheduled via Promise.resolve().then (sync-throw normalization)
    await act(async () => {
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('body-v1')
    expect(screen.queryByText(/コピー済み/)).not.toBeInTheDocument()

    // Selection / text change while writeText is still pending
    rerender(
      <ExpressionFreeformExport
        exportText="body-v2"
        onStatusMessage={onStatusMessage}
      />,
    )
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('textbox', { name: '選んだ表現のプロンプト' }))
      .toHaveValue('body-v2')
    expect(screen.queryByText(/コピー済み|コピーに失敗/)).not.toBeInTheDocument()

    // Stale generation resolves later — must not apply copied to new body
    await act(async () => {
      resolveWrite?.()
      await Promise.resolve()
    })
    expect(screen.queryByText(/コピー済み/)).not.toBeInTheDocument()
    expect(screen.queryByText(/コピーに失敗/)).not.toBeInTheDocument()
    expect(onStatusMessage).not.toHaveBeenCalledWith(
      expect.stringMatching(/コピーしました|コピーに失敗/),
    )
  })

  it('ignores stale deferred reject after exportText change (no failed on new body)', async () => {
    let rejectWrite: ((reason?: unknown) => void) | null = null
    const writeText = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectWrite = reject
    }))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const onStatusMessage = vi.fn()
    const { rerender } = render(
      <ExpressionFreeformExport
        exportText="body-v1"
        onStatusMessage={onStatusMessage}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'まとめてプロンプトをコピー' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledTimes(1)

    rerender(
      <ExpressionFreeformExport
        exportText="body-v2"
        onStatusMessage={onStatusMessage}
      />,
    )

    await act(async () => {
      rejectWrite?.(new Error('stale-clipboard-token'))
      await Promise.resolve()
    })
    expect(screen.queryByText(/コピーに失敗|コピー済み/)).not.toBeInTheDocument()
    expect(screen.queryByText(/stale-clipboard-token/)).not.toBeInTheDocument()
    expect(onStatusMessage).not.toHaveBeenCalledWith(
      expect.stringMatching(/コピーに失敗|コピーしました/),
    )
  })

  it('clears timeout timer when exportText changes during pending clipboard wait', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(() => new Promise<void>(() => {}))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const onStatusMessage = vi.fn()
    try {
      const { rerender } = render(
        <ExpressionFreeformExport
          exportText="body-v1"
          onStatusMessage={onStatusMessage}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'まとめてプロンプトをコピー' }))
      await act(async () => {
        await Promise.resolve()
      })
      expect(writeText).toHaveBeenCalledTimes(1)

      rerender(
        <ExpressionFreeformExport
          exportText="body-v2"
          onStatusMessage={onStatusMessage}
        />,
      )
      // Timer from the cancelled generation must not fire failed UI
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FREEFORM_CLIPBOARD_TIMEOUT_MS + 100)
      })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.queryByText(/コピーに失敗|コピー済み/)).not.toBeInTheDocument()
      expect(onStatusMessage).not.toHaveBeenCalledWith(
        expect.stringMatching(/コピーに失敗|コピーしました/),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears local copied feedback on exportText change without wiping parent status', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const onStatusMessage = vi.fn()
    const { rerender } = render(
      <ExpressionFreeformExport
        exportText="body-v1"
        onStatusMessage={onStatusMessage}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'まとめてプロンプトをコピー' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      /コピー済みです。まだ送信していません/,
    )
    // Copy feedback is child-local only — never mirrored to parent aria-live.
    expect(onStatusMessage).not.toHaveBeenCalled()
    const callsAfterCopy = onStatusMessage.mock.calls.length

    rerender(
      <ExpressionFreeformExport
        exportText="body-v2"
        onStatusMessage={onStatusMessage}
      />,
    )
    expect(screen.queryByText(/コピー済み/)).not.toBeInTheDocument()
    // Must not clear parent selection status with empty string
    expect(onStatusMessage).not.toHaveBeenCalledWith('')
    expect(onStatusMessage.mock.calls.length).toBe(callsAfterCopy)
    // text change must not trigger another writeText
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it('respects FREEFORM_CLIPBOARD_TIMEOUT_MS upper bound of 1500', () => {
    expect(FREEFORM_CLIPBOARD_TIMEOUT_MS).toBe(1500)
  })

  it('maps synchronous writeText throw to generic failed UI (no raw error)', async () => {
    const writeText = vi.fn(() => {
      throw new Error('sync-clipboard-token-must-not-leak')
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const onStatusMessage = vi.fn()
    render(
      <ExpressionFreeformExport
        exportText="body-for-sync-throw"
        onStatusMessage={onStatusMessage}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'まとめてプロンプトをコピー' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'コピーに失敗しました。表示中の文言を手動で選んでコピーしてください。',
    )
    expect(screen.queryByText(/sync-clipboard-token-must-not-leak/)).not.toBeInTheDocument()
    // Failure stays in child alert only (no parent double-announce).
    expect(onStatusMessage).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('body-for-sync-throw')
  })

  it('keeps copy feedback in child live region only (no parent status mirror)', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const onStatusMessage = vi.fn()
    render(
      <ExpressionFreeformExport
        exportText="body-for-local-live"
        onStatusMessage={onStatusMessage}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'まとめてプロンプトをコピー' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'コピー済みです。まだ送信していません。',
    )
    expect(onStatusMessage).not.toHaveBeenCalledWith(
      expect.stringMatching(/コピーしました|コピーに失敗|コピーできません/),
    )
    expect(onStatusMessage).not.toHaveBeenCalledWith('')
  })
})
