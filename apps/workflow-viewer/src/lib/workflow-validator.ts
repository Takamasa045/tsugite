import {
  WORKFLOW_NODE_TYPES,
  WORKFLOW_STATUSES,
  type WorkflowData,
  type WorkflowValidationIssue,
  type WorkflowValidationResult,
} from '../types/workflow'

const statuses = new Set<string>(WORKFLOW_STATUSES)
const nodeTypes = new Set<string>(WORKFLOW_NODE_TYPES)
const logLevels = new Set(['info', 'success', 'warning', 'error'])
const previewRoles = new Set(['material', 'final'])
const previewKinds = new Set(['image', 'video', 'audio'])

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

function addRequiredString(
  object: Record<string, unknown>,
  key: string,
  path: string,
  errors: WorkflowValidationIssue[],
): void {
  if (typeof object[key] !== 'string' || object[key].length === 0) {
    errors.push({ code: 'required', message: `${key} must be a non-empty string`, path })
  }
}

function validateNonNegativeTime(
  value: unknown,
  path: string,
  duration: number,
  errors: WorkflowValidationIssue[],
): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push({ code: 'invalid_time', message: 'time must be a finite number', path })
  } else if (value < 0) {
    errors.push({ code: 'negative_time', message: 'time must be zero or greater', path })
  } else if (value > duration) {
    errors.push({
      code: 'time_exceeds_duration',
      message: `time must not exceed duration (${duration})`,
      path,
    })
  }
}

function addDetailsError(
  message: string,
  path: string,
  errors: WorkflowValidationIssue[],
): void {
  errors.push({ code: 'invalid_details', message, path })
}

function validateDetailItems(
  input: unknown,
  path: string,
  errors: WorkflowValidationIssue[],
): void {
  if (!Array.isArray(input)) {
    addDetailsError('detail items must be an array', path, errors)
    return
  }
  input.forEach((item, index) => {
    const itemPath = `${path}[${index}]`
    if (!isRecord(item)) {
      addDetailsError('detail item must be an object', itemPath, errors)
      return
    }
    for (const key of ['label', 'description'] as const) {
      if (typeof item[key] !== 'string' || item[key].length === 0) {
        addDetailsError(`${key} must be a non-empty string`, `${itemPath}.${key}`, errors)
      }
    }
    if (item.reference !== undefined && (typeof item.reference !== 'string' || item.reference.length === 0)) {
      addDetailsError('reference must be a non-empty string', `${itemPath}.reference`, errors)
    }
    if (item.href !== undefined && item.href !== './review/index.html') {
      addDetailsError('href must be the safe local review HTML path', `${itemPath}.href`, errors)
    }
    if (item.facts !== undefined && (!Array.isArray(item.facts) || !item.facts.every((fact) => typeof fact === 'string' && fact.length > 0))) {
      addDetailsError('facts must be a non-empty string array', `${itemPath}.facts`, errors)
    }
  })
}

function validateNodeDetails(
  input: unknown,
  path: string,
  errors: WorkflowValidationIssue[],
): void {
  if (!isRecord(input)) {
    addDetailsError('details must be an object', path, errors)
    return
  }
  for (const key of ['purpose', 'activity', 'outcome'] as const) {
    if (typeof input[key] !== 'string' || input[key].length === 0) {
      addDetailsError(`${key} must be a non-empty string`, `${path}.${key}`, errors)
    }
  }
  validateDetailItems(input.inputs, `${path}.inputs`, errors)
  validateDetailItems(input.outputs, `${path}.outputs`, errors)
  if (input.previews !== undefined) validateMediaPreviews(input.previews, `${path}.previews`, errors)
  if (input.approval === undefined) return
  if (!isRecord(input.approval)) {
    addDetailsError('approval must be an object', `${path}.approval`, errors)
    return
  }
  for (const key of ['subject', 'decision'] as const) {
    if (typeof input.approval[key] !== 'string' || input.approval[key].length === 0) {
      addDetailsError(`${key} must be a non-empty string`, `${path}.approval.${key}`, errors)
    }
  }
  if (!Array.isArray(input.approval.checkpoints) || !input.approval.checkpoints.every((item) => typeof item === 'string' && item.length > 0)) {
    addDetailsError('checkpoints must be a non-empty string array', `${path}.approval.checkpoints`, errors)
  }
  if (
    input.approval.decidedAt !== undefined &&
    (typeof input.approval.decidedAt !== 'string' || Number.isNaN(Date.parse(input.approval.decidedAt)))
  ) {
    addDetailsError('decidedAt must be an ISO date string', `${path}.approval.decidedAt`, errors)
  }
}

