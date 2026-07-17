import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectEnvironment } from "./doctor.js";
import { loadBackendCapabilities } from "./backends/capabilities.js";
import type { AdapterDefinition } from "./adapters/registry.js";
import { analyzeProject } from "./orchestrator/analyze.js";
import {
  loadPromptGuideCatalog,
  loadPromptGuideById,
  resolvePromptGuidance,
  type PromptMode
} from "./adapters/promptKnowledge.js";
import {
  loadStoryGuide,
  recommendStoryFrameworks
} from "./adapters/storyKnowledge.js";
import type { Manifest } from "./manifest/schema.js";
import { createDryRun, createPlan } from "./orchestrator/plan.js";
import { finalizeCompletedProject } from "./orchestrator/finalize.js";
import {
  inspectGate1Review,
  openCreativeReview,
  writeCreativeReview
} from "./orchestrator/review.js";
import { inspectGate3RunForApproval, renderAssembledMedia } from "./orchestrator/render.js";
import { assembleLocalMediaRun, inspectGate2RunForApproval } from "./orchestrator/run.js";
import {
  createPlannedState,
  markGateAwaiting,
  readState,
  recordGateDecision,
  writeState,
  type GateDecision,
  type GateId,
  type RunState
} from "./orchestrator/state.js";
import { validateProject } from "./project/validateProject.js";
import type { Project } from "./project/schema.js";
import { PipelineError, type Issue, type Result } from "./types.js";
import { appendProjectFeedback } from "./feedback/index.js";
import { openWorkflowViewer, writeWorkflowViewer } from "./viewer/artifact.js";
import {
  openWorkflowViewerLauncher,
  startWorkflowViewerLauncher
} from "./viewer/launcher.js";

