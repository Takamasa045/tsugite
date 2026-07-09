import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { readJsonFile } from "../io.js";
import { validateManifestAssets } from "../manifest/assets.js";
import { validateManifest } from "../manifest/validate.js";
import type { Project } from "../project/schema.js";
import type { Issue, Result } from "../types.js";
import { inspectGate3Output, validateGate3QcReport, writeGate3QcReport } from "./gate3Qc.js";
import { markGateAwaiting, writeState, type RunState } from "./state.js";

export type RenderResult = {
  outputPath: string;
  reportPath: string;
  gate3QcReportPath: string;
  alreadyRendered: boolean;
  state: RunState;
  statePath: string;
};

type RenderOptions = {
  stateDir: string;
  state: RunState;
};

const backendRenderReportSchema = z
  .object({
    backend: z.string().min(1),
    output_path: z.string().min(1),
    manifest_path: z.string().min(1),
    duration_seconds: z.number().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive()
  })
  .passthrough();

export async function renderAssembledMedia(
  project: Project,
  options: RenderOptions
): Promise<Result<RenderResult>> {
  const runId = project.run_id ?? project.slug;
  const runDir = join(options.stateDir, runId);
  const manifestPath = join(runDir, "manifest.json");
  const outputPath = join(runDir, "final.mp4");
  const reportPath = join(runDir, "render-report.json");
  const gate3QcReportPath = join(runDir, "gate3-qc.json");
  const statePath = join(runDir, "state.json");

  if (options.state.status === "awaiting_gate_3" && options.state.gates.gate_3.status === "awaiting_approval") {
    const inspected = await inspectAwaitingGate3Artifacts(project, options.stateDir, false);
    if (!inspected.ok) return inspected;

    return {
      ok: true,
      issues: [],
      outputPath,
      reportPath,
      gate3QcReportPath,
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

  const manifestResult = await loadAssembledManifest(manifestPath, runDir);
  if (!manifestResult.ok) return manifestResult;

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

  const renderReport = await readBackendRenderReport(reportPath, {
    backend: project.edit.backend,
    outputPath,
    manifestPath
  });
  if (!renderReport.ok) return renderReport;
  const gate3QcReport = await writeGate3QcReport(manifestResult.manifest, outputPath, gate3QcReportPath);
  if (gate3QcReport.actual.ok && !renderReportMatchesProbe(renderReport.report, gate3QcReport.actual)) {
    return {
      ok: false,
      issues: [
        {
          code: "render.report_invalid",
          message: "render report does not match the final output probe",
          path: reportPath
        }
      ]
    };
  }

  const nextState = markGateAwaiting(options.state, "gate_3");
  const writtenStatePath = await writeState(options.stateDir, nextState);

  return {
    ok: true,
    issues: [],
    outputPath,
    reportPath,
    gate3QcReportPath,
    alreadyRendered: false,
    state: nextState,
    statePath: writtenStatePath
  };
}

export async function inspectGate3RunForApproval(project: Project, stateDir: string): Promise<Result<{}>> {
  const inspected = await inspectAwaitingGate3Artifacts(project, stateDir, true);
  return inspected.ok ? { ok: true, issues: [] } : { ok: false, issues: inspected.issues };
}

async function inspectAwaitingGate3Artifacts(
  project: Project,
  stateDir: string,
  requireQcPass: boolean
): Promise<Result<{}>> {
  const runId = project.run_id ?? project.slug;
  const runDir = join(stateDir, runId);
  const manifestPath = join(runDir, "manifest.json");
  const outputPath = join(runDir, "final.mp4");
  const reportPath = join(runDir, "render-report.json");
  const gate3QcReportPath = join(runDir, "gate3-qc.json");
  if (!(await isFile(outputPath)) || !(await isFile(reportPath))) {
    return {
      ok: false,
      issues: [{ code: "render.output_missing", message: "render output is missing for the awaiting Gate 3 state" }]
    };
  }
  if (!(await isFile(gate3QcReportPath))) {
    return {
      ok: false,
      issues: [
        {
          code: "render.gate3_qc_missing",
          message: "Gate 3 QC report is missing for the awaiting Gate 3 state",
          path: gate3QcReportPath
        }
      ]
    };
  }
  const manifestResult = await loadAssembledManifest(manifestPath, runDir);
  if (!manifestResult.ok) return manifestResult;
  const renderReport = await readBackendRenderReport(reportPath, {
    backend: project.edit.backend,
    outputPath,
    manifestPath
  });
  if (!renderReport.ok) return renderReport;
  try {
    const gate3Qc = validateGate3QcReport(await readJsonFile(gate3QcReportPath), outputPath);
    if (!gate3Qc.ok) return gate3Qc;
    const freshGate3Qc = inspectGate3Output(manifestResult.manifest, outputPath);
    if (JSON.stringify(gate3Qc.report) !== JSON.stringify(freshGate3Qc)) {
      return {
        ok: false,
        issues: [
          {
            code: "render.gate3_qc_stale",
            message: "Gate 3 QC report no longer matches the final output and render contract",
            path: gate3QcReportPath
          }
        ]
      };
    }
    if (freshGate3Qc.actual.ok && !renderReportMatchesProbe(renderReport.report, freshGate3Qc.actual)) {
      return {
        ok: false,
        issues: [
          {
            code: "render.report_invalid",
            message: "render report does not match the final output probe",
            path: reportPath
          }
        ]
      };
    }
    if (requireQcPass && !freshGate3Qc.ok) {
      return {
        ok: false,
        issues: [
          {
            code: "render.gate3_qc_failed",
            message: "Gate 3 QC must pass before approval; use re-render or abort",
            path: gate3QcReportPath
          }
        ]
      };
    }
    return { ok: true, issues: [] };
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: "render.gate3_qc_invalid",
          message: error instanceof Error ? error.message : String(error),
          path: gate3QcReportPath
        }
      ]
    };
  }
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

