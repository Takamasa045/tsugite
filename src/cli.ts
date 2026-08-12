import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectEnvironment } from "./doctor.js";
import { loadBackendCapabilities } from "./backends/capabilities.js";
import type { AdapterDefinition } from "./adapters/registry.js";
import { runGenerationModelPreflight } from "./adapters/modelPreflight.js";
import { analyzeProject } from "./orchestrator/analyze.js";
import { composeProject } from "./orchestrator/compose.js";
import {
  loadPromptGuideCatalog,
  loadPromptGuideById,
  resolvePromptGuidance,
  type PromptGuide,
  type PromptMode
} from "./adapters/promptKnowledge.js";
import {
  loadStoryGuide,
  recommendStoryFrameworks
} from "./adapters/storyKnowledge.js";
import type { Manifest } from "./manifest/schema.js";
import { createDryRun, createPlan } from "./orchestrator/plan.js";
import {
  finalizeCompletedProject,
  preflightFinalizeApplyBoundary,
  type FinalizeRunDirIdentity,
  type FinalizeStateDirIdentity
} from "./orchestrator/finalize.js";
import {
  auditAndCleanupWorktrees,
  summarizeWorktreeCleanupWarning
} from "./worktree/lifecycle.js";
import {
  deferWorktreeIntegration,
  reconcileDeferredWorktrees
} from "./worktree/deferred.js";
import {
  inspectGate1Review,
  openCreativeReview,
  writeCreativeReview
} from "./orchestrator/review.js";
import { renderReviewPreview } from "./orchestrator/reviewPreview.js";
import { inspectGate3RunForApproval, renderAssembledMedia } from "./orchestrator/render.js";
import { assembleLocalMediaRun, inspectGate2RunForApproval } from "./orchestrator/run.js";
import {
  issuesForOuterGateWithPersonQaDecision,
  loadPersonQaApprovalBinding,
  parsePersonQaHumanDecision,
  personConsistencyRequiredForStage,
  writePersonQaApprovalBinding,
  type PersonQaHumanDecisionRecord
} from "./qa/personConsistency/index.js";
import {
  notifySikumiRunCompleted,
  notifySikumiStateChange,
  projectRootFromStateDir
} from "./integrations/sikumiOutbox.js";
import {
  acquireRunLock,
  LAUNCHER_EXPECTED_APPROVAL_DIGEST_ENV,
  RUN_LOCK_INHERIT_ENV,
  createPlannedState,
  markGateAwaiting,
  readState,
  recordGateDecision,
  writeState,
  type GateDecision,
  type GateId,
  type RunLock,
  type RunState
} from "./orchestrator/state.js";
import { ensureProjectVisibleOnLauncherShelf } from "./project/projectsHome.js";
import { validateProject } from "./project/validateProject.js";
import { createProjectGenerationUnitSourceResolver } from "./videoPromptDirector/generationUnitSourceResolver.js";
import {
  buildActiveGate1ProductionBinding,
  buildActiveGate2ProductionBinding,
  buildActiveGate3ProductionBinding,
  buildActiveGateBundleForProject,
  loadDurableGateBundle,
  productionDecisionId,
  resolveOrchestrationMode,
  writeDurableGateBundle
} from "./productionControl/activePipeline.js";
import {
  assertLiveActiveSubjectsBeforePhase,
  loadDurableSelectedCompletions,
  sha256FileContents,
  writeDurableCoordinatorPrincipal,
  writeDurableGate2Evidence,
  writeDurableGate3Evidence,
  writeDurableGateDecision
} from "./productionControl/durableGateEvidence.js";
import { digest as canonicalDigest } from "./orchestrator/editorialProposal.js";
import { compileProductionContract } from "./productionControl/contractCompiler.js";
import { runCoordinatorRecoverCli } from "./productionControl/coordinatorRecoveryCli.js";
import { resolveCanonicalProductionControlRoot } from "./productionControl/activeRunGeneration.js";
import {
  applyMigration,
  applyRollback,
  diagnoseMode,
  previewMigration,
  previewRollback
} from "./productionControl/rc/index.js";
import { connectionSelectionPrompt, listConnectionOptions } from "./connections/registry.js";
import {
  callRemoteTool,
  listAgentServices,
  listRemoteTools,
  resolveAgentService
} from "./agentServices/index.js";
import { readJsonFile } from "./io.js";
import type { Project } from "./project/schema.js";
import { PipelineError, type Issue, type Result } from "./types.js";
import { appendProjectFeedback } from "./feedback/index.js";
import { openWorkflowViewer, writeWorkflowViewer } from "./viewer/artifact.js";
import {
  openWorkflowViewerLauncher,
  startWorkflowViewerLauncher
} from "./viewer/launcher.js";
import {
  GLOBAL_OPTIONS,
  commandRequiresConfig,
  getCommandHelp,
  isCommandOptionAllowed,
  isKnownCommand,
  listCommandHelp,
  suggestCommands,
  type CommandSpec
} from "./cli/commandCatalog.js";

