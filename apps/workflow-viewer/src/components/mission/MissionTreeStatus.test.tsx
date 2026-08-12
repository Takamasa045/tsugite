import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MissionTreeStatus } from './MissionTreeStatus'

describe('MissionTreeStatus', () => {
  it('renders read-only mission decision, recovery, and learning status', () => {
    render(
      <MissionTreeStatus
        missionTree={{
          production_id: 'prod-1',
          mode: 'active',
          mission_status: 'ready',
          tree_revision: 3,
          current_decision: {
            kind: 'awaiting_human',
            summary: '人間の判断待ちです',
            reason_code: 'task.awaiting_human',
          },
          recovery: { active: true, attempts: 1, limit: 2, last_error_code: 'PC_GRANT_EXHAUSTED' },
          learning_status: 'awaiting-human',
          task_tree_read_only: true,
          legacy_workflow_preserved: true,
        }}
      />,
    )

    expect(screen.getByTestId('mission-tree-status')).toHaveAttribute('data-tree-read-only', 'true')
    expect(screen.getByTestId('mission-tree-decision')).toHaveTextContent('人間の判断待ちです')
    expect(screen.getByTestId('mission-tree-recovery')).toHaveTextContent('active (1/2)')
    expect(screen.getByTestId('mission-tree-learning')).toHaveTextContent('awaiting-human')
    expect(screen.getByTestId('mission-tree-readonly-note')).toHaveTextContent('Gate')
  })
})
