import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Manifest } from "../manifest/schema.js";
import type { Project } from "../project/schema.js";
import type { Result } from "../types.js";
import { markGateAwaiting, writeState, type RunState } from "./state.js";

export type LocalRunResult = {
  manifestPath: string;
  assetCount: number;
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
  options: AssembleOptions
): Promise<Result<LocalRunResult>> {
  if (project.generation && project.generation.requests.length > 0) {
    return {
      ok: false,
      issues: [
        {
          code: "run.generation_not_implemented",
          message: "generation adapters are scheduled for a later phase"
        }
      ]
    };
  }

  const runId = project.run_id ?? project.slug;
  const runDir = join(options.stateDir, runId);
  const manifestOutputPath = join(runDir, "manifest.json");
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
      assetCount: countManifestAssets(manifest),
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

  const nextState = markGateAwaiting(options.state, "gate_2");
  const writtenStatePath = await writeState(options.stateDir, nextState);

  return {
    ok: true,
    issues: [],
    manifestPath: manifestOutputPath,
    assetCount,
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
