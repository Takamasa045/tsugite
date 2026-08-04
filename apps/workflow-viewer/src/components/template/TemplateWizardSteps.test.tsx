import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { LauncherTemplate, TemplateWizardState } from './templateShelfModel'
import { TemplateWizardSteps } from './TemplateWizardSteps'

const template = {
  id: 'blog-dialogue-60s',
  name: 'ブログ掛け合い 60秒',
  summary: 'summary',
  category: '記事を動画化',
  useCases: [],
  duration: '60秒',
  aspectRatio: '16:9',
  requiredInputs: [],
  requiredInputDetails: [],
  preview: { frames: [], flow: [] },
  notFor: [],
  variants: [
    {
      id: 'cast',
      label: 'キャラクター構成',
      defaultOptionId: 'beginner-expert',
      options: [
        { id: 'beginner-expert', label: '初心者×専門家', description: 'd' },
        { id: 'peers', label: '同僚同士', description: 'd' },
      ],
    },
  ],
  tags: [],
  audio: 'none',
  status: 'stable',
  distribution: 'bundled',
  valid: true,
} as LauncherTemplate

function stateAt(step: number): TemplateWizardState {
  return {
    step,
    templateId: template.id,
    choices: step > 1 ? { cast: 'peers' } : {},
    expressionSelections: [],
    expressionSelectionMode: 'unset',
  }
}

describe('TemplateWizardSteps soft-disable focus contract', () => {
  it('past step click keeps focus after that chip becomes current (aria-disabled, not native)', async () => {
    const user = userEvent.setup()
    let wizard = stateAt(2)
    const onGoToStep = vi.fn((step: number) => {
      wizard = stateAt(step)
      rerender(
        <TemplateWizardSteps
          template={template}
          state={wizard}
          onGoToStep={onGoToStep}
        />,
      )
    })

    const { rerender } = render(
      <TemplateWizardSteps
        template={template}
        state={wizard}
        onGoToStep={onGoToStep}
      />,
    )

    const pastVideo = screen.getByRole('button', { name: /動画/ })
    expect(pastVideo).not.toHaveAttribute('aria-disabled')
    pastVideo.focus()
    await user.click(pastVideo)

    expect(onGoToStep).toHaveBeenCalledWith(0)
    const currentVideo = screen.getByRole('button', { name: /動画/ })
    expect(currentVideo).toHaveAttribute('aria-current', 'step')
    expect(currentVideo).toHaveAttribute('aria-disabled', 'true')
    expect(currentVideo).not.toHaveAttribute('disabled')
    expect(currentVideo).toHaveAttribute('tabindex', '-1')
    expect(currentVideo).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)

    // Guard: current/future must not navigate
    await user.click(currentVideo)
    expect(onGoToStep).toHaveBeenCalledTimes(1)
  })

  it('future and current stay out of tab order; only past steps are tabbable', () => {
    render(
      <TemplateWizardSteps
        template={template}
        state={stateAt(1)}
        onGoToStep={vi.fn()}
      />,
    )
    const buttons = screen.getAllByRole('button')
    const past = buttons.filter((button) => button.getAttribute('tabindex') !== '-1')
    const blocked = buttons.filter((button) => button.getAttribute('tabindex') === '-1')
    expect(past.length).toBeGreaterThanOrEqual(1)
    expect(blocked.length).toBeGreaterThanOrEqual(1)
    for (const button of blocked) {
      expect(button).toHaveAttribute('aria-disabled', 'true')
      expect(button).not.toHaveAttribute('disabled')
    }
  })

  it('production source uses aria-disabled + tabIndex contract (no native disabled)', async () => {
    const source = await readComponentSource('src/components/template/TemplateWizardSteps.tsx')
    expect(source).toMatch(/aria-disabled=\{!canGo \|\| undefined\}/)
    expect(source).toMatch(/tabIndex=\{canGo \? 0 : -1\}/)
    expect(source).toMatch(/if \(!canGo\) return/)
    expect(source).not.toMatch(/disabled=\{!canGo\}/)
  })
})

async function readComponentSource(relativePath: string): Promise<string> {
  const nodeFs = 'node:fs'
  const nodePath = 'node:path'
  const fs = await import(/* @vite-ignore */ nodeFs) as {
    readFileSync: (path: string, encoding: string) => string
  }
  const path = await import(/* @vite-ignore */ nodePath) as {
    resolve: (...parts: string[]) => string
  }
  const cwd = (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.()
  if (!cwd) throw new Error('process.cwd is unavailable')
  return fs.readFileSync(path.resolve(cwd, relativePath), 'utf8')
}
