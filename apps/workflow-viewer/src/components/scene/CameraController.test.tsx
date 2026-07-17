import { act, cleanup, render } from '@testing-library/react'
import { PerspectiveCamera, Vector3 } from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CameraController } from './CameraController'

const harness = vi.hoisted(() => ({
  controls: null as null | { target: unknown; update: () => void },
  frame: null as null | ((state: unknown, delta: number) => void),
  orbitProps: null as null | Record<string, unknown>,
  threeState: null as null | { camera: unknown; size: { height: number; width: number } },
}))

vi.mock('@react-three/fiber', () => ({
  useFrame: (callback: (state: unknown, delta: number) => void) => {
    harness.frame = callback
  },
  useThree: (selector: (state: unknown) => unknown) => selector(harness.threeState),
}))

vi.mock('@react-three/drei', async () => {
  const React = await import('react')
  const { Vector3: MockVector3 } = await import('three')
  const OrbitControls = React.forwardRef(function MockOrbitControls(
    props: Record<string, unknown>,
    ref: React.ForwardedRef<{ target: InstanceType<typeof MockVector3>; update: () => void }>,
  ) {
    const controls = React.useMemo(() => ({ target: new MockVector3(), update: () => undefined }), [])
    harness.controls = controls
    harness.orbitProps = props
    React.useImperativeHandle(ref, () => controls, [controls])
    return React.createElement('div', { 'data-testid': 'orbit-controls' })
  })

  return { OrbitControls }
})

beforeEach(() => {
  const camera = new PerspectiveCamera(42, 16 / 9, 0.1, 140)
  camera.position.set(0, 7, 16)
  harness.controls = null
  harness.frame = null
  harness.orbitProps = null
  harness.threeState = { camera, size: { height: 900, width: 1600 } }
})

afterEach(cleanup)

describe('CameraController', () => {
  it('カーソル位置へのズームと工程単体まで寄れる距離をOrbitControlsへ渡す', () => {
    render(<CameraController focusRequest={null} positions={{ center: [0, 0, 0] }} sceneKey="sample" />)

    expect(harness.orbitProps?.zoomToCursor).toBe(true)
    expect(harness.orbitProps?.enableZoom).toBe(true)
    expect(harness.orbitProps?.minDistance).toBeLessThanOrEqual(1.8)
  })

  it('工程IDのフォーカス要求を、その工程を中心とするカメラ移動へ変換する', () => {
    const camera = harness.threeState?.camera as PerspectiveCamera
    render(
      <CameraController
        focusRequest={{ nodeId: 'right-node', nonce: 1 }}
        positions={{ 'left-node': [-4, 0, 0], 'right-node': [5, 1, -1] }}
        sceneKey="sample"
      />,
    )

    act(() => {
      for (let index = 0; index < 4; index += 1) harness.frame?.({}, 1)
    })

    const target = harness.controls?.target as Vector3
    expect(target.toArray()).toEqual([5, 1.55, -1])
    expect(camera.position.distanceTo(target)).toBeCloseTo(6.2, 1)
  })
})
