import { describe, expect, it } from 'vitest'

import {
  getEdgeVisualState,
  getPosition,
  getSceneBounds,
  toVectorTuple,
} from './scene-utils'

describe('scene-utils', () => {
  it('supports tuple and object positions', () => {
    expect(toVectorTuple([1, 2, 3])).toEqual([1, 2, 3])
    expect(toVectorTuple({ x: 4, y: 5, z: 6 })).toEqual([4, 5, 6])
  })

  it('reads positions from records and maps', () => {
    expect(getPosition({ plan: [1, 0, 2] }, 'plan')).toEqual([1, 0, 2])
    expect(getPosition(new Map([['plan', { x: 3, y: 1, z: -2 }]]), 'plan')).toEqual([
      3,
      1,
      -2,
    ])
    expect(getPosition({}, 'missing')).toBeNull()
  })

  it('calculates a stable center and radius for camera fitting', () => {
    const bounds = getSceneBounds({
      first: [-5, 0, -2],
      second: [5, 2, 2],
    })
    expect(bounds.center).toEqual([0, 1, 0])
    expect(bounds.radius).toBeCloseTo(Math.sqrt(30))
    expect(getSceneBounds({})).toEqual({ center: [0, 0, 0], radius: 4 })
  })

  it('derives edge visuals from both endpoint states', () => {
    expect(getEdgeVisualState('completed', 'completed')).toBe('completed')
    expect(getEdgeVisualState('completed', 'running')).toBe('active')
    expect(getEdgeVisualState('error', 'pending')).toBe('error')
    expect(getEdgeVisualState('pending', 'queued')).toBe('ready')
    expect(getEdgeVisualState('pending', 'pending')).toBe('inactive')
  })
})
