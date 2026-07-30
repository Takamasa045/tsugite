import type { ExpressionItem, PreviewFidelity } from './expressionLibraryModel'
import { previewFidelityLabel } from './expressionLibraryModel'

export interface ExpressionPreviewProps {
  item: Pick<ExpressionItem, 'role' | 'category' | 'title' | 'previewFidelity' | 'source' | 'aspect'>
  compact?: boolean
}

/**
 * Lightweight CSS/SVG motion hint or composition storyboard.
 * Never claims to be a real render/preview asset.
 */
export function ExpressionPreview({ item, compact = false }: ExpressionPreviewProps) {
  const fidelity: PreviewFidelity = item.previewFidelity
  const label = previewFidelityLabel(fidelity)
  const variant = item.source === 'presentation-preset'
    ? 'storyboard'
    : roleVariant(item.role)

  return (
    <figure
      aria-label={`${item.title}の${label}`}
      className={compact
        ? 'launcher-expression-preview is-compact'
        : 'launcher-expression-preview'}
      data-fidelity={fidelity}
      data-variant={variant}
    >
      <div aria-hidden="true" className="launcher-expression-preview-stage">
        {variant === 'storyboard' ? (
          <div className="launcher-expression-storyboard">
            <span className="launcher-expression-storyboard-frame" data-step="1" />
            <span className="launcher-expression-storyboard-frame" data-step="2" />
            <span className="launcher-expression-storyboard-frame" data-step="3" />
          </div>
        ) : (
          <svg className="launcher-expression-motion-svg" viewBox="0 0 120 68" role="presentation">
            <rect className="launcher-expression-motion-bg" height="68" rx="4" width="120" x="0" y="0" />
            {variant === 'data' && (
              <>
                <rect className="launcher-expression-motion-bar" height="18" width="12" x="18" y="36" />
                <rect className="launcher-expression-motion-bar" height="28" width="12" x="40" y="26" />
                <rect className="launcher-expression-motion-bar" height="36" width="12" x="62" y="18" />
                <rect className="launcher-expression-motion-bar" height="24" width="12" x="84" y="30" />
              </>
            )}
            {variant === 'text' && (
              <>
                <rect className="launcher-expression-motion-line" height="6" width="70" x="18" y="22" />
                <rect className="launcher-expression-motion-line is-late" height="6" width="52" x="18" y="34" />
                <rect className="launcher-expression-motion-cursor" height="14" width="3" x="74" y="18" />
              </>
            )}
            {variant === 'code' && (
              <>
                <rect className="launcher-expression-motion-line" height="4" width="48" x="16" y="16" />
                <rect className="launcher-expression-motion-line is-mid" height="4" width="64" x="16" y="28" />
                <rect className="launcher-expression-motion-line is-late" height="4" width="40" x="16" y="40" />
              </>
            )}
            {variant === 'transition' && (
              <>
                <rect className="launcher-expression-motion-panel" height="40" width="40" x="14" y="14" />
                <rect className="launcher-expression-motion-panel is-wipe" height="40" width="40" x="66" y="14" />
              </>
            )}
            {variant === 'shader' && (
              <>
                <circle className="launcher-expression-motion-orb" cx="60" cy="34" r="16" />
                <circle className="launcher-expression-motion-orb is-outer" cx="60" cy="34" r="24" />
              </>
            )}
            {variant === 'social' && (
              <>
                <rect className="launcher-expression-motion-chip" height="10" width="54" x="18" y="16" />
                <rect className="launcher-expression-motion-chip is-mid" height="10" width="42" x="18" y="30" />
                <rect className="launcher-expression-motion-chip is-late" height="10" width="48" x="18" y="44" />
              </>
            )}
            {(variant === 'aux' || variant === 'generic') && (
              <>
                <rect className="launcher-expression-motion-panel" height="36" width="70" x="25" y="16" />
                <rect className="launcher-expression-motion-line is-late" height="4" width="40" x="40" y="48" />
              </>
            )}
          </svg>
        )}
      </div>
      <figcaption className="launcher-expression-preview-caption">
        <b>{item.source === 'presentation-preset' ? '構成イメージ' : '動きの見本札'}</b>
        <small>{label}</small>
        {item.aspect && item.aspect !== 'unknown' && <small>{item.aspect}</small>}
      </figcaption>
    </figure>
  )
}

function roleVariant(role: ExpressionItem['role']): string {
  switch (role) {
    case 'data-viz':
      return 'data'
    case 'text-overlay':
      return 'text'
    case 'code-dev':
      return 'code'
    case 'transition':
      return 'transition'
    case '3d-shader':
      return 'shader'
    case 'social':
      return 'social'
    case 'auxiliary':
      return 'aux'
    case 'full-composition':
      return 'storyboard'
    default:
      return 'generic'
  }
}