type ParsedArgs = {
  command: string;
  helpTopic?: string;
  config?: string;
  json: boolean;
  dryRun: boolean;
  actor?: string;
  gate?: string;
  decision?: string;
  stateDir?: string;
  catalog?: string;
  model?: string;
  capability?: string;
  inputMode?: string;
  output?: string;
  shot?: string;
  request?: string;
  duration?: string;
  shitateRoot?: string;
  character?: string;
  runId?: string;
  anchor?: string;
  requestId?: string;
  speakerId?: string;
  displayName?: string;
  side?: string;
  accent?: string;
  fromManifest?: string;
  speaker?: string;
  subject?: string;
  field?: string;
  text?: string;
  textFile?: string;
  projectsDir?: string;
  port?: string;
  backend?: string;
  key?: string;
  category?: string;
  signal?: string;
  stage?: string;
  summary?: string;
  evidence?: string;
  promotionKind?: string;
  target?: string;
  proposalSummary?: string;
  verification?: string;
  proposalWorkflow?: string;
  proposalRunId?: string;
  proposalSource?: string;
  open: boolean;
  apply: boolean;
  defer: boolean;
  reconcile: boolean;
  allowExternalAnalysis: boolean;
  confirmPaid: boolean;
  recovery?: string;
  errorCode?: string;
  node?: string;
  paths: string[];
  expectedPlanDigest?: string;
  expectedProductionCompletionDigest?: string;
  expectedApprovalDigest?: string;
  personQaDecision?: string;
  personQaReason?: string;
  service?: string;
  tool?: string;
  argumentsJson?: string;
  issues: Issue[];
};

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  args.expectedApprovalDigest = process.env[LAUNCHER_EXPECTED_APPROVAL_DIGEST_ENV];
  delete process.env[LAUNCHER_EXPECTED_APPROVAL_DIGEST_ENV];
  if (!args.command) {
    return output(args, 1, {
      ok: false,
      issues: [{ code: "cli.command_missing", message: "command is required" }],
      next_actions: ["node bin/pipeline --help"]
    });
  }

  if (args.command === "help") {
    if (args.issues.length > 0) {
      return output(args, 1, { ok: false, command: "help", issues: args.issues });
    }
    return outputHelp(args);
  }

  if (!isKnownCommand(args.command)) {
    const suggestedCommands = suggestCommands(args.command);
    return output(args, 1, {
      ok: false,
      command: args.command,
      issues: [{ code: "cli.command_unknown", message: `unknown command '${args.command}'` }],
      suggested_commands: suggestedCommands,
      next_actions: [
        ...(suggestedCommands[0] ? [`node bin/pipeline help ${suggestedCommands[0]}`] : []),
        "node bin/pipeline --help"
      ]
    });
  }

  if (args.issues.length > 0) {
    return output(args, 1, { ok: false, command: args.command, issues: args.issues });
  }

  if (args.command === "doctor") {
    const report = await inspectEnvironment(args.config);
    return output(args, report.ok ? 0 : 1, {
      ok: report.ok,
      command: "doctor",
      checks: report.checks
    });
  }

  if (args.command === "guides") {
    try {
      return await outputPromptGuides(args);
    } catch (error) {
      return output(args, 1, {
        ok: false,
        command: "guides",
        scope: "prompt-guidance-only",
        issues: cliIssuesFromError(error)
      });
    }
  }

  if (args.command === "story-guides") {
    try {
      return await outputStoryGuides(args);
    } catch (error) {
      return output(args, 1, {
        ok: false,
        command: "story-guides",
        scope: "creative-guidance-only",
        issues: cliIssuesFromError(error)
      });
    }
  }

  if (args.command === "connections") {
    try {
      const query = {
        ...(args.model ? { model: args.model } : {}),
        ...(args.capability ? { capability: args.capability } : {})
      };
      const connections = await listConnectionOptions(query);
      return output(args, 0, {
        ok: true,
        command: "connections",
        billing_action: false,
        secret_values_exposed: false,
        filters: query,
        connections,
        selection_prompt: await connectionSelectionPrompt(query)
      });
    } catch (error) {
      return output(args, 1, {
        ok: false,
        command: "connections",
        issues: cliIssuesFromError(error)
      });
    }
  }

  if (args.command === "services") {
    try {
      // Production CLI always uses the bundled registry; env overrides are ignored.
      const services = await listAgentServices();
      return output(args, 0, {
        ok: true,
        command: "services",
        network: false,
        network_attempted: false,
        billing_action: false,
        provider_usage_possible: true,
        remote_usage: false,
        secret_values_exposed: false,
        side_effect: false,
        human_gate: "not_required",
        scope: "agent-service-registry",
        services
      });
    } catch (error) {
      return output(args, 1, {
        ok: false,
        command: "services",
        network: false,
        network_attempted: false,
        billing_action: false,
        provider_usage_possible: true,
        remote_usage: false,
        issues: cliIssuesFromError(error)
      });
    }
  }

  if (args.command === "service-tools") {
    if (!args.service) {
      return output(args, 1, {
        ok: false,
        command: "service-tools",
        network: false,
        network_attempted: false,
        billing_action: false,
        provider_usage_possible: true,
        remote_usage: false,
        issues: [{
          code: "cli.service_missing",
          message: "--service is required",
          path: "--service"
        }]
      });
    }
    try {
      const service = await resolveAgentService(args.service);
      const listed = await listRemoteTools({ service });
      return output(args, 0, {
        ok: true,
        command: "service-tools",
        network: true,
        network_attempted: true,
        billing_action: false,
        provider_usage_possible: true,
        remote_usage: true,
        secret_values_exposed: false,
        side_effect: false,
        human_gate: "not_required",
        service: service.id,
        endpoint_host: service.endpoint_validated.hostname,
        endpoint_canonical: service.endpoint_validated.canonical,
        observed_tools: listed.observed_tools,
        declared_tools: listed.declared_tools,
        blocked_undeclared: listed.blocked_undeclared,
        blocked_by_policy: listed.blocked_by_policy
      });
    } catch (error) {
      const issues = cliIssuesFromError(error);
      const networkAttempted = agentServiceErrorImpliesNetwork(issues);
      return output(args, 1, {
        ok: false,
        command: "service-tools",
        network: networkAttempted,
        network_attempted: networkAttempted,
        billing_action: false,
        provider_usage_possible: true,
        remote_usage: networkAttempted,
        service: args.service,
        issues
      });
    }
  }

  if (args.command === "service-call") {
    const missing: Issue[] = [];
    if (!args.service) {
      missing.push({
        code: "cli.service_missing",
        message: "--service is required",
        path: "--service"
      });
    }
    if (!args.tool) {
      missing.push({
        code: "cli.tool_missing",
        message: "--tool is required",
        path: "--tool"
      });
    }
    if (missing.length > 0) {
      return output(args, 1, {
        ok: false,
        command: "service-call",
        network: false,
        network_attempted: false,
        billing_action: false,
        provider_usage_possible: true,
        remote_usage: false,
        issues: missing
      });
    }
    try {
      const service = await resolveAgentService(args.service!);
      const called = await callRemoteTool({
        service,
        toolName: args.tool!,
        arguments: args.argumentsJson
      });
      return output(args, 0, {
        ok: true,
        command: "service-call",
        network: true,
        network_attempted: true,
        billing_action: false,
        provider_usage_possible: true,
        remote_usage: true,
        secret_values_exposed: false,
        side_effect: false,
        human_gate: called.human_gate,
        service: called.service_id,
        tool: called.tool,
        endpoint_host: service.endpoint_validated.hostname,
        endpoint_canonical: service.endpoint_validated.canonical,
        result: called.result
      });
    } catch (error) {
      const issues = cliIssuesFromError(error);
      const networkAttempted = agentServiceErrorImpliesNetwork(issues);
      return output(args, 1, {
        ok: false,
        command: "service-call",
        network: networkAttempted,
        network_attempted: networkAttempted,
        billing_action: false,
        provider_usage_possible: true,
        remote_usage: networkAttempted,
        service: args.service,
        tool: args.tool,
        issues
      });
    }
  }

  if (args.command === "presets") {
    if (!args.backend) {
      return output(args, 1, {
        ok: false,
        command: "presets",
        issues: [{ code: "cli.backend_missing", message: "--backend is required", path: "--backend" }]
      });
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.backend)) {
      return output(args, 1, {
        ok: false,
        command: "presets",
        issues: [{ code: "cli.backend_invalid", message: "--backend must be a safe backend id", path: "--backend" }]
      });
    }
    try {
      const backend = await loadBackendCapabilities(args.backend);
      if (!backend) {
        return output(args, 1, {
          ok: false,
          command: "presets",
          backend: args.backend,
          issues: [{ code: "backend.not_found", message: `backend '${args.backend}' was not found` }]
        });
      }
      return output(args, 0, {
        ok: true,
        command: "presets",
        backend: args.backend,
        presets: backend.capabilities.presets
      });
    } catch (error) {
      return output(args, 1, {
        ok: false,
        command: "presets",
        backend: args.backend,
        issues: cliIssuesFromError(error)
      });
    }
  }

  if (args.command === "viewer-launcher") {
    const port = args.port === undefined ? 0 : Number(args.port);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      return output(args, 1, {
        ok: false,
        command: "viewer-launcher",
        issues: [{
          code: "viewer_launcher.port",
          message: "--port must be an integer between 0 and 65535",
          path: "--port"
        }]
      });
    }
    try {
      const launcher = await startWorkflowViewerLauncher({
        ...(args.projectsDir ? { projectsDir: args.projectsDir } : {}),
        port
      });
      const closeOnSignal = () => {
        void launcher.close();
      };
      process.once("SIGINT", closeOnSignal);
      process.once("SIGTERM", closeOnSignal);
      try {
        if (args.open) {
          try {
            await openWorkflowViewerLauncher(launcher.url);
          } catch (error) {
            await launcher.close();
            return output(args, 1, {
              ok: false,
              command: "viewer-launcher",
              url: launcher.url,
              issues: [{
                code: "viewer_launcher.open_failed",
                message: error instanceof Error ? error.message : String(error)
              }]
            });
          }
        }
        const status = output(args, 0, {
          ok: true,
          command: "viewer-launcher",
          url: launcher.url,
          port: launcher.port,
          project_count: launcher.projectCount,
          opened: args.open
        });
        await launcher.closed;
        return status;
      } finally {
        process.off("SIGINT", closeOnSignal);
        process.off("SIGTERM", closeOnSignal);
      }
    } catch (error) {
      return output(args, 1, {
        ok: false,
        command: "viewer-launcher",
        issues: [{
          code: "viewer_launcher.start_failed",
          message: error instanceof Error ? error.message : String(error)
        }]
      });
    }
  }

  if (args.command === "worktrees") {
    if (args.defer && args.reconcile) {
      return output(args, 1, {
        ok: false,
        command: "worktrees",
        issues: [{
          code: "worktrees.mode_conflict",
          message: "--defer and --reconcile cannot be used together"
        }]
      });
    }
    if (args.apply) {
      const coordinatorIssue = requireCoordinator(args);
      if (coordinatorIssue) {
        return output(args, 1, { ok: false, command: "worktrees", issues: [coordinatorIssue] });
      }
      if (!args.reconcile && args.paths.length === 0) {
        return output(args, 1, {
          ok: false,
          command: "worktrees",
          issues: [{
            code: "worktrees.path_required",
            message: "--path is required when applying worktree cleanup",
            path: "--path"
          }]
        });
      }
    }
    if (args.defer && args.paths.length !== 1) {
      return output(args, 1, {
        ok: false,
        command: "worktrees",
        issues: [{
          code: "worktrees.defer_path_required",
          message: "--defer requires exactly one --path",
          path: "--path"
        }]
      });
    }
    if (args.reconcile && args.paths.length > 0) {
      return output(args, 1, {
        ok: false,
        command: "worktrees",
        issues: [{
          code: "worktrees.reconcile_path_unsupported",
          message: "--reconcile processes the oldest queued entry and does not accept --path",
          path: "--path"
        }]
      });
    }

    try {
      if (args.defer) {
        const result = await deferWorktreeIntegration({
          cwd: process.cwd(),
          path: args.paths[0]!,
          apply: args.apply
        });
        return output(args, result.ok ? 0 : 1, {
          ok: result.ok,
          command: "worktrees",
          mode: "defer",
          issues: result.issues,
          applied: result.applied,
          queued: result.queued,
          queue_path: result.queue_path,
          entries: result.entries,
          entry: result.entry
        });
      }
      if (args.reconcile) {
        const result = await reconcileDeferredWorktrees({
          cwd: process.cwd(),
          apply: args.apply
        });
        return output(args, result.ok ? 0 : 1, {
          ok: result.ok,
          command: "worktrees",
          mode: "reconcile",
          issues: result.issues,
          applied: result.applied,
          status: result.status,
          waiting_reason: result.waiting_reason,
          queue_path: result.queue_path,
          entries: result.entries,
          processed: result.processed,
          integration_commit: result.integration_commit,
          removed: result.removed,
          checks: result.checks
        });
      }
      const result = await auditAndCleanupWorktrees({
        cwd: process.cwd(),
        apply: args.apply,
        paths: args.paths
      });
      const worktreeWarning = summarizeWorktreeCleanupWarning(result.worktrees ?? []);
      const warnings: Issue[] = worktreeWarning.active
        ? [{
            code: "worktrees.cleanup_candidates_accumulated",
            message: `${worktreeWarning.removable_count} safely removable worktrees are registered (warning threshold: ${worktreeWarning.threshold}); review them before explicit cleanup. This warning never removes worktrees.`
          }]
        : [];
      return output(args, result.ok ? 0 : 1, {
        ok: result.ok,
        command: "worktrees",
        issues: result.issues,
        warnings,
        worktree_warning: worktreeWarning,
        applied: result.applied ?? false,
        git_common_dir: result.git_common_dir,
        primary_path: result.primary_path,
        current_path: result.current_path,
        main_branch: result.main_branch,
        worktrees: result.worktrees ?? [],
        targets: result.targets ?? [],
        removed: result.removed ?? []
      });
    } catch (error) {
      return output(args, 1, {
        ok: false,
        command: "worktrees",
        issues: cliIssuesFromError(error)
      });
    }
  }

  if (!args.config) {
    if (commandRequiresConfig(args.command)) {
      return output(args, 1, {
        ok: false,
        command: args.command,
        issues: [{ code: "cli.config_missing", message: "--config is required" }],
        next_actions: [`node bin/pipeline help ${args.command}`]
      });
    }
    return output(args, 1, {
      ok: false,
      command: args.command,
      issues: [{ code: "cli.command_unhandled", message: `command '${args.command}' has no CLI handler` }]
    });
  }

  if (args.command === "feedback") {
    const signal = parseFeedbackSignal(args.signal);
    const stage = parseFeedbackStage(args.stage);
    const gate = parseFeedbackGate(args.gate);
    const promotionKind = parseFeedbackPromotionKind(args.promotionKind);
    const proposalSource = parseFeedbackAutomationSource(args.proposalSource);
    const hasPromotionTarget = Boolean(promotionKind && args.target);
    const hasProposalDetails = Boolean(args.proposalSummary && args.verification);
    const hasProposalSource = Boolean(args.proposalWorkflow || args.proposalRunId || args.proposalSource);
    const issues: Issue[] = [
      ...(args.key ? [] : [{ code: "feedback.key_required", message: "--key is required", path: "--key" }]),
      ...(args.category ? [] : [{ code: "feedback.category_required", message: "--category is required", path: "--category" }]),
      ...(args.signal
        ? signal
          ? []
          : [{ code: "feedback.signal_invalid", message: "--signal must be prefer, avoid, or keep", path: "--signal" }]
        : [{ code: "feedback.signal_required", message: "--signal is required", path: "--signal" }]),
      ...(args.stage
        ? stage
          ? []
          : [{ code: "feedback.stage_invalid", message: "--stage must be observed, recurring, promoted, or verified", path: "--stage" }]
        : [{ code: "feedback.stage_required", message: "--stage is required", path: "--stage" }]),
      ...(args.summary ? [] : [{ code: "feedback.summary_required", message: "--summary is required", path: "--summary" }]),
      ...(args.gate && !gate
        ? [{ code: "feedback.gate_invalid", message: "--gate must be gate_1, gate_2, or gate_3", path: "--gate" }]
        : []),
      ...(args.promotionKind && !promotionKind
        ? [{
            code: "feedback.promotion_kind_invalid",
            message: "--promotion-kind must be template, constraint, validator, qa, rule, or documentation",
            path: "--promotion-kind"
          }]
        : []),
      ...(Boolean(args.promotionKind) === Boolean(args.target)
        ? []
        : [{
            code: "feedback.promotion_incomplete",
            message: "--promotion-kind and --target must be provided together",
            path: args.promotionKind ? "--target" : "--promotion-kind"
          }]),
      ...(Boolean(args.proposalSummary) === Boolean(args.verification)
        ? []
        : [{
            code: "feedback.proposal_incomplete",
            message: "--proposal-summary and --verification must be provided together",
            path: args.proposalSummary ? "--verification" : "--proposal-summary"
          }]),
      ...(args.proposalWorkflow && !isSafeFeedbackId(args.proposalWorkflow)
        ? [{
            code: "feedback.proposal_workflow_invalid",
            message: "--proposal-workflow must be a safe id",
            path: "--proposal-workflow"
          }]
        : []),
      ...(args.proposalRunId && !isSafeFeedbackId(args.proposalRunId)
        ? [{
            code: "feedback.proposal_run_id_invalid",
            message: "--proposal-run-id must be a safe id",
            path: "--proposal-run-id"
        }]
        : []),
      ...(args.proposalSource && !proposalSource
        ? [{
            code: "feedback.proposal_source_invalid",
            message: "--proposal-source must be codex, claude-desktop, or claude-code",
            path: "--proposal-source"
          }]
        : []),
      ...(hasProposalSource && !hasProposalDetails
        ? [{
            code: "feedback.proposal_source_without_proposal",
            message: "proposal source requires --proposal-summary and --verification",
            path: args.proposalSource
              ? "--proposal-source"
              : args.proposalWorkflow
                ? "--proposal-workflow"
                : "--proposal-run-id"
          }]
        : []),
      ...(args.proposalRunId && !args.proposalWorkflow
        ? [{
            code: "feedback.proposal_workflow_required",
            message: "--proposal-run-id requires --proposal-workflow",
            path: "--proposal-workflow"
        }]
        : []),
      ...(args.proposalSource && !args.proposalWorkflow
        ? [{
            code: "feedback.proposal_workflow_required",
            message: "--proposal-source requires --proposal-workflow",
            path: "--proposal-workflow"
          }]
        : []),
      ...(hasProposalDetails && !hasPromotionTarget
        ? [{
            code: "feedback.proposal_target_required",
            message: "promotion proposal requires --promotion-kind and --target",
            path: "--promotion-kind"
          }]
        : []),
      ...(hasProposalDetails && !args.evidence
        ? [{
            code: "feedback.proposal_evidence_required",
            message: "promotion proposal requires --evidence",
            path: "--evidence"
          }]
        : []),
      ...(hasProposalDetails && stage !== "recurring"
        ? [{
            code: "feedback.proposal_stage_invalid",
            message: "promotion proposal requires --stage recurring",
            path: "--stage"
          }]
        : []),
      ...(hasPromotionTarget && !hasProposalDetails && stage !== "promoted"
        ? [{
            code: "feedback.promotion_stage_invalid",
            message: "promotion metadata requires --stage promoted, or proposal details with --stage recurring",
            path: "--stage"
          }]
        : [])
    ];
    if (issues.length > 0) return output(args, 1, { ok: false, command: "feedback", issues });

    try {
      const recorded = await appendProjectFeedback(args.config, {
        key: args.key!,
        category: args.category!,
        signal: signal!,
        stage: stage!,
        summary: args.summary!,
        ...(args.runId ? { run_id: args.runId } : {}),
        ...(gate ? { gate } : {}),
        ...(args.evidence ? { evidence: [args.evidence] } : {}),
        ...(hasPromotionTarget && stage === "promoted"
          ? { promotion: { kind: promotionKind!, target: args.target! } }
          : {}),
        ...(hasPromotionTarget && hasProposalDetails && stage === "recurring"
          ? {
              promotion_proposal: {
                id: randomUUID(),
                kind: promotionKind!,
                target: args.target!,
                change_summary: args.proposalSummary!,
                verification: args.verification!,
                ...(args.proposalWorkflow ? {
                  source: {
                    kind: automationSourceKind(proposalSource ?? "codex"),
                    workflow_id: args.proposalWorkflow,
                    ...(args.proposalRunId ? { run_id: args.proposalRunId } : {})
                  }
                } : {}),
                decision: "pending" as const
              }
            }
          : {})
      });
      return output(args, 0, {
        ok: true,
        command: "feedback",
        path: recorded.path,
        entry: recorded.entry
      });
    } catch (error) {
      return output(args, 1, {
        ok: false,
        command: "feedback",
        issues: cliIssuesFromError(error)
      });
    }
  }

  if (args.command === "shitate-import") {
    const shitateRoot = args.shitateRoot ?? process.env.SHITATE_ROOT;
    const requiredIssues = [
      ...(shitateRoot ? [] : [{ code: "shitate_import.root_required", message: "--shitate-root or SHITATE_ROOT is required" }]),
      ...(args.character ? [] : [{ code: "shitate_import.character_required", message: "--character is required" }]),
      ...(args.runId ? [] : [{ code: "shitate_import.run_id_required", message: "--run-id is required" }])
    ];
    if (requiredIssues.length > 0) {
      return output(args, 1, { ok: false, command: "shitate-import", issues: requiredIssues });
    }
    const { importShitateSnapshot } = await import("./integrations/shitate.js");
    const imported = await importShitateSnapshot({
      configPath: args.config,
      shitateRoot: shitateRoot!,
      character: args.character!,
      runId: args.runId!,
      ...(args.anchor ? { anchor: args.anchor } : {}),
      ...(args.requestId ? { requestId: args.requestId } : {}),
      ...(args.speakerId ? { speakerId: args.speakerId } : {}),
      ...(args.displayName ? { displayName: args.displayName } : {}),
      ...(args.side ? { side: args.side as "left" | "right" } : {}),
      ...(args.accent ? { accent: args.accent } : {})
    });
    return output(args, imported.ok ? 0 : 1, {
      ok: imported.ok,
      command: "shitate-import",
      issues: imported.issues,
      character: args.character,
      run_id: args.runId,
      destination: imported.destination,
      lock_path: imported.lockPath,
      image_id: imported.imageId,
      speaker_id: imported.speakerId,
      request_image_path: imported.requestImagePath,
      already_imported: imported.alreadyImported,
      warnings: imported.warnings
    });
  }

  if (args.command === "character-add") {
    const requiredIssues = [
      ...(args.fromManifest
        ? []
        : [{ code: "character_add.from_manifest_required", message: "--from-manifest is required", path: "--from-manifest" }]),
      ...(args.speaker
        ? []
        : [{ code: "character_add.speaker_required", message: "--speaker is required", path: "--speaker" }])
    ];
    if (requiredIssues.length > 0) {
      return output(args, 1, { ok: false, command: "character-add", issues: requiredIssues });
    }
    const { addCharacterToProject } = await import("./characters/addToProject.js");
    const sourceManifestPath = args.fromManifest!;
    const result = await addCharacterToProject({
      sourceManifestPath,
      sourceRootDir: dirname(sourceManifestPath),
      speakerId: args.speaker!,
      targetConfigPath: args.config
    });
    if (!result.ok) {
      return output(args, 1, {
        ok: false,
        command: "character-add",
        speaker_id: args.speaker,
        issues: [result.issue]
      });
    }
    return output(args, 0, {
      ok: true,
      command: "character-add",
      speaker_id: result.speakerId,
      added: result.added,
      already_present: result.alreadyPresent,
      manifest_path: result.manifestPath,
      ...(result.added
        ? {
            destination_dir: result.destinationDir,
            image_id_map: result.imageIdMap
          }
        : {})
    });
  }

  if (args.command === "lock-block") {
    const requiredIssues: Issue[] = [
      ...(args.subject
        ? []
        : [{ code: "lock_block.subject_required", message: "--subject is required", path: "--subject" }]),
      ...(args.field
        ? []
        : [{ code: "lock_block.field_required", message: "--field is required", path: "--field" }]),
      ...(args.text || args.textFile
        ? []
        : [{
            code: "lock_block.text_required",
            message: "--text or --text-file is required",
            path: "--text"
          }]),
      ...(args.text && args.textFile
        ? [{
            code: "lock_block.text_conflict",
            message: "pass only one of --text or --text-file",
            path: "--text"
          }]
        : [])
    ];
    if (requiredIssues.length > 0) {
      return output(args, 1, { ok: false, command: "lock-block", issues: requiredIssues });
    }
    const { readFile } = await import("node:fs/promises");
    const { lockSubjectBlock } = await import("./videoPromptDirector/lockBlock.js");
    let text = args.text;
    if (args.textFile) {
      text = await readFile(args.textFile, "utf8");
    }
    const result = await lockSubjectBlock({
      configPath: args.config!,
      subjectId: args.subject!,
      field: args.field!,
      text: text!,
      ...(args.requestId ? { requestId: args.requestId } : {})
    });
    if (!result.ok) {
      return output(args, 1, {
        ok: false,
        command: "lock-block",
        issues: result.issues
      });
    }
    return output(args, 0, {
      ok: true,
      command: "lock-block",
      request_id: result.requestId,
      ir_kind: result.irKind,
      subject_id: result.subjectId,
      field: result.field,
      sha256: result.sha256,
      config_path: result.configPath
    });
  }

  const generationUnitSourceResolver = createProjectGenerationUnitSourceResolver(args.config);
  const validation = await validateProject(args.config, { generationUnitSourceResolver });
  const launcherShelf = validation.ok && validation.project
    ? await ensureProjectVisibleOnLauncherShelf({
        configPath: args.config,
        projectSlug: validation.project.slug
      })
    : undefined;
  if (args.command === "validate") {
    const ok = validation.ok && (launcherShelf?.ok ?? true);
    return output(args, ok ? 0 : 1, {
      ok,
      command: "validate",
      issues: [
        ...validation.issues,
        ...(launcherShelf && !launcherShelf.ok ? launcherShelf.issues : [])
      ],
      ...(validation.h3_compilations && validation.h3_compilations.length > 0
        ? { h3_compilations: validation.h3_compilations }
        : {}),
      ...(validation.video_prompt_plans && validation.video_prompt_plans.length > 0
        ? { video_prompt_plans: validation.video_prompt_plans }
        : {}),
      launcher_visible: launcherShelf?.ok ?? false,
      launcher_already_home: launcherShelf?.alreadyHome,
      launcher_linked: launcherShelf?.linked,
      launcher_projects_home: launcherShelf?.projectsHome,
      launcher_project_root: launcherShelf?.launcherProjectRoot,
      launcher_config_path: launcherShelf?.launcherConfigPath
    });
  }

  if (!validation.ok) {
    return output(args, 1, {
      ok: false,
      command: args.command,
      issues: validation.issues
    });
  }

  if (args.command === "models") {
    const generation = validation.project?.generation;
    if (!generation || !validation.adapter) {
      return output(args, 1, {
        ok: false,
        command: "models",
        billing_action: false,
        generation_submitted: false,
        fully_validated: false,
        requests: [],
        issues: [{
          code: "models.generation_required",
          message: "project must declare generation requests and an adapter"
        }]
      });
    }
    const inspected = runGenerationModelPreflight(validation.adapter, generation.requests);
    return output(args, inspected.ok ? 0 : 1, {
      ok: inspected.ok,
      command: "models",
      billing_action: inspected.billingAction,
      generation_submitted: inspected.generationSubmitted,
      fully_validated: inspected.fullyValidated,
      requests: inspected.requests,
      issues: inspected.issues
    });
  }

  if (args.command === "production-status") {
    const { dirname, resolve } = await import("node:path");
    const projectRoot = resolve(dirname(args.config!));
    const { buildProductionStatusReport } = await import("./productionControl/rc/controlPlaneStatus.js");
    try {
      const status = await buildProductionStatusReport({
        project: validation.project!,
        projectRoot
      });
      return output(args, status.ok ? 0 : 1, {
        ok: status.ok,
        command: "production-status",
        fixture_only: true,
        billing_action: false,
        generation_submitted: false,
        gate_mutated: false,
        status,
        diagnostics: status.diagnostics
      });
    } catch (error) {
      return output(args, 1, {
        ok: false,
        command: "production-status",
        issues: cliIssuesFromError(error)
      });
    }
  }

  if (args.command === "production-migrate") {
    const target = args.target === "shadow" || args.target === "active" ? args.target : undefined;
    if (!target) {
      return output(args, 1, {
        ok: false,
        command: "production-migrate",
        issues: [{
          code: "production_migrate.target_required",
          message: "--target must be shadow or active",
          path: "--target"
        }]
      });
    }
    const { dirname, resolve } = await import("node:path");
    const projectRoot = resolve(dirname(args.config!));
    const preview = previewMigration({
      project: validation.project!,
      target_mode: target,
      projectRoot,
      coordinator: args.actor === "coordinator"
    });
    if (!args.apply) {
      return output(args, preview.ok ? 0 : 1, {
        ok: preview.ok,
        command: "production-migrate",
        dry_run: true,
        fixture_only: true,
        billing_action: false,
        generation_submitted: false,
        gate_mutated: false,
        preview
      });
    }
    const coordinatorIssue = requireCoordinator(args);
    if (coordinatorIssue) {
      return output(args, 1, { ok: false, command: "production-migrate", issues: [coordinatorIssue] });
    }
    if (!args.expectedPlanDigest) {
      return output(args, 1, {
        ok: false,
        command: "production-migrate",
        issues: [{
          code: "production_migrate.preview_digest_required",
          message: "--expected-plan-digest must equal preview.digest from production-migrate preview",
          path: "--expected-plan-digest"
        }]
      });
    }
    try {
      const applied = await applyMigration({
        project: validation.project!,
        target_mode: target,
        projectRoot,
        actor: "coordinator",
        expected_preview_digest: args.expectedPlanDigest,
        coordinator: true
      });
      return output(args, 0, {
        ok: true,
        command: "production-migrate",
        dry_run: false,
        fixture_only: true,
        billing_action: false,
        generation_submitted: false,
        gate_mutated: false,
        preview: applied.preview,
        record: applied.record
      });
    } catch (error) {
      return output(args, 1, {
        ok: false,
        command: "production-migrate",
        issues: cliIssuesFromError(error)
      });
    }
  }

  if (args.command === "production-rollback") {
    const target = args.target === "shadow" || args.target === "legacy" ? args.target : undefined;
    if (!target) {
      return output(args, 1, {
        ok: false,
        command: "production-rollback",
        issues: [{
          code: "production_rollback.target_required",
          message: "--target must be shadow or legacy",
          path: "--target"
        }]
      });
    }
    const preview = previewRollback({
      project: validation.project!,
      to_mode: target,
      coordinator: args.actor === "coordinator"
    });
    if (!args.apply) {
      return output(args, preview.allowed ? 0 : 1, {
        ok: preview.allowed,
        command: "production-rollback",
        dry_run: true,
        fixture_only: true,
        billing_action: false,
        generation_submitted: false,
        gate_mutated: false,
        preview
      });
    }
    const coordinatorIssue = requireCoordinator(args);
    if (coordinatorIssue) {
      return output(args, 1, { ok: false, command: "production-rollback", issues: [coordinatorIssue] });
    }
    try {
      const { dirname, resolve } = await import("node:path");
      const projectRoot = resolve(dirname(args.config!));
      const applied = await applyRollback({
        project: validation.project!,
        projectRoot,
        to_mode: target,
        actor: "coordinator"
      });
      return output(args, 0, {
        ok: true,
        command: "production-rollback",
        dry_run: false,
        fixture_only: true,
        billing_action: false,
        generation_submitted: false,
        gate_mutated: false,
        preview: applied.preview,
        record: applied.record
      });
    } catch (error) {
      return output(args, 1, {
        ok: false,
        command: "production-rollback",
        issues: cliIssuesFromError(error)
      });
    }
  }

  if (args.command === "recover") {
    const coordinatorIssue = requireCoordinator(args);
    if (coordinatorIssue) {
      return output(args, 1, { ok: false, command: "recover", issues: [coordinatorIssue] });
    }
    const recoveryMode = args.recovery === "local" || args.recovery === "paid" ? args.recovery : undefined;
    const issues: Issue[] = [
      ...(args.node
        ? []
        : [{ code: "recover.node_required", message: "--node is required", path: "--node" }]),
      ...(args.errorCode
        ? []
        : [{ code: "recover.error_code_required", message: "--error-code is required", path: "--error-code" }]),
      ...(recoveryMode
        ? []
        : [{
          code: "recover.mode_required",
          message: "--recovery must be local or paid",
          path: "--recovery"
        }]),
      ...(args.apply && args.dryRun
        ? [{
          code: "recover.apply_dry_run_conflict",
          message: "use either --apply or --dry-run, not both"
        }]
        : [])
    ];
    if (issues.length > 0) {
      return output(args, 1, { ok: false, command: "recover", issues });
    }

    if (resolveOrchestrationMode(validation.project!) !== "active") {
      return output(args, 1, {
        ok: false,
        command: "recover",
        issues: [{
          code: "recover.active_mode_required",
          message: "recover requires orchestration.mode=active"
        }]
      });
    }

    // Canonical production-control root under the authoritative project config directory.
    const configPath = args.config!;
    const { dirname, resolve } = await import("node:path");
    const projectRoot = resolve(dirname(configPath));
    const productionControlRoot = resolveCanonicalProductionControlRoot(projectRoot);
    const packageDir = args.paths[0];
    const result = await runCoordinatorRecoverCli({
      recovery: recoveryMode!,
      apply: Boolean(args.apply),
      confirm_paid: Boolean(args.confirmPaid),
      node_id: args.node!,
      error_code: args.errorCode!,
      projectRoot,
      productionControlRoot,
      ...(packageDir ? { packageDir } : {}),
      production_id: validation.project?.slug
    });
    if (!result.ok) {
      return output(args, 1, { ok: false, command: "recover", issues: result.issues });
    }
    // silent_paid_spend is derived from result provenance, never a hardcoded success constant.
    const silentPaidSpend = result.mode === "apply-paid"
      ? result.paid_spend.silent
      : false;
    return output(args, 0, {
      command: "recover",
      dry_run: !args.apply,
      ...result,
      silent_paid_spend: silentPaidSpend,
      ...(result.mode === "apply-paid"
        ? {
          fixture_only: result.fixture_only,
          paid_spend: result.paid_spend
        }
        : {})
    });
  }

  let runLock: RunLock | undefined;
  // finalize --apply acquires its lock only after the project-local stateDir preflight below.
  if (shouldAcquireRunLock(args) && args.command !== "finalize") {
    const location = getStateLocation(args, validation.project!);
    const inheritedRunLockToken = process.env[RUN_LOCK_INHERIT_ENV];
    delete process.env[RUN_LOCK_INHERIT_ENV];
    try {
      runLock = await acquireRunLock(
        location.stateDir,
        validation.project!.run_id ?? validation.project!.slug,
        inheritedRunLockToken
      );
    } catch (error) {
      return output(args, 1, {
        ok: false,
        command: args.command,
        issues: [
          {
            code: "run.locked",
            message: error instanceof Error && "code" in error && error.code === "run.locked"
              ? error.message
              : "run lock is unavailable"
          }
        ]
      });
    }
  }

  try {

  let finalizeBoundaryIdentities:
    | {
      stateDirIdentity: FinalizeStateDirIdentity;
      runDirIdentity?: FinalizeRunDirIdentity;
    }
    | undefined;

  if (args.command === "finalize") {
    if (args.apply) {
      const coordinatorIssue = requireCoordinator(args);
      if (coordinatorIssue) {
        return output(args, 1, { ok: false, command: "finalize", issues: [coordinatorIssue] });
      }
      // Reject project-external / unapproved stateDir before creating any run lock.
      // Capture canonical path + device/inode so lock acquire can re-validate identity.
      const boundary = await preflightFinalizeApplyBoundary({
        configPath: args.config!,
        project: validation.project!,
        stateDir: args.stateDir
      });
      if (!boundary.ok) {
        return output(args, 1, {
          ok: false,
          command: "finalize",
          issues: boundary.issues,
          applied: true,
          deleted_files: 0,
          deleted_bytes: 0
        });
      }
      finalizeBoundaryIdentities = {
        stateDirIdentity: boundary.stateDirIdentity,
        runDirIdentity: boundary.runDirIdentity
      };
      const inheritedRunLockToken = process.env[RUN_LOCK_INHERIT_ENV];
      delete process.env[RUN_LOCK_INHERIT_ENV];
      try {
        runLock = await acquireRunLock(
          boundary.stateDir,
          boundary.runId,
          inheritedRunLockToken,
          {
            expectedStateDir: boundary.stateDirIdentity,
            containWithin: dirname(resolve(args.config!))
          }
        );
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : "run.locked";
        const message = error instanceof Error
          ? error.message
          : "run lock is unavailable";
        return output(args, 1, {
          ok: false,
          command: "finalize",
          issues: [
            {
              code: code === "run.locked" ? "run.locked" : code,
              message: code === "run.locked" && !("code" in (error as object))
                ? "run lock is unavailable"
                : message
            }
          ]
        });
      }
    }
    // Active mode: recompute Gate1+2+3 from durable evidence before finalize.
    // Never pass stored production digests as expected.
    if (resolveOrchestrationMode(validation.project!) === "active") {
      const stateResult = await loadState(args, validation.project!, { allowMissing: true });
      if (stateResult.ok && stateResult.state) {
        const g1 = stateResult.state.gates.gate_1;
        const g2 = stateResult.state.gates.gate_2;
        const g3 = stateResult.state.gates.gate_3;
        if (
          !g1.production_subject_digest
          || !g1.production_decision_digest
          || !g2.production_subject_digest
          || !g2.production_decision_digest
          || !g3.production_subject_digest
          || !g3.production_decision_digest
        ) {
          return output(args, 1, {
            ok: false,
            command: "finalize",
            issues: [{
              code: "gate.production_subject_missing",
              message: "active finalize requires current Gate 1, Gate 2, and Gate 3 production subjects"
            }]
          });
        }
        try {
          const productionId = compileProductionContract({ project: validation.project! }).production_id;
          const runDir = join(stateResult.stateDir, stateResult.state.run_id);
          const phaseCheck = await assertLiveActiveSubjectsBeforePhase({
            mode: "active",
            phase: "finalize",
            runDir,
            state: stateResult.state,
            production_id: productionId
          });
          if (!phaseCheck.ok) {
            await writeState(stateResult.stateDir, phaseCheck.cascadedState);
            return output(args, 1, {
              ok: false,
              command: "finalize",
              issues: [{
                code: "gate.production_subject_stale",
                message: phaseCheck.error.message
              }],
              cascade: {
                stale_gate_1: phaseCheck.cascade.stale_gate_1,
                stale_gate_2: phaseCheck.cascade.stale_gate_2,
                stale_gate_3: phaseCheck.cascade.stale_gate_3,
                kinds: phaseCheck.cascadeKinds
              }
            });
          }
        } catch (error) {
          return output(args, 1, {
            ok: false,
            command: "finalize",
            issues: [{
              code: "gate.production_subject_stale",
              message: error instanceof Error ? error.message : String(error)
            }]
          });
        }
      }
    }

    const finalized = await finalizeCompletedProject({
      configPath: args.config,
      project: validation.project!,
      manifest: validation.manifest!,
      stateDir: args.stateDir,
      apply: args.apply,
      expectedPlanDigest: args.expectedPlanDigest,
      expectedProductionCompletionDigest: args.expectedProductionCompletionDigest,
      // Pin preflight identities through apply so a post-lock stateDir/runDir swap fail-closes.
      ...(args.apply && finalizeBoundaryIdentities
        ? {
            expectedStateDirIdentity: finalizeBoundaryIdentities.stateDirIdentity,
            expectedRunDirIdentity: finalizeBoundaryIdentities.runDirIdentity
          }
        : {})
    });
    if (finalized.ok && finalized.applied) {
      const projectRoot = dirname(resolve(args.config!));
      const runId = validation.project!.run_id ?? validation.project!.slug;
      // Product completion = finalize apply only (not Gate 3 approve alone).
      await notifySikumiRunCompleted({
        project: validation.project!,
        projectRoot,
        runId
      });
    }
    return output(args, finalized.ok ? 0 : 1, {
      ok: finalized.ok,
      command: "finalize",
      issues: finalized.issues,
      applied: finalized.applied,
      canonical_output: finalized.canonicalOutput,
      completion_record: finalized.recordPath,
      already_finalized: finalized.alreadyFinalized === true,
      media_files: finalized.mediaFiles,
      retained_media: finalized.retainedMedia,
      planned_bytes: finalized.plannedBytes,
      deleted_files: finalized.deletedFiles,
      deleted_bytes: finalized.deletedBytes,
      plan_digest: finalized.planDigest,
      ...(finalized.productionCompletionDigest
        ? {
            production_completion_digest: finalized.productionCompletionDigest,
            control_plane_evidence: finalized.controlPlaneEvidence
          }
        : {}),
      unrestored_paths: finalized.unrestoredPaths,
      launcher_projects_home: finalized.launcherProjectsHome,
      launcher_project_root: finalized.launcherProjectRoot,
      launcher_already_home: finalized.launcherAlreadyHome,
      promoted_to_launcher_home: finalized.promotedToLauncherHome,
      launcher_config_path: finalized.launcherConfigPath,
      launcher_visible: Boolean(finalized.launcherProjectRoot)
    });
  }

  if (args.command === "plan") {
    return output(args, 0, {
      ok: true,
      command: "plan",
      plan: createPlan(
        validation.project!,
        validation.manifest!,
        validation.adapter,
        validation.analysisAdapters ?? validation.analysisAdapter,
        validation.promptGuides,
        validation.audioAdapter,
        validation.generationConnection,
        validation.audioConnection,
        validation.backend,
        validation.h3_compilations,
        validation.video_prompt_plans
      )
    });
  }

  if (args.command === "analyze") {
    const coordinatorIssue = requireCoordinator(args);
    if (coordinatorIssue) return output(args, 1, { ok: false, command: "analyze", issues: [coordinatorIssue] });
    const analyzed = await analyzeProject(
      args.config,
      validation.project!,
      validation.manifest!,
      validation.analysisAdapters ?? validation.analysisAdapter,
      args.stateDir,
      { allowExternalAnalysis: args.allowExternalAnalysis }
    );
    return output(args, analyzed.ok ? 0 : 1, {
      ok: analyzed.ok,
      command: "analyze",
      issues: analyzed.issues,
      analysis_path: analyzed.analysisPath,
      proposal_path: analyzed.proposalPath,
      handoff_path: analyzed.handoffPath,
      result_count: analyzed.resultCount,
      actual_credits: analyzed.actualCredits,
      api_used: analyzed.apiUsed,
      network_used: analyzed.networkUsed
    });
  }

  if (args.command === "compose") {
    const coordinatorIssue = requireCoordinator(args);
    if (coordinatorIssue) return output(args, 1, { ok: false, command: "compose", issues: [coordinatorIssue] });
    const composed = await composeProject(
      args.config,
      validation.project!,
      validation.manifest!,
      args.stateDir
    );
    return output(args, composed.ok ? 0 : 1, {
      ok: composed.ok,
      command: "compose",
      issues: composed.issues,
      proposal_path: composed.proposalPath,
      proposal_count: composed.proposalCount,
      source_manifest_digest: composed.sourceManifestDigest,
      analysis_digest: composed.analysisDigest,
      gate_state: "unchanged"
    });
  }

  if (args.command === "viewer") {
    const plan = createPlan(
      validation.project!,
      validation.manifest!,
      validation.adapter,
      validation.analysisAdapters ?? validation.analysisAdapter,
      validation.promptGuides,
      validation.audioAdapter,
      validation.generationConnection,
      validation.audioConnection,
      validation.backend,
      validation.h3_compilations,
      validation.video_prompt_plans
    );
    try {
      const viewer = await writeWorkflowViewer({
        configPath: args.config,
        project: validation.project!,
        plan,
        outputDir: args.output,
        stateDir: args.stateDir
      });
      if (args.open) {
        try {
          await openWorkflowViewer(viewer.viewerPath);
        } catch (error) {
          return output(args, 1, {
            ok: false,
            command: "viewer",
            viewer_path: viewer.viewerPath,
            workflow_path: viewer.workflowPath,
            issues: [
              {
                code: "viewer.open_failed",
                message: error instanceof Error ? error.message : String(error),
                path: viewer.viewerPath
              }
            ]
          });
        }
      }
      return output(args, 0, {
        ok: true,
        command: "viewer",
        viewer_path: viewer.viewerPath,
        workflow_path: viewer.workflowPath,
        output_dir: viewer.outputDir,
        state_found: viewer.stateFound,
        opened: args.open
      });
    } catch (error) {
      return output(args, 1, {
        ok: false,
        command: "viewer",
        issues: [
          {
            code: "viewer.write_failed",
            message: error instanceof Error ? error.message : String(error),
            path: args.output
          }
        ]
      });
    }
  }

  if (args.command === "review") {
    const plan = createPlan(
      validation.project!,
      validation.manifest!,
      validation.adapter,
      validation.analysisAdapters ?? validation.analysisAdapter,
      validation.promptGuides,
      validation.audioAdapter,
      validation.generationConnection,
      validation.audioConnection,
      validation.backend,
      validation.h3_compilations,
      validation.video_prompt_plans
    );
    try {
      const review = await writeCreativeReview({
        configPath: args.config,
        project: validation.project!,
        manifest: validation.manifest!,
        plan,
        outputDir: args.output,
        stateDir: args.stateDir
      });
      if (args.open) {
        try {
          await openCreativeReview(review.reviewPath);
        } catch (error) {
          return output(args, 1, {
            ok: false,
            command: "review",
            review_path: review.reviewPath,
            review_data_path: review.dataPath,
            issues: [
              {
                code: "review.open_failed",
                message: error instanceof Error ? error.message : String(error),
                path: review.reviewPath
              }
            ]
          });
        }
      }
      return output(args, 0, {
        ok: true,
        command: "review",
        review_path: review.reviewPath,
        review_data_path: review.dataPath,
        asset_count: review.assetCount,
        gate: "gate-1",
        gate_state: "unchanged",
        opened: args.open
      });
    } catch (error) {
      return output(args, 1, {
        ok: false,
        command: "review",
        issues: [
          {
            code: "review.write_failed",
            message: error instanceof Error ? error.message : String(error),
            path: args.output
          }
        ]
      });
    }
  }

  if (args.command === "review-preview") {
    const coordinatorIssue = requireCoordinator(args);
    if (coordinatorIssue) {
      return output(args, 1, { ok: false, command: "review-preview", issues: [coordinatorIssue] });
    }
    const plan = createPlan(
      validation.project!,
      validation.manifest!,
      validation.adapter,
      validation.analysisAdapters ?? validation.analysisAdapter,
      validation.promptGuides,
      validation.audioAdapter,
      validation.generationConnection,
      validation.audioConnection,
      validation.backend,
      validation.h3_compilations,
      validation.video_prompt_plans
    );
    const preview = await renderReviewPreview({
      configPath: args.config!,
      project: validation.project!,
      manifest: validation.manifest!,
      shotId: args.shot,
      outputDir: args.output,
      stateDir: args.stateDir
    });
    if (!preview.ok) {
      return output(args, 1, { ok: false, command: "review-preview", issues: preview.issues });
    }
    try {
      const review = await writeCreativeReview({
        configPath: args.config!,
        project: validation.project!,
        manifest: validation.manifest!,
        plan,
        outputDir: args.output,
        stateDir: args.stateDir
      });
      return output(args, 0, {
        ok: true,
        command: "review-preview",
        preview_path: preview.previewPath,
        reused: preview.reused,
        digest: preview.digest,
        shot_id: preview.shotId,
        review_path: review.reviewPath,
        review_data_path: review.dataPath,
        gate_state: "unchanged"
      });
    } catch (error) {
      return output(args, 1, {
        ok: false,
        command: "review-preview",
        issues: [{
          code: "review_preview.review_write_failed",
          message: error instanceof Error ? error.message : String(error),
          path: args.output
        }]
      });
    }
  }

  if (args.command === "run" && args.dryRun) {
    return output(args, 0, {
      ok: true,
      command: "run",
      dry_run: createDryRun(
        validation.project!,
        validation.manifest!,
        validation.adapter,
        validation.analysisAdapters ?? validation.analysisAdapter,
        validation.backend,
        validation.promptGuides,
        validation.audioAdapter,
        validation.generationConnection,
        validation.audioConnection,
        validation.h3_compilations,
        validation.video_prompt_plans
      )
    });
  }

  if (args.command === "gate") {
    const coordinatorIssue = requireCoordinator(args);
    if (coordinatorIssue) return output(args, 1, { ok: false, command: "gate", issues: [coordinatorIssue] });

    const gate = parseGate(args.gate);
    const unsupportedDecision = isUnsupportedDecision(gate, args.decision);
    const decision = parseDecision(gate, args.decision);
    const issues = [
      ...(gate ? [] : [{ code: "cli.gate_missing", message: "--gate must be gate-1, gate-2, or gate-3" }]),
      ...(unsupportedDecision
        ? [unsupportedDecision]
        : decision
          ? []
          : [{ code: "cli.decision_missing", message: "--decision is missing or invalid for the selected gate" }])
    ];
    if (issues.length > 0) return output(args, 1, { ok: false, command: "gate", issues });

    const gateResult = await recordGate(
      args,
      validation.project!,
      validation.manifest!,
      gate!,
      decision!,
      validation.adapter,
      validation.audioAdapter,
      // Keep Gate 2 inspect on the same guide set used at Gate 1 / run (custom dirs included).
      validation.promptGuides
    );
    return output(args, gateResult.ok ? 0 : 1, {
      ok: gateResult.ok,
      command: "gate",
      issues: gateResult.issues,
      state: gateResult.state,
      state_path: gateResult.statePath,
      review_path: gateResult.reviewPath,
      review_data_path: gateResult.reviewDataPath
    });
  }

  if (args.command === "run") {
    const coordinatorIssue = requireCoordinator(args);
    if (coordinatorIssue) return output(args, 1, { ok: false, command: "run", issues: [coordinatorIssue] });

    const stateResult = await loadState(args, validation.project!, { allowMissing: true });
    if (!stateResult.ok) return output(args, 1, { ok: false, command: "run", issues: stateResult.issues });

    if (!stateResult.state || stateResult.state.gates.gate_1.status !== "approved") {
      return output(args, 1, {
        ok: false,
        command: "run",
        issues: [{ code: "run.requires_gate_1_approval", message: "Gate 1 must be approved before run" }]
      });
    }

    const review = await inspectGate1Review({
      configPath: args.config!,
      project: validation.project!,
      manifest: validation.manifest!,
      stateDir: stateResult.stateDir
    });
    if (!review.ok) {
      return output(args, 1, { ok: false, command: "run", issues: review.issues });
    }
    if (stateResult.state.gates.gate_1.approved_input_digest !== review.approvalDigest) {
      return output(args, 1, {
        ok: false,
        command: "run",
        issues: [{ code: "gate.review_changed", message: "Gate 1 approval does not match the current review and input artifacts" }]
      });
    }

    // Active mode: recompute expected Gate1 from durable GateBundle + HumanDecisionRef.
    // Never pass stored production digests as expected (no tautological self-comparison).
    if (resolveOrchestrationMode(validation.project!) === "active") {
      const g1 = stateResult.state.gates.gate_1;
      if (!g1.production_subject_digest || !g1.production_decision_digest) {
        return output(args, 1, {
          ok: false,
          command: "run",
          issues: [{
            code: "gate.production_subject_missing",
            message: "active run requires Gate 1 production_subject_digest and production_decision_digest"
          }]
        });
      }
      const productionId = compileProductionContract({ project: validation.project! }).production_id;
      const runDir = join(stateResult.stateDir, stateResult.state.run_id);
      try {
        const phaseCheck = await assertLiveActiveSubjectsBeforePhase({
          mode: "active",
          phase: "run",
          runDir,
          state: stateResult.state,
          production_id: productionId
        });
        if (!phaseCheck.ok) {
          // Persist cascade under the serial state boundary before throwing the phase error.
          await writeState(stateResult.stateDir, phaseCheck.cascadedState);
          stateResult.state = phaseCheck.cascadedState;
          return output(args, 1, {
            ok: false,
            command: "run",
            issues: [{
              code: "gate.production_subject_stale",
              message: phaseCheck.error.message
            }],
            cascade: {
              stale_gate_1: phaseCheck.cascade.stale_gate_1,
              stale_gate_2: phaseCheck.cascade.stale_gate_2,
              stale_gate_3: phaseCheck.cascade.stale_gate_3,
              kinds: phaseCheck.cascadeKinds
            }
          });
        }
      } catch (error) {
        return output(args, 1, {
          ok: false,
          command: "run",
          issues: [{
            code: "gate.production_subject_stale",
            message: error instanceof Error ? error.message : String(error)
          }]
        });
      }
    }

    const runResult = await assembleLocalMediaRun(validation.project!, validation.manifest!, {
      configPath: resolve(args.config!),
      manifestPath: resolve(dirname(resolve(args.config!)), validation.project!.manifest),
      stateDir: stateResult.stateDir,
      state: stateResult.state,
      generationConnection: validation.generationConnection,
      audioConnection: validation.audioConnection,
      connectionVerificationApproved: true,
      audioConnectionVerificationApproved: true,
      // Keep Gate 1 / run lineage on the same guide set (including custom promptGuideDirs).
      promptGuides: validation.promptGuides,
      generationUnitSourceResolver,
      ...(review.compilation ? { compilation: review.compilation } : {}),
      verifyApprovedInputs: async () => {
        const currentReview = await inspectGate1Review({
          configPath: args.config!,
          project: validation.project!,
          manifest: validation.manifest!,
          stateDir: stateResult.stateDir
        });
        if (!currentReview.ok) return { ok: false as const, issues: currentReview.issues };
        if (stateResult.state!.gates.gate_1.approved_input_digest !== currentReview.approvalDigest) {
          return {
            ok: false as const,
            issues: [{
              code: "gate.review_changed",
              message: "Gate 1 approval does not match the pinned run inputs"
            }]
          };
        }
        return { ok: true as const, issues: [] };
      }
    }, validation.adapter, validation.audioAdapter);
    return output(args, runResult.ok ? 0 : 1, {
      ok: runResult.ok,
      command: "run",
      issues: runResult.issues,
      manifest_path: runResult.manifestPath,
      qc_report_path: runResult.qcReportPath,
      run_log_path: runResult.runLogPath,
      edl_path: runResult.edlPath,
      asset_count: runResult.assetCount,
      actual_credits: runResult.actualCredits,
      already_assembled: runResult.alreadyAssembled,
      gate_2_auto_passed: runResult.gate2AutoPassed,
      gate_2_auto_pass_blocked_reason: runResult.gate2AutoPassBlockedReason,
      state: runResult.state,
      state_path: runResult.statePath,
      ...(runResult.h3_artifacts ? { h3_artifacts: runResult.h3_artifacts } : {})
    });
  }

  if (args.command === "render") {
    const coordinatorIssue = requireCoordinator(args);
    if (coordinatorIssue) return output(args, 1, { ok: false, command: "render", issues: [coordinatorIssue] });

    const stateResult = await loadState(args, validation.project!, { allowMissing: true });
    if (!stateResult.ok) return output(args, 1, { ok: false, command: "render", issues: stateResult.issues });

    if (!stateResult.state || stateResult.state.gates.gate_2.status !== "approved") {
      return output(args, 1, {
        ok: false,
        command: "render",
        issues: [{ code: "render.requires_gate_2_approval", message: "Gate 2 must be approved before render" }]
      });
    }

    let approvedCompilation;
    if (validation.project!.edit.editorial || validation.project!.edit.composition) {
      const review = await inspectGate1Review({
        configPath: args.config!,
        project: validation.project!,
        manifest: validation.manifest!,
        stateDir: stateResult.stateDir
      });
      if (!review.ok) return output(args, 1, { ok: false, command: "render", issues: review.issues });
      if (
        stateResult.state.gates.gate_1.approved_input_digest !== review.approvalDigest ||
        !review.compilation
      ) {
        return output(args, 1, {
          ok: false,
          command: "render",
          issues: [{ code: "gate.analysis_changed", message: "Gate 1 approval does not match the current edit EDL" }]
        });
      }
      approvedCompilation = review.compilation;
    }
    // Restore Gate 2 person-QA decision from the approval binding so the digest
    // matches the payload used at approve time (decision + reason + report hash).
    let gate2PersonQaDecision: PersonQaHumanDecisionRecord | undefined;
    if (personConsistencyRequiredForStage(validation.project!, "gate_2")) {
      const runId = validation.project!.run_id ?? validation.project!.slug;
      const loaded = await loadPersonQaApprovalBinding({
        runDir: join(stateResult.stateDir, runId),
        stage: "gate_2"
      });
      if (loaded.ok) {
        gate2PersonQaDecision = loaded.binding.human_decision;
      }
    }
    const gate2Inspection = await inspectGate2RunForApproval(
      validation.project!,
      validation.manifest!,
      stateResult.stateDir,
      validation.adapter,
      approvedCompilation,
      validation.audioAdapter,
      validation.promptGuides,
      gate2PersonQaDecision
    );
    if (!gate2Inspection.ok) {
      const issues = gate2Inspection.issues.map((issue) =>
        issue.code === "run.manifest_missing"
          ? { ...issue, code: "render.manifest_missing", message: "assembled manifest is missing" }
          : issue
      );
      return output(args, 1, { ok: false, command: "render", issues });
    }
    if (stateResult.state.gates.gate_2.approved_input_digest !== gate2Inspection.approvalDigest) {
      return output(args, 1, {
        ok: false,
        command: "render",
        issues: [{ code: "render.gate2_artifacts_changed", message: "Gate 2 approval does not match the current run artifacts" }]
      });
    }

    // Active mode: live recompute Gate 1+2 subject+decision (not presence-only) before render.
    if (resolveOrchestrationMode(validation.project!) === "active") {
      const g1 = stateResult.state.gates.gate_1;
      const g2 = stateResult.state.gates.gate_2;
      if (
        !g1.production_subject_digest
        || !g1.production_decision_digest
        || !g2.production_subject_digest
        || !g2.production_decision_digest
      ) {
        return output(args, 1, {
          ok: false,
          command: "render",
          issues: [{
            code: "gate.production_subject_missing",
            message: "active render requires current Gate 1 and Gate 2 production subjects"
          }]
        });
      }
      try {
        const productionId = compileProductionContract({ project: validation.project! }).production_id;
        const runDir = join(stateResult.stateDir, stateResult.state.run_id);
        const phaseCheck = await assertLiveActiveSubjectsBeforePhase({
          mode: "active",
          phase: "render",
          runDir,
          state: stateResult.state,
          production_id: productionId
        });
        if (!phaseCheck.ok) {
          await writeState(stateResult.stateDir, phaseCheck.cascadedState);
          return output(args, 1, {
            ok: false,
            command: "render",
            issues: [{
              code: "gate.production_subject_stale",
              message: phaseCheck.error.message
            }],
            cascade: {
              stale_gate_1: phaseCheck.cascade.stale_gate_1,
              stale_gate_2: phaseCheck.cascade.stale_gate_2,
              stale_gate_3: phaseCheck.cascade.stale_gate_3,
              kinds: phaseCheck.cascadeKinds
            }
          });
        }
      } catch (error) {
        return output(args, 1, {
          ok: false,
          command: "render",
          issues: [{
            code: "gate.production_subject_stale",
            message: error instanceof Error ? error.message : String(error)
          }]
        });
      }
    }

    const renderResult = await renderAssembledMedia(validation.project!, {
      stateDir: stateResult.stateDir,
      state: stateResult.state,
      configPath: resolve(args.config!)
    });
    return output(args, renderResult.ok ? 0 : 1, {
      ok: renderResult.ok,
      command: "render",
      issues: renderResult.issues,
      output_path: renderResult.outputPath,
      report_path: renderResult.reportPath,
      gate3_qc_report_path: renderResult.gate3QcReportPath,
      already_rendered: renderResult.alreadyRendered,
      state: renderResult.state,
      state_path: renderResult.statePath
    });
  }

  return output(args, 1, {
    ok: false,
    command: args.command,
    issues: [{ code: "cli.command_unknown", message: `unknown command '${args.command}'` }]
  });
  } finally {
    await runLock?.release();
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const helpRequest = parseHelpRequest(argv);
  if (helpRequest) {
    return {
      command: "help",
      ...(helpRequest.topic ? { helpTopic: helpRequest.topic } : {}),
      json: argv.includes("--json"),
      dryRun: false,
      open: false,
      apply: false,
      defer: false,
      reconcile: false,
      allowExternalAnalysis: false,
      confirmPaid: false,
      paths: [],
      issues: helpRequest.issues
    };
  }

  const commandIndex = argv.findIndex((arg) => arg !== "--json");
  const parsed: ParsedArgs = {
    command: commandIndex >= 0 ? argv[commandIndex] : "",
    json: argv.includes("--json"),
    dryRun: false,
    open: false,
    apply: false,
    defer: false,
    reconcile: false,
    allowExternalAnalysis: false,
    confirmPaid: false,
    paths: [],
    issues: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    if (index === commandIndex) continue;
    const arg = argv[index];
    if (arg === "--json") continue;
    if (arg === "--dry-run") {
      if (isCommandOptionAllowed(parsed.command, arg)) {
        parsed.dryRun = true;
      } else {
        parsed.issues.push({
          code: "cli.option_unsupported",
          message: `${arg} is not supported by '${parsed.command}'`,
          path: arg
        });
      }
      continue;
    }
    if (arg === "--open") {
      if (isCommandOptionAllowed(parsed.command, arg)) {
        parsed.open = true;
      } else {
        parsed.issues.push({
          code: "cli.option_unsupported",
          message: `${arg} is not supported by '${parsed.command}'`,
          path: arg
        });
      }
      continue;
    }
    if (arg === "--apply") {
      if (isCommandOptionAllowed(parsed.command, arg)) {
        parsed.apply = true;
      } else {
        parsed.issues.push({
          code: "cli.option_unsupported",
          message: `${arg} is not supported by '${parsed.command}'`,
          path: arg
        });
      }
      continue;
    }
    if (arg === "--defer" || arg === "--reconcile") {
      if (isCommandOptionAllowed(parsed.command, arg)) {
        if (arg === "--defer") parsed.defer = true;
        else parsed.reconcile = true;
      } else {
        parsed.issues.push({
          code: "cli.option_unsupported",
          message: `${arg} is not supported by '${parsed.command}'`,
          path: arg
        });
      }
      continue;
    }
    if (arg === "--allow-external-analysis") {
      if (isCommandOptionAllowed(parsed.command, arg)) {
        parsed.allowExternalAnalysis = true;
      } else {
        parsed.issues.push({
          code: "cli.option_unsupported",
          message: `${arg} is not supported by '${parsed.command}'`,
          path: arg
        });
      }
      continue;
    }
    if (arg === "--confirm-paid") {
      if (isCommandOptionAllowed(parsed.command, arg)) {
        parsed.confirmPaid = true;
      } else {
        parsed.issues.push({
          code: "cli.option_unsupported",
          message: `${arg} is not supported by '${parsed.command}'`,
          path: arg
        });
      }
      continue;
    }
    if (arg === "--path") {
      if (!isCommandOptionAllowed(parsed.command, arg)) {
        parsed.issues.push({
          code: "cli.option_unsupported",
          message: `${arg} is not supported by '${parsed.command}'`,
          path: arg
        });
        const skipped = argv[index + 1];
        if (skipped && !skipped.startsWith("--")) index += 1;
        continue;
      }
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        parsed.issues.push({
          code: "cli.option_value_missing",
          message: `${arg} requires a value`,
          path: arg
        });
        continue;
      }
      parsed.paths.push(value);
      index += 1;
      continue;
    }

    const valueOptions: Record<
      string,
      keyof Pick<ParsedArgs, "config" | "actor" | "gate" | "decision" | "stateDir" | "catalog" | "model" | "capability" | "inputMode" | "output" | "shot" | "request" | "duration" | "shitateRoot" | "character" | "runId" | "anchor" | "requestId" | "speakerId" | "displayName" | "side" | "accent" | "fromManifest" | "speaker" | "subject" | "field" | "text" | "textFile" | "projectsDir" | "port" | "backend" | "key" | "category" | "signal" | "stage" | "summary" | "evidence" | "promotionKind" | "target" | "proposalSummary" | "verification" | "proposalWorkflow" | "proposalRunId" | "proposalSource" | "expectedPlanDigest" | "expectedProductionCompletionDigest" | "personQaDecision" | "personQaReason" | "service" | "tool" | "argumentsJson" | "recovery" | "errorCode" | "node">
    > = {
      "--config": "config",
      "--actor": "actor",
      "--gate": "gate",
      "--decision": "decision",
      "--person-qa-decision": "personQaDecision",
      "--person-qa-reason": "personQaReason",
      "--state-dir": "stateDir",
      "--catalog": "catalog",
      "--model": "model",
      "--capability": "capability",
      "--input-mode": "inputMode",
      "--output": "output",
      "--shot": "shot",
      "--request": "request",
      "--duration": "duration",
      "--shitate-root": "shitateRoot",
      "--character": "character",
      "--run-id": "runId",
      "--anchor": "anchor",
      "--request-id": "requestId",
      "--speaker-id": "speakerId",
      "--display-name": "displayName",
      "--side": "side",
      "--accent": "accent",
      "--from-manifest": "fromManifest",
      "--speaker": "speaker",
      "--subject": "subject",
      "--field": "field",
      "--text": "text",
      "--text-file": "textFile",
      "--projects-dir": "projectsDir",
      "--port": "port",
      "--backend": "backend",
      "--key": "key",
      "--category": "category",
      "--signal": "signal",
      "--stage": "stage",
      "--summary": "summary",
      "--evidence": "evidence",
      "--promotion-kind": "promotionKind",
      "--target": "target",
      "--proposal-summary": "proposalSummary",
      "--verification": "verification",
      "--proposal-workflow": "proposalWorkflow",
      "--proposal-run-id": "proposalRunId",
      "--proposal-source": "proposalSource",
      "--expected-plan-digest": "expectedPlanDigest",
      "--expected-production-completion-digest": "expectedProductionCompletionDigest",
      "--service": "service",
      "--tool": "tool",
      "--arguments": "argumentsJson",
      "--recovery": "recovery",
      "--error-code": "errorCode",
      "--node": "node"
    };
    const target = valueOptions[arg];
    if (target) {
      const value = argv[index + 1];
      if (!isCommandOptionAllowed(parsed.command, arg)) {
        parsed.issues.push({
          code: "cli.option_unsupported",
          message: `${arg} is not supported by '${parsed.command}'`,
          path: arg
        });
        if (value && !value.startsWith("--")) index += 1;
        continue;
      }
      if (!value || value.startsWith("--")) {
        parsed.issues.push({
          code: "cli.option_value_missing",
          message: `${arg} requires a value`,
          path: arg
        });
        continue;
      }
      parsed[target] = value;
      index += 1;
      continue;
    }

    parsed.issues.push({ code: "cli.option_unknown", message: `unknown option '${arg}'`, path: arg });
  }

  return parsed;
}

