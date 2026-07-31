import type { ExpressionPreviewSpec, PreviewMotionFamily } from './expressionPreviewSpec'

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
        <span className="launcher-expression-motion-orbit-dot" />
        <span className="launcher-expression-motion-text">{text}</span>
      </div>
    )
  }

  if (family === 'line-draw') {
    return (
      <div className="launcher-expression-motion launcher-expression-motion-line-draw">
        <span className="launcher-expression-motion-line-el" />
        <span className="launcher-expression-motion-line-el is-second" />
        <span className="launcher-expression-motion-text">{text}</span>
      </div>
    )
  }

  if (family === 'typewriter') {
    return (
      <div className="launcher-expression-motion launcher-expression-motion-typewriter">
        <span className="launcher-expression-motion-text is-typewriter">{text}</span>
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
      <span className="launcher-expression-motion-text">{text}</span>
      {family === 'wipe' && <span className="launcher-expression-motion-wipe-veil" />}
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
