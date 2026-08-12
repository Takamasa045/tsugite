import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as nativePath from "node:path";
import type { GenerationRequest, Project } from "../project/schema.js";
import { ArtifactStore } from "../productionControl/artifactStore.js";
import { sha256Canonical } from "../productionControl/canonical.js";
import { sha256Canonical as runtimeSha256Canonical } from "../integrity/canonical.js";
import { generationUnitContractSchema, toProgramBindingSource } from "../productionControl/contracts/generationUnit.js";
import { lyricsContractSchema, type LyricsContractV1 } from "../productionControl/contracts/lyrics.js";
import { musicStructureContractSchema } from "../productionControl/contracts/music.js";
import { assetContractSchema, type AssetContractV1 } from "../productionControl/contracts/asset.js";
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
declare const trustedGenerationUnitLyricsBrand: unique symbol;
export type TrustedGenerationUnitLyricsToken = {
  readonly [trustedGenerationUnitLyricsBrand]: true;
};
const trustedGenerationUnitLyricsTokens = new WeakSet<object>();
const lyricsSnapshots = new WeakMap<object, LyricsSource>();
const lyricsTokenBySource = new WeakMap<object, TrustedGenerationUnitLyricsToken>();
const fullT04Snapshots = new WeakMap<object, { unit: unknown; lyrics?: unknown; assets?: unknown }>();
declare const trustedAssetContractResolutionBrand: unique symbol;
export type TrustedAssetContractResolution = {
  readonly kind: "authoritative-project-asset-contract";
  readonly contract: AssetContractV1;
  readonly project_root: string;
  readonly artifact_id: string;
  readonly artifact_digest: string;
  readonly [trustedAssetContractResolutionBrand]: true;
};
const trustedAssetContractResolutions = new WeakSet<object>();
const assetContractResolutionSnapshots = new WeakMap<object, string>();
const assetContractResolutionStores = new WeakMap<object, ArtifactStore>();

export type GenerationUnitContractFacts = {
  generation_unit_digest: string;
  master_duration_ms: number;
  clip_duration_ms: number;
  audio_policy: "reuse-master" | "reference-only" | "native-generated" | "silent";
  reference_audio_asset_id?: string;
  reference_audio_asset_digest?: string;
  asset_contract?: {
    contract_id: string;
    revision: number;
    digest: string;
    entry_id: string;
    path: string;
    sha256: string;
    byte_size: number;
    external_send: "allowed" | "forbidden" | "needs-human";
  };
  asset_contract_entries?: Array<{
    contract_id: string;
    revision: number;
    digest: string;
    entry_id: string;
    path: string;
    sha256: string;
    byte_size: number;
    external_send: "allowed" | "forbidden" | "needs-human";
  }>;
};

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

/**
 * Resolve T03's typed source from the project-local, non-authoring store.
 * Active vs legacy is decided from the project object only after callers apply
 * trusted projection (`projectWithRuntimeAuthority`) or pass a project whose
 * orchestration.mode already reflects ResolvedRuntimeAuthority. This resolver
 * never re-reads durable pointer or re-resolves YAML against pointer itself —
 * untrusted disk YAML with mode disabled/omit must not reach here as "active"
 * unless the validate/CLI entry already projected authority.
 */
