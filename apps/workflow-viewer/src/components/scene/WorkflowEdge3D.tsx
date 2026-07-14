import { Line } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { memo, useMemo, useRef } from 'react'
import type { Mesh } from 'three'
import { Quaternion, Vector3 } from 'three'

import type { WorkflowStatus } from '../../types/workflow'
import { getEdgeVisualState } from './scene-utils'

interface WorkflowEdge3DProps {
  reducedMotion: boolean
  source: readonly [number, number, number]
  sourceStatus: WorkflowStatus
  target: readonly [number, number, number]
  targetStatus: WorkflowStatus
}

const EDGE_COLORS = {
  active: '#a98db0',
  completed: '#719a72',
  error: '#c45d4f',
  inactive: '#4a3b2e',
  ready: '#6f9b8d',
} as const

export const WorkflowEdge3D = memo(function WorkflowEdge3D({
  reducedMotion,
  source,
  sourceStatus,
  target,
  targetStatus,
}: WorkflowEdge3DProps) {
  const pulseRef = useRef<Mesh>(null)
  const state = getEdgeVisualState(sourceStatus, targetStatus)
  const color = EDGE_COLORS[state]
  const { arrowPosition, arrowQuaternion, end, start } = useMemo(() => {
    const startVector = new Vector3(...source)
    const endVector = new Vector3(...target)
    const direction = endVector.clone().sub(startVector)
    const length = direction.length()
    if (length > 0.001) direction.normalize()
    else direction.set(1, 0, 0)

    const insetStart = startVector.clone().addScaledVector(direction, Math.min(0.9, length * 0.2))
    const insetEnd = endVector.clone().addScaledVector(direction, -Math.min(1, length * 0.2))
    const arrow = insetEnd.clone().addScaledVector(direction, -0.12)
    const quaternion = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction)

    return {
      arrowPosition: arrow.toArray(),
      arrowQuaternion: quaternion,
      end: insetEnd.toArray(),
      start: insetStart.toArray(),
    }
  }, [source, target])

  useFrame(({ clock }) => {
    if (!pulseRef.current || reducedMotion || state !== 'active') return
    const progress = (clock.getElapsedTime() * 0.38) % 1
    pulseRef.current.position.set(
      start[0] + (end[0] - start[0]) * progress,
      start[1] + (end[1] - start[1]) * progress,
      start[2] + (end[2] - start[2]) * progress,
    )
  })

  return (
    <group>
      <Line
        color="#39291d"
        lineWidth={3}
        opacity={0.72}
        points={[start, end]}
        transparent
      />
      <Line
        color={color}
        dashed={state === 'inactive'}
        dashScale={1.8}
        dashSize={0.18}
        gapSize={0.14}
        lineWidth={state === 'active' ? 2 : 1}
        opacity={state === 'inactive' ? 0.42 : 0.86}
        points={[start, end]}
        transparent
      />
      <mesh position={arrowPosition} quaternion={arrowQuaternion}>
        <coneGeometry args={[0.1, 0.32, 7]} />
        <meshBasicMaterial color={color} transparent opacity={state === 'inactive' ? 0.38 : 0.9} />
      </mesh>
      {state === 'active' ? (
        <mesh ref={pulseRef} position={start}>
          <sphereGeometry args={[0.1, 10, 8]} />
          <meshBasicMaterial color="#f5f3ff" />
          <pointLight color={color} distance={1.7} intensity={1.2} />
        </mesh>
      ) : null}
    </group>
  )
})
