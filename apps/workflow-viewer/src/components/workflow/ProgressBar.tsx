interface ProgressBarProps {
  value: number
  label: string
  showValue?: boolean
}

export function ProgressBar({ value, label, showValue = false }: ProgressBarProps) {
  const normalizedValue = Math.min(100, Math.max(0, Math.round(value)))

  return (
    <div className="progress-block">
      {showValue ? (
        <div className="progress-caption">
          <span>{label}</span>
          <strong>{normalizedValue}%</strong>
        </div>
      ) : null}
      <div
        aria-label={label}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={normalizedValue}
        className="progress-track"
        role="progressbar"
      >
        <span className="progress-fill" style={{ width: `${normalizedValue}%` }} />
      </div>
    </div>
  )
}
