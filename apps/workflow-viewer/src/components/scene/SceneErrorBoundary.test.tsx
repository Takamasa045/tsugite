import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SceneErrorBoundary } from './SceneErrorBoundary'

afterEach(() => vi.restoreAllMocks())

describe('SceneErrorBoundary', () => {
  it('catches scene errors without exposing the raw exception or stack', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onError = vi.fn()

    render(
      <SceneErrorBoundary
        fallback={<div data-testid="safe-scene-fallback">3Dを利用できません</div>}
        onError={onError}
      >
        <ThrowingScene />
      </SceneErrorBoundary>,
    )

    expect(screen.getByTestId('safe-scene-fallback')).toBeVisible()
    expect(onError).toHaveBeenCalledOnce()
    expect(screen.queryByText(/raw-secret|\/Users\/|stack trace/i)).not.toBeInTheDocument()
  })
})

function ThrowingScene(): never {
  throw new Error('raw-secret /Users/private/project stack trace')
}
