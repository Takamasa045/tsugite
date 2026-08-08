import { useEffect, type RefObject } from 'react'

/**
 * M4: mark ancestor-sibling subtrees inert so a dialog works even when it is
 * the only meaningful child under #root (portal or deep single-child trees).
 * Restores inert on cleanup. Pair with focusin trap / Tab / Escape / restore.
 */
export function collectDialogInertTargets(
  dialog: HTMLElement,
  rootId = 'root',
): HTMLElement[] {
  const targets: HTMLElement[] = []
  const seen = new Set<HTMLElement>()
  const mark = (node: HTMLElement) => {
    if (seen.has(node) || node.contains(dialog)) return
    seen.add(node)
    node.inert = true
    targets.push(node)
  }

  let current: HTMLElement | null = dialog
  while (current && current !== document.documentElement) {
    const parentEl: HTMLElement | null = current.parentElement
    if (!parentEl) break
    for (const sibling of Array.from(parentEl.children)) {
      if (sibling instanceof HTMLElement && sibling !== current) {
        mark(sibling)
      }
    }
    current = parentEl
  }

  const root = document.getElementById(rootId)
  if (root instanceof HTMLElement && !root.contains(dialog)) {
    mark(root)
  }
  return targets
}

export function useDialogBackgroundInert(
  open: boolean,
  dialogRef: RefObject<HTMLElement | null>,
  rootId = 'root',
): void {
  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (!dialog) return
    const targets = collectDialogInertTargets(dialog, rootId)
    return () => {
      for (const node of targets) node.inert = false
    }
  }, [open, dialogRef, rootId])
}
