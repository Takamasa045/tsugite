/**
 * Active-mode generation execution for the live orchestrator run path.
 * Durable GenerationJob + full production binding + GateBundle membership
 * + T05 adopt/lease + ProductionDispatcher. Never calls runCliGenerationAdapter.
 */
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GenerationRequest } from "../project/schema.js";
import type { Result } from "../types.js";
import type { CliGenerationResult } from "../adapters/cliGeneration.js";
import type { GenerationJobProviderAdapter } from "../generationJobs/adapter.js";
import { GenerationJobMachine } from "../generationJobs/machine.js";
import { GenerationJobStore } from "../generationJobs/store.js";
import { computeRequestDigest } from "../generationJobs/approval.js";
import type { GenerationJobRequest } from "../generationJobs/schema.js";
import { sha256Canonical } from "./canonical.js";
import { pcError, ProductionControlError } from "./errors.js";
import {
  buildActiveGate1ProductionBinding,
  createFullProductionJobBinding,
  loadDurableGateBundle,
  requireActiveModeForEffect
} from "./activePipeline.js";
import {
  createCompletionRefFromPinnedJob,
  type GenerationCompletionRef
} from "./generationBridge.js";
import {
  loadDurableCoordinatorPrincipal,
  loadDurableGateDecision,
  writeDurableSelectedCompletions
} from "./durableGateEvidence.js";
import { ProductionDispatcher } from "./dispatcher.js";
import {
  createAttemptLease,
  createLeaseIndex,
  registerLease,
  releaseLease
} from "./leases.js";
import { resumeProductionControl } from "./resume.js";
import type { GateBundle } from "./gateBundle.js";
import type { RouteIdentity } from "./programBinding.js";
import type { ExecutionCompilationBundle } from "../videoPromptDirector/compilationBundle.js";
import type { RunState } from "../orchestrator/stateTypes.js";

export type ActiveRunGenerationOptions = {
  runId: string;
  runDir: string;
  state: RunState;
  production_id: string;
  /** Must match the T05-adopted bundle provenance (not a free-form alias). */
  project_id: string;
  /** Exact planning/execution revision id bound at T05 adopt time. */
  revision_id: string;
  pinnedRequests: GenerationRequest[];
  /** Fixture/stub or real GenerationJob adapter. Required for active. */
  adapter: GenerationJobProviderAdapter;
  /** Must return a T05-adopted execution-capable compilation bundle. */
  resolveExecutionBundle: (
    jobId: string,
    request: GenerationRequest
  ) => Promise<ExecutionCompilationBundle> | ExecutionCompilationBundle;
  gate_bundle?: GateBundle;
  dispatcher?: ProductionDispatcher;
  /** When set, resumeProductionControl is attempted before effectful work. */
  productionControlRoot?: string;
  now?: () => string;
};

function toJobRequest(request: GenerationRequest, connectionId: string): GenerationJobRequest {
  const mode = String(
    (request as { mode?: string }).mode
    ?? (request as { video_prompt?: { target?: { mode?: string } } }).video_prompt?.target?.mode
    ?? "text-to-video"
  );
  const modelId = String(
    (request as { model?: string }).model
    ?? (request as { video_prompt?: { target?: { model_profile_id?: string } } })
      .video_prompt?.target?.model_profile_id
    ?? "unknown-model"
  );
  const base = {
    digest: "",
    model_id: modelId,
    mode,
    connection_id: connectionId,
    auth_env_names: [] as string[],
    asset_paths: [] as string[],
    params: {
      request_id: request.id,
      ...(typeof (request as { prompt?: unknown }).prompt === "string"
        ? { prompt: (request as { prompt: string }).prompt }
        : {})
    }
  };
  return { ...base, digest: computeRequestDigest(base) };
}

