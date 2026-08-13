import { sha256Bytes, sha256Canonical } from "../productionControl/canonical.js";
import { pcError } from "../productionControl/errors.js";
import {
  digestRefSchema,
  humanDecisionRefSchema,
  safeIdSchema,
  type DigestRef,
  type HumanDecisionRef
} from "../productionControl/schema.js";
import {
  identityDefinitionSchema,
  identityVerificationSchema,
  lockedTextSchema,
  type IdentityDefinition,
  type IdentityVerification,
  type IdentityVerificationRequirements,
  type LockedText
} from "./schema.js";

export type IdentityMigrationIssue = {
  code:
    | "identity.lock_hash_mismatch"
    | "identity.variant_asset_unknown"
    | "identity.definition_confirmation_missing"
    | "identity.verification_missing_evidence"
    | "identity.verification_decision_missing"
    | "identity.verification_status_missing"
    | "identity.verification_requirements_unknown"
    | "identity.legacy_flag_not_authoritative";
  message: string;
};

export type LegacyIdentityVerificationInput = {
  selected_output_refs?: DigestRef[];
  required_condition_ids?: string[];
  evaluated_condition_ids?: string[];
  evaluations?: Array<{
    condition_id: string;
    output_refs: DigestRef[];
    evidence_artifact_refs: DigestRef[];
    result: "pass" | "drift" | "not-evaluable";
  }>;
  status?: "verified" | "residual-risk-accepted" | "rejected" | "not-evaluable";
  coverage_basis?: "multiple-shots" | "multiple-conditions";
  distinct_output_count?: number;
  distinct_condition_count?: number;
  risk_class?: "low";
  residual_drifts?: string[];
  acceptance_scope?: string;
  rejection_reasons?: string[];
  blocking_reasons?: string[];
  decision?: HumanDecisionRef;
};

export type IdentityMigrationInput = {
  ir: unknown;
  production_id: string;
  contract_id?: string;
  revision?: number;
  asset_digests?: Record<string, string>;
  definition_confirmation?: HumanDecisionRef;
  verification_requirements?: IdentityVerificationRequirements;
  verification?: LegacyIdentityVerificationInput;
};

export type IdentityMigrationResult = {
  status: "not_applicable" | "awaiting_human" | "migrated" | "blocked";
  definition?: IdentityDefinition;
  verification?: IdentityVerification;
  issues: IdentityMigrationIssue[];
  legacy_evidence: {
    locked_flag_seen: boolean;
    locked_block_count: number;
    verification_candidate_seen: boolean;
  };
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function digestRefIdentity(ref: DigestRef): string {
  return `${ref.kind}\u0000${ref.id}\u0000${ref.digest}`;
}

function lockedText(value: unknown, issues: IdentityMigrationIssue[]): LockedText | undefined {
  const source = record(value);
  if (!source || typeof source.text !== "string" || typeof source.sha256 !== "string") return undefined;
  try {
    return lockedTextSchema.parse({ text: source.text, sha256: source.sha256 });
  } catch {
    issues.push({ code: "identity.lock_hash_mismatch", message: "existing locked block hash does not match its exact text" });
    return undefined;
  }
}

function derivedLockedText(value: unknown): LockedText | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return { text: value, sha256: sha256Bytes(new TextEncoder().encode(value)) };
}

function defaultRequirements(ir: Record<string, unknown>, issues: IdentityMigrationIssue[]): IdentityVerificationRequirements | undefined {
  const conditions: IdentityVerificationRequirements["conditions"] = [];
  const shots = Array.isArray(ir.shots) ? ir.shots : [];
  for (const shot of shots) {
    const shotRecord = record(shot);
    if (!shotRecord || !Array.isArray(shotRecord.subject_expectations)) continue;
    const subjectIds = shotRecord.subject_expectations
      .map((entry) => record(entry)?.subject_id)
      .filter((value): value is string => typeof value === "string");
    if (subjectIds.length === 0) continue;
    const conditionId = typeof shotRecord.id === "string" ? `shot-${shotRecord.id}` : undefined;
    if (!conditionId) continue;
    conditions.push({
      condition_id: conditionId,
      description: `legacy subject expectation for ${conditionId}`,
      subject_ids: [...new Set(subjectIds)]
    });
  }
  if (conditions.length === 0) {
    issues.push({ code: "identity.verification_requirements_unknown", message: "legacy identity verification conditions cannot be proven" });
    return undefined;
  }
  return {
    risk_class: "medium",
    conditions,
    minimum_distinct_outputs: 2,
    minimum_distinct_conditions: Math.min(2, conditions.length)
  };
}

