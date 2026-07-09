import type { Manifest } from "../manifest/schema.js";
import type { Project } from "../project/schema.js";
import type { AdapterDefinition } from "../adapters/registry.js";
import {
  renderPreflightCommands,
  type BackendCapabilities,
  type BackendExternalCommand
} from "../backends/capabilities.js";

export type PlanStep = {
  name: string;
  status: "pending" | "gate";
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
  steps: PlanStep[];
};

export function createPlan(
  project: Project,
  manifest: Manifest,
  adapter?: AdapterDefinition
): ExecutionPlan {
  const totalClipDuration = manifest.clips.reduce((sum, clip) => sum + clip.duration, 0);
  const estimatedCredits = estimateCredits(project, adapter);

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
    steps: [
      { name: "validate", status: "pending" },
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
  backend?: BackendCapabilities
): {
  executed: false;
  plan: ExecutionPlan;
  estimated_credits: number;
  external_commands: BackendExternalCommand[];
} {
  return {
    executed: false,
    plan: createPlan(project, manifest, adapter),
    estimated_credits: estimateCredits(project, adapter),
    external_commands: renderPreflightCommands(backend)
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
