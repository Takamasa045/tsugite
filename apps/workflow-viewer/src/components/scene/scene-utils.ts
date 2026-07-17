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

const PRESENTATION_SCALE_X = 0.6
const JOINERY_WEAVE = [-0.62, 0.28, 0.68, -0.18, -0.7, 0.18, 0.58, -0.36]

export function createPresentationPositions(
  positions: NodePositions,
): Record<string, [number, number, number]> {
  const entries = isPositionMap(positions) ? [...positions.entries()] : Object.entries(positions)
  const tuples = entries.map(([id, position]) => [id, toVectorTuple(position)] as const)
  const zValues = tuples.map(([, position]) => position[2])
  const isLongSingleRail = tuples.length >= 7 && Math.max(...zValues) - Math.min(...zValues) < 0.2

  if (!isLongSingleRail) return Object.fromEntries(tuples)

  const xValues = tuples.map(([, position]) => position[0])
  const centerX = (Math.min(...xValues) + Math.max(...xValues)) / 2
  const orderByX = new Map(
    [...tuples]
      .sort((left, right) => left[1][0] - right[1][0])
      .map(([id], index) => [id, index]),
  )

  return Object.fromEntries(
    tuples.map(([id, position]) => {
      const order = orderByX.get(id) ?? 0
      return [id, [
        centerX + (position[0] - centerX) * PRESENTATION_SCALE_X,
        position[1],
        position[2] + (JOINERY_WEAVE[order % JOINERY_WEAVE.length] ?? 0),
      ]]
    }),
  )
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

export function getSceneFitDistance(
  positions: NodePositions,
  aspectRatio: number,
  verticalFovDegrees: number,
): number {
  const values = isPositionMap(positions) ? [...positions.values()] : Object.values(positions)
  if (values.length === 0) return 8

  const tuples = values.map(toVectorTuple)
  const xValues = tuples.map((position) => position[0])
  const zValues = tuples.map((position) => position[2])
  const width = Math.max(...xValues) - Math.min(...xValues) + 4
  const depth = Math.max(...zValues) - Math.min(...zValues) + 4.5
  const verticalHalfFov = (verticalFovDegrees * Math.PI) / 360
  const horizontalHalfFov = Math.atan(
    Math.tan(verticalHalfFov) * Math.max(0.5, aspectRatio),
  )
  const horizontalDistance = width / 2 / Math.tan(horizontalHalfFov)
  const verticalDistance = depth / 2 / Math.tan(verticalHalfFov)

  return Math.max(8, horizontalDistance * 1.06, verticalDistance * 1.12)
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