function routeFromBatch(bundle: GateBundle, compilationDigest: string): {
  route: RouteIdentity;
  pricing_binding_digest: string;
  batch_id: string;
} {
  for (const batch of bundle.generation_batches) {
    for (const unit of batch.ordered_units) {
      if (unit.base_compilation_digest === compilationDigest) {
        return {
          route: batch.route,
          pricing_binding_digest: batch.pricing_binding_digest,
          batch_id: batch.batch_id
        };
      }
    }
  }
  if (
    bundle.generation_batches.length === 1
    && bundle.generation_batches[0]!.ordered_units.length >= 1
  ) {
    const batch = bundle.generation_batches[0]!;
    return {
      route: batch.route,
      pricing_binding_digest: batch.pricing_binding_digest,
      batch_id: batch.batch_id
    };
  }
  throw pcError(
    "PC_GENERATION_BINDING_INVALID",
    "active generation requires GateBundle unit membership for compilation"
  );
}

/**
 * Execute active generation through durable jobs + T05 + dispatcher.
 * Active call graph never reaches runCliGenerationAdapter.
 */
export async function executeActiveGenerationForRun(
  options: ActiveRunGenerationOptions
): Promise<Result<CliGenerationResult & { completion_refs: GenerationCompletionRef[] }>> {
  requireActiveModeForEffect("active", "external-submit");

  const bundle = options.gate_bundle ?? (await loadDurableGateBundle(options.runDir));
  if (!bundle) {
    return {
      ok: false,
      issues: [{
        code: "run.active_gate_bundle_missing",
        message: "active generation requires durable GateBundle from plan/review"
      }]
    };
  }
  if (bundle.generation_batches.length === 0) {
    return {
      ok: false,
      issues: [{
        code: "run.active_gate_bundle_empty",
        message: "active generation requires nonempty GateBundle batches"
      }]
    };
  }

  const gate1 = await loadDurableGateDecision(options.runDir, "gate_1");
  if (!gate1) {
    return {
      ok: false,
      issues: [{
        code: "run.active_gate1_decision_missing",
        message: "active generation requires durable Gate 1 HumanDecisionRef"
      }]
    };
  }

  const principal = await loadDurableCoordinatorPrincipal(options.runDir);
  if (!principal || principal.gate_1_decision_digest !== gate1.decision_digest) {
    return {
      ok: false,
      issues: [{
        code: "run.active_coordinator_principal_missing",
        message: "active generation requires verified durable coordinator principal evidence"
      }]
    };
  }

  if (options.productionControlRoot) {
    const rootKind = await inspectProductionControlRoot(options.productionControlRoot);
    if (rootKind === "empty" || rootKind === "missing") {
      // Truly empty/new control roots may proceed without event history.
    } else {
      // Non-empty roots must resume cleanly. Corrupt/tampered chains fail closed
      // before any job create or adapter invocation.
      try {
        await resumeProductionControl({
          mode: "active",
          root: options.productionControlRoot,
          production_id: options.production_id
        });
        // Resume may succeed with 0 committed events while a corrupt uncommitted
        // log tail remains — treat that as fail-closed (not empty/new).
        const { EventStore } = await import("./eventStore.js");
        const recovery = await new EventStore(options.productionControlRoot).recover();
        if (recovery.uncommitted_line_count > 0) {
          return {
            ok: false,
            issues: [{
              code: "run.active_production_control_resume_failed",
              message:
                "production control root is non-empty with corrupt uncommitted event tail; "
                + "refusing active generation before job/adapter"
            }]
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof ProductionControlError
          ? error.code
          : "PC_RESUME_INVALID";
        return {
          ok: false,
          issues: [{
            code: "run.active_production_control_resume_failed",
            message: `production control root is non-empty and failed resume (${code}): ${message}`
          }]
        };
      }
    }
  }

  const jobRoot = join(options.runDir, "generation-jobs");
  await mkdir(jobRoot, { recursive: true });
  const store = new GenerationJobStore({ rootDir: jobRoot });
  const dispatcher = options.dispatcher ?? new ProductionDispatcher();
  const leaseIndex = createLeaseIndex();
  const now = options.now ?? (() => new Date().toISOString());

  const clips: CliGenerationResult["clips"] = [];
  const images: CliGenerationResult["images"] = [];
  const audio: CliGenerationResult["audio"] = [];
  const requests: CliGenerationResult["requests"] = [];
  const completionRefs: GenerationCompletionRef[] = [];
  let credits = 0;

  for (const [index, pinned] of options.pinnedRequests.entries()) {
    const connectionId = options.adapter.connection_id;
    const jobRequest = toJobRequest(pinned, connectionId);
    const jobId = `job-${options.runId}-${pinned.id}`.replace(/[^A-Za-z0-9._-]/g, "-");
    const attemptId = `attempt-${jobId}-1`;
    const nodeId = `gen-node-${index}`;

    let executionBundle: ExecutionCompilationBundle;
    try {
      executionBundle = await options.resolveExecutionBundle(jobId, pinned);
    } catch (error) {
      return {
        ok: false,
        issues: [{
          code: "run.active_execution_bundle_failed",
          message: error instanceof Error ? error.message : String(error)
        }]
      };
    }
    if (!executionBundle?.execution_capable || !executionBundle.compilation_digest) {
      return {
        ok: false,
        issues: [{
          code: "run.active_execution_bundle_invalid",
          message: "active generation requires a T05-adopted execution-capable compilation bundle"
        }]
      };
    }

    let membership: ReturnType<typeof routeFromBatch>;
    try {
      membership = routeFromBatch(bundle, executionBundle.compilation_digest);
    } catch (error) {
      return {
        ok: false,
        issues: [{
          code: "run.active_binding_membership",
          message: error instanceof Error ? error.message : String(error)
        }]
      };
    }

    const attemptLease = createAttemptLease({
      lease_id: `lease-${attemptId}`,
      node_id: nodeId,
      task_revision: 0,
      attempt_id: attemptId,
      attempt_key: sha256Canonical({
        kind: "active-attempt-key",
        job_id: jobId,
        attempt_id: attemptId,
        request_digest: jobRequest.digest
      }),
      input_digest: jobRequest.digest,
      role: "generator",
      effect: "external-submit",
      expires_at: new Date(Date.now() + 60_000).toISOString()
    });
    try {
      registerLease(leaseIndex, attemptLease);
    } catch (error) {
      return {
        ok: false,
        issues: [{
          code: "run.active_lease_conflict",
          message: error instanceof Error ? error.message : String(error)
        }]
      };
    }

    const batch = bundle.generation_batches.find((b) => b.batch_id === membership.batch_id)!;
    const approvalDigest = sha256Canonical({
      kind: "active-job-approval-seed",
      job_id: jobId,
      request_digest: jobRequest.digest,
      gate_1_decision_digest: gate1.decision_digest
    });

    let binding;
    try {
      binding = createFullProductionJobBinding({
        production_id: options.production_id,
        run_id: options.runId,
        node_id: nodeId,
        attempt_id: attemptId,
        generation_job_id: jobId,
        approval_observed_revision: 0,
        approval_digest: approvalDigest,
        gate_bundle: bundle,
        gate_1_decision_digest: gate1.decision_digest,
        request_digest: jobRequest.digest,
        compilation_digest: executionBundle.compilation_digest,
        route: membership.route,
        pricing_binding_digest: membership.pricing_binding_digest
      });
    } catch (error) {
      releaseLease(leaseIndex, attemptLease.lease_id);
      return {
        ok: false,
        issues: [{
          code: "run.active_binding_invalid",
          message: error instanceof Error ? error.message : String(error)
        }]
      };
    }

    try {
      await store.create({
        job_id: jobId,
        connection_id: connectionId,
        model_id: jobRequest.model_id,
        mode: jobRequest.mode,
        request: jobRequest,
        model_profile_digest: membership.route.model_profile_digest,
        connection_capability_digest: membership.route.connection_digest,
        pricing: batch.pricing,
        status: "awaiting_cost_approval",
        production_binding: binding
      });
    } catch (error) {
      releaseLease(leaseIndex, attemptLease.lease_id);
      // Existing job (restart / double-run): never create a second submit path.
      return {
        ok: false,
        issues: [{
          code: "run.active_job_exists",
          message: error instanceof Error ? error.message : String(error)
        }]
      };
    }

    // Write a tiny local artifact file for stub download verification when needed.
    const artifactSeedPath = join(options.runDir, `active-seed-${jobId}.bin`);
    await writeFile(artifactSeedPath, Buffer.from(`fixture-active-${jobId}`));

    const machine = new GenerationJobMachine({
      store,
      adapter: options.adapter,
      orchestrationMode: "active",
      dispatcher,
      now,
      resolveExecutionBundle: async () => executionBundle,
      resolveSubmissionBinding: async (job) => ({
        production_id: options.production_id,
        project_id: options.project_id,
        revision_id: options.revision_id,
        request_id: executionBundle.request_id,
        attempt_id: job.production_binding!.attempt_id,
        job_id: job.job_id,
        compilation_digest: executionBundle.compilation_digest,
        effective_contract_digest: executionBundle.effective_contract_digest,
        asset_lineage_digest: sha256Canonical(executionBundle.asset_lineage),
        grammar_profile_digest: executionBundle.grammar_profile?.digest
      }),
      resolveGateBundle: async () => bundle,
      resolveLiveGate1: async () => recomputeLiveGate1Evidence({
        production_id: options.production_id,
        run_id: options.runId,
        gate_bundle: bundle,
        gate1,
        state: options.state
      }),
      resolveCoordinatorPrincipal: async () => principal
    });

    try {
      const approved = await machine.approve(jobId, "coordinator");
      if (approved.status !== "approved") {
        releaseLease(leaseIndex, attemptLease.lease_id);
        return {
          ok: false,
          issues: [{
            code: "run.active_job_approve_failed",
            message: `generation job '${jobId}' did not reach approved (status=${approved.status})`
          }]
        };
      }

      let current = await machine.submit(jobId);
      if (current.status === "submission_unknown") {
        releaseLease(leaseIndex, attemptLease.lease_id);
        return {
          ok: false,
          issues: [{
            code: "run.active_submission_unknown",
            message: `generation job '${jobId}' entered submission_unknown; automatic resubmit is forbidden`
          }]
        };
      }
      if (current.status !== "submitted" && current.status !== "succeeded" && current.status !== "pinned") {
        releaseLease(leaseIndex, attemptLease.lease_id);
        return {
          ok: false,
          issues: [{
            code: "run.active_job_submit_failed",
            message:
              current.error?.message
              ?? `generation job '${jobId}' submit failed (status=${current.status})`
          }]
        };
      }

      if (current.status === "submitted") {
        current = await machine.poll(jobId);
      }
      if (current.status === "succeeded" || current.status === "downloading") {
        current = await machine.downloadAndPin(jobId);
      }

      current = await store.load(jobId);
      if (current.status !== "pinned" || !current.artifact?.pinned) {
        releaseLease(leaseIndex, attemptLease.lease_id);
        return {
          ok: false,
          issues: [{
            code: "run.active_job_not_pinned",
            message: `generation job '${jobId}' did not reach pinned completion`
          }]
        };
      }

      const completion = createCompletionRefFromPinnedJob({
        job: current,
        binding,
        verification_digest: sha256Canonical({
          kind: "active-completion-verification",
          job_id: jobId,
          artifact: current.artifact.sha256
        })
      });
      completionRefs.push(completion);

      const src = current.artifact.relative_path;
      const clip = {
        id: `clip-${pinned.id}`,
        src,
        in: 0,
        out: 1,
        duration: 1,
        fps: 24,
        resolution: { width: 1280, height: 720 },
        audio: false
      };
      clips.push(clip);
      requests.push({
        request_id: pinned.id,
        attempts: 1,
        credits: 0,
        clips: [{
          id: `clip-${pinned.id}`,
          src,
          duration: 1,
          fps: 24,
          resolution: { width: 1280, height: 720 },
          audio: false
        }],
        images: [],
        audio: [],
        metadata: {
          generation_job_id: jobId,
          completion_digest: completion.digest,
          provider_job_id: current.provider_job_id,
          submission_via: "t05-lease"
        }
      });
    } catch (error) {
      releaseLease(leaseIndex, attemptLease.lease_id);
      return {
        ok: false,
        issues: [{
          code: "run.active_generation_failed",
          message: error instanceof Error ? error.message : String(error)
        }]
      };
    }

    releaseLease(leaseIndex, attemptLease.lease_id);
  }

  if (completionRefs.length > 0) {
    await writeDurableSelectedCompletions(options.runDir, completionRefs);
  }

  return {
    ok: true,
    issues: [],
    clips,
    images,
    audio,
    credits,
    requests,
    completion_refs: completionRefs
  };
}

/**
 * Classify a production-control root before resume.
 * - missing: path does not exist (safe first run)
 * - empty: directory exists but has no event/snapshot/artifact chain
 * - nonempty: any durable control evidence present (must resume fail-closed)
 */
export async function inspectProductionControlRoot(
  root: string
): Promise<"missing" | "empty" | "nonempty"> {
  try {
    await lstat(root);
  } catch {
    return "missing";
  }
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return "nonempty";
  }
  if (entries.length === 0) return "empty";
  const durableNames = new Set([
    "events.jsonl",
    "events.commit.json",
    "coordination-state.json",
    "artifacts",
    "leases"
  ]);
  for (const name of entries) {
    if (durableNames.has(name) || name.startsWith("events") || name.endsWith(".jsonl")) {
      return "nonempty";
    }
  }
  // Non-control files alone still count as non-empty (fail closed on unknown contents).
  return "nonempty";
}

/**
 * Recompute Gate1 subject/decision from durable GateBundle + HumanDecisionRef body,
 * verify actor/decision digest and current RunState, then return mint-ready evidence.
 * Free-form forged digest pairs never pass.
 */
export function recomputeLiveGate1Evidence(input: {
  production_id: string;
  run_id: string;
  gate_bundle: GateBundle;
  gate1: {
    decision: {
      decision_id: string;
      decision: string;
      actor: string;
      decided_at: string;
      reason?: string;
      subject_digest: string;
    };
    decision_digest: string;
    legacy_approved_input_digest?: string;
  };
  state: RunState;
}): {
  subject_digest: string;
  decision_digest: string;
  production_id: string;
  run_id: string;
  legacy_approved_input_digest: string;
  decision: {
    decision_id: string;
    decision: string;
    actor: string;
    decided_at: string;
    reason?: string;
  };
} {
  const legacy =
    input.gate1.legacy_approved_input_digest
    ?? input.state.gates.gate_1.approved_input_digest;
  if (!legacy) {
    throw pcError("PC_GATE_SUBJECT_STALE", "Gate 1 legacy approved_input_digest is missing");
  }
  const recomputed = buildActiveGate1ProductionBinding({
    production_id: input.production_id,
    run_id: input.run_id,
    gate_bundle: input.gate_bundle,
    legacy_approved_input_digest: legacy,
    decision: {
      decision_id: input.gate1.decision.decision_id,
      decision: input.gate1.decision.decision,
      actor: input.gate1.decision.actor,
      decided_at: input.gate1.decision.decided_at,
      ...(input.gate1.decision.reason ? { reason: input.gate1.decision.reason } : {})
    }
  });
  if (recomputed.decision_digest !== input.gate1.decision_digest) {
    throw pcError(
      "PC_GATE_SUBJECT_STALE",
      "recomputed Gate 1 decision digest does not match durable HumanDecisionRef"
    );
  }
  if (recomputed.subject_digest !== input.gate1.decision.subject_digest) {
    throw pcError(
      "PC_GATE_SUBJECT_STALE",
      "recomputed Gate 1 subject digest does not match durable decision subject"
    );
  }
  const stateSubject = input.state.gates.gate_1.production_subject_digest;
  const stateDecision = input.state.gates.gate_1.production_decision_digest;
  if (
    !stateSubject
    || !stateDecision
    || stateSubject !== recomputed.subject_digest
    || stateDecision !== recomputed.decision_digest
  ) {
    throw pcError(
      "PC_GATE_SUBJECT_STALE",
      "recomputed Gate 1 subjects do not match current RunState"
    );
  }
  if (input.gate1.decision.decision !== "approved" || !input.gate1.decision.actor) {
    throw pcError("PC_AUTHORITY_DENIED", "Gate 1 decision must be approved with a durable actor");
  }
  return {
    subject_digest: recomputed.subject_digest,
    decision_digest: recomputed.decision_digest,
    production_id: input.production_id,
    run_id: input.run_id,
    legacy_approved_input_digest: legacy,
    decision: {
      decision_id: input.gate1.decision.decision_id,
      decision: input.gate1.decision.decision,
      actor: input.gate1.decision.actor,
      decided_at: input.gate1.decision.decided_at,
      ...(input.gate1.decision.reason ? { reason: input.gate1.decision.reason } : {})
    }
  };
}

/**
 * Offline fixture/local GenerationJob adapter. No process/network/DNS.
 * Used by active CLI injection when connection evidence declares fixture transport.
 */
export function createFixtureGenerationJobAdapter(options: {
  connection_id: string;
  adapter_id?: string;
  artifact_bytes?: Buffer;
  onSubmit?: (
    request: GenerationJobRequest,
    ctx: { submission_input?: unknown; job: { request: GenerationJobRequest } }
  ) => void | Promise<void>;
  /** When set, returns this absolute path as the downloaded artifact. */
  fixture_artifact_path?: string;
}): GenerationJobProviderAdapter {
  const bytes = options.artifact_bytes ?? Buffer.from("fixture-active-generation");
  let providerJobId = "";
  return {
    adapter_id: options.adapter_id ?? "local-fixture",
    connection_id: options.connection_id,
    capabilities: { submit: true, poll: true, download: true, cancel: false },
    async preflight() {
      return { ok: true as const, execution_ready: true };
    },
    async submit(request, ctx) {
      // Active residual: never reopen project asset paths; submission_input is authority.
      if (Array.isArray(request.asset_paths) && request.asset_paths.length > 0) {
        return {
          ok: false as const,
          code: "fixture.asset_paths_forbidden",
          message: "active fixture adapter rejects reopenable asset_paths; use submission_input",
          acceptance_possible: false
        };
      }
      await options.onSubmit?.(request, ctx as never);
      providerJobId = `fixture-${request.digest.slice(0, 12)}`;
      return { ok: true as const, provider_job_id: providerJobId, accepted: true as const };
    },
    async poll() {
      return { ok: true as const, status: "succeeded" as const };
    },
    async download(_id, destinationDir) {
      const { createHash } = await import("node:crypto");
      const { copyFile, writeFile: wf } = await import("node:fs/promises");
      await mkdir(destinationDir, { recursive: true });
      const dest = join(destinationDir, "out.mp4");
      if (options.fixture_artifact_path) {
        await copyFile(options.fixture_artifact_path, dest);
        const { readFile } = await import("node:fs/promises");
        const data = await readFile(dest);
        return {
          ok: true as const,
          absolute_path: dest,
          sha256: createHash("sha256").update(data).digest("hex"),
          byte_length: data.byteLength
        };
      }
      await wf(dest, bytes);
      return {
        ok: true as const,
        absolute_path: dest,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byte_length: bytes.byteLength
      };
    },
    async cancel() {
      return { ok: true as const, cancelled: true };
    }
  };
}

/** Process-local fixture injection for CLI active path (tests only; cleared after). */
let installedActiveGenerationFixture:
  | {
      adapter: GenerationJobProviderAdapter;
      resolveExecutionBundle: ActiveRunGenerationOptions["resolveExecutionBundle"];
      project_id: string;
      revision_id: string;
      production_id?: string;
      productionControlRoot?: string;
      dispatcher?: ProductionDispatcher;
    }
  | undefined;

/**
 * Install a fixture active-generation injection for the live CLI/assemble path.
 * Production never calls this; tests must clear after use.
 */
export function installActiveGenerationFixtureForTests(fixture: {
  adapter: GenerationJobProviderAdapter;
  resolveExecutionBundle: ActiveRunGenerationOptions["resolveExecutionBundle"];
  project_id: string;
  revision_id: string;
  production_id?: string;
  productionControlRoot?: string;
  dispatcher?: ProductionDispatcher;
}): void {
  installedActiveGenerationFixture = fixture;
}

export function clearActiveGenerationFixtureForTests(): void {
  installedActiveGenerationFixture = undefined;
}

export function peekActiveGenerationFixtureForTests(): typeof installedActiveGenerationFixture {
  return installedActiveGenerationFixture;
}

export type ActiveGenerationInjection = {
  adapter: GenerationJobProviderAdapter;
  resolveExecutionBundle: ActiveRunGenerationOptions["resolveExecutionBundle"];
  project_id: string;
  revision_id: string;
  production_id?: string;
  productionControlRoot?: string;
  dispatcher?: ProductionDispatcher;
};

/**
 * Resolve active generation injection for CLI/assembleLocalMediaRun.
 * Explicit options win; else installed fixture (test/local); else fail closed.
 * Never invents a live network/provider adapter.
 */
export function resolveActiveGenerationInjection(input: {
  explicit?: ActiveGenerationInjection;
  /** Connection id evidence from project/run (fail closed when real capability missing). */
  connection_id?: string;
}): Result<ActiveGenerationInjection> {
  if (input.explicit?.adapter && input.explicit.resolveExecutionBundle) {
    return {
      ok: true,
      issues: [],
      adapter: input.explicit.adapter,
      resolveExecutionBundle: input.explicit.resolveExecutionBundle,
      project_id: input.explicit.project_id,
      revision_id: input.explicit.revision_id,
      ...(input.explicit.production_id ? { production_id: input.explicit.production_id } : {}),
      ...(input.explicit.productionControlRoot
        ? { productionControlRoot: input.explicit.productionControlRoot }
        : {}),
      ...(input.explicit.dispatcher ? { dispatcher: input.explicit.dispatcher } : {})
    };
  }
  const fixture = installedActiveGenerationFixture;
  if (fixture?.adapter && fixture.resolveExecutionBundle) {
    if (
      input.connection_id
      && fixture.adapter.connection_id
      && fixture.adapter.connection_id !== input.connection_id
    ) {
      return {
        ok: false,
        issues: [{
          code: "run.active_generation_connection_mismatch",
          message:
            `fixture adapter connection '${fixture.adapter.connection_id}' does not match `
            + `project connection '${input.connection_id}'`
        }]
      };
    }
    return {
      ok: true,
      issues: [],
      adapter: fixture.adapter,
      resolveExecutionBundle: fixture.resolveExecutionBundle,
      project_id: fixture.project_id,
      revision_id: fixture.revision_id,
      ...(fixture.production_id ? { production_id: fixture.production_id } : {}),
      ...(fixture.productionControlRoot
        ? { productionControlRoot: fixture.productionControlRoot }
        : {}),
      ...(fixture.dispatcher ? { dispatcher: fixture.dispatcher } : {})
    };
  }
  return {
    ok: false,
    issues: [{
      code: "run.active_generation_adapter_required",
      message:
        "active generation requires GenerationJob adapter + T05 execution bundle resolver "
        + "from project/run connection evidence; real missing capability fails closed "
        + "(no legacy CLI adapter fallback)"
    }]
  };
}
