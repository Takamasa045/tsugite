import {
  WORKFLOW_STATUSES,
  type DerivedWorkflowState,
  type WorkflowData,
  type WorkflowNode,
  type WorkflowNodeDetails,
  type WorkflowStatus,
} from '../types/workflow'

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

const currentOutcomeCopy: Partial<Record<WorkflowStatus, string>> = {
  pending: 'まだ着手していません。前工程の完了後にこの作業を始めます。',
  queued: '実行順を待っています。順番が来ると自動的に着手します。',
  thinking: '現在、方針と条件を整理しています。',
  running: '現在、この作業を実行しています。',
  waiting_approval: '必要な確認を終え、人の承認を待っています。',
  testing: '現在、成果物と条件が合っているか検査しています。',
}

function detailsAtStatus(details: WorkflowNodeDetails | undefined, status: WorkflowStatus): WorkflowNodeDetails | undefined {
  if (!details) return undefined
  const terminal = status === 'completed' || status === 'error' || status === 'skipped'
  const approvalDecision = status === 'waiting_approval'
    ? '現在は未承認です。内容を確認して進行可否を判断してください。'
    : status === 'pending' || status === 'queued'
      ? 'まだ判断は行われていません。前工程の完了後に内容を確認してください。'
      : '判断に必要な情報を確認しています。処理が整うまでお待ちください。'
  const approval = details.approval
    ? terminal
      ? { ...details.approval, checkpoints: [...details.approval.checkpoints] }
      : {
          subject: details.approval.subject,
          checkpoints: [...details.approval.checkpoints],
          decision: approvalDecision,
        }
    : undefined
  return {
    ...details,
    outcome: terminal ? details.outcome : (currentOutcomeCopy[status] ?? details.outcome),
    inputs: details.inputs.map((item) => ({ ...item, ...(item.facts ? { facts: [...item.facts] } : {}) })),
    outputs: details.outputs.map((item) => ({
      ...item,
      ...(details.approval && !terminal
        ? { facts: [approvalDecision] }
        : item.facts ? { facts: [...item.facts] } : {}),
    })),
    ...(approval ? { approval } : {}),
  }
}

export function calculateWorkflowProgress(nodes: readonly Pick<WorkflowNode, 'progress'>[]): number {
  if (nodes.length === 0) return 0
  const total = nodes.reduce((sum, node) => sum + clamp(node.progress, 0, 100), 0)
  return Math.round((total / nodes.length) * 10) / 10
}

export function deriveWorkflowStateAtTime(workflow: WorkflowData, time: number): DerivedWorkflowState {
  const currentTime = clamp(Number.isFinite(time) ? time : 0, 0, workflow.duration)
  const nodeById = Object.fromEntries(
    workflow.nodes.map((node) => [node.id, {
      ...node,
      inputs: [...node.inputs],
      outputs: [...node.outputs],
      logs: node.logs.filter((log) => log.time <= currentTime).map((log) => ({ ...log })),
    }]),
  ) as Record<string, WorkflowNode>

  const events = workflow.events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.time <= currentTime)
    .sort((left, right) => left.event.time - right.event.time || left.index - right.index)

  for (const { event } of events) {
    const node = nodeById[event.nodeId]
    if (!node) continue
    const progress =
      event.progress === undefined
        ? event.status === 'completed'
          ? 100
          : node.progress
        : clamp(event.progress, 0, 100)
    nodeById[event.nodeId] = { ...node, status: event.status, progress }
  }

  for (const [nodeId, node] of Object.entries(nodeById)) {
    nodeById[nodeId] = { ...node, ...(node.details ? { details: detailsAtStatus(node.details, node.status) } : {}) }
  }

  const nodes = workflow.nodes.map((node) => nodeById[node.id]).filter((node): node is WorkflowNode => Boolean(node))
  const counts = Object.fromEntries(WORKFLOW_STATUSES.map((status) => [status, 0])) as Record<WorkflowStatus, number>
  for (const node of nodes) counts[node.status] += 1

  return {
    currentTime,
    nodes,
    nodeById,
    progress: calculateWorkflowProgress(nodes),
    counts,
  }
}