function validateMediaPreviews(
  input: unknown,
  path: string,
  errors: WorkflowValidationIssue[],
): void {
  if (!Array.isArray(input)) {
    addDetailsError('previews must be an array', path, errors)
    return
  }
  input.forEach((preview, index) => {
    const previewPath = `${path}[${index}]`
    if (!isRecord(preview)) {
      addDetailsError('preview must be an object', previewPath, errors)
      return
    }
    for (const key of ['id', 'label', 'description'] as const) {
      if (typeof preview[key] !== 'string' || preview[key].length === 0) {
        addDetailsError(`${key} must be a non-empty string`, `${previewPath}.${key}`, errors)
      }
    }
    if (typeof preview.role !== 'string' || !previewRoles.has(preview.role)) {
      addDetailsError('role must be material or final', `${previewPath}.role`, errors)
    }
    if (typeof preview.kind !== 'string' || !previewKinds.has(preview.kind)) {
      addDetailsError('kind must be image, video, or audio', `${previewPath}.kind`, errors)
    }
    if (
      typeof preview.src !== 'string' ||
      !/^\.\/previews\/[A-Za-z0-9._-]+$/.test(preview.src)
    ) {
      addDetailsError('src must be a safe relative preview path', `${previewPath}.src`, errors)
    }
  })
}

function findCycle(nodeIds: Set<string>, edges: unknown[]): boolean {
  const adjacency = new Map<string, string[]>([...nodeIds].map((id) => [id, []]))
  for (const edge of edges) {
    if (!isRecord(edge) || typeof edge.source !== 'string' || typeof edge.target !== 'string') continue
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      adjacency.get(edge.source)?.push(edge.target)
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true
    if (visited.has(nodeId)) return false
    visiting.add(nodeId)
    for (const next of adjacency.get(nodeId) ?? []) {
      if (visit(next)) return true
    }
    visiting.delete(nodeId)
    visited.add(nodeId)
    return false
  }

  return [...nodeIds].some(visit)
}

