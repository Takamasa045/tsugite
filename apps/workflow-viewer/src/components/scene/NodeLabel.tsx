import { Html } from '@react-three/drei'
import type { CSSProperties, MouseEvent } from 'react'

import type { WorkflowNode } from '../../types/workflow'
import { getAgentWorkerLabel, shouldShowAgentWorker } from './agent-activity'
import { STATUS_VISUALS } from './status-visuals'

interface NodeLabelProps {
  featured?: boolean
  node: WorkflowNode
  onSelect: (nodeId: string) => void
  raised?: boolean
  selected: boolean
  workerPresent?: boolean
}

export function NodeLabel({
  featured = false,
  node,
  onSelect,
  raised = false,
  selected,
  workerPresent,
}: NodeLabelProps) {
  const visual = STATUS_VISUALS[node.status]
  const labelStyle = { '--node-accent': visual.color } as CSSProperties
  const workerVisible = workerPresent ?? shouldShowAgentWorker(node)
  const workerLabel = getAgentWorkerLabel(node.status)
  const workerLift = workerVisible ? 1.02 : 0
  const labelHeight = (raised ? (featured ? 2.24 : 2.08) : featured ? 1.72 : 1.48) + workerLift

  const handleSelect = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    onSelect(node.id)
  }

  return (
    <Html
      center
      position={[0, labelHeight, 0]}
      distanceFactor={12}
      zIndexRange={[20, 0]}
    >
      <button
        aria-current={featured ? 'step' : undefined}
        aria-label={`${node.name}の詳細を表示`}
        aria-pressed={selected}
        className="scene-node-label"
        data-featured={featured ? 'true' : 'false'}
        data-selected={selected ? 'true' : 'false'}
        data-status={node.status}
        data-worker={workerLabel ? 'true' : 'false'}
        onClick={handleSelect}
        onPointerDown={(event) => event.stopPropagation()}
        style={labelStyle}
        type="button"
      >
        <span aria-hidden="true" className="scene-node-icon">{visual.icon}</span>
        <strong>{node.name}</strong>
        <small>{visual.label}</small>
        {workerLabel ? (
          <span className="scene-worker-label">
            <i aria-hidden="true" />
            {workerLabel}
          </span>
        ) : null}
      </button>
    </Html>
  )
}
