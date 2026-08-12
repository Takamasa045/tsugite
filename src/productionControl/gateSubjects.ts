/**
 * Additive Gate 1/2/3 subject + decision bindings and cascade rules.
 * Does not replace legacy approved_input_digest / Gate3 final SHA / plan_digest.
 */
import { z } from "zod";
import { sha256Canonical, withoutField } from "./canonical.js";
import { pcError } from "./errors.js";
import { gateBundleSchema, type GateBundle } from "./gateBundle.js";
import { digestSchema, humanDecisionRefSchema, safeIdSchema, type HumanDecisionRef } from "./schema.js";

const finiteNumber = z.number().refine(Number.isFinite, "finite number required");

export const gate1SubjectSchema = z.object({
  schema_version: z.literal(1),
  production_id: safeIdSchema,
  run_id: safeIdSchema,
  gate_bundle_digest: digestSchema,
  review_artifact_digest: digestSchema,
  /** Legacy Gate 1 approval subject (existing review approved_input_digest basis). */
  legacy_approved_input_digest: digestSchema,
  digest: digestSchema
}).strict().superRefine((value, context) => {
  if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "gate 1 subject digest mismatch" });
  }
});
export type Gate1Subject = z.infer<typeof gate1SubjectSchema>;
export type Gate1SubjectV1 = Gate1Subject;

export const gate2SubjectSchema = z.object({
  schema_version: z.literal(1),
  gate_1_decision_digest: digestSchema,
  gate_bundle_digest: digestSchema,
  selected_generation_completion_digests: z.array(digestSchema).max(256),
  manifest_digest: digestSchema,
  resolved_composition_plan_digest: digestSchema.optional(),
  identity_verification_report_digest: digestSchema.optional(),
  technical_qa_digest: digestSchema,
  semantic_qa_digest: digestSchema.optional(),
  digest: digestSchema
}).strict().superRefine((value, context) => {
  if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "gate 2 subject digest mismatch" });
  }
});
export type Gate2Subject = z.infer<typeof gate2SubjectSchema>;
export type Gate2SubjectV1 = Gate2Subject;

export const gate3SubjectSchema = z.object({
  schema_version: z.literal(1),
  gate_2_decision_digest: digestSchema,
  gate_2_subject_digest: digestSchema,
  final_artifact_sha256: digestSchema,
  render_report_digest: digestSchema,
  gate_3_qc_digest: digestSchema,
  selected_branch_digest: digestSchema,
  resolved_composition_plan_digest: digestSchema.optional(),
  digest: digestSchema
}).strict().superRefine((value, context) => {
  if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "gate 3 subject digest mismatch" });
  }
});
export type Gate3Subject = z.infer<typeof gate3SubjectSchema>;
export type Gate3SubjectV1 = Gate3Subject;

export type GateDecisionBinding = {
  gate: "gate_1" | "gate_2" | "gate_3";
  subject_digest: string;
  decision: HumanDecisionRef;
  /** Legacy approved_input_digest preserved unchanged. */
  legacy_approved_input_digest?: string;
};

export function createGate1Subject(input: {
  production_id: string;
  run_id: string;
  gate_bundle: GateBundle;
  legacy_approved_input_digest: string;
}): Gate1Subject {
  const bundle = gateBundleSchema.parse(input.gate_bundle);
  if (bundle.production_id !== input.production_id || bundle.run_id !== input.run_id) {
    throw pcError("PC_GATE_BUNDLE_INVALID", "gate bundle production/run binding mismatch");
  }
  const base = {
    schema_version: 1 as const,
    production_id: input.production_id,
    run_id: input.run_id,
    gate_bundle_digest: bundle.digest,
    review_artifact_digest: bundle.review_artifact_digest,
    legacy_approved_input_digest: input.legacy_approved_input_digest
  };
  return gate1SubjectSchema.parse({ ...base, digest: sha256Canonical(base) });
}

