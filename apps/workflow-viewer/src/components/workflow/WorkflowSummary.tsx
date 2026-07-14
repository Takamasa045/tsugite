import { Activity, AlertTriangle, CheckCircle2, Clock3, Layers3 } from 'lucide-react'
import type { WorkflowData, WorkflowNode } from '../../types/workflow'
import { ProgressBar } from './ProgressBar'
import { StatusBadge } from './StatusBadge'

interface WorkflowSummaryProps {
  workflow: WorkflowData
  currentNodes: WorkflowNode[]
}

function formatDateTime(value?: string) {
  if (!value) return '未記録'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = Math.floor(seconds % 60)
  return hours > 0 ? `${hours}時間 ${minutes}分` : `${minutes}分 ${rest}秒`
}

export function WorkflowSummary({ workflow, currentNodes }: WorkflowSummaryProps) {
  const completed = currentNodes.filter((node) => node.status === 'completed').length
  const running = currentNodes.filter((node) =>
    ['thinking', 'running', 'testing'].includes(node.status),
  ).length
  const errors = currentNodes.filter((node) => node.status === 'error').length
  const progress = currentNodes.length
    ? currentNodes.reduce((sum, node) => sum + node.progress, 0) / currentNodes.length
    : 0

  return (
    <section aria-labelledby="workflow-summary-title" className="panel-section summary-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">制作の記録 · OVERVIEW</span>
          <h2 id="workflow-summary-title">制作全体の状況</h2>
        </div>
        <StatusBadge status={workflow.status} compact />
      </div>

      <p className="panel-description">{workflow.description ?? '説明は登録されていません。'}</p>
      <ProgressBar label="全体の進み具合" showValue value={progress} />

      <div className="metric-grid">
        <div className="metric-card" data-metric="nodes">
          <Layers3 aria-hidden="true" size={17} />
          <span>工程数</span>
          <strong>{currentNodes.length} 工程</strong>
        </div>
        <div className="metric-card" data-metric="completed">
          <CheckCircle2 aria-hidden="true" size={17} />
          <span>完了</span>
          <strong>{completed} 件</strong>
        </div>
        <div className="metric-card" data-metric="running">
          <Activity aria-hidden="true" size={17} />
          <span>作業中</span>
          <strong>{running} 件</strong>
        </div>
        <div className="metric-card" data-metric="error">
          <AlertTriangle aria-hidden="true" size={17} />
          <span>要確認</span>
          <strong>{errors} 件</strong>
        </div>
      </div>

      <dl className="metadata-list">
        <div>
          <dt><Clock3 aria-hidden="true" size={14} />開始</dt>
          <dd>{formatDateTime(workflow.startedAt)}</dd>
        </div>
        <div>
          <dt>記録時間</dt>
          <dd>{formatDuration(workflow.duration)}</dd>
        </div>
      </dl>
    </section>
  )
}
