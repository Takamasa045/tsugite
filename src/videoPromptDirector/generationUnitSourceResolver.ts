import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { GenerationRequest, Project } from "../project/schema.js";
import {
  generationUnitProgramSourceSchema,
  type GenerationUnitProgramSourceV1
} from "../productionControl/programBinding.js";
import type { GenerationUnitSourceResolver } from "./videoPromptCompile.js";

const DEFAULT_SOURCE_DIR = "production-control/generation-units";

/** Resolve T03's typed source from the project-local, non-authoring store. */
export function createProjectGenerationUnitSourceResolver(configPath: string): GenerationUnitSourceResolver {
  const projectRoot = dirname(resolve(configPath));
  return async ({ project, request }: { project: Project; request: GenerationRequest }) => {
    const configured = (project as unknown as { production_control?: { generation_unit_sources_dir?: unknown } })
      .production_control?.generation_unit_sources_dir;
    const sourceDir = configured === undefined ? DEFAULT_SOURCE_DIR : configured;
    if (typeof sourceDir !== "string" || !isSafeProjectRelative(sourceDir) || !isSafeId(request.id)) return undefined;

    try {
      const root = await realpath(projectRoot);
      const directory = await realpath(join(root, sourceDir));
      if (!isContained(root, directory)) return undefined;
      const candidate = await realpath(join(directory, `${request.id}.json`));
      if (!isContained(directory, candidate)) return undefined;
      const metadata = await stat(candidate);
      if (!metadata.isFile()) return undefined;
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as unknown;
      const source = generationUnitProgramSourceSchema.safeParse(parsed);
      return source.success ? (source.data as GenerationUnitProgramSourceV1) : undefined;
    } catch {
      return undefined;
    }
  };
}

function isSafeProjectRelative(value: string): boolean {
  return value.length > 0
    && !isAbsolute(value)
    && !value.includes("\\")
    && !value.includes("\0")
    && !value.split("/").includes("..");
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function isContained(root: string, candidate: string): boolean {
  const descendant = relative(root, candidate);
  return descendant === ""
    || (!isAbsolute(descendant) && descendant !== ".." && !descendant.startsWith(".." + "/"));
}
