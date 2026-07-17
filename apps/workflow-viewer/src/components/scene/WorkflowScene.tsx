import { Canvas } from '@react-three/fiber'
import { useEffect, useMemo, useState } from 'react'

import type { WorkflowData, WorkflowNode } from '../../types/workflow'
import { CameraController } from './CameraController'
import type { FocusRequest } from './CameraController'
import { SceneEnvironment } from './SceneEnvironment'
import { WorkflowEdge3D } from './WorkflowEdge3D'
import { WorkflowNode3D } from './WorkflowNode3D'
import type { NodePositions } from './scene-utils'
import {
  createPresentationPositions,
  getPosition,
  getSceneBounds,
  getSceneFitDistance,
} from './scene-utils'

export interface WorkflowSceneProps {
  currentTime: number
  focusRequest?: FocusRequest | null
  focusNodeId?: string
  nodesAtTime?: readonly WorkflowNode[]
  onSelect: (nodeId: string | null) => void
  positions: NodePositions
  resetSignal?: unknown
  selectedNodeId: string | null
  workflow: WorkflowData
}

function useReducedMotion() {
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const updatePreference = () => setReducedMotion(query.matches)
    updatePreference()
    query.addEventListener('change', updatePreference)
    return () => query.removeEventListener('change', updatePreference)
  }, [])

  return reducedMotion
}

interface SceneContentProps extends WorkflowSceneProps {
  reducedMotion: boolean
}

function SceneContent({
  currentTime,
  focusRequest,
  focusNodeId,
  nodesAtTime,
  onSelect,
  positions,
  reducedMotion,
  resetSignal,
  selectedNodeId,
  workflow,
}: SceneContentProps) {
  const visibleNodes = nodesAtTime ?? workflow.nodes
  const nodeById = useMemo(
    () => new Map(visibleNodes.map((node) => [node.id, node])),
    [visibleNodes],
  )
  const floorY = useMemo(() => {
    const values = visibleNodes
      .map((node) => getPosition(positions, node.id)?.[1])
      .filter((value): value is number => value !== undefined)
    return (values.length > 0 ? Math.min(...values) : 0) - 1.35
  }, [positions, visibleNodes])
  const sceneBounds = useMemo(() => getSceneBounds(positions), [positions])

  return (
    <>
      <SceneEnvironment
        center={sceneBounds.center}
        floorY={floorY}
        onBackgroundClick={() => onSelect(null)}
        radius={sceneBounds.radius}
        reducedMotion={reducedMotion}
      />
      <group>
        {workflow.edges.map((edge) => {
          const sourceNode = nodeById.get(edge.source)
          const targetNode = nodeById.get(edge.target)
          const source = getPosition(positions, edge.source)
          const target = getPosition(positions, edge.target)
          if (!sourceNode || !targetNode || !source || !target) return null

          return (
            <WorkflowEdge3D
              key={edge.id}
              reducedMotion={reducedMotion}
              source={source}
              sourceStatus={sourceNode.status}
              target={target}
              targetStatus={targetNode.status}
            />
          )
        })}
      </group>
      <group>
        {visibleNodes.map((node, index) => {
          const position = getPosition(positions, node.id)
          if (!position) return null
          return (
            <WorkflowNode3D
              currentTime={currentTime}
              featured={node.id === focusNodeId}
              focusMode={selectedNodeId !== null}
              labelRaised={index % 2 === 1}
              key={node.id}
              node={node}
              onSelect={onSelect}
              position={position}
              reducedMotion={reducedMotion}
              selected={node.id === selectedNodeId}
            />
          )
        })}
      </group>
      <CameraController
        focusRequest={focusRequest ?? null}
        positions={positions}
        resetSignal={resetSignal}
        sceneKey={workflow.id}
      />
    </>
  )
}

export function WorkflowScene(props: WorkflowSceneProps) {
  const reducedMotion = useReducedMotion()
  const presentationPositions = useMemo(
    () => createPresentationPositions(props.positions),
    [props.positions],
  )
  const bounds = useMemo(
    () => getSceneBounds(presentationPositions),
    [presentationPositions],
  )
  const initialDistance = getSceneFitDistance(presentationPositions, 1.25, 42)
  const cameraPosition: [number, number, number] = [
    bounds.center[0] + initialDistance * 0.11,
    bounds.center[1] + initialDistance * 0.3,
    bounds.center[2] + initialDistance * 0.95,
  ]

  return (
    <div
      aria-label={`${props.workflow.name}の3Dワークフロー。ノードは${props.workflow.nodes.length}件です。`}
      role="img"
      style={{ height: '100%', minHeight: 320, position: 'relative', width: '100%' }}
    >
      <Canvas
        camera={{ far: 140, fov: 42, near: 0.1, position: cameraPosition }}
        dpr={[1, 1.75]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        onPointerMissed={() => props.onSelect(null)}
        shadows="percentage"
      >
        <SceneContent {...props} positions={presentationPositions} reducedMotion={reducedMotion} />
      </Canvas>
    </div>
  )
}
