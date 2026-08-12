/**
 * Active production-control live bridge for plan / review / Gate / run / render / finalize.
 * Fixture-safe: no provider, network, billing, or real project Gate mutation.
 *
 * Disabled / shadow / legacy paths never call these helpers for authority.
 */
import type { Project } from "../project/schema.js";
import type { GateId, RunState } from "../orchestrator/stateTypes.js";
import type { ProductionGateBinding } from "../orchestrator/stateTransitions.js";
import { sha256Canonical } from "./canonical.js";
import { compileProductionContract } from "./contractCompiler.js";
import { pcError } from "./errors.js";
import {
  createGateBundle,
  gateBundleHasUnknownPrice,
  parseGateBundle,
  projectGateBundleForReview,
  type GateBundle,
  type GateBundleInput,
  type GenerationBatch
} from "./gateBundle.js";
import {
  assertCurrentGateSubjects,
  bindGateDecision,
  cascadeFromDrift,
  createGate1Subject,
  createGate2Subject,
  createGate3Subject,
  evaluateGate2AutoPass as evaluateGate2AutoPassCore,
  gateDecisionDigest,
  type GateCascade,
  type GateDriftKind,
  type LiveGateSubjects
} from "./gateSubjects.js";
import {
  assertActiveBindingRequired,
  assertBindingMatchesGateBundle,
  createGenerationJobApprovalBinding,
  parseGenerationJobApprovalBinding,
  type GenerationJobApprovalBinding
} from "./generationBridge.js";
import type { ProductionControlMode } from "./schema.js";
import type { RouteIdentity } from "./programBinding.js";
import { compileTaskTree } from "./taskTreeCompiler.js";
import { createDefaultTaskTreeTemplate } from "./taskTreeTemplates.js";

export type ActiveGateBundleBuildInput = {
  production_id: string;
  run_id: string;
  production_contract_digest: string;
  contract_set_digest: string;
  task_tree_digest: string;
  selected_artifact_digests?: string[];
  composition_intent_digest?: string;
  generation_batches: GateBundleInput["generation_batches"];
  review_artifact_digest: string;
};

export type GateBundleReviewProjection = ReturnType<typeof projectGateBundleForReview>;

/**
 * Resolve orchestration mode. Unresolved mode fails closed for active-required effect boundaries.
 */
export function resolveOrchestrationMode(
  project: Pick<Project, "orchestration"> | { orchestration?: { mode?: string } } | undefined
): ProductionControlMode | undefined {
  const mode = project?.orchestration?.mode;
  if (mode === "disabled" || mode === "shadow" || mode === "active") return mode;
  return undefined;
}

/** Effect boundary: active-required operations fail closed when mode is unresolved. */
export function requireResolvedModeForEffect(
  mode: ProductionControlMode | undefined,
  effect: "external-submit" | "gate" | "render" | "finalize" | "run"
): ProductionControlMode | "legacy" {
  if (mode === undefined) {
    // Unspecified project → legacy path (not production-control active).
    return "legacy";
  }
  if (mode === "disabled" || mode === "shadow") return mode;
  if (mode === "active") return "active";
  throw pcError("PC_MODE_INACTIVE", `unresolved production control mode at ${effect} boundary`);
}

/**
 * Build a live GateBundle from production contract / contract set / task tree / batches.
 * Secret-free review projection is available via projectGateBundleForReview.
 */
export function buildActiveGateBundle(input: ActiveGateBundleBuildInput): GateBundle {
  return createGateBundle({
    production_id: input.production_id,
    run_id: input.run_id,
    production_contract_digest: input.production_contract_digest,
    contract_set_digest: input.contract_set_digest,
    task_tree_digest: input.task_tree_digest,
    selected_artifact_digests: input.selected_artifact_digests ?? [],
    ...(input.composition_intent_digest
      ? { composition_intent_digest: input.composition_intent_digest }
      : {}),
    generation_batches: input.generation_batches,
    review_artifact_digest: input.review_artifact_digest
  });
}