function buildDefinition(input: IdentityMigrationInput, issues: IdentityMigrationIssue[]): IdentityDefinition | undefined {
  const ir = record(input.ir);
  if (!ir) throw pcError("PC_CONTRACT_INVALID", "identity migration requires an IR object");
  const subjectsRaw = Array.isArray(ir.subjects) ? ir.subjects : [];
  const scenesRaw = Array.isArray(ir.scenes) ? ir.scenes : [];
  if (subjectsRaw.length === 0 && scenesRaw.length === 0) return undefined;
  const contractId = safeIdSchema.parse(input.contract_id ?? `${input.production_id}.identity`);
  const assetDigests = input.asset_digests ?? {};
  let lockedBlockCount = 0;
  const subjects = subjectsRaw.map((rawSubject) => {
    const source = record(rawSubject) ?? {};
    const blocks = record(source.locked_blocks) ?? {};
    const locked_blocks: IdentityDefinition["subjects"][number]["locked_blocks"] = {};
    for (const field of ["voice", "appearance", "manner"] as const) {
      const value = lockedText(blocks[field], issues);
      if (value) {
        locked_blocks[field] = value;
        lockedBlockCount += 1;
      }
    }
    const variants = (Array.isArray(source.variants) ? source.variants : []).flatMap((rawVariant) => {
      const variant = record(rawVariant);
      const id = variant?.id;
      const sourceAsset = variant?.source_asset;
      if (typeof id !== "string" || typeof sourceAsset !== "string") return [];
      const assetDigest = assetDigests[sourceAsset];
      if (!assetDigest) {
        issues.push({ code: "identity.variant_asset_unknown", message: `variant '${id}' has no verified local asset digest` });
        return [];
      }
      return [{ id, source_asset_id: sourceAsset, asset_digest: assetDigest }];
    });
    return {
      id: source.id,
      locked_blocks,
      variants
    };
  });
  const scenes = scenesRaw.map((rawScene) => {
    const source = record(rawScene) ?? {};
    const locationMap = derivedLockedText(source.location_map);
    const palette = derivedLockedText(source.palette);
    const wardrobe = derivedLockedText(source.wardrobe);
    return {
      id: source.id,
      ...(locationMap ? { location_map: locationMap } : {}),
      ...(palette ? { palette } : {}),
      ...(wardrobe ? { wardrobe } : {}),
      props: Array.isArray(source.props) ? source.props.filter((value): value is string => typeof value === "string") : [],
      ...(typeof source.time_of_day === "string" ? { time_of_day: source.time_of_day } : {}),
      ...(typeof source.screen_direction === "string" ? { screen_direction: source.screen_direction } : {}),
      active_subjects: Array.isArray(source.active_subjects)
        ? source.active_subjects.filter((value): value is string => typeof value === "string")
        : []
    };
  });
  const requirements = input.verification_requirements
    ?? defaultRequirements(ir, issues)
    ?? {
      risk_class: "medium" as const,
      conditions: [{ condition_id: "identity-condition-unknown", description: "human must define verification conditions", subject_ids: subjects.map((subject) => subject.id) }],
      minimum_distinct_outputs: 2,
      minimum_distinct_conditions: 2
    };
  const definitionStatus = input.definition_confirmation ? "confirmed" as const : "awaiting_human" as const;
  const content = {
    schema_version: 1 as const,
    contract_id: contractId,
    revision: input.revision ?? 0,
    subjects,
    scenes,
    verification_requirements: requirements,
    definition_status: definitionStatus,
    ...(input.definition_confirmation ? { definition_confirmation: input.definition_confirmation } : {})
  };
  const { definition_confirmation: _confirmation, ...definitionSubject } = content;
  const definitionDigest = sha256Canonical(definitionSubject);
  const definition = {
    ...content,
    definition_digest: definitionDigest,
    digest: sha256Canonical({ ...content, definition_digest: definitionDigest })
  };
  try {
    return identityDefinitionSchema.parse(definition);
  } catch (error) {
    if (input.definition_confirmation) issues.push({ code: "identity.definition_confirmation_missing", message: "definition confirmation does not match the migrated definition" });
    else issues.push({ code: "identity.definition_confirmation_missing", message: "identity definition remains awaiting human confirmation" });
    const { definition_confirmation: _confirmation, ...withoutConfirmation } = content;
    const awaiting = { ...withoutConfirmation, definition_status: "awaiting_human" as const };
    const awaitingDefinitionDigest = sha256Canonical(awaiting);
    return identityDefinitionSchema.parse({
      ...awaiting,
      definition_digest: awaitingDefinitionDigest,
      digest: sha256Canonical({ ...awaiting, definition_digest: awaitingDefinitionDigest })
    });
  }
}

