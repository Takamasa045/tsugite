import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  EXPRESSION_CLIPBOARD_TIMEOUT_MS,
  writeLocalClipboardText,
} from './localClipboardCopy'

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

function installWriteText(
  writeText: ReturnType<typeof vi.fn> | undefined,
): { writeText: ReturnType<typeof vi.fn> | undefined; restore: () => void } {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  if (writeText === undefined) {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
  } else {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
  }
  return {
    writeText,
    restore: () => {
      if (previous) {
        Object.defineProperty(navigator, 'clipboard', previous)
      } else {
        Reflect.deleteProperty(navigator, 'clipboard')
      }
    },
  }
}

describe('writeLocalClipboardText', () => {
  afterEach(() => {
    vi.useRealTimers()
    document.querySelectorAll('textarea[aria-hidden="true"]').forEach((node) => {
      node.remove()
    })
  })

  it('execCommand success skips navigator and restores focus after selecting text', async () => {
    const writeText = vi.fn(async () => undefined)
    const clipboard = installWriteText(writeText)
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = 'copy'
    document.body.append(button)
    button.focus()
    expect(document.activeElement).toBe(button)

    // Capture only — never throw inside execCommand (throw falls back to navigator).
    // jsdom may not move activeElement on select(); inspect the temporary node instead.
    const captured: {
      commandId?: string
      value?: string
      readonly?: boolean
      selectionStart?: number | null
      selectionEnd?: number | null
      tagName?: string
    } = {}
    const { execCommand, restore } = installExecCommand((commandId) => {
      captured.commandId = commandId
      const area = document.querySelector('textarea[aria-hidden="true"]')
      if (area instanceof HTMLTextAreaElement) {
        captured.tagName = area.tagName
        captured.value = area.value
        captured.readonly = area.readOnly || area.hasAttribute('readonly')
        captured.selectionStart = area.selectionStart
        captured.selectionEnd = area.selectionEnd
      }
      return true
    })

    try {
      const result = await writeLocalClipboardText('expression-prompt-body')
      expect(result).toBe('ok')
      expect(execCommand).toHaveBeenCalledTimes(1)
      expect(execCommand).toHaveBeenCalledWith('copy')
      expect(captured.commandId).toBe('copy')
      expect(captured.tagName).toBe('TEXTAREA')
      expect(captured.value).toBe('expression-prompt-body')
      expect(captured.readonly).toBe(true)
      expect(captured.selectionStart).toBe(0)
      expect(captured.selectionEnd).toBe('expression-prompt-body'.length)
      expect(writeText).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(button)
      expect(document.querySelector('textarea[aria-hidden="true"]')).toBeNull()
    } finally {
      restore()
      clipboard.restore()
      button.remove()
    }
  })

  it('execCommand success is ok even without navigator.clipboard', async () => {
    const clipboard = installWriteText(undefined)
    const { execCommand, restore } = installExecCommand(true)
    try {
      const result = await writeLocalClipboardText('no-navigator-needed')
      expect(result).toBe('ok')
      expect(execCommand).toHaveBeenCalledWith('copy')
    } finally {
      restore()
      clipboard.restore()
    }
  })

  it('falls back to navigator when execCommand returns false', async () => {
    const writeText = vi.fn(async () => undefined)
    const clipboard = installWriteText(writeText)
    const { execCommand, restore } = installExecCommand(false)
    try {
      const result = await writeLocalClipboardText('fallback-body')
      expect(result).toBe('ok')
      expect(execCommand).toHaveBeenCalledWith('copy')
      expect(writeText).toHaveBeenCalledTimes(1)
      expect(writeText).toHaveBeenCalledWith('fallback-body')
      expect(document.querySelector('textarea[aria-hidden="true"]')).toBeNull()
    } finally {
      restore()
      clipboard.restore()
    }
  })

  it('falls back to navigator when execCommand throws', async () => {
    const writeText = vi.fn(async () => undefined)
    const clipboard = installWriteText(writeText)
    const previous = Object.getOwnPropertyDescriptor(document, 'execCommand')
    const execCommand = vi.fn(() => {
      throw new Error('exec-secret-token-must-not-escape')
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })
    try {
      const result = await writeLocalClipboardText('throw-fallback-body')
      expect(result).toBe('ok')
      expect(execCommand).toHaveBeenCalledWith('copy')
      expect(writeText).toHaveBeenCalledWith('throw-fallback-body')
      expect(document.querySelector('textarea[aria-hidden="true"]')).toBeNull()
    } finally {
      if (previous) {
        Object.defineProperty(document, 'execCommand', previous)
      } else {
        Reflect.deleteProperty(document, 'execCommand')
      }
      clipboard.restore()
    }
  })

  it('falls back to navigator when textarea.select throws and removes temporary textarea', async () => {
    const writeText = vi.fn(async () => undefined)
    const clipboard = installWriteText(writeText)
    const { execCommand, restore } = installExecCommand(true)
    const selectSpy = vi.spyOn(HTMLTextAreaElement.prototype, 'select').mockImplementation(() => {
      throw new Error('select-secret-token-must-not-escape')
    })
    try {
      await expect(writeLocalClipboardText('select-throw-body')).resolves.toBe('ok')
      expect(execCommand).not.toHaveBeenCalled()
      expect(writeText).toHaveBeenCalledTimes(1)
      expect(writeText).toHaveBeenCalledWith('select-throw-body')
      expect(document.querySelector('textarea[aria-hidden="true"]')).toBeNull()
    } finally {
      selectSpy.mockRestore()
      restore()
      clipboard.restore()
    }
  })

  it('keeps execCommand ok when focus restore throws and still removes temporary textarea', async () => {
    const writeText = vi.fn(async () => undefined)
    const clipboard = installWriteText(writeText)
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = 'copy'
    document.body.append(button)
    button.focus()
    expect(document.activeElement).toBe(button)

    const focusSpy = vi.spyOn(button, 'focus').mockImplementation(() => {
      throw new Error('focus-secret-token-must-not-escape')
    })
    const { execCommand, restore } = installExecCommand(true)
    try {
      await expect(writeLocalClipboardText('focus-throw-body')).resolves.toBe('ok')
      expect(execCommand).toHaveBeenCalledWith('copy')
      expect(writeText).not.toHaveBeenCalled()
      expect(document.querySelector('textarea[aria-hidden="true"]')).toBeNull()
    } finally {
      focusSpy.mockRestore()
      restore()
      clipboard.restore()
      button.remove()
    }
  })

  it('keeps execCommand ok when textarea.remove throws without rejecting raw error', async () => {
    const writeText = vi.fn(async () => undefined)
    const clipboard = installWriteText(writeText)
    const { execCommand, restore } = installExecCommand(true)
    const removeSpy = vi
      .spyOn(HTMLTextAreaElement.prototype, 'remove')
      .mockImplementation(function (this: HTMLTextAreaElement) {
        // Detach via parentNode so the spy does not recurse, then throw.
        // Models remove() raising while the caller must keep ok and not leave the node.
        this.parentNode?.removeChild(this)
        throw new Error('remove-secret-token-must-not-escape')
      })
    try {
      await expect(writeLocalClipboardText('remove-throw-body')).resolves.toBe('ok')
      expect(execCommand).toHaveBeenCalledWith('copy')
      expect(writeText).not.toHaveBeenCalled()
      expect(document.querySelector('textarea[aria-hidden="true"]')).toBeNull()
    } finally {
      removeSpy.mockRestore()
      restore()
      clipboard.restore()
    }
  })

  it('falls back to navigator when execCommand is missing', async () => {
    const writeText = vi.fn(async () => undefined)
    const clipboard = installWriteText(writeText)
    const previous = Object.getOwnPropertyDescriptor(document, 'execCommand')
    Reflect.deleteProperty(document, 'execCommand')
    try {
      const result = await writeLocalClipboardText('no-exec-body')
      expect(result).toBe('ok')
      expect(writeText).toHaveBeenCalledWith('no-exec-body')
    } finally {
      if (previous) {
        Object.defineProperty(document, 'execCommand', previous)
      }
      clipboard.restore()
    }
  })

  it('returns unsupported when both execCommand and navigator are unavailable', async () => {
    const clipboard = installWriteText(undefined)
    const { execCommand, restore } = installExecCommand(false)
    try {
      const result = await writeLocalClipboardText('nowhere-to-write')
      expect(result).toBe('unsupported')
      expect(execCommand).toHaveBeenCalledWith('copy')
    } finally {
      restore()
      clipboard.restore()
    }
  })

  it('maps navigator reject to failed without leaking raw error text', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('navigator-secret-token')
    })
    const clipboard = installWriteText(writeText)
    const { restore } = installExecCommand(false)
    try {
      const result = await writeLocalClipboardText('fail-body')
      expect(result).toBe('failed')
      expect(writeText).toHaveBeenCalledTimes(1)
    } finally {
      restore()
      clipboard.restore()
    }
  })

  it('times out unresolved navigator writeText after EXPRESSION_CLIPBOARD_TIMEOUT_MS', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(() => new Promise<void>(() => {}))
    const clipboard = installWriteText(writeText)
    const { restore } = installExecCommand(false)
    try {
      const pending = writeLocalClipboardText('hang-body')
      await Promise.resolve()
      expect(writeText).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(EXPRESSION_CLIPBOARD_TIMEOUT_MS)
      await expect(pending).resolves.toBe('failed')
    } finally {
      restore()
      clipboard.restore()
    }
  })

  it('returns stale when generation changes during navigator wait', async () => {
    let resolveWrite: (() => void) | undefined
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = () => {
            resolve()
          }
        }),
    )
    const clipboard = installWriteText(writeText)
    const { restore } = installExecCommand(false)
    let current = 1
    try {
      const pending = writeLocalClipboardText('stale-body', {
        signal: {
          generation: 1,
          current: () => current,
        },
      })
      await Promise.resolve()
      expect(writeText).toHaveBeenCalledTimes(1)
      current = 2
      resolveWrite?.()
      await expect(pending).resolves.toBe('stale')
    } finally {
      restore()
      clipboard.restore()
    }
  })

  it('does not invoke execCommand or navigator by itself (no auto-copy)', async () => {
    const writeText = vi.fn(async () => undefined)
    const clipboard = installWriteText(writeText)
    const { execCommand, restore } = installExecCommand(true)
    try {
      expect(execCommand).not.toHaveBeenCalled()
      expect(writeText).not.toHaveBeenCalled()
      // Import/export only; callers must invoke writeLocalClipboardText on click.
    } finally {
      restore()
      clipboard.restore()
    }
  })
})