/**
 * Build GateBundle for an active project from live ProductionContract + TaskTree.
 * Callers supply generation batches / selected artifacts / review digest from plan/review.
 */
export function buildActiveGateBundleForProject(input: {
  project: Project;
  run_id: string;
  review_artifact_digest: string;
  selected_artifact_digests?: string[];
  composition_intent_digest?: string;
  generation_batches?: GateBundleInput["generation_batches"];
  /** Optional override contract-set digest when a ContractSet is already selected. */
  contract_set_digest?: string;
}): GateBundle {
  const contract = compileProductionContract({ project: input.project });
  const tree = compileTaskTree({
    production: contract,
    template: createDefaultTaskTreeTemplate(contract)
  });
  return buildActiveGateBundle({
    production_id: contract.production_id,
    run_id: input.run_id,
    production_contract_digest: contract.root_digest,
    contract_set_digest: input.contract_set_digest ?? sha256Canonical({
      kind: "active-contract-set-placeholder",
      production_id: contract.production_id,
      production_contract_digest: contract.root_digest
    }),
    task_tree_digest: tree.digest,
    selected_artifact_digests: input.selected_artifact_digests ?? [],
    ...(input.composition_intent_digest
      ? { composition_intent_digest: input.composition_intent_digest }
      : {}),
    generation_batches: input.generation_batches ?? [],
    review_artifact_digest: input.review_artifact_digest
  });
}

/** Active plan/review projection: secret-free GateBundle summary for review-data.json. */
export function buildGateBundleReviewProjection(bundle: GateBundle): GateBundleReviewProjection {
  return projectGateBundleForReview(bundle);
}

/**
 * Active Gate 1 approval subject: exact GateBundle digest bound alongside legacy digest.
 * Rejects absent bundle. Unknown price may review but never approve.
 */
export function buildActiveGate1ProductionBinding(input: {
  production_id: string;
  run_id: string;
  gate_bundle: GateBundle | undefined;
  legacy_approved_input_digest: string;
  decision: {
    decision_id: string;
    decision: string;
    actor: string;
    decided_at: string;
    reason?: string;
  };
  allow_unknown_price_review_only?: boolean;
}): {
  subject_digest: string;
  decision_digest: string;
  productionBinding: ProductionGateBinding;
  gate_bundle_digest: string;
} {
  if (!input.gate_bundle) {
    throw pcError("PC_GATE_BUNDLE_INVALID", "active Gate 1 approval requires a GateBundle");
  }
  const bundle = parseGateBundle(input.gate_bundle);
  if (gateBundleHasUnknownPrice(bundle) && !input.allow_unknown_price_review_only) {
    throw pcError("PC_GATE_BUNDLE_INVALID", "unknown price cannot be approved or executed");
  }
  if (gateBundleHasUnknownPrice(bundle) && input.decision.decision === "approved") {
    throw pcError("PC_GATE_BUNDLE_INVALID", "unknown price cannot be approved or executed");
  }
  const subject = createGate1Subject({
    production_id: input.production_id,
    run_id: input.run_id,
    gate_bundle: bundle,
    legacy_approved_input_digest: input.legacy_approved_input_digest
  });
  const binding = bindGateDecision({
    gate: "gate_1",
    subject_digest: subject.digest,
    decision: {
      decision_id: input.decision.decision_id,
      decision: input.decision.decision,
      actor: input.decision.actor,
      decided_at: input.decision.decided_at,
      ...(input.decision.reason ? { reason: input.decision.reason } : {})
    },
    legacy_approved_input_digest: input.legacy_approved_input_digest,
    decision_source: "human"
  });
  const decisionDigest = gateDecisionDigest(binding.decision);
  return {
    subject_digest: subject.digest,
    decision_digest: decisionDigest,
    gate_bundle_digest: bundle.digest,
    productionBinding: {
      production_subject_digest: subject.digest,
      production_decision_digest: decisionDigest
    }
  };
}

