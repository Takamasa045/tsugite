/**
 * Gate 2 / Gate 3 binding for person consistency reports and human decisions.
 * Automatic score thresholds are intentionally not implemented.
 */
import { createHash } from "node:crypto";
import { sha256Canonical } from "../../h3/hash.js";
import type { Issue, Result } from "../../types.js";
import { bindPersonConsistencyEvidence, resolveSafeRunArtifactPath } from "./evidence.js";
import {
  personQaHumanDecisionRecordSchema,
  type PersonConsistencyReportV1,
  type PersonConsistencyStage,
  type PersonQaHumanDecisionRecord
} from "./schema.js";
import {
  gate2AutoPassBlockedByPersonQa,
  personConsistencyRequiredForStage,
  type ProjectWithQuality
} from "./policy.js";

export type PersonQaGateApprovalPayload = {
  technical_qc_digest: string;
  semantic_report_digest: string;
  human_decision: PersonQaHumanDecisionRecord["decision"];
  reason: string;
  stage: PersonConsistencyStage;
  report_status: PersonConsistencyReportV1["status"];
};

/**
 * Human decision is required when policy enabled for the stage.
 * Report status blocked/review/not_evaluable must never auto-accept.
 */
export function parsePersonQaHumanDecision(
  input: unknown
): Result<{ decision: PersonQaHumanDecisionRecord }> {
  const parsed = personQaHumanDecisionRecordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.human_decision_invalid",
          message:
            parsed.error.issues[0]?.message
            ?? "person QA decision requires accept|revise|accept-not-evaluable and a non-empty reason"
        }
      ]
    };
  }
  return { ok: true, issues: [], decision: parsed.data };
}

/**
 * Map human person-QA decision + report status into gate-safe validation.
 * - accept: only when report.status === "ok"
 * - accept-not-evaluable: only when report.status is not_evaluable,
 *   or review where every required trait is not-evaluable (no stable/possible-drift findings)
 * - revise: always allowed
 * Never auto-accept blocked/review/not_evaluable.
 */
export function validatePersonQaDecisionAgainstReport(
  decision: PersonQaHumanDecisionRecord,
  report: PersonConsistencyReportV1
): Issue[] {
  if (decision.decision === "revise") return [];

  if (report.status === "blocked") {
    return [
      {
        code: "person_qa.auto_accept_forbidden",
        message: "blocked person consistency report cannot be accepted; use revise"
      }
    ];
  }

  if (decision.decision === "accept") {
    if (report.status !== "ok") {
      return [
        {
          code: "person_qa.auto_accept_forbidden",
          message: `report status '${report.status}' cannot be accepted; use revise or accept-not-evaluable`
        }
      ];
    }
    return [];
  }

  // accept-not-evaluable
  if (report.status === "not_evaluable") return [];

  if (report.status === "review") {
    const required = report.subjects.flatMap((subject) =>
      subject.traits.filter((trait) => trait.level === "required")
    );
    if (required.length === 0) {
      return [
        {
          code: "person_qa.accept_not_evaluable_invalid",
          message: "accept-not-evaluable on review requires at least one required trait marked not-evaluable"
        }
      ];
    }
    if (required.some((trait) => trait.status !== "not-evaluable")) {
      return [
        {
          code: "person_qa.accept_not_evaluable_invalid",
          message:
            "accept-not-evaluable on review requires every required trait to be not-evaluable (no stable/possible-drift findings)"
        }
      ];
    }
    return [];
  }

  return [
    {
      code: "person_qa.accept_not_evaluable_invalid",
      message: "accept-not-evaluable requires report status not_evaluable or review-with-not-evaluable-traits"
    }
  ];
}

export function buildPersonQaGateApprovalDigest(payload: PersonQaGateApprovalPayload): string {
  return sha256Canonical(payload);
}

export function digestTechnicalQc(qc: unknown): string {
  return sha256Canonical(qc);
}

/**
 * Full Gate approval digest contribution when person QA is required.
 * Combines technical QC digest, semantic report digest, human decision, and reason.
 */
