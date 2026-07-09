import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readJsonFile } from "../io.js";
import { validateManifestAssets } from "../manifest/assets.js";
import { validateManifest } from "../manifest/validate.js";
import type { Project } from "../project/schema.js";
import type { Issue, Result } from "../types.js";
import { markGateAwaiting, writeState, type RunState } from "./state.js";

export type RenderResult = {
  outputPath: string;
  reportPath: string;
  alreadyRendered: boolean;
  state: RunState;
  statePath: string;
};

type RenderOptions = {
  stateDir: string;
  state: RunState;
};

export async function renderAssembledMedia(
  project: Project,
  options: RenderOptions
): Promise<Result<RenderResult>> {
  const runId = project.run_id ?? project.slug;
  const runDir = join(options.stateDir, runId);
  const manifestPath = join(runDir, "manifest.json");
  const outputPath = join(runDir, "final.mp4");
  const reportPath = join(runDir, "render-report.json");
  const statePath = join(runDir, "state.json");

  if (options.state.status === "awaiting_gate_3" && options.state.gates.gate_3.status === "awaiting_approval") {
    if (!(await isFile(outputPath)) || !(await isFile(reportPath))) {
      return {
        ok: false,
        issues: [{ code: "render.output_missing", message: "render output is missing for the awaiting Gate 3 state" }]
      };
    }

    return {
      ok: true,
      issues: [],
      outputPath,
      reportPath,
      alreadyRendered: true,
      state: options.state,
      statePath
    };
  }

  if (options.state.status !== "rendering" || options.state.gates.gate_2.status !== "approved") {
    return {
      ok: false,
      issues: [{ code: "render.invalid_state", message: "render requires a Gate 2 approved rendering state" }]
    };
  }

  if (!(await isFile(manifestPath))) {
    return {
      ok: false,
      issues: [{ code: "render.manifest_missing", message: "assembled manifest is missing", path: manifestPath }]
    };
  }

  const manifestInput = await readJsonFile(manifestPath);
  const manifestResult = validateManifest(manifestInput);
  if (!manifestResult.ok || !manifestResult.manifest) {
    return { ok: false, issues: manifestResult.issues };
  }

  const assetResult = await validateManifestAssets(manifestResult.manifest, dirname(manifestPath), {
    assetRoot: runDir
  });
  if (!assetResult.ok) return assetResult;

  const backendResult = await runBackend(project.edit.backend, {
    manifestPath,
    runDir,
    outputPath,
    reportPath
  });
  if (!backendResult.ok) return backendResult;
  if (!(await isFile(outputPath)) || !(await isFile(reportPath))) {
    return {
      ok: false,
      issues: [{ code: "render.output_missing", message: "backend completed without render output" }]
    };
  }

  const nextState = markGateAwaiting(options.state, "gate_3");
  const writtenStatePath = await writeState(options.stateDir, nextState);

  return {
    ok: true,
    issues: [],
    outputPath,
    reportPath,
    alreadyRendered: false,
    state: nextState,
    statePath: writtenStatePath
  };
}

async function runBackend(
  backend: string,
  payload: { manifestPath: string; runDir: string; outputPath: string; reportPath: string }
): Promise<Result<{}>> {
  const scriptPath = resolve("backends", backend, "render.mjs");
  if (!(await isFile(scriptPath))) {
    return {
      ok: false,
      issues: [{ code: "render.backend_not_implemented", message: `backend '${backend}' has no render runner` }]
    };
  }

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    input: `${JSON.stringify(payload)}\n`,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20
  });

  if (result.error) {
    return {
      ok: false,
      issues: [{ code: "render.backend_failed", message: result.error.message }]
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      issues: [backendFailureIssue(result.stderr, result.stdout)]
    };
  }

  return { ok: true, issues: [] };
}

function renderErrorMessage(stderr: string, stdout: string): string {
  const text = `${stderr}\n${stdout}`.trim();
  return text.length > 0 ? text.slice(0, 2000) : "backend render failed";
}

function backendFailureIssue(stderr: string, stdout: string): Issue {
  try {
    const parsed = JSON.parse(stdout) as { code?: unknown; issue?: { code?: unknown; message?: unknown }; message?: unknown };
    const code = typeof parsed.code === "string" ? parsed.code : parsed.issue?.code;
    const message =
      typeof parsed.message === "string"
        ? parsed.message
        : typeof parsed.issue?.message === "string"
          ? parsed.issue.message
          : renderErrorMessage(stderr, stdout);
    if (typeof code === "string" && code.length > 0) {
      return { code, message };
    }
  } catch {
    // Fall through to the generic backend failure.
  }

  return { code: "render.backend_failed", message: renderErrorMessage(stderr, stdout) };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