export function createGate2Subject(input: {
  gate_1_decision_digest: string;
  gate_bundle_digest: string;
  selected_generation_completion_digests: string[];
  manifest_digest: string;
  resolved_composition_plan_digest?: string;
  identity_verification_report_digest?: string;
  technical_qa_digest: string;
  semantic_qa_digest?: string;
}): Gate2Subject {
  const base = {
    schema_version: 1 as const,
    gate_1_decision_digest: input.gate_1_decision_digest,
    gate_bundle_digest: input.gate_bundle_digest,
    selected_generation_completion_digests: [...input.selected_generation_completion_digests],
    manifest_digest: input.manifest_digest,
    ...(input.resolved_composition_plan_digest
      ? { resolved_composition_plan_digest: input.resolved_composition_plan_digest }
      : {}),
    ...(input.identity_verification_report_digest
      ? { identity_verification_report_digest: input.identity_verification_report_digest }
      : {}),
    technical_qa_digest: input.technical_qa_digest,
    ...(input.semantic_qa_digest ? { semantic_qa_digest: input.semantic_qa_digest } : {})
  };
  return gate2SubjectSchema.parse({ ...base, digest: sha256Canonical(base) });
}

export function createGate3Subject(input: {
  gate_2_decision_digest: string;
  gate_2_subject_digest: string;
  final_artifact_sha256: string;
  render_report_digest: string;
  gate_3_qc_digest: string;
  selected_branch_digest: string;
  resolved_composition_plan_digest?: string;
}): Gate3Subject {
  const base = {
    schema_version: 1 as const,
    gate_2_decision_digest: input.gate_2_decision_digest,
    gate_2_subject_digest: input.gate_2_subject_digest,
    final_artifact_sha256: input.final_artifact_sha256,
    render_report_digest: input.render_report_digest,
    gate_3_qc_digest: input.gate_3_qc_digest,
    selected_branch_digest: input.selected_branch_digest,
    ...(input.resolved_composition_plan_digest
      ? { resolved_composition_plan_digest: input.resolved_composition_plan_digest }
      : {})
  };
  return gate3SubjectSchema.parse({ ...base, digest: sha256Canonical(base) });
}

export function gateDecisionDigest(decision: HumanDecisionRef): string {
  return sha256Canonical(humanDecisionRefSchema.parse(decision));
}

export function bindGateDecision(input: {
  gate: "gate_1" | "gate_2" | "gate_3";
  subject_digest: string;
  decision: Omit<HumanDecisionRef, "subject_digest"> & { subject_digest?: string };
  legacy_approved_input_digest?: string;
  /** Gate 1 and Gate 3 are always human. Gate 2 may use existing narrow auto-pass. */
  decision_source?: "human" | "auto_qc";
}): GateDecisionBinding {
  if (input.gate !== "gate_2" && input.decision_source === "auto_qc") {
    throw pcError("PC_AUTHORITY_DENIED", "Gate 1 and Gate 3 always require a human decision");
  }
  const decision = humanDecisionRefSchema.parse({
    ...input.decision,
    subject_digest: input.decision.subject_digest ?? input.subject_digest
  });
  if (decision.subject_digest !== input.subject_digest) {
    throw pcError("PC_GATE_SUBJECT_STALE", "gate decision subject digest mismatch");
  }
  return {
    gate: input.gate,
    subject_digest: input.subject_digest,
    decision,
    ...(input.legacy_approved_input_digest
      ? { legacy_approved_input_digest: input.legacy_approved_input_digest }
      : {})
  };
}

/** Drift classes that invalidate Gate approvals. */
export type GateDriftKind =
  | "contract"
  | "task-tree"
  | "identity-definition"
  | "route"
  | "price"
  | "pre-gate-composition"
  | "prompt"
  | "compilation"
  | "selected-completion"
  | "manifest"
  | "identity-verification"
  | "resolved-composition"
  | "technical-qa"
  | "semantic-qa"
  | "gate2-decision"
  | "final-artifact"
  | "render-report"
  | "gate3-qc"
  | "final-branch";

export type GateCascade = {
  stale_gate_1: boolean;
  stale_gate_2: boolean;
  stale_gate_3: boolean;
  render_forbidden: boolean;
  finalize_forbidden: boolean;
};

const UPSTREAM_GATE1_DRIFT = new Set<GateDriftKind>([
  "contract",
  "task-tree",
  "identity-definition",
  "route",
  "price",
  "pre-gate-composition",
  "prompt",
  "compilation"
]);

const GATE2_ONLY_DRIFT = new Set<GateDriftKind>([
  "selected-completion",
  "manifest",
  "identity-verification",
  "resolved-composition",
  "technical-qa",
  "semantic-qa"
]);

const GATE3_ONLY_DRIFT = new Set<GateDriftKind>([
  "gate2-decision",
  "final-artifact",
  "render-report",
  "gate3-qc",
  "final-branch"
]);

