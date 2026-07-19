import type { Manifest } from "../manifest/schema.js";
import type { AudioRequest, Project } from "../project/schema.js";
import type { AdapterDefinition } from "../adapters/registry.js";
import type { GenerationConnectionResolution } from "../connections/registry.js";
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
  phase: "generation" | "audio" | "analysis";
  adapter: string;
  connection?: string;
  transport?: GenerationConnectionResolution["transport"];
  setup_status?: GenerationConnectionResolution["setup_status"];
  provider?: string;
  route_note?: string;
  auth_kind?: GenerationConnectionResolution["auth_kind"];
  connection_contract_digest?: string;
  automatic_fallback?: false;
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
  analysis?: {
    mode: "local" | "hybrid" | "cloud";
    external_permission_required: boolean;
    max_estimated_credits: number;
    transfers: Array<{
      request_id: string;
      adapter: string;
      input_scope: "low-confidence-segments" | "source-media" | "source-media-and-dependencies";
      credential_env: string[];
      timeout_ms: number;
    }>;
  };
  audio?: AudioRequest & {
    automatic_fallback: false;
    external_permission_required: boolean;
    transfer?: {
      input_scope: "request-metadata";
      credential_env: string[];
      optional_credential_env: string[];
      timeout_ms: number;
    };
  };
  prompt_guidance?: PromptGuidance[];
  steps: PlanStep[];
};

type AnalysisAdapterInput = AdapterDefinition | AdapterDefinition[];

export function createPlan(
  project: Project,
  manifest: Manifest,
  adapter?: AdapterDefinition,
  analysisAdapter?: AnalysisAdapterInput,
  promptGuides: PromptGuide[] = [],
  audioAdapter?: AdapterDefinition,
  generationConnection?: GenerationConnectionResolution,
  audioConnection?: GenerationConnectionResolution
): ExecutionPlan {
  const totalClipDuration = manifest.clips.reduce((sum, clip) => sum + clip.duration, 0);
  const estimatedCredits = estimateCredits(project, manifest, adapter, analysisAdapter, audioAdapter);
  const agentHandoffs = createAgentHandoffs(
    project,
    adapter,
    analysisAdapter,
    audioAdapter,
    generationConnection,
    audioConnection
  );
  const analysis = createAnalysisPlan(project, manifest, analysisAdapter);
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
    ...(analysis ? { analysis } : {}),
    ...(project.audio
      ? {
          audio: {
            ...project.audio,
            automatic_fallback: false as const,
            external_permission_required: Boolean(audioAdapter?.network),
            ...(audioAdapter?.network?.input_scope === "request-metadata"
              ? {
                  transfer: {
                    input_scope: audioAdapter.network.input_scope,
                    credential_env: [...audioAdapter.network.credential_env],
                    optional_credential_env: [...audioAdapter.network.optional_credential_env],
                    timeout_ms: audioAdapter.network.timeout_ms
                  }
                }
              : {}),
            ...(project.audio.bgm ? { bgm: { ...project.audio.bgm } } : {}),
            sfx: project.audio.sfx.map((request) => ({ ...request })),
            params: { ...project.audio.params }
          }
        }
      : {}),
    ...(promptGuidance.length > 0 ? { prompt_guidance: promptGuidance } : {}),
    steps: [
      { name: "validate", status: "pending" },
      ...(project.analysis ? [{ name: "analysis-handoff", status: "pending" as const }] : []),
      { name: "creative-review", status: "pending" },
      { name: "gate-1", status: "gate" },
      ...(project.audio ? [{ name: "audio-generation", status: "pending" as const }] : []),
      { name: "assemble-manifest", status: "pending" },
      { name: "gate-2", status: "gate" },
      { name: "render", status: "pending" },
      { name: "gate-3", status: "gate" }
    ]
  };
}

function createAnalysisPlan(
  project: Project,
  manifest: Manifest,
  analysisAdapter?: AnalysisAdapterInput
): ExecutionPlan["analysis"] | undefined {
  if (!project.analysis) return undefined;
  const available = analysisAdapter
    ? (Array.isArray(analysisAdapter) ? analysisAdapter : [analysisAdapter])
    : [];
  const byName = new Map(available.map((adapter) => [adapter.name, adapter]));
  const transfers = project.analysis.requests.flatMap((request) => {
    const adapterName = request.adapter ?? project.analysis!.adapter;
    const definition = byName.get(adapterName);
    if (!definition?.network || definition.network.input_scope === "request-metadata") return [];
    return [{
      request_id: request.id,
      adapter: adapterName,
      input_scope: definition.network.input_scope,
      credential_env: [...definition.network.credential_env],
      timeout_ms: definition.network.timeout_ms
    }];
  });
  return {
    mode: project.analysis.mode,
    external_permission_required: transfers.length > 0,
    max_estimated_credits: estimateAnalysisCredits(project, manifest, analysisAdapter),
    transfers
  };
}

export function createDryRun(
  project: Project,
  manifest: Manifest,
  adapter?: AdapterDefinition,
  analysisAdapter?: AnalysisAdapterInput,
  backend?: BackendCapabilities,
  promptGuides: PromptGuide[] = [],
  audioAdapter?: AdapterDefinition,
  generationConnection?: GenerationConnectionResolution,
  audioConnection?: GenerationConnectionResolution
): {
  executed: false;
  plan: ExecutionPlan;
  estimated_credits: number;
  external_commands: BackendExternalCommand[];
  agent_handoffs: AgentHandoff[];
} {
  const plan = createPlan(
    project,
    manifest,
    adapter,
    analysisAdapter,
    promptGuides,
    audioAdapter,
    generationConnection,
    audioConnection
  );
  return {
    executed: false,
    plan,
    estimated_credits: estimateCredits(project, manifest, adapter, analysisAdapter, audioAdapter),
    external_commands: renderPreflightCommands(backend),
    agent_handoffs: plan.agent_handoffs
  };
}

