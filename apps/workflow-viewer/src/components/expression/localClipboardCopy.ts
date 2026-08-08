/** Clipboard wait upper bound; never hang on unresolved writeText. */
export const EXPRESSION_CLIPBOARD_TIMEOUT_MS = 1500

export type LocalClipboardCopyState = 'idle' | 'copied' | 'unsupported' | 'failed'

export const LOCAL_CLIPBOARD_COPY_MESSAGES = {
  copied: 'コピー済みです。まだ送信していません。',
  unsupported: 'この環境ではコピーできません。表示中の文言を手動で選んでコピーしてください。',
  failed: 'コピーに失敗しました。表示中の文言を手動で選んでコピーしてください。',
} as const

/**
 * Synchronous copy via hidden textarea + document.execCommand("copy").
 * Must run inside a user-gesture stack (e.g. click) so macOS OS clipboard updates.
 * Never throws; never leaves the temporary textarea mounted when remove succeeds.
 * Cleanup / focus-restore failures do not overwrite a successful execCommand result.
 */
function copyWithHiddenTextarea(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    return false
  }

  // textarea.select() moves focus; restore the caller after remove so Chromium
  // does not leave focus on body (copy success/fail and generation stay unchanged).
  const previousActive = document.activeElement
  let textarea: HTMLTextAreaElement | null = null
  let ok = false

  try {
    textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('aria-hidden', 'true')
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    textarea.style.top = '0'
    textarea.style.opacity = '0'
    textarea.style.pointerEvents = 'none'
    document.body.append(textarea)
    textarea.select()
    ok = document.execCommand('copy')
  } catch {
    // DOM prep / select / execCommand: swallow and fall through to navigator.
    ok = false
  }

  // Best-effort remove: do not throw out, do not overwrite ok.
  if (textarea !== null) {
    try {
      textarea.remove()
    } catch {
      // keep ok as-is
    }
  }

  // Best-effort focus restore: do not throw out, do not overwrite ok.
  try {
    if (
      previousActive instanceof HTMLElement
      && previousActive.isConnected
    ) {
      previousActive.focus({ preventScroll: true })
    }
  } catch {
    // keep ok as-is
  }

  return ok
}

/**
 * Local clipboard write: try user-gesture sync execCommand first, then
 * navigator.clipboard.writeText with timeout/stale control.
 * Never throws raw errors to UI. Returns a coarse result only (no tokens / exception text).
 *
 * On execCommand success, returns ok without calling navigator (OS clipboard is updated
 * even when Clipboard API would resolve without applying the system pasteboard).
 */
export async function writeLocalClipboardText(
  text: string,
  options?: { timeoutMs?: number; signal?: { generation: number; current: () => number } },
): Promise<'ok' | 'failed' | 'unsupported' | 'stale'> {
  // Prefer the synchronous path while still in the user-click stack.
  if (copyWithHiddenTextarea(text)) {
    if (options?.signal && options.signal.generation !== options.signal.current()) {
      return 'stale'
    }
    return 'ok'
  }

  if (
    typeof navigator === 'undefined'
    || !navigator.clipboard
    || typeof navigator.clipboard.writeText !== 'function'
  ) {
    return 'unsupported'
  }

  const timeoutMs = options?.timeoutMs ?? EXPRESSION_CLIPBOARD_TIMEOUT_MS
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  // Normalize sync throws from writeText into Promise rejections.
  const writePromise = Promise.resolve().then(() => navigator.clipboard.writeText(text))
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timeoutId = setTimeout(() => {
      timeoutId = null
      resolve('timeout')
    }, timeoutMs)
  })

  try {
    const result = await Promise.race([
      writePromise.then(() => 'ok' as const).catch(() => 'failed' as const),
      timeoutPromise,
    ])
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
    if (options?.signal && options.signal.generation !== options.signal.current()) {
      return 'stale'
    }
    return result === 'ok' ? 'ok' : 'failed'
  } catch {
    if (timeoutId !== null) clearTimeout(timeoutId)
    if (options?.signal && options.signal.generation !== options.signal.current()) {
      return 'stale'
    }
    return 'failed'
  }
}
