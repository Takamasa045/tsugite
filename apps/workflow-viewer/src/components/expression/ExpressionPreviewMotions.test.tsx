import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { PreviewMotionBody } from './ExpressionPreviewMotions'
import {
  EXPRESSION_PREVIEW_SAMPLE_TEXT,
  type ExpressionPreviewSpec,
  type PreviewMotionFamily,
} from './expressionPreviewSpec'

function makeSpec(family: PreviewMotionFamily): ExpressionPreviewSpec {
  return {
    signature: `test-${family}`,
    family,
    direction: 'up',
    distance: 12,
    delayMs: 0,
    durationMs: 900,
    staggerMs: 80,
    intensity: 0.6,
    sampleText: EXPRESSION_PREVIEW_SAMPLE_TEXT,
    fidelityNote: '概念見本',
    familyLabel: family,
    conceptualOnly: true,
    fidelity: 'motion-hint',
    source: 'reference-catalog',
    role: 'text-overlay',
    aspect: '16:9',
  }
}

const FAMILY_DOM: ReadonlyArray<{
  family: PreviewMotionFamily
  rootClass: string
  requiredSelectors: string[]
  minSampleText: number
  glitchAriaHidden?: boolean
}> = [
  {
    family: 'fade',
    rootClass: 'launcher-expression-motion-fade',
    requiredSelectors: ['.launcher-expression-motion-text'],
    minSampleText: 1,
  },
  {
    family: 'slide',
    rootClass: 'launcher-expression-motion-slide',
    requiredSelectors: ['.launcher-expression-motion-text'],
    minSampleText: 1,
  },
  {
    family: 'wipe',
    rootClass: 'launcher-expression-motion-wipe',
    requiredSelectors: [
      '.launcher-expression-motion-text',
      '.launcher-expression-motion-wipe-veil',
    ],
    minSampleText: 1,
  },
  {
    family: 'scale',
    rootClass: 'launcher-expression-motion-scale',
    requiredSelectors: ['.launcher-expression-motion-text'],
    minSampleText: 1,
  },
  {
    family: 'rotate',
    rootClass: 'launcher-expression-motion-rotate',
    requiredSelectors: ['.launcher-expression-motion-text'],
    minSampleText: 1,
  },
  {
    family: 'pulse',
    rootClass: 'launcher-expression-motion-pulse',
    requiredSelectors: ['.launcher-expression-motion-text'],
    minSampleText: 1,
  },
  {
    family: 'glitch',
    rootClass: 'launcher-expression-motion-glitch',
    requiredSelectors: [
      '.launcher-expression-motion-text',
      '.launcher-expression-motion-text.is-glitch-a',
      '.launcher-expression-motion-text.is-glitch-b',
    ],
    minSampleText: 3,
    glitchAriaHidden: true,
  },
  {
    family: 'bars',
    rootClass: 'launcher-expression-motion-bars',
    requiredSelectors: [
      '.launcher-expression-motion-bar-el',
      '.launcher-expression-motion-text.is-caption',
    ],
    minSampleText: 1,
  },
  {
    family: 'stack',
    rootClass: 'launcher-expression-motion-stack',
    requiredSelectors: ['.launcher-expression-motion-stack-card'],
    minSampleText: 1,
  },
  {
    family: 'orbit',
    rootClass: 'launcher-expression-motion-orbit',
    requiredSelectors: [
      '.launcher-expression-motion-orbit-ring',
      '.launcher-expression-motion-orbit-dot',
      '.launcher-expression-motion-text',
    ],
    minSampleText: 1,
  },
  {
    family: 'line-draw',
    rootClass: 'launcher-expression-motion-line-draw',
    requiredSelectors: [
      '.launcher-expression-motion-line-el',
      '.launcher-expression-motion-line-el.is-second',
      '.launcher-expression-motion-text',
    ],
    minSampleText: 1,
  },
  {
    family: 'typewriter',
    rootClass: 'launcher-expression-motion-typewriter',
    requiredSelectors: [
      '.launcher-expression-motion-text.is-typewriter',
      '.launcher-expression-motion-cursor-el',
    ],
    minSampleText: 1,
  },
]

describe('PreviewMotionBody motion families (DOM contract)', () => {
  it('covers all 12 motion families', () => {
    expect(FAMILY_DOM.map((entry) => entry.family).sort()).toEqual([
      'bars',
      'fade',
      'glitch',
      'line-draw',
      'orbit',
      'pulse',
      'rotate',
      'scale',
      'slide',
      'stack',
      'typewriter',
      'wipe',
    ].sort())
  })

  it.each(FAMILY_DOM)(
    'renders $family with root class, required children, and sample text',
    ({ family, rootClass, requiredSelectors, minSampleText, glitchAriaHidden }) => {
      const { container } = render(<PreviewMotionBody spec={makeSpec(family)} />)
      const root = container.querySelector(`.launcher-expression-motion.${rootClass}`)
      expect(root).toBeTruthy()
      expect(root?.classList.contains('launcher-expression-motion')).toBe(true)
      expect(root?.classList.contains(rootClass)).toBe(true)

      for (const selector of requiredSelectors) {
        expect(container.querySelector(selector)).toBeTruthy()
      }

      const cycleEnds = container.querySelectorAll('[data-preview-cycle-end="true"]')
      expect(cycleEnds).toHaveLength(1)
      expect(cycleEnds[0]?.classList.contains('launcher-expression-motion-cursor-el')).toBe(false)
      expect(cycleEnds[0]?.getAttribute('data-preview-cycle-animation')).toMatch(/^expr-/)

      const sampleNodes = screen.getAllByText(EXPRESSION_PREVIEW_SAMPLE_TEXT)
      expect(sampleNodes.length).toBeGreaterThanOrEqual(minSampleText)

      if (glitchAriaHidden) {
        const glitchA = container.querySelector('.is-glitch-a')
        const glitchB = container.querySelector('.is-glitch-b')
        expect(glitchA?.getAttribute('aria-hidden')).toBe('true')
        expect(glitchB?.getAttribute('aria-hidden')).toBe('true')
      }

      // bars has 4 bars
      if (family === 'bars') {
        expect(container.querySelectorAll('.launcher-expression-motion-bar-el')).toHaveLength(4)
      }
      // stack has 3 cards
      if (family === 'stack') {
        expect(container.querySelectorAll('.launcher-expression-motion-stack-card')).toHaveLength(3)
      }
    },
  )
})