async function loadAssembledManifest(
  manifestPath: string,
  runDir: string
): Promise<Result<{ manifest: NonNullable<ReturnType<typeof validateManifest>["manifest"]> }>> {
  if (!(await isFile(manifestPath))) {
    return {
      ok: false,
      issues: [{ code: "render.manifest_missing", message: "assembled manifest is missing", path: manifestPath }]
    };
  }

  try {
    const manifestResult = validateManifest(await readJsonFile(manifestPath));
    if (!manifestResult.ok || !manifestResult.manifest) {
      return { ok: false, issues: manifestResult.issues };
    }
    const assetResult = await validateManifestAssets(manifestResult.manifest, dirname(manifestPath), { assetRoot: runDir });
    if (!assetResult.ok) return assetResult;
    return { ok: true, issues: [], manifest: manifestResult.manifest };
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: "render.manifest_invalid",
          message: error instanceof Error ? error.message : String(error),
          path: manifestPath
        }
      ]
    };
  }
}

async function readBackendRenderReport(
  reportPath: string,
  expected: { backend: string; outputPath: string; manifestPath: string }
): Promise<Result<{ report: z.infer<typeof backendRenderReportSchema> }>> {
  try {
    const parsed = backendRenderReportSchema.safeParse(await readJsonFile(reportPath));
    if (
      !parsed.success ||
      parsed.data.backend !== expected.backend ||
      resolve(parsed.data.output_path) !== resolve(expected.outputPath) ||
      resolve(parsed.data.manifest_path) !== resolve(expected.manifestPath)
    ) {
      return {
        ok: false,
        issues: [
          {
            code: "render.report_invalid",
            message: parsed.success
              ? "render report does not match the selected backend and run artifacts"
              : parsed.error.issues[0]?.message ?? "invalid render report",
            path: reportPath
          }
        ]
      };
    }
    return { ok: true, issues: [], report: parsed.data };
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: "render.report_invalid",
          message: error instanceof Error ? error.message : String(error),
          path: reportPath
        }
      ]
    };
  }
}

function renderReportMatchesProbe(
  report: z.infer<typeof backendRenderReportSchema>,
  probe: { ok: boolean; duration_seconds?: number; width?: number; height?: number; fps?: number }
): boolean {
  return (
    probe.ok &&
    probe.duration_seconds !== undefined &&
    probe.width !== undefined &&
    probe.height !== undefined &&
    probe.fps !== undefined &&
    Math.abs(report.duration_seconds - probe.duration_seconds) <= 0.01 &&
    report.width === probe.width &&
    report.height === probe.height &&
    Math.abs(report.fps - probe.fps) <= 0.01
  );
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