export function buildGateApprovalWithPersonQa(options: {
  baseApprovalPayload: unknown;
  technicalQc: unknown;
  reportSha256: string;
  reportStatus: PersonConsistencyReportV1["status"];
  stage: PersonConsistencyStage;
  humanDecision: PersonQaHumanDecisionRecord;
}): { approvalDigest: string; personQaPayload: PersonQaGateApprovalPayload } {
  const personQaPayload: PersonQaGateApprovalPayload = {
    technical_qc_digest: digestTechnicalQc(options.technicalQc),
    semantic_report_digest: options.reportSha256,
    human_decision: options.humanDecision.decision,
    reason: options.humanDecision.reason,
    stage: options.stage,
    report_status: options.reportStatus
  };

  const approvalDigest = sha256Canonical({
    base: options.baseApprovalPayload,
    person_consistency: personQaPayload
  });

  return { approvalDigest, personQaPayload };
}

/**
 * Inspect person consistency evidence for gate approval.
 * Fail closed when policy requires the stage and report is missing/stale/tampered.
 */
export async function inspectPersonConsistencyForGate(options: {
  project: ProjectWithQuality;
  stage: PersonConsistencyStage;
  runDir: string;
  reportRelativePath: string;
  contactSheetRelativePath?: string;
  expectedInputDigest?: string;
  expectedReportSha256?: string;
  humanDecision?: unknown;
  /** When true, require human decision for approval path. */
  requireHumanDecision: boolean;
}): Promise<
  Result<{
    required: boolean;
    report?: PersonConsistencyReportV1;
    report_sha256?: string;
    binding?: {
      stage: PersonConsistencyStage;
      report_relative_path: string;
      report_sha256: string;
      contact_sheet_relative_path?: string;
      contact_sheet_sha256?: string;
      human_decision?: PersonQaHumanDecisionRecord;
    };
    human_decision?: PersonQaHumanDecisionRecord;
  }>
> {
  const policyEnabled = Boolean(
    options.project.quality
    && typeof options.project.quality === "object"
    && (options.project.quality as { person_consistency?: { enabled?: boolean; stages?: string[] } })
      .person_consistency?.enabled
    && (
      (options.project.quality as { person_consistency?: { stages?: string[] } })
        .person_consistency?.stages ?? []
    ).includes(options.stage)
  );

  if (!policyEnabled) {
    return { ok: true, issues: [], required: false };
  }

  const bound = await bindPersonConsistencyEvidence({
    runDir: options.runDir,
    stage: options.stage,
    reportRelativePath: options.reportRelativePath,
    contactSheetRelativePath: options.contactSheetRelativePath,
    expectedInputDigest: options.expectedInputDigest,
    expectedReportSha256: options.expectedReportSha256
  });
  if (!bound.ok) return bound;

  let human_decision: PersonQaHumanDecisionRecord | undefined;
  if (options.requireHumanDecision) {
    if (options.humanDecision === undefined) {
      return {
        ok: false,
        issues: [
          {
            code: "person_qa.human_decision_required",
            message:
              "person consistency QA requires --person-qa-decision and --person-qa-reason for this gate"
          }
        ]
      };
    }
    const parsed = parsePersonQaHumanDecision(options.humanDecision);
    if (!parsed.ok) return parsed;
    const against = validatePersonQaDecisionAgainstReport(parsed.decision, bound.report);
    if (against.length > 0) return { ok: false, issues: against };
    human_decision = parsed.decision;
  }

  return {
    ok: true,
    issues: [],
    required: true,
    report: bound.report,
    report_sha256: bound.report_sha256,
    human_decision,
    binding: {
      stage: options.stage,
      report_relative_path: bound.report_relative_path,
      report_sha256: bound.report_sha256,
      ...(bound.contact_sheet_relative_path
        ? {
            contact_sheet_relative_path: bound.contact_sheet_relative_path,
            contact_sheet_sha256: bound.contact_sheet_sha256
          }
        : {}),
      ...(human_decision ? { human_decision } : {})
    }
  };
}

export function evaluateGate2AutoPassWithPersonQa(options: {
  project: ProjectWithQuality;
  basePassed: boolean;
  baseReason?: string;
}): { passed: boolean; reason: string } {
  const blocked = gate2AutoPassBlockedByPersonQa(options.project);
  if (blocked) {
    return { passed: false, reason: blocked };
  }
  if (!options.basePassed) {
    return { passed: false, reason: options.baseReason ?? "not_configured" };
  }
  return { passed: true, reason: "ok" };
}

/**
 * Finalize revalidation: ensure bound report still matches digest and artifact integrity.
 */
