import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ExpressionCard } from './ExpressionCard'
import { ExpressionRecommendations } from './ExpressionRecommendations'
import {
  normalizePresentationPreset,
  type ExpressionSelection,
} from './expressionLibraryModel'
import type { RecommendationResult } from './expressionRecommendation'
import { LEXICON_VERSION } from './expressionRecommendation'

const sampleItem = normalizePresentationPreset({
  backend: 'remotion',
  backendLabel: 'Remotion',
  id: 'finish-soft-1',
  label: '仕上げ soft',
  description: 'desc',
  aspectRatio: '16:9',
})

const sampleSelection: ExpressionSelection = {
  key: sampleItem.key,
  provider: sampleItem.provider,
  nativeId: sampleItem.nativeId,
  title: sampleItem.title,
  description: sampleItem.description,
  tags: [...sampleItem.tags],
  features: [...sampleItem.features],
  role: sampleItem.role,
  capability: sampleItem.capability,
  previewFidelity: sampleItem.previewFidelity,
  reason: '合う',
  source: sampleItem.source,
}

describe('ExpressionCard / ExpressionRecommendations soft-disable focus', () => {
  it('selected ExpressionCard uses aria-disabled (not native) and keeps focus with no re-select', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const { rerender } = render(
      <ul>
        <ExpressionCard
          item={sampleItem}
          listContext="一覧"
          selected={false}
          selectReason="test"
          onSelect={onSelect}
        />
      </ul>,
    )

    const add = screen.getByRole('button', { name: '一覧の仕上げ softをコピー候補に追加' })
    add.focus()
    await user.click(add)
    expect(onSelect).toHaveBeenCalledTimes(1)

    rerender(
      <ul>
        <ExpressionCard
          item={sampleItem}
          listContext="一覧"
          selected
          selectReason="test"
          onSelect={onSelect}
        />
      </ul>,
    )

    const selected = screen.getByRole('button', { name: '一覧の仕上げ softは選択中' })
    expect(selected).toHaveAttribute('aria-disabled', 'true')
    expect(selected).not.toHaveAttribute('disabled')
    selected.focus()
    expect(selected).toHaveFocus()
    await user.click(selected)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(selected).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
  })

  it('selected ExpressionRecommendations button uses aria-disabled and guards re-select', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const recommendation: RecommendationResult = {
      recommendations: [{
        item: sampleItem,
        score: 90,
        band: 'recommend',
        reasons: ['合う'],
        cautions: [],
        executable: true,
        previewFidelity: sampleItem.previewFidelity,
      }],
      clarification: null,
      lexiconVersion: LEXICON_VERSION,
    }

    const { rerender } = render(
      <ExpressionRecommendations
        recommendation={recommendation}
        selections={[]}
        onSelect={onSelect}
      />,
    )

    const add = screen.getByRole('button', {
      name: '絞り込んだ候補の仕上げ softをコピー候補に追加',
    })
    await user.click(add)
    expect(onSelect).toHaveBeenCalledTimes(1)

    rerender(
      <ExpressionRecommendations
        recommendation={recommendation}
        selections={[sampleSelection]}
        onSelect={onSelect}
      />,
    )

    const selected = screen.getByRole('button', {
      name: '絞り込んだ候補の仕上げ softは選択中',
    })
    expect(selected).toHaveAttribute('aria-disabled', 'true')
    expect(selected).not.toHaveAttribute('disabled')
    selected.focus()
    await user.click(selected)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(selected).toHaveFocus()
  })

  it('production sources do not use dynamic native disabled for selected/loading soft-disable', async () => {
    const cardSource = await readComponentSource('src/components/expression/ExpressionCard.tsx')
    const recSource = await readComponentSource('src/components/expression/ExpressionRecommendations.tsx')
    expect(cardSource).toMatch(/aria-disabled=\{selected \|\| undefined\}/)
    expect(cardSource).not.toMatch(/disabled=\{selected\}/)
    expect(cardSource).toMatch(/if \(selected\) return/)
    expect(recSource).toMatch(/aria-disabled=\{selected \|\| undefined\}/)
    expect(recSource).not.toMatch(/disabled=\{selected\}/)
    expect(recSource).toMatch(/if \(selected\) return/)
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
