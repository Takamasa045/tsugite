import type { WorkflowData, WorkflowNode } from '../../types/workflow'
import { NodeDetails } from '../workflow/NodeDetails'
import { WorkflowSummary } from '../workflow/WorkflowSummary'

interface SidePanelProps {
  workflow: WorkflowData
  currentNodes: WorkflowNode[]
  selectedNodeId: string | null
  onSelectNode: (nodeId: string | null) => void
}

export function SidePanel({ workflow, currentNodes, selectedNodeId, onSelectNode }: SidePanelProps) {
  const selectedNode = currentNodes.find((node) => node.id === selectedNodeId)

  return (
    <aside aria-label="制作の記録" className="side-panel">
      {selectedNode ? (
        <NodeDetails
          currentNodes={currentNodes}
          node={selectedNode}
          onSelectNode={onSelectNode}
          workflow={workflow}
        />
      ) : (
        <WorkflowSummary currentNodes={currentNodes} workflow={workflow} />
      )}
    </aside>
  )
}
