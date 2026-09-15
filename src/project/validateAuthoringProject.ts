import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { z } from "zod";
import { authoringEngineRunSchema, type AuthoringEngineRun } from "../productionControl/authoringEngine.js";
import type { Issue } from "../types.js";
import { isAuthoringProduction, type AuthoringProduction, type Project } from "./schema.js";

const STATE_MAX_BYTES = 2 * 1024 * 1024;

const persistedAuthoringStateSchema = z
  .object({
    workspace: z.string().min(1).optional(),
    run: authoringEngineRunSchema
  })
  .passthrough();

export type ValidateAuthoringProjectOptions = {
  isAdapterRegistered?: (adapterId: string) => boolean | Promise<boolean>;
};

export type ValidateAuthoringProjectResult = {
  issues: Issue[];
  run?: AuthoringEngineRun;
  workspaceRealPath?: string;
  stateRealPath?: string;
};

export async function validateAuthoringProject(
  configPath: string,
  project: Project,
  options: ValidateAuthoringProjectOptions = {}
): Promise<ValidateAuthoringProjectResult> {
  if (!isAuthoringProduction(project)) {
    return {
      issues: [{
        code: "authoring.kind_required",
        message: "project is not an authoring production",
        path: "production.kind"
      }]
    };
  }
  const production = project.production;
  const issues: Issue[] = [];
  const projectRoot = resolve(dirname(configPath));
  let projectReal: string;
  try {
    const rootStats = await lstat(projectRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      return {
        issues: [{
          code: "authoring.project_unsafe",
          message: "project root must be a regular directory",
          path: "production"
        }]
      };
    }
    projectReal = await realpath(projectRoot);
  } catch (error) {
    return {
      issues: [{
        code: "authoring.project_unsafe",
        message: error instanceof Error ? error.message : String(error),
        path: "production"
      }]
    };
  }

  const registered = await resolveAdapterRegistered(production.adapter, options.isAdapterRegistered);
  if (!registered) {
    issues.push({
      code: "authoring.adapter_unregistered",
      message: `authoring adapter '${production.adapter}' is not a trusted registered adapter`,
      path: "production.adapter"
    });
  }

  const layout = await resolveCanonicalLayout(production.adapter);
  if (layout) {
    if (production.state !== layout.state) {
      issues.push({
        code: "authoring.layout_unsupported",
        message: "production.state is not the registered canonical authoring state path",
        path: "production.state"
      });
    }
    if (production.workspace !== layout.workspace) {
      issues.push({
        code: "authoring.layout_unsupported",
        message: "production.workspace is not the registered canonical authoring workspace path",
        path: "production.workspace"
      });
    }
    if (issues.length > 0) return { issues };
  }

  const stateResult = await readContainedRegularFile(
    projectReal,
    production.state,
    STATE_MAX_BYTES,
    "production.state"
  );
  if (!stateResult.ok) {
    issues.push(...stateResult.issues);
    return { issues };
  }

  let parsed: z.infer<typeof persistedAuthoringStateSchema>;
  try {
    parsed = persistedAuthoringStateSchema.parse(JSON.parse(stateResult.text));
  } catch (error) {
    return {
      issues: [{
        code: "authoring.state_invalid",
        message: error instanceof Error ? error.message : "authoring state is not a valid AuthoringEngineRun record",
        path: "production.state"
      }],
      stateRealPath: stateResult.realPath
    };
  }

  const expectedId = project.run_id ?? project.slug;
  if (parsed.run.production_id !== project.slug && parsed.run.production_id !== expectedId) {
    issues.push({
      code: "authoring.identity_mismatch",
      message: `authoring state production_id '${parsed.run.production_id}' does not match project '${project.slug}'`,
      path: "production.state"
    });
  }

  const workspaceResult = await realpathContainedDirectoryRelative(
    projectReal,
    production.workspace,
    "production.workspace"
  );
  if (!workspaceResult.ok) {
    issues.push(...workspaceResult.issues);
    return { issues, run: parsed.run, stateRealPath: stateResult.realPath };
  }

  if (parsed.workspace) {
    try {
      const recorded = await realpath(parsed.workspace);
      if (recorded !== workspaceResult.realPath) {
        issues.push({
          code: "authoring.workspace_identity",
          message: "persisted authoring workspace is not the project-declared workspace",
          path: "production.workspace"
        });
      }
    } catch {
      issues.push({
        code: "authoring.workspace_identity",
        message: "persisted authoring workspace path could not be resolved",
        path: "production.workspace"
      });
    }
  }

  const boundFiles = uniqueBoundFiles(parsed.run);
  for (const file of boundFiles) {
    issues.push(...await verifyBoundSourceFile(workspaceResult.realPath, file, "production.state"));
  }

  return {
    issues,
    run: parsed.run,
    workspaceRealPath: workspaceResult.realPath,
    stateRealPath: stateResult.realPath
  };
}

