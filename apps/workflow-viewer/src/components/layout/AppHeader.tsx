import { ArrowLeft, RotateCcw } from 'lucide-react'
import type { WorkflowData, WorkflowNode } from '../../types/workflow'
import { ProgressBar } from '../workflow/ProgressBar'
import { StatusBadge } from '../workflow/StatusBadge'

export interface WorkflowSampleOption {
  id: string
  label: string
}

interface AppHeaderProps {
  workflow: WorkflowData
  currentNodes: WorkflowNode[]
  onResetView: () => void
  samples: WorkflowSampleOption[]
  activeSampleId: string
  onSampleChange: (sampleId: string) => void
  launcherHref?: string
}

export function AppHeader({
  workflow,
  currentNodes,
  onResetView,
  samples,
  activeSampleId,
  onSampleChange,
  launcherHref,
}: AppHeaderProps) {
  const progress = currentNodes.length
    ? currentNodes.reduce((sum, node) => sum + node.progress, 0) / currentNodes.length
    : 0
  const roundedProgress = Math.round(progress)
  const completedCount = currentNodes.filter((node) => node.status === 'completed').length

  return (
    <header className="app-header">
      <div className="brand-block">
        <span aria-hidden="true" className="brand-mark">継</span>
        <div>
          <span className="product-name">TSUGITE / 制作の見取図</span>
          <h1>{workflow.name}</h1>
        </div>
      </div>

      <div className="header-progress">
        <div className="header-progress-meta">
          <div className="header-progress-copy">
            <StatusBadge status={workflow.status} compact />
            <span>{currentNodes.length}工程中 {completedCount}工程完了</span>
          </div>
          <strong>{roundedProgress}%</strong>
        </div>
        <ProgressBar label="全体進捗" value={progress} />
      </div>

      <div className="header-actions">
        {launcherHref && (
          <a className="control-button viewer-back-link" href={launcherHref}>
            <ArrowLeft aria-hidden="true" size={15} />
            <span>制作案件へ戻る</span>
          </a>
        )}
        <label className="field-label">
          <span>サンプルを切り替える</span>
          <select value={activeSampleId} onChange={(event) => onSampleChange(event.target.value)}>
            {samples.map((sample) => <option key={sample.id} value={sample.id}>{sample.label}</option>)}
          </select>
        </label>
        <button className="control-button" onClick={onResetView} type="button">
          <RotateCcw aria-hidden="true" size={15} />
          <span>表示をリセット</span>
        </button>
      </div>
    </header>
  )
}
