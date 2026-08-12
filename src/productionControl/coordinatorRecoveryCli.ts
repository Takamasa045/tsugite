/**
 * Coordinator recovery CLI bridge (PO-6).
 * Explicit entry only — never silent paid auto-spend from run/resume.
 * Fixture packages may supply in-process adapters; live network is never implied.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GenerationJobProviderAdapter } from "../generationJobs/adapter.js";
import { GenerationJobMachine, type LiveGate1Evidence } from "../generationJobs/machine.js";
import { GenerationJobStore } from "../generationJobs/store.js";
import type { GenerationJobRequest } from "../generationJobs/schema.js";
import { sha256Canonical } from "./canonical.js";
import { pcError, ProductionControlError } from "./errors.js";
import {
  executeCoordinatorPaidRecovery,
  planCoordinatorRecovery,
  runActiveLocalRecovery,
  type ActiveLocalRecoveryResult,
  type ActivePaidRegenerationInput,
  type ActivePaidRegenerationResult,
  type CoordinatorRecoveryPlan
} from "./activeRecovery.js";
import type { GateBundle } from "./gateBundle.js";
import {
  parseRegenerationGrant,
  parseRegenerationPolicySpec,
  type RegenerationGrant,
  type RegenerationPolicySpec
} from "./recoveryContracts.js";
import { createInitialMissionState } from "./reducer.js";
import { resumeProductionControl } from "./resume.js";
import type { HumanDecisionRef, MissionState } from "./schema.js";
import type { DurableCoordinatorPrincipalEvidence } from "./authorityGuard.js";
import type { ExecutionCompilationBundle } from "../videoPromptDirector/compilationBundle.js";

export type RecoveryPackage = {
  production_id: string;
  run_id: string;
  project_id: string;
  revision_id: string;
  node_id: string;
  observed_error_code: string;
  failure_kind: ActivePaidRegenerationInput["failure_kind"];
  policy?: RegenerationPolicySpec;
  grant?: RegenerationGrant;
  gate_bundle?: GateBundle;
  gate_1_decision?: HumanDecisionRef;
  live_gate_1_subject_digest?: string;
  live_gate_1_decision_digest?: string;
  mission_state?: MissionState;
  base_compilation_digest?: string;
  derived_compilation_digest?: string;
  patch_artifact_digest?: string;
  requested_credits?: number;
  ordinal?: number;
  trigger_failure_ref?: ActivePaidRegenerationInput["trigger_failure_ref"];
  job_request?: GenerationJobRequest;
  fixture_adapter?: {
    outcome: "success" | "known-non-submission" | "submission_unknown";
    provider_job_id?: string;
    artifact_path?: string;
    artifact_sha256?: string;
  };
  local?: {
    action: "resume-known-job-poll" | "retry-verified-download";
    job_id: string;
    known_job: {
      generation_job_id: string;
      provider_job_id: string;
      connection_id: string;
      connection_digest: string;
    };
    tree_revision: number;
    task_revision: number;
    input_digest: string;
    jobs_root: string;
  };
  coordinator_principal?: DurableCoordinatorPrincipalEvidence;
  live_gate1?: LiveGate1Evidence;
  execution_bundle?: ExecutionCompilationBundle;
  sibling_node_ids?: string[];
  issued_at?: string;
  now?: string;
};

export type CoordinatorRecoverCliResult =
  | {
      ok: true;
      mode: "plan";
      plan: CoordinatorRecoveryPlan;
      resume?: {
        applied_from_sequence: number;
        ledger_recovery?: { status: "ok"; recovered_tx_ids: string[] };
      };
    }
  | { ok: true; mode: "apply-local"; result: ActiveLocalRecoveryResult }
  | { ok: true; mode: "apply-paid"; result: ActivePaidRegenerationResult }
  | { ok: false; issues: Array<{ code: string; message: string }> };

export async function loadRecoveryPackage(packageDir: string): Promise<RecoveryPackage> {
  const raw = await readFile(join(packageDir, "recovery-package.json"), "utf8");
  const parsed = JSON.parse(raw) as RecoveryPackage;
  if (!parsed || typeof parsed !== "object") {
    throw pcError("PC_RECOVERY_DENIED", "recovery package is invalid");
  }
  if (parsed.policy) parsed.policy = parseRegenerationPolicySpec(parsed.policy);
  if (parsed.grant) parsed.grant = parseRegenerationGrant(parsed.grant);
  return parsed;
}

export async function runCoordinatorRecoverCli(input: {
  recovery: "local" | "paid";
  apply: boolean;
  confirm_paid: boolean;
  node_id: string;
  error_code: string;
  productionControlRoot: string;
  packageDir?: string;
  production_id?: string;
}): Promise<CoordinatorRecoverCliResult> {
  try {
    return await runCoordinatorRecoverCliInner(input);
  } catch (error) {
    if (error instanceof ProductionControlError) {
      return { ok: false, issues: [{ code: error.code, message: error.message }] };
    }
    return {
      ok: false,
      issues: [{
        code: "recover.failed",
        message: error instanceof Error ? error.message : String(error)
      }]
    };
  }
}

async function runCoordinatorRecoverCliInner(input: {
  recovery: "local" | "paid";
  apply: boolean;
  confirm_paid: boolean;
  node_id: string;
  error_code: string;
  productionControlRoot: string;
  packageDir?: string;
  production_id?: string;
}): Promise<CoordinatorRecoverCliResult> {
  const pkg = input.packageDir ? await loadRecoveryPackage(input.packageDir) : undefined;
  const productionId = pkg?.production_id ?? input.production_id ?? "prod-unknown";
  let missionState: MissionState =
    pkg?.mission_state ?? createFailedKnownMission(productionId, input.node_id);

  // Resume reconciles event chain + ledger; ledger errors surface (not swallowed).
  const resumed = await resumeProductionControl({
    mode: "active",
    production_id: productionId,
    root: input.productionControlRoot
  });
  if (Object.keys(resumed.state.nodes).length > 0) {
    missionState = resumed.state;
  }
  const resumeMeta = {
    applied_from_sequence: resumed.applied_from_sequence,
    ...(resumed.ledger_recovery ? { ledger_recovery: resumed.ledger_recovery } : {})
  };

  const failureKind = pkg?.failure_kind ?? "known-failure";
  const plan = planCoordinatorRecovery({
    production_id: productionId,
    node_id: input.node_id,
    observed_error_code: input.error_code,
    failure_kind: failureKind,
    mission_state: missionState,
    policy: pkg?.policy,
    evidence: {
      gate_bundle_digest: pkg?.gate_bundle?.digest,
      grant_digest: pkg?.grant?.digest,
      gate_1_decision_digest: pkg?.live_gate_1_decision_digest,
      job_id: pkg?.local?.job_id
    }
  });

  if (!input.apply) {
    return { ok: true, mode: "plan", plan, resume: resumeMeta };
  }

  if (input.recovery === "local") {
    return applyLocal(pkg, productionId, input.node_id, missionState);
  }
  return applyPaid(pkg, productionId, input, failureKind, missionState);
}

async function applyLocal(
  pkg: RecoveryPackage | undefined,
  productionId: string,
  nodeId: string,
  missionState: MissionState
): Promise<CoordinatorRecoverCliResult> {
  if (!pkg?.local) {
    return {
      ok: false,
      issues: [{
        code: "recover.local_package_required",
        message: "local apply requires a recovery package with local job binding"
      }]
    };
  }
  const jobStore = new GenerationJobStore({ rootDir: pkg.local.jobs_root });
  const machine = new GenerationJobMachine({
    store: jobStore,
    adapter: buildFixtureAdapter(pkg),
    orchestrationMode: "active"
  });
  const result = await runActiveLocalRecovery({
    production_id: productionId,
    node_id: nodeId,
    mission_state: missionState,
    tree_revision: pkg.local.tree_revision,
    task_revision: pkg.local.task_revision,
    input_digest: pkg.local.input_digest,
    action: pkg.local.action,
    known_job: pkg.local.known_job,
    job_id: pkg.local.job_id,
    jobStore,
    machine,
    sibling_node_ids: pkg.sibling_node_ids,
    issued_at: pkg.issued_at,
    now: pkg.now ? new Date(pkg.now) : undefined
  });
  return { ok: true, mode: "apply-local", result };
}

async function applyPaid(
  pkg: RecoveryPackage | undefined,
  productionId: string,
  input: {
    confirm_paid: boolean;
    node_id: string;
    error_code: string;
    productionControlRoot: string;
  },
  failureKind: ActivePaidRegenerationInput["failure_kind"],
  missionState: MissionState
): Promise<CoordinatorRecoverCliResult> {
  if (!input.confirm_paid) {
    return {
      ok: false,
      issues: [{
        code: "recover.confirm_paid_required",
        message: "paid recovery apply requires --confirm-paid (silent spend is forbidden)"
      }]
    };
  }
  if (!pkg?.policy || !pkg.gate_bundle || !pkg.gate_1_decision || !pkg.job_request) {
    return {
      ok: false,
      issues: [{
        code: "recover.paid_package_incomplete",
        message: "paid apply requires policy, gate_bundle, gate_1_decision, and job_request in the package"
      }]
    };
  }
  if (!pkg.fixture_adapter) {
    return {
      ok: false,
      issues: [{
        code: "recover.fixture_only",
        message: "paid apply via CLI is fixture-package only in this path; live provider spend is not enabled here"
      }]
    };
  }

  const subjectDigest = pkg.live_gate_1_subject_digest ?? "a".repeat(64);
  const decisionDigest = pkg.live_gate_1_decision_digest ?? "b".repeat(64);
  const principalBody = {
    schema_version: 1 as const,
    kind: "coordinator-principal" as const,
    actor: "coordinator" as const,
    gate_1_decision_digest: decisionDigest
  };
  const principal: DurableCoordinatorPrincipalEvidence = pkg.coordinator_principal ?? {
    ...principalBody,
    digest: sha256Canonical(principalBody)
  };
  const liveGate1: LiveGate1Evidence = pkg.live_gate1 ?? {
    subject_digest: subjectDigest,
    decision_digest: decisionDigest,
    production_id: productionId,
    run_id: pkg.run_id,
    legacy_approved_input_digest: "d".repeat(64),
    decision: {
      decision_id: pkg.gate_1_decision.decision_id,
      decision: pkg.gate_1_decision.decision,
      actor: pkg.gate_1_decision.actor,
      decided_at: pkg.gate_1_decision.decided_at
    }
  };

  const forceMap = {
    success: "success",
    "known-non-submission": "known-non-submission",
    submission_unknown: "submission_unknown"
  } as const;
  const forceOutcome =
    pkg.fixture_adapter.outcome in forceMap
      ? forceMap[pkg.fixture_adapter.outcome as keyof typeof forceMap]
      : undefined;

  const paidInput: ActivePaidRegenerationInput & { confirm_paid: true } = {
    confirm_paid: true,
    production_id: productionId,
    run_id: pkg.run_id,
    project_id: pkg.project_id,
    revision_id: pkg.revision_id,
    productionControlRoot: input.productionControlRoot,
    node_id: input.node_id,
    observed_error_code: input.error_code,
    failure_kind: failureKind,
    policy: pkg.policy,
    gate_bundle: pkg.gate_bundle,
    gate_1_decision: pkg.gate_1_decision,
    live_gate_1_subject_digest: subjectDigest,
    live_gate_1_decision_digest: decisionDigest,
    grant: pkg.grant,
    base_compilation_digest: pkg.base_compilation_digest ?? "f".repeat(64),
    derived_compilation_digest: pkg.derived_compilation_digest ?? "e".repeat(64),
    patch_artifact_digest: pkg.patch_artifact_digest ?? "b".repeat(64),
    requested_credits: pkg.requested_credits ?? 1,
    ordinal: pkg.ordinal ?? 0,
    trigger_failure_ref: pkg.trigger_failure_ref ?? {
      kind: "failure",
      id: "f1",
      digest: "a".repeat(64)
    },
    mission_state: missionState,
    sibling_node_ids: pkg.sibling_node_ids,
    job_request: pkg.job_request,
    adapter: buildFixtureAdapter(pkg),
    resolveExecutionBundle: async () => {
      if (!pkg.execution_bundle) {
        throw pcError("PC_RECOVERY_DENIED", "fixture package missing execution_bundle");
      }
      return pkg.execution_bundle;
    },
    live_gate1: liveGate1,
    coordinator_principal: principal,
    ...(forceOutcome ? { force_outcome: forceOutcome } : {}),
    issued_at: pkg.issued_at,
    now: pkg.now ? new Date(pkg.now) : undefined
  };

  const result = await executeCoordinatorPaidRecovery(paidInput);
  return { ok: true, mode: "apply-paid", result };
}

function createFailedKnownMission(productionId: string, nodeId: string): MissionState {
  const base = createInitialMissionState(productionId);
  return {
    ...base,
    mission_status: "running",
    nodes: {
      [nodeId]: {
        node_id: nodeId,
        status: "failed_known",
        task_revision: 1,
        input_digest: "a".repeat(64),
        dependency_closure_digest: "b".repeat(64),
        stale: false
      }
    }
  };
}

function buildFixtureAdapter(pkg: RecoveryPackage): GenerationJobProviderAdapter {
  const fixture = pkg.fixture_adapter;
  const providerJobId = fixture?.provider_job_id ?? "fixture-provider-1";
  const connectionId =
    pkg.job_request?.connection_id ?? pkg.local?.known_job.connection_id ?? "fixture";
  return {
    adapter_id: "fixture-recovery",
    connection_id: connectionId,
    capabilities: { submit: true, poll: true, download: true, cancel: false },
    async preflight() {
      return { ok: true as const, execution_ready: true };
    },
    async submit() {
      if (fixture?.outcome === "known-non-submission") {
        return {
          ok: false as const,
          code: "KNOWN_NON_SUBMISSION",
          message: "fixture known non-submission",
          acceptance_possible: false,
          retryable: false
        };
      }
      if (fixture?.outcome === "submission_unknown") {
        throw Object.assign(new Error("fixture network partition after POST"), {
          code: "SUBMISSION_OUTCOME_UNKNOWN"
        });
      }
      return { ok: true as const, provider_job_id: providerJobId, accepted: true as const };
    },
    async poll() {
      return { ok: true as const, status: "succeeded" as const };
    },
    async download() {
      return {
        ok: true as const,
        absolute_path: fixture?.artifact_path ?? join("/private/tmp", "fixture-recovery.bin"),
        sha256: fixture?.artifact_sha256 ?? "a".repeat(64),
        byte_length: 1
      };
    }
  };
}