export async function revalidatePersonConsistencyForFinalize(options: {
  project: ProjectWithQuality;
  stage: PersonConsistencyStage;
  runDir: string;
  reportRelativePath: string;
  expectedReportSha256: string;
  expectedInputDigest?: string;
  contactSheetRelativePath?: string;
  expectedContactSheetSha256?: string;
}): Promise<Result<{ report_sha256: string }>> {
  const inspected = await inspectPersonConsistencyForGate({
    project: options.project,
    stage: options.stage,
    runDir: options.runDir,
    reportRelativePath: options.reportRelativePath,
    contactSheetRelativePath: options.contactSheetRelativePath,
    expectedInputDigest: options.expectedInputDigest,
    expectedReportSha256: options.expectedReportSha256,
    requireHumanDecision: false
  });
  if (!inspected.ok) return inspected;
  if (!inspected.required) {
    return { ok: true, issues: [], report_sha256: options.expectedReportSha256 };
  }
  if (inspected.report_sha256 !== options.expectedReportSha256) {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.report_stale",
          message: "person consistency report changed after gate approval",
          path: options.reportRelativePath
        }
      ]
    };
  }
  return {
    ok: true,
    issues: [],
    report_sha256: inspected.report_sha256!
  };
}

/**
 * Gate approval binding persisted under the run dir.
 * Gate 3 state.approved_input_digest remains sha256(final.mp4) for launcher/finalize identity.
 * Person-QA contribution (report + decision + reason) is bound here and revalidated on finalize.
 */
export const PERSON_QA_APPROVAL_BINDING_SCHEMA =
  "person-consistency-approval-binding-v1" as const;

export type PersonQaApprovalBindingV1 = {
  schema_version: typeof PERSON_QA_APPROVAL_BINDING_SCHEMA;
  stage: PersonConsistencyStage;
  /** Gate 3 final.mp4 digest (identity stored in state.approved_input_digest). */
  final_output_sha256?: string;
  report_relative_path: string;
  semantic_report_digest: string;
  contact_sheet_relative_path?: string;
  contact_sheet_sha256?: string;
  human_decision: PersonQaHumanDecisionRecord;
  person_qa_payload: PersonQaGateApprovalPayload;
  /** Canonical digest of base output identity + person_qa_payload. */
  person_qa_approval_digest: string;
};

export function personConsistencyApprovalBindingRelativePath(
  stage: PersonConsistencyStage
): string {
  return stage === "gate_2"
    ? "qa/person-consistency/gate2/approval-binding.json"
    : "qa/person-consistency/gate3/approval-binding.json";
}

export function buildPersonQaApprovalBinding(options: {
  stage: PersonConsistencyStage;
  finalOutputSha256?: string;
  reportRelativePath: string;
  reportSha256: string;
  reportStatus: PersonConsistencyReportV1["status"];
  contactSheetRelativePath?: string;
  contactSheetSha256?: string;
  humanDecision: PersonQaHumanDecisionRecord;
  technicalQc: unknown;
  baseApprovalPayload: unknown;
}): PersonQaApprovalBindingV1 {
  const withPerson = buildGateApprovalWithPersonQa({
    baseApprovalPayload: options.baseApprovalPayload,
    technicalQc: options.technicalQc,
    reportSha256: options.reportSha256,
    reportStatus: options.reportStatus,
    stage: options.stage,
    humanDecision: options.humanDecision
  });
  return {
    schema_version: PERSON_QA_APPROVAL_BINDING_SCHEMA,
    stage: options.stage,
    ...(options.finalOutputSha256
      ? { final_output_sha256: options.finalOutputSha256 }
      : {}),
    report_relative_path: options.reportRelativePath,
    semantic_report_digest: options.reportSha256,
    ...(options.contactSheetRelativePath
      ? {
          contact_sheet_relative_path: options.contactSheetRelativePath,
          ...(options.contactSheetSha256
            ? { contact_sheet_sha256: options.contactSheetSha256 }
            : {})
        }
      : {}),
    human_decision: options.humanDecision,
    person_qa_payload: withPerson.personQaPayload,
    person_qa_approval_digest: withPerson.approvalDigest
  };
}

