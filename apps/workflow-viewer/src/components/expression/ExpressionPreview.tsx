import { Pause, Play } from 'lucide-react'
import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react'

import type { ExpressionItem } from './expressionLibraryModel'
import { previewFidelityLabel } from './expressionLibraryModel'
import {
  buildExpressionPreviewSpec,
  EXPRESSION_PREVIEW_SAMPLE_TEXT,
  previewSpecCssVars,
} from './expressionPreviewSpec'
import { PreviewMotionBody } from './ExpressionPreviewMotions'

export interface ExpressionPreviewProps {
  item: Pick<
    ExpressionItem,
    | 'nativeId'
    | 'title'
    | 'description'
    | 'tags'
    | 'role'
    | 'category'
    | 'previewFidelity'
    | 'source'
    | 'aspect'
    | 'features'
    | 'pace'
    | 'tone'
    | 'family'
  >
  compact?: boolean
  /** Optional accessible-name context (e.g. 推薦 / 一覧) to disambiguate duplicates. */
  listContextLabel?: string
}

type PreviewPhase = 'idle' | 'playing' | 'completed'

/** Shared IntersectionObserver — one per document, not one per card. */
let sharedObserver: IntersectionObserver | null = null
const observedTargets = new WeakMap<Element, (visible: boolean) => void>()

function getSharedObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          observedTargets.get(entry.target)?.(entry.isIntersecting)
        }
      },
      { root: null, rootMargin: '48px 0px', threshold: 0.05 },
    )
  }
  return sharedObserver
}

/** Shared prefers-reduced-motion media query — one subscription, not one per card. */
let sharedReducedMedia: MediaQueryList | null = null
let sharedReducedNotify: (() => void) | null = null
const reducedMotionListeners = new Set<() => void>()
let activePreviewStop: (() => void) | null = null

function getSharedReducedMedia(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null
  }
  if (!sharedReducedMedia) {
    sharedReducedMedia = window.matchMedia('(prefers-reduced-motion: reduce)')
    sharedReducedNotify = () => {
      for (const listener of reducedMotionListeners) listener()
    }
    if (typeof sharedReducedMedia.addEventListener === 'function') {
      sharedReducedMedia.addEventListener('change', sharedReducedNotify)
    } else {
      // Safari < 14
      sharedReducedMedia.addListener(sharedReducedNotify)
    }
  }
  return sharedReducedMedia
}

/** テスト隔離用。本番 UI からは呼ばない。 */
export function resetExpressionPreviewSharedStateForTests(): void {
  if (sharedObserver) {
    sharedObserver.disconnect()
    sharedObserver = null
  }
  if (sharedReducedMedia && sharedReducedNotify) {
    if (typeof sharedReducedMedia.removeEventListener === 'function') {
      sharedReducedMedia.removeEventListener('change', sharedReducedNotify)
    } else {
      sharedReducedMedia.removeListener(sharedReducedNotify)
    }
  }
  sharedReducedMedia = null
  sharedReducedNotify = null
  reducedMotionListeners.clear()
  activePreviewStop = null
}

function subscribeReducedMotion(onChange: () => void): () => void {
  reducedMotionListeners.add(onChange)
  // Ensure the shared media is wired even if this is the first subscriber.
  getSharedReducedMedia()
  return () => {
    reducedMotionListeners.delete(onChange)
  }
}

function getReducedMotionSnapshot(): boolean {
  return getSharedReducedMedia()?.matches ?? false
}

function getReducedMotionServerSnapshot(): boolean {
  return false
}

/**
 * Conceptual motion sample for an expression card.
 * Never claims to be a real render or official catalog implementation.
 */
