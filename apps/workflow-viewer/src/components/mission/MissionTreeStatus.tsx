import type { MissionTreeOverlay } from '../../types/workflow'

export interface MissionTreeStatusProps {
  missionTree: MissionTreeOverlay
}

const DECISION_KINDS = new Set([
  'none',
  'awaiting_human',
  'gate',
  'blocked',
  'outcome_unknown',
  'recovery',
  'learning',
  'stale',
])

/**
 * Read-only Mission Tree current-decision strip for active productions.
 * Scene graph itself uses shared WorkflowScene / WorkflowFallback (PO-0A).
 * Does not participate in Gate subject construction.
 */
export function MissionTreeStatus({ missionTree }: MissionTreeStatusProps) {
  const decisionKind = DECISION_KINDS.has(missionTree.currentDecision.kind)
    ? missionTree.currentDecision.kind
    : 'none'

  return (
    <section
      aria-label="Mission Tree 状態（読み取り専用）"
      className="mission-tree-status"
      data-decision-kind={decisionKind}
      data-mission-mode={missionTree.mode}
      data-testid="mission-tree-status"
      data-tree-read-only="true"
    >
      <div className="mission-tree-status__row">
        <span className="eyebrow">MISSION TREE</span>
        <strong data-testid="mission-tree-decision">{missionTree.currentDecision.summary}</strong>
      </div>
      <dl className="mission-tree-status__meta">
        <div>
          <dt>状態</dt>
          <dd data-testid="mission-tree-mission-status">{missionTree.missionStatus}</dd>
        </div>
        <div>
          <dt>decision</dt>
          <dd data-testid="mission-tree-decision-kind">{decisionKind}</dd>
        </div>
        <div>
          <dt>revision</dt>
          <dd data-testid="mission-tree-revision">{missionTree.treeRevision}</dd>
        </div>
        <div>
          <dt>recovery</dt>
          <dd data-testid="mission-tree-recovery">
            {missionTree.recovery.active
              ? `active (${missionTree.recovery.attempts}${missionTree.recovery.limit === null ? '' : `/${missionTree.recovery.limit}`})`
              : 'idle'}
          </dd>
        </div>
        {missionTree.learningStatus ? (
          <div>
            <dt>learning</dt>
            <dd data-testid="mission-tree-learning">{missionTree.learningStatus}</dd>
          </div>
        ) : null}
      </dl>
      <p className="mission-tree-status__note" data-testid="mission-tree-readonly-note">
        TaskTree は読み取り専用です。Gate の承認対象には混入しません。
      </p>
    </section>
  )
}
