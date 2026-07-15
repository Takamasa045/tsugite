import { dirname, isAbsolute, resolve } from "node:path";
import { loadAdapterDefinition, type AdapterDefinition } from "../adapters/registry.js";
import {
  loadProjectPromptGuides,
  type PromptGuide
} from "../adapters/promptKnowledge.js";
import { readJsonFile } from "../io.js";
import { validateGenerationConstraints } from "../adapters/constraints.js";
import {
  loadBackendCapabilities,
  validateBackendCapabilities,
  type BackendCapabilities
} from "../backends/capabilities.js";
import { validateManifestAssets } from "../manifest/assets.js";
import { validateManifest } from "../manifest/validate.js";
import type { Manifest } from "../manifest/schema.js";
import type { Issue, Result } from "../types.js";
import { PipelineError } from "../types.js";
import { loadProject } from "./loadProject.js";
import type { AnalysisRequest, Project } from "./schema.js";

type ValidateOptions = {
  adapterDirs?: string[];
  backendDirs?: string[];
  promptGuideDirs?: string[];
};

export async function validateProject(
  configPath: string,
  options: ValidateOptions = {}
): Promise<
  Result<{
    project: Project;
    manifest: Manifest;
    adapter?: AdapterDefinition;
    analysisAdapter?: AdapterDefinition;
    analysisAdapters?: AdapterDefinition[];
    backend?: BackendCapabilities;
    promptGuides: PromptGuide[];
  }>
> {
  const issues: Issue[] = [];
  let project: Project;

  try {
    project = await loadProject(configPath);
  } catch (error) {
    return { ok: false, issues: issuesFromError(error) };
  }

  const configDir = dirname(resolve(configPath));
  const manifestPath = resolveFrom(configDir, project.manifest);
  const manifestDir = dirname(manifestPath);
  const projectRoot = projectAssetRoot(configDir, project.manifest);
  const manifestInput = await readManifest(manifestPath);
  if (!manifestInput.ok) {
    return { ok: false, issues: manifestInput.issues, project };
  }

  const manifestResult = validateManifest(manifestInput.input);
  issues.push(...manifestResult.issues);
  if (manifestResult.manifest) {
    issues.push(
      ...(await validateManifestAssets(manifestResult.manifest, manifestDir, {
        assetRoot: projectRoot
      })).issues
    );
  }

  let backend;
  let backendLoadFailed = false;
  try {
    backend = await loadBackendCapabilities(project.edit.backend, options.backendDirs);
  } catch (error) {
    backendLoadFailed = true;
    issues.push(...issuesFromError(error));
  }
  if (!backend && !backendLoadFailed) {
    issues.push({
      code: "backend.not_found",
      message: `backend '${project.edit.backend}' was not found`
    });
  } else if (backend && manifestResult.manifest) {
    issues.push(...validateBackendCapabilities(manifestResult.manifest, backend).issues);
    if (project.edit.editorial?.captions && !backend.capabilities.captions) {
      issues.push({
        code: "backend.capability.captions",
        message: "editorial output requires captions, but backend does not support captions",
        path: "edit.editorial.captions"
      });
    }
  }

  let adapter: AdapterDefinition | undefined;
  let analysisAdapter: AdapterDefinition | undefined;
  let analysisAdapters: AdapterDefinition[] | undefined;
  let promptGuides: PromptGuide[] = [];
  try {
    if (project.generation) {
      adapter = await loadAdapterDefinition(project.generation.adapter, options.adapterDirs);
      if (adapter.class !== "generation") {
        issues.push({
          code: "adapter.class_mismatch",
          message: `adapter '${project.generation.adapter}' cannot be used for generation requests`
        });
      } else if (!adapter.dry_run_estimate) {
        issues.push({
          code: "adapter.dry_run_unsupported",
          message: `adapter '${project.generation.adapter}' cannot provide dry-run estimates`
        });
      }
    }
    if (project.analysis) {
      analysisAdapter = await loadAdapterDefinition(project.analysis.adapter, options.adapterDirs);
      if (analysisAdapter.class !== "analysis") {
        issues.push({
          code: "adapter.class_mismatch",
          message: `adapter '${project.analysis.adapter}' cannot be used for analysis requests`
        });
      }

      const loadedByName = new Map<string, AdapterDefinition>([
        [analysisAdapter.name, analysisAdapter]
      ]);
      const selectedNames = uniqueInOrder(
        project.analysis.requests.map((request) => request.adapter ?? project.analysis!.adapter)
      );
      analysisAdapters = [];
      for (const name of selectedNames) {
        let selected = loadedByName.get(name);
        if (!selected) {
          selected = await loadAdapterDefinition(name, options.adapterDirs);
          loadedByName.set(name, selected);
        }
        analysisAdapters.push(selected);
      }

      for (const request of project.analysis.requests) {
        const selectedName = request.adapter ?? project.analysis.adapter;
        const selected = loadedByName.get(selectedName);
        if (!selected) continue;
        issues.push(...validateAnalysisRequestAdapter(project, request, selected, loadedByName, manifestResult.manifest));
      }
      if (manifestResult.manifest) {
        issues.push(...validateAnalysisDependencies(project, manifestResult.manifest, loadedByName));
      }
    }
    issues.push(...(await validateGenerationConstraints(project, options.adapterDirs)).issues);
    promptGuides = await loadProjectPromptGuides(project, options.promptGuideDirs);
  } catch (error) {
    issues.push(...issuesFromError(error));
  }

  if (issues.length > 0 || !manifestResult.manifest) {
    return { ok: false, issues, project, manifest: manifestResult.manifest, adapter, analysisAdapter, analysisAdapters, backend, promptGuides };
  }

  return { ok: true, issues: [], project, manifest: manifestResult.manifest, adapter, analysisAdapter, analysisAdapters, backend, promptGuides };
}

