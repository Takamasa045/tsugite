import { RoundedBox, useCursor } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { memo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { ThreeEvent } from '@react-three/fiber'
import type { Group, MeshStandardMaterial } from 'three'
import { MathUtils } from 'three'

import type { WorkflowNode } from '../../types/workflow'
import { NodeLabel } from './NodeLabel'
import { StatusEffect } from './StatusEffect'
import { STATUS_VISUALS } from './status-visuals'

interface WorkflowNode3DProps {
  node: WorkflowNode
  onFocus: (position: readonly [number, number, number]) => void
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
  materialRef: RefObject<MeshStandardMaterial | null>
  node: WorkflowNode
  selected: boolean
}

function NodeBody({ materialRef, node, selected }: NodeBodyProps) {
  const visual = STATUS_VISUALS[node.status]
  const woodColor = node.type === 'approval'
    ? '#8f6843'
    : node.type === 'agent'
      ? '#755239'
      : node.type === 'output'
        ? '#a57c50'
        : '#866140'
  const material = (
    <meshStandardMaterial
      ref={materialRef}
      color={woodColor}
      emissive={visual.color}
      emissiveIntensity={visual.emissiveIntensity * 0.44}
      metalness={0.05}
      opacity={node.status === 'skipped' ? 0.38 : 0.9}
      roughness={0.68}
      transparent
    />
  )

  if (node.type === 'task') {
    return (
      <RoundedBox
        args={[2.25, 0.9, 1.32]}
        castShadow={selected}
        radius={0.14}
        smoothness={3}
      >
        {material}
      </RoundedBox>
    )
  }

  return (
    <mesh castShadow={selected}>
      <NodeGeometry type={node.type} />
      {material}
    </mesh>
  )
}

export const WorkflowNode3D = memo(function WorkflowNode3D({
  node,
  onFocus,
  onSelect,
  position,
  reducedMotion,
  selected,
}: WorkflowNode3DProps) {
  const groupRef = useRef<Group>(null)
  const materialRef = useRef<MeshStandardMaterial>(null)
  const [hovered, setHovered] = useState(false)
  const visual = STATUS_VISUALS[node.status]
  useCursor(hovered, 'pointer', 'auto')

  useFrame(({ clock }, delta) => {
    if (!groupRef.current || !materialRef.current) return

    const ambientPulse =
      !reducedMotion && (node.status === 'thinking' || node.status === 'queued')
        ? Math.sin(clock.getElapsedTime() * 2) * 0.035
        : 0
    const desiredScale = (selected ? 1.12 : hovered ? 1.06 : 1) + ambientPulse
    const nextScale = MathUtils.damp(groupRef.current.scale.x, desiredScale, 9, delta)
    groupRef.current.scale.setScalar(nextScale)

    if (reducedMotion) {
      materialRef.current.emissiveIntensity = visual.emissiveIntensity * 0.44
      return
    }

    const warningPulse =
      node.status === 'error' || node.status === 'waiting_approval'
        ? (Math.sin(clock.getElapsedTime() * 5) + 1) * 0.2
        : 0
    materialRef.current.emissiveIntensity = visual.emissiveIntensity * 0.44 + warningPulse
  })

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation()
    onSelect(node.id)
  }

  const handleDoubleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation()
    onSelect(node.id)
    onFocus(position)
  }

  return (
    <group
      ref={groupRef}
      position={position}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onPointerOut={() => setHovered(false)}
      onPointerOver={(event) => {
        event.stopPropagation()
        setHovered(true)
      }}
    >
      <NodeBody materialRef={materialRef} node={node} selected={selected} />
      <mesh scale={selected ? 1.1 : 1.03}>
        <NodeGeometry type={node.type} />
        <meshBasicMaterial
          color={selected ? '#f0dfbd' : visual.color}
          transparent
          opacity={selected ? 0.28 : 0.1}
          wireframe
        />
      </mesh>
      <StatusEffect color={visual.color} reducedMotion={reducedMotion} status={node.status} />
      <NodeLabel node={node} onSelect={onSelect} selected={selected} />
    </group>
  )
})
