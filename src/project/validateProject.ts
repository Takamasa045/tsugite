import { dirname, isAbsolute, resolve } from "node:path";
import { loadAdapterDefinition, type AdapterDefinition } from "../adapters/registry.js";
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
import type { Project } from "./schema.js";

type ValidateOptions = {
  adapterDirs?: string[];
  backendDirs?: string[];
};

export async function validateProject(
  configPath: string,
  options: ValidateOptions = {}
): Promise<Result<{ project: Project; manifest: Manifest; adapter?: AdapterDefinition; backend?: BackendCapabilities }>> {
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
  }

  let adapter: AdapterDefinition | undefined;
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
    issues.push(...(await validateGenerationConstraints(project, options.adapterDirs)).issues);
  } catch (error) {
    issues.push(...issuesFromError(error));
  }

  if (issues.length > 0 || !manifestResult.manifest) {
    return { ok: false, issues, project, manifest: manifestResult.manifest, adapter, backend };
  }

  return { ok: true, issues: [], project, manifest: manifestResult.manifest, adapter, backend };
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