type ParsedArgs = {
  command: string;
  config?: string;
  json: boolean;
  dryRun: boolean;
  actor?: string;
  gate?: string;
  decision?: string;
  stateDir?: string;
  catalog?: string;
  model?: string;
  inputMode?: string;
  output?: string;
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
  open: boolean;
  apply: boolean;
  allowExternalAnalysis: boolean;
  issues: Issue[];
};

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.issues.length > 0) {
    return output(args, 1, { ok: false, command: args.command, issues: args.issues });
  }
  if (!args.command) {
    return output(args, 1, { ok: false, issues: [{ code: "cli.command_missing", message: "command is required" }] });
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

  if (!args.config) {
    return output(args, 1, {
      ok: false,
      command: args.command,
      issues: [{ code: "cli.config_missing", message: "--config is required" }]
    });
  }

  if (args.command === "feedback") {
    const signal = parseFeedbackSignal(args.signal);
    const stage = parseFeedbackStage(args.stage);
    const gate = parseFeedbackGate(args.gate);
    const promotionKind = parseFeedbackPromotionKind(args.promotionKind);
    const hasPromotionTarget = Boolean(promotionKind && args.target);
    const hasProposalDetails = Boolean(args.proposalSummary && args.verification);
    const hasProposalSource = Boolean(args.proposalWorkflow || args.proposalRunId);
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
      ...(hasProposalSource && !hasProposalDetails
        ? [{
            code: "feedback.proposal_source_without_proposal",
            message: "proposal source requires --proposal-summary and --verification",
            path: args.proposalWorkflow ? "--proposal-workflow" : "--proposal-run-id"
          }]
        : []),
      ...(args.proposalRunId && !args.proposalWorkflow
        ? [{
            code: "feedback.proposal_workflow_required",
            message: "--proposal-run-id requires --proposal-workflow",
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
                    kind: "codex_automation" as const,
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

  const validation = await validateProject(args.config);
  if (args.command === "validate") {
    return output(args, validation.ok ? 0 : 1, {
      ok: validation.ok,
      command: "validate",
      issues: validation.issues
    });
  }

  if (!validation.ok) {
    return output(args, 1, {
      ok: false,
      command: args.command,
      issues: validation.issues
    });
  }

  if (args.command === "finalize") {
    if (args.apply) {
      const coordinatorIssue = requireCoordinator(args);
      if (coordinatorIssue) {
        return output(args, 1, { ok: false, command: "finalize", issues: [coordinatorIssue] });
      }
    }
    const finalized = await finalizeCompletedProject({
      configPath: args.config,
      project: validation.project!,
      manifest: validation.manifest!,
      stateDir: args.stateDir,
      apply: args.apply
    });
    return output(args, finalized.ok ? 0 : 1, {
      ok: finalized.ok,
      command: "finalize",
      issues: finalized.issues,
      applied: finalized.applied,
      canonical_output: finalized.canonicalOutput,
      completion_record: finalized.recordPath,
      media_files: finalized.mediaFiles,
      retained_media: finalized.retainedMedia,
      planned_bytes: finalized.plannedBytes,
      deleted_files: finalized.deletedFiles,
      deleted_bytes: finalized.deletedBytes
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
        validation.promptGuides
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

  if (args.command === "viewer") {
    const plan = createPlan(
      validation.project!,
      validation.manifest!,
      validation.adapter,
      validation.analysisAdapters ?? validation.analysisAdapter,
      validation.promptGuides
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
      validation.promptGuides
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
        validation.promptGuides
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
      validation.adapter
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
    if (
      validation.project!.analysis &&
      stateResult.state.gates.gate_1.approved_input_digest !== review.approvalDigest
    ) {
      return output(args, 1, {
        ok: false,
        command: "run",
        issues: [{ code: "gate.analysis_changed", message: "Gate 1 approval does not match the current analysis artifacts" }]
      });
    }

    const runResult = await assembleLocalMediaRun(validation.project!, validation.manifest!, {
      configPath: resolve(args.config!),
      manifestPath: resolve(dirname(resolve(args.config!)), validation.project!.manifest),
      stateDir: stateResult.stateDir,
      state: stateResult.state,
      ...(review.compilation ? { editorial: review.compilation } : {})
    }, validation.adapter);
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
      state: runResult.state,
      state_path: runResult.statePath
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

    let editorialCompilation;
    if (validation.project!.edit.editorial) {
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
          issues: [{ code: "gate.analysis_changed", message: "Gate 1 approval does not match the current editorial EDL" }]
        });
      }
      editorialCompilation = review.compilation;
    }
    const gate2Inspection = await inspectGate2RunForApproval(
      validation.project!,
      validation.manifest!,
      stateResult.stateDir,
      validation.adapter,
      editorialCompilation
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

    const renderResult = await renderAssembledMedia(validation.project!, {
      stateDir: stateResult.stateDir,
      state: stateResult.state
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
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: argv[0] ?? "",
    json: argv.includes("--json"),
    dryRun: false,
    open: false,
    apply: false,
    allowExternalAnalysis: false,
    issues: []
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") continue;
    if (arg === "--dry-run") {
      if (isOptionAllowed(parsed.command, arg)) {
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
      if (isOptionAllowed(parsed.command, arg)) {
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
      if (isOptionAllowed(parsed.command, arg)) {
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
    if (arg === "--allow-external-analysis") {
      if (isOptionAllowed(parsed.command, arg)) {
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

    const valueOptions: Record<
      string,
      keyof Pick<ParsedArgs, "config" | "actor" | "gate" | "decision" | "stateDir" | "catalog" | "model" | "inputMode" | "output" | "request" | "duration" | "shitateRoot" | "character" | "runId" | "anchor" | "requestId" | "speakerId" | "displayName" | "side" | "accent" | "projectsDir" | "port" | "backend" | "key" | "category" | "signal" | "stage" | "summary" | "evidence" | "promotionKind" | "target" | "proposalSummary" | "verification" | "proposalWorkflow" | "proposalRunId">
    > = {
      "--config": "config",
      "--actor": "actor",
      "--gate": "gate",
      "--decision": "decision",
      "--state-dir": "stateDir",
      "--catalog": "catalog",
      "--model": "model",
      "--input-mode": "inputMode",
      "--output": "output",
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
      "--proposal-run-id": "proposalRunId"
    };
    const target = valueOptions[arg];
    if (target) {
      const value = argv[index + 1];
      if (!isOptionAllowed(parsed.command, arg)) {
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

function isOptionAllowed(command: string, option: string): boolean {
  const allowedByCommand: Record<string, Set<string>> = {
    doctor: new Set(["--config"]),
    guides: new Set(["--catalog", "--model", "--input-mode"]),
    "story-guides": new Set(["--request", "--duration"]),
    presets: new Set(["--backend"]),
    "viewer-launcher": new Set(["--projects-dir", "--port", "--open"]),
    "shitate-import": new Set(["--config", "--shitate-root", "--character", "--run-id", "--anchor", "--request-id", "--speaker-id", "--display-name", "--side", "--accent"]),
    feedback: new Set(["--config", "--key", "--category", "--signal", "--stage", "--summary", "--run-id", "--gate", "--evidence", "--promotion-kind", "--target", "--proposal-summary", "--verification", "--proposal-workflow", "--proposal-run-id"]),
    validate: new Set(["--config"]),
    plan: new Set(["--config"]),
    analyze: new Set(["--config", "--actor", "--state-dir", "--allow-external-analysis"]),
    viewer: new Set(["--config", "--output", "--state-dir", "--open"]),
    review: new Set(["--config", "--output", "--state-dir", "--open"]),
    finalize: new Set(["--config", "--state-dir", "--actor", "--apply"]),
    run: new Set(["--config", "--dry-run", "--actor", "--state-dir"]),
    gate: new Set(["--config", "--actor", "--gate", "--decision", "--state-dir"]),
    render: new Set(["--config", "--actor", "--state-dir"])
  };
  return allowedByCommand[command]?.has(option) ?? true;
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
      "--input-mode must be text-to-video or image-to-video"
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

function parsePromptMode(value: string): PromptMode | undefined {
  if (value === "text-to-video" || value === "image-to-video") return value;
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

async function recordGate(
  args: ParsedArgs,
  project: Project,
  manifest: Manifest,
  gate: GateId,
  decision: GateDecision,
  adapter?: AdapterDefinition
): Promise<Result<{ state: RunState; statePath: string; reviewPath?: string; reviewDataPath?: string }>> {
  const stateLocation = getStateLocation(args, project);
  const existing = await loadState(args, project, { allowMissing: gate === "gate_1" });
  if (!existing.ok) return existing;

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

  if (decision === "approved" && gate === "gate_2") {
    let editorialCompilation;
    if (project.edit.editorial) {
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
          issues: [{ code: "gate.analysis_changed", message: "Gate 1 approval does not match the current editorial EDL" }],
          state,
          statePath: stateLocation.statePath
        };
      }
      editorialCompilation = review.compilation;
    }
    const inspected = await inspectGate2RunForApproval(
      project,
      manifest,
      existing.stateDir,
      adapter,
      editorialCompilation
    );
    if (!inspected.ok) {
      return { ok: false, issues: inspected.issues, state, statePath: stateLocation.statePath };
    }
    gateApprovalDigest = inspected.approvalDigest;
  }

  if (decision === "approved" && gate === "gate_3") {
    const inspected = await inspectGate3RunForApproval(project, existing.stateDir);
    if (!inspected.ok) {
      return { ok: false, issues: inspected.issues, state, statePath: stateLocation.statePath };
    }
  }

  let nextState: RunState;
  try {
    nextState = recordGateDecision(state, gate, decision, undefined, gateApprovalDigest);
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
  process.exit(status);
}