type HelpRequest = { topic?: string; issues: Issue[] };

function parseHelpRequest(argv: string[]): HelpRequest | undefined {
  const firstCommandIndex = argv.findIndex((arg) => arg !== "--json");
  const explicitHelpIndex = argv[firstCommandIndex] === "help" ? firstCommandIndex : -1;
  const helpOptionIndex = argv.findIndex((arg) => arg === "--help" || arg === "-h");
  if (explicitHelpIndex < 0 && helpOptionIndex < 0) return undefined;
  if (explicitHelpIndex >= 0) return parseExplicitHelpRequest(argv, explicitHelpIndex);

  return parseCommandHelpRequest(argv, helpOptionIndex);
}

function parseExplicitHelpRequest(argv: string[], explicitHelpIndex: number): HelpRequest {
  let topic: string | undefined;
  const issues: Issue[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json" || index === explicitHelpIndex) continue;

    if (arg.startsWith("-")) {
      issues.push(unsupportedHelpOption(arg));
      const possibleValue = argv[index + 1];
      if (possibleValue && !possibleValue.startsWith("-")) index += 1;
      continue;
    }

    if (!topic) topic = arg;
    else issues.push(extraHelpArgument(arg));
  }
  return { ...(topic ? { topic } : {}), issues };
}

function parseCommandHelpRequest(argv: string[], helpOptionIndex: number): HelpRequest {
  const firstCommandIndex = argv.findIndex((arg) => arg !== "--json");
  let topicIndex = firstCommandIndex >= 0 &&
    firstCommandIndex !== helpOptionIndex &&
    !argv[firstCommandIndex].startsWith("-")
    ? firstCommandIndex
    : -1;
  if (topicIndex < 0 && firstCommandIndex === helpOptionIndex) {
    for (let index = helpOptionIndex + 1; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === "--json") continue;
      if (arg.startsWith("-")) break;
      topicIndex = index;
      break;
    }
  }

  const topic = topicIndex >= 0 ? argv[topicIndex] : undefined;
  const command = topic ? getCommandHelp(topic) : undefined;
  const issues: Issue[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      arg === "--json" ||
      arg === "--help" ||
      arg === "-h" ||
      index === topicIndex
    ) continue;

    if (arg.startsWith("-")) {
      if (topic && !command) {
        const possibleValue = argv[index + 1];
        if (possibleValue && !possibleValue.startsWith("-")) index += 1;
        continue;
      }
      const option = command?.options.find(({ name }) => name === arg) ??
        GLOBAL_OPTIONS.find(({ name }) => name === arg);
      if (option) {
        const possibleValue = argv[index + 1];
        if (option.value && possibleValue && !possibleValue.startsWith("-")) index += 1;
        continue;
      }
      issues.push(unsupportedHelpOption(arg));
      const possibleValue = argv[index + 1];
      if (possibleValue && !possibleValue.startsWith("-")) index += 1;
      continue;
    }

    issues.push(extraHelpArgument(arg));
  }
  return { ...(topic ? { topic } : {}), issues };
}

