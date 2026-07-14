import type {
  WorkflowData,
  WorkflowLayoutResult,
  WorkflowNodePosition,
} from '../types/workflow'

export const LAYER_GAP = 5
export const NODE_GAP = 3

function calculateDagLayers(workflow: WorkflowData): {
  nodePositions: Record<string, WorkflowNodePosition>
  hasCycle: boolean
} {
  const nodeIds = new Set(workflow.nodes.map((node) => node.id))
  const indegree = new Map(workflow.nodes.map((node) => [node.id, 0]))
  const adjacency = new Map(workflow.nodes.map((node) => [node.id, [] as string[]]))
  for (const edge of workflow.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue
    adjacency.get(edge.source)?.push(edge.target)
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
  }

  const queue = workflow.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  const layers = new Map<string, number>(queue.map((id) => [id, 0]))
  const visited = new Set<string>()
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue
    visited.add(current)
    for (const target of adjacency.get(current) ?? []) {
      layers.set(target, Math.max(layers.get(target) ?? 0, (layers.get(current) ?? 0) + 1))
      const nextIndegree = (indegree.get(target) ?? 1) - 1
      indegree.set(target, nextIndegree)
      if (nextIndegree === 0) queue.push(target)
    }
  }

  const hasCycle = visited.size !== workflow.nodes.length
  const fallbackLayer = Math.max(0, ...layers.values()) + (visited.size > 0 ? 1 : 0)
  for (const node of workflow.nodes) {
    if (!layers.has(node.id)) layers.set(node.id, fallbackLayer)
  }

  const nodesByLayer = new Map<number, string[]>()
  for (const node of workflow.nodes) {
    const layer = layers.get(node.id) ?? 0
    nodesByLayer.set(layer, [...(nodesByLayer.get(layer) ?? []), node.id])
  }
  const nodePositions: Record<string, WorkflowNodePosition> = {}
  for (const [layer, ids] of nodesByLayer) {
    ids.forEach((id, order) => {
      nodePositions[id] = { layer, order }
    })
  }
  return { nodePositions, hasCycle }
}

export function calculateNodePositions(workflow: WorkflowData): WorkflowLayoutResult {
  const hasAllExplicitPositions = workflow.nodes.every((node) => node.position !== undefined)
  const dagResult = hasAllExplicitPositions ? null : calculateDagLayers(workflow)
  const logicalPositions = Object.fromEntries(
    workflow.nodes.map((node) => [
      node.id,
      hasAllExplicitPositions ? (node.position as WorkflowNodePosition) : dagResult?.nodePositions[node.id] ?? { layer: 0, order: 0 },
    ]),
  )

  const nodesByLayer = new Map<number, Array<{ id: string; order: number }>>()
  for (const node of workflow.nodes) {
    const position = logicalPositions[node.id]
    if (!position) continue
    nodesByLayer.set(position.layer, [
      ...(nodesByLayer.get(position.layer) ?? []),
      { id: node.id, order: position.order },
    ])
  }

  const positions: WorkflowLayoutResult['positions'] = {}
  for (const [layer, entries] of nodesByLayer) {
    entries.sort((left, right) => left.order - right.order)
    const center = (entries.length - 1) / 2
    entries.forEach((entry, index) => {
      positions[entry.id] = {
        x: layer * LAYER_GAP,
        y: 0,
        z: (index - center) * NODE_GAP,
        layer,
        order: entry.order,
      }
    })
  }

  return {
    positions,
    warnings: dagResult?.hasCycle ? ['cycle detected; unresolved nodes use a fallback layer'] : [],
  }
}
