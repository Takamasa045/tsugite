/**
 * Gate 2 / Gate 3 binding for person consistency reports and human decisions.
 * Automatic score thresholds are intentionally not implemented.
 */
import { createHash } from "node:crypto";
import { sha256Canonical } from "../../h3/hash.js";
import type { Issue, Result } from "../../types.js";
import { bindPersonConsistencyEvidence, resolveSafeRunArtifactPath } from "./evidence.js";
import {
  personConsistencyStageSchema,
  personQaHumanDecisionRecordSchema,
  personQaHumanDecisionSchema,
  reportStatusSchema,
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
  /** Bound when contact-sheet evidence was present at approval time. */
  contact_sheet_relative_path?: string;
  contact_sheet_sha256?: string;
};

const PERSON_QA_APPROVAL_BINDING_TOP_LEVEL_KEYS = new Set([
  "schema_version",
  "stage",
  "final_output_sha256",
  "report_relative_path",
  "semantic_report_digest",
  "contact_sheet_relative_path",
  "contact_sheet_sha256",
  "human_decision",
  "person_qa_payload",
  "person_qa_approval_digest"
]);

const PERSON_QA_GATE_APPROVAL_PAYLOAD_KEYS = new Set([
  "technical_qc_digest",
  "semantic_report_digest",
  "human_decision",
  "reason",
  "stage",
  "report_status",
  "contact_sheet_relative_path",
  "contact_sheet_sha256"
]);

/** Same safe-relative-path rule as personConsistencyArtifactRefsSchema. */
function isSafeRelativeArtifactPath(value: unknown): value is string {
  return (
    typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !value.includes("..")
    && !value.includes("\\")
  );
}

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
/**
 * Outer gate decision must not record approved when person-QA is revise.
 * revise is a valid person-QA outcome but must not advance Gate 2/3.
 */