function uniqueBoundFiles(run: AuthoringEngineRun): Array<{ relative_path: string; sha256: string; bytes: number }> {
  const byPath = new Map<string, { relative_path: string; sha256: string; bytes: number }>();
  for (const file of run.source_files) byPath.set(file.relative_path, file);
  if (run.plan_binding) {
    for (const file of run.plan_binding.source_files) byPath.set(file.relative_path, file);
    for (const file of run.plan_binding.asset_files) byPath.set(file.relative_path, file);
  }
  return [...byPath.values()];
}

async function resolveAdapterRegistered(
  adapterId: string,
  injected?: (adapterId: string) => boolean | Promise<boolean>
): Promise<boolean> {
  if (injected) return injected(adapterId);
  const { isRegisteredAuthoringAdapter } = await loadAuthoringUiRegistry();
  return isRegisteredAuthoringAdapter(adapterId);
}

async function loadAuthoringUiRegistry(): Promise<{
  isRegisteredAuthoringAdapter: (adapterId: string) => boolean;
  getAuthoringUiLaunchSpec: (adapterId: string) => {
    canonicalLayout?: { state: string; workspace: string };
  } | undefined;
}> {
  const { pathToFileURL, fileURLToPath } = await import("node:url");
  const registryPath = join(fileURLToPath(new URL("../..", import.meta.url)), "adapters", "authoringUiRegistry.mjs");
  return await import(pathToFileURL(registryPath).href) as {
    isRegisteredAuthoringAdapter: (adapterId: string) => boolean;
    getAuthoringUiLaunchSpec: (adapterId: string) => {
      canonicalLayout?: { state: string; workspace: string };
    } | undefined;
  };
}

async function resolveCanonicalLayout(
  adapterId: string
): Promise<{ state: string; workspace: string } | undefined> {
  const { getAuthoringUiLaunchSpec } = await loadAuthoringUiRegistry();
  return getAuthoringUiLaunchSpec(adapterId)?.canonicalLayout;
}

async function verifyBoundSourceFile(
  workspaceReal: string,
  file: { relative_path: string; sha256: string; bytes: number },
  issuePath: string
): Promise<Issue[]> {
  if (!isSafeRelativePath(file.relative_path)) {
    return [{
      code: "authoring.source_path_unsafe",
      message: `authoring source '${file.relative_path}' is not a safe relative path`,
      path: issuePath
    }];
  }
  const candidate = resolve(workspaceReal, file.relative_path);
  if (!isContained(workspaceReal, candidate)) {
    return [{
      code: "authoring.path_unsafe",
      message: `authoring source '${file.relative_path}' escapes the workspace`,
      path: issuePath
    }];
  }
  try {
    const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const [fileStats, linkStats] = await Promise.all([handle.stat(), lstat(candidate)]);
      if (!fileStats.isFile() || linkStats.isSymbolicLink()) {
        return [{
          code: "authoring.source_missing",
          message: `authoring source '${file.relative_path}' must be a regular file`,
          path: issuePath
        }];
      }
      const real = await realpath(candidate);
      if (!isContained(workspaceReal, real)) {
        return [{
          code: "authoring.path_unsafe",
          message: `authoring source '${file.relative_path}' escapes the workspace`,
          path: issuePath
        }];
      }
      if (fileStats.size !== file.bytes) {
        return [{
          code: "authoring.source_identity",
          message: `authoring source '${file.relative_path}' byte size does not match the persisted record`,
          path: issuePath
        }];
      }
      const digest = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (position < fileStats.size) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead <= 0) break;
        digest.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      if (digest.digest("hex") !== file.sha256) {
        return [{
          code: "authoring.source_identity",
          message: `authoring source '${file.relative_path}' digest does not match the persisted record`,
          path: issuePath
        }];
      }
      return [];
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") {
      return [{
        code: "authoring.source_missing",
        message: `authoring source '${file.relative_path}' was not found`,
        path: issuePath
      }];
    }
    throw error;
  }
}

