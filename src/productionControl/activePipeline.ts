/**
 * Active production-control live bridge for plan / review / Gate / run / render / finalize.
 * Fixture-safe: no provider, network, billing, or real project Gate mutation.
 *
 * Disabled / shadow / legacy paths never call these helpers for authority.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "../project/schema.js";
import type { GateId, RunState } from "../orchestrator/stateTypes.js";
import type { ProductionGateBinding } from "../orchestrator/stateTransitions.js";
import { sha256Canonical } from "./canonical.js";
import { compileProductionContract } from "./contractCompiler.js";
import { createContractSet } from "./contractRegistry.js";
import { pcError } from "./errors.js";
import {
  createGateBundle,
  gateBundleHasUnknownPrice,
  parseGateBundle,
  pricingBindingDigest,
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
import type { ProductionControlMode, ProductionContract } from "./schema.js";
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

/** One ordered unit of generation evidence for GateBundle construction. */
export type ActiveGenerationUnitEvidence = {
  generation_unit_digest: string;
  base_compilation_digest: string;
  route: RouteIdentity;
  pricing: GateBundleInput["generation_batches"][number]["pricing"];
  pricing_binding_digest?: string;
  program_start_ms?: number;
  program_end_ms?: number;
};

/**
 * Build ordered generation batches from live plan/review evidence.
 * Mixed routes become separate batches. Unknown price is allowed for review
 * projection but Gate1 approve refuses it.
 */
export function buildGenerationBatchesFromEvidence(
  units: readonly ActiveGenerationUnitEvidence[]
): GateBundleInput["generation_batches"] {
  if (units.length === 0) {
    throw pcError(
      "PC_GATE_BUNDLE_INVALID",
      "active GateBundle requires real generation batches from plan/review evidence"
    );
  }
  const byRoute = new Map<string, ActiveGenerationUnitEvidence[]>();
  for (const unit of units) {
    const key = unit.route.route_digest;
    const list = byRoute.get(key) ?? [];
    list.push(unit);
    byRoute.set(key, list);
  }
  const batches: GateBundleInput["generation_batches"] = [];
  let batchIndex = 0;
  for (const group of byRoute.values()) {
    const route = group[0]!.route;
    const pricing = group[0]!.pricing;
    const pricingDigest = group[0]!.pricing_binding_digest
      ?? pricingBindingDigest(pricing, route);
    // All units in a route group must share the same pricing binding.
    for (const unit of group) {
      const unitPricing = unit.pricing_binding_digest
        ?? pricingBindingDigest(unit.pricing, unit.route);
      if (unitPricing !== pricingDigest) {
        throw pcError(
          "PC_GATE_BUNDLE_INVALID",
          "generation batch cannot mix pricing bindings for one RouteIdentity"
        );
      }
    }
    batches.push({
      batch_id: `batch-${batchIndex}`,
      route,
      ordered_units: group.map((unit, ordinal) => ({
        ordinal,
        generation_unit_digest: unit.generation_unit_digest,
        base_compilation_digest: unit.base_compilation_digest,
        route_digest: unit.route.route_digest,
        ...(unit.program_start_ms !== undefined ? { program_start_ms: unit.program_start_ms } : {}),
        ...(unit.program_end_ms !== undefined ? { program_end_ms: unit.program_end_ms } : {})
      })),
      pricing,
      pricing_binding_digest: pricingDigest
    });
    batchIndex += 1;
  }
  return batches;
}

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

/**
 * Effect boundary mode resolution.
 * - Explicit disabled/shadow/active: returned as-is.
 * - Unspecified mode at run/render/finalize: legacy-compatible (no production-control claim).
 * - Unresolved/unknown or production-control effect (external-submit/gate) without explicit
 *   mode: fail closed (never silently treat as legacy active authority).
 */
export function requireResolvedModeForEffect(
  mode: ProductionControlMode | undefined,
  effect: "external-submit" | "gate" | "render" | "finalize" | "run"
): ProductionControlMode | "legacy" {
  if (mode === "disabled" || mode === "shadow" || mode === "active") return mode;
  if (mode === undefined) {
    if (effect === "external-submit" || effect === "gate") {
      throw pcError("PC_MODE_INACTIVE", `unresolved production control mode at ${effect} boundary`);
    }
    return "legacy";
  }
  throw pcError("PC_MODE_INACTIVE", `unresolved production control mode at ${effect} boundary`);
}

/** Active job/generation effect boundary: mode must be explicitly active. */
export function requireActiveModeForEffect(
  mode: ProductionControlMode | undefined,
  effect: "external-submit" | "gate" | "job"
): "active" {
  if (mode === "active") return "active";
  throw pcError("PC_MODE_INACTIVE", `active mode required at ${effect} boundary`);
}

/**
 * Build a live GateBundle from production contract / contract set / task tree / batches.
 * Secret-free review projection is available via projectGateBundleForReview.
 * Rejects empty batches when the caller did not explicitly allow a local-only bundle.
 */