export function issuesForOuterGateWithPersonQaDecision(
  outerDecision: string,
  personQaDecision: PersonQaHumanDecisionRecord | undefined
): Issue[] {
  if (outerDecision === "approved" && personQaDecision?.decision === "revise") {
    return [
      {
        code: "person_qa.revise_blocks_outer_approval",
        message:
          "person-qa-decision 'revise' cannot approve the outer gate; use --decision revise or an accept decision"
      }
    ];
  }
  return [];
}

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
  contactSheetRelativePath?: string;
  contactSheetSha256?: string;
}): { approvalDigest: string; personQaPayload: PersonQaGateApprovalPayload } {
  const personQaPayload: PersonQaGateApprovalPayload = {
    technical_qc_digest: digestTechnicalQc(options.technicalQc),
    semantic_report_digest: options.reportSha256,
    human_decision: options.humanDecision.decision,
    reason: options.humanDecision.reason,
    stage: options.stage,
    report_status: options.reportStatus,
    ...(options.contactSheetRelativePath && options.contactSheetSha256
      ? {
          contact_sheet_relative_path: options.contactSheetRelativePath,
          contact_sheet_sha256: options.contactSheetSha256
        }
      : {})
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
  if (options.expectedContactSheetSha256) {
    const actual = inspected.binding?.contact_sheet_sha256;
    if (actual !== options.expectedContactSheetSha256) {
      return {
        ok: false,
        issues: [
          {
            code: "person_qa.contact_sheet_stale",
            message: "person consistency contact sheet changed after gate approval",
            path: options.contactSheetRelativePath
              ?? inspected.binding?.contact_sheet_relative_path
          }
        ]
      };
    }
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
    humanDecision: options.humanDecision,
    contactSheetRelativePath: options.contactSheetRelativePath,
    contactSheetSha256: options.contactSheetSha256
  });
  const contactBound =
    typeof withPerson.personQaPayload.contact_sheet_relative_path === "string"
    && typeof withPerson.personQaPayload.contact_sheet_sha256 === "string";
  return {
    schema_version: PERSON_QA_APPROVAL_BINDING_SCHEMA,
    stage: options.stage,
    ...(options.finalOutputSha256
      ? { final_output_sha256: options.finalOutputSha256 }
      : {}),
    report_relative_path: options.reportRelativePath,
    semantic_report_digest: options.reportSha256,
    ...(contactBound
      ? {
          contact_sheet_relative_path: withPerson.personQaPayload.contact_sheet_relative_path,
          contact_sheet_sha256: withPerson.personQaPayload.contact_sheet_sha256
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

const SHA256_HEX = /^[a-f0-9]{64}$/;

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function bindingInvalid(relativePath: string, message: string): Result<{ binding: PersonQaApprovalBindingV1 }> {
  return {
    ok: false,
    issues: [
      {
        code: "person_qa.binding_invalid",
        message,
        path: relativePath
      }
    ]
  };
}

/**
 * Strict structural validation of a loaded approval binding.
 * human_decision must exactly match person_qa_payload decision/reason/stage/report_status.
 * Contact-sheet top-level fields must match person_qa_payload when present.
 * Unknown top-level or payload keys are rejected.
 */
function validatePersonQaApprovalBindingStructure(
  parsed: unknown,
  stage: PersonConsistencyStage,
  relativePath: string
): Result<{ binding: PersonQaApprovalBindingV1 }> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return bindingInvalid(
      relativePath,
      "person consistency approval binding failed structural checks"
    );
  }

  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PERSON_QA_APPROVAL_BINDING_TOP_LEVEL_KEYS.has(key)) {
      return bindingInvalid(
        relativePath,
        `person consistency approval binding has unknown top-level field '${key}'`
      );
    }
  }

  if (
    record.schema_version !== PERSON_QA_APPROVAL_BINDING_SCHEMA
    || !personConsistencyStageSchema.safeParse(record.stage).success
    || record.stage !== stage
    || !isSafeRelativeArtifactPath(record.report_relative_path)
    || !isSha256Hex(record.semantic_report_digest)
    || !isSha256Hex(record.person_qa_approval_digest)
  ) {
    return bindingInvalid(
      relativePath,
      "person consistency approval binding failed structural checks"
    );
  }

  if (record.final_output_sha256 !== undefined && !isSha256Hex(record.final_output_sha256)) {
    return bindingInvalid(
      relativePath,
      "person consistency approval binding final_output_sha256 is not a valid sha256"
    );
  }

  const hasTopContactPath = record.contact_sheet_relative_path !== undefined;
  const hasTopContactSha = record.contact_sheet_sha256 !== undefined;
  if (hasTopContactPath !== hasTopContactSha) {
    return bindingInvalid(
      relativePath,
      "person consistency approval binding contact sheet path and sha256 must both be present or both absent"
    );
  }
  if (hasTopContactPath) {
    if (!isSafeRelativeArtifactPath(record.contact_sheet_relative_path)) {
      return bindingInvalid(
        relativePath,
        "person consistency approval binding contact_sheet_relative_path is not a safe relative path"
      );
    }
    if (!isSha256Hex(record.contact_sheet_sha256)) {
      return bindingInvalid(
        relativePath,
        "person consistency approval binding contact_sheet_sha256 is not a valid sha256"
      );
    }
  }

  const decision = parsePersonQaHumanDecision(record.human_decision);
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

  const payload = record.person_qa_payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return bindingInvalid(
      relativePath,
      "person consistency approval binding person_qa_payload is missing"
    );
  }

  const personQaPayload = payload as Record<string, unknown>;
  for (const key of Object.keys(personQaPayload)) {
    if (!PERSON_QA_GATE_APPROVAL_PAYLOAD_KEYS.has(key)) {
      return bindingInvalid(
        relativePath,
        `person consistency approval binding person_qa_payload has unknown field '${key}'`
      );
    }
  }

  const reportStatusParsed = reportStatusSchema.safeParse(personQaPayload.report_status);
  const humanDecisionParsed = personQaHumanDecisionSchema.safeParse(personQaPayload.human_decision);
  if (
    !isSha256Hex(personQaPayload.technical_qc_digest)
    || !isSha256Hex(personQaPayload.semantic_report_digest)
    || !humanDecisionParsed.success
    || typeof personQaPayload.reason !== "string"
    || personQaPayload.reason.trim().length === 0
    || !personConsistencyStageSchema.safeParse(personQaPayload.stage).success
    || personQaPayload.stage !== stage
    || !reportStatusParsed.success
  ) {
    return bindingInvalid(
      relativePath,
      "person consistency approval binding person_qa_payload failed structural checks"
    );
  }

  const hasPayloadContactPath = personQaPayload.contact_sheet_relative_path !== undefined;
  const hasPayloadContactSha = personQaPayload.contact_sheet_sha256 !== undefined;
  if (hasPayloadContactPath !== hasPayloadContactSha) {
    return bindingInvalid(
      relativePath,
      "person consistency approval binding person_qa_payload contact sheet path and sha256 must both be present or both absent"
    );
  }
  if (hasPayloadContactPath) {
    if (!isSafeRelativeArtifactPath(personQaPayload.contact_sheet_relative_path)) {
      return bindingInvalid(
        relativePath,
        "person consistency approval binding person_qa_payload contact_sheet_relative_path is not a safe relative path"
      );
    }
    if (!isSha256Hex(personQaPayload.contact_sheet_sha256)) {
      return bindingInvalid(
        relativePath,
        "person consistency approval binding person_qa_payload contact_sheet_sha256 is not a valid sha256"
      );
    }
  }

  // Top-level contact sheet fields must exactly match the payload snapshot used for the digest.
  if (
    record.contact_sheet_relative_path !== personQaPayload.contact_sheet_relative_path
    || record.contact_sheet_sha256 !== personQaPayload.contact_sheet_sha256
  ) {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.binding_tampered",
          message:
            "person consistency approval binding contact sheet fields do not match person_qa_payload",
          path: relativePath
        }
      ]
    };
  }

  // human_decision must exactly match the payload snapshot used for the approval digest.
  if (
    decision.decision.decision !== humanDecisionParsed.data
    || decision.decision.reason !== personQaPayload.reason
    || personQaPayload.semantic_report_digest !== record.semantic_report_digest
  ) {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.binding_tampered",
          message:
            "person consistency approval binding human_decision does not match person_qa_payload",
          path: relativePath
        }
      ]
    };
  }

  const payloadContactPath = personQaPayload.contact_sheet_relative_path;
  const payloadContactSha = personQaPayload.contact_sheet_sha256;
  const topContactPath = record.contact_sheet_relative_path;
  const topContactSha = record.contact_sheet_sha256;

  const normalizedPayload: PersonQaGateApprovalPayload = {
    technical_qc_digest: personQaPayload.technical_qc_digest,
    semantic_report_digest: personQaPayload.semantic_report_digest,
    human_decision: humanDecisionParsed.data,
    reason: personQaPayload.reason,
    stage,
    report_status: reportStatusParsed.data,
    ...(isSafeRelativeArtifactPath(payloadContactPath) && isSha256Hex(payloadContactSha)
      ? {
          contact_sheet_relative_path: payloadContactPath,
          contact_sheet_sha256: payloadContactSha
        }
      : {})
  };

  return {
    ok: true,
    issues: [],
    binding: {
      schema_version: PERSON_QA_APPROVAL_BINDING_SCHEMA,
      stage,
      ...(isSha256Hex(record.final_output_sha256)
        ? { final_output_sha256: record.final_output_sha256 }
        : {}),
      report_relative_path: record.report_relative_path,
      semantic_report_digest: record.semantic_report_digest,
      ...(isSafeRelativeArtifactPath(topContactPath) && isSha256Hex(topContactSha)
        ? {
            contact_sheet_relative_path: topContactPath,
            contact_sheet_sha256: topContactSha
          }
        : {}),
      human_decision: decision.decision,
      person_qa_payload: normalizedPayload,
      person_qa_approval_digest: record.person_qa_approval_digest
    }
  };
}

