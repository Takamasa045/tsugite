import { useCallback, useEffect, useId, useRef, useState } from 'react'

import type { TemplateVariant } from './templateShelfModel'

export interface TemplateAxisStepProps {
  variant: TemplateVariant
  selectedOptionId?: string
  onSelect: (optionId: string) => void
  onSkipWithDefaults: () => void
}

export function TemplateAxisStep({
  variant,
  selectedOptionId,
  onSelect,
  onSkipWithDefaults,
}: TemplateAxisStepProps) {
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [focusIndex, setFocusIndex] = useState(() => {
    const selected = variant.options.findIndex((option) => option.id === selectedOptionId)
    return selected >= 0 ? selected : 0
  })

  useEffect(() => {
    headingRef.current?.focus()
  }, [variant.id])

  useEffect(() => {
    const selected = variant.options.findIndex((option) => option.id === selectedOptionId)
    setFocusIndex(selected >= 0 ? selected : 0)
  }, [selectedOptionId, variant.options])

  const moveFocus = useCallback((nextIndex: number) => {
    const count = variant.options.length
    if (count === 0) return
    const normalized = ((nextIndex % count) + count) % count
    setFocusIndex(normalized)
    optionRefs.current[normalized]?.focus()
  }, [variant.options.length])

  return (
    <section
      aria-labelledby={headingId}
      className="launcher-template-axis-step"
    >
      <div className="launcher-template-axis-heading">
        <h2 id={headingId} ref={headingRef} tabIndex={-1}>{variant.label}</h2>
        <button
          className="launcher-secondary"
          onClick={onSkipWithDefaults}
          type="button"
        >
          おすすめのまま進む
        </button>
      </div>

      <div
        aria-labelledby={headingId}
        className="launcher-template-axis-options"
        role="group"
      >
        {variant.options.map((option, index) => {
          const selected = option.id === selectedOptionId
          const isDefault = option.id === variant.defaultOptionId
          const tabIndex = index === focusIndex ? 0 : -1

          return (
            <button
              aria-pressed={selected}
              className="launcher-template-axis-option"
              data-recommended={isDefault || undefined}
              key={option.id}
              onClick={() => onSelect(option.id)}
              onFocus={() => setFocusIndex(index)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                  event.preventDefault()
                  moveFocus(index + 1)
                } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  moveFocus(index - 1)
                } else if (event.key === 'Home') {
                  event.preventDefault()
                  moveFocus(0)
                } else if (event.key === 'End') {
                  event.preventDefault()
                  moveFocus(variant.options.length - 1)
                }
              }}
              ref={(node) => {
                optionRefs.current[index] = node
              }}
              tabIndex={tabIndex}
              type="button"
            >
              <span className="launcher-template-axis-option-topline">
                <strong>{option.label}</strong>
                {isDefault && <small>推奨</small>}
              </span>
              <span className="launcher-template-axis-option-description">{option.description}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
