import { RoundedBox, useCursor } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { memo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { ThreeEvent } from '@react-three/fiber'
import type { Group, MeshStandardMaterial } from 'three'
import { MathUtils } from 'three'

import type { WorkflowNode } from '../../types/workflow'
import { AgentWorker3D } from './AgentWorker3D'
import { getAgentWorkerDepartureProgress, shouldShowAgentWorker } from './agent-activity'
import { NodeLabel } from './NodeLabel'
import { StatusEffect } from './StatusEffect'
import { STATUS_VISUALS } from './status-visuals'

interface WorkflowNode3DProps {
  currentTime: number
  featured: boolean
  focusMode: boolean
  labelRaised: boolean
  node: WorkflowNode
  onSelect: (nodeId: string) => void
  position: readonly [number, number, number]
  reducedMotion: boolean
  selected: boolean
}

function NodeGeometry({ type }: Pick<WorkflowNode, 'type'>) {
  if (type === 'agent') return <cylinderGeometry args={[0.86, 0.86, 1.25, 6]} />
  if (type === 'approval') return <octahedronGeometry args={[0.92, 0]} />
  if (type === 'output') return <boxGeometry args={[2.6, 1.15, 1.55]} />
  if (type === 'group') return <boxGeometry args={[2.8, 0.32, 1.8]} />
  return <boxGeometry args={[2.25, 0.9, 1.32, 2, 2, 2]} />
}

interface NodeBodyProps {
  featured: boolean
  materialRef: RefObject<MeshStandardMaterial | null>
  node: WorkflowNode
  selected: boolean
}

function NodeBody({ featured, materialRef, node, selected }: NodeBodyProps) {
  const visual = STATUS_VISUALS[node.status]
  const woodColor = node.type === 'approval'
    ? '#a85d32'
    : node.type === 'agent'
      ? '#4b382f'
      : node.type === 'output'
        ? '#b18a59'
        : '#81532f'
  const material = (
    <meshStandardMaterial
      ref={materialRef}
      color={woodColor}
      emissive={visual.color}
      emissiveIntensity={visual.emissiveIntensity * (featured ? 0.28 : 0.14)}
      metalness={node.type === 'approval' ? 0.12 : 0.035}
      opacity={node.status === 'skipped' ? 0.38 : 0.96}
      roughness={node.type === 'approval' ? 0.42 : 0.62}
      transparent
    />
  )

  if (node.type === 'task') {
    return (
      <RoundedBox
        args={[2.25, 0.9, 1.32]}
        castShadow={selected || featured}
        radius={0.14}
        smoothness={3}
      >
        {material}
      </RoundedBox>
    )
  }

  return (
    <mesh castShadow={selected || featured}>
      <NodeGeometry type={node.type} />
      {material}
    </mesh>
  )
}

function NodeJoineryDetails({
  color,
  featured,
  type,
}: {
  color: string
  featured: boolean
  type: WorkflowNode['type']
}) {
  const baseY = type === 'approval' ? -0.98 : type === 'agent' ? -0.72 : -0.58
  const topY = type === 'approval' ? 1.02 : type === 'agent' ? 0.74 : 0.54
  const tenonX = type === 'output' ? 1.38 : 1.2

  return (
    <group>
      <mesh position={[0, baseY, 0]}>
        <cylinderGeometry args={[0.5, 0.66, 0.18, 8]} />
        <meshStandardMaterial color="#261d18" metalness={0.06} roughness={0.78} />
      </mesh>
      <mesh position={[0, baseY + 0.1, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.52, 0.025, 6, 32]} />
        <meshBasicMaterial color={featured ? '#e0bd78' : color} transparent opacity={0.8} />
      </mesh>
      <mesh position={[0, topY, 0]}>
        <cylinderGeometry args={[0.09, 0.12, 0.24, 8]} />
        <meshStandardMaterial color="#c5a15e" metalness={0.64} roughness={0.28} />
      </mesh>
      {type === 'task' || type === 'output' ? (
        <group>
          <mesh position={[0, topY - 0.12, 0]}>
            <boxGeometry args={[1.14, 0.035, 0.68]} />
            <meshStandardMaterial
              color="#d8b875"
              emissive={color}
              emissiveIntensity={featured ? 0.48 : 0.16}
              metalness={0.03}
              roughness={0.72}
            />
          </mesh>
          {[-1, 1].map((direction) => (
            <group key={direction} position={[tenonX * direction, 0, 0]}>
              <mesh castShadow>
                <boxGeometry args={[0.34, 0.27, 0.5]} />
                <meshStandardMaterial color="#b77c45" roughness={0.76} />
              </mesh>
              <mesh position={[0, 0, 0.27]} rotation={[Math.PI / 2, 0, 0]}>
                <torusGeometry args={[0.12, 0.018, 5, 24]} />
                <meshBasicMaterial color="#56331f" transparent opacity={0.82} />
              </mesh>
            </group>
          ))}
          {[-0.56, 0.56].map((offset) => (
            <mesh key={offset} position={[offset, -0.43, 0.69]} rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.055, 0.055, 0.11, 10]} />
              <meshStandardMaterial color="#d8bd88" roughness={0.7} />
            </mesh>
          ))}
        </group>
      ) : null}
      {featured ? <pointLight color="#f0d7a4" distance={4.2} intensity={2.6} position={[0, 1.4, 0.8]} /> : null}
    </group>
  )
}