export async function writePersonQaApprovalBinding(options: {
  runDir: string;
  binding: PersonQaApprovalBindingV1;
}): Promise<Result<{ relativePath: string; absolutePath: string }>> {
  const relativePath = personConsistencyApprovalBindingRelativePath(options.binding.stage);
  const resolved = await resolveSafeRunArtifactPath(options.runDir, relativePath);
  if (!resolved.ok) return resolved;

  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(resolved.absolutePath), { recursive: true });
    await writeFile(
      resolved.absolutePath,
      `${JSON.stringify(options.binding, null, 2)}\n`,
      "utf8"
    );
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.binding_write_failed",
          message: error instanceof Error ? error.message : String(error),
          path: relativePath
        }
      ]
    };
  }

  return {
    ok: true,
    issues: [],
    relativePath,
    absolutePath: resolved.absolutePath
  };
}

export async function loadPersonQaApprovalBinding(options: {
  runDir: string;
  stage: PersonConsistencyStage;
}): Promise<Result<{ binding: PersonQaApprovalBindingV1; relativePath: string }>> {
  const relativePath = personConsistencyApprovalBindingRelativePath(options.stage);
  const resolved = await resolveSafeRunArtifactPath(options.runDir, relativePath);
  if (!resolved.ok) return resolved;

  let raw: string;
  try {
    const { readFile } = await import("node:fs/promises");
    raw = await readFile(resolved.absolutePath, "utf8");
  } catch {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.binding_missing",
          message: "person consistency approval binding is missing",
          path: relativePath
        }
      ]
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.binding_invalid",
          message: "person consistency approval binding is not valid JSON",
          path: relativePath
        }
      ]
    };
  }

  if (
    !parsed
    || typeof parsed !== "object"
    || (parsed as { schema_version?: string }).schema_version
      !== PERSON_QA_APPROVAL_BINDING_SCHEMA
    || (parsed as { stage?: string }).stage !== options.stage
    || typeof (parsed as { semantic_report_digest?: string }).semantic_report_digest !== "string"
    || typeof (parsed as { report_relative_path?: string }).report_relative_path !== "string"
    || typeof (parsed as { person_qa_approval_digest?: string }).person_qa_approval_digest
      !== "string"
    || !(parsed as { human_decision?: unknown }).human_decision
  ) {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.binding_invalid",
          message: "person consistency approval binding failed structural checks",
          path: relativePath
        }
      ]
    };
  }

  const decision = parsePersonQaHumanDecision(
    (parsed as { human_decision: unknown }).human_decision
  );
  if (!decision.ok) {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.binding_invalid",
          message: "person consistency approval binding has invalid human decision",
          path: relativePath
        },
        ...decision.issues
      ]
    };
  }

  return {
    ok: true,
    issues: [],
    relativePath,
    binding: parsed as PersonQaApprovalBindingV1
  };
}

/**
 * Finalize entry: when person QA is enabled for Gate 3, load binding and revalidate report.
 * Does not replace the final.mp4 identity check — call after that succeeds.
 */
export async function revalidatePersonConsistencyOnFinalize(options: {
  project: ProjectWithQuality;
  runDir: string;
  finalOutputSha256: string;
}): Promise<Result<{ report_sha256: string; person_qa_approval_digest: string }>> {
  if (!personConsistencyRequiredForStage(options.project, "gate_3")) {
    return {
      ok: true,
      issues: [],
      report_sha256: options.finalOutputSha256,
      person_qa_approval_digest: options.finalOutputSha256
    };
  }

  const loaded = await loadPersonQaApprovalBinding({
    runDir: options.runDir,
    stage: "gate_3"
  });
  if (!loaded.ok) return loaded;

  if (
    loaded.binding.final_output_sha256
    && loaded.binding.final_output_sha256 !== options.finalOutputSha256
  ) {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.binding_output_mismatch",
          message: "person consistency approval binding final_output_sha256 does not match final.mp4",
          path: loaded.relativePath
        }
      ]
    };
  }

  const revalidated = await revalidatePersonConsistencyForFinalize({
    project: options.project,
    stage: "gate_3",
    runDir: options.runDir,
    reportRelativePath: loaded.binding.report_relative_path,
    expectedReportSha256: loaded.binding.semantic_report_digest,
    contactSheetRelativePath: loaded.binding.contact_sheet_relative_path
  });
  if (!revalidated.ok) return revalidated;

  return {
    ok: true,
    issues: [],
    report_sha256: revalidated.report_sha256,
    person_qa_approval_digest: loaded.binding.person_qa_approval_digest
  };
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
