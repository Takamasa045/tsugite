import type { WorkflowStatus } from '../../types/workflow'

export interface StatusVisual {
  color: string
  icon: string
  label: string
  emissiveIntensity: number
}

export const STATUS_VISUALS: Record<WorkflowStatus, StatusVisual> = {
  pending: {
    color: '#777169',
    icon: '—',
    label: '待機',
    emissiveIntensity: 0.05,
  },
  queued: {
    color: '#75aaa8',
    icon: '◌',
    label: 'キュー',
    emissiveIntensity: 0.45,
  },
  thinking: {
    color: '#668fc0',
    icon: '∿',
    label: '思考中',
    emissiveIntensity: 0.65,
  },
  running: {
    color: '#9a80b1',
    icon: '▶',
    label: '実行中',
    emissiveIntensity: 0.85,
  },
  waiting_approval: {
    color: '#d0a143',
    icon: '!',
    label: '承認待ち',
    emissiveIntensity: 0.75,
  },
  testing: {
    color: '#c87842',
    icon: '◇',
    label: 'テスト中',
    emissiveIntensity: 0.75,
  },
  completed: {
    color: '#719a72',
    icon: '✓',
    label: '完了',
    emissiveIntensity: 0.55,
  },
  error: {
    color: '#c45d4f',
    icon: '×',
    label: 'エラー',
    emissiveIntensity: 0.8,
  },
  skipped: {
    color: '#4c4842',
    icon: '≫',
    label: 'スキップ',
    emissiveIntensity: 0.02,
  },
}