export const WorkflowNode3D = memo(function WorkflowNode3D({
  currentTime,
  featured,
  focusMode,
  labelRaised,
  node,
  onSelect,
  position,
  reducedMotion,
  selected,
}: WorkflowNode3DProps) {
  const groupRef = useRef<Group>(null)
  const materialRef = useRef<MeshStandardMaterial>(null)
  const [hovered, setHovered] = useState(false)
  const visual = STATUS_VISUALS[node.status]
  const workerVisible = shouldShowAgentWorker(node)
  const departureProgress = getAgentWorkerDepartureProgress(node, currentTime)
  const workerPresent = workerVisible || departureProgress !== null
  useCursor(hovered, 'pointer', 'auto')

  useFrame(({ clock }, delta) => {
    if (!groupRef.current || !materialRef.current) return

    const ambientPulse =
      !reducedMotion && (node.status === 'thinking' || node.status === 'queued')
        ? Math.sin(clock.getElapsedTime() * 2) * 0.035
        : 0
    const desiredScale = (selected ? 1.16 : featured ? 1.1 : hovered ? 1.06 : 1) + ambientPulse
    const nextScale = MathUtils.damp(groupRef.current.scale.x, desiredScale, 9, delta)
    groupRef.current.scale.setScalar(nextScale)

    if (reducedMotion) {
      materialRef.current.emissiveIntensity = visual.emissiveIntensity * 0.16
      return
    }

    const warningPulse =
      node.status === 'error' || node.status === 'waiting_approval'
        ? (Math.sin(clock.getElapsedTime() * 5) + 1) * 0.1
        : 0
    materialRef.current.emissiveIntensity = visual.emissiveIntensity * 0.18 + warningPulse
  })

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation()
    onSelect(node.id)
  }

  return (
    <group
      ref={groupRef}
      position={position}
      onClick={handleClick}
      onPointerOut={() => setHovered(false)}
      onPointerOver={(event) => {
        event.stopPropagation()
        setHovered(true)
      }}
    >
      <NodeBody featured={featured} materialRef={materialRef} node={node} selected={selected} />
      <NodeJoineryDetails color={visual.color} featured={featured} type={node.type} />
      <AgentWorker3D
        active={workerPresent}
        color={visual.color}
        departureProgress={departureProgress}
        featured={featured}
        nodeId={node.id}
        reducedMotion={reducedMotion}
        status={node.status}
      />
      <mesh scale={selected ? 1.12 : featured ? 1.08 : 1.03}>
        <NodeGeometry type={node.type} />
        <meshBasicMaterial
          color={selected || featured ? '#f0dfbd' : visual.color}
          transparent
          opacity={selected ? 0.22 : featured ? 0.12 : 0.06}
          wireframe
        />
      </mesh>
      <StatusEffect color={visual.color} reducedMotion={reducedMotion} status={node.status} />
      <NodeLabel
        featured={featured}
        muted={focusMode && !selected}
        node={node}
        onSelect={onSelect}
        raised={labelRaised}
        selected={selected}
        workerPresent={workerPresent}
      />
    </group>
  )
})
