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
import {
  resolveConnectionsByAdapter,
  resolveGenerationConnection,
  type GenerationConnectionResolution
} from "../connections/registry.js";
import { loadProject } from "./loadProject.js";
import { generationRequestCapability, type AnalysisRequest, type Project } from "./schema.js";
import { projectAssetRoot, validateGenerationAssets } from "./generationAssets.js";

export type ValidateProjectOptions = {
  adapterDirs?: string[];
  backendDirs?: string[];
  connectionCatalogPath?: string;
  promptGuideDirs?: string[];
};

export async function validateProject(
  configPath: string,
  options: ValidateProjectOptions = {}
): Promise<
  Result<{
    project: Project;
    manifest: Manifest;
    adapter?: AdapterDefinition;
    audioAdapter?: AdapterDefinition;
    analysisAdapter?: AdapterDefinition;
    analysisAdapters?: AdapterDefinition[];
    backend?: BackendCapabilities;
    promptGuides: PromptGuide[];
    generationConnection?: GenerationConnectionResolution;
    audioConnection?: GenerationConnectionResolution;
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
  issues.push(...(await validateGenerationAssets(project, configDir, projectRoot)).issues);
  const manifestInput = await readManifest(manifestPath);
  if (!manifestInput.ok) {
    return { ok: false, issues: [...issues, ...manifestInput.issues], project };
  }

  const manifestResult = validateManifest(manifestInput.input);
  issues.push(...manifestResult.issues);
  if (manifestResult.manifest) {
    issues.push(...validateCompositionBrief(project, manifestResult.manifest));
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
  let generationConnection: GenerationConnectionResolution | undefined;
  let audioAdapter: AdapterDefinition | undefined;
  let audioConnection: GenerationConnectionResolution | undefined;
  let analysisAdapter: AdapterDefinition | undefined;
  let analysisAdapters: AdapterDefinition[] | undefined;
  let promptGuides: PromptGuide[] = [];
  try {
    if (project.generation) {
      let adapterName = project.generation.adapter;
      const requestedConnection = project.generation.connection;
      if (project.generation.requests.length > 0 && !requestedConnection && !adapterName) {
        issues.push({
          code: "generation.connection_required",
          message: "どのサービスを使って生成しますか？ `pipeline connections --json` で利用可能な候補を確認してください。",
          path: "generation.connection"
        });
      } else if (requestedConnection) {
        const declaredConnection = await resolveGenerationConnection(requestedConnection, options.connectionCatalogPath);
        if (!declaredConnection) {
          issues.push({
            code: "generation.connection_unavailable",
            message: `connection '${requestedConnection}' is not integrated for generation`,
            path: "generation.connection"
          });
          adapterName = undefined;
        } else if (adapterName && adapterName !== declaredConnection.adapter) {
          issues.push({
            code: "generation.connection_adapter_mismatch",
            message: `connection '${declaredConnection.id}' uses adapter '${declaredConnection.adapter}', not '${adapterName}'`,
            path: "generation.adapter"
          });
          adapterName = undefined;
        } else {
          const connection = await resolveGenerationConnection(
            requestedConnection,
            options.connectionCatalogPath,
            generationConnectionRequirements(project)
          );
          if (!connection) {
            issues.push({
              code: "generation.connection_incompatible",
              message: `connection '${declaredConnection.id}' does not support every requested model and input mode`,
              path: "generation.requests"
            });
            adapterName = undefined;
          } else {
            generationConnection = connection;
            adapterName = connection.adapter;
            project = {
              ...project,
              generation: {
                ...project.generation,
                connection: connection.id,
                adapter: connection.adapter
              }
            };
          }
        }
      } else if (adapterName) {
        const declaredConnections = await resolveConnectionsByAdapter(
          adapterName,
          {},
          options.connectionCatalogPath
        );
        if (declaredConnections.length > 0 && project.generation.requests.length > 0) {
          const candidateIds = declaredConnections.map((connection) => `'${connection.id}'`).join(", ");
          issues.push({
            code: "generation.connection_required",
            message: declaredConnections.length === 1
              ? `どのサービスを使って生成しますか？ 候補 ${candidateIds} を generation.connection に明示してください。`
              : `どのサービスを使って生成しますか？ 候補 ${candidateIds} から generation.connection を明示してください。`,
            path: "generation.connection"
          });
          adapterName = undefined;
        } else if (project.generation.requests.length > 0) {
          const declaredAdapter = await loadAdapterDefinition(adapterName, options.adapterDirs);
          if (declaredAdapter.connection_requirement !== "local-only") {
            issues.push({
              code: "generation.connection_required",
              message: "どのサービスを使って生成しますか？ 未登録の外部adapterはconnectionレジストリへ追加してから generation.connection を明示してください。",
              path: "generation.connection"
            });
            adapterName = undefined;
          }
        }
      }
      if (adapterName) {
        adapter = await loadAdapterDefinition(adapterName, options.adapterDirs);
        if (adapter.class !== "generation") {
          issues.push({
            code: "adapter.class_mismatch",
            message: `adapter '${adapterName}' cannot be used for generation requests`
          });
        } else if (!adapter.dry_run_estimate) {
          issues.push({
            code: "adapter.dry_run_unsupported",
            message: `adapter '${adapterName}' cannot provide dry-run estimates`
          });
        }
      }
    }
    if (project.audio) {
      let audioAdapterName = project.audio.adapter;
      const requestedConnection = project.audio.connection;
      const requirements = audioConnectionRequirements(project);
      if (!requestedConnection && !audioAdapterName) {
        issues.push({
          code: "audio.connection_required",
          message: "どのサービスを使って生成しますか？ `pipeline connections --json` で利用可能な候補を確認してください。",
          path: "audio.connection"
        });
      } else if (requestedConnection) {
        const declaredConnection = await resolveGenerationConnection(
          requestedConnection,
          options.connectionCatalogPath
        );
        if (!declaredConnection) {
          issues.push({
            code: "audio.connection_unavailable",
            message: `connection '${requestedConnection}' is not integrated for audio generation`,
            path: "audio.connection"
          });
          audioAdapterName = undefined;
        } else if (audioAdapterName && audioAdapterName !== declaredConnection.adapter) {
          issues.push({
            code: "audio.connection_adapter_mismatch",
            message: `connection '${declaredConnection.id}' uses adapter '${declaredConnection.adapter}', not '${audioAdapterName}'`,
            path: "audio.adapter"
          });
          audioAdapterName = undefined;
        } else {
          const connection = await resolveGenerationConnection(
            requestedConnection,
            options.connectionCatalogPath,
            requirements
          );
          if (!connection) {
            issues.push({
              code: "audio.connection_incompatible",
              message: `connection '${declaredConnection.id}' does not support every requested audio capability`,
              path: "audio"
            });
            audioAdapterName = undefined;
          } else {
            const connectionAdapter = await loadAdapterDefinition(connection.adapter, options.adapterDirs);
            if (connectionAdapter.class !== "audio") {
              issues.push({
                code: "audio.connection_incompatible",
                message: `connection '${connection.id}' exposes audio through generation.requests, not the legacy audio block`,
                path: "audio"
              });
              audioAdapterName = undefined;
            } else {
              audioConnection = connection;
              audioAdapterName = connection.adapter;
              project = {
                ...project,
                audio: {
                  ...project.audio,
                  connection: connection.id,
                  adapter: connection.adapter
                }
              };
            }
          }
        }
      } else if (audioAdapterName) {
        const declaredConnections = await resolveConnectionsByAdapter(
          audioAdapterName,
          {},
          options.connectionCatalogPath
        );
        if (declaredConnections.length > 0) {
          const candidateIds = declaredConnections.map((connection) => `'${connection.id}'`).join(", ");
          issues.push({
            code: "audio.connection_required",
            message: declaredConnections.length === 1
              ? `どのサービスを使って生成しますか？ 候補 ${candidateIds} を audio.connection に明示してください。`
              : `どのサービスを使って生成しますか？ 候補 ${candidateIds} から audio.connection を明示してください。`,
            path: "audio.connection"
          });
          audioAdapterName = undefined;
        } else {
          const declaredAdapter = await loadAdapterDefinition(audioAdapterName, options.adapterDirs);
          if (declaredAdapter.connection_requirement !== "local-only") {
            issues.push({
              code: "audio.connection_required",
              message: "どのサービスを使って生成しますか？ 未登録の外部adapterはconnectionレジストリへ追加してから audio.connection を明示してください。",
              path: "audio.connection"
            });
            audioAdapterName = undefined;
          }
        }
      }
      if (!audioAdapterName) {
        audioAdapter = undefined;
      } else {
      const audioRequest = project.audio!;
      audioAdapter = await loadAdapterDefinition(audioAdapterName, options.adapterDirs);
      if (audioAdapter.class !== "audio") {
        issues.push({
          code: "adapter.class_mismatch",
          message: `adapter '${audioAdapterName}' cannot be used for audio requests`,
          path: "audio.adapter"
        });
      } else if (audioAdapter.kind !== "cli") {
        issues.push({
          code: "adapter.kind_mismatch",
          message: `audio adapter '${audioAdapterName}' must be an executable cli adapter`,
          path: "audio.adapter"
        });
      } else if (!audioAdapter.dry_run_estimate) {
        issues.push({
          code: "adapter.dry_run_unsupported",
          message: `audio adapter '${audioAdapterName}' cannot provide dry-run estimates`,
          path: "audio.adapter"
        });
      } else {
        const capabilities = audioAdapter.audio_capabilities;
        if (audioRequest.bgm && !capabilities?.bgm_modes.includes(audioRequest.bgm.mode)) {
          issues.push({
            code: "audio.bgm_mode_unsupported",
            message: `audio adapter '${audioAdapterName}' does not support BGM mode '${audioRequest.bgm.mode}'`,
            path: "audio.bgm.mode"
          });
        }
        if (audioRequest.sfx.length > 0 && !capabilities?.sfx) {
          issues.push({
            code: "audio.sfx_unsupported",
            message: `audio adapter '${audioAdapterName}' does not support SFX`,
            path: "audio.sfx"
          });
        }
      }
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
    if (project.generation?.adapter && adapter?.class === "generation") {
      issues.push(...(await validateGenerationConstraints(project, options.adapterDirs)).issues);
    }
    promptGuides = await loadProjectPromptGuides(project, options.promptGuideDirs);
  } catch (error) {
    issues.push(...issuesFromError(error));
  }

  if (issues.length > 0 || !manifestResult.manifest) {
    return { ok: false, issues, project, manifest: manifestResult.manifest, adapter, audioAdapter, analysisAdapter, analysisAdapters, backend, promptGuides, generationConnection, audioConnection };
  }

  return { ok: true, issues: [], project, manifest: manifestResult.manifest, adapter, audioAdapter, analysisAdapter, analysisAdapters, backend, promptGuides, generationConnection, audioConnection };
}

function generationConnectionRequirements(project: Project): {
  models: string[];
  capabilities: string[];
} {
  const requests = project.generation?.requests ?? [];
  return {
    models: uniqueInOrder(requests.flatMap((request) => request.model ? [request.model] : [])),
    capabilities: uniqueInOrder(requests.map(generationRequestCapability))
  };
}

function audioConnectionRequirements(project: Project): { capabilities: string[] } {
  if (!project.audio) return { capabilities: [] };
  return {
    capabilities: [
      ...(project.audio.bgm ? ["audio.music"] : []),
      ...(project.audio.sfx.length > 0 ? ["audio.sound-effects"] : [])
    ]
  };
}

function validateCompositionBrief(project: Project, manifest: Manifest): Issue[] {
  if (!project.composition) return [];

  const issues: Issue[] = [];
  const clipCounts = new Map<string, number>();
  for (const [index, clip] of manifest.clips.entries()) {
    if (clipCounts.has(clip.id)) {
      issues.push({
        code: "composition.clip_id_duplicate",
        message: `composition source clip id '${clip.id}' must be unique`,
        path: `clips.${index}.id`
      });
    }
    clipCounts.set(clip.id, (clipCounts.get(clip.id) ?? 0) + 1);
  }

  const required = project.composition.brief.required_clip_ids;
  const excluded = project.composition.brief.excluded_clip_ids;
  const requiredSet = new Set<string>();
  const excludedSet = new Set<string>();

  validateCompositionClipList("required", required, requiredSet, clipCounts, issues);
  validateCompositionClipList("excluded", excluded, excludedSet, clipCounts, issues);

  for (const [index, clipId] of excluded.entries()) {
    if (!requiredSet.has(clipId)) continue;
    issues.push({
      code: "composition.clip_conflict",
      message: `composition clip '${clipId}' cannot be both required and excluded`,
      path: `composition.brief.excluded_clip_ids.${index}`
    });
  }

  return issues;
}

function validateCompositionClipList(
  kind: "required" | "excluded",
  clipIds: string[],
  seen: Set<string>,
  clipCounts: Map<string, number>,
  issues: Issue[]
): void {
  for (const [index, clipId] of clipIds.entries()) {
    const path = `composition.brief.${kind}_clip_ids.${index}`;
    if (seen.has(clipId)) {
      issues.push({
        code: `composition.${kind}_clip_duplicate`,
        message: `composition ${kind} clip '${clipId}' is duplicated`,
        path
      });
    }
    seen.add(clipId);

    const count = clipCounts.get(clipId) ?? 0;
    if (count === 0) {
      issues.push({
        code: "composition.clip_not_found",
        message: `composition ${kind} clip '${clipId}' was not found`,
        path
      });
    } else if (count > 1) {
      issues.push({
        code: "composition.clip_ambiguous",
        message: `composition ${kind} clip '${clipId}' is not unique`,
        path
      });
    }
  }
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
    const allowsCrossSourceDependencies = request.output === "similarity_groups"
      && request.depends_on.every((dependencyId) => requests.get(dependencyId)?.output === "scene_observations");
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
      if (
        !allowsCrossSourceDependencies
        && effectiveSourceClipId(request, manifest) !== effectiveSourceClipId(dependency, manifest)
      ) {
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