export function buildActiveGate2ProductionBinding(input: {
  gate_1_decision_digest: string;
  gate_bundle_digest: string;
  selected_generation_completion_digests: string[];
  manifest_digest: string;
  technical_qa_digest: string;
  resolved_composition_plan_digest?: string;
  identity_verification_report_digest?: string;
  semantic_qa_digest?: string;
  decision: {
    decision_id: string;
    decision: string;
    actor: string;
    decided_at: string;
    reason?: string;
  };
  decision_source?: "human" | "auto_qc";
  legacy_approved_input_digest?: string;
}): {
  subject_digest: string;
  decision_digest: string;
  productionBinding: ProductionGateBinding;
} {
  const subject = createGate2Subject({
    gate_1_decision_digest: input.gate_1_decision_digest,
    gate_bundle_digest: input.gate_bundle_digest,
    selected_generation_completion_digests: input.selected_generation_completion_digests,
    manifest_digest: input.manifest_digest,
    technical_qa_digest: input.technical_qa_digest,
    ...(input.resolved_composition_plan_digest
      ? { resolved_composition_plan_digest: input.resolved_composition_plan_digest }
      : {}),
    ...(input.identity_verification_report_digest
      ? { identity_verification_report_digest: input.identity_verification_report_digest }
      : {}),
    ...(input.semantic_qa_digest ? { semantic_qa_digest: input.semantic_qa_digest } : {})
  });
  const binding = bindGateDecision({
    gate: "gate_2",
    subject_digest: subject.digest,
    decision: {
      decision_id: input.decision.decision_id,
      decision: input.decision.decision,
      actor: input.decision.actor,
      decided_at: input.decision.decided_at,
      ...(input.decision.reason ? { reason: input.decision.reason } : {})
    },
    ...(input.legacy_approved_input_digest
      ? { legacy_approved_input_digest: input.legacy_approved_input_digest }
      : {}),
    decision_source: input.decision_source ?? "human"
  });
  const decisionDigest = gateDecisionDigest(binding.decision);
  return {
    subject_digest: subject.digest,
    decision_digest: decisionDigest,
    productionBinding: {
      production_subject_digest: subject.digest,
      production_decision_digest: decisionDigest
    }
  };
}

export function buildActiveGate3ProductionBinding(input: {
  gate_2_decision_digest: string;
  gate_2_subject_digest: string;
  final_artifact_sha256: string;
  render_report_digest: string;
  gate_3_qc_digest: string;
  selected_branch_digest: string;
  resolved_composition_plan_digest?: string;
  decision: {
    decision_id: string;
    decision: string;
    actor: string;
    decided_at: string;
    reason?: string;
  };
  legacy_approved_input_digest?: string;
}): {
  subject_digest: string;
  decision_digest: string;
  productionBinding: ProductionGateBinding;
} {
  const subject = createGate3Subject({
    gate_2_decision_digest: input.gate_2_decision_digest,
    gate_2_subject_digest: input.gate_2_subject_digest,
    final_artifact_sha256: input.final_artifact_sha256,
    render_report_digest: input.render_report_digest,
    gate_3_qc_digest: input.gate_3_qc_digest,
    selected_branch_digest: input.selected_branch_digest,
    ...(input.resolved_composition_plan_digest
      ? { resolved_composition_plan_digest: input.resolved_composition_plan_digest }
      : {})
  });
  const binding = bindGateDecision({
    gate: "gate_3",
    subject_digest: subject.digest,
    decision: {
      decision_id: input.decision.decision_id,
      decision: input.decision.decision,
      actor: input.decision.actor,
      decided_at: input.decision.decided_at,
      ...(input.decision.reason ? { reason: input.decision.reason } : {})
    },
    ...(input.legacy_approved_input_digest
      ? { legacy_approved_input_digest: input.legacy_approved_input_digest }
      : {}),
    decision_source: "human"
  });
  const decisionDigest = gateDecisionDigest(binding.decision);
  return {
    subject_digest: subject.digest,
    decision_digest: decisionDigest,
    productionBinding: {
      production_subject_digest: subject.digest,
      production_decision_digest: decisionDigest
    }
  };
}

