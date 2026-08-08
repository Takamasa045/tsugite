/**
 * Viewer-facing person consistency detail data contract.
 * Large UI rewrites are out of scope; this provides status/basis/traits/coverage/links
 * that the Workflow Viewer Gate detail can render without hover-only interactions.
 * P5 adds optional evidence integrity / analyzer / human-decision fields (compatible).
 */
import type {
  PersonConsistencyReportV1,
  PersonConsistencyStage,
  PersonQaHumanDecisionRecord
} from "./schema.js";

export type ViewerPersonConsistencyTrait = {
  trait: string;
  status: string;
  level: string;
  notes?: string;
};

export type ViewerPersonConsistencySubject = {
  subject_id: string;
  basis: string;
  evaluable_coverage: number;
  traits: ViewerPersonConsistencyTrait[];
  ambiguity_codes: string[];
  observation_count: number;
  face_evaluable_count: number;
};

export type ViewerEvidenceIntegrity = "valid" | "tampered" | "invalid" | "not-verified";

export type ViewerAnalyzerStatus = {
  status: "ok" | "not-run" | "needs-human-review" | "failed";
  label: string;
  needs_human_review: boolean;
};

export type ViewerPersonConsistencyFrameDetail = {
  timestamp_ms: number;
  shot_id: string;
  visibility: string;
  face_evaluable: boolean;
  reason: string;
};

export type ViewerPersonConsistencyEvidence = {
  stage: PersonConsistencyStage;
  status: string;
  basis_summary: string;
  subjects: ViewerPersonConsistencySubject[];
  ambiguities: string[];
  blocked_reasons: string[];
  contact_sheet_href?: string;
  contact_sheet_alt: string;
  report_href?: string;
  keyboard_targets: Array<{
    id: string;
    label: string;
    href?: string;
    description: string;
  }>;
  /** Status labels must not rely on color alone. */
  status_label: string;
  a11y: {
    status_text: string;
    summary_text: string;
  };
  /** P5: hash verification result before load. Viewer never auto-passes on invalid. */
  evidence_integrity?: ViewerEvidenceIntegrity;
  evidence_integrity_label?: string;
  analyzer?: ViewerAnalyzerStatus;
  human_decision?: PersonQaHumanDecisionRecord;
  /** Per-observation frame details for keyboard-reachable listing. */
  frame_details?: ViewerPersonConsistencyFrameDetail[];
  automatic_score_note?: string;
};

const STATUS_LABELS: Record<string, string> = {
  ok: "OK（評価可能・重大な曖昧さなし）",
  review: "要レビュー（人が判断）",
  not_evaluable: "評価不能（失敗ではない）",
  blocked: "ブロック（自動判定不可）"
};

const INTEGRITY_LABELS: Record<ViewerEvidenceIntegrity, string> = {
  valid: "証跡ハッシュ検証: 有効",
  tampered: "証跡ハッシュ検証: 改ざん検出（自動合格にしない）",
  invalid: "証跡ハッシュ検証: 無効（自動合格にしない）",
  "not-verified": "証跡ハッシュ検証: 未検証"
};

const ANALYZER_LABELS: Record<ViewerAnalyzerStatus["status"], string> = {
  ok: "解析器: 実行済み",
  "not-run": "解析器: 未実行（人手レビュー要）",
  "needs-human-review": "解析器: 人手レビュー要",
  failed: "解析器: 失敗（人手レビュー要）"
};