function unsupportedHelpOption(option: string): Issue {
  return {
    code: "cli.help_option_unsupported",
    message: `${option} is not supported by help`,
    path: option
  };
}

function extraHelpArgument(argument: string): Issue {
  return {
    code: "cli.help_argument_extra",
    message: "help accepts at most one command",
    path: argument
  };
}

async function outputStoryGuides(args: ParsedArgs): Promise<number> {
  if (args.duration && !args.request) {
    return storyGuideOptionError(args, "story_guide.request_required", "--request is required when --duration is provided");
  }
  const duration = args.duration ? Number(args.duration) : undefined;
  if (args.duration && (!Number.isFinite(duration) || duration! <= 0)) {
    return storyGuideOptionError(args, "story_guide.duration", "--duration must be a positive number of seconds");
  }

  const guide = await loadStoryGuide();
  if (!args.request) {
    return output(args, 0, {
      ok: true,
      command: "story-guides",
      scope: "creative-guidance-only",
      execution_capability: "not-evaluated",
      catalog: {
        catalog_id: guide.catalog_id,
        display_name: guide.display_name,
        revision: guide.revision,
        frameworks: guide.frameworks,
        duration_presets: guide.duration_presets,
        principles: guide.principles,
        sources: guide.sources,
        safety_notes: guide.safety_notes
      }
    });
  }

  return output(args, 0, {
    ok: true,
    command: "story-guides",
    scope: "creative-guidance-only",
    execution_capability: "not-evaluated",
    recommendation: recommendStoryFrameworks(args.request, guide, { durationSeconds: duration })
  });
}