function validateAnalysisRequestAdapter(
  project: Project,
  request: AnalysisRequest,
  adapter: AdapterDefinition,
  adapters: Map<string, AdapterDefinition>,
  manifest?: Manifest
): Issue[] {
  const path = `analysis.requests.${request.id}`;
  if (adapter.class !== "analysis") {
    return [{
      code: "adapter.class_mismatch",
      message: `adapter '${adapter.name}' cannot be used for analysis requests`,
      path: `${path}.adapter`
    }];
  }
  if (adapter.kind !== "cli") return [];

  const issues: Issue[] = [];
  const mode = project.analysis?.mode ?? "local";
  if (adapter.offline === false && mode === "local") {
    issues.push({
      code: "analysis.offline_contract_required",
      message: `local analysis adapter '${adapter.name}' must declare offline: true`,
      path: `${path}.adapter`
    });
    issues.push({
      code: "analysis.online_adapter_forbidden",
      message: `analysis mode 'local' cannot use online adapter '${adapter.name}'`,
      path: `${path}.adapter`
    });
  }
  if (adapter.offline === undefined) {
    issues.push({
      code: "analysis.offline_contract_required",
      message: `cli analysis adapter '${adapter.name}' must explicitly declare offline`,
      path: `${path}.adapter`
    });
  }
  if (adapter.offline === false && !adapter.network) {
    issues.push({
      code: "analysis.network_contract_required",
      message: `online analysis adapter '${adapter.name}' must declare its network input scope`,
      path: `${path}.adapter`
    });
  }
  if (adapter.offline === false && mode === "hybrid") {
    if (adapter.network?.input_scope !== "low-confidence-segments") {
      issues.push({
        code: "analysis.hybrid_scope_invalid",
        message: "hybrid analysis can send only low-confidence transcript segments",
        path: `${path}.adapter`
      });
    }
    if (request.output !== "transcript") {
      issues.push({
        code: "analysis.hybrid_output_invalid",
        message: "hybrid online refinement must produce a transcript",
        path: `${path}.output`
      });
    }
    const dependencies = request.depends_on
      .map((id) => project.analysis?.requests.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is AnalysisRequest => Boolean(candidate));
    const hasOfflineTranscript = dependencies.some((dependency) => {
      const selectedName = dependency.adapter ?? project.analysis!.adapter;
      return dependency.output === "transcript" && adapters.get(selectedName)?.offline === true;
    });
    if (!hasOfflineTranscript) {
      issues.push({
        code: "analysis.hybrid_transcript_dependency_required",
        message: "hybrid online refinement must depend on an offline transcript request",
        path: `${path}.depends_on`
      });
    }
  }
  if (!adapter.outputs) {
    issues.push({
      code: "analysis.outputs_contract_required",
      message: `cli analysis adapter '${adapter.name}' must declare supported outputs`,
      path: `${path}.adapter`
    });
  } else if (!adapter.outputs.includes(request.output)) {
    issues.push({
      code: "analysis.output_unsupported",
      message: `analysis adapter '${adapter.name}' does not support '${request.output}'`,
      path: `${path}.output`
    });
  }
  if (manifest) issues.push(...validateAnalysisSource(request, manifest));
  return issues;
}

