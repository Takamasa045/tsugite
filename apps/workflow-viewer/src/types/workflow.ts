export const WORKFLOW_STATUSES = [
  'pending',
  'queued',
  'thinking',
  'running',
  'waiting_approval',
  'testing',
  'completed',
  'error',
  'skipped',
] as const

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number]

export const WORKFLOW_NODE_TYPES = ['task', 'agent', 'approval', 'output', 'group'] as const

export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number]

export type WorkflowLogLevel = 'info' | 'success' | 'warning' | 'error'

export interface WorkflowLog {
  time: number
  level: WorkflowLogLevel
  message: string
}

export interface WorkflowNodePosition {
  layer: number
  order: number
}

export interface WorkflowMediaPreview {
  id: string
  role: 'material' | 'final'
  kind: 'image' | 'video' | 'audio'
  label: string
  description: string
  src: string
}

export interface WorkflowDetailItem {
  label: string
  description: string
  reference?: string
  facts?: string[]
}

export interface WorkflowApprovalDetails {
  subject: string
  checkpoints: string[]
  decision: string
  decidedAt?: string
}

export interface WorkflowNodeDetails {
  purpose: string
  activity: string
  outcome: string
  inputs: WorkflowDetailItem[]
  outputs: WorkflowDetailItem[]
  previews?: WorkflowMediaPreview[]
  approval?: WorkflowApprovalDetails
}

export interface WorkflowNode {
  id: string
  name: string
  technicalName?: string
  type: WorkflowNodeType
  agent?: string
  description?: string
  status: WorkflowStatus
  progress: number
  startedAt?: number
  completedAt?: number
  position?: WorkflowNodePosition
  inputs: string[]
  outputs: string[]
  details?: WorkflowNodeDetails
  logs: WorkflowLog[]
}

export interface WorkflowEdge {
  id: string
  source: string
  target: string
}

export interface WorkflowEvent {
  time: number
  nodeId: string
  status: WorkflowStatus
  progress?: number
  message?: string
}

export interface WorkflowData {
  id: string
  name: string
  description?: string
  status: WorkflowStatus
  startedAt?: string
  duration: number
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  events: WorkflowEvent[]
}

export interface WorkflowValidationIssue {
  code: string
  message: string
  path?: string
}

export type WorkflowValidationResult =
  | {
      success: true
      data: WorkflowData
      warnings?: WorkflowValidationIssue[]
    }
  | {
      success: false
      errors: WorkflowValidationIssue[]
    }

export interface WorkflowNodeCoordinates extends WorkflowNodePosition {
  x: number
  y: number
  z: number
}

export interface WorkflowLayoutResult {
  positions: Record<string, WorkflowNodeCoordinates>
  warnings: string[]
}

export interface DerivedWorkflowState {
  currentTime: number
  nodes: WorkflowNode[]
  nodeById: Record<string, WorkflowNode>
  progress: number
  counts: Record<WorkflowStatus, number>
}