function estimateCredits(
  project: Project,
  manifest: Manifest,
  adapter?: AdapterDefinition,
  analysisAdapter?: AnalysisAdapterInput,
  audioAdapter?: AdapterDefinition
): number {
  const generation = !project.generation || !adapter
    ? 0
    : project.generation.requests.reduce((sum, request) => {
        return sum + adapter.credit_estimate.per_request + request.duration * adapter.credit_estimate.per_second;
      }, 0);
  const audio = !project.audio || !audioAdapter
    ? 0
    : audioAdapter.credit_estimate.per_request +
      manifest.meta.target_duration_seconds * audioAdapter.credit_estimate.per_second;
  return generation + audio + estimateAnalysisCredits(project, manifest, analysisAdapter);
}

function estimateAnalysisCredits(
  project: Project,
  manifest: Manifest,
  analysisAdapter?: AnalysisAdapterInput
): number {
  if (!project.analysis || !analysisAdapter) return 0;
  const available = Array.isArray(analysisAdapter) ? analysisAdapter : [analysisAdapter];
  const byName = new Map(available.map((definition) => [definition.name, definition]));
  const analysis = project.analysis.requests.reduce((sum, request) => {
    const definition = byName.get(request.adapter ?? project.analysis!.adapter);
    if (!definition?.network) return sum;
    const clip = request.source_clip_id
      ? manifest.clips.find((candidate) => candidate.id === request.source_clip_id)
      : manifest.clips.length === 1 ? manifest.clips[0] : undefined;
    const duration = clip ? clip.out - clip.in : 0;
    return sum + definition.credit_estimate.per_request + duration * definition.credit_estimate.per_second;
  }, 0);
  return analysis;
}

function createAgentHandoffs(
  project: Project,
  adapter?: AdapterDefinition,
  analysisAdapter?: AnalysisAdapterInput,
  audioAdapter?: AdapterDefinition,
  generationConnection?: GenerationConnectionResolution,
  audioConnection?: GenerationConnectionResolution
): AgentHandoff[] {
  const handoffs: AgentHandoff[] = [];

  if (project.generation && adapter) {
    handoffs.push({
      phase: "generation",
      adapter: adapter.name,
      automatic_fallback: false,
      ...(project.generation.connection
        ? {
            connection: project.generation.connection,
            ...(generationConnection
              ? {
                  transport: generationConnection.transport,
                  setup_status: generationConnection.setup_status,
                  provider: generationConnection.provider,
                  route_note: generationConnection.route_note,
                  auth_kind: generationConnection.auth_kind,
                  connection_contract_digest: generationConnection.contract_digest
                }
              : {})
          }
        : {}),
      kind: adapter.kind,
      class: adapter.class,
      outputs: project.generation.requests.map((request) => request.id),
      dry_run_estimate_available: adapter.dry_run_estimate,
      batch: adapter.batch,
      execution: generationConnection
        ? generationConnection.transport === "cli" && adapter.kind === "cli"
          ? "pipeline-cli"
          : "agent-handoff"
        : adapter.kind === "cli" ? "pipeline-cli" : "agent-handoff"
    });
  }

  if (project.audio && audioAdapter) {
    handoffs.push({
      phase: "audio",
      adapter: audioAdapter.name,
      automatic_fallback: false,
      ...(project.audio.connection
        ? {
            connection: project.audio.connection,
            ...(audioConnection
              ? {
                  transport: audioConnection.transport,
                  setup_status: audioConnection.setup_status,
                  provider: audioConnection.provider,
                  route_note: audioConnection.route_note,
                  auth_kind: audioConnection.auth_kind,
                  connection_contract_digest: audioConnection.contract_digest
                }
              : {})
          }
        : {}),
      kind: audioAdapter.kind,
      class: audioAdapter.class,
      outputs: [
        ...(project.audio.bgm ? [`bgm:${project.audio.bgm.id}`] : []),
        ...project.audio.sfx.map((request) => `sfx:${request.id}`)
      ],
      dry_run_estimate_available: audioAdapter.dry_run_estimate,
      batch: audioAdapter.batch,
      execution: audioConnection
        ? audioConnection.transport === "cli" && audioAdapter.kind === "cli"
          ? "pipeline-cli"
          : "agent-handoff"
        : audioAdapter.kind === "cli" ? "pipeline-cli" : "agent-handoff"
    });
  }

  if (project.analysis && analysisAdapter) {
    const available = Array.isArray(analysisAdapter) ? analysisAdapter : [analysisAdapter];
    const byName = new Map(available.map((definition) => [definition.name, definition]));
    const adapterNames = uniqueInOrder(
      project.analysis.requests.map((request) => request.adapter ?? project.analysis!.adapter)
    );
    for (const adapterName of adapterNames) {
      const definition = byName.get(adapterName);
      if (!definition) continue;
      const outputs = uniqueInOrder(
        project.analysis.requests
          .filter((request) => (request.adapter ?? project.analysis!.adapter) === adapterName)
          .map((request) => request.output)
      );
      handoffs.push({
        phase: "analysis",
        adapter: definition.name,
        kind: definition.kind,
        class: definition.class,
        outputs,
        dry_run_estimate_available: definition.dry_run_estimate,
        batch: definition.batch,
        execution: definition.kind === "cli" ? "pipeline-cli" : "agent-handoff"
      });
    }
  }

  return handoffs;
}

function uniqueInOrder<T>(values: T[]): T[] {
  return [...new Set(values)];
}
