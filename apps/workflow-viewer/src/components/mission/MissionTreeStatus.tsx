import type { MissionTreeOverlay } from '../../types/workflow'

export interface MissionTreeStatusProps {
  missionTree: MissionTreeOverlay
}

/**
 * Read-only Mission Tree status strip for active productions.
 * Does not participate in Gate subject construction.
 */
export function MissionTreeStatus({ missionTree }: MissionTreeStatusProps) {
  return (
    <section
      aria-label="Mission Tree 状態（読み取り専用）"
      className="mission-tree-status"
      data-mission-mode={missionTree.mode}
      data-testid="mission-tree-status"
      data-tree-read-only="true"
    >
      <div className="mission-tree-status__row">
        <span className="eyebrow">MISSION TREE</span>
        <strong data-testid="mission-tree-decision">{missionTree.current_decision.summary}</strong>
      </div>
      <dl className="mission-tree-status__meta">
        <div>
          <dt>状態</dt>
          <dd data-testid="mission-tree-mission-status">{missionTree.mission_status}</dd>
        </div>
        <div>
          <dt>revision</dt>
          <dd data-testid="mission-tree-revision">{missionTree.tree_revision}</dd>
        </div>
        <div>
          <dt>recovery</dt>
          <dd data-testid="mission-tree-recovery">
            {missionTree.recovery.active
              ? `active (${missionTree.recovery.attempts}${missionTree.recovery.limit === null ? '' : `/${missionTree.recovery.limit}`})`
              : 'idle'}
          </dd>
        </div>
        {missionTree.learning_status ? (
          <div>
            <dt>learning</dt>
            <dd data-testid="mission-tree-learning">{missionTree.learning_status}</dd>
          </div>
        ) : null}
      </dl>
      <p className="mission-tree-status__note" data-testid="mission-tree-readonly-note">
        TaskTree は読み取り専用です。Gate の承認対象には混入しません。
      </p>
    </section>
  )
}