function ExpressionPreviewComponent({
  item,
  compact = false,
  listContextLabel,
}: ExpressionPreviewProps) {
  const reactId = useId()
  const stageId = `${reactId}-stage`
  const captionId = `${reactId}-caption`
  const stageRef = useRef<HTMLDivElement | null>(null)
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot,
  )
  const [inView, setInView] = useState(false)
  const [phase, setPhase] = useState<PreviewPhase>('idle')
  const [hasAutoplayed, setHasAutoplayed] = useState(false)
  const [playbackRun, setPlaybackRun] = useState(0)
  const previousReducedMotion = useRef(reducedMotion)

  const spec = useMemo(() => buildExpressionPreviewSpec(item), [
    item.nativeId,
    item.title,
    item.description,
    item.role,
    item.source,
    item.previewFidelity,
    item.aspect,
    item.category,
    item.family,
    item.tags,
    item.features,
    item.pace,
    item.tone,
  ])
  const cssVars = useMemo(() => previewSpecCssVars(spec), [spec])

  useEffect(() => {
    const wasReduced = previousReducedMotion.current
    previousReducedMotion.current = reducedMotion
    if (!wasReduced && reducedMotion) {
      setPhase((current) => current === 'playing' ? 'idle' : current)
    }
  }, [reducedMotion])

  // Visibility starts the preview once; it must not reset a frame while scrolling.
  useEffect(() => {
    if (!inView || hasAutoplayed || reducedMotion) return
    setHasAutoplayed(true)
    setPhase('playing')
  }, [hasAutoplayed, inView, reducedMotion])

  const logicallyPlaying = phase === 'playing'
  const playing = logicallyPlaying && inView

  // Keep the shelf legible: only one preview may animate at a time.
  useEffect(() => {
    if (!playing) return
    const stop = () => setPhase('idle')
    activePreviewStop?.()
    activePreviewStop = stop
    return () => {
      if (activePreviewStop === stop) activePreviewStop = null
    }
  }, [playing])

  useEffect(() => {
    const node = stageRef.current
    if (!node) return
    const observer = getSharedObserver()
    if (!observer) {
      setInView(true)
      return
    }
    observedTargets.set(node, setInView)
    observer.observe(node)
    return () => {
      observer.unobserve(node)
      observedTargets.delete(node)
    }
  }, [])

  const fidelityLabel = previewFidelityLabel(spec.fidelity)
  const contextPrefix = listContextLabel ? `${listContextLabel}の` : ''
  const playLabel = logicallyPlaying
    ? `${contextPrefix}${item.title}の見本を一時停止`
    : phase === 'completed'
      ? `${contextPrefix}${item.title}の見本をもう一度再生`
      : `${contextPrefix}${item.title}の見本を再生`
  // figure 名にも listContext を含め、推薦と一覧で同 item が並んでも区別する
  const stageLabel = `${contextPrefix}${item.title}の見本。共通文字「${EXPRESSION_PREVIEW_SAMPLE_TEXT}」。${spec.familyLabel}。${spec.fidelityNote}`

  return (
    <figure
      aria-describedby={captionId}
      aria-label={stageLabel}
      className={compact
        ? 'launcher-expression-preview is-compact'
        : 'launcher-expression-preview'}
      data-family={spec.family}
      data-fidelity={spec.fidelity}
      data-playing={playing ? 'true' : 'false'}
      data-phase={phase}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      data-source={spec.source}
      style={cssVars as CSSProperties}
    >
      <div
        ref={stageRef}
        aria-hidden="true"
        className="launcher-expression-preview-stage"
        data-axis={cssVars['--expr-preview-axis']}
        data-direction={spec.direction}
        data-family={spec.family}
        data-playing={playing ? 'true' : 'false'}
        data-phase={phase}
        id={stageId}
        onAnimationEnd={(event) => {
          if (phase !== 'playing') return
          if (!(event.target instanceof HTMLElement)) return
          if (event.target.dataset.previewCycleEnd !== 'true') return
          const expectedAnimation = event.target.dataset.previewCycleAnimation
          if (!expectedAnimation || event.animationName !== expectedAnimation) return
          setPhase('completed')
        }}
      >
        <PreviewMotionBody key={playbackRun} spec={spec} />
      </div>
      <div className="launcher-expression-preview-toolbar">
        <button
          aria-controls={stageId}
          aria-label={playLabel}
          aria-pressed={logicallyPlaying}
          className="launcher-expression-preview-toggle"
          onClick={() => {
            if (phase === 'playing') {
              setPhase('idle')
              return
            }
            setHasAutoplayed(true)
            if (phase === 'completed') {
              setPlaybackRun((current) => current + 1)
            }
            setPhase('playing')
          }}
          type="button"
        >
          {logicallyPlaying
            ? <Pause aria-hidden="true" size={14} />
            : <Play aria-hidden="true" size={14} />}
          <span>{logicallyPlaying ? '一時停止' : '再生'}</span>
        </button>
        {reducedMotion && (
          <small role="status">動きを抑える設定のため自動再生を停止中。再生ボタンで確認できます。</small>
        )}
      </div>
      {/* figcaption must be a direct child of figure (not inside toolbar div).
          fidelityLabel already carries the conceptual / non-reproduction note. */}
      <figcaption className="launcher-expression-preview-caption" id={captionId}>
        <b>概念見本</b>
        <small>{spec.familyLabel}</small>
        <small>{fidelityLabel}</small>
        {item.aspect && item.aspect !== 'unknown' && <small>{item.aspect}</small>}
      </figcaption>
    </figure>
  )
}

function previewPropsEqual(
  prev: ExpressionPreviewProps,
  next: ExpressionPreviewProps,
): boolean {
  if (prev.compact !== next.compact) return false
  if (prev.listContextLabel !== next.listContextLabel) return false
  const a = prev.item
  const b = next.item
  return a.nativeId === b.nativeId
    && a.title === b.title
    && a.description === b.description
    && a.role === b.role
    && a.source === b.source
    && a.previewFidelity === b.previewFidelity
    && a.aspect === b.aspect
    && a.category === b.category
    && a.family === b.family
    && a.tags === b.tags
    && a.features === b.features
    && a.pace === b.pace
    && a.tone === b.tone
}

export const ExpressionPreview = memo(ExpressionPreviewComponent, previewPropsEqual)
