import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ExpressionItem } from './expressionLibraryModel'
import {
  ExpressionPreview,
  resetExpressionPreviewSharedStateForTests,
} from './ExpressionPreview'
import { EXPRESSION_PREVIEW_SAMPLE_TEXT } from './expressionPreviewSpec'

function makeItem(overrides: Partial<ExpressionItem> = {}): ExpressionItem {
  return {
    key: 'reference-catalog::hyperframes::component::typewriter',
    provider: 'hyperframes',
    nativeId: 'typewriter',
    title: 'Typewriter',
    description: 'Text effect',
    tags: ['text', 'caption', 'typewriter'],
    role: 'text-overlay',
    category: '文字・字幕',
    aspect: '16:9',
    durationSeconds: null,
    capability: 'reference-only',
    availability: 'reference-catalog',
    previewFidelity: 'motion-hint',
    family: 'typewriter',
    tone: [],
    pace: [],
    features: ['text', 'typewriter'],
    brandLock: false,
    source: 'reference-catalog',
    catalogType: 'component',
    ...overrides,
  }
}

type ObserverCallback = IntersectionObserverCallback

describe('ExpressionPreview', () => {
  const observerCallbacks = new Map<Element, ObserverCallback>()

  afterEach(() => {
    resetExpressionPreviewSharedStateForTests()
    vi.unstubAllGlobals()
    observerCallbacks.clear()
  })

  function stubIntersectionObserver() {
    class FakeIntersectionObserver {
      callback: ObserverCallback
      constructor(callback: ObserverCallback) {
        this.callback = callback
      }
      observe(target: Element) {
        observerCallbacks.set(target, this.callback)
      }
      unobserve(target: Element) {
        observerCallbacks.delete(target)
      }
      disconnect() {
        observerCallbacks.clear()
      }
      takeRecords(): IntersectionObserverEntry[] {
        return []
      }
      root = null
      rootMargin = ''
      thresholds: readonly number[] = []
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  }

  function fireVisibility(target: Element, isIntersecting: boolean) {
    const callback = observerCallbacks.get(target)
    expect(callback).toBeTruthy()
    act(() => {
      callback!([
        {
          isIntersecting,
          target,
          intersectionRatio: isIntersecting ? 1 : 0,
          time: 0,
          boundingClientRect: {} as DOMRectReadOnly,
          intersectionRect: {} as DOMRectReadOnly,
          rootBounds: null,
        } as IntersectionObserverEntry,
      ], {} as IntersectionObserver)
    })
  }

  function firePreviewAnimationEnd(target: Element, animationName: string) {
    for (const type of ['animationend', 'webkitAnimationEnd']) {
      const event = new Event(type, { bubbles: true })
      Object.defineProperty(event, 'animationName', { value: animationName })
      fireEvent(target, event)
    }
  }

  function firePreviewAnimationIteration(target: Element) {
    fireEvent(target, new Event('animationiteration', { bubbles: true }))
    fireEvent(target, new Event('webkitAnimationIteration', { bubbles: true }))
  }

  function stubMutableReducedMotion(initial: boolean) {
    let matches = initial
    const listeners = new Set<() => void>()
    const media = {
      get matches() {
        return matches
      },
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: (listener: () => void) => listeners.add(listener),
      removeListener: (listener: () => void) => listeners.delete(listener),
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      dispatchEvent: () => false,
    } as unknown as MediaQueryList
    vi.stubGlobal('matchMedia', () => media)
    return {
      setMatches(next: boolean) {
        matches = next
        act(() => {
          for (const listener of listeners) listener()
        })
      },
    }
  }

  it('shows shared sample text and conceptual fidelity note', () => {
    render(<ExpressionPreview item={makeItem()} />)
    expect(screen.getByText(EXPRESSION_PREVIEW_SAMPLE_TEXT)).toBeVisible()
    expect(screen.getByText('概念見本')).toBeVisible()
    expect(screen.getAllByText(/公式実装の再現ではありません|概念見本/).length).toBeGreaterThan(0)
    expect(screen.getByRole('figure').getAttribute('aria-label')).toMatch(/TSUGITE 継ぎ手/)
  })

  it('includes listContextLabel in figure aria-label so recommend vs list stay distinct', () => {
    const { rerender } = render(
      <ExpressionPreview item={makeItem({ title: 'Typewriter' })} listContextLabel="一覧" />,
    )
    expect(screen.getByRole('figure').getAttribute('aria-label')).toMatch(/^一覧のTypewriterの見本/)
    // 操作 button の既存文脈名は維持
    expect(screen.getByRole('button', { name: /一覧のTypewriterの見本を/ })).toBeVisible()

    rerender(
      <ExpressionPreview item={makeItem({ title: 'Typewriter' })} listContextLabel="絞り込んだ候補" />,
    )
    expect(screen.getByRole('figure').getAttribute('aria-label')).toMatch(/^絞り込んだ候補のTypewriterの見本/)
    expect(screen.getByRole('button', { name: /絞り込んだ候補のTypewriterの見本を/ })).toBeVisible()
  })

  it('marks presentation presets as conceptual samples, not composition overview', () => {
    render(
      <ExpressionPreview
        item={makeItem({
          key: 'presentation-preset::remotion::article-dialogue-16x9',
          provider: 'remotion',
          nativeId: 'article-dialogue-16x9',
          title: '横型・会話で解説',
          role: 'full-composition',
          source: 'presentation-preset',
          previewFidelity: 'composition-storyboard',
          capability: 'declared-executable-candidate',
          availability: 'declared-available',
          tags: ['presentation-preset'],
        })}
      />,
    )
    expect(screen.getByText('概念見本')).toBeVisible()
    expect(screen.queryByText('構成の概略')).not.toBeInTheDocument()
    expect(screen.getByText(/候補名や説明から作った概念見本|実際の構成・動きの再現ではありません/)).toBeTruthy()
  })

  it('exposes unique play/pause accessible names including the title', async () => {
    const user = userEvent.setup()
    render(<ExpressionPreview item={makeItem({ title: 'Typewriter' })} />)

    const playButton = screen.getByRole('button', { name: /Typewriterの見本を/ })
    expect(playButton).toBeVisible()
    const pressedBefore = playButton.getAttribute('aria-pressed')
    await user.click(playButton)
    expect(playButton.getAttribute('aria-pressed')).not.toBe(pressedBefore)
    // name stays unique with title
    expect(screen.getByRole('button', { name: /Typewriterの見本を/ })).toBeVisible()
  })

  it('plays only an observer-confirmed visible card and pauses CSS off-screen without losing phase', () => {
    stubIntersectionObserver()
    render(
      <>
        <ExpressionPreview item={makeItem({ nativeId: 'first', title: 'First' })} />
        <ExpressionPreview item={makeItem({ nativeId: 'second', title: 'Second' })} />
      </>,
    )

    const stages = document.querySelectorAll('.launcher-expression-preview-stage')
    expect(stages).toHaveLength(2)
    expect(stages[0]?.getAttribute('data-playing')).toBe('false')
    expect(stages[1]?.getAttribute('data-playing')).toBe('false')

    fireVisibility(stages[0]!, true)
    expect(stages[0]?.getAttribute('data-playing')).toBe('true')
    expect(stages[0]?.getAttribute('data-phase')).toBe('playing')
    expect(stages[1]?.getAttribute('data-playing')).toBe('false')

    fireVisibility(stages[0]!, false)
    expect(stages[0]?.getAttribute('data-playing')).toBe('false')
    expect(stages[0]?.getAttribute('data-phase')).toBe('playing')

    fireVisibility(stages[1]!, true)
    expect(stages[0]?.getAttribute('data-playing')).toBe('false')
    expect(stages[1]?.getAttribute('data-playing')).toBe('true')
  })

  it('keeps one active preview when two cards are visible and explicit play changes the winner', async () => {
    const user = userEvent.setup()
    stubIntersectionObserver()
    render(
      <>
        <ExpressionPreview item={makeItem({ nativeId: 'first', title: 'First' })} />
        <ExpressionPreview item={makeItem({ nativeId: 'second', title: 'Second' })} />
      </>,
    )

    const stages = document.querySelectorAll('.launcher-expression-preview-stage')
    expect(stages).toHaveLength(2)

    fireVisibility(stages[0]!, true)
    fireVisibility(stages[1]!, true)
    expect(stages[0]?.getAttribute('data-playing')).toBe('false')
    expect(stages[1]?.getAttribute('data-playing')).toBe('true')

    await user.click(screen.getByRole('button', { name: 'Firstの見本を再生' }))
    expect(stages[0]?.getAttribute('data-playing')).toBe('true')
    expect(stages[1]?.getAttribute('data-playing')).toBe('false')
  })

  it('hands active preview back to the remaining visible card when the winner leaves', () => {
    stubIntersectionObserver()
    render(
      <>
        <ExpressionPreview item={makeItem({ nativeId: 'first', title: 'First' })} />
        <ExpressionPreview item={makeItem({ nativeId: 'second', title: 'Second' })} />
      </>,
    )

    const stages = document.querySelectorAll('.launcher-expression-preview-stage')
    expect(stages).toHaveLength(2)

    fireVisibility(stages[0]!, true)
    fireVisibility(stages[1]!, true)
    expect(stages[0]?.getAttribute('data-playing')).toBe('false')
    expect(stages[1]?.getAttribute('data-playing')).toBe('true')

    fireVisibility(stages[1]!, false)
    expect(stages[0]?.getAttribute('data-playing')).toBe('true')
    expect(stages[1]?.getAttribute('data-playing')).toBe('false')
  })

  it('ignores cursor animation iterations while the primary cycle is playing', () => {
    render(<ExpressionPreview item={makeItem()} />)
    const stage = document.querySelector('.launcher-expression-preview-stage')
    const cursor = stage?.querySelector('.launcher-expression-motion-cursor-el')
    expect(stage?.getAttribute('data-phase')).toBe('playing')
    expect(cursor).toBeTruthy()

    firePreviewAnimationIteration(cursor!)
    firePreviewAnimationIteration(stage!)

    expect(stage?.getAttribute('data-phase')).toBe('playing')
  })

  it('completes only on animationend from the explicit cycle-end target', () => {
    render(<ExpressionPreview item={makeItem()} />)
    const stage = document.querySelector('.launcher-expression-preview-stage')
    const cursor = stage?.querySelector('.launcher-expression-motion-cursor-el')
    const cycleEnd = stage?.querySelector('[data-preview-cycle-end="true"]')
    expect(cycleEnd).toBeTruthy()
    const expectedAnimation = cycleEnd?.getAttribute('data-preview-cycle-animation')
    expect(expectedAnimation).toBe('expr-typewriter')

    firePreviewAnimationEnd(cursor!, 'expr-cursor')
    expect(stage?.getAttribute('data-phase')).toBe('playing')

    firePreviewAnimationEnd(cycleEnd!, 'expr-cursor')
    expect(stage?.getAttribute('data-phase')).toBe('playing')

    firePreviewAnimationEnd(cycleEnd!, expectedAnimation!)
    expect(stage?.getAttribute('data-phase')).toBe('completed')
  })

  it.each([
    ['bars', '.launcher-expression-motion-bar-el'],
    ['stack', '.launcher-expression-motion-stack-card'],
    ['line-draw', '.launcher-expression-motion-line-el'],
  ] as const)('marks only the final %s stagger target as cycle-end', (family, selector) => {
    render(<ExpressionPreview item={makeItem({
      family,
      nativeId: family,
      title: family,
      description: family,
      category: family,
      tags: [family],
      features: [family],
    })} />)
    const stage = document.querySelector('.launcher-expression-preview-stage')
    const targets = Array.from(stage?.querySelectorAll(selector) ?? [])
    const cycleEnds = targets.filter((target) => target.getAttribute('data-preview-cycle-end') === 'true')
    expect(targets.length).toBeGreaterThan(1)
    expect(cycleEnds).toEqual([targets.at(-1)])
    const expectedAnimation = targets.at(-1)?.getAttribute('data-preview-cycle-animation')
    expect(expectedAnimation).toMatch(/^expr-/)

    firePreviewAnimationEnd(targets[0]!, expectedAnimation!)
    expect(stage?.getAttribute('data-phase')).toBe('playing')
    firePreviewAnimationEnd(targets.at(-1)!, 'expr-cursor')
    expect(stage?.getAttribute('data-phase')).toBe('playing')
    firePreviewAnimationEnd(targets.at(-1)!, expectedAnimation!)
    expect(stage?.getAttribute('data-phase')).toBe('completed')
  })

  it('remounts the motion subtree when replaying a completed preview', async () => {
    const user = userEvent.setup()
    render(<ExpressionPreview item={makeItem()} />)
    const stage = document.querySelector('.launcher-expression-preview-stage')
    const cycleEnd = stage?.querySelector('[data-preview-cycle-end="true"]')
    const before = stage?.querySelector('.launcher-expression-motion')
    expect(cycleEnd).toBeTruthy()
    expect(before).toBeTruthy()
    const expectedAnimation = cycleEnd?.getAttribute('data-preview-cycle-animation')
    expect(expectedAnimation).toBe('expr-typewriter')

    firePreviewAnimationEnd(cycleEnd!, expectedAnimation!)
    expect(stage?.getAttribute('data-phase')).toBe('completed')
    await user.click(screen.getByRole('button', { name: 'Typewriterの見本をもう一度再生' }))

    const after = stage?.querySelector('.launcher-expression-motion')
    expect(after).toBeTruthy()
    expect(after).not.toBe(before)
    expect(stage?.getAttribute('data-phase')).toBe('playing')
    expect(stage?.getAttribute('data-playing')).toBe('true')
  })

  it('points aria-controls at the stage id, not the caption', () => {
    render(<ExpressionPreview item={makeItem()} />)
    const playButton = screen.getByRole('button', { name: /Typewriterの見本を/ })
    const controlsId = playButton.getAttribute('aria-controls')
    expect(controlsId).toBeTruthy()
    const stage = document.getElementById(controlsId!)
    expect(stage).toBeTruthy()
    expect(stage?.classList.contains('launcher-expression-preview-stage')).toBe(true)
    const caption = document.querySelector('.launcher-expression-preview-caption')
    expect(caption).toBeTruthy()
    expect(caption?.id).toBeTruthy()
    expect(caption?.id).not.toBe(controlsId)
  })

  it('places figcaption as a direct figure child and links it via aria-describedby', () => {
    render(<ExpressionPreview item={makeItem()} />)
    const figure = screen.getByRole('figure')
    const caption = figure.querySelector(':scope > figcaption.launcher-expression-preview-caption')
    expect(caption).toBeTruthy()
    expect(caption?.parentElement).toBe(figure)
    expect(figure.querySelector('.launcher-expression-preview-toolbar figcaption')).toBeNull()
    const describedBy = figure.getAttribute('aria-describedby')
    expect(describedBy).toBe(caption?.id)
    expect(caption?.textContent).toMatch(/概念見本/)
    expect(caption?.textContent).toMatch(/公式実装の再現ではありません|実際の構成・動きの再現ではありません|概念見本/)
  })

  it('does not auto-play when prefers-reduced-motion is reduce', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }))

    render(<ExpressionPreview item={makeItem()} />)
    const stage = document.querySelector('.launcher-expression-preview-stage')
    expect(stage?.getAttribute('data-playing')).toBe('false')
    expect(screen.getByRole('button', { name: 'Typewriterの見本を再生' })).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('動きを抑える設定のため自動再生を停止中')
  })

  it('animates on explicit play even when prefers-reduced-motion is reduce', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }))

    render(<ExpressionPreview item={makeItem()} />)
    const stage = document.querySelector('.launcher-expression-preview-stage')
    expect(stage?.getAttribute('data-playing')).toBe('false')

    await user.click(screen.getByRole('button', { name: 'Typewriterの見本を再生' }))
    expect(stage?.getAttribute('data-playing')).toBe('true')
    expect(screen.getByRole('button', { name: 'Typewriterの見本を一時停止' })).toBeVisible()
  })

  it('returns a running preview to idle when reduced motion turns on and still allows explicit play', async () => {
    const user = userEvent.setup()
    const media = stubMutableReducedMotion(false)
    render(<ExpressionPreview item={makeItem()} />)
    const stage = document.querySelector('.launcher-expression-preview-stage')
    expect(stage?.getAttribute('data-phase')).toBe('playing')

    media.setMatches(true)
    expect(stage?.getAttribute('data-phase')).toBe('idle')
    expect(stage?.getAttribute('data-playing')).toBe('false')

    await user.click(screen.getByRole('button', { name: 'Typewriterの見本を再生' }))
    expect(stage?.getAttribute('data-phase')).toBe('playing')
    expect(stage?.getAttribute('data-playing')).toBe('true')
  })

  it('preserves an explicit stop when reduced motion is later disabled', async () => {
    const user = userEvent.setup()
    const media = stubMutableReducedMotion(true)
    render(<ExpressionPreview item={makeItem()} />)
    const stage = document.querySelector('.launcher-expression-preview-stage')
    expect(stage?.getAttribute('data-phase')).toBe('idle')

    await user.click(screen.getByRole('button', { name: 'Typewriterの見本を再生' }))
    expect(stage?.getAttribute('data-phase')).toBe('playing')

    await user.click(screen.getByRole('button', { name: 'Typewriterの見本を一時停止' }))
    expect(stage?.getAttribute('data-phase')).toBe('idle')

    media.setMatches(false)
    expect(stage?.getAttribute('data-phase')).toBe('idle')
    expect(stage?.getAttribute('data-playing')).toBe('false')
    expect(screen.getByRole('button', { name: 'Typewriterの見本を再生' })).toBeVisible()
  })

  it('keeps the playback phase when the preview leaves and re-enters the viewport', async () => {
    stubIntersectionObserver()
    const user = userEvent.setup()
    render(<ExpressionPreview item={makeItem()} />)
    const stage = document.querySelector('.launcher-expression-preview-stage')
    expect(stage).toBeTruthy()
    fireVisibility(stage!, true)

    // Exercise an explicit pause/play after visibility has been confirmed.
    const playButton = screen.getByRole('button', { name: /Typewriterの見本を/ })
    const wasPlaying = playButton.getAttribute('aria-pressed') === 'true'
    if (!wasPlaying) {
      await user.click(playButton)
    } else {
      // pause then play to set userPlaying explicitly true path
      await user.click(playButton)
      await user.click(playButton)
    }
    expect(stage?.getAttribute('data-playing')).toBe('true')

    fireVisibility(stage!, false)
    expect(stage?.getAttribute('data-playing')).toBe('false')
    expect(stage?.getAttribute('data-phase')).toBe('playing')

    fireVisibility(stage!, true)
    expect(stage?.getAttribute('data-playing')).toBe('true')
    expect(stage?.getAttribute('data-phase')).toBe('playing')
  })

  it('survives without matchMedia and IntersectionObserver', () => {
    const originalMatchMedia = window.matchMedia
    const originalIO = window.IntersectionObserver
    // @ts-expect-error intentional absence for environment parity
    delete window.matchMedia
    // @ts-expect-error intentional absence
    delete window.IntersectionObserver

    expect(() => render(<ExpressionPreview item={makeItem()} />)).not.toThrow()
    expect(screen.getByText(EXPRESSION_PREVIEW_SAMPLE_TEXT)).toBeVisible()

    window.matchMedia = originalMatchMedia
    window.IntersectionObserver = originalIO
  })
})
