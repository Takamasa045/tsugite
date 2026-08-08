/**
 * Viewer-facing person consistency detail data contract.
 * Large UI rewrites are out of scope; this provides status/basis/traits/coverage/links
 * that the Workflow Viewer Gate detail can render without hover-only interactions.
 */
import type { PersonConsistencyReportV1, PersonConsistencyStage } from "./schema.js";

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
};

const STATUS_LABELS: Record<string, string> = {
  ok: "OK（評価可能・重大な曖昧さなし）",
  review: "要レビュー（人が判断）",
  not_evaluable: "評価不能（失敗ではない）",
  blocked: "ブロック（自動判定不可）"
};

export function toViewerPersonConsistencyEvidence(
  report: PersonConsistencyReportV1,
  options: {
    reportHref?: string;
    contactSheetHref?: string;
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
      summary_text: `${status_label}。根拠: ${basisSet.join(" / ") || "なし"}。対象人物: ${subjectNames}。曖昧さ: ${report.ambiguities.length}件。`
    }
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
    ...(evidence.contact_sheet_href ? [`コンタクトシート: ${evidence.contact_sheet_href}`] : [])
  ];
}
