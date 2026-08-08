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
  href?: string
  facts?: string[]
}

export interface WorkflowApprovalDetails {
  subject: string
  checkpoints: string[]
  decision: string
  decidedAt?: string
}

/** Optional person-consistency QA panel model (P5). Viewer-only; does not mutate Gates. */
export interface WorkflowPersonConsistencyEvidence {
  stage: string
  status: string
  status_label: string
  basis_summary: string
  subjects: Array<{
    subject_id: string
    basis: string
    evaluable_coverage: number
    traits: Array<{ trait: string; status: string; level: string; notes?: string }>
    ambiguity_codes: string[]
    observation_count: number
    face_evaluable_count: number
  }>
  ambiguities: string[]
  blocked_reasons?: string[]
  contact_sheet_href?: string
  contact_sheet_alt: string
  report_href?: string
  evidence_integrity?: 'valid' | 'tampered' | 'invalid' | 'not-verified'
  evidence_integrity_label?: string
  analyzer?: {
    status: 'ok' | 'not-run' | 'needs-human-review' | 'failed'
    label: string
    needs_human_review: boolean
  }
  human_decision?: {
    decision: string
    reason: string
    decided_at?: string
  }
  frame_details?: Array<{
    timestamp_ms: number
    shot_id: string
    visibility: string
    face_evaluable: boolean
    reason: string
  }>
  automatic_score_note?: string
  a11y?: {
    status_text: string
    summary_text: string
  }
}

export interface WorkflowNodeDetails {
  purpose: string
  activity: string
  outcome: string
  inputs: WorkflowDetailItem[]
  outputs: WorkflowDetailItem[]
  previews?: WorkflowMediaPreview[]
  approval?: WorkflowApprovalDetails
  /** Optional P5 person-consistency evidence panel data. */
  personConsistency?: WorkflowPersonConsistencyEvidence
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
