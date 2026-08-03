import type { ExpressionPreviewSpec, PreviewMotionFamily } from './expressionPreviewSpec'

const CYCLE_ANIMATION_BY_FAMILY: Record<PreviewMotionFamily, string> = {
  bars: 'expr-bars',
  fade: 'expr-fade',
  glitch: 'expr-glitch-main',
  'line-draw': 'expr-line-draw',
  orbit: 'expr-orbit-dot',
  pulse: 'expr-pulse',
  rotate: 'expr-rotate',
  scale: 'expr-scale',
  slide: 'expr-slide-y',
  stack: 'expr-stack',
  typewriter: 'expr-typewriter',
  wipe: 'expr-wipe',
}

function cycleAnimationName(spec: ExpressionPreviewSpec): string {
  if (spec.family === 'slide' && (spec.direction === 'left' || spec.direction === 'right')) {
    return 'expr-slide-x'
  }
  return CYCLE_ANIMATION_BY_FAMILY[spec.family]
}

/**
 * Pure presentational motion markup for expression previews.
 * Playback / observer / reduced-motion contracts stay in ExpressionPreview.
 * Do not change family markup, TSUGITE sample text placement, CSS classes, or aria-hidden.
 */
export function PreviewMotionBody({ spec }: { spec: ExpressionPreviewSpec }) {
  const text = spec.sampleText
  const family = spec.family

  if (family === 'bars') {
    return (
      <div className="launcher-expression-motion launcher-expression-motion-bars">
        {[0, 1, 2, 3].map((index) => (
          <span
            className="launcher-expression-motion-bar-el"
            data-preview-cycle-animation={index === 3 ? cycleAnimationName(spec) : undefined}
            data-preview-cycle-end={index === 3 ? 'true' : undefined}
            key={index}
            style={{ animationDelay: `calc(var(--expr-preview-delay) + ${index} * var(--expr-preview-stagger))` }}
          />
        ))}
        <span className="launcher-expression-motion-text is-caption">{text}</span>
      </div>
    )
  }

  if (family === 'stack') {
    return (
      <div className="launcher-expression-motion launcher-expression-motion-stack">
        {[0, 1, 2].map((index) => (
          <span
            className="launcher-expression-motion-stack-card"
            data-preview-cycle-animation={index === 2 ? cycleAnimationName(spec) : undefined}
            data-preview-cycle-end={index === 2 ? 'true' : undefined}
            key={index}
            style={{
              animationDelay: `calc(var(--expr-preview-delay) + ${index} * var(--expr-preview-stagger))`,
              // Per-card offsets survive keyframes via CSS variables.
              ['--expr-stack-x' as string]: index === 0 ? '-10px' : index === 2 ? '10px' : '0px',
              ['--expr-stack-y' as string]: index === 0 ? '-8px' : index === 2 ? '8px' : '0px',
              ['--expr-stack-scale' as string]: index === 1 ? '1' : '0.92',
              ['--expr-stack-opacity' as string]: index === 1 ? '1' : '0.55',
            }}
          >
            {index === 1 ? text : '·'}
          </span>
        ))}
      </div>
    )
  }

  if (family === 'orbit') {
    return (
      <div className="launcher-expression-motion launcher-expression-motion-orbit">
        <span className="launcher-expression-motion-orbit-ring" />
        <span
          className="launcher-expression-motion-orbit-dot"
          data-preview-cycle-animation={cycleAnimationName(spec)}
          data-preview-cycle-end="true"
        />
        <span className="launcher-expression-motion-text">{text}</span>
      </div>
    )
  }

  if (family === 'line-draw') {
    return (
      <div className="launcher-expression-motion launcher-expression-motion-line-draw">
        <span className="launcher-expression-motion-line-el" />
        <span
          className="launcher-expression-motion-line-el is-second"
          data-preview-cycle-animation={cycleAnimationName(spec)}
          data-preview-cycle-end="true"
        />
        <span className="launcher-expression-motion-text">{text}</span>
      </div>
    )
  }

  if (family === 'typewriter') {
    return (
      <div className="launcher-expression-motion launcher-expression-motion-typewriter">
        <span
          className="launcher-expression-motion-text is-typewriter"
          data-preview-cycle-animation={cycleAnimationName(spec)}
          data-preview-cycle-end="true"
        >
          {text}
        </span>
        <span className="launcher-expression-motion-cursor-el" />
      </div>
    )
  }

  // fade / slide / wipe / scale / rotate / pulse / glitch share a text shell
  return (
    <div
      className={`launcher-expression-motion launcher-expression-motion-${familyCss(family)}`}
      data-direction={spec.direction}
    >
      <span
        className="launcher-expression-motion-text"
        data-preview-cycle-animation={family === 'wipe' ? undefined : cycleAnimationName(spec)}
        data-preview-cycle-end={family === 'wipe' ? undefined : 'true'}
      >
        {text}
      </span>
      {family === 'wipe' && (
        <span
          className="launcher-expression-motion-wipe-veil"
          data-preview-cycle-animation={cycleAnimationName(spec)}
          data-preview-cycle-end="true"
        />
      )}
      {family === 'glitch' && (
        <>
          <span aria-hidden="true" className="launcher-expression-motion-text is-glitch-a">{text}</span>
          <span aria-hidden="true" className="launcher-expression-motion-text is-glitch-b">{text}</span>
        </>
      )}
    </div>
  )
}

function familyCss(family: PreviewMotionFamily): string {
  return family === 'line-draw' ? 'line-draw' : family
}
