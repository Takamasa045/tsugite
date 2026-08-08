/**
 * Person consistency QA evidence panel (provider-neutral).
 * Verified evidence only; tampered/invalid/not-verified never shows contact-sheet or frame media.
 * Keyboard reachable, semantic landmarks, non-color status labels, lazy media when valid.
 */
import type { WorkflowPersonConsistencyEvidence } from '../../types/workflow'

export type PersonConsistencyPanelProps = WorkflowPersonConsistencyEvidence

const INTEGRITY_FALLBACK: Record<
  NonNullable<PersonConsistencyPanelProps['evidence_integrity']>,
  string
> = {
  valid: '証跡ハッシュ検証: 有効',
  tampered: '証跡ハッシュ検証: 改ざん検出（自動合格にしない）',
  invalid: '証跡ハッシュ検証: 無効（自動合格にしない）',
  'not-verified': '証跡ハッシュ検証: 未検証',
}

function canShowEvidenceMedia(
  integrity: NonNullable<PersonConsistencyPanelProps['evidence_integrity']>,
): boolean {
  return integrity === 'valid'
}

export function PersonConsistencyPanel(props: PersonConsistencyPanelProps) {
  const integrity = props.evidence_integrity ?? 'not-verified'
  const integrityLabel =
    props.evidence_integrity_label ?? INTEGRITY_FALLBACK[integrity]
  const isTampered = integrity === 'tampered' || integrity === 'invalid'
  const showMedia = canShowEvidenceMedia(integrity)
  const summary =
    props.a11y?.summary_text
    ?? `${props.status_label}。${integrityLabel}。対象 ${props.subjects.map((s) => s.subject_id).join('、') || 'なし'}`

  return (
    <section
      aria-labelledby="person-consistency-heading"
      className="person-consistency-panel"
      data-integrity={integrity}
      data-stage={props.stage}
    >
      <header className="person-consistency-header">
        <h3 id="person-consistency-heading">人物一貫性 QA 証跡</h3>
        <p className="person-consistency-summary" id="person-consistency-summary">
          {summary}
        </p>
      </header>

      <div
        aria-label="証跡ステータス"
        className="person-consistency-status-row"
        role="group"
      >
        <span
          className={`person-qa-status person-qa-status-${props.status}`}
          data-status={props.status}
          tabIndex={0}
        >
          判定: {props.status_label}
        </span>
        <span
          className={`person-qa-integrity person-qa-integrity-${integrity}`}
          data-integrity={integrity}
          tabIndex={0}
        >
          {integrityLabel}
        </span>
        {props.analyzer ? (
          <span
            className={`person-qa-analyzer person-qa-analyzer-${props.analyzer.status}`}
            data-analyzer={props.analyzer.status}
            tabIndex={0}
          >
            {props.analyzer.label}
          </span>
        ) : null}
      </div>

      {isTampered ? (
        <div className="person-qa-tamper-alert" role="alert">
          <strong>証跡が無効または改ざんされています</strong>
          <p>
            ハッシュ検証に失敗したため、この証跡を自動合格や Gate 通過根拠として扱いません。
            Viewer の表示失敗も Gate 状態を変更しません。
          </p>
        </div>
      ) : null}

      {!showMedia && !isTampered ? (
        <div className="person-qa-media-placeholder" role="status">
          証跡メディアはハッシュ検証が有効な場合のみ表示します（現在: {integrityLabel}）。
        </div>
      ) : null}

      {!showMedia && isTampered ? (
        <div className="person-qa-media-placeholder" role="status">
          改ざん/無効な証跡のためコンタクトシートとフレーム画像は表示しません。
        </div>
      ) : null}

      <p className="person-qa-advisory" tabIndex={0}>
        {props.automatic_score_note
          ?? '自動scoreは参考情報のみ。Gate通過には人の判断と証跡digestが必要です。'}
      </p>

      <section aria-labelledby="person-qa-subjects-heading" className="person-qa-subjects">
        <h4 id="person-qa-subjects-heading">対象人物サマリー</h4>
        {props.subjects.length === 0 ? (
          <p>対象人物なし</p>
        ) : (
          <ul className="person-qa-subject-list">
            {props.subjects.map((subject) => (
              <li key={subject.subject_id}>
                <article
                  aria-label={`Subject ${subject.subject_id}`}
                  className="person-qa-subject-card"
                  id={`person-qa-subject-${subject.subject_id}`}
                  tabIndex={0}
                >
                  <h5>{subject.subject_id}</h5>
                  <p>
                    根拠: {subject.basis} / カバレッジ:{' '}
                    {Math.round(subject.evaluable_coverage * 100)}% / 顔評価可:{' '}
                    {subject.face_evaluable_count}/{subject.observation_count}
                  </p>
                  <ul>
                    {subject.traits.map((trait) => (
                      <li key={`${subject.subject_id}-${trait.trait}`}>
                        <span data-trait-status={trait.status}>
                          {trait.trait}: {trait.status}（{trait.level}）
                        </span>
                        {trait.notes ? <span> — {trait.notes}</span> : null}
                      </li>
                    ))}
                  </ul>
                </article>
              </li>
            ))}
          </ul>
        )}
      </section>

      {showMedia && props.contact_sheet_href ? (
        <section
          aria-labelledby="person-qa-contact-sheet-heading"
          className="person-qa-contact-sheet"
        >
          <h4 id="person-qa-contact-sheet-heading">コンタクトシート</h4>
          <a
            aria-label={props.contact_sheet_alt}
            href={props.contact_sheet_href}
            id="person-qa-contact-sheet"
            rel="noreferrer"
            tabIndex={0}
            target="_blank"
          >
            <img
              alt={props.contact_sheet_alt}
              loading="lazy"
              src={props.contact_sheet_href}
            />
          </a>
        </section>
      ) : null}

      {showMedia && props.frame_details && props.frame_details.length > 0 ? (
        <section
          aria-labelledby="person-qa-frames-heading"
          className="person-qa-frames"
        >
          <h4 id="person-qa-frames-heading">フレーム詳細</h4>
          <ol className="person-qa-frame-list">
            {props.frame_details.map((frame, index) => (
              <li
                key={`${frame.shot_id}-${frame.timestamp_ms}-${index}`}
                tabIndex={0}
              >
                <span>
                  {frame.shot_id} @ {frame.timestamp_ms}ms — {frame.visibility}
                  {frame.face_evaluable ? ' / 顔評価可' : ' / 顔評価不可'}: {frame.reason}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {props.human_decision ? (
        <section
          aria-labelledby="person-qa-decision-heading"
          className="person-qa-decision"
          id="person-qa-human-decision"
        >
          <h4 id="person-qa-decision-heading">人の判断</h4>
          <p tabIndex={0}>
            決定: <strong>{props.human_decision.decision}</strong>
          </p>
          <p tabIndex={0}>理由: {props.human_decision.reason}</p>
          {props.human_decision.decided_at ? (
            <time dateTime={props.human_decision.decided_at}>
              判断日時: {props.human_decision.decided_at}
            </time>
          ) : null}
        </section>
      ) : (
        <section
          aria-labelledby="person-qa-decision-heading"
          className="person-qa-decision person-qa-decision-missing"
        >
          <h4 id="person-qa-decision-heading">人の判断</h4>
          <p tabIndex={0}>未記録（Gate 通過不可）</p>
        </section>
      )}

      {(props.ambiguities.length > 0 || (props.blocked_reasons?.length ?? 0) > 0) ? (
        <section aria-labelledby="person-qa-issues-heading" className="person-qa-issues">
          <h4 id="person-qa-issues-heading">曖昧さ・ブロック理由</h4>
          <ul>
            {props.ambiguities.map((item) => (
              <li key={item} tabIndex={0}>
                曖昧さ: {item}
              </li>
            ))}
            {(props.blocked_reasons ?? []).map((item) => (
              <li key={item} tabIndex={0}>
                ブロック: {item}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {props.report_href ? (
        <p>
          <a
            aria-label="人物一貫性レポートを開く"
            href={props.report_href}
            id="person-qa-report"
            rel="noreferrer"
            tabIndex={0}
            target="_blank"
          >
            レポートを開く
          </a>
        </p>
      ) : null}

      <p className="person-qa-basis" tabIndex={0}>
        評価根拠サマリー: {props.basis_summary}
      </p>
    </section>
  )
}
