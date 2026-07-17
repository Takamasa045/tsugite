import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import type { Group, Mesh, MeshStandardMaterial } from 'three'
import { MathUtils } from 'three'

import type { WorkflowStatus } from '../../types/workflow'
import { getAgentActivity } from './agent-activity'

interface AgentWorker3DProps {
  active: boolean
  color: string
  departureProgress: number | null
  featured: boolean
  nodeId: string
  reducedMotion: boolean
  status: WorkflowStatus
}

function getPhaseOffset(value: string): number {
  return [...value].reduce((total, character) => total + character.charCodeAt(0), 0) * 0.17
}

export function AgentWorker3D({
  active,
  color,
  departureProgress,
  featured,
  nodeId,
  reducedMotion,
  status,
}: AgentWorker3DProps) {
  const rootRef = useRef<Group>(null)
  const headRef = useRef<Group>(null)
  const leftArmRef = useRef<Group>(null)
  const rightArmRef = useRef<Group>(null)
  const toolRef = useRef<Group>(null)
  const malletRef = useRef<Group>(null)
  const motesRef = useRef<Group>(null)
  const scanRef = useRef<Mesh>(null)
  const presenceRingRef = useRef<Mesh>(null)
  const presenceRingMaterialRef = useRef<MeshStandardMaterial>(null)
  const presenceRef = useRef(reducedMotion && active ? 1 : 0)
  const activity = useMemo(
    () => getAgentActivity(status, reducedMotion),
    [reducedMotion, status],
  )
  const phaseOffset = useMemo(() => getPhaseOffset(nodeId), [nodeId])
  const opacity = 0.96

  useFrame(({ clock }, delta) => {
    const root = rootRef.current
    const head = headRef.current
    const leftArm = leftArmRef.current
    const rightArm = rightArmRef.current
    if (!root || !head || !leftArm || !rightArm) return

    const elapsed = clock.getElapsedTime()
    const speed = 0.9 + activity.intensity * 2.1
    const phase = elapsed * speed + phaseOffset
    const wave = activity.animated ? Math.sin(phase) : 0
    const softWave = activity.animated ? Math.sin(phase * 0.55) : 0
    const departurePresence = departureProgress === null
      ? null
      : departureProgress < 0.72
        ? 1
        : Math.max(0, (1 - departureProgress) / 0.28)
    const targetPresence = departurePresence ?? (active ? 1 : 0)
    const presence = reducedMotion
      ? targetPresence
      : MathUtils.damp(presenceRef.current, targetPresence, active ? 7.5 : 3.6, delta)
    presenceRef.current = presence
    root.visible = active || presence > 0.015

    const baseScale = featured ? 0.98 : 0.86
    const transitionArc = Math.sin(Math.min(1, presence) * Math.PI)
    root.scale.setScalar(Math.max(0.001, baseScale * presence))

    root.position.y =
      0.64
      - (1 - presence) * 0.32
      + (active ? transitionArc * 0.09 : 0)
      + softWave * 0.025 * activity.intensity
    root.rotation.set(0, 0, 0)
    head.rotation.set(0, 0, 0)
    leftArm.rotation.set(-0.12, 0, -0.18)
    rightArm.rotation.set(-0.12, 0, 0.18)

    if (activity.mode === 'think') {
      head.rotation.y = softWave * 0.38
      head.rotation.z = wave * 0.06
      rightArm.rotation.x = -0.8 + wave * 0.08
      rightArm.rotation.z = 0.48
    } else if (activity.mode === 'craft') {
      root.rotation.z = softWave * 0.025
      leftArm.rotation.x = -0.72 - wave * 0.48
      leftArm.rotation.z = -0.24
      rightArm.rotation.x = -0.82 + wave * 0.58
      rightArm.rotation.z = 0.22
    } else if (activity.mode === 'inspect') {
      head.rotation.y = softWave * (activity.scan ? 0.42 : 0.18)
      head.rotation.x = -0.12 + wave * 0.035
      rightArm.rotation.x = -0.72 + wave * 0.12
      rightArm.rotation.z = 0.38
    } else if (activity.mode === 'signal') {
      head.rotation.y = softWave * 0.12
      rightArm.rotation.x = -0.22
      rightArm.rotation.z = 2.42 + wave * 0.08
    } else if (activity.mode === 'recover') {
      root.rotation.z = -0.08 + softWave * 0.025
      head.rotation.z = 0.16
      leftArm.rotation.x = -0.9 + wave * 0.15
      rightArm.rotation.x = -0.52 - wave * 0.15
    }

    if (departureProgress !== null) {
      const bow = Math.sin(departureProgress * Math.PI)
      root.rotation.x = bow * 0.42
      head.rotation.x = bow * 0.86
      leftArm.rotation.x = -0.32 - bow * 0.38
      rightArm.rotation.x = -0.32 - bow * 0.38
      leftArm.rotation.z = -0.28 + bow * 0.18
      rightArm.rotation.z = 0.28 - bow * 0.18
    }

    if (toolRef.current) {
      toolRef.current.rotation.z = activity.mode === 'craft' ? -0.28 + wave * 0.2 : 0
      toolRef.current.position.y = activity.mode === 'craft' ? 0.74 + wave * 0.06 : 0.7
    }
    if (malletRef.current) {
      malletRef.current.rotation.z = 0.3 - wave * 0.26
      malletRef.current.position.y = 0.78 - wave * 0.06
    }
    if (motesRef.current) {
      motesRef.current.rotation.y = activity.animated ? elapsed * (0.55 + activity.intensity) : 0
      motesRef.current.rotation.z = softWave * 0.2
    }
    if (scanRef.current) {
      scanRef.current.position.x = activity.animated ? wave * 0.55 : 0
      scanRef.current.scale.x = 0.8 + Math.abs(softWave) * 0.24
    }
    if (presenceRingRef.current && presenceRingMaterialRef.current) {
      presenceRingRef.current.scale.setScalar(0.72 + transitionArc * 0.72)
      presenceRingMaterialRef.current.opacity = reducedMotion ? 0 : transitionArc * 0.58
    }
  })

  return (
    <group ref={rootRef} position={[0, 0.64, 0.28]} scale={0.001}>
      <mesh ref={presenceRingRef} position={[0, 0.03, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.56, 0.035, 6, 40]} />
        <meshStandardMaterial
          ref={presenceRingMaterialRef}
          color="#b47b42"
          depthWrite={false}
          metalness={0.02}
          opacity={0}
          roughness={0.78}
          transparent
        />
      </mesh>
      <group>
        <mesh position={[-0.13, 0.24, 0]} castShadow>
          <boxGeometry args={[0.17, 0.48, 0.18]} />
          <meshStandardMaterial color="#243942" opacity={opacity} roughness={0.7} transparent />
        </mesh>
        <mesh position={[0.13, 0.24, 0]} castShadow>
          <boxGeometry args={[0.17, 0.48, 0.18]} />
          <meshStandardMaterial color="#243942" opacity={opacity} roughness={0.7} transparent />
        </mesh>
        {[-0.13, 0.13].map((offset) => (
          <mesh key={offset} position={[offset, -0.055, 0.08]} castShadow>
            <boxGeometry args={[0.2, 0.1, 0.3]} />
            <meshStandardMaterial color="#e8dfcc" opacity={opacity} roughness={0.82} transparent />
          </mesh>
        ))}
        <mesh position={[0, 0.6, 0]}>
          <boxGeometry args={[0.68, 0.11, 0.32]} />
          <meshStandardMaterial color="#182c31" opacity={opacity} roughness={0.74} transparent />
        </mesh>
        <mesh position={[0, 0.82, 0]} castShadow>
          <cylinderGeometry args={[0.3, 0.38, 0.72, 6]} />
          <meshStandardMaterial
            color="#294d55"
            emissive={color}
            emissiveIntensity={featured ? 0.22 : 0.09}
            metalness={0.04}
            opacity={opacity}
            roughness={0.58}
            transparent
          />
        </mesh>
        <mesh position={[0, 0.76, 0.3]}>
          <boxGeometry args={[0.46, 0.48, 0.035]} />
          <meshStandardMaterial color="#8f5d37" opacity={opacity} roughness={0.76} transparent />
        </mesh>
        {[-1, 1].map((direction) => (
          <mesh
            key={direction}
            position={[0.09 * direction, 0.96, 0.31]}
            rotation={[0, 0, 0.5 * direction]}
          >
            <boxGeometry args={[0.075, 0.48, 0.026]} />
            <meshStandardMaterial color="#d2b982" opacity={opacity} roughness={0.78} transparent />
          </mesh>
        ))}
      </group>

      <group ref={headRef} position={[0, 1.4, 0]}>
        <mesh castShadow>
          <icosahedronGeometry args={[0.25, 1]} />
          <meshStandardMaterial color="#d8bd91" opacity={opacity} roughness={0.72} transparent />
        </mesh>
        <mesh position={[0, 0.21, 0]}>
          <cylinderGeometry args={[0.2, 0.25, 0.13, 8]} />
          <meshStandardMaterial color="#172b31" opacity={opacity} roughness={0.72} transparent />
        </mesh>
        <mesh position={[0, 0.065, 0.205]}>
          <boxGeometry args={[0.52, 0.075, 0.075]} />
          <meshStandardMaterial color="#eee2c9" opacity={opacity} roughness={0.82} transparent />
        </mesh>
        {[-1, 1].map((direction) => (
          <mesh
            key={direction}
            position={[0.13 * direction, -0.03, -0.22]}
            rotation={[0.12, 0, 0.38 * direction]}
          >
            <boxGeometry args={[0.07, 0.34, 0.035]} />
            <meshStandardMaterial color="#eee2c9" opacity={opacity} roughness={0.82} transparent />
          </mesh>
        ))}
      </group>

      <group ref={leftArmRef} position={[-0.34, 1.04, 0]}>
        <mesh position={[0, -0.28, 0]} castShadow>
          <cylinderGeometry args={[0.075, 0.09, 0.56, 6]} />
          <meshStandardMaterial color="#294d55" opacity={opacity} roughness={0.66} transparent />
        </mesh>
        <mesh position={[0, -0.58, 0]}>
          <sphereGeometry args={[0.095, 8, 6]} />
          <meshStandardMaterial color="#d8bd91" opacity={opacity} roughness={0.72} transparent />
        </mesh>
      </group>
      <group ref={rightArmRef} position={[0.34, 1.04, 0]}>
        <mesh position={[0, -0.28, 0]} castShadow>
          <cylinderGeometry args={[0.075, 0.09, 0.56, 6]} />
          <meshStandardMaterial color="#294d55" opacity={opacity} roughness={0.66} transparent />
        </mesh>
        <mesh position={[0, -0.58, 0]}>
          <sphereGeometry args={[0.095, 8, 6]} />
          <meshStandardMaterial color="#d8bd91" opacity={opacity} roughness={0.72} transparent />
        </mesh>
      </group>

      {activity.tool === 'chisel' ? (
        <>
          <group ref={toolRef} position={[0.43, 0.74, 0.42]} rotation={[0.18, 0, -0.28]}>
            <mesh>
              <cylinderGeometry args={[0.035, 0.045, 0.72, 6]} />
              <meshStandardMaterial color="#6d472c" roughness={0.72} />
            </mesh>
            <mesh position={[0, -0.37, 0]}>
              <boxGeometry args={[0.13, 0.18, 0.055]} />
              <meshStandardMaterial color="#a9a49a" metalness={0.32} roughness={0.48} />
            </mesh>
          </group>
          <group ref={malletRef} position={[-0.43, 0.78, 0.4]} rotation={[0.12, 0, 0.3]}>
            <mesh>
              <cylinderGeometry args={[0.035, 0.045, 0.58, 7]} />
              <meshStandardMaterial color="#765039" roughness={0.8} />
            </mesh>
            <mesh position={[0, -0.31, 0]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.12, 0.14, 0.34, 8]} />
              <meshStandardMaterial color="#b98652" roughness={0.84} />
            </mesh>
          </group>
          <group position={[0, 0.08, 0.62]}>
            {[-0.34, 0.08, 0.38].map((offset, index) => (
              <mesh key={offset} position={[offset, 0, index % 2 === 0 ? 0.04 : -0.04]} rotation={[0, index * 0.7, 0.3]}>
                <boxGeometry args={[0.2, 0.025, 0.055]} />
                <meshStandardMaterial color="#d2b982" roughness={0.88} />
              </mesh>
            ))}
          </group>
        </>
      ) : null}

      {activity.tool === 'lantern' ? (
        <group ref={toolRef} position={[0.46, 0.7, 0.36]}>
          <mesh>
            <cylinderGeometry args={[0.13, 0.13, 0.25, 8]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={1.1}
              opacity={0.82}
              transparent
            />
          </mesh>
          <pointLight color={color} distance={2.4} intensity={3.2} />
        </group>
      ) : null}

      {activity.motes ? (
        <group ref={motesRef} position={[0, 1.52, 0]}>
          {[
            [-0.44, 0.1, 0],
            [0.22, 0.42, 0.12],
            [0.45, -0.05, -0.08],
          ].map((position, index) => (
            <mesh key={index} position={position as [number, number, number]}>
              <sphereGeometry args={[0.045 + index * 0.01, 8, 6]} />
              <meshBasicMaterial color={color} transparent opacity={0.72} />
            </mesh>
          ))}
        </group>
      ) : null}

      {activity.scan ? (
        <mesh ref={scanRef} position={[0, 0.38, 0.72]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[1.2, 0.26]} />
          <meshBasicMaterial color={color} depthWrite={false} opacity={0.26} transparent />
        </mesh>
      ) : null}
    </group>
  )
}
