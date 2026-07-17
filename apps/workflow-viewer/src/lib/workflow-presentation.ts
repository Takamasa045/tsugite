import type { WorkflowNode } from '../types/workflow'

const activeStatuses = new Set<WorkflowNode['status']>(['thinking', 'running', 'testing'])

export function getFocusNode(nodes: readonly WorkflowNode[]): WorkflowNode | undefined {
  return nodes.find((node) => node.status === 'error')
    ?? nodes.find((node) => node.status === 'waiting_approval')
    ?? nodes.find((node) => activeStatuses.has(node.status))
    ?? nodes.find((node) => node.status === 'queued')
    ?? nodes.find((node) => node.status === 'pending')
    ?? [...nodes].reverse().find((node) => node.status === 'completed')
    ?? nodes[0]
}

export function getFocusCopy(node?: WorkflowNode): { label: string; summary: string; note: string } {
  if (!node) {
    return {
      label: '工程はまだありません',
      summary: '表示できる工程がありません',
      note: 'ワークフローのデータを確認してください。',
    }
  }

  if (node.status === 'error') {
    return {
      label: 'いま確認が必要な工程',
      summary: `いま確認が必要な工程：${node.name}`,
      note: '右の記録欄で問題の内容と、次に行う対応を確認できます。',
    }
  }
  if (node.status === 'waiting_approval') {
    return {
      label: 'あなたの確認を待っています',
      summary: `承認を待っている工程：${node.name}`,
      note: '右の記録欄で、承認する内容と確認ポイントを確認できます。',
    }
  }
  if (activeStatuses.has(node.status)) {
    return {
      label: 'いま進めている工程',
      summary: `いま進めている工程：${node.name}`,
      note: '工程を選ぶと、行っている作業と途中経過を確認できます。',
    }
  }
  if (node.status === 'queued' || node.status === 'pending') {
    return {
      label: '次に始まる工程',
      summary: `次に始まる工程：${node.name}`,
      note: '前の工程が終わると、この工程へ進みます。',
    }
  }
  return {
    label: '最後に完了した工程',
    summary: `最後に完了した工程：${node.name}`,
    note: '工程を選ぶと、行ったことと成果物を確認できます。',
  }
}
