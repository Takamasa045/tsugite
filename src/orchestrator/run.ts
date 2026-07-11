import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { runCliGenerationAdapter, type CliGenerationRequestResult } from "../adapters/cliGeneration.js";
import type { AdapterDefinition } from "../adapters/registry.js";
import type { Manifest } from "../manifest/schema.js";
import { validateManifest } from "../manifest/validate.js";
import { toExecutionProject, type Project } from "../project/schema.js";
import type { Result } from "../types.js";
import { inspectGate2Manifest, writeGate2QcReport } from "./gate2Qc.js";
import { markGateAwaiting, writeState, type RunState } from "./state.js";

export type LocalRunResult = {
  manifestPath: string;
  qcReportPath: string;
  runLogPath: string;
  assetCount: number;
  actualCredits: number;
  alreadyAssembled: boolean;
  state: RunState;
  statePath: string;
};

type AssembleOptions = {
  manifestPath: string;
  stateDir: string;
  state: RunState;
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
  adapter?: AdapterDefinition
): Promise<Result<LocalRunResult>> {
  if (project.generation && project.generation.requests.length > 0) {
    return assembleGeneratedMediaRun(project, manifest, options, adapter);
  }

  const runId = project.run_id ?? project.slug;
  const runDir = join(options.stateDir, runId);
  const manifestOutputPath = join(runDir, "manifest.json");
  const qcReportPath = join(runDir, "gate2-qc.json");
  const runLogPath = join(runDir, "run-log.md");
  const statePath = join(runDir, "state.json");
  const inputDigest = runInputDigest(project, manifest);

  if (options.state.status === "awaiting_gate_2" && options.state.gates.gate_2.status === "awaiting_approval") {
    const resumed = await inspectAwaitingGate2Artifacts({
      runId,
      mode: "local-media",
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
      issues: [
        {
          code: "run.invalid_state",
          message: "run requires a Gate 1 approved running state"
        }
      ]
    };
  }

  const manifestDir = dirname(options.manifestPath);
  const assembled = cloneManifest(manifest);
  let assetCount = 0;

  await mkdir(runDir, { recursive: true });

  for (const [index, clip] of assembled.clips.entries()) {
    const copied = await copyAsset(clip.src, manifestDir, runDir, "assets/clips", index, clip.id);
    clip.src = copied.relativePath;
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

  await writeFile(manifestOutputPath, `${JSON.stringify(assembled, null, 2)}\n`);
  await writeGate2QcReport(assembled, manifestOutputPath, qcReportPath);
  await writeRunLog(runLogPath, {
    runId,
    mode: "local-media",
    assetCount,
    actualCredits: 0,
    inputDigest,
    requests: []
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
    actualCredits: 0,
    alreadyAssembled: false,
    state: nextState,
    statePath: writtenStatePath
  };
}

export async function inspectGate2RunForApproval(
  project: Project,
  manifest: Manifest,
  stateDir: string,
  adapter?: AdapterDefinition
): Promise<Result<ResumeMetrics>> {
  const runId = project.run_id ?? project.slug;
  const runDir = join(stateDir, runId);
  const isGeneration = Boolean(project.generation && project.generation.requests.length > 0);
  return inspectAwaitingGate2Artifacts({
    runId,
    mode: isGeneration ? "generation" : "local-media",
    inputDigest: runInputDigest(project, manifest, isGeneration ? adapter : undefined),
    requireQcPass: true,
    manifestPath: join(runDir, "manifest.json"),
    qcReportPath: join(runDir, "gate2-qc.json"),
    runLogPath: join(runDir, "run-log.md")
  });
}

async function assembleGeneratedMediaRun(
  project: Project,
  manifest: Manifest,
  options: AssembleOptions,
  adapter: AdapterDefinition | undefined
): Promise<Result<LocalRunResult>> {
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
  const inputDigest = runInputDigest(project, manifest, adapter);

  if (options.state.status === "awaiting_gate_2" && options.state.gates.gate_2.status === "awaiting_approval") {
    const resumed = await inspectAwaitingGate2Artifacts({
      runId,
      mode: "generation",
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

  const assembled = cloneManifest(manifest);
  assembled.clips = [];
  assembled.provenance = [];
  let assetCount = 0;

  const manifestDir = dirname(options.manifestPath);
  for (const [index, image] of assembled.images.entries()) {
    const copied = await copyAsset(image.src, manifestDir, runDir, "assets/images", index, image.id);
    image.src = copied.relativePath;
    assetCount += 1;
  }

  const generation = runCliGenerationAdapter(adapter, project.generation!.requests, { runId, runDir });
  if (!generation.ok) return generation;

  for (const [index, clip] of generation.clips.entries()) {
    const copied = await copyAsset(clip.src, process.cwd(), runDir, "assets/clips", index, clip.id);
    assembled.clips.push({
      ...clip,
      src: copied.relativePath
    });
    assetCount += 1;
  }

  for (const request of generation.requests) {
    const original = project.generation!.requests.find((candidate) => candidate.id === request.request_id);
    for (const clip of request.clips) {
      assembled.provenance.push({
        clip_id: clip.id,
        engine: adapter.name,
        model: original?.model,
        params: original?.params,
        credits: request.credits / request.clips.length
      });
    }
  }

  await writeFile(manifestOutputPath, `${JSON.stringify(assembled, null, 2)}\n`);
  await writeGate2QcReport(assembled, manifestOutputPath, qcReportPath);
  await writeRunLog(runLogPath, {
    runId,
    mode: "generation",
    assetCount,
    actualCredits: generation.credits,
    inputDigest,
    requests: generation.requests
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
    actualCredits: generation.credits,
    alreadyAssembled: false,
    state: nextState,
    statePath: writtenStatePath
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
  const relativePath = join(relativeTargetDir, targetName);
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
  inputDigest: string;
  requireQcPass?: boolean;
  manifestPath: string;
  qcReportPath: string;
  runLogPath: string;
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

  const expectedCredits =
    input.mode === "generation"
      ? assembledManifest.manifest.provenance.reduce((sum, entry) => sum + (entry.credits ?? 0), 0)
      : 0;
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

  const freshQcReport = inspectGate2Manifest(assembledManifest.manifest, dirname(input.manifestPath));
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
    actualCredits: runLog.log.actualCredits
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
    log: { runId: string; mode: string; assetCount: number; actualCredits: number; inputDigest: string };
  }>
> {
  try {
    const text = await readFile(path, "utf8");
    const runId = text.match(/^# Run Log: (.+)$/m)?.[1]?.trim();
    const mode = text.match(/^- mode: (.+)$/m)?.[1]?.trim();
    const assetCountText = text.match(/^- asset_count: (.+)$/m)?.[1]?.trim();
    const actualCreditsText = text.match(/^- actual_credits: (.+)$/m)?.[1]?.trim();
    const inputDigest = text.match(/^- input_digest: ([a-f0-9]{64})$/m)?.[1];
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

    return { ok: true, issues: [], log: { runId, mode, assetCount, actualCredits, inputDigest } };
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
    requests: CliGenerationRequestResult[];
  }
): Promise<void> {
  const lines = [
    `# Run Log: ${input.runId}`,
    "",
    `- mode: ${input.mode}`,
    `- asset_count: ${input.assetCount}`,
    `- actual_credits: ${input.actualCredits}`,
    `- input_digest: ${input.inputDigest}`,
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

function runInputDigest(project: Project, manifest: Manifest, adapter?: AdapterDefinition): string {
  return createHash("sha256")
    .update(
      stableJson({
        project: toExecutionProject(project),
        manifest: manifestDigestInput(manifest),
        adapter: adapter ? { ...adapter, root: undefined } : undefined
      })
    )
    .digest("hex");
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
