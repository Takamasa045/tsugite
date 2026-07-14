import { Html } from '@react-three/drei'
import type { CSSProperties, MouseEvent } from 'react'

import type { WorkflowNode } from '../../types/workflow'
import { STATUS_VISUALS } from './status-visuals'

interface NodeLabelProps {
  node: WorkflowNode
  onSelect: (nodeId: string) => void
  selected: boolean
}

export function NodeLabel({ node, onSelect, selected }: NodeLabelProps) {
  const visual = STATUS_VISUALS[node.status]
  const labelStyle = { '--node-accent': visual.color } as CSSProperties

  const handleSelect = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    onSelect(node.id)
  }

  return (
    <Html center position={[0, 1.42, 0]} distanceFactor={13} zIndexRange={[20, 0]}>
      <button
        aria-label={`${node.name}の詳細を表示`}
        aria-pressed={selected}
        className="scene-node-label"
        data-selected={selected ? 'true' : 'false'}
        data-status={node.status}
        onClick={handleSelect}
        onPointerDown={(event) => event.stopPropagation()}
        style={labelStyle}
        type="button"
      >
        <span aria-hidden="true" className="scene-node-icon">{visual.icon}</span>
        <strong>{node.name}</strong>
        <small>{visual.label}</small>
      </button>
    </Html>
  )
}
