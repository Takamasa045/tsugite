import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import type { Group, Mesh, MeshBasicMaterial } from 'three'

import type { WorkflowStatus } from '../../types/workflow'

interface StatusEffectProps {
  color: string
  reducedMotion: boolean
  status: WorkflowStatus
}

const RING_STATUSES = new Set<WorkflowStatus>([
  'running',
  'testing',
  'waiting_approval',
  'queued',
])

export function StatusEffect({ color, reducedMotion, status }: StatusEffectProps) {
  const ringRef = useRef<Group>(null)
  const haloRef = useRef<Mesh>(null)
  const haloMaterialRef = useRef<MeshBasicMaterial>(null)
  const hasRing = RING_STATUSES.has(status)
  const hasHalo = status === 'thinking' || status === 'error' || status === 'completed'

  useFrame(({ clock }, delta) => {
    if (reducedMotion) return

    const elapsed = clock.getElapsedTime()
    if (ringRef.current) {
      const direction = status === 'testing' ? -1 : 1
      ringRef.current.rotation.y += delta * direction * (status === 'running' ? 1.5 : 0.75)
      ringRef.current.rotation.z += delta * 0.22
    }

    if (haloRef.current && haloMaterialRef.current) {
      const speed = status === 'error' ? 5 : 1.7
      const pulse = (Math.sin(elapsed * speed) + 1) / 2
      const scale = 1 + pulse * (status === 'thinking' ? 0.18 : 0.08)
      haloRef.current.scale.setScalar(scale)
      haloMaterialRef.current.opacity = status === 'completed' ? 0.14 : 0.08 + pulse * 0.18
    }
  })

  return (
    <group>
      {hasRing ? (
        <group ref={ringRef} rotation={[Math.PI / 2, 0, 0]}>
          <mesh>
            <torusGeometry args={[1.25, 0.025, 8, 48]} />
            <meshBasicMaterial color={color} transparent opacity={0.58} />
          </mesh>
          <mesh rotation={[0.55, 0, 0]}>
            <torusGeometry args={[1.08, 0.012, 8, 40]} />
            <meshBasicMaterial color={color} transparent opacity={0.28} />
          </mesh>
        </group>
      ) : null}
      {hasHalo ? (
        <mesh ref={haloRef} scale={1.08}>
          <sphereGeometry args={[1.1, 20, 12]} />
          <meshBasicMaterial
            ref={haloMaterialRef}
            color={color}
            depthWrite={false}
            transparent
            opacity={status === 'completed' ? 0.14 : 0.12}
          />
        </mesh>
      ) : null}
    </group>
  )
}