function storyGuideOptionError(args: ParsedArgs, code: string, message: string): number {
  return output(args, 1, {
    ok: false,
    command: "story-guides",
    scope: "creative-guidance-only",
    issues: [{ code, message }]
  });
}

async function outputPromptGuides(args: ParsedArgs): Promise<number> {
  if (!args.catalog && (args.model || args.inputMode)) {
    return promptGuideOptionError(args, "prompt_guide.catalog_required", "--catalog is required when filtering guides");
  }
  if (args.catalog && Boolean(args.model) !== Boolean(args.inputMode)) {
    return promptGuideOptionError(
      args,
      "prompt_guide.filter_incomplete",
      "--model and --input-mode must be provided together"
    );
  }
  const inputMode = args.inputMode ? parsePromptMode(args.inputMode) : undefined;
  if (args.inputMode && !inputMode) {
    return promptGuideOptionError(
      args,
      "prompt_guide.input_mode",
      "--input-mode must be text-to-video, image-to-video, transition, or reference"
    );
  }

  if (!args.catalog) {
    const guides = await loadPromptGuideCatalog();
    return output(args, 0, {
      ok: true,
      command: "guides",
      scope: "prompt-guidance-only",
      execution_capability: "not-evaluated",
      catalogs: guides.map((guide) => ({
        catalog_id: guide.catalog_id,
        display_name: guide.display_name,
        revision: guide.revision,
        models: guide.models.map((model) => model.id),
        guide_path: guide.path
      }))
    });
  }

  const guide = await loadPromptGuideById(args.catalog);
  if (!guide) {
    return output(args, 1, {
      ok: false,
      command: "guides",
      scope: "prompt-guidance-only",
      issues: [{ code: "prompt_guide.not_found", message: `prompt guide '${args.catalog}' was not found` }]
    });
  }
  if (!args.model || !args.inputMode) {
    return output(args, 0, {
      ok: true,
      command: "guides",
      scope: "prompt-guidance-only",
      execution_capability: "not-evaluated",
      guide
    });
  }

  const guidance = resolvePromptGuidance(
    {
      id: "guide-query",
      prompt: "guide query",
      model: args.model,
      duration: 1,
      aspect: "16:9",
      input_mode: inputMode!,
      prompt_guide: { catalog: guide.catalog_id },
      params: {}
    },
    guide
  );
  return output(args, 0, {
    ok: true,
    command: "guides",
    scope: "prompt-guidance-only",
    execution_capability: "not-evaluated",
    guidance
  });
}