/**
 * Mutate RunState gate bindings for cascade invalidation.
 * Unifies gate-1 / gate_1 naming to gate_1 | gate_2 | gate_3 only.
 */
export function applyCascadeToRunState(
  state: RunState,
  cascade: GateCascade,
  updatedAt = new Date().toISOString()
): RunState {
  const clear = (gate: GateId): RunState["gates"][GateId] => {
    const current = state.gates[gate];
    if (current.status !== "approved" && current.status !== "awaiting_approval") {
      return current;
    }
    return {
      status: "pending",
      updated_at: updatedAt
    };
  };
  const gates = { ...state.gates };
  if (cascade.stale_gate_1) gates.gate_1 = clear("gate_1");
  if (cascade.stale_gate_2) gates.gate_2 = clear("gate_2");
  if (cascade.stale_gate_3) gates.gate_3 = clear("gate_3");
  return {
    ...state,
    updated_at: updatedAt,
    gates,
    status: cascade.stale_gate_1
      ? "planned"
      : cascade.stale_gate_2
        ? state.gates.gate_1.status === "approved"
          ? "awaiting_gate_2"
          : state.status
        : cascade.stale_gate_3
          ? state.gates.gate_2.status === "approved"
            ? "awaiting_gate_3"
            : state.status
          : state.status
  };
}

export function cascadeRunStateFromDrift(
  state: RunState,
  kinds: readonly GateDriftKind[],
  updatedAt?: string
): { state: RunState; cascade: GateCascade } {
  const cascade = cascadeFromDrift(kinds);
  return { state: applyCascadeToRunState(state, cascade, updatedAt), cascade };
}

/** Normalize gate id aliases (gate-1, Gate1, gate_1) → gate_1. */
export function normalizeGateId(raw: string): GateId | undefined {
  const key = raw.trim().toLowerCase().replace(/-/g, "_");
  if (key === "gate_1" || key === "gate1") return "gate_1";
  if (key === "gate_2" || key === "gate2") return "gate_2";
  if (key === "gate_3" || key === "gate3") return "gate_3";
  return undefined;
}

/**
 * Live recompute immediately before run (Gate1), render (Gate1+2), or finalize (Gate1+2+3).
 * Missing/stale active production subjects block.
 */
export function assertActiveSubjectsBeforePhase(input: {
  mode: ProductionControlMode | undefined;
  phase: "run" | "render" | "finalize";
  state: RunState;
  expected: LiveGateSubjects;
}): void {
  if (input.mode !== "active") return;
  const current: LiveGateSubjects = {
    gate_1_subject_digest: input.state.gates.gate_1.production_subject_digest,
    gate_1_decision_digest: input.state.gates.gate_1.production_decision_digest,
    gate_2_subject_digest: input.state.gates.gate_2.production_subject_digest,
    gate_2_decision_digest: input.state.gates.gate_2.production_decision_digest,
    gate_3_subject_digest: input.state.gates.gate_3.production_subject_digest,
    gate_3_decision_digest: input.state.gates.gate_3.production_decision_digest
  };
  if (input.phase === "run") {
    if (
      !current.gate_1_subject_digest
      || !current.gate_1_decision_digest
      || current.gate_1_subject_digest !== input.expected.gate_1_subject_digest
      || current.gate_1_decision_digest !== input.expected.gate_1_decision_digest
    ) {
      throw pcError("PC_GATE_SUBJECT_STALE", "Gate 1 subject is stale or missing before run");
    }
    return;
  }
  assertCurrentGateSubjects({
    phase: input.phase,
    current,
    expected: input.expected
  });
}

/**
 * Create full production binding for generation job (active mode).
 * Recomputes immutable identity; rejects incomplete bindings.
 */
