import { describe, expect, it, vi } from 'vitest'

import {
  reasonForSceneError,
  releaseWebglContext,
  shouldSurfaceContextLost,
} from './scene-state'

describe('scene-state context-loss guards', () => {
  it('maps failure phase to the public reason code', () => {
    expect(reasonForSceneError('initializing')).toBe('viewer.scene.initialization_failed')
    expect(reasonForSceneError('ready')).toBe('viewer.scene.runtime_error')
  })

  it('suppresses stale or disconnected webglcontextlost events', () => {
    expect(
      shouldSurfaceContextLost({
        canvasConnected: false,
        eventGeneration: 1,
        activeGeneration: 1,
        phase: 'ready',
      }),
    ).toBe(false)

    expect(
      shouldSurfaceContextLost({
        canvasConnected: true,
        eventGeneration: 1,
        activeGeneration: 2,
        phase: 'ready',
      }),
    ).toBe(false)

    expect(
      shouldSurfaceContextLost({
        canvasConnected: true,
        eventGeneration: 2,
        activeGeneration: 2,
        phase: 'degraded',
      }),
    ).toBe(false)

    expect(
      shouldSurfaceContextLost({
        canvasConnected: true,
        eventGeneration: 3,
        activeGeneration: 3,
        phase: 'ready',
      }),
    ).toBe(true)

    expect(
      shouldSurfaceContextLost({
        canvasConnected: true,
        eventGeneration: 3,
        activeGeneration: 3,
        phase: 'initializing',
      }),
    ).toBe(true)
  })

  it('releases probe WebGL contexts through WEBGL_lose_context', () => {
    const loseContext = vi.fn()
    const gl = {
      getExtension: vi.fn((name: string) => {
        expect(name).toBe('WEBGL_lose_context')
        return { loseContext }
      }),
    }

    releaseWebglContext(gl)
    expect(gl.getExtension).toHaveBeenCalledWith('WEBGL_lose_context')
    expect(loseContext).toHaveBeenCalledTimes(1)

    expect(() => releaseWebglContext(null)).not.toThrow()
    expect(() => releaseWebglContext(undefined)).not.toThrow()
    expect(() => releaseWebglContext({ getExtension: () => null })).not.toThrow()
  })
})