/**
 * Cascade rules (runtime-and-recovery §13):
 * - upstream contract/tree/identity-definition/route/price/pre-Gate composition/prompt/compilation → 1→2→3
 * - selected completion/manifest/IdentityVerification/resolved CompositionPlan/technical+semantic QA → 2→3 only
 * - Gate2 decision/subject and final artifact/render report/Gate3 QC/final branch → Gate3 only
 * Never infer Identity confirmed/verified from definition alone (callers must separate kinds).
 */
export function cascadeFromDrift(kinds: readonly GateDriftKind[]): GateCascade {
  let stale1 = false;
  let stale2 = false;
  let stale3 = false;
  for (const kind of kinds) {
    if (UPSTREAM_GATE1_DRIFT.has(kind)) {
      stale1 = true;
      stale2 = true;
      stale3 = true;
    } else if (GATE2_ONLY_DRIFT.has(kind)) {
      stale2 = true;
      stale3 = true;
    } else if (GATE3_ONLY_DRIFT.has(kind)) {
      stale3 = true;
    } else {
      throw pcError("PC_SCHEMA_INVALID", `unknown gate drift kind: ${String(kind)}`);
    }
  }
  // Gate 1 stale always propagates to 2/3.
  if (stale1) {
    stale2 = true;
    stale3 = true;
  }
  return {
    stale_gate_1: stale1,
    stale_gate_2: stale2,
    stale_gate_3: stale3,
    render_forbidden: stale1 || stale2,
    finalize_forbidden: stale1 || stale2 || stale3
  };
}

export type LiveGateSubjects = {
  gate_1_subject_digest?: string;
  gate_1_decision_digest?: string;
  gate_2_subject_digest?: string;
  gate_2_decision_digest?: string;
  gate_3_subject_digest?: string;
  gate_3_decision_digest?: string;
};

/** Live recompute immediately before render (Gate 1+2) or finalize (Gate 1+2+3). */
export function assertCurrentGateSubjects(input: {
  phase: "render" | "finalize";
  current: LiveGateSubjects;
  expected: LiveGateSubjects;
}): void {
  const pairs: Array<[keyof LiveGateSubjects, string]> = [
    ["gate_1_subject_digest", "Gate 1 subject"],
    ["gate_1_decision_digest", "Gate 1 decision"],
    ["gate_2_subject_digest", "Gate 2 subject"],
    ["gate_2_decision_digest", "Gate 2 decision"]
  ];
  if (input.phase === "finalize") {
    pairs.push(["gate_3_subject_digest", "Gate 3 subject"], ["gate_3_decision_digest", "Gate 3 decision"]);
  }
  for (const [key, label] of pairs) {
    const current = input.current[key];
    const expected = input.expected[key];
    if (!current || !expected || current !== expected) {
      throw pcError("PC_GATE_SUBJECT_STALE", `${label} is stale or missing before ${input.phase}`);
    }
  }
}

/**
 * Existing Gate 2 auto-pass remains the narrow opt-in only:
 * credits 0, generated assets 0, QC issues 0, semantic QA absent, project opt-in.
 * Hierarchy alone never widens auto-pass.
 */
export function evaluateGate2AutoPass(input: {
  project_opt_in: boolean;
  credits_consumed: number;
  newly_generated_assets: number;
  technical_qa_issue_count: number;
  has_semantic_qa: boolean;
}): { auto_pass: boolean; blocked_reason?: string } {
  if (!input.project_opt_in) return { auto_pass: false, blocked_reason: "project did not opt in" };
  if (input.credits_consumed !== 0) return { auto_pass: false, blocked_reason: "credits consumed" };
  if (input.newly_generated_assets !== 0) return { auto_pass: false, blocked_reason: "new assets generated" };
  if (input.technical_qa_issue_count !== 0) return { auto_pass: false, blocked_reason: "technical QA reported issues" };
  if (input.has_semantic_qa) return { auto_pass: false, blocked_reason: "semantic QA present" };
  return { auto_pass: true };
}

export function parseGate1Subject(input: unknown): Gate1Subject {
  return gate1SubjectSchema.parse(input);
}

export function parseGate2Subject(input: unknown): Gate2Subject {
  return gate2SubjectSchema.parse(input);
}

export function parseGate3Subject(input: unknown): Gate3Subject {
  return gate3SubjectSchema.parse(input);
}

// Keep finiteNumber imported usage for future amount bindings if needed by callers.
void finiteNumber;