export function createFullProductionJobBinding(input: {
  production_id: string;
  run_id: string;
  node_id: string;
  attempt_id: string;
  generation_job_id: string;
  approval_observed_revision: number;
  approval_digest: string;
  gate_bundle: GateBundle;
  gate_1_decision_digest: string;
  request_digest: string;
  compilation_digest: string;
  route: RouteIdentity;
  pricing_binding_digest: string;
  regeneration_attempt_authorization_digest?: string;
}): GenerationJobApprovalBinding {
  const binding = createGenerationJobApprovalBinding({
    production_id: input.production_id,
    run_id: input.run_id,
    node_id: input.node_id,
    attempt_id: input.attempt_id,
    generation_job_id: input.generation_job_id,
    approval_observed_revision: input.approval_observed_revision,
    approval_digest: input.approval_digest,
    gate_bundle_digest: input.gate_bundle.digest,
    gate_1_decision_digest: input.gate_1_decision_digest,
    request_digest: input.request_digest,
    compilation_digest: input.compilation_digest,
    route: input.route,
    pricing_binding_digest: input.pricing_binding_digest,
    ...(input.regeneration_attempt_authorization_digest
      ? {
          regeneration_attempt_authorization_digest:
            input.regeneration_attempt_authorization_digest
        }
      : {})
  });
  assertBindingMatchesGateBundle(binding, input.gate_bundle);
  return binding;
}

/** Verify stored binding is a full approval binding (not a 64-char-length shell). */
export function assertFullProductionBinding(
  binding: unknown,
  mode: ProductionControlMode | undefined
): GenerationJobApprovalBinding | undefined {
  if (mode !== "active") {
    assertActiveBindingRequired(mode ?? "disabled", undefined);
    return undefined;
  }
  if (!binding || typeof binding !== "object") {
    throw pcError("PC_GENERATION_BINDING_INVALID", "active mode requires full generation job production binding");
  }
  // Recompute identity via shared schema — length-only checks are insufficient.
  return parseGenerationJobApprovalBinding(binding);
}

/**
 * Shared Gate 2 auto-pass policy used by both production-control subjects and the live run path.
 * Preserves the existing narrow conditions; does not widen hierarchy auto-pass.
 */
export function evaluateActiveGate2AutoPassPolicy(input: {
  project_opt_in: boolean;
  credits_consumed: number;
  newly_generated_assets: number;
  technical_qa_issue_count: number;
  has_semantic_qa: boolean;
}): { auto_pass: boolean; blocked_reason?: string } {
  return evaluateGate2AutoPassCore(input);
}

/** Map live run conditions onto the shared auto-pass core (single implementation). */
export function mapRunConditionsToGate2AutoPass(input: {
  project_opt_in: boolean;
  credits: number;
  generatedAssetCount: number;
  qcIssueCount: number;
  semanticQaEnabled: boolean;
}): { auto_pass: boolean; blocked_reason?: string } {
  return evaluateActiveGate2AutoPassPolicy({
    project_opt_in: input.project_opt_in,
    credits_consumed: input.credits,
    newly_generated_assets: input.generatedAssetCount,
    technical_qa_issue_count: input.qcIssueCount,
    has_semantic_qa: input.semanticQaEnabled
  });
}

export function liveSubjectsFromRunState(state: RunState): LiveGateSubjects {
  return {
    gate_1_subject_digest: state.gates.gate_1.production_subject_digest,
    gate_1_decision_digest: state.gates.gate_1.production_decision_digest,
    gate_2_subject_digest: state.gates.gate_2.production_subject_digest,
    gate_2_decision_digest: state.gates.gate_2.production_decision_digest,
    gate_3_subject_digest: state.gates.gate_3.production_subject_digest,
    gate_3_decision_digest: state.gates.gate_3.production_decision_digest
  };
}

/** Deterministic decision id for CLI gate decisions. */
export function productionDecisionId(gate: GateId, actor: string, decidedAt: string): string {
  return sha256Canonical({
    kind: "production-gate-decision-id",
    gate,
    actor,
    decided_at: decidedAt
  }).slice(0, 32);
}

export type { GateBundle, GenerationBatch, GenerationJobApprovalBinding, GateCascade, GateDriftKind };