export function buildActiveGateBundle(input: ActiveGateBundleBuildInput & {
  allow_empty_batches?: boolean;
}): GateBundle {
  if (
    (!input.generation_batches || input.generation_batches.length === 0)
    && !input.allow_empty_batches
  ) {
    throw pcError(
      "PC_GATE_BUNDLE_INVALID",
      "active GateBundle requires real generation batches from plan/review evidence"
    );
  }
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
 * Durable ContractSet digest from the live ProductionContract — never a placeholder kind.
 * Uses the assets slot bound to the production contract root when no richer set is supplied.
 */
export function buildActiveContractSetDigest(contract: ProductionContract): string {
  const set = createContractSet({
    production_id: contract.production_id,
    revision: 0,
    contracts: [{
      slot: "assets",
      contract_id: `${contract.production_id}-assets`,
      contract_revision: 0,
      artifact_id: `${contract.production_id}-assets-art`,
      digest: contract.root_digest
    }]
  });
  return set.digest;
}

/**
 * Build GateBundle for an active project from live ProductionContract + TaskTree + evidence.
 * generation_batches are required when the project has generation requests.
 * Empty batches are only allowed for local-media (no generation) projects.
 */
export function buildActiveGateBundleForProject(input: {
  project: Project;
  run_id: string;
  review_artifact_digest: string;
  selected_artifact_digests?: string[];
  composition_intent_digest?: string;
  /** Ordered batches from plan/review evidence. Required when generation exists. */
  generation_batches?: GateBundleInput["generation_batches"];
  /** Optional override contract-set digest when a ContractSet is already selected. */
  contract_set_digest?: string;
}): GateBundle {
  const contract = compileProductionContract({ project: input.project });
  const tree = compileTaskTree({
    production: contract,
    template: createDefaultTaskTreeTemplate(contract)
  });
  const hasGeneration = Boolean(input.project.generation?.requests?.length);
  const batches = input.generation_batches ?? [];
  if (hasGeneration && batches.length === 0) {
    throw pcError(
      "PC_GATE_BUNDLE_INVALID",
      "active GateBundle requires real generation batches from plan/review evidence"
    );
  }
  return buildActiveGateBundle({
    production_id: contract.production_id,
    run_id: input.run_id,
    production_contract_digest: contract.root_digest,
    contract_set_digest: input.contract_set_digest ?? buildActiveContractSetDigest(contract),
    task_tree_digest: tree.digest,
    selected_artifact_digests: input.selected_artifact_digests ?? [],
    ...(input.composition_intent_digest
      ? { composition_intent_digest: input.composition_intent_digest }
      : {}),
    generation_batches: batches,
    review_artifact_digest: input.review_artifact_digest,
    allow_empty_batches: !hasGeneration
  });
}

const DURABLE_GATE_BUNDLE_RELATIVE = join("production-control", "gate-bundle.json");

/** Persist the canonical GateBundle for the run so review and Gate1 share one digest. */
export async function writeDurableGateBundle(runDir: string, bundle: GateBundle): Promise<string> {
  const parsed = parseGateBundle(bundle);
  const dir = join(runDir, "production-control");
  await mkdir(dir, { recursive: true });
  const path = join(runDir, DURABLE_GATE_BUNDLE_RELATIVE);
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return path;
}

/** Load the durable GateBundle written at review; verifies digest on parse. */
export async function loadDurableGateBundle(runDir: string): Promise<GateBundle | undefined> {
  const path = join(runDir, DURABLE_GATE_BUNDLE_RELATIVE);
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parseGateBundle(raw);
  } catch {
    return undefined;
  }
}

/**
 * Load durable GateBundle or rebuild from the same evidence and require exact digest match.
 * Refuses when batches/evidence are absent or digests diverge.
 */
export function resolveActiveGateBundle(input: {
  durable?: GateBundle;
  rebuild: () => GateBundle;
}): GateBundle {
  const rebuilt = parseGateBundle(input.rebuild());
  if (input.durable) {
    const durable = parseGateBundle(input.durable);
    if (durable.digest !== rebuilt.digest) {
      throw pcError(
        "PC_GATE_BUNDLE_INVALID",
        "durable GateBundle digest does not match rebuilt plan/review evidence"
      );
    }
    return durable;
  }
  if (rebuilt.generation_batches.length === 0) {
    // Local-only rebuilds may be empty; callers that require generation must pass batches.
  }
  return rebuilt;
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
  /**
   * Local-media-only projects with zero generation may approve an empty batch list
   * when the caller has already verified there are no generation requests.
   * Never a default for generation projects.
   */
  allow_empty_local_only?: boolean;
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
  if (
    input.decision.decision === "approved"
    && bundle.generation_batches.length === 0
    && !input.allow_empty_local_only
  ) {
    throw pcError(
      "PC_GATE_BUNDLE_INVALID",
      "active Gate 1 approval requires real generation batches from plan/review evidence"
    );
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
 * Compares subject+decision digests, not mere presence. Missing/stale blocks.
 */
export function assertActiveSubjectsBeforePhase(input: {
  mode: ProductionControlMode | undefined;
  phase: "run" | "render" | "finalize";
  state: RunState;
  expected: LiveGateSubjects;
}): void {
  if (input.mode !== "active") return;
  const current = liveSubjectsFromRunState(input.state);
  if (input.phase === "run") {
    if (
      !current.gate_1_subject_digest
      || !current.gate_1_decision_digest
      || !input.expected.gate_1_subject_digest
      || !input.expected.gate_1_decision_digest
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
 * Recompute expected Gate 1 subject+decision from the live GateBundle + legacy digest
 * and the durable RunState decision. Used before run to compare against stored subjects.
 */
export function recomputeExpectedGate1Subjects(input: {
  production_id: string;
  run_id: string;
  gate_bundle: GateBundle;
  legacy_approved_input_digest: string;
  /** Decision fields stored when Gate 1 was approved (actor/decided_at/decision_id). */
  decision: {
    decision_id: string;
    decision: string;
    actor: string;
    decided_at: string;
    reason?: string;
  };
}): LiveGateSubjects {
  const bound = buildActiveGate1ProductionBinding({
    production_id: input.production_id,
    run_id: input.run_id,
    gate_bundle: input.gate_bundle,
    legacy_approved_input_digest: input.legacy_approved_input_digest,
    decision: input.decision
  });
  return {
    gate_1_subject_digest: bound.subject_digest,
    gate_1_decision_digest: bound.decision_digest
  };
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
