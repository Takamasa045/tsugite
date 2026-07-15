import type { WorkflowNode, WorkflowStatus } from '../../types/workflow'

export type AgentActivityMode = 'idle' | 'think' | 'craft' | 'inspect' | 'signal' | 'recover'
export type AgentTool = 'none' | 'chisel' | 'lantern'

export interface AgentActivity {
  animated: boolean
  intensity: number
  mode: AgentActivityMode
  motes: boolean
  scan: boolean
  tool: AgentTool
}

const ACTIVITIES: Record<WorkflowStatus, Omit<AgentActivity, 'animated'>> = {
  pending: { intensity: 0.04, mode: 'idle', motes: false, scan: false, tool: 'none' },
  queued: { intensity: 0.22, mode: 'think', motes: true, scan: false, tool: 'none' },
  thinking: { intensity: 0.58, mode: 'think', motes: true, scan: false, tool: 'none' },
  running: { intensity: 1, mode: 'craft', motes: false, scan: false, tool: 'chisel' },
  waiting_approval: { intensity: 0.68, mode: 'signal', motes: false, scan: false, tool: 'lantern' },
  testing: { intensity: 0.84, mode: 'inspect', motes: false, scan: true, tool: 'lantern' },
  completed: { intensity: 0.16, mode: 'inspect', motes: false, scan: false, tool: 'none' },
  error: { intensity: 0.62, mode: 'recover', motes: true, scan: false, tool: 'lantern' },
  skipped: { intensity: 0, mode: 'idle', motes: false, scan: false, tool: 'none' },
}

const WORKING_STATUSES = new Set<WorkflowStatus>([
  'queued',
  'thinking',
  'running',
  'waiting_approval',
  'testing',
  'error',
])

const WORKER_LABELS: Partial<Record<WorkflowStatus, string>> = {
  queued: '職人が仕事の支度をしています',
  thinking: '職人が考えをまとめています',
  running: '職人が手を動かしています',
  waiting_approval: '職人があなたの確認を待っています',
  testing: '職人が仕上がりを点検しています',
  error: '職人が直し方を探しています',
}

const DEPARTURE_DURATION = 1.5

export function shouldShowAgentWorker(
  node: Pick<WorkflowNode, 'status'>,
): boolean {
  return WORKING_STATUSES.has(node.status)
}

export function getAgentWorkerLabel(status: WorkflowStatus): string | null {
  return WORKER_LABELS[status] ?? null
}

export function getAgentWorkerDepartureProgress(
  node: Pick<WorkflowNode, 'completedAt' | 'status'>,
  currentTime: number,
): number | null {
  if (
    node.status !== 'completed'
    || node.completedAt === undefined
    || node.completedAt <= 0
    || currentTime < node.completedAt
    || currentTime >= node.completedAt + DEPARTURE_DURATION
  ) {
    return null
  }

  return (currentTime - node.completedAt) / DEPARTURE_DURATION
}

export function getAgentActivity(
  status: WorkflowStatus,
  reducedMotion = false,
): AgentActivity {
  const activity = ACTIVITIES[status]
  return {
    ...activity,
    animated: !reducedMotion && activity.intensity > 0,
    intensity: reducedMotion ? 0 : activity.intensity,
  }
}
