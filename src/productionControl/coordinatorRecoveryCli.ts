/**
 * Coordinator recovery CLI bridge (PO-6).
 * Explicit entry only — never silent paid auto-spend from run/resume.
 *
 * Fixture packages may supply in-process adapters under an explicit fixture namespace.
 * Fixture results are not production durable truth and never imply live network spend.
 * Live provider paid apply is not enabled on this path.
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
import { loadDurableGateBundle } from "./activePipeline.js";
import {
  loadDurableCoordinatorPrincipal,
  loadDurableGateDecision
} from "./durableGateEvidence.js";
import { assertContainedUnderProjectRoot } from "./recoveryPathSafety.js";

/** Explicit fixture namespace — never promoted to production durable authority. */
export type RecoveryFixtureAdapterSpec = {
  /** Must be "fixture" — rejects accidental production adapter injection. */
  namespace: "fixture";
  outcome: "success" | "known-non-submission" | "submission_unknown";
  provider_job_id?: string;
  artifact_path?: string;
  artifact_sha256?: string;
};

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
  /**
   * Explicit fixture namespace only. Paid CLI apply requires this; live provider
   * spend is not enabled here. Fixture evidence cannot promote to production truth.
   */
  fixture_adapter?: RecoveryFixtureAdapterSpec;
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
    /** Must stay under authoritative project realpath. */
    jobs_root: string;
  };
  coordinator_principal?: DurableCoordinatorPrincipalEvidence;
  live_gate1?: LiveGate1Evidence;
  execution_bundle?: ExecutionCompilationBundle;
  sibling_node_ids?: string[];
  issued_at?: string;
  now?: string;
  /**
   * Optional project-relative run dir for durable evidence re-read.
   * When present, GateBundle / Gate1 decision / coordinator principal are loaded
   * from the authoritative store and must exact-match package claims.
   */
  durable_run_dir?: string;
};