function promptGuideOptionError(args: ParsedArgs, code: string, message: string): number {
  return output(args, 1, {
    ok: false,
    command: "guides",
    scope: "prompt-guidance-only",
    issues: [{ code, message }]
  });
}

function cliIssuesFromError(error: unknown): Issue[] {
  if (error instanceof PipelineError) return error.issues;
  return [{ code: "pipeline.error", message: error instanceof Error ? error.message : String(error) }];
}

/**
 * Pre-network policy/validation failures stay network_attempted=false.
 * Timeout/network/remote/DNS issues after connect path report true.
 */
function agentServiceErrorImpliesNetwork(issues: Issue[]): boolean {
  const preNetwork = new Set([
    "agent_service.not_found",
    "agent_service.registry_invalid",
    "agent_service.duplicate_id",
    "agent_service.endpoint_invalid",
    "agent_service.endpoint_forbidden",
    "agent_service.tool_undeclared",
    "agent_service.tool_write_like_blocked",
    "agent_service.tool_policy_blocked",
    "agent_service.side_effect_blocked",
    "agent_service.human_gate_required",
    "agent_service.arguments_invalid",
    "agent_service.arguments_too_large",
    "cli.service_missing",
    "cli.tool_missing",
    "cli.option_unknown",
    "cli.option_unsupported",
    "cli.option_value_missing"
  ]);
  if (issues.length === 0) return false;
  // DNS private can happen at pre-connect check; still counts as network attempt
  // (resolver was consulted). Remote/timeout/redirect after fetch also count.
  return issues.some((issue) => !preNetwork.has(issue.code));
}

