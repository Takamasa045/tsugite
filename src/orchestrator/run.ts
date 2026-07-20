import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { runCliGenerationAdapter, type CliGenerationRequestResult } from "../adapters/cliGeneration.js";
import { runCliAudioAdapter, type CliAudioResult } from "../adapters/cliAudio.js";
import type { AdapterDefinition } from "../adapters/registry.js";
import type { Manifest } from "../manifest/schema.js";
import { validateManifest } from "../manifest/validate.js";
import { generationRequestOutputKind, toExecutionProject, type Project } from "../project/schema.js";
import type { Result } from "../types.js";
import { inspectGate2ManifestWithFingerprints, writeGate2QcReport } from "./gate2Qc.js";
import { markGateAwaiting, writeState, type RunState } from "./state.js";
import { digest } from "./editorialProposal.js";
import type { EditorialCompilation } from "./review.js";
import { pinGenerationAssets, projectAssetRoot } from "../project/generationAssets.js";
import { toPortablePath } from "../platform/path.js";
import {
  resolveGenerationConnection,
  type GenerationConnectionResolution
} from "../connections/registry.js";

export type LocalRunResult = {
  manifestPath: string;
  qcReportPath: string;
  runLogPath: string;
  edlPath?: string;
  assetCount: number;
  actualCredits: number;
  alreadyAssembled: boolean;
  state: RunState;
  statePath: string;
};

type AssembleOptions = {
  configPath?: string;
  manifestPath: string;
  stateDir: string;
  state: RunState;
  editorial?: EditorialCompilation;
  generationConnection?: GenerationConnectionResolution;
  audioConnection?: GenerationConnectionResolution;
  connectionVerificationApproved?: boolean;
  audioConnectionVerificationApproved?: boolean;
  verifyApprovedInputs?: () => Promise<Result<{}>>;
};

