import { useRef } from 'react'

import { getStatusConfig } from '../../lib/status-config'
import type { WorkflowData, WorkflowNode } from '../../types/workflow'
import type { NodePositions } from './scene-utils'
import { getPosition } from './scene-utils'
import {
  SCENE_REASON_LABELS,
  type ScenePresentationStateV1,
} from './scene-state'

interface WorkflowFallbackProps {
  nodesAtTime?: readonly WorkflowNode[]
  onRetry: () => void
  onSelect: (nodeId: string | null) => void
  positions: NodePositions
  reducedMotion: boolean
  selectedNodeId: string | null
  state: Extract<ScenePresentationStateV1, { status: 'degraded' }>
  workflow: WorkflowData
}

function pointFor(position: readonly [number, number, number] | null, minX: number, maxX: number, minZ: number, maxZ: number): string {
  if (!position) return '0,0'
  const x = maxX === minX ? 50 : 8 + ((position[0] - minX) / (maxX - minX)) * 84
  const y = maxZ === minZ ? 50 : 12 + ((position[2] - minZ) / (maxZ - minZ)) * 76
  return `${x},${y}`
}

export function WorkflowFallback({
  nodesAtTime,
  onRetry,
  onSelect,
  positions,
  reducedMotion,
  selectedNodeId,
  state,
  workflow,
}: WorkflowFallbackProps) {
  const visibleNodes = nodesAtTime ?? workflow.nodes
  const nodeRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const coordinates = visibleNodes.map((node) => getPosition(positions, node.id)).filter(
    (position): position is [number, number, number] => position !== null,
  )
  const valuesX = coordinates.map((position) => position[0])
  const valuesZ = coordinates.map((position) => position[2])
  const minX = Math.min(...valuesX, 0)
  const maxX = Math.max(...valuesX, 1)
  const minZ = Math.min(...valuesZ, 0)
  const maxZ = Math.max(...valuesZ, 1)
  const nodeById = new Map(visibleNodes.map((node) => [node.id, node]))

  const moveSelection = (node: WorkflowNode, delta: number) => {
    const index = visibleNodes.findIndex((candidate) => candidate.id === node.id)
    const next = visibleNodes[(index + delta + visibleNodes.length) % visibleNodes.length]
    if (!next) return
    onSelect(next.id)
    nodeRefs.current[next.id]?.focus()
  }

  return (
    <div
      aria-label={`${workflow.name}の2D制作工程。ノードは${visibleNodes.length}件です。`}
      className="workflow-scene-fallback"
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      data-renderer="dom-tree"
      data-testid="workflow-scene-fallback"
      role="group"
    >
      <div className="workflow-fallback-toolbar">
        <div>
          <span className="eyebrow">3D DEGRADED MODE</span>
          <strong>工程を2D表示しています</strong>
          <p data-testid="scene-fallback-reason">
            {SCENE_REASON_LABELS[state.reason_code]} ({state.reason_code})
          </p>
        </div>
        <button className="control-button" onClick={onRetry} type="button">
          3D表示を再試行
        </button>
      </div>

      <svg
        aria-label={`${workflow.name}の工程関係。ノードは${visibleNodes.length}件です。`}
        className="workflow-fallback-map"
        role="img"
        viewBox="0 0 100 100"
      >
        <title>{workflow.name}の工程関係</title>
        {workflow.edges.map((edge) => {
          const source = nodeById.get(edge.source)
          const target = nodeById.get(edge.target)
          if (!source || !target) return null
          return (
            <line
              data-edge-id={edge.id}
              key={edge.id}
              stroke="currentColor"
              strokeDasharray="2 2"
              x1={pointFor(getPosition(positions, source.id), minX, maxX, minZ, maxZ).split(',')[0]}
              x2={pointFor(getPosition(positions, target.id), minX, maxX, minZ, maxZ).split(',')[0]}
              y1={pointFor(getPosition(positions, source.id), minX, maxX, minZ, maxZ).split(',')[1]}
              y2={pointFor(getPosition(positions, target.id), minX, maxX, minZ, maxZ).split(',')[1]}
            />
          )
        })}
      </svg>

      <ol aria-label="2D工程一覧" className="workflow-fallback-nodes">
        {visibleNodes.map((node, index) => {
          const status = getStatusConfig(node.status)
          const selected = node.id === selectedNodeId
          const featured = index === 0 && selectedNodeId === null
          return (
            <li key={node.id}>
              <button
                aria-current={featured ? 'step' : undefined}
                aria-label={`${node.name}の詳細を表示`}
                aria-pressed={selected}
                className="workflow-fallback-node"
                data-featured={featured ? 'true' : 'false'}
                data-node-id={node.id}
                data-selected={selected ? 'true' : 'false'}
                data-status={node.status}
                onClick={() => onSelect(node.id)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                    event.preventDefault()
                    moveSelection(node, 1)
                  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    moveSelection(node, -1)
                  }
                }}
                ref={(element) => {
                  nodeRefs.current[node.id] = element
                }}
                tabIndex={selected || (selectedNodeId === null && index === 0) ? 0 : -1}
                type="button"
              >
                <span className="workflow-fallback-node-number">工程 {String(index + 1).padStart(2, '0')}</span>
                <strong>{node.name}</strong>
                <span className="workflow-fallback-node-status">{status.symbol} {status.label}</span>
                <span className="workflow-fallback-node-progress">{Math.round(node.progress)}%</span>
              </button>
            </li>
          )
        })}
      </ol>
      <span aria-hidden="true" data-testid="scene-fallback-node-count" hidden>{visibleNodes.length}</span>
    </div>
  )
}
