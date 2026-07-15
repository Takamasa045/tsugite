import { OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import type { ComponentRef } from 'react'
import { Vector3 } from 'three'

import type { NodePositions } from './scene-utils'
import { getSceneBounds, getSceneFitDistance } from './scene-utils'

export interface FocusRequest {
  nonce: number
  position: readonly [number, number, number]
}

interface CameraControllerProps {
  focusRequest: FocusRequest | null
  positions: NodePositions
  resetSignal?: unknown
  sceneKey: string
}

// Keep the workflow's X axis readable from left to right while retaining a
// shallow workshop-floor perspective.
const FIT_DIRECTION = new Vector3(0.18, 0.48, 1.55).normalize()

export function CameraController({
  focusRequest,
  positions,
  resetSignal,
  sceneKey,
}: CameraControllerProps) {
  const camera = useThree((state) => state.camera)
  const size = useThree((state) => state.size)
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null)
  const desiredPosition = useRef(new Vector3())
  const desiredTarget = useRef(new Vector3())
  const transitioning = useRef(false)
  const bounds = useMemo(() => getSceneBounds(positions), [positions])

  const fitView = () => {
    const center = new Vector3(...bounds.center)
    const aspectRatio = size.width / Math.max(1, size.height)
    const verticalFov = 'fov' in camera && typeof camera.fov === 'number' ? camera.fov : 42
    const distance = getSceneFitDistance(positions, aspectRatio, verticalFov)
    desiredTarget.current.copy(center)
    desiredPosition.current.copy(center).addScaledVector(FIT_DIRECTION, distance)
    transitioning.current = true
  }

  useEffect(() => {
    fitView()
    // `resetSignal` intentionally lets the parent replay the fit-view transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal, sceneKey, size.height, size.width])

  useEffect(() => {
    if (!focusRequest) return
    const target = new Vector3(...focusRequest.position)
    const currentDirection = camera.position.clone().sub(controlsRef.current?.target ?? target)
    if (currentDirection.lengthSq() < 0.01) currentDirection.copy(FIT_DIRECTION)
    currentDirection.normalize()
    desiredTarget.current.copy(target)
    desiredPosition.current.copy(target).addScaledVector(currentDirection, 6.4)
    transitioning.current = true
  }, [camera, focusRequest])

  useFrame((_, delta) => {
    const controls = controlsRef.current
    if (!controls || !transitioning.current) return

    const factor = 1 - Math.exp(-delta * 6)
    camera.position.lerp(desiredPosition.current, factor)
    controls.target.lerp(desiredTarget.current, factor)
    controls.update()

    if (
      camera.position.distanceToSquared(desiredPosition.current) < 0.002 &&
      controls.target.distanceToSquared(desiredTarget.current) < 0.002
    ) {
      camera.position.copy(desiredPosition.current)
      controls.target.copy(desiredTarget.current)
      controls.update()
      transitioning.current = false
    }
  })

  return (
    <OrbitControls
      ref={controlsRef}
      dampingFactor={0.08}
      enableDamping
      enablePan
      enableRotate
      enableZoom
      maxDistance={70}
      minDistance={3.5}
      onStart={() => {
        transitioning.current = false
      }}
      screenSpacePanning
    />
  )
}
