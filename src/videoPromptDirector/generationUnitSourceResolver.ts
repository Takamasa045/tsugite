import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as nativePath from "node:path";
import type { GenerationRequest, Project } from "../project/schema.js";
import {
  generationUnitProgramSourceSchema,
  type GenerationUnitProgramSourceV1
} from "../productionControl/programBinding.js";
import type { GenerationUnitSourceResolver } from "./videoPromptCompile.js";

const DEFAULT_SOURCE_DIR = "production-control/generation-units";

/**
 * Separator-aware containment used by the source resolver and its Windows
 * adversarial tests. `pathApi` is injectable only for platform tests; the
 * production default is the host-native `node:path` implementation.
 */
export function isGenerationUnitPathContained(
  root: string,
  candidate: string,
  pathApi: Pick<typeof nativePath, "resolve" | "relative" | "isAbsolute" | "sep"> = nativePath
): boolean {
  const resolvedRoot = pathApi.resolve(root);
  const resolvedCandidate = pathApi.resolve(candidate);
  const descendant = pathApi.relative(resolvedRoot, resolvedCandidate);
  return descendant === ""
    || (!pathApi.isAbsolute(descendant)
      && descendant !== ".."
      && !descendant.startsWith(`..${pathApi.sep}`));
}

/** Resolve T03's typed source from the project-local, non-authoring store. */
export function createProjectGenerationUnitSourceResolver(configPath: string): GenerationUnitSourceResolver {
  const projectRoot = dirname(resolve(configPath));
  return async ({ project, request }: { project: Project; request: GenerationRequest }) => {
    const configured = (project as unknown as { production_control?: { generation_unit_sources_dir?: unknown } })
      .production_control?.generation_unit_sources_dir;
    const sourceDir = configured === undefined ? DEFAULT_SOURCE_DIR : configured;
    if (typeof sourceDir !== "string" || !isSafeProjectRelative(sourceDir) || !isSafeId(request.id)) return undefined;

    let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
    let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const root = await realpath(projectRoot);
      const lexicalDirectory = join(root, sourceDir);
      const directoryLexicalStat = await lstat(lexicalDirectory);
      // Reject symlink/junction directory entries before realpath. This also
      // prevents an outside generation-units tree from becoming canonical.
      if (directoryLexicalStat.isSymbolicLink()) return undefined;
      const directory = await realpath(lexicalDirectory);
      if (!isGenerationUnitPathContained(root, directory)) return undefined;

      directoryHandle = await open(
        lexicalDirectory,
        fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0)
      );
      const directoryStat = await directoryHandle.stat();
      if (!directoryStat.isDirectory()) return undefined;
      const directoryAgain = await realpath(lexicalDirectory);
      if (directoryAgain !== directory || !isGenerationUnitPathContained(root, directoryAgain)) return undefined;

      const lexicalCandidate = join(lexicalDirectory, `${request.id}.json`);
      const lexicalCandidateStat = await lstat(lexicalCandidate);
      if (lexicalCandidateStat.isSymbolicLink()) return undefined;
      const candidate = await realpath(lexicalCandidate);
      if (!isGenerationUnitPathContained(directory, candidate)) return undefined;

      fileHandle = await open(lexicalCandidate, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const before = await fileHandle.stat();
      if (!before.isFile()) return undefined;
      const beforePath = await realpath(lexicalCandidate);
      if (beforePath !== candidate || !isGenerationUnitPathContained(directory, beforePath)) return undefined;

      // Read from the opened descriptor, never by reopening the checked path.
      const parsed = JSON.parse(await fileHandle.readFile("utf8")) as unknown;
      const after = await fileHandle.stat();
      const directoryAfter = await directoryHandle.stat();
      const afterPath = await realpath(lexicalCandidate);
      if (!sameFileIdentity(before, after)
        || !sameFileIdentity(directoryStat, directoryAfter)
        || beforePath !== afterPath
        || !isGenerationUnitPathContained(directory, afterPath)) return undefined;
      const source = generationUnitProgramSourceSchema.safeParse(parsed);
      return source.success ? (source.data as GenerationUnitProgramSourceV1) : undefined;
    } catch {
      return undefined;
    } finally {
      await fileHandle?.close().catch(() => undefined);
      await directoryHandle?.close().catch(() => undefined);
    }
  };
}

function isSafeProjectRelative(value: string): boolean {
  return value.length > 0
    && !isAbsolute(value)
    && !nativePath.win32.isAbsolute(value)
    && !value.includes("\0")
    && !value.split(/[\\/]/u).includes("..");
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function sameFileIdentity(
  before: { dev: number; ino: number; size: number; mtimeMs: number },
  after: { dev: number; ino: number; size: number; mtimeMs: number }
): boolean {
  const stableDeviceIdentity = before.dev !== 0 && before.ino !== 0 && after.dev !== 0 && after.ino !== 0;
  return (!stableDeviceIdentity || (before.dev === after.dev && before.ino === after.ino))
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs;
}