/**
 * Recompute Gate 3 canonical person-QA approval digest from final.mp4 identity + payload.
 * Must match buildPersonQaApprovalBinding({ baseApprovalPayload: { final_output_sha256 } }).
 */
export function recomputeGate3PersonQaApprovalDigest(options: {
  finalOutputSha256: string;
  personQaPayload: PersonQaGateApprovalPayload;
}): string {
  return sha256Canonical({
    base: { final_output_sha256: options.finalOutputSha256 },
    person_consistency: options.personQaPayload
  });
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

  const validated = validatePersonQaApprovalBindingStructure(parsed, options.stage, relativePath);
  if (!validated.ok) return validated;

  return {
    ok: true,
    issues: [],
    relativePath,
    binding: validated.binding
  };
}

/**
 * Finalize entry: when person QA is enabled for Gate 3, load binding and revalidate report.
 * Does not replace the final.mp4 identity check — call after that succeeds.
 * When QA is required, expectedPersonQaApprovalDigest from Gate 3 state is mandatory (fail closed).
 */
export async function revalidatePersonConsistencyOnFinalize(options: {
  project: ProjectWithQuality;
  runDir: string;
  finalOutputSha256: string;
  /** Approval-time digest from state.gates.gate_3.person_qa_approval_digest */
  expectedPersonQaApprovalDigest?: string;
}): Promise<Result<{ report_sha256: string; person_qa_approval_digest: string }>> {
  if (!personConsistencyRequiredForStage(options.project, "gate_3")) {
    return {
      ok: true,
      issues: [],
      report_sha256: options.finalOutputSha256,
      person_qa_approval_digest: options.finalOutputSha256
    };
  }

  if (!options.expectedPersonQaApprovalDigest || !isSha256Hex(options.expectedPersonQaApprovalDigest)) {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.expected_approval_digest_missing",
          message:
            "person consistency finalize requires state.gates.gate_3.person_qa_approval_digest from approval time"
        }
      ]
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
    contactSheetRelativePath: loaded.binding.contact_sheet_relative_path,
    expectedContactSheetSha256: loaded.binding.contact_sheet_sha256
  });
  if (!revalidated.ok) return revalidated;

  // Recompute canonical Gate 3 digest from known final.mp4 + stored payload; reject forgeries.
  const recomputed = recomputeGate3PersonQaApprovalDigest({
    finalOutputSha256: options.finalOutputSha256,
    personQaPayload: loaded.binding.person_qa_payload
  });
  if (
    recomputed !== loaded.binding.person_qa_approval_digest
    || recomputed !== options.expectedPersonQaApprovalDigest
  ) {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.approval_digest_mismatch",
          message:
            "person consistency approval digest does not match binding payload and/or Gate 3 expected digest",
          path: loaded.relativePath
        }
      ]
    };
  }

  return {
    ok: true,
    issues: [],
    report_sha256: revalidated.report_sha256,
    person_qa_approval_digest: recomputed
  };
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