function validateAnalysisSource(
  request: AnalysisRequest,
  manifest: Manifest
): Issue[] {
  const path = `analysis.requests.${request.id}.source_clip_id`;
  if (!request.source_clip_id && manifest.clips.length !== 1) {
    return [{
      code: "analysis.source_clip_required",
      message: "source_clip_id is required when the manifest has multiple clips",
      path
    }];
  }
  const matchingClips = request.source_clip_id
    ? manifest.clips.filter((clip) => clip.id === request.source_clip_id)
    : [];
  if (request.source_clip_id && matchingClips.length === 0) {
    return [{
      code: "analysis.source_clip_not_found",
      message: `analysis source clip '${request.source_clip_id}' was not found`,
      path
    }];
  }
  if (matchingClips.length > 1) {
    return [{
      code: "analysis.source_clip_ambiguous",
      message: `analysis source clip '${request.source_clip_id}' is not unique`,
      path
    }];
  }
  return [];
}

function validateAnalysisDependencies(
  project: Project,
  manifest: Manifest,
  adapters: Map<string, AdapterDefinition>
): Issue[] {
  if (!project.analysis) return [];
  const requests = new Map(project.analysis.requests.map((request) => [request.id, request]));
  const issues: Issue[] = [];

  for (const request of project.analysis.requests) {
    for (const dependencyId of request.depends_on) {
      const dependency = requests.get(dependencyId);
      const path = `analysis.requests.${request.id}.depends_on`;
      if (!dependency) {
        issues.push({
          code: "analysis.dependency_not_found",
          message: `analysis dependency '${dependencyId}' was not found`,
          path
        });
        continue;
      }
      const requestAdapterName = request.adapter ?? project.analysis.adapter;
      const dependencyAdapterName = dependency.adapter ?? project.analysis.adapter;
      const crossesAdapters = requestAdapterName !== dependencyAdapterName;
      if (crossesAdapters && project.analysis.mode === "local") {
        issues.push({
          code: "analysis.dependency_adapter_mismatch",
          message: "local analysis dependencies must use the same adapter",
          path
        });
      }
      if (crossesAdapters && !adapters.has(requestAdapterName)) {
        issues.push({
          code: "analysis.dependency_adapter_not_loaded",
          message: `analysis adapter '${requestAdapterName}' is not loaded`,
          path
        });
      }
      if (effectiveSourceClipId(request, manifest) !== effectiveSourceClipId(dependency, manifest)) {
        issues.push({
          code: "analysis.dependency_source_mismatch",
          message: "analysis dependencies must use the same source clip",
          path
        });
      }
    }
  }

  if (hasAnalysisDependencyCycle(project.analysis.requests)) {
    issues.push({
      code: "analysis.dependency_cycle",
      message: "analysis dependencies must not contain a cycle",
      path: "analysis.requests"
    });
  }
  return issues;
}

function effectiveSourceClipId(
  request: AnalysisRequest,
  manifest: Manifest
): string | undefined {
  return request.source_clip_id ?? (manifest.clips.length === 1 ? manifest.clips[0]?.id : undefined);
}

function hasAnalysisDependencyCycle(
  requests: AnalysisRequest[]
): boolean {
  const dependencies = new Map(requests.map((request) => [request.id, request.depends_on]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const cyclic = (dependencies.get(id) ?? []).some((dependency) => dependencies.has(dependency) && visit(dependency));
    visiting.delete(id);
    visited.add(id);
    return cyclic;
  };
  return requests.some((request) => visit(request.id));
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)];
}

function issuesFromError(error: unknown): Issue[] {
  if (error instanceof PipelineError) return error.issues;
  return [
    {
      code: "pipeline.error",
      message: error instanceof Error ? error.message : String(error)
    }
  ];
}

async function readManifest(path: string): Promise<Result<{ input: unknown }>> {
  try {
    return { ok: true, issues: [], input: await readJsonFile(path) };
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: "manifest.read_failed",
          message: error instanceof Error ? error.message : String(error),
          path
        }
      ]
    };
  }
}

function resolveFrom(baseDir: string, candidate: string): string {
  return isAbsolute(candidate) ? candidate : resolve(baseDir, candidate);
}

function projectAssetRoot(configDir: string, manifest: string): string {
  return manifest.startsWith("../") ? resolve(configDir, "..") : configDir;
}
