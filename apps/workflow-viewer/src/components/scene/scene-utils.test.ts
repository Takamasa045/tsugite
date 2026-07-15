import { describe, expect, it } from 'vitest'

import {
  createPresentationPositions,
  getEdgeVisualState,
  getPosition,
  getSceneBounds,
  getSceneFitDistance,
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

  it('長い工程列を中央へ寄せ、木組みのような浅い前後差を付ける', () => {
    const positions = createPresentationPositions({
      first: { x: 0, y: 0, z: 0 },
      second: { x: 5, y: 0, z: 0 },
      third: { x: 10, y: 0, z: 0 },
      fourth: { x: 15, y: 0, z: 0 },
      fifth: { x: 20, y: 0, z: 0 },
      sixth: { x: 25, y: 0, z: 0 },
      seventh: { x: 30, y: 0, z: 0 },
    })

    expect(positions.first[0]).toBeCloseTo(6)
    expect(positions.seventh[0]).toBeCloseTo(24)
    expect(positions.first[2]).not.toBe(positions.second[2])
    expect(getSceneBounds(positions).radius).toBeLessThan(getSceneBounds({
      first: [0, 0, 0],
      seventh: [30, 0, 0],
    }).radius)
  })

  it('短い工程や既存の並列配置は変形しない', () => {
    expect(createPresentationPositions({
      first: { x: 0, y: 0, z: -1.5 },
      second: { x: 5, y: 0, z: 1.5 },
    })).toEqual({
      first: [0, 0, -1.5],
      second: [5, 0, 1.5],
    })
  })

  it('横幅が狭い画面では全工程が切れないようカメラを遠ざける', () => {
    const positions = {
      first: [0, 0, 0] as const,
      last: [21, 0, 0] as const,
    }

    const narrow = getSceneFitDistance(positions, 1.05, 42)
    const wide = getSceneFitDistance(positions, 1.8, 42)
    expect(narrow).toBeGreaterThan(25)
    expect(narrow).toBeGreaterThan(wide)
  })

  it('derives edge visuals from both endpoint states', () => {
    expect(getEdgeVisualState('completed', 'completed')).toBe('completed')
    expect(getEdgeVisualState('completed', 'running')).toBe('active')
    expect(getEdgeVisualState('error', 'pending')).toBe('error')
    expect(getEdgeVisualState('pending', 'queued')).toBe('ready')
    expect(getEdgeVisualState('pending', 'pending')).toBe('inactive')
  })
})