function buildVerification(
  input: IdentityMigrationInput,
  definition: IdentityDefinition,
  issues: IdentityMigrationIssue[]
): IdentityVerification | undefined {
  if (definition.definition_status !== "confirmed" || !definition.definition_confirmation) {
    issues.push({ code: "identity.definition_confirmation_missing", message: "verification cannot be migrated before the identity definition is human-confirmed" });
    return undefined;
  }
  const candidate = input.verification;
  if (!candidate) {
    issues.push({ code: "identity.verification_missing_evidence", message: "selected output and evidence are not available for migration" });
    return undefined;
  }
  if (!candidate.decision) {
    issues.push({ code: "identity.verification_decision_missing", message: "identity verification requires an explicit human decision" });
    return undefined;
  }
  if (!candidate.status) {
    issues.push({ code: "identity.verification_status_missing", message: "identity verification status must be explicit; verified cannot be inferred" });
    return undefined;
  }
  const selected = (candidate.selected_output_refs ?? []).map((ref) => digestRefSchema.parse(ref));
  const evaluations = (candidate.evaluations ?? []).map((evaluation) => ({
    condition_id: safeIdSchema.parse(evaluation.condition_id),
    output_refs: evaluation.output_refs.map((ref) => digestRefSchema.parse(ref)),
    evidence_artifact_refs: evaluation.evidence_artifact_refs.map((ref) => digestRefSchema.parse(ref)),
    result: evaluation.result
  }));
  if (selected.length === 0 || evaluations.length === 0 || evaluations.some((evaluation) => evaluation.evidence_artifact_refs.length === 0)) {
    issues.push({ code: "identity.verification_missing_evidence", message: "verification requires selected outputs and evidence for every evaluated condition" });
    return undefined;
  }
  const required = candidate.required_condition_ids ?? definition.verification_requirements.conditions.map((condition) => condition.condition_id);
  const evaluated = candidate.evaluated_condition_ids ?? evaluations.map((evaluation) => evaluation.condition_id);
  const requiredDefinitionIds = definition.verification_requirements.conditions.map((condition) => condition.condition_id);
  if (required.length !== requiredDefinitionIds.length
    || required.some((conditionId) => !requiredDefinitionIds.includes(conditionId))) {
    issues.push({ code: "identity.verification_requirements_unknown", message: "verification report cannot reduce the confirmed definition requirements" });
    return undefined;
  }
  if (evaluated.some((conditionId) => !requiredDefinitionIds.includes(conditionId))) {
    issues.push({ code: "identity.verification_requirements_unknown", message: "verification report references an undeclared condition" });
    return undefined;
  }
  const status = candidate.status;
  if (status === "verified" && (
    new Set(selected.map(digestRefIdentity)).size < definition.verification_requirements.minimum_distinct_outputs
    || new Set(evaluated).size < definition.verification_requirements.minimum_distinct_conditions
    || evaluations.some((evaluation) => evaluation.result !== "pass")
  )) {
    issues.push({ code: "identity.verification_missing_evidence", message: "verified status does not meet the definition coverage requirements" });
    return undefined;
  }
  if (status === "residual-risk-accepted" && definition.verification_requirements.risk_class !== "low") {
    issues.push({ code: "identity.verification_requirements_unknown", message: "residual risk acceptance is limited to low-risk identity definitions" });
    return undefined;
  }
  const statusFields = status === "verified"
    ? {
        status,
        coverage_basis: candidate.coverage_basis ?? "multiple-conditions" as const,
        distinct_output_count: candidate.distinct_output_count ?? new Set(selected.map((ref) => ref.id)).size,
        distinct_condition_count: candidate.distinct_condition_count ?? new Set(evaluated).size,
        decision: candidate.decision
      }
    : status === "residual-risk-accepted"
      ? { status, risk_class: "low" as const, residual_drifts: candidate.residual_drifts ?? ["legacy residual risk"], acceptance_scope: candidate.acceptance_scope ?? "legacy migration scope", decision: candidate.decision }
      : status === "rejected"
        ? { status, rejection_reasons: candidate.rejection_reasons ?? ["legacy identity verification rejected"], decision: candidate.decision }
        : { status: "not-evaluable" as const, blocking_reasons: candidate.blocking_reasons ?? ["identity verification coverage is insufficient"], decision: candidate.decision };
  const base = {
    schema_version: 1 as const,
    production_id: input.production_id,
    identity_definition_digest: definition.definition_digest,
    selected_output_refs: selected,
    required_condition_ids: required,
    evaluated_condition_ids: evaluated,
    evaluations,
    ...statusFields
  };
  const { decision: _decision, ...subject } = base;
  const subjectDigest = sha256Canonical(subject);
  const report = {
    ...base,
    verification_subject_digest: subjectDigest,
    digest: sha256Canonical({ ...base, verification_subject_digest: subjectDigest })
  };
  try {
    return identityVerificationSchema.parse(report);
  } catch {
    issues.push({ code: "identity.verification_missing_evidence", message: "legacy verification evidence does not satisfy the strict report contract" });
    return undefined;
  }
}

