import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MissionTreeStatus } from './MissionTreeStatus'

describe('MissionTreeStatus', () => {
  it('renders camelCase current decision and read-only markers', () => {
    render(
      <MissionTreeStatus
        missionTree={{
          productionId: 'prod-1',
          mode: 'active',
          missionStatus: 'ready',
          treeRevision: 2,
          sourceEventSequence: 4,
          currentDecision: {
            kind: 'awaiting_human',
            summary: '人間の判断待ちです',
            reasonCode: 'task.awaiting_human',
            nodeId: 'task-closeout',
          },
          recovery: { active: false, attempts: 0, limit: 2 },
          learningStatus: 'awaiting-human',
          taskTreeReadOnly: true,
          legacyWorkflowPreserved: true,
          digest: 'a'.repeat(64),
        }}
      />,
    )

    expect(screen.getByTestId('mission-tree-decision')).toHaveTextContent('人間の判断待ちです')
    expect(screen.getByTestId('mission-tree-decision-kind')).toHaveTextContent('awaiting_human')
    expect(screen.getByTestId('mission-tree-mission-status')).toHaveTextContent('ready')
    expect(screen.getByTestId('mission-tree-revision')).toHaveTextContent('2')
    expect(screen.getByTestId('mission-tree-status')).toHaveAttribute('data-tree-read-only', 'true')
    expect(screen.getByTestId('mission-tree-status')).toHaveAttribute('data-decision-kind', 'awaiting_human')
  })

  it('surfaces blocked and outcome_unknown decision kinds', () => {
    const { rerender } = render(
      <MissionTreeStatus
        missionTree={{
          productionId: 'prod-2',
          mode: 'active',
          missionStatus: 'ready',
          treeRevision: 1,
          currentDecision: { kind: 'blocked', summary: 'blocked' },
          recovery: { active: false, attempts: 0, limit: null },
          taskTreeReadOnly: true,
          legacyWorkflowPreserved: true,
        }}
      />,
    )
    expect(screen.getByTestId('mission-tree-status')).toHaveAttribute('data-decision-kind', 'blocked')

    rerender(
      <MissionTreeStatus
        missionTree={{
          productionId: 'prod-2',
          mode: 'active',
          missionStatus: 'ready',
          treeRevision: 1,
          currentDecision: { kind: 'outcome_unknown', summary: 'unknown' },
          recovery: { active: true, attempts: 1, limit: 2, lastErrorCode: 'submission_unknown' },
          taskTreeReadOnly: true,
          legacyWorkflowPreserved: true,
        }}
      />,
    )
    expect(screen.getByTestId('mission-tree-status')).toHaveAttribute('data-decision-kind', 'outcome_unknown')
    expect(screen.getByTestId('mission-tree-recovery')).toHaveTextContent('active (1/2)')
  })
})