export function validateWorkflowData(input: unknown): WorkflowValidationResult {
  const errors: WorkflowValidationIssue[] = []
  const warnings: WorkflowValidationIssue[] = []
  if (!isRecord(input)) {
    return {
      success: false,
      errors: [{ code: 'required', message: 'workflow must be an object', path: '$' }],
    }
  }

  addRequiredString(input, 'id', 'id', errors)
  addRequiredString(input, 'name', 'name', errors)
  if (typeof input.status !== 'string' || !statuses.has(input.status)) {
    errors.push({ code: 'invalid_status', message: 'workflow status is invalid', path: 'status' })
  }
  const duration = typeof input.duration === 'number' && Number.isFinite(input.duration) ? input.duration : 0
  if (typeof input.duration !== 'number' || !Number.isFinite(input.duration) || input.duration < 0) {
    errors.push({
      code: input.duration === undefined ? 'required' : 'invalid_duration',
      message: 'duration must be a non-negative finite number',
      path: 'duration',
    })
  }

  const nodes = Array.isArray(input.nodes) ? input.nodes : []
  const edges = Array.isArray(input.edges) ? input.edges : []
  const events = Array.isArray(input.events) ? input.events : []
  if (!Array.isArray(input.nodes)) errors.push({ code: 'required', message: 'nodes must be an array', path: 'nodes' })
  if (!Array.isArray(input.edges)) errors.push({ code: 'required', message: 'edges must be an array', path: 'edges' })
  if (!Array.isArray(input.events)) errors.push({ code: 'required', message: 'events must be an array', path: 'events' })

  const nodeIds = new Set<string>()
  nodes.forEach((node, index) => {
    const path = `nodes[${index}]`
    if (!isRecord(node)) {
      errors.push({ code: 'invalid_node', message: 'node must be an object', path })
      return
    }
    addRequiredString(node, 'id', `${path}.id`, errors)
    addRequiredString(node, 'name', `${path}.name`, errors)
    if (node.technicalName !== undefined && (typeof node.technicalName !== 'string' || node.technicalName.length === 0)) {
      errors.push({ code: 'invalid_details', message: 'technicalName must be a non-empty string', path: `${path}.technicalName` })
    }
    if (typeof node.id === 'string') {
      if (nodeIds.has(node.id)) {
        errors.push({ code: 'duplicate_node_id', message: `duplicate node id: ${node.id}`, path: `${path}.id` })
      }
      nodeIds.add(node.id)
    }
    if (typeof node.type !== 'string' || !nodeTypes.has(node.type)) {
      errors.push({ code: 'invalid_node_type', message: 'node type is invalid', path: `${path}.type` })
    }
    if (typeof node.status !== 'string' || !statuses.has(node.status)) {
      errors.push({ code: 'invalid_status', message: 'node status is invalid', path: `${path}.status` })
    }
    if (typeof node.progress !== 'number' || !Number.isFinite(node.progress) || node.progress < 0 || node.progress > 100) {
      errors.push({ code: 'invalid_progress', message: 'progress must be between 0 and 100', path: `${path}.progress` })
    }
    for (const key of ['inputs', 'outputs'] as const) {
      if (!Array.isArray(node[key]) || !node[key].every((item) => typeof item === 'string')) {
        errors.push({ code: 'required', message: `${key} must be a string array`, path: `${path}.${key}` })
      }
    }
    if (node.details !== undefined) validateNodeDetails(node.details, `${path}.details`, errors)
    if (!Array.isArray(node.logs)) {
      errors.push({ code: 'required', message: 'logs must be an array', path: `${path}.logs` })
    } else {
      node.logs.forEach((log, logIndex) => {
        const logPath = `${path}.logs[${logIndex}]`
        if (!isRecord(log)) {
          errors.push({ code: 'invalid_log', message: 'log must be an object', path: logPath })
          return
        }
        validateNonNegativeTime(log.time, `${logPath}.time`, duration, errors)
        if (typeof log.level !== 'string' || !logLevels.has(log.level)) {
          errors.push({ code: 'invalid_log_level', message: 'log level is invalid', path: `${logPath}.level` })
        }
        addRequiredString(log, 'message', `${logPath}.message`, errors)
      })
    }
    for (const key of ['startedAt', 'completedAt'] as const) {
      if (node[key] !== undefined) validateNonNegativeTime(node[key], `${path}.${key}`, duration, errors)
    }
    if (node.position !== undefined) {
      if (
        !isRecord(node.position) ||
        !Number.isInteger(node.position.layer) ||
        Number(node.position.layer) < 0 ||
        !Number.isInteger(node.position.order) ||
        Number(node.position.order) < 0
      ) {
        errors.push({ code: 'invalid_position', message: 'position layer/order must be non-negative integers', path: `${path}.position` })
      }
    }
  })

  const edgeIds = new Set<string>()
  edges.forEach((edge, index) => {
    const path = `edges[${index}]`
    if (!isRecord(edge)) {
      errors.push({ code: 'invalid_edge', message: 'edge must be an object', path })
      return
    }
    addRequiredString(edge, 'id', `${path}.id`, errors)
    addRequiredString(edge, 'source', `${path}.source`, errors)
    addRequiredString(edge, 'target', `${path}.target`, errors)
    if (typeof edge.id === 'string') {
      if (edgeIds.has(edge.id)) errors.push({ code: 'duplicate_edge_id', message: `duplicate edge id: ${edge.id}`, path: `${path}.id` })
      edgeIds.add(edge.id)
    }
    if (
      (typeof edge.source === 'string' && !nodeIds.has(edge.source)) ||
      (typeof edge.target === 'string' && !nodeIds.has(edge.target))
    ) {
      errors.push({ code: 'unknown_edge_node', message: 'edge refers to an unknown node', path })
    }
  })

  events.forEach((event, index) => {
    const path = `events[${index}]`
    if (!isRecord(event)) {
      errors.push({ code: 'invalid_event', message: 'event must be an object', path })
      return
    }
    validateNonNegativeTime(event.time, `${path}.time`, duration, errors)
    if (typeof event.nodeId !== 'string' || !nodeIds.has(event.nodeId)) {
      errors.push({ code: 'unknown_event_node', message: 'event refers to an unknown node', path: `${path}.nodeId` })
    }
    if (typeof event.status !== 'string' || !statuses.has(event.status)) {
      errors.push({ code: 'invalid_status', message: 'event status is invalid', path: `${path}.status` })
    }
    if (
      event.progress !== undefined &&
      (typeof event.progress !== 'number' || !Number.isFinite(event.progress) || event.progress < 0 || event.progress > 100)
    ) {
      errors.push({ code: 'invalid_progress', message: 'event progress must be between 0 and 100', path: `${path}.progress` })
    }
  })

  if (findCycle(nodeIds, edges)) {
    warnings.push({ code: 'cycle_detected', message: 'workflow dependencies contain a cycle', path: 'edges' })
  }

  if (errors.length > 0) return { success: false, errors }
  return {
    success: true,
    data: input as unknown as WorkflowData,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