function parsePromptMode(value: string): PromptMode | undefined {
  if (
    value === "text-to-video"
    || value === "image-to-video"
    || value === "transition"
    || value === "reference"
  ) {
    return value;
  }
  return undefined;
}

function parseFeedbackSignal(value: string | undefined): "prefer" | "avoid" | "keep" | undefined {
  if (value === "prefer" || value === "avoid" || value === "keep") return value;
  return undefined;
}

function parseFeedbackStage(
  value: string | undefined
): "observed" | "recurring" | "promoted" | "verified" | undefined {
  if (value === "observed" || value === "recurring" || value === "promoted" || value === "verified") {
    return value;
  }
  return undefined;
}

function parseFeedbackGate(value: string | undefined): "gate_1" | "gate_2" | "gate_3" | undefined {
  if (value === "gate_1" || value === "gate_2" || value === "gate_3") return value;
  return undefined;
}

function parseFeedbackPromotionKind(
  value: string | undefined
): "template" | "constraint" | "validator" | "qa" | "rule" | "documentation" | undefined {
  if (
    value === "template" ||
    value === "constraint" ||
    value === "validator" ||
    value === "qa" ||
    value === "rule" ||
    value === "documentation"
  ) {
    return value;
  }
  return undefined;
}

type FeedbackAutomationSource = "codex" | "claude-desktop" | "claude-code";

function parseFeedbackAutomationSource(value: string | undefined): FeedbackAutomationSource | undefined {
  if (value === "codex" || value === "claude-desktop" || value === "claude-code") return value;
  return undefined;
}

function automationSourceKind(source: FeedbackAutomationSource) {
  if (source === "claude-desktop") return "claude_desktop_automation" as const;
  if (source === "claude-code") return "claude_code_automation" as const;
  return "codex_automation" as const;
}