export function toViewerPersonConsistencyEvidence(
  report: PersonConsistencyReportV1,
  options: {
    reportHref?: string;
    contactSheetHref?: string;
    evidenceIntegrity?: ViewerEvidenceIntegrity;
    analyzerStatus?: ViewerAnalyzerStatus["status"];
    humanDecision?: PersonQaHumanDecisionRecord;
  } = {}
): ViewerPersonConsistencyEvidence {
  const subjects = report.subjects.map((subject) => {
    const face_evaluable_count = subject.observations.filter((item) => item.face_evaluable).length;
    return {
      subject_id: subject.subject_id,
      basis: subject.basis,
      evaluable_coverage: subject.evaluable_coverage,
      traits: subject.traits.map((trait) => ({
        trait: trait.trait,
        status: trait.status,
        level: trait.level,
        ...(trait.notes ? { notes: trait.notes } : {})
      })),
      ambiguity_codes: subject.ambiguity_codes,
      observation_count: subject.observations.length,
      face_evaluable_count
    };
  });

  const basisSet = [...new Set(subjects.map((subject) => subject.basis))];
  const status_label = STATUS_LABELS[report.status] ?? report.status;
  const subjectNames = subjects.map((subject) => subject.subject_id).join("、") || "なし";

  const contact_sheet_alt = subjects.length
    ? `人物一貫性コンタクトシート: 対象 ${subjectNames}、stage ${report.stage}、状態 ${status_label}`
    : `人物一貫性コンタクトシート: stage ${report.stage}、状態 ${status_label}`;

  const keyboard_targets: ViewerPersonConsistencyEvidence["keyboard_targets"] = [
    {
      id: "person-qa-report",
      label: "人物一貫性レポート",
      href: options.reportHref,
      description: `status ${report.status} / ${subjects.length} subjects`
    }
  ];
  if (options.contactSheetHref || report.artifacts.contact_sheet_relative_path) {
    keyboard_targets.push({
      id: "person-qa-contact-sheet",
      label: "コンタクトシート",
      href: options.contactSheetHref,
      description: contact_sheet_alt
    });
  }
  for (const subject of subjects) {
    keyboard_targets.push({
      id: `person-qa-subject-${subject.subject_id}`,
      label: `Subject ${subject.subject_id}`,
      description: `basis ${subject.basis}, coverage ${Math.round(subject.evaluable_coverage * 100)}%, face-evaluable ${subject.face_evaluable_count}/${subject.observation_count}`
    });
  }

  const evidence_integrity = options.evidenceIntegrity ?? "not-verified";
  const evidence_integrity_label = INTEGRITY_LABELS[evidence_integrity];
  const analyzerStatus = options.analyzerStatus ?? "not-run";
  const analyzer: ViewerAnalyzerStatus = {
    status: analyzerStatus,
    label: ANALYZER_LABELS[analyzerStatus],
    needs_human_review: analyzerStatus !== "ok"
  };

  const frame_details: ViewerPersonConsistencyFrameDetail[] = report.subjects.flatMap((subject) =>
    subject.observations.map((observation) => ({
      timestamp_ms: observation.timestamp_ms,
      shot_id: observation.shot_id,
      visibility: observation.visibility,
      face_evaluable: observation.face_evaluable,
      reason: observation.reason
    }))
  );

  keyboard_targets.push({
    id: "person-qa-evidence-integrity",
    label: "証跡整合性",
    description: evidence_integrity_label
  });
  keyboard_targets.push({
    id: "person-qa-analyzer",
    label: "解析器状態",
    description: analyzer.label
  });
  if (options.humanDecision) {
    keyboard_targets.push({
      id: "person-qa-human-decision",
      label: "人の判断",
      description: `${options.humanDecision.decision}: ${options.humanDecision.reason}`
    });
  }

  return {
    stage: report.stage,
    status: report.status,
    basis_summary: basisSet.join(", ") || "n/a",
    subjects,
    ambiguities: report.ambiguities,
    blocked_reasons: report.blocked_reasons,
    ...(options.contactSheetHref ? { contact_sheet_href: options.contactSheetHref } : {}),
    contact_sheet_alt,
    ...(options.reportHref ? { report_href: options.reportHref } : {}),
    keyboard_targets,
    status_label,
    a11y: {
      status_text: status_label,
      summary_text: `${status_label}。${evidence_integrity_label}。${analyzer.label}。根拠: ${basisSet.join(" / ") || "なし"}。対象人物: ${subjectNames}。曖昧さ: ${report.ambiguities.length}件。`
    },
    evidence_integrity,
    evidence_integrity_label,
    analyzer,
    ...(options.humanDecision ? { human_decision: options.humanDecision } : {}),
    frame_details,
    automatic_score_note: "自動scoreは参考情報のみ。Gate通過には人の判断と証跡digestが必要です。"
  };
}

/**
 * Merge person QA evidence into Gate detail facts for keyboard-reachable listing.
 */
export function personConsistencyDetailFacts(
  evidence: ViewerPersonConsistencyEvidence
): string[] {
  return [
    `人物一貫性: ${evidence.status_label}`,
    `評価根拠: ${evidence.basis_summary}`,
    `対象人物: ${evidence.subjects.map((subject) => subject.subject_id).join("、") || "なし"}`,
    `評価可能カバレッジ: ${evidence.subjects
      .map((subject) => `${subject.subject_id}=${Math.round(subject.evaluable_coverage * 100)}%`)
      .join("、") || "n/a"}`,
    `曖昧さ: ${evidence.ambiguities.length ? evidence.ambiguities.join("、") : "なし"}`,
    ...(evidence.evidence_integrity_label
      ? [`証跡整合性: ${evidence.evidence_integrity_label}`]
      : []),
    ...(evidence.analyzer ? [`解析器: ${evidence.analyzer.label}`] : []),
    ...(evidence.human_decision
      ? [`人の判断: ${evidence.human_decision.decision}（${evidence.human_decision.reason}）`]
      : []),
    ...(evidence.contact_sheet_href ? [`コンタクトシート: ${evidence.contact_sheet_href}`] : [])
  ];
}
