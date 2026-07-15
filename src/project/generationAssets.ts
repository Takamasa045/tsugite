import { copyFile, lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Issue, Result } from "../types.js";
import type { GenerationRequest, Project } from "./schema.js";

export async function validateGenerationAssets(
  project: Project,
  configDir: string,
  assetRoot: string
): Promise<Result<{}>> {
  const issues: Issue[] = [];
  for (const [index, request] of project.generation?.requests.entries() ?? []) {
    if (!request.first_frame) continue;
    const result = await resolveGenerationAsset(
      request.first_frame,
      configDir,
      assetRoot,
      `generation.requests.${index}.first_frame`,
      "generation.first_frame"
    );
    if (!result.ok) issues.push(...result.issues);
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, issues: [] };
}

export async function pinGenerationAssets(
  requests: GenerationRequest[],
  configDir: string,
  assetRoot: string,
  runDir: string
): Promise<Result<{ requests: GenerationRequest[]; manifestPaths: Map<string, string> }>> {
  const prepared: GenerationRequest[] = [];
  const manifestPaths = new Map<string, string>();

  for (const [index, request] of requests.entries()) {
    if (!request.first_frame) {
      prepared.push(request);
      continue;
    }
    const resolved = await resolveGenerationAsset(
      request.first_frame,
      configDir,
      assetRoot,
      `generation.requests.${index}.first_frame`,
      "generation.first_frame"
    );
    if (!resolved.ok) return resolved;

    const relativePath = join(
      "assets",
      "generation-inputs",
      request.id,
      `001-first-frame${extension(request.first_frame)}`
    );
    const target = join(runDir, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolved.path, target);
    prepared.push({ ...request, first_frame: target });
    manifestPaths.set(request.id, relativePath);
  }

  return { ok: true, issues: [], requests: prepared, manifestPaths };
}

export function projectAssetRoot(configDir: string, manifest: string): string {
  return manifest.startsWith("../") ? resolve(configDir, "..") : configDir;
}

async function resolveGenerationAsset(
  source: string,
  baseDir: string,
  assetRoot: string,
  path: string,
  codePrefix: string
): Promise<Result<{ path: string }>> {
  if (isAbsolute(source) || source.includes("\\")) {
    return failure(`${codePrefix}.safe`, "generation asset must be a relative local path", path);
  }

  const root = resolve(assetRoot);
  const candidate = resolve(baseDir, source);
  if (!isWithin(root, candidate)) {
    return failure(`${codePrefix}.safe`, "generation asset must stay within the project asset root", path);
  }

  const symlink = await containsSymlink(root, candidate);
  if (symlink) {
    return failure(`${codePrefix}.symlink`, "generation asset paths must not contain symbolic links", path);
  }

  try {
    const inspected = await lstat(candidate);
    if (!inspected.isFile()) {
      return failure(`${codePrefix}.exists`, "generation asset must point to an existing regular file", path);
    }
    const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
    if (!isWithin(realRoot, realCandidate)) {
      return failure(`${codePrefix}.safe`, "generation asset must stay within the project asset root", path);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return failure(`${codePrefix}.exists`, "generation asset must point to an existing regular file", path);
    }
    return failure(`${codePrefix}.safe`, "generation asset could not be resolved safely", path);
  }

  return { ok: true, issues: [], path: candidate };
}

async function containsSymlink(root: string, candidate: string): Promise<boolean> {
  const fromRoot = relative(root, candidate);
  let current = root;
  for (const part of fromRoot.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return false;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function extension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}

function failure(code: string, message: string, path: string): { ok: false; issues: Issue[] } {
  return { ok: false, issues: [{ code, message, path }] };
}
