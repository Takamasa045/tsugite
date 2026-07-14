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
  queued: { label: '待機中', Icon: Clock3 },
  thinking: { label: '思考中', Icon: BrainCircuit },
  running: { label: '実行中', Icon: LoaderCircle },
  waiting_approval: { label: '承認待ち', Icon: Pause },
  testing: { label: 'テスト中', Icon: FlaskConical },
  completed: { label: '完了', Icon: Check },
  error: { label: 'エラー', Icon: AlertTriangle },
  skipped: { label: 'スキップ', Icon: FastForward },
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