export function migrateIdentityLockPhaseAtoE(input: IdentityMigrationInput): IdentityMigrationResult {
  safeIdSchema.parse(input.production_id);
  const ir = record(input.ir);
  if (!ir) throw pcError("PC_CONTRACT_INVALID", "identity migration requires an IR object");
  const issues: IdentityMigrationIssue[] = [];
  const subjects = Array.isArray(ir.subjects) ? ir.subjects : [];
  const lockedFlagSeen = subjects.some((subject) => record(subject)?.locked === true);
  if (lockedFlagSeen) issues.push({ code: "identity.legacy_flag_not_authoritative", message: "locked:true is retained as legacy evidence only" });
  const definition = buildDefinition(input, issues);
  if (!definition) return { status: "not_applicable", issues, legacy_evidence: { locked_flag_seen: lockedFlagSeen, locked_block_count: 0, verification_candidate_seen: false } };
  const verification = buildVerification(input, definition, issues);
  return {
    status: verification ? "migrated" : issues.some((issue) => issue.code === "identity.lock_hash_mismatch") ? "blocked" : "awaiting_human",
    definition,
    ...(verification ? { verification } : {}),
    issues,
    legacy_evidence: {
      locked_flag_seen: lockedFlagSeen,
      locked_block_count: definition.subjects.reduce((count, subject) => count + Object.keys(subject.locked_blocks).length, 0),
      verification_candidate_seen: Boolean(input.verification)
    }
  };
}

export const migrateIdentityLock = migrateIdentityLockPhaseAtoE;
