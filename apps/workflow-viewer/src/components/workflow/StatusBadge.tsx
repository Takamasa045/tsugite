import {
  AlertTriangle,
  BrainCircuit,
  Check,
  Circle,
  Clock3,
  FastForward,
  FlaskConical,
  LoaderCircle,
  Pause,
  Radio,
} from 'lucide-react'
import type { WorkflowStatus } from '../../types/workflow'

const statusMeta = {
  pending: { label: '未着手', Icon: Circle },
  queued: { label: '開始待ち', Icon: Clock3 },
  thinking: { label: '内容を検討中', Icon: BrainCircuit },
  running: { label: '作業中', Icon: LoaderCircle },
  waiting_approval: { label: '確認待ち', Icon: Pause },
  testing: { label: '品質確認中', Icon: FlaskConical },
  completed: { label: '完了', Icon: Check },
  error: { label: '要確認', Icon: AlertTriangle },
  skipped: { label: '対象外', Icon: FastForward },
} satisfies Record<WorkflowStatus, { label: string; Icon: typeof Radio }>

interface StatusBadgeProps {
  status: WorkflowStatus
  compact?: boolean
}

export function StatusBadge({ status, compact = false }: StatusBadgeProps) {
  const { label, Icon } = statusMeta[status]

  return (
    <span className={`status-badge status-${status}`} data-status={status}>
      <Icon aria-hidden="true" size={compact ? 12 : 14} strokeWidth={2} />
      <span>{label}</span>
    </span>
  )
}