export type PaidSpendProvenance = {
  /** True only when --confirm-paid was explicit. */
  confirmed: boolean;
  /** True when spend path could run without human confirm (must always be false on success). */
  silent: boolean;
  /** True when fixture adapter namespace was used (no live provider). */
  fixture_only: boolean;
  /** Always false on this CLI path — real provider billing is not enabled. */
  real_provider: boolean;
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
      paid_spend?: undefined;
      fixture_only?: boolean;
    }
  | {
      ok: true;
      mode: "apply-local";
      result: ActiveLocalRecoveryResult;
      paid_spend?: undefined;
      fixture_only?: boolean;
    }
  | {
      ok: true;
      mode: "apply-paid";
      result: ActivePaidRegenerationResult;
      /** Provenance for silent_paid_spend derivation — never a hardcoded constant alone. */
      paid_spend: PaidSpendProvenance;
      fixture_only: true;
    }
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
  /** Authoritative project root (config directory). All recovery paths confined here. */
  projectRoot: string;
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
  projectRoot: string;
  productionControlRoot: string;
  packageDir?: string;
  production_id?: string;
}): Promise<CoordinatorRecoverCliResult> {
  const projectContained = await assertContainedUnderProjectRoot({
    projectRoot: input.projectRoot,
    candidate: input.projectRoot,
    label: "projectRoot"
  });
  const projectReal = projectContained.project_real_path;

  const pcContained = await assertContainedUnderProjectRoot({
    projectRoot: projectReal,
    candidate: input.productionControlRoot,
    label: "productionControlRoot",
    allowMissingLeaf: true
  });
  const productionControlRoot = pcContained.real_path;

  let packageDir: string | undefined;
  let pkg: RecoveryPackage | undefined;
  if (input.packageDir) {
    const pkgContained = await assertContainedUnderProjectRoot({
      projectRoot: projectReal,
      candidate: input.packageDir,
      label: "packageDir"
    });
    packageDir = pkgContained.real_path;
    // TOCTOU: re-contain after load path is fixed, then read.
    await assertContainedUnderProjectRoot({
      projectRoot: projectReal,
      candidate: packageDir,
      label: "packageDir"
    });
    pkg = await loadRecoveryPackage(packageDir);
  }

  const productionId = pkg?.production_id ?? input.production_id ?? "prod-unknown";
  let missionState: MissionState =
    pkg?.mission_state ?? createFailedKnownMission(productionId, input.node_id);

  // Resume reconciles event chain + ledger; ledger errors surface (not swallowed).
  const resumed = await resumeProductionControl({
    mode: "active",
    production_id: productionId,
    root: productionControlRoot
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
    return {
      ok: true,
      mode: "plan",
      plan,
      resume: resumeMeta,
      fixture_only: Boolean(pkg?.fixture_adapter)
    };
  }

  if (input.recovery === "local") {
    return applyLocal(pkg, productionId, input.node_id, missionState, projectReal);
  }
  return applyPaid(pkg, productionId, {
    confirm_paid: input.confirm_paid,
    node_id: input.node_id,
    error_code: input.error_code,
    productionControlRoot,
    projectRoot: projectReal
  }, failureKind, missionState);
}

async function applyLocal(
  pkg: RecoveryPackage | undefined,
  productionId: string,
  nodeId: string,
  missionState: MissionState,
  projectRoot: string
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
  const jobsContained = await assertContainedUnderProjectRoot({
    projectRoot,
    candidate: pkg.local.jobs_root,
    label: "local.jobs_root",
    allowMissingLeaf: true
  });
  const jobStore = new GenerationJobStore({ rootDir: jobsContained.real_path });
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
  return {
    ok: true,
    mode: "apply-local",
    result,
    fixture_only: Boolean(pkg.fixture_adapter)
  };
}

async function applyPaid(
  pkg: RecoveryPackage | undefined,
  productionId: string,
  input: {
    confirm_paid: boolean;
    node_id: string;
    error_code: string;
    productionControlRoot: string;
    projectRoot: string;
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
  if (!pkg) {
    return {
      ok: false,
      issues: [{
        code: "recover.paid_package_incomplete",
        message: "paid apply requires a recovery package"
      }]
    };
  }
  if (!pkg.fixture_adapter) {
    return {
      ok: false,
      issues: [{
        code: "recover.fixture_only",
        message:
          "paid apply via CLI is fixture-package only in this path; live provider spend is not enabled here"
      }]
    };
  }
  if (pkg.fixture_adapter.namespace !== "fixture") {
    return {
      ok: false,
      issues: [{
        code: "recover.fixture_only",
        message: "fixture_adapter.namespace must be exactly \"fixture\"; production adapters are not accepted"
      }]
    };
  }

  const evidence = await resolvePaidPackageEvidence(pkg, productionId, input.projectRoot);
  if (!evidence.ok) {
    return { ok: false, issues: evidence.issues };
  }

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
    policy: evidence.policy,
    gate_bundle: evidence.gate_bundle,
    gate_1_decision: evidence.gate_1_decision,
    live_gate_1_subject_digest: evidence.live_gate_1_subject_digest,
    live_gate_1_decision_digest: evidence.live_gate_1_decision_digest,
    grant: pkg.grant,
    base_compilation_digest: evidence.base_compilation_digest,
    derived_compilation_digest: evidence.derived_compilation_digest,
    patch_artifact_digest: evidence.patch_artifact_digest,
    requested_credits: evidence.requested_credits,
    ordinal: evidence.ordinal,
    trigger_failure_ref: evidence.trigger_failure_ref,
    mission_state: missionState,
    sibling_node_ids: pkg.sibling_node_ids,
    job_request: evidence.job_request,
    adapter: buildFixtureAdapter(pkg),
    resolveExecutionBundle: async () => {
      if (!pkg.execution_bundle) {
        throw pcError("PC_RECOVERY_DENIED", "fixture package missing execution_bundle");
      }
      return pkg.execution_bundle;
    },
    live_gate1: evidence.live_gate1,
    coordinator_principal: evidence.coordinator_principal,
    ...(forceOutcome ? { force_outcome: forceOutcome } : {}),
    issued_at: pkg.issued_at,
    now: pkg.now ? new Date(pkg.now) : undefined
  };

  // Public paid entry requires Coordinator path + explicit confirm_paid (no silent spend).
  const result = await executeCoordinatorPaidRecovery(paidInput);
  const paid_spend: PaidSpendProvenance = {
    confirmed: input.confirm_paid === true,
    silent: input.confirm_paid !== true,
    fixture_only: true,
    real_provider: false
  };
  return {
    ok: true,
    mode: "apply-paid",
    result,
    paid_spend,
    fixture_only: true
  };
}

type EvidenceOk = {
  ok: true;
  policy: RegenerationPolicySpec;
  gate_bundle: GateBundle;
  gate_1_decision: HumanDecisionRef;
  live_gate_1_subject_digest: string;
  live_gate_1_decision_digest: string;
  base_compilation_digest: string;
  derived_compilation_digest: string;
  patch_artifact_digest: string;
  requested_credits: number;
  ordinal: number;
  trigger_failure_ref: ActivePaidRegenerationInput["trigger_failure_ref"];
  job_request: GenerationJobRequest;
  live_gate1: LiveGate1Evidence;
  coordinator_principal: DurableCoordinatorPrincipalEvidence;
};

/**
 * No synthetic hex digests / default principals.
 * Fixture packages must carry complete explicit evidence.
 * When durable_run_dir is set, re-read authoritative store and exact-match package claims.
 */
async function resolvePaidPackageEvidence(
  pkg: RecoveryPackage,
  productionId: string,
  projectRoot: string
): Promise<EvidenceOk | { ok: false; issues: Array<{ code: string; message: string }> }> {
  const missing: string[] = [];
  if (!pkg.policy) missing.push("policy");
  if (!pkg.gate_bundle) missing.push("gate_bundle");
  if (!pkg.gate_1_decision) missing.push("gate_1_decision");
  if (!pkg.job_request) missing.push("job_request");
  if (!isHexDigest(pkg.live_gate_1_subject_digest)) missing.push("live_gate_1_subject_digest");
  if (!isHexDigest(pkg.live_gate_1_decision_digest)) missing.push("live_gate_1_decision_digest");
  if (!isHexDigest(pkg.base_compilation_digest)) missing.push("base_compilation_digest");
  if (!isHexDigest(pkg.derived_compilation_digest)) missing.push("derived_compilation_digest");
  if (!isHexDigest(pkg.patch_artifact_digest)) missing.push("patch_artifact_digest");
  if (!pkg.coordinator_principal) missing.push("coordinator_principal");
  if (!pkg.live_gate1) missing.push("live_gate1");
  if (typeof pkg.requested_credits !== "number") missing.push("requested_credits");
  if (typeof pkg.ordinal !== "number") missing.push("ordinal");
  if (!pkg.trigger_failure_ref) missing.push("trigger_failure_ref");
  if (!pkg.run_id || !pkg.project_id || !pkg.revision_id) {
    missing.push("run_id/project_id/revision_id");
  }

  if (missing.length > 0) {
    return {
      ok: false,
      issues: [{
        code: "recover.live_evidence_required",
        message:
          `paid recovery evidence incomplete (no synthetic defaults): missing ${missing.join(", ")}`
      }]
    };
  }

  // Re-read durable store when package points at an authoritative run dir.
  if (pkg.durable_run_dir) {
    const runContained = await assertContainedUnderProjectRoot({
      projectRoot,
      candidate: pkg.durable_run_dir,
      label: "durable_run_dir"
    });
    const runDir = runContained.real_path;
    const durableBundle = await loadDurableGateBundle(runDir);
    const durableDecision = await loadDurableGateDecision(runDir, "gate_1");
    const durablePrincipal = await loadDurableCoordinatorPrincipal(runDir);

    if (!durableBundle || !durableDecision || !durablePrincipal) {
      return {
        ok: false,
        issues: [{
          code: "recover.live_evidence_required",
          message:
            "durable GateBundle / Gate1 decision / coordinator principal missing under durable_run_dir"
        }]
      };
    }
    if (durableBundle.digest !== pkg.gate_bundle!.digest) {
      return {
        ok: false,
        issues: [{
          code: "recover.live_evidence_required",
          message: "package gate_bundle digest does not exact-match durable GateBundle"
        }]
      };
    }
    if (durableDecision.decision_digest !== pkg.live_gate_1_decision_digest) {
      return {
        ok: false,
        issues: [{
          code: "recover.live_evidence_required",
          message: "package gate_1 decision digest does not exact-match durable decision"
        }]
      };
    }
    if (
      durableDecision.decision.decision_id !== pkg.gate_1_decision!.decision_id
      || durableDecision.decision.decision !== pkg.gate_1_decision!.decision
      || durableDecision.decision.actor !== pkg.gate_1_decision!.actor
      || durableDecision.decision.decided_at !== pkg.gate_1_decision!.decided_at
    ) {
      return {
        ok: false,
        issues: [{
          code: "recover.live_evidence_required",
          message: "package HumanDecisionRef does not exact-match durable Gate1 decision"
        }]
      };
    }
    if (durablePrincipal.digest !== pkg.coordinator_principal!.digest) {
      return {
        ok: false,
        issues: [{
          code: "recover.live_evidence_required",
          message: "package coordinator_principal does not exact-match durable principal"
        }]
      };
    }
    if (durablePrincipal.gate_1_decision_digest !== pkg.live_gate_1_decision_digest) {
      return {
        ok: false,
        issues: [{
          code: "recover.live_evidence_required",
          message: "durable principal gate_1_decision_digest mismatch"
        }]
      };
    }
  }

  // Fixture principal must bind the claimed decision digest (no synthetic stand-in).
  const principal = pkg.coordinator_principal!;
  if (
    principal.actor !== "coordinator"
    || principal.kind !== "coordinator-principal"
    || principal.gate_1_decision_digest !== pkg.live_gate_1_decision_digest
  ) {
    return {
      ok: false,
      issues: [{
        code: "recover.live_evidence_required",
        message: "coordinator_principal must bind package live_gate_1_decision_digest"
      }]
    };
  }
  const principalBody = {
    schema_version: 1 as const,
    kind: "coordinator-principal" as const,
    actor: "coordinator" as const,
    gate_1_decision_digest: principal.gate_1_decision_digest
  };
  if (principal.digest !== sha256Canonical(principalBody)) {
    return {
      ok: false,
      issues: [{
        code: "recover.live_evidence_required",
        message: "coordinator_principal digest mismatch"
      }]
    };
  }

  const liveGate1 = pkg.live_gate1!;
  if (
    liveGate1.subject_digest !== pkg.live_gate_1_subject_digest
    || liveGate1.decision_digest !== pkg.live_gate_1_decision_digest
    || liveGate1.production_id !== productionId
    || liveGate1.run_id !== pkg.run_id
  ) {
    return {
      ok: false,
      issues: [{
        code: "recover.live_evidence_required",
        message: "live_gate1 digests/ids must exact-match package claims"
      }]
    };
  }

  return {
    ok: true,
    policy: pkg.policy!,
    gate_bundle: pkg.gate_bundle!,
    gate_1_decision: pkg.gate_1_decision!,
    live_gate_1_subject_digest: pkg.live_gate_1_subject_digest!,
    live_gate_1_decision_digest: pkg.live_gate_1_decision_digest!,
    base_compilation_digest: pkg.base_compilation_digest!,
    derived_compilation_digest: pkg.derived_compilation_digest!,
    patch_artifact_digest: pkg.patch_artifact_digest!,
    requested_credits: pkg.requested_credits!,
    ordinal: pkg.ordinal!,
    trigger_failure_ref: pkg.trigger_failure_ref!,
    job_request: pkg.job_request!,
    live_gate1: liveGate1,
    coordinator_principal: principal
  };
}

function isHexDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
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
      // Fixture-only download stub — absolute outside paths are not production artifacts.
      return {
        ok: true as const,
        absolute_path: fixture?.artifact_path ?? join(pkg.local?.jobs_root ?? ".", "fixture-recovery.bin"),
        sha256: fixture?.artifact_sha256 ?? "a".repeat(64),
        byte_length: 1
      };
    }
  };
}
