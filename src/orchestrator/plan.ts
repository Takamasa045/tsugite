import type { Manifest } from "../manifest/schema.js";
import type { Project } from "../project/schema.js";
import type { AdapterDefinition } from "../adapters/registry.js";
import {
  resolveProjectPromptGuidance,
  type PromptGuide,
  type PromptGuidance
} from "../adapters/promptKnowledge.js";
import {
  renderPreflightCommands,
  type BackendCapabilities,
  type BackendExternalCommand
} from "../backends/capabilities.js";

export type PlanStep = {
  name: string;
  status: "pending" | "gate";
};

export type AgentHandoff = {
  phase: "generation" | "analysis";
  adapter: string;
  kind: AdapterDefinition["kind"];
  class: AdapterDefinition["class"];
  outputs: string[];
  dry_run_estimate_available: boolean;
  batch: boolean;
  execution: "pipeline-cli" | "agent-handoff";
};

export type ExecutionPlan = {
  run_id: string;
  slug: string;
  backend: string;
  target_duration_seconds: number;
  total_clip_duration_seconds: number;
  estimated_credits: number;
  clips: Array<{
    id: string;
    duration: number;
    src: string;
  }>;
  agent_handoffs: AgentHandoff[];
  prompt_guidance?: PromptGuidance[];
  steps: PlanStep[];
};

export function createPlan(
  project: Project,
  manifest: Manifest,
  adapter?: AdapterDefinition,
  analysisAdapter?: AdapterDefinition,
  promptGuides: PromptGuide[] = []
): ExecutionPlan {
  const totalClipDuration = manifest.clips.reduce((sum, clip) => sum + clip.duration, 0);
  const estimatedCredits = estimateCredits(project, adapter);
  const agentHandoffs = createAgentHandoffs(project, adapter, analysisAdapter);
  const promptGuidance = resolveProjectPromptGuidance(project, promptGuides);

  return {
    run_id: project.run_id ?? project.slug,
    slug: project.slug,
    backend: project.edit.backend,
    target_duration_seconds: manifest.meta.target_duration_seconds,
    total_clip_duration_seconds: totalClipDuration,
    estimated_credits: estimatedCredits,
    clips: manifest.clips.map((clip) => ({
      id: clip.id,
      duration: clip.duration,
      src: clip.src
    })),
    agent_handoffs: agentHandoffs,
    ...(promptGuidance.length > 0 ? { prompt_guidance: promptGuidance } : {}),
    steps: [
      { name: "validate", status: "pending" },
      ...(project.analysis ? [{ name: "analysis-handoff", status: "pending" as const }] : []),
      { name: "creative-review", status: "pending" },
      { name: "gate-1", status: "gate" },
      { name: "assemble-manifest", status: "pending" },
      { name: "gate-2", status: "gate" },
      { name: "render", status: "pending" },
      { name: "gate-3", status: "gate" }
    ]
  };
}

export function createDryRun(
  project: Project,
  manifest: Manifest,
  adapter?: AdapterDefinition,
  analysisAdapter?: AdapterDefinition,
  backend?: BackendCapabilities,
  promptGuides: PromptGuide[] = []
): {
  executed: false;
  plan: ExecutionPlan;
  estimated_credits: number;
  external_commands: BackendExternalCommand[];
  agent_handoffs: AgentHandoff[];
} {
  const plan = createPlan(project, manifest, adapter, analysisAdapter, promptGuides);
  return {
    executed: false,
    plan,
    estimated_credits: estimateCredits(project, adapter),
    external_commands: renderPreflightCommands(backend),
    agent_handoffs: plan.agent_handoffs
  };
}

function estimateCredits(project: Project, adapter?: AdapterDefinition): number {
  if (!project.generation || !adapter) return 0;
  return project.generation.requests.reduce((sum, request) => {
    return (
      sum +
      adapter.credit_estimate.per_request +
      request.duration * adapter.credit_estimate.per_second
    );
  }, 0);
}

function createAgentHandoffs(
  project: Project,
  adapter?: AdapterDefinition,
  analysisAdapter?: AdapterDefinition
): AgentHandoff[] {
  const handoffs: AgentHandoff[] = [];

  if (project.generation && adapter) {
    handoffs.push({
      phase: "generation",
      adapter: adapter.name,
      kind: adapter.kind,
      class: adapter.class,
      outputs: project.generation.requests.map((request) => request.id),
      dry_run_estimate_available: adapter.dry_run_estimate,
      batch: adapter.batch,
      execution: adapter.kind === "cli" ? "pipeline-cli" : "agent-handoff"
    });
  }

  if (project.analysis && analysisAdapter) {
    handoffs.push({
      phase: "analysis",
      adapter: analysisAdapter.name,
      kind: analysisAdapter.kind,
      class: analysisAdapter.class,
      outputs: project.analysis.requests.map((request) => request.output),
      dry_run_estimate_available: analysisAdapter.dry_run_estimate,
      batch: analysisAdapter.batch,
      execution: analysisAdapter.kind === "cli" ? "pipeline-cli" : "agent-handoff"
    });
  }

  return handoffs;
}