function isSafeFeedbackId(value: string): boolean {
  return value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function requireCoordinator(args: ParsedArgs): Issue | undefined {
  if (args.actor === "coordinator") return undefined;
  return {
    code: "cli.coordinator_required",
    message: "this command requires --actor coordinator"
  };
}

function shouldAcquireRunLock(args: ParsedArgs): boolean {
  if (args.command === "review" || args.command === "review-preview" || args.command === "compose") return true;
  if (args.command === "finalize" && args.apply) return args.actor === "coordinator";
  if ((args.command === "run" && !args.dryRun) || args.command === "render") {
    return args.actor === "coordinator";
  }
  if (args.command === "recover" && args.apply) {
    return args.actor === "coordinator";
  }
  if (args.command !== "gate" || args.actor !== "coordinator") return false;

  const gate = parseGate(args.gate);
  return Boolean(gate && !isUnsupportedDecision(gate, args.decision) && parseDecision(gate, args.decision));
}

async function recordGate(
  args: ParsedArgs,
  project: Project,
  manifest: Manifest,
  gate: GateId,
  decision: GateDecision,
  adapter?: AdapterDefinition,
  audioAdapter?: AdapterDefinition,
  promptGuides?: PromptGuide[]
): Promise<Result<{ state: RunState; statePath: string; reviewPath?: string; reviewDataPath?: string }>> {
  const stateLocation = getStateLocation(args, project);
  const existing = await loadState(args, project, { allowMissing: gate === "gate_1" });
  if (!existing.ok) return existing;

  // null when first gate decision synthesizes state — mapper emits run.started.
  const persistedPrevious = existing.state ?? null;
  let state = existing.state ?? createPlannedState(project.run_id ?? project.slug);
  let reviewPath: string | undefined;
  let reviewDataPath: string | undefined;
  let reviewApprovalDigest: string | undefined;
  if (gate === "gate_1" && decision === "approved") {
    const review = await inspectGate1Review({
      configPath: args.config!,
      project,
      manifest,
      stateDir: stateLocation.stateDir
    });
    if (!review.ok) {
      return {
        ok: false,
        issues: review.issues,
        state,
        statePath: stateLocation.statePath,
        reviewPath: review.reviewPath,
        reviewDataPath: review.dataPath
      };
    }
    reviewPath = review.reviewPath;
    reviewDataPath = review.dataPath;
    reviewApprovalDigest = review.approvalDigest;
  }
  if (gate === "gate_1" && (state.gates.gate_1.status === "pending" || state.gates.gate_1.status === "revise")) {
    state = markGateAwaiting(state, "gate_1");
  }

  let gateApprovalDigest = reviewApprovalDigest;
  let personQaApprovalDigest: string | undefined;

  const personQaStage = gate === "gate_2" ? "gate_2" as const : gate === "gate_3" ? "gate_3" as const : undefined;
  let personQaDecision: PersonQaHumanDecisionRecord | undefined;
  if (
    decision === "approved"
    && personQaStage
    && personConsistencyRequiredForStage(project, personQaStage)
  ) {
    const parsedPersonQa = parsePersonQaHumanDecision({
      decision: args.personQaDecision,
      reason: args.personQaReason
    });
    if (!parsedPersonQa.ok) {
      return {
        ok: false,
        issues: [
          {
            code: "person_qa.human_decision_required",
            message:
              "person consistency QA requires --person-qa-decision (accept|revise|accept-not-evaluable) and non-empty --person-qa-reason"
          },
          ...parsedPersonQa.issues
        ],
        state,
        statePath: stateLocation.statePath
      };
    }
    personQaDecision = parsedPersonQa.decision;
    const outerPersonQaIssues = issuesForOuterGateWithPersonQaDecision(decision, personQaDecision);
    if (outerPersonQaIssues.length > 0) {
      return {
        ok: false,
        issues: outerPersonQaIssues,
        state,
        statePath: stateLocation.statePath
      };
    }
  }

  if (decision === "approved" && gate === "gate_2") {
    let approvedCompilation;
    if (project.edit.editorial || project.edit.composition) {
      const review = await inspectGate1Review({
        configPath: args.config!,
        project,
        manifest,
        stateDir: existing.stateDir
      });
      if (!review.ok) {
        return { ok: false, issues: review.issues, state, statePath: stateLocation.statePath };
      }
      if (
        state.gates.gate_1.approved_input_digest !== review.approvalDigest ||
        !review.compilation
      ) {
        return {
          ok: false,
          issues: [{ code: "gate.analysis_changed", message: "Gate 1 approval does not match the current edit EDL" }],
          state,
          statePath: stateLocation.statePath
        };
      }
      approvedCompilation = review.compilation;
    }
    const inspected = await inspectGate2RunForApproval(
      project,
      manifest,
      existing.stateDir,
      adapter,
      approvedCompilation,
      audioAdapter,
      promptGuides,
      personQaDecision
    );
    if (!inspected.ok) {
      return { ok: false, issues: inspected.issues, state, statePath: stateLocation.statePath };
    }
    gateApprovalDigest = inspected.approvalDigest;
    // Persist Gate 2 person-QA binding so render can rebuild the same approval digest.
    if (inspected.personQaApprovalBinding) {
      const runId = project.run_id ?? project.slug;
      const written = await writePersonQaApprovalBinding({
        runDir: join(existing.stateDir, runId),
        binding: inspected.personQaApprovalBinding
      });
      if (!written.ok) {
        return { ok: false, issues: written.issues, state, statePath: stateLocation.statePath };
      }
      personQaApprovalDigest = inspected.personQaApprovalBinding.person_qa_approval_digest;
    }
  }

  if (decision === "approved" && gate === "gate_3") {
    const inspected = await inspectGate3RunForApproval(project, existing.stateDir, personQaDecision);
    if (!inspected.ok) {
      return { ok: false, issues: inspected.issues, state, statePath: stateLocation.statePath };
    }
    gateApprovalDigest = inspected.approvalDigest;
    // Persist person-QA binding (report + decision + reason digest) for finalize revalidation.
    // Gate 3 state.approved_input_digest remains sha256(final.mp4) for launcher compatibility.
    if (inspected.personQaApprovalBinding) {
      const runId = project.run_id ?? project.slug;
      const written = await writePersonQaApprovalBinding({
        runDir: join(existing.stateDir, runId),
        binding: inspected.personQaApprovalBinding
      });
      if (!written.ok) {
        return { ok: false, issues: written.issues, state, statePath: stateLocation.statePath };
      }
      personQaApprovalDigest = inspected.personQaApprovalBinding.person_qa_approval_digest;
    }
  }

  if (
    decision === "approved"
    && args.expectedApprovalDigest
    && gateApprovalDigest !== args.expectedApprovalDigest
  ) {
    return {
      ok: false,
      issues: [{
        code: "gate.approval_artifacts_changed",
        message: "approval artifacts changed after the launcher confirmation"
      }],
      state,
      statePath: stateLocation.statePath,
      reviewPath,
      reviewDataPath
    };
  }

  // Active mode: bind exact production subject+decision for Gate1/2/3 human approvals.
  // Gate1: durable GateBundle digest (review must match rebuild). Unknown price / empty evidence refuse.
  // Gate2/3: exact HumanDecisionRef subjects. Legacy approved_input_digest preserved separately.
  let productionBinding: import("./orchestrator/stateTransitions.js").ProductionGateBinding | undefined;
  const orchestrationMode = resolveOrchestrationMode(project);
  if (orchestrationMode === "active" && decision === "approved") {
    try {
      const decidedAt = new Date().toISOString();
      if (gate === "gate_1") {
        if (!gateApprovalDigest) {
          return {
            ok: false,
            issues: [{
              code: "gate.production_bundle_missing",
              message: "active Gate 1 approval requires a current review subject"
            }],
            state,
            statePath: stateLocation.statePath,
            reviewPath,
            reviewDataPath
          };
        }
        const runDir = join(stateLocation.stateDir, state.run_id);
        const hasGeneration = Boolean(project.generation?.requests?.length);
        // Canonical path: load durable GateBundle written at review (same digest).
        // parseGateBundle re-verifies digest. Generation projects refuse missing durable evidence.
        let bundle = await loadDurableGateBundle(runDir);
        if (!bundle) {
          if (hasGeneration) {
            return {
              ok: false,
              issues: [{
                code: "gate.production_bundle_missing",
                message: "active Gate 1 approval requires durable GateBundle from plan/review evidence"
              }],
              state,
              statePath: stateLocation.statePath,
              reviewPath,
              reviewDataPath
            };
          }
          // Local-media only: rebuild empty-batch GateBundle from contract/tree evidence.
          bundle = buildActiveGateBundleForProject({
            project,
            run_id: state.run_id,
            review_artifact_digest: gateApprovalDigest
          });
          await writeDurableGateBundle(runDir, bundle);
        }
        const decisionId = productionDecisionId("gate_1", "coordinator", decidedAt);
        const bound = buildActiveGate1ProductionBinding({
          production_id: bundle.production_id,
          run_id: state.run_id,
          gate_bundle: bundle,
          legacy_approved_input_digest: gateApprovalDigest,
          decision: {
            decision_id: decisionId,
            decision: "approved",
            actor: "coordinator",
            decided_at: decidedAt
          },
          allow_empty_local_only: !hasGeneration
        });
        await writeDurableGateDecision(runDir, {
          gate: "gate_1",
          decision: {
            decision_id: decisionId,
            decision: "approved",
            actor: "coordinator",
            decided_at: decidedAt,
            subject_digest: bound.subject_digest
          },
          decision_source: "human",
          legacy_approved_input_digest: gateApprovalDigest
        });
        await writeDurableCoordinatorPrincipal(runDir, {
          gate_1_decision_digest: bound.decision_digest
        });
        productionBinding = bound.productionBinding;
      } else if (gate === "gate_2") {
        const g1 = state.gates.gate_1;
        if (!g1.production_decision_digest || !g1.production_subject_digest) {
          return {
            ok: false,
            issues: [{
              code: "gate.production_subject_missing",
              message: "active Gate 2 approval requires Gate 1 production subject and decision"
            }],
            state,
            statePath: stateLocation.statePath
          };
        }
        const runDir = join(stateLocation.stateDir, state.run_id);
        const durable = await loadDurableGateBundle(runDir);
        if (!durable) {
          return {
            ok: false,
            issues: [{
              code: "gate.production_bundle_missing",
              message: "active Gate 2 approval requires durable GateBundle from Gate 1"
            }],
            state,
            statePath: stateLocation.statePath
          };
        }
        if (!gateApprovalDigest) {
          return {
            ok: false,
            issues: [{
              code: "gate.production_subject_missing",
              message: "active Gate 2 approval requires legacy approval digest"
            }],
            state,
            statePath: stateLocation.statePath
          };
        }
        // Actual selected pinned completions + distinct manifest / technical QA digests.
        const completions = await loadDurableSelectedCompletions(runDir);
        const completionDigests = completions.map((ref) => ref.digest);
        const manifestPath = join(runDir, "manifest.json");
        const qcPath = join(runDir, "gate2-qc.json");
        let manifestDigest: string;
        let technicalQaDigest: string;
        try {
          manifestDigest = await sha256FileContents(manifestPath);
          technicalQaDigest = await sha256FileContents(qcPath);
        } catch {
          return {
            ok: false,
            issues: [{
              code: "gate.production_evidence_missing",
              message: "active Gate 2 approval requires durable manifest.json and gate2-qc.json evidence"
            }],
            state,
            statePath: stateLocation.statePath
          };
        }
        const decisionId = productionDecisionId("gate_2", "coordinator", decidedAt);
        const bound = buildActiveGate2ProductionBinding({
          gate_1_decision_digest: g1.production_decision_digest,
          gate_bundle_digest: durable.digest,
          selected_generation_completion_digests: completionDigests,
          manifest_digest: manifestDigest,
          technical_qa_digest: technicalQaDigest,
          decision: {
            decision_id: decisionId,
            decision: "approved",
            actor: "coordinator",
            decided_at: decidedAt
          },
          decision_source: "human",
          legacy_approved_input_digest: gateApprovalDigest
        });
        await writeDurableGate2Evidence(runDir, {
          gate_bundle_digest: durable.digest,
          gate_1_decision_digest: g1.production_decision_digest,
          selected_generation_completion_digests: completionDigests,
          manifest_digest: manifestDigest,
          technical_qa_digest: technicalQaDigest
        });
        await writeDurableGateDecision(runDir, {
          gate: "gate_2",
          decision: {
            decision_id: decisionId,
            decision: "approved",
            actor: "coordinator",
            decided_at: decidedAt,
            subject_digest: bound.subject_digest
          },
          decision_source: "human",
          legacy_approved_input_digest: gateApprovalDigest
        });
        productionBinding = bound.productionBinding;
      } else if (gate === "gate_3") {
        const g2 = state.gates.gate_2;
        if (!g2.production_decision_digest || !g2.production_subject_digest) {
          return {
            ok: false,
            issues: [{
              code: "gate.production_subject_missing",
              message: "active Gate 3 approval requires Gate 2 production subject and decision"
            }],
            state,
            statePath: stateLocation.statePath
          };
        }
        if (!gateApprovalDigest) {
          return {
            ok: false,
            issues: [{
              code: "gate.production_subject_missing",
              message: "active Gate 3 approval requires final artifact digest"
            }],
            state,
            statePath: stateLocation.statePath
          };
        }
        const runDir = join(stateLocation.stateDir, state.run_id);
        // Distinct final artifact / render report / Gate3 QC / branch evidence — not one composite.
        const finalPath = join(runDir, "final.mp4");
        const renderReportPath = join(runDir, "render-report.json");
        const gate3QcPath = join(runDir, "gate3-qc.json");
        let finalArtifactSha: string;
        let renderReportDigest: string;
        let gate3QcDigest: string;
        try {
          finalArtifactSha = await sha256FileContents(finalPath);
          renderReportDigest = await sha256FileContents(renderReportPath);
          gate3QcDigest = await sha256FileContents(gate3QcPath);
        } catch {
          return {
            ok: false,
            issues: [{
              code: "gate.production_evidence_missing",
              message:
                "active Gate 3 approval requires final.mp4, render-report.json, and gate3-qc.json evidence"
            }],
            state,
            statePath: stateLocation.statePath
          };
        }
        if (finalArtifactSha !== gateApprovalDigest) {
          return {
            ok: false,
            issues: [{
              code: "gate.production_evidence_mismatch",
              message: "active Gate 3 final artifact digest does not match approval digest"
            }],
            state,
            statePath: stateLocation.statePath
          };
        }
        // Branch evidence: deterministic digest of Gate2 decision + final (no empty array).
        const selectedBranchDigest = canonicalDigest({
          kind: "gate-3-selected-branch",
          gate_2_decision_digest: g2.production_decision_digest,
          final_artifact_sha256: finalArtifactSha
        });
        const decisionId = productionDecisionId("gate_3", "coordinator", decidedAt);
        const bound = buildActiveGate3ProductionBinding({
          gate_2_decision_digest: g2.production_decision_digest,
          gate_2_subject_digest: g2.production_subject_digest,
          final_artifact_sha256: finalArtifactSha,
          render_report_digest: renderReportDigest,
          gate_3_qc_digest: gate3QcDigest,
          selected_branch_digest: selectedBranchDigest,
          decision: {
            decision_id: decisionId,
            decision: "approved",
            actor: "coordinator",
            decided_at: decidedAt
          },
          legacy_approved_input_digest: gateApprovalDigest
        });
        await writeDurableGate3Evidence(runDir, {
          gate_2_decision_digest: g2.production_decision_digest,
          gate_2_subject_digest: g2.production_subject_digest,
          final_artifact_sha256: finalArtifactSha,
          render_report_digest: renderReportDigest,
          gate_3_qc_digest: gate3QcDigest,
          selected_branch_digest: selectedBranchDigest
        });
        await writeDurableGateDecision(runDir, {
          gate: "gate_3",
          decision: {
            decision_id: decisionId,
            decision: "approved",
            actor: "coordinator",
            decided_at: decidedAt,
            subject_digest: bound.subject_digest
          },
          decision_source: "human",
          legacy_approved_input_digest: gateApprovalDigest
        });
        productionBinding = bound.productionBinding;
      }
    } catch (error) {
      return {
        ok: false,
        issues: [{
          code: "gate.production_subject_invalid",
          message: error instanceof Error ? error.message : String(error)
        }],
        state,
        statePath: stateLocation.statePath,
        reviewPath,
        reviewDataPath
      };
    }
  }

  let nextState: RunState;
  try {
    nextState = recordGateDecision(
      state,
      gate,
      decision,
      undefined,
      gateApprovalDigest,
      "human",
      personQaApprovalDigest,
      productionBinding
    );
  } catch (error) {
    return {
      ok: false,
      issues: [{ code: "state.gate_invalid", message: error instanceof Error ? error.message : String(error) }],
      state,
      statePath: stateLocation.statePath
    };
  }

  try {
    await writeState(stateLocation.stateDir, nextState);
    // Optional sikumi Outbox (default OFF; fail-soft; never blocks gate write).
    const projectRoot = args.config
      ? dirname(resolve(args.config))
      : projectRootFromStateDir(stateLocation.stateDir, project.dist_dir);
    await notifySikumiStateChange({
      project,
      projectRoot,
      previous: persistedPrevious,
      next: nextState
    });
    return {
      ok: true,
      issues: [],
      state: nextState,
      statePath: stateLocation.statePath,
      reviewPath,
      reviewDataPath
    };
  } catch (error) {
    return {
      ok: false,
      issues: [{ code: "state.gate_invalid", message: error instanceof Error ? error.message : String(error) }],
      state,
      statePath: stateLocation.statePath
    };
  }
}

async function loadState(
  args: ParsedArgs,
  project: Project,
  options: { allowMissing?: boolean } = {}
): Promise<Result<{ state?: RunState; statePath: string; stateDir: string }>> {
  const location = getStateLocation(args, project);

  try {
    const state = await readState(location.statePath);
    const runId = project.run_id ?? project.slug;
    if (state.run_id !== runId) {
      return {
        ok: false,
        issues: [
          {
            code: "state.run_id_mismatch",
            message: `state run_id '${state.run_id}' does not match project run_id '${runId}'`,
            path: location.statePath
          }
        ],
        statePath: location.statePath,
        stateDir: location.stateDir
      };
    }
    return { ok: true, issues: [], state, statePath: location.statePath, stateDir: location.stateDir };
  } catch (error) {
    if (options.allowMissing && isMissingFile(error)) {
      return {
        ok: true,
        issues: [],
        statePath: location.statePath,
        stateDir: location.stateDir
      };
    }

    return {
      ok: false,
      issues: [
        {
          code: isMissingFile(error) ? "state.not_found" : "state.invalid",
          message: error instanceof Error ? error.message : String(error),
          path: location.statePath
        }
      ],
      statePath: location.statePath,
      stateDir: location.stateDir
    };
  }
}

function getStateLocation(args: ParsedArgs, project: Project): { stateDir: string; statePath: string } {
  const stateDir = args.stateDir
    ? resolve(args.stateDir)
    : resolve(dirname(resolve(args.config!)), project.dist_dir);
  const runId = project.run_id ?? project.slug;
  return {
    stateDir,
    statePath: join(stateDir, runId, "state.json")
  };
}

function parseGate(value: string | undefined): GateId | undefined {
  if (value === "gate-1" || value === "gate_1") return "gate_1";
  if (value === "gate-2" || value === "gate_2") return "gate_2";
  if (value === "gate-3" || value === "gate_3") return "gate_3";
  return undefined;
}

function parseDecision(gate: GateId | undefined, value: string | undefined): GateDecision | undefined {
  if (gate === "gate_1") {
    if (value === "approve" || value === "approved") return "approved";
    if (value === "revise") return "revise";
    if (value === "abort") return "abort";
  }
  if (gate === "gate_2") {
    if (value === "approve_all" || value === "approve-all") return "approved";
    if (value === "revise") return "revise";
    if (value === "abort") return "abort";
  }
  if (gate === "gate_3") {
    if (value === "approve" || value === "approved") return "approved";
    if (value === "re-render" || value === "re_render") return "re_render";
    if (value === "abort") return "abort";
  }
  return undefined;
}

function isUnsupportedDecision(gate: GateId | undefined, value: string | undefined): Issue | undefined {
  if (gate === "gate_2" && (value === "retry_specific" || value === "retry-specific")) {
    return {
      code: "cli.decision_unsupported",
      message: "Gate 2 retry_specific is not implemented; use revise for a full re-plan",
      path: "--decision"
    };
  }
  return undefined;
}

type SerializableCommandHelp = {
  name: string;
  summary: string;
  usage: string;
  requires_config: boolean;
  safety: CommandSpec["safety"];
  options: Array<{ name: string; value?: string; summary: string }>;
};

function outputHelp(args: ParsedArgs): number {
  if (args.helpTopic) {
    const command = getCommandHelp(args.helpTopic);
    if (!command) {
      const suggestedCommands = suggestCommands(args.helpTopic);
      return output(args, 1, {
        ok: false,
        command: "help",
        topic: args.helpTopic,
        issues: [{ code: "cli.help_topic_unknown", message: `unknown command '${args.helpTopic}'` }],
        suggested_commands: suggestedCommands,
        next_actions: [
          ...(suggestedCommands[0] ? [`node bin/pipeline help ${suggestedCommands[0]}`] : []),
          "node bin/pipeline --help"
        ]
      });
    }

    const commandHelp = serializeCommandHelp(command);
    const payload = {
      ok: true,
      command: "help",
      topic: command.name,
      command_help: commandHelp
    };
    if (args.json) return output(args, 0, payload);
    console.log(formatCommandHelp(commandHelp));
    return 0;
  }

  const commands = listCommandHelp().map(serializeCommandHelp);
  const payload = {
    ok: true,
    command: "help",
    usage: "node bin/pipeline <command> [options]",
    global_options: GLOBAL_OPTIONS,
    commands
  };
  if (args.json) return output(args, 0, payload);
  console.log(formatCommandCatalogHelp(payload.usage, commands));
  return 0;
}

function serializeCommandHelp(command: CommandSpec): SerializableCommandHelp {
  return {
    name: command.name,
    summary: command.summary,
    usage: command.usage,
    requires_config: command.requiresConfig,
    safety: command.safety,
    options: [...command.options, ...GLOBAL_OPTIONS].map((option) => ({ ...option }))
  };
}

function formatCommandCatalogHelp(usage: string, commands: SerializableCommandHelp[]): string {
  const longestName = Math.max(...commands.map((command) => command.name.length));
  const lines = [
    "Tsugite pipeline",
    `Usage: ${usage}`,
    "",
    "Commands:",
    ...commands.map((command) => (
      `  ${command.name.padEnd(longestName)}  ${command.summary} [${command.safety}]`
    )),
    "",
    "Safety:",
    "  read-only       Does not change project or Gate state.",
    "  local-write     Writes local artifacts or project records.",
    "  approval-gated  Human approval and the required actor remain mandatory.",
    "",
    "Run `node bin/pipeline help <command>` for command-specific options.",
    "Add `--json` for machine-readable output."
  ];
  return lines.join("\n");
}

function formatCommandHelp(command: SerializableCommandHelp): string {
  const optionLines = command.options.map((option) => {
    const signature = [option.name, option.value].filter(Boolean).join(" ");
    return `  ${signature.padEnd(32)} ${option.summary}`;
  });
  return [
    `${command.name} - ${command.summary}`,
    `Usage: ${command.usage}`,
    `Safety: ${command.safety}`,
    `Project config required: ${command.requires_config ? "yes" : "no"}`,
    "",
    "Options:",
    ...optionLines
  ].join("\n");
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function output(args: ParsedArgs, status: number, payload: unknown): number {
  const text = args.json ? JSON.stringify(payload, null, 2) : formatHuman(payload);
  if (status === 0) console.log(text);
  else console.error(text);
  return status;
}

function formatHuman(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  const status = await main();
  // Large JSON over pipes can exceed the ~64KiB kernel buffer; process.exit()
  // must wait for stdout/stderr to drain or parents only see truncated output.
  await drainStdio();
  process.exit(status);
}

/**
 * Wait for stdout/stderr to flush (or timeout) before process.exit.
 * Only waits when the stream already needs a drain (large JSON over a full
 * pipe). Avoid empty writes — they can keep the process alive long enough for
 * late Node warnings to append after the JSON body on stderr.
 */
export async function drainStdio(options: {
  timeoutMs?: number;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
} = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const drain = (stream: NodeJS.WriteStream): Promise<void> => new Promise((resolveDrain) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveDrain();
    };
    const timer = setTimeout(done, Math.max(1, timeoutMs));
    try {
      if (stream.destroyed || stream.writableEnded) {
        done();
        return;
      }
      if (stream.writableNeedDrain) {
        stream.once("drain", done);
        stream.once("error", done);
        stream.once("close", done);
        return;
      }
      // Already drained: resolve immediately (do not write("") — pollutes stderr/stdout tests).
      done();
    } catch {
      done();
    }
  });
  await Promise.all([
    drain(options.stdout ?? process.stdout),
    drain(options.stderr ?? process.stderr)
  ]);
}
