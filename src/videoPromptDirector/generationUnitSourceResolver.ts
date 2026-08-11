import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as nativePath from "node:path";
import type { GenerationRequest, Project } from "../project/schema.js";
import { ArtifactStore } from "../productionControl/artifactStore.js";
import { sha256Canonical } from "../productionControl/canonical.js";
import { generationUnitContractSchema, toProgramBindingSource } from "../productionControl/contracts/generationUnit.js";
import { lyricsContractSchema, type LyricsContractV1 } from "../productionControl/contracts/lyrics.js";
import { musicStructureContractSchema } from "../productionControl/contracts/music.js";
import {
  generationUnitProgramSourceSchema,
  type GenerationUnitProgramSourceV1
} from "../productionControl/programBinding.js";
import type { LyricsSource } from "./semanticBlocks.js";
import type { GenerationUnitSourceResolver } from "./videoPromptCompile.js";

const DEFAULT_SOURCE_DIR = "production-control/generation-units";
const MAX_CONTRACT_ARTIFACT_BYTES = 16 * 1024 * 1024;
const trustedGenerationUnitSources = new WeakSet<object>();
const generationUnitSourceSnapshots = new WeakMap<object, string>();
const lyricsByGenerationUnitSource = new WeakMap<object, LyricsSource>();

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
  return async ({ project, request, ir, requestIndex }: { project: Project; request: GenerationRequest; ir: import("./schemaV2.js").VideoPromptIrV2; requestIndex: number }) => {
    if (project.orchestration?.mode === "active") {
      return resolveAuthoritativeGenerationUnit(projectRoot, project, request, ir, requestIndex);
    }
    return resolveLegacyGenerationUnitSource(projectRoot, project, request);
  };
}

/** Only this module can mark a source as derived from the full T04 artifact. */
export function isAuthoritativeGenerationUnitSource(source: GenerationUnitProgramSourceV1): boolean {
  if (!trustedGenerationUnitSources.has(source as object)) return false;
  try {
    return generationUnitSourceSnapshots.get(source as object) === sha256Canonical(source);
  } catch {
    return false;
  }
}

export function lyricsSourceForGenerationUnitSource(source: GenerationUnitProgramSourceV1): LyricsSource | undefined {
  return lyricsByGenerationUnitSource.get(source as object);
}

async function resolveLegacyGenerationUnitSource(
  projectRoot: string,
  project: Project,
  request: GenerationRequest
): Promise<GenerationUnitProgramSourceV1 | undefined> {
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
      if (!before.isFile() || before.dev === 0 || before.ino === 0 || before.size > MAX_CONTRACT_ARTIFACT_BYTES) return undefined;
      const beforePath = await realpath(lexicalCandidate);
      if (beforePath !== candidate || !isGenerationUnitPathContained(directory, beforePath)) return undefined;

      // Read from the opened descriptor, never by reopening the checked path.
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < before.size) {
        const read = await fileHandle.read(bytes, offset, before.size - offset, offset);
        if (read.bytesRead <= 0) return undefined;
        offset += read.bytesRead;
      }
      const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
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
}