function isSafeRelativePath(value: string): boolean {
  return value.length > 0
    && !value.startsWith("/")
    && win32.parse(value).root.length === 0
    && !value.includes("..")
    && !value.includes("\\")
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

async function realpathContainedDirectoryRelative(
  rootReal: string,
  relativePath: string,
  issuePath: string
): Promise<{ ok: true; realPath: string } | { ok: false; issues: Issue[] }> {
  if (!isSafeRelativePath(relativePath)) {
    return {
      ok: false,
      issues: [{
        code: "authoring.path_unsafe",
        message: "path must be a safe relative path",
        path: issuePath
      }]
    };
  }
  const candidate = resolve(rootReal, relativePath);
  if (!isContained(rootReal, candidate)) {
    return {
      ok: false,
      issues: [{
        code: "authoring.path_unsafe",
        message: "path escapes the project root",
        path: issuePath
      }]
    };
  }
  try {
    const stats = await lstat(candidate);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return {
        ok: false,
        issues: [{
          code: "authoring.workspace_missing",
          message: "authoring workspace must be a regular directory",
          path: issuePath
        }]
      };
    }
    const real = await realpath(candidate);
    if (!isContained(rootReal, real)) {
      return {
        ok: false,
        issues: [{
          code: "authoring.path_unsafe",
          message: "workspace escapes the project root",
          path: issuePath
        }]
      };
    }
    return { ok: true, realPath: real };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        ok: false,
        issues: [{
          code: "authoring.workspace_missing",
          message: "authoring workspace was not found",
          path: issuePath
        }]
      };
    }
    throw error;
  }
}

async function readContainedRegularFile(
  rootReal: string,
  relativePath: string,
  maxBytes: number,
  issuePath: string
): Promise<
  | { ok: true; realPath: string; text: string; bytes: Buffer; stats: { size: number } }
  | { ok: false; issues: Issue[] }
> {
  if (!isSafeRelativePath(relativePath)) {
    return {
      ok: false,
      issues: [{
        code: "authoring.path_unsafe",
        message: "path must be a safe relative path",
        path: issuePath
      }]
    };
  }
  const candidate = resolve(rootReal, relativePath);
  if (!isContained(rootReal, candidate)) {
    return {
      ok: false,
      issues: [{
        code: "authoring.path_unsafe",
        message: "path escapes the project root",
        path: issuePath
      }]
    };
  }
  try {
    const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const [fileStats, linkStats] = await Promise.all([handle.stat(), lstat(candidate)]);
      if (!fileStats.isFile() || linkStats.isSymbolicLink()) {
        return {
          ok: false,
          issues: [{
            code: "authoring.file_missing",
            message: "path must be a regular file",
            path: issuePath
          }]
        };
      }
      if (fileStats.size > maxBytes) {
        return {
          ok: false,
          issues: [{
            code: "authoring.state_too_large",
            message: "file exceeds the authoring read limit",
            path: issuePath
          }]
        };
      }
      const real = await realpath(candidate);
      if (!isContained(rootReal, real)) {
        return {
          ok: false,
          issues: [{
            code: "authoring.path_unsafe",
            message: "path escapes the project root",
            path: issuePath
          }]
        };
      }
      const bytes = await readFile(real);
      return {
        ok: true,
        realPath: real,
        text: bytes.toString("utf8"),
        bytes,
        stats: { size: fileStats.size }
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") {
      return {
        ok: false,
        issues: [{
          code: "authoring.file_missing",
          message: code === "ELOOP" ? "path must not be a symlink" : "authoring state file was not found",
          path: issuePath
        }]
      };
    }
    throw error;
  }
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

export type { AuthoringProduction };