export function createProjectGenerationUnitSourceResolver(configPath: string): GenerationUnitSourceResolver {
  const projectRoot = dirname(resolve(configPath));
  return async ({ project, request, ir, requestIndex }: { project: Project; request: GenerationRequest; ir: import("./schemaV2.js").VideoPromptIrV2; requestIndex: number }) => {
    // Trust projected mode only (no independent YAML re-resolve).
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

export function generationUnitContractFacts(source: GenerationUnitProgramSourceV1): GenerationUnitContractFacts | undefined {
  if (!isAuthoritativeGenerationUnitSource(source)) return undefined;
  const snapshot = fullT04Snapshots.get(source as object);
  if (!snapshot) return undefined;
  const unit = generationUnitContractSchema.parse(snapshot.unit);
  const assetContract = snapshot.assets ? assetContractSchema.parse(snapshot.assets) : undefined;
  const referenceEntry = unit.reference_audio_binding && assetContract
    ? assetContract.assets.find((entry) => entry.asset_id === unit.reference_audio_binding?.derived_asset_id)
    : undefined;
  return deepFreeze({
    generation_unit_digest: unit.digest,
    master_duration_ms: unit.program.master_duration_ms,
    clip_duration_ms: unit.clip_duration_ms,
    audio_policy: unit.audio_policy,
    ...(unit.reference_audio_binding ? {
      reference_audio_asset_id: unit.reference_audio_binding.derived_asset_id,
      reference_audio_asset_digest: unit.reference_audio_binding.derived_asset_digest
    } : {}),
    ...(assetContract ? {
      asset_contract_entries: assetContract.assets.map((entry) => ({
        contract_id: assetContract.contract_id,
        revision: assetContract.revision,
        digest: assetContract.digest,
        entry_id: entry.asset_id,
        path: entry.project_relative_path,
        sha256: entry.sha256,
        byte_size: entry.byte_size,
        external_send: entry.external_send
      })),
      ...(referenceEntry ? {
      asset_contract: {
        contract_id: assetContract.contract_id,
        revision: assetContract.revision,
        digest: assetContract.digest,
        entry_id: referenceEntry.asset_id,
        path: referenceEntry.project_relative_path,
        sha256: referenceEntry.sha256,
        byte_size: referenceEntry.byte_size,
        external_send: referenceEntry.external_send
      }
      } : {})
    } : {})
  });
}

/**
 * Standalone asset authority. It follows the same project-local create-only
 * ArtifactStore/ref contract as the T04 MV resolver; caller-supplied asset
 * JSON is never promoted by the execution derivation boundary.
 */
export async function resolveProjectAssetContract(configPath: string, project: Project): Promise<TrustedAssetContractResolution | undefined> {
  const ref = project.orchestration?.authoring?.assets;
  if (!ref || ref.kind !== "asset-contract") return undefined;
  const configured = (project as unknown as { production_control?: { artifact_store_dir?: unknown } }).production_control?.artifact_store_dir;
  if (configured !== undefined && (typeof configured !== "string" || !isSafeProjectRelative(configured))) return undefined;
  try {
    const projectRoot = await realpath(dirname(resolve(configPath)));
    const store = new ArtifactStore(join(projectRoot, typeof configured === "string" ? configured : "production-control"));
    const contract = parseArtifact(await store.readBounded(ref.id, MAX_CONTRACT_ARTIFACT_BYTES), assetContractSchema, ref.digest);
    const resolved = deepFreeze({
      kind: "authoritative-project-asset-contract" as const,
      contract: deepFreeze(structuredClone(contract)),
      project_root: projectRoot,
      artifact_id: ref.id,
      artifact_digest: ref.digest
    }) as TrustedAssetContractResolution;
    trustedAssetContractResolutions.add(resolved as object);
    assetContractResolutionSnapshots.set(resolved as object, runtimeSha256Canonical({
      kind: resolved.kind,
      contract: resolved.contract,
      project_root: resolved.project_root,
      artifact_id: resolved.artifact_id,
      artifact_digest: resolved.artifact_digest
    }));
    assetContractResolutionStores.set(resolved as object, store);
    return resolved;
  } catch {
    return undefined;
  }
}

export async function reloadAuthoritativeAssetContract(resolution: TrustedAssetContractResolution): Promise<AssetContractV1> {
  if (!isAuthoritativeAssetContractResolution(resolution)) throw new Error("VPD-J002: AssetContract resolver token is not authoritative");
  const store = assetContractResolutionStores.get(resolution as object);
  if (!store) throw new Error("VPD-J002: AssetContract resolver provenance is unavailable");
  const current = parseArtifact(await store.readBounded(resolution.artifact_id, MAX_CONTRACT_ARTIFACT_BYTES), assetContractSchema, resolution.artifact_digest);
  if (current.digest !== resolution.contract.digest || sha256Canonical(current) !== sha256Canonical(resolution.contract)) {
    throw new Error("VPD-J002: authoritative AssetContract changed after resolution");
  }
  return current;
}

export function isAuthoritativeAssetContractResolution(value: unknown): value is TrustedAssetContractResolution {
  return Boolean(value && typeof value === "object"
    && trustedAssetContractResolutions.has(value as object)
    && assetContractResolutionSnapshots.get(value as object) === runtimeSha256Canonical({
      kind: (value as TrustedAssetContractResolution).kind,
      contract: (value as TrustedAssetContractResolution).contract,
      project_root: (value as TrustedAssetContractResolution).project_root,
      artifact_id: (value as TrustedAssetContractResolution).artifact_id,
      artifact_digest: (value as TrustedAssetContractResolution).artifact_digest
    }));
}

/**
 * Compiler-internal handoff. The public API exposes no mutable LyricsSource
 * getter; only an opaque token minted beside the full T04 artifact snapshot
 * can be materialized inside the compiler boundary.
 */
export function consumeGenerationUnitLyricsToken(source: GenerationUnitProgramSourceV1): TrustedGenerationUnitLyricsToken | undefined {
  if (!isAuthoritativeGenerationUnitSource(source)) return undefined;
  const token = lyricsTokenBySource.get(source as object);
  return token && trustedGenerationUnitLyricsTokens.has(token as object) ? token : undefined;
}

/** Compiler-only source-bound handoff; a token from another source is invalid. */
export function consumeGenerationUnitLyricsForSource(
  source: GenerationUnitProgramSourceV1,
  token: TrustedGenerationUnitLyricsToken
): LyricsSource | undefined {
  if (!isAuthoritativeGenerationUnitSource(source)
    || lyricsTokenBySource.get(source as object) !== token
    || !trustedGenerationUnitLyricsTokens.has(token as object)) return undefined;
  const snapshot = lyricsSnapshots.get(token as object);
  return snapshot ? deepFreeze(structuredClone(snapshot)) : undefined;
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
      if (!directoryStat.isDirectory() || !sameFileIdentity(directoryLexicalStat, directoryStat)) return undefined;
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
      if (beforePath !== candidate || !isGenerationUnitPathContained(directory, beforePath)
        || !sameFileIdentity(lexicalCandidateStat, before)) return undefined;

      // Read from the opened descriptor, never by reopening the checked path.
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < before.size) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, before.size - offset));
        const read = await fileHandle.read(chunk, 0, chunk.byteLength, offset);
        if (read.bytesRead <= 0) return undefined;
        chunks.push(Buffer.from(chunk.subarray(0, read.bytesRead)));
        offset += read.bytesRead;
      }
      const parsed = JSON.parse(Buffer.concat(chunks, before.size).toString("utf8")) as unknown;
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
    if (unit.audio_policy !== ir.audio.policy) return undefined;

    const musicRef = project.orchestration?.authoring?.music;
    if (!musicRef || musicRef.id !== unit.music_binding.contract_id || musicRef.digest !== unit.music_binding.contract_digest) return undefined;
    const music = parseArtifact(await store.readBounded(musicRef.id, MAX_CONTRACT_ARTIFACT_BYTES), musicStructureContractSchema, musicRef.digest);
    if (music.contract_id !== unit.music_binding.contract_id || music.revision !== unit.music_binding.revision
      || music.digest !== unit.music_binding.contract_digest || music.timing_digest !== unit.music_binding.timing_digest
      || music.master_audio.sha256 !== unit.music_binding.master_audio_digest
      || unit.program.master_duration_ms !== music.master_audio.duration_ms) return undefined;
    for (const ref of unit.beat_anchor_refs) {
      const beat = music.beat_markers.find((candidate) => candidate.id === ref.fragment_id);
      if (!beat || ref.digest !== sha256Canonical(beat)
        || beat.at_ms < unit.program.start_ms || beat.at_ms > unit.program.end_ms) return undefined;
    }
    if (unit.program.section_id) {
      const section = music.sections.find((candidate) => candidate.id === unit.program.section_id);
      if (!section || unit.program.start_ms < section.start_ms || unit.program.end_ms > section.end_ms) return undefined;
    }
    let assetContract: import("../productionControl/contracts/asset.js").AssetContractV1 | undefined;
    if (unit.audio_policy === "reference-only") {
      const binding = unit.reference_audio_binding;
      const referenceAsset = ir.assets.find((asset) => asset.id === binding?.derived_asset_id);
      const irAudioIds = ir.assets.filter((asset) => asset.type === "audio").map((asset) => asset.id);
      if (!binding || !referenceAsset || referenceAsset.type !== "audio"
        || referenceAsset.sha256 !== binding.derived_asset_digest
        || binding.source_start_ms !== unit.program.start_ms
        || binding.source_end_ms !== unit.program.end_ms
        || !ir.audio.reference_asset_ids.includes(binding.derived_asset_id)
        || ir.audio.reference_asset_ids.length !== 1
        || irAudioIds.length !== 1
        || irAudioIds[0] !== binding.derived_asset_id) return undefined;
      const assetRef = project.orchestration?.authoring?.assets;
      if (!assetRef || assetRef.id.length === 0 || assetRef.digest.length !== 64) return undefined;
      assetContract = parseArtifact(await store.readBounded(assetRef.id, MAX_CONTRACT_ARTIFACT_BYTES), assetContractSchema, assetRef.digest);
      const assetEntry = assetContract.assets.find((asset) => asset.asset_id === binding.derived_asset_id);
      if (!assetEntry || assetEntry.kind !== "audio" || assetEntry.project_relative_path !== referenceAsset.path
        || assetEntry.sha256 !== binding.derived_asset_digest
        || assetEntry.external_send !== "allowed") return undefined;
      if (!(await verifyProjectAssetBytes(canonicalProjectRoot, assetEntry.project_relative_path, assetEntry.sha256, assetEntry.byte_size))) return undefined;
    } else if (ir.assets.some((asset) => asset.type === "audio") || ir.audio.reference_asset_ids.length > 0) return undefined;

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
        if (cue.section_id && unit.program.section_id && cue.section_id !== unit.program.section_id) return undefined;
        if (cue.timing === "timed" && (cue.start_ms < unit.program.start_ms || cue.end_ms > unit.program.end_ms)) return undefined;
      }
    } else if (unit.lyric_cue_refs.length > 0) return undefined;

    const source = deepFreeze(toProgramBindingSource(unit));
    trustedGenerationUnitSources.add(source as object);
    generationUnitSourceSnapshots.set(source as object, sha256Canonical(source));
    fullT04Snapshots.set(source as object, deepFreeze({ unit: structuredClone(unit), ...(lyrics ? { lyrics: structuredClone(lyrics) } : {}), ...(assetContract ? { assets: structuredClone(assetContract) } : {}) }));
    if (lyrics) {
      const lyricsSource = deepFreeze({
        canonical_text: lyrics.source.canonical_text,
        text_digest: lyrics.source.text_digest,
        language_bcp47: lyrics.language_bcp47,
        program_start_ms: unit.program.start_ms,
        cues: unit.lyric_cue_refs.map((ref) => {
          const cue = lyrics!.cues.find((candidate) => candidate.id === ref.fragment_id)!;
          return {
            cue_id: cue.id,
            occurrence_id: cue.source_span.occurrence_id,
            timing: cue.timing,
            lyrics_contract_digest: lyrics!.digest,
            language_bcp47: lyrics!.language_bcp47,
            source_span: cue.source_span,
            ...(cue.timing === "timed" ? {
              start_ms: cue.start_ms,
              end_ms: cue.end_ms,
              ...(cue.word_timings ? {
                word_timings: cue.word_timings.map((word) => ({
                  start_ms: word.start_ms - unit.program.start_ms,
                  end_ms: word.end_ms - unit.program.start_ms,
                  source_span: word.source_span
                }))
              } : {})
            } : {}),
            singer_ids: [...cue.singer_ids],
            use: [...cue.use]
          };
        })
      }) as LyricsSource;
      const token = Object.freeze({}) as TrustedGenerationUnitLyricsToken;
      trustedGenerationUnitLyricsTokens.add(token as object);
      lyricsSnapshots.set(token as object, lyricsSource);
      lyricsTokenBySource.set(source as object, token);
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

async function verifyProjectAssetBytes(root: string, projectRelativePath: string, expectedDigest: string, expectedSize: number): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const realRoot = await realpath(root);
    const lexical = join(realRoot, projectRelativePath);
    const lexicalStat = await lstat(lexical);
    if (lexicalStat.isSymbolicLink() || !lexicalStat.isFile() || lexicalStat.dev === 0 || lexicalStat.ino === 0 || lexicalStat.size !== expectedSize) return false;
    const real = await realpath(lexical);
    if (real !== lexical || !isGenerationUnitPathContained(realRoot, real)) return false;
    handle = await open(lexical, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.dev === 0 || before.ino === 0 || before.dev !== lexicalStat.dev || before.ino !== lexicalStat.ino || before.size !== expectedSize) return false;
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const read = await handle.read(chunk, 0, Math.min(chunk.byteLength, before.size - offset), offset);
      if (read.bytesRead <= 0) return false;
      hash.update(chunk.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    return hash.digest("hex") === expectedDigest
      && after.dev === before.dev && after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