const gate2QcResumeSchema = z
  .object({
    ok: z.boolean(),
    target_duration_seconds: z.number(),
    total_clip_duration_seconds: z.number(),
    duration_delta_seconds: z.number(),
    asset_count: z.number().int().nonnegative(),
    assets: z.array(
      z
        .object({
          id: z.string().min(1),
          kind: z.enum(["clip", "audio", "image"]),
          src: z.string().min(1),
          path: z.string().min(1),
          probe: z.object({ ok: z.boolean() }).passthrough(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
        })
        .passthrough()
    ),
    issues: z.array(
      z
        .object({
          code: z.string().min(1),
          message: z.string(),
          path: z.string().optional()
        })
        .passthrough()
    )
  })
  .passthrough();

type ResumeMetrics = {
  assetCount: number;
  actualCredits: number;
  approvalDigest: string;
};

type ManifestAssetReference = {
  id: string;
  kind: "clip" | "audio" | "image";
  src: string;
};

export async function assembleLocalMediaRun(
  project: Project,
  manifest: Manifest,
  options: AssembleOptions,
  adapter?: AdapterDefinition,
  audioAdapter?: AdapterDefinition
): Promise<Result<LocalRunResult>> {
  const isAwaitingGate2Resume = options.state.status === "awaiting_gate_2"
    && options.state.gates.gate_2.status === "awaiting_approval";
  const audioConnection = options.audioConnection
    ?? (project.audio?.connection
      ? await resolveGenerationConnection(project.audio.connection)
      : undefined);
  if (project.audio?.connection && !audioConnection) {
    return {
      ok: false,
      issues: [{
        code: "run.audio_connection_unavailable",
        message: `audio connection '${project.audio.connection}' could not be resolved for execution`,
        path: "audio.connection"
      }]
    };
  }
  if (audioConnection && audioConnection.transport !== "cli") {
    return {
      ok: false,
      issues: [{
        code: "run.audio_connection_handoff_required",
        message: `audio connection '${audioConnection.id}' uses ${audioConnection.transport.toUpperCase()} and requires an agent handoff; pipeline run will not execute adapter '${audioConnection.adapter}' as CLI`,
        path: "audio.connection"
      }]
    };
  }
  if (
    !isAwaitingGate2Resume
    && audioConnection?.setup_status === "needs-verification"
    && !options.audioConnectionVerificationApproved
  ) {
    return {
      ok: false,
      issues: [{
        code: "run.audio_connection_verification_required",
        message: `audio connection '${audioConnection.id}' needs verification recorded in the approved Gate 1 review before run`,
        path: "audio.connection"
      }]
    };
  }
  if (
    !isAwaitingGate2Resume
    && audioConnection
    && ["needs-setup", "not-integrated"].includes(audioConnection.setup_status)
  ) {
    return {
      ok: false,
      issues: [{
        code: "run.audio_connection_setup_required",
        message: `audio connection '${audioConnection.id}' is ${audioConnection.setup_status}; complete setup before run`,
        path: "audio.connection"
      }]
    };
  }
  if (project.generation && project.generation.requests.length > 0) {
    return assembleGeneratedMediaRun(project, manifest, options, adapter, audioAdapter);
  }

  const runId = project.run_id ?? project.slug;
  const runDir = join(options.stateDir, runId);
  const manifestOutputPath = join(runDir, "manifest.json");
  const qcReportPath = join(runDir, "gate2-qc.json");
  const runLogPath = join(runDir, "run-log.md");
  const edlPath = project.edit.editorial ? join(runDir, "editorial-edl.json") : undefined;
  const statePath = join(runDir, "state.json");
  const inputDigest = runInputDigest(project, manifest, undefined, audioAdapter);

  if (isAwaitingGate2Resume) {
    const resumed = await inspectAwaitingGate2Artifacts({
      runId,
      mode: "local-media",
      backend: project.edit.backend,
      inputDigest,
      manifestPath: manifestOutputPath,
      qcReportPath,
      runLogPath,
      ...(edlPath && options.editorial ? {
        edlPath,
        editorialEdlDigest: options.editorial.edl.digest,
        editorialManifest: options.editorial.manifest
      } : {})
    });
    if (!resumed.ok) return { ok: false, issues: resumed.issues };

    return {
      ok: true,
      issues: [],
      manifestPath: manifestOutputPath,
      qcReportPath,
      runLogPath,
      ...(edlPath ? { edlPath } : {}),
      assetCount: resumed.assetCount,
      actualCredits: resumed.actualCredits,
      alreadyAssembled: true,
      state: options.state,
      statePath
    };
  }

  if (options.state.status !== "running" || options.state.gates.gate_1.status !== "approved") {
    return {
      ok: false,
      issues: [
        {
          code: "run.invalid_state",
          message: "run requires a Gate 1 approved running state"
        }
      ]
    };
  }

  const manifestDir = dirname(options.manifestPath);
  if (project.edit.editorial && !options.editorial) {
    return {
      ok: false,
      issues: [{ code: "run.editorial_required", message: "approved editorial compilation is required before assembly" }]
    };
  }
  const assembled = cloneManifest(options.editorial?.manifest ?? manifest);
  let assetCount = 0;

  await mkdir(runDir, { recursive: true });

  const copiedClips = new Map<string, string>();
  for (const [index, clip] of assembled.clips.entries()) {
    let relativePath = copiedClips.get(clip.src);
    if (!relativePath) {
      const copied = await copyAsset(clip.src, manifestDir, runDir, "assets/clips", index, clip.id);
      relativePath = copied.relativePath;
      copiedClips.set(clip.src, relativePath);
    }
    clip.src = relativePath;
    assetCount += 1;
  }

  for (const [index, image] of assembled.images.entries()) {
    const copied = await copyAsset(image.src, manifestDir, runDir, "assets/images", index, image.id);
    image.src = copied.relativePath;
    assetCount += 1;
  }

  const audioTracks = [
    ["bgm", assembled.audio.bgm],
    ["narration", assembled.audio.narration],
    ["sfx", assembled.audio.sfx]
  ] as const;

  for (const [track, entries] of audioTracks) {
    for (const [index, entry] of entries.entries()) {
      if (!entry.src) continue;
      const copied = await copyAsset(entry.src, manifestDir, runDir, `assets/audio/${track}`, index, entry.id ?? track);
      entry.src = copied.relativePath;
      assetCount += 1;
    }
  }

  if (options.verifyApprovedInputs) {
    const verified = await options.verifyApprovedInputs();
    if (!verified.ok) return verified;
  }

  const generatedAudio = appendGeneratedAudio(project, assembled, runId, runDir, audioAdapter);
  if (!generatedAudio.ok) return generatedAudio;
  assetCount += generatedAudio.assetCount;

  await writeFile(manifestOutputPath, `${JSON.stringify(assembled, null, 2)}\n`);
  if (edlPath && options.editorial) {
    await writeFile(edlPath, `${JSON.stringify(options.editorial.edl, null, 2)}\n`);
  }
  await writeGate2QcReport(assembled, manifestOutputPath, qcReportPath);
  await writeRunLog(runLogPath, {
    runId,
    mode: "local-media",
    assetCount,
    actualCredits: generatedAudio.credits,
    inputDigest,
    reviewPath: "review/index.html",
    reviewDataPath: "review/review-data.json",
    requests: [],
    ...(generatedAudio.log ? { audio: generatedAudio.log } : {}),
    ...(options.editorial ? { editorialEdlDigest: options.editorial.edl.digest } : {})
  });

  const nextState = markGateAwaiting(options.state, "gate_2");
  const writtenStatePath = await writeState(options.stateDir, nextState);

  return {
    ok: true,
    issues: [],
    manifestPath: manifestOutputPath,
    qcReportPath,
    runLogPath,
    ...(edlPath ? { edlPath } : {}),
    assetCount,
    actualCredits: generatedAudio.credits,
    alreadyAssembled: false,
    state: nextState,
    statePath: writtenStatePath
  };
}

export async function inspectGate2RunForApproval(
  project: Project,
  manifest: Manifest,
  stateDir: string,
  adapter?: AdapterDefinition,
  editorial?: EditorialCompilation,
  audioAdapter?: AdapterDefinition
): Promise<Result<ResumeMetrics>> {
  const runId = project.run_id ?? project.slug;
  const runDir = join(stateDir, runId);
  const isGeneration = Boolean(project.generation && project.generation.requests.length > 0);
  return inspectAwaitingGate2Artifacts({
    runId,
    mode: isGeneration ? "generation" : "local-media",
    backend: project.edit.backend,
    inputDigest: runInputDigest(project, manifest, isGeneration ? adapter : undefined, audioAdapter),
    requireQcPass: true,
    manifestPath: join(runDir, "manifest.json"),
    qcReportPath: join(runDir, "gate2-qc.json"),
    runLogPath: join(runDir, "run-log.md"),
    ...(editorial ? {
      edlPath: join(runDir, "editorial-edl.json"),
      editorialEdlDigest: editorial.edl.digest,
      editorialManifest: editorial.manifest
    } : {})
  });
}

async function assembleGeneratedMediaRun(
  project: Project,
  manifest: Manifest,
  options: AssembleOptions,
  adapter: AdapterDefinition | undefined,
  audioAdapter: AdapterDefinition | undefined
): Promise<Result<LocalRunResult>> {
  const isAwaitingGate2Resume = options.state.status === "awaiting_gate_2"
    && options.state.gates.gate_2.status === "awaiting_approval";
  const generationConnection = options.generationConnection
    ?? (project.generation?.connection
      ? await resolveGenerationConnection(project.generation.connection)
      : undefined);
  if (project.generation?.connection && !generationConnection) {
    return {
      ok: false,
      issues: [{
        code: "run.connection_unavailable",
        message: `generation connection '${project.generation.connection}' could not be resolved for execution`,
        path: "generation.connection"
      }]
    };
  }
  if (generationConnection && generationConnection.transport !== "cli") {
    return {
      ok: false,
      issues: [{
        code: "run.connection_handoff_required",
        message: `generation connection '${generationConnection.id}' uses ${generationConnection.transport.toUpperCase()} and requires an agent handoff; pipeline run will not execute adapter '${generationConnection.adapter}' as CLI`,
        path: "generation.connection"
      }]
    };
  }
  if (generationConnection && !isAwaitingGate2Resume) {
    if (generationConnection.setup_status === "needs-verification" && !options.connectionVerificationApproved) {
      return {
        ok: false,
        issues: [{
          code: "run.connection_verification_required",
          message: `generation connection '${generationConnection.id}' needs verification recorded in the approved Gate 1 review before run`,
          path: "generation.connection"
        }]
      };
    }
    if (["needs-setup", "not-integrated"].includes(generationConnection.setup_status)) {
      return {
        ok: false,
        issues: [{
          code: "run.connection_setup_required",
          message: `generation connection '${generationConnection.id}' is ${generationConnection.setup_status}; complete setup before run`,
          path: "generation.connection"
        }]
      };
    }
  }
  if (!adapter) {
    return {
      ok: false,
      issues: [{ code: "run.adapter_missing", message: "generation adapter definition is required" }]
    };
  }

  const runId = project.run_id ?? project.slug;
  const runDir = join(options.stateDir, runId);
  const manifestOutputPath = join(runDir, "manifest.json");
  const qcReportPath = join(runDir, "gate2-qc.json");
  const runLogPath = join(runDir, "run-log.md");
  const statePath = join(runDir, "state.json");
  const inputDigest = runInputDigest(project, manifest, adapter, audioAdapter);

  if (isAwaitingGate2Resume) {
    const resumed = await inspectAwaitingGate2Artifacts({
      runId,
      mode: "generation",
      backend: project.edit.backend,
      inputDigest,
      manifestPath: manifestOutputPath,
      qcReportPath,
      runLogPath
    });
    if (!resumed.ok) return { ok: false, issues: resumed.issues };

    return {
      ok: true,
      issues: [],
      manifestPath: manifestOutputPath,
      qcReportPath,
      runLogPath,
      assetCount: resumed.assetCount,
      actualCredits: resumed.actualCredits,
      alreadyAssembled: true,
      state: options.state,
      statePath
    };
  }

  if (options.state.status !== "running" || options.state.gates.gate_1.status !== "approved") {
    return {
      ok: false,
      issues: [{ code: "run.invalid_state", message: "run requires a Gate 1 approved running state" }]
    };
  }

  await mkdir(runDir, { recursive: true });

  const hasGenerationAssets = project.generation!.requests.some(
    (request) => Boolean(request.first_frame) || (request.reference_images?.length ?? 0) > 0
  );
  if (hasGenerationAssets && !options.configPath) {
    return {
      ok: false,
      issues: [{ code: "run.config_path_required", message: "generation assets require the project config path" }]
    };
  }
  const configDir = options.configPath ? dirname(resolve(options.configPath)) : dirname(options.manifestPath);
  const pinned = await pinGenerationAssets(
    project.generation!.requests,
    configDir,
    projectAssetRoot(configDir, project.manifest),
    runDir
  );
  if (!pinned.ok) return pinned;

  const assembled = cloneManifest(manifest);
  if (project.generation!.requests.some((request) => generationRequestOutputKind(request) === "video")) {
    assembled.clips = [];
  }
  assembled.provenance = [];
  let assetCount = 0;

  const manifestDir = dirname(options.manifestPath);
  for (const [index, image] of assembled.images.entries()) {
    const copied = await copyAsset(image.src, manifestDir, runDir, "assets/images", index, image.id);
    image.src = copied.relativePath;
    assetCount += 1;
  }

  const audioTracks = [
    ["bgm", assembled.audio.bgm],
    ["narration", assembled.audio.narration],
    ["sfx", assembled.audio.sfx]
  ] as const;

  for (const [track, entries] of audioTracks) {
    for (const [index, entry] of entries.entries()) {
      if (!entry.src) continue;
      const copied = await copyAsset(entry.src, manifestDir, runDir, `assets/audio/${track}`, index, entry.id ?? track);
      entry.src = copied.relativePath;
      assetCount += 1;
    }
  }

  if (options.verifyApprovedInputs) {
    const verified = await options.verifyApprovedInputs();
    if (!verified.ok) return verified;
  }

  const generation = runCliGenerationAdapter(adapter, pinned.requests, { runId, runDir });
  if (!generation.ok) return generation;

  const existingImageIds = new Set(assembled.images.map((image) => image.id));
  const duplicateImage = generation.images.find((image) => existingImageIds.has(image.id));
  const existingAudioIds = new Set(
    [...assembled.audio.bgm, ...assembled.audio.narration, ...assembled.audio.sfx]
      .flatMap((track) => track.id ? [track.id] : [])
  );
  const duplicateAudio = generation.audio.find((track) => existingAudioIds.has(track.id));
  if (duplicateImage || duplicateAudio) {
    const duplicate = duplicateImage ?? duplicateAudio!;
    return {
      ok: false,
      issues: [{
        code: "run.generated_asset_id_duplicate",
        message: `generated asset id '${duplicate.id}' already exists in the project manifest`,
        path: "generation.requests"
      }]
    };
  }

  for (const [index, clip] of generation.clips.entries()) {
    const copied = await copyAsset(clip.src, process.cwd(), runDir, "assets/clips", index, clip.id);
    assembled.clips.push({
      ...clip,
      src: copied.relativePath
    });
    assetCount += 1;
  }

  for (const [index, image] of generation.images.entries()) {
    const copied = await copyAsset(image.src, process.cwd(), runDir, "assets/images/generated", index, image.id);
    assembled.images.push({ ...image, src: copied.relativePath });
    assetCount += 1;
  }

  for (const [index, track] of generation.audio.entries()) {
    const copied = await copyAsset(track.src, process.cwd(), runDir, `assets/audio/${track.role}`, index, track.id);
    assembled.audio[track.role === "music" ? "bgm" : track.role].push({
      id: track.id,
      src: copied.relativePath,
      start: track.start,
      ...(track.end !== undefined ? { end: track.end } : {}),
      ...(track.volume !== undefined ? { volume: track.volume } : {})
    });
    assetCount += 1;
  }

  for (const request of generation.requests) {
    const original = project.generation!.requests.find((candidate) => candidate.id === request.request_id);
    const generatedAssets = [
      ...request.clips.map((asset) => ({ id: asset.id, kind: "clip" })),
      ...request.images.map((asset) => ({ id: asset.id, kind: "image" })),
      ...request.audio.map((asset) => ({ id: asset.id, kind: "audio" }))
    ];
    for (const asset of generatedAssets) {
      assembled.provenance.push({
        ...(asset.kind === "clip" ? { clip_id: asset.id } : { asset_id: asset.id, asset_kind: asset.kind }),
        engine: adapter.name,
        model: original?.model,
        params: {
          ...(original?.params ?? {}),
          ...(pinned.manifestPaths.get(request.request_id)
            ? { first_frame: pinned.manifestPaths.get(request.request_id) }
            : {}),
          ...(pinned.referenceManifestPaths.get(request.request_id)
            ? { reference_images: pinned.referenceManifestPaths.get(request.request_id) }
            : {})
        },
        credits: request.credits / generatedAssets.length
      });
    }
  }

  const generatedAudio = appendGeneratedAudio(project, assembled, runId, runDir, audioAdapter);
  if (!generatedAudio.ok) return generatedAudio;
  assetCount += generatedAudio.assetCount;
  const actualCredits = generation.credits + generatedAudio.credits;

  await writeFile(manifestOutputPath, `${JSON.stringify(assembled, null, 2)}\n`);
  await writeGate2QcReport(assembled, manifestOutputPath, qcReportPath);
  await writeRunLog(runLogPath, {
    runId,
    mode: "generation",
    assetCount,
    actualCredits,
    inputDigest,
    reviewPath: "review/index.html",
    reviewDataPath: "review/review-data.json",
    requests: generation.requests,
    ...(generatedAudio.log ? { audio: generatedAudio.log } : {})
  });

  const nextState = markGateAwaiting(options.state, "gate_2");
  const writtenStatePath = await writeState(options.stateDir, nextState);

  return {
    ok: true,
    issues: [],
    manifestPath: manifestOutputPath,
    qcReportPath,
    runLogPath,
    assetCount,
    actualCredits,
    alreadyAssembled: false,
    state: nextState,
    statePath: writtenStatePath
  };
}

type AudioRunLog = {
  adapter: string;
  bgmCount: number;
  sfxCount: number;
  elevenlabsUsed: boolean;
  fallbackUsed: boolean;
};

type AudioAssemblyResult = Result<{
  assetCount: number;
  credits: number;
  log?: AudioRunLog;
}>;

function appendGeneratedAudio(
  project: Project,
  manifest: Manifest,
  runId: string,
  runDir: string,
  adapter?: AdapterDefinition
): AudioAssemblyResult {
  if (!project.audio) return { ok: true, issues: [], assetCount: 0, credits: 0 };
  if (!adapter) {
    return {
      ok: false,
      issues: [{ code: "run.audio_adapter_missing", message: "audio adapter definition is required" }]
    };
  }

  const existingIds = new Set(
    [...manifest.audio.bgm, ...manifest.audio.narration, ...manifest.audio.sfx]
      .map((track) => track.id)
      .filter((id): id is string => Boolean(id))
  );
  const requestedTracks = [...(project.audio.bgm ? [project.audio.bgm] : []), ...project.audio.sfx];
  const duplicate = requestedTracks.find((track) => existingIds.has(track.id));
  if (duplicate) {
    return {
      ok: false,
      issues: [{ code: "run.audio_track_id_duplicate", message: `audio track id '${duplicate.id}' already exists in the manifest` }]
    };
  }

  const result = runCliAudioAdapter(adapter, project.audio, {
    runId,
    runDir,
    targetDurationSeconds: manifest.meta.target_duration_seconds
  });
  if (!result.ok) return result;
  const generatedTracks = [...(result.bgm ? [result.bgm] : []), ...result.sfx];

  const relativeTrack = (track: NonNullable<CliAudioResult["bgm"]>) => ({
    ...track,
    src: toPortablePath(relative(runDir, isAbsolute(track.src) ? track.src : resolve(process.cwd(), track.src)))
  });
  if (result.bgm) manifest.audio.bgm.push(relativeTrack(result.bgm));
  manifest.audio.sfx.push(...result.sfx.map(relativeTrack));

  const provenance = {
    adapter: adapter.name,
    credits: result.credits,
    track_ids: generatedTracks.map((track) => track.id),
    provider: result.metadata.provider,
    bgm_mode: result.metadata.bgm_mode,
    elevenlabs_used: result.metadata.elevenlabs_used,
    fallback_used: result.metadata.fallback_used
  };
  (manifest as Record<string, unknown>).audio_provenance = provenance;

  return {
    ok: true,
    issues: [],
    assetCount: generatedTracks.length,
    credits: result.credits,
    log: {
      adapter: adapter.name,
      bgmCount: result.bgm ? 1 : 0,
      sfxCount: result.sfx.length,
      elevenlabsUsed: result.metadata.elevenlabs_used,
      fallbackUsed: result.metadata.fallback_used
    }
  };
}

function cloneManifest(manifest: Manifest): Manifest {
  return JSON.parse(JSON.stringify(manifest)) as Manifest;
}

async function copyAsset(
  src: string,
  sourceBaseDir: string,
  runDir: string,
  relativeTargetDir: string,
  index: number,
  label: string
): Promise<{ relativePath: string }> {
  const sourcePath = isAbsolute(src) ? src : resolve(sourceBaseDir, src);
  const targetName = `${String(index + 1).padStart(3, "0")}-${safeFileLabel(label)}${assetExtension(src)}`;
  const relativePath = toPortablePath(join(relativeTargetDir, targetName));
  const targetPath = join(runDir, relativePath);

  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);

  return { relativePath };
}

function safeFileLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "asset";
}

function assetExtension(src: string): string {
  const name = basename(src);
  const lastDot = name.lastIndexOf(".");
  return lastDot >= 0 ? name.slice(lastDot) : "";
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function inspectAwaitingGate2Artifacts(input: {
  runId: string;
  mode: "local-media" | "generation";
  backend: string;
  inputDigest: string;
  requireQcPass?: boolean;
  manifestPath: string;
  qcReportPath: string;
  runLogPath: string;
  edlPath?: string;
  editorialEdlDigest?: string;
  editorialManifest?: Manifest;
}): Promise<Result<ResumeMetrics>> {
  if (!(await isFile(input.manifestPath))) {
    return {
      ok: false,
      issues: [
        {
          code: "run.manifest_missing",
          message: "assembled manifest is missing for the awaiting Gate 2 state"
        }
      ]
    };
  }

  const assembledManifest = await readAndValidateManifest(input.manifestPath);
  if (!assembledManifest.ok) return assembledManifest;

  if (!(await isFile(input.qcReportPath))) {
    return {
      ok: false,
      issues: [{ code: "run.qc_report_missing", message: "Gate 2 QC report is missing for the awaiting Gate 2 state" }]
    };
  }

  const qcReport = await readAndValidateQcReport(input.qcReportPath);
  if (!qcReport.ok) return qcReport;

  if (!(await isFile(input.runLogPath))) {
    return {
      ok: false,
      issues: [{ code: "run.run_log_missing", message: "run log is missing for the awaiting Gate 2 state" }]
    };
  }

  const runLog = await readAndValidateRunLog(input.runLogPath);
  if (!runLog.ok) return runLog;

  if (input.editorialEdlDigest) {
    if (!input.edlPath || !(await isFile(input.edlPath))) {
      return {
        ok: false,
        issues: [{ code: "run.edl_missing", message: "approved editorial EDL is missing", path: input.edlPath }]
      };
    }
    const edl = await readAndValidateEdl(input.edlPath, input.editorialEdlDigest);
    if (!edl.ok) return edl;
    if (runLog.log.editorialEdlDigest !== input.editorialEdlDigest) {
      return {
        ok: false,
        issues: [{ code: "run.edl_inconsistent", message: "run log does not match the approved editorial EDL" }]
      };
    }
    if (
      !input.editorialManifest ||
      edl.edl.output_manifest_digest !== digest(input.editorialManifest) ||
      !edlMatchesManifest(edl.edl, assembledManifest.manifest) ||
      !editorialManifestMatchesAssembled(input.editorialManifest, assembledManifest.manifest)
    ) {
      return {
        ok: false,
        issues: [{ code: "run.edl_inconsistent", message: "editorial EDL does not match the assembled manifest" }]
      };
    }
  } else if (runLog.log.editorialEdlDigest) {
    return {
      ok: false,
      issues: [{ code: "run.edl_unapproved", message: "assembled run contains an editorial EDL without current approval" }]
    };
  }

  const assetReferences = manifestAssetReferences(assembledManifest.manifest);
  const realRunDir = await realpath(dirname(input.manifestPath));
  const resolvedAssets = await Promise.all(
    assetReferences.map(async (asset) => ({
      ...asset,
      path: await resolveRunAssetPath(input.manifestPath, asset.src, realRunDir)
    }))
  );
  const invalidAssetPath = resolvedAssets.find((asset) => asset.path === undefined);
  if (invalidAssetPath) {
    return {
      ok: false,
      issues: [
        {
          code: "run.asset_path_invalid",
          message: `assembled asset '${invalidAssetPath.id}' must stay inside the run directory`,
          path: invalidAssetPath.src
        }
      ]
    };
  }

  const expectedQcAssets = assetReferences.map(referenceKey).sort();
  const actualQcAssets = qcReport.report.assets
    .map((asset) => referenceKey({ id: asset.id, kind: asset.kind, src: asset.src }))
    .sort();
  const assetPathsByReference = new Map(resolvedAssets.map((asset) => [referenceKey(asset), asset.path]));
  const qcPathsMatch = qcReport.report.assets.every((asset) => {
    return asset.path === assetPathsByReference.get(referenceKey(asset));
  });
  const totalClipDuration = assembledManifest.manifest.clips.reduce((sum, clip) => sum + clip.duration, 0);
  const targetDuration = assembledManifest.manifest.meta.target_duration_seconds;
  const durationDelta = Math.round((totalClipDuration - targetDuration) * 1000) / 1000;
  const qcSummaryMatches =
    Math.abs(qcReport.report.target_duration_seconds - targetDuration) <= 1e-9 &&
    Math.abs(qcReport.report.total_clip_duration_seconds - totalClipDuration) <= 1e-9 &&
    Math.abs(qcReport.report.duration_delta_seconds - durationDelta) <= 1e-9;

  if (
    qcReport.report.asset_count !== assetReferences.length ||
    qcReport.report.assets.length !== assetReferences.length ||
    JSON.stringify(actualQcAssets) !== JSON.stringify(expectedQcAssets) ||
    !qcPathsMatch ||
    !qcSummaryMatches
  ) {
    return {
      ok: false,
      issues: [
        {
          code: "run.qc_report_inconsistent",
          message: "Gate 2 QC report does not match the assembled manifest"
        }
      ]
    };
  }

  if (runLog.log.inputDigest !== input.inputDigest) {
    return {
      ok: false,
      issues: [{ code: "run.input_changed", message: "project, manifest, or adapter inputs changed after assembly" }]
    };
  }

  if (
    runLog.log.runId !== input.runId ||
    runLog.log.mode !== input.mode ||
    runLog.log.assetCount !== assetReferences.length
  ) {
    return {
      ok: false,
      issues: [{ code: "run.run_log_inconsistent", message: "run log does not match the assembled run artifacts" }]
    };
  }

  const generationCredits = input.mode === "generation"
    ? assembledManifest.manifest.provenance.reduce((sum, entry) => sum + (entry.credits ?? 0), 0)
    : 0;
  const expectedCredits = generationCredits + manifestAudioCredits(assembledManifest.manifest);
  if (Math.abs(runLog.log.actualCredits - expectedCredits) > 1e-9) {
    return {
      ok: false,
      issues: [{ code: "run.run_log_inconsistent", message: "run log credits do not match manifest provenance" }]
    };
  }

  for (const asset of resolvedAssets) {
    if (!(await isFile(asset.path!))) {
      return {
        ok: false,
        issues: [{ code: "run.asset_missing", message: `assembled asset '${asset.id}' is missing`, path: asset.path }]
      };
    }
  }

  const freshQcReport = await inspectGate2ManifestWithFingerprints(
    assembledManifest.manifest,
    dirname(input.manifestPath)
  );
  if (stableJson(qcReport.report) !== stableJson(freshQcReport)) {
    return {
      ok: false,
      issues: [
        {
          code: "run.qc_report_stale",
          message: "Gate 2 QC report no longer matches the assembled assets",
          path: input.qcReportPath
        }
      ]
    };
  }
  if (input.requireQcPass && !freshQcReport.ok) {
    return {
      ok: false,
      issues: [
        {
          code: "run.qc_failed",
          message: "Gate 2 QC must pass before approve_all; use revise or abort",
          path: input.qcReportPath
        }
      ]
    };
  }

  return {
    ok: true,
    issues: [],
    assetCount: assetReferences.length,
    actualCredits: runLog.log.actualCredits,
    approvalDigest: digest({
      backend: input.backend,
      manifest: assembledManifest.manifest,
      editorial_edl_digest: input.editorialEdlDigest,
      run_log: runLog.log,
      gate2_qc: freshQcReport
    })
  };
}

async function readAndValidateManifest(path: string): Promise<Result<{ manifest: Manifest }>> {
  try {
    const parsed = validateManifest(JSON.parse(await readFile(path, "utf8")));
    if (!parsed.ok || !parsed.manifest) {
      return {
        ok: false,
        issues: [{ code: "run.manifest_invalid", message: parsed.issues[0]?.message ?? "invalid assembled manifest" }]
      };
    }
    return { ok: true, issues: [], manifest: parsed.manifest };
  } catch (error) {
    return {
      ok: false,
      issues: [{ code: "run.manifest_invalid", message: error instanceof Error ? error.message : String(error) }]
    };
  }
}

async function readAndValidateQcReport(
  path: string
): Promise<Result<{ report: z.infer<typeof gate2QcResumeSchema> }>> {
  try {
    const parsed = gate2QcResumeSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (!parsed.success) {
      return {
        ok: false,
        issues: [{ code: "run.qc_report_invalid", message: parsed.error.issues[0]?.message ?? "invalid Gate 2 QC report" }]
      };
    }
    return { ok: true, issues: [], report: parsed.data };
  } catch (error) {
    return {
      ok: false,
      issues: [{ code: "run.qc_report_invalid", message: error instanceof Error ? error.message : String(error) }]
    };
  }
}

async function readAndValidateRunLog(path: string): Promise<
  Result<{
    log: {
      runId: string;
      mode: string;
      assetCount: number;
      actualCredits: number;
      inputDigest: string;
      editorialEdlDigest?: string;
    };
  }>
> {
  try {
    const text = await readFile(path, "utf8");
    const runId = text.match(/^# Run Log: (.+)$/m)?.[1]?.trim();
    const mode = text.match(/^- mode: (.+)$/m)?.[1]?.trim();
    const assetCountText = text.match(/^- asset_count: (.+)$/m)?.[1]?.trim();
    const actualCreditsText = text.match(/^- actual_credits: (.+)$/m)?.[1]?.trim();
    const inputDigest = text.match(/^- input_digest: ([a-f0-9]{64})$/m)?.[1];
    const editorialEdlDigest = text.match(/^- editorial_edl_digest: ([a-f0-9]{64})$/m)?.[1];
    const assetCount = Number(assetCountText);
    const actualCredits = Number(actualCreditsText);

    if (
      !runId ||
      !mode ||
      assetCountText === undefined ||
      actualCreditsText === undefined ||
      !Number.isInteger(assetCount) ||
      assetCount < 0 ||
      !Number.isFinite(actualCredits) ||
      actualCredits < 0 ||
      !inputDigest
    ) {
      return {
        ok: false,
        issues: [{ code: "run.run_log_invalid", message: "run log is missing valid summary fields" }]
      };
    }

    return {
      ok: true,
      issues: [],
      log: {
        runId,
        mode,
        assetCount,
        actualCredits,
        inputDigest,
        ...(editorialEdlDigest ? { editorialEdlDigest } : {})
      }
    };
  } catch (error) {
    return {
      ok: false,
      issues: [{ code: "run.run_log_invalid", message: error instanceof Error ? error.message : String(error) }]
    };
  }
}

function manifestAssetReferences(manifest: Manifest): ManifestAssetReference[] {
  return [
    ...manifest.clips.map((clip) => ({ id: clip.id, kind: "clip" as const, src: clip.src })),
    ...manifest.images.map((image) => ({ id: image.id, kind: "image" as const, src: image.src })),
    ...manifest.audio.bgm.flatMap((entry, index) =>
      entry.src ? [{ id: entry.id ?? `bgm-${index + 1}`, kind: "audio" as const, src: entry.src }] : []
    ),
    ...manifest.audio.narration.flatMap((entry, index) =>
      entry.src ? [{ id: entry.id ?? `narration-${index + 1}`, kind: "audio" as const, src: entry.src }] : []
    ),
    ...manifest.audio.sfx.flatMap((entry, index) =>
      entry.src ? [{ id: entry.id ?? `sfx-${index + 1}`, kind: "audio" as const, src: entry.src }] : []
    )
  ];
}

function referenceKey(reference: ManifestAssetReference): string {
  return `${reference.kind}\u0000${reference.id}\u0000${reference.src}`;
}

async function resolveRunAssetPath(manifestPath: string, src: string, realRunDir: string): Promise<string | undefined> {
  if (isAbsolute(src)) return undefined;
  const runDir = dirname(manifestPath);
  const assetPath = resolve(runDir, src);
  const relativePath = relative(runDir, assetPath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return undefined;
  try {
    const realAssetPath = await realpath(assetPath);
    const realRelativePath = relative(realRunDir, realAssetPath);
    if (realRelativePath === ".." || realRelativePath.startsWith(`..${sep}`) || isAbsolute(realRelativePath)) {
      return undefined;
    }
  } catch {
    // Preserve the lexical path so the caller can report a missing asset separately.
  }
  return assetPath;
}

async function writeRunLog(
  path: string,
  input: {
    runId: string;
    mode: string;
    assetCount: number;
    actualCredits: number;
    inputDigest: string;
    reviewPath: string;
    reviewDataPath: string;
    requests: CliGenerationRequestResult[];
    editorialEdlDigest?: string;
    audio?: AudioRunLog;
  }
): Promise<void> {
  const lines = [
    `# Run Log: ${input.runId}`,
    "",
    `- mode: ${input.mode}`,
    `- asset_count: ${input.assetCount}`,
    `- actual_credits: ${input.actualCredits}`,
    `- input_digest: ${input.inputDigest}`,
    ...(input.editorialEdlDigest ? [`- editorial_edl_digest: ${input.editorialEdlDigest}`] : []),
    ...(input.audio ? [
      `- audio_adapter: ${input.audio.adapter}`,
      `- audio_bgm_count: ${input.audio.bgmCount}`,
      `- audio_sfx_count: ${input.audio.sfxCount}`,
      `- elevenlabs_used: ${input.audio.elevenlabsUsed}`,
      `- audio_fallback_used: ${input.audio.fallbackUsed}`
    ] : []),
    `- review_path: ${input.reviewPath}`,
    `- review_data_path: ${input.reviewDataPath}`,
    `- generated_at: ${new Date().toISOString()}`,
    "",
    "## Requests",
    ...input.requests.map(
      (request) =>
        `- ${request.request_id}: attempts=${request.attempts}, credits=${request.credits}, clips=${request.clips.length}`
    )
  ];
  await writeFile(path, `${lines.join("\n")}\n`);
}

async function readAndValidateEdl(
  path: string,
  expectedDigest: string
): Promise<Result<{ edl: Record<string, unknown> }>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const claimedDigest = parsed.digest;
    const { digest: _digest, ...withoutDigest } = parsed;
    if (claimedDigest !== expectedDigest || digest(withoutDigest) !== expectedDigest) {
      return {
        ok: false,
        issues: [{ code: "run.edl_invalid", message: "editorial EDL digest does not match Gate 1 approval", path }]
      };
    }
    return { ok: true, issues: [], edl: parsed };
  } catch (error) {
    return {
      ok: false,
      issues: [{ code: "run.edl_invalid", message: error instanceof Error ? error.message : String(error), path }]
    };
  }
}

function edlMatchesManifest(edl: Record<string, unknown>, manifest: Manifest): boolean {
  if (edl.duration_seconds !== manifest.meta.target_duration_seconds || !Array.isArray(edl.segments)) return false;
  if (edl.segments.length !== manifest.clips.length) return false;
  return edl.segments.every((unknownSegment, index) => {
    if (!unknownSegment || typeof unknownSegment !== "object" || Array.isArray(unknownSegment)) return false;
    const segment = unknownSegment as Record<string, unknown>;
    const clip = manifest.clips[index];
    return Boolean(clip) &&
      segment.source_clip_id === (clip as Record<string, unknown>).source_clip_id &&
      segment.source_start === clip.in &&
      segment.source_end === clip.out &&
      segment.output_start === (clip as Record<string, unknown>).output_start &&
      segment.output_end === (clip as Record<string, unknown>).output_end;
  });
}

function editorialManifestMatchesAssembled(expected: Manifest, assembled: Manifest): boolean {
  const generatedIds = manifestAudioTrackIds(assembled);
  const assembledBgm = assembled.audio.bgm.filter((track) => !track.id || !generatedIds.has(track.id));
  const assembledSfx = assembled.audio.sfx.filter((track) => !track.id || !generatedIds.has(track.id));
  if (
    expected.clips.length !== assembled.clips.length ||
    expected.images.length !== assembled.images.length ||
    expected.audio.bgm.length !== assembledBgm.length ||
    expected.audio.narration.length !== assembled.audio.narration.length ||
    expected.audio.sfx.length !== assembledSfx.length
  ) {
    return false;
  }

  const relocated = cloneManifest(expected);
  for (const [index, clip] of relocated.clips.entries()) clip.src = assembled.clips[index]!.src;
  for (const [index, image] of relocated.images.entries()) image.src = assembled.images[index]!.src;
  for (const track of ["bgm", "narration", "sfx"] as const) {
    const comparable = track === "bgm" ? assembledBgm : track === "sfx" ? assembledSfx : assembled.audio.narration;
    for (const [index, entry] of relocated.audio[track].entries()) {
      entry.src = comparable[index]!.src;
    }
  }
  const comparableAssembled = cloneManifest(assembled);
  comparableAssembled.audio.bgm = assembledBgm;
  comparableAssembled.audio.sfx = assembledSfx;
  delete (comparableAssembled as Record<string, unknown>).audio_provenance;
  return stableJson(relocated) === stableJson(comparableAssembled);
}

function runInputDigest(
  project: Project,
  manifest: Manifest,
  adapter?: AdapterDefinition,
  audioAdapter?: AdapterDefinition
): string {
  return createHash("sha256")
    .update(
      stableJson({
        project: toExecutionProject(project),
        manifest: manifestDigestInput(manifest),
        adapter: adapter ? { ...adapter, root: undefined } : undefined,
        audio_adapter: audioAdapter ? { ...audioAdapter, root: undefined } : undefined
      })
    )
    .digest("hex");
}

function manifestAudioProvenance(manifest: Manifest): Record<string, unknown> | undefined {
  const value = (manifest as Record<string, unknown>).audio_provenance;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function manifestAudioCredits(manifest: Manifest): number {
  const credits = manifestAudioProvenance(manifest)?.credits;
  return typeof credits === "number" && Number.isFinite(credits) && credits >= 0 ? credits : 0;
}

function manifestAudioTrackIds(manifest: Manifest): Set<string> {
  const ids = manifestAudioProvenance(manifest)?.track_ids;
  return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
}

export function manifestDigestInput(manifest: Manifest): unknown {
  const normalized = cloneManifest(manifest);
  const digestInput: Record<string, unknown> = { ...normalized };
  if (normalized.images.length === 0) delete digestInput.images;
  if (normalized.speakers.length === 0) delete digestInput.speakers;
  if (normalized.presentation?.draft === false) {
    const presentation: Record<string, unknown> = { ...normalized.presentation };
    delete presentation.draft;
    digestInput.presentation = presentation;
  }
  digestInput.captions = normalized.captions.map((caption) => {
    const normalizedCaption: Record<string, unknown> = { ...caption };
    if (caption.emphasis.length === 0) delete normalizedCaption.emphasis;
    if (caption.visual?.badges.length === 0) {
      const visual: Record<string, unknown> = { ...caption.visual };
      delete visual.badges;
      normalizedCaption.visual = visual;
    }
    return normalizedCaption;
  });
  return digestInput;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
