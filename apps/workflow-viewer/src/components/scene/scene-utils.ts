import type { WorkflowStatus } from '../../types/workflow'

export type ScenePosition =
  | readonly [number, number, number]
  | { x: number; y: number; z: number }

export type NodePositions =
  | Readonly<Record<string, ScenePosition>>
  | ReadonlyMap<string, ScenePosition>

export type EdgeVisualState = 'inactive' | 'ready' | 'active' | 'completed' | 'error'

function isTuple(position: ScenePosition): position is readonly [number, number, number] {
  return Array.isArray(position)
}

function isPositionMap(positions: NodePositions): positions is ReadonlyMap<string, ScenePosition> {
  return typeof (positions as ReadonlyMap<string, ScenePosition>).get === 'function'
}

export function toVectorTuple(position: ScenePosition): [number, number, number] {
  return isTuple(position)
    ? [position[0], position[1], position[2]]
    : [position.x, position.y, position.z]
}

export function getPosition(
  positions: NodePositions,
  nodeId: string,
): [number, number, number] | null {
  const position = isPositionMap(positions) ? positions.get(nodeId) : positions[nodeId]
  return position ? toVectorTuple(position) : null
}

export function getSceneBounds(positions: NodePositions): {
  center: [number, number, number]
  radius: number
} {
  const values = isPositionMap(positions) ? [...positions.values()] : Object.values(positions)

  if (values.length === 0) {
    return { center: [0, 0, 0], radius: 4 }
  }

  const tuples = values.map(toVectorTuple)
  const minimum = tuples.reduce(
    (result, position) => result.map((value, index) => Math.min(value, position[index])) as [
      number,
      number,
      number,
    ],
    [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
  )
  const maximum = tuples.reduce(
    (result, position) => result.map((value, index) => Math.max(value, position[index])) as [
      number,
      number,
      number,
    ],
    [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  )
  const center: [number, number, number] = [
    (minimum[0] + maximum[0]) / 2,
    (minimum[1] + maximum[1]) / 2,
    (minimum[2] + maximum[2]) / 2,
  ]
  const radius = Math.max(
    4,
    Math.hypot(
      maximum[0] - center[0],
      maximum[1] - center[1],
      maximum[2] - center[2],
    ),
  )

  return { center, radius }
}

const ACTIVE_STATUSES = new Set<WorkflowStatus>(['thinking', 'running', 'testing'])

export function getEdgeVisualState(
  sourceStatus: WorkflowStatus,
  targetStatus: WorkflowStatus,
): EdgeVisualState {
  if (sourceStatus === 'error' || targetStatus === 'error') return 'error'
  if (sourceStatus === 'completed' && targetStatus === 'completed') return 'completed'
  if (ACTIVE_STATUSES.has(targetStatus)) return 'active'
  if (sourceStatus === 'completed' || targetStatus === 'queued') return 'ready'
  return 'inactive'
}
