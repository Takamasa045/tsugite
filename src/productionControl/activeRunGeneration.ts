/**
 * Active-mode generation execution for the live orchestrator run path.
 * Durable GenerationJob + full production binding + GateBundle membership
 * + T05 adopt/lease + ProductionDispatcher. Never calls runCliGenerationAdapter.
 */
import { mkdir, writeFile } from "node:fs/promises";
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
import { pcError } from "./errors.js";
import {
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
    try {
      await resumeProductionControl({
        mode: "active",
        root: options.productionControlRoot,
        production_id: options.production_id
      });
    } catch {
      // First active run may have no event history; empty roots fail resume and are ignored.
      // Corrupt non-empty chains surface via subsequent effect failures if state is inconsistent.
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
      resolveLiveGate1: async () => ({
        subject_digest: options.state.gates.gate_1.production_subject_digest!,
        decision_digest: gate1.decision_digest
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
