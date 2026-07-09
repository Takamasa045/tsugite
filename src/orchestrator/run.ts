import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { runCliGenerationAdapter, type CliGenerationRequestResult } from "../adapters/cliGeneration.js";
import type { AdapterDefinition } from "../adapters/registry.js";
import type { Manifest } from "../manifest/schema.js";
import type { Project } from "../project/schema.js";
import type { Result } from "../types.js";
import { writeGate2QcReport } from "./gate2Qc.js";
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

  if (options.state.status === "awaiting_gate_2" && options.state.gates.gate_2.status === "awaiting_approval") {
    if (!(await isFile(manifestOutputPath))) {
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

    return {
      ok: true,
      issues: [],
      manifestPath: manifestOutputPath,
      qcReportPath,
      runLogPath,
      assetCount: countManifestAssets(manifest),
      actualCredits: 0,
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

  if (options.state.status === "awaiting_gate_2" && options.state.gates.gate_2.status === "awaiting_approval") {
    if (!(await isFile(manifestOutputPath))) {
      return {
        ok: false,
        issues: [{ code: "run.manifest_missing", message: "assembled manifest is missing for the awaiting Gate 2 state" }]
      };
    }

    return {
      ok: true,
      issues: [],
      manifestPath: manifestOutputPath,
      qcReportPath,
      runLogPath,
      assetCount: countManifestAssets(manifest),
      actualCredits: 0,
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

  const generation = runCliGenerationAdapter(adapter, project.generation!.requests, { runId, runDir });
  if (!generation.ok) return generation;

  const assembled = cloneManifest(manifest);
  assembled.clips = [];
  assembled.provenance = [];
  let assetCount = 0;

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

function countManifestAssets(manifest: Manifest): number {
  return (
    manifest.clips.length +
    manifest.audio.bgm.filter((entry) => entry.src).length +
    manifest.audio.narration.filter((entry) => entry.src).length +
    manifest.audio.sfx.filter((entry) => entry.src).length
  );
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function writeRunLog(
  path: string,
  input: {
    runId: string;
    mode: string;
    assetCount: number;
    actualCredits: number;
    requests: CliGenerationRequestResult[];
  }
): Promise<void> {
  const lines = [
    `# Run Log: ${input.runId}`,
    "",
    `- mode: ${input.mode}`,
    `- asset_count: ${input.assetCount}`,
    `- actual_credits: ${input.actualCredits}`,
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
