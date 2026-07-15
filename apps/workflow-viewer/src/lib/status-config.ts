import type { WorkflowStatus } from '../types/workflow'

export interface StatusConfig {
  label: string
  color: string
  emissive: string
  symbol: string
  animation: 'none' | 'blink' | 'pulse' | 'rotate' | 'orbit'
}

export const STATUS_CONFIG: Record<WorkflowStatus, StatusConfig> = {
  pending: {
    label: '未着手',
    color: '#777169',
    emissive: '#302b26',
    symbol: '○',
    animation: 'none',
  },
  queued: {
    label: '開始待ち',
    color: '#75aaa8',
    emissive: '#3f6967',
    symbol: '…',
    animation: 'blink',
  },
  thinking: {
    label: '内容を検討中',
    color: '#668fc0',
    emissive: '#3d5e86',
    symbol: '∴',
    animation: 'pulse',
  },
  running: {
    label: '作業中',
    color: '#9a80b1',
    emissive: '#665078',
    symbol: '▶',
    animation: 'rotate',
  },
  waiting_approval: {
    label: '確認待ち',
    color: '#d0a143',
    emissive: '#7f5f20',
    symbol: '!',
    animation: 'blink',
  },
  testing: {
    label: '品質確認中',
    color: '#c87842',
    emissive: '#81441f',
    symbol: '✓?',
    animation: 'orbit',
  },
  completed: {
    label: '完了',
    color: '#719a72',
    emissive: '#3f6844',
    symbol: '✓',
    animation: 'none',
  },
  error: {
    label: '要確認',
    color: '#c45d4f',
    emissive: '#7d3029',
    symbol: '⚠',
    animation: 'blink',
  },
  skipped: {
    label: '対象外',
    color: '#4c4842',
    emissive: '#26231f',
    symbol: '−',
    animation: 'none',
  },
}

export function getStatusConfig(status: WorkflowStatus): StatusConfig {
  return STATUS_CONFIG[status]
}