async function resolveAuthoritativeGenerationUnit(
  projectRoot: string,
  project: Project,
  request: GenerationRequest,
  ir: import("./schemaV2.js").VideoPromptIrV2,
  requestIndex: number
): Promise<GenerationUnitProgramSourceV1 | undefined> {
  if (ir.program_kind !== "mv") return undefined;
  const refs = project.orchestration?.authoring?.generation_units ?? [];
  const unitRef = refs.find((candidate) => candidate.id === request.id);
  if (!unitRef || refs.filter((candidate) => candidate.id === request.id).length !== 1) return undefined;
  const storeRoot = ((project as unknown as { production_control?: { artifact_store_dir?: unknown } }).production_control?.artifact_store_dir);
  if (storeRoot !== undefined && (typeof storeRoot !== "string" || !isSafeProjectRelative(storeRoot))) return undefined;
  try {
    const canonicalProjectRoot = await realpath(projectRoot);
    // Read-only validation must not create a production-control directory or
    // promote an absent artifact into an authoring source.
    const store = new ArtifactStore(join(canonicalProjectRoot, typeof storeRoot === "string" ? storeRoot : "production-control"));
    const unit = parseArtifact(await store.readBounded(unitRef.id, MAX_CONTRACT_ARTIFACT_BYTES), generationUnitContractSchema, unitRef.digest);
    if (unit.unit_id !== request.id || unit.ordinal !== requestIndex || unit.program.end_ms - unit.program.start_ms !== ir.target.duration_ms) return undefined;
    if (unit.route.ir_model !== ir.target.model_profile_id || unit.route.mode_binding !== ir.target.mode) return undefined;

    const musicRef = project.orchestration?.authoring?.music;
    if (!musicRef || musicRef.id !== unit.music_binding.contract_id || musicRef.digest !== unit.music_binding.contract_digest) return undefined;
    const music = parseArtifact(await store.readBounded(musicRef.id, MAX_CONTRACT_ARTIFACT_BYTES), musicStructureContractSchema, musicRef.digest);
    if (music.contract_id !== unit.music_binding.contract_id || music.revision !== unit.music_binding.revision
      || music.digest !== unit.music_binding.contract_digest || music.timing_digest !== unit.music_binding.timing_digest
      || music.master_audio.sha256 !== unit.music_binding.master_audio_digest
      || unit.program.master_duration_ms !== music.master_audio.duration_ms) return undefined;
    for (const ref of unit.beat_anchor_refs) {
      const beat = music.beat_markers.find((candidate) => candidate.id === ref.fragment_id);
      if (!beat || ref.digest !== sha256Canonical(beat)) return undefined;
    }

    let lyrics: LyricsContractV1 | undefined;
    const lyricsRef = project.orchestration?.authoring?.lyrics;
    if (unit.lyrics_binding) {
      if (!lyricsRef || lyricsRef.id !== unit.lyrics_binding.contract_id || lyricsRef.digest !== unit.lyrics_binding.contract_digest) return undefined;
      lyrics = parseArtifact(await store.readBounded(lyricsRef.id, MAX_CONTRACT_ARTIFACT_BYTES), lyricsContractSchema, lyricsRef.digest);
      if (lyrics.contract_id !== unit.lyrics_binding.contract_id || lyrics.revision !== unit.lyrics_binding.revision
        || lyrics.digest !== unit.lyrics_binding.contract_digest || lyrics.source.text_digest !== unit.lyrics_binding.text_digest
        || lyrics.timing_digest !== unit.lyrics_binding.timing_digest) return undefined;
      for (const ref of unit.lyric_cue_refs) {
        const cue = lyrics.cues.find((candidate) => candidate.id === ref.fragment_id);
        if (!cue || ref.digest !== sha256Canonical(cue)) return undefined;
      }
    } else if (unit.lyric_cue_refs.length > 0) return undefined;

    const source = deepFreeze(toProgramBindingSource(unit));
    trustedGenerationUnitSources.add(source as object);
    generationUnitSourceSnapshots.set(source as object, sha256Canonical(source));
    if (lyrics) {
      lyricsByGenerationUnitSource.set(source as object, {
        canonical_text: lyrics.source.canonical_text,
        text_digest: lyrics.source.text_digest,
        cues: unit.lyric_cue_refs.map((ref) => {
          const cue = lyrics!.cues.find((candidate) => candidate.id === ref.fragment_id)!;
          return {
            cue_id: cue.id,
            occurrence_id: cue.source_span.occurrence_id,
            timing: cue.timing,
            lyrics_contract_digest: lyrics!.digest,
            source_span: cue.source_span
          };
        })
      });
    }
    return source;
  } catch {
    return undefined;
  }
}

function parseArtifact<T>(bytes: Buffer, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, expectedDigest: string): T {
  const parsedJson: unknown = JSON.parse(bytes.toString("utf8"));
  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) throw new Error("artifact schema mismatch");
  const body = parsed.data as T & { digest?: unknown };
  if (body.digest !== expectedDigest && sha256Canonical(parsedJson) !== expectedDigest) throw new Error("artifact digest mismatch");
  return parsed.data;
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
  return stableDeviceIdentity
    && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
