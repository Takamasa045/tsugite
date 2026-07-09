import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderAssembledMedia } from "../src/orchestrator/render.js";
import { writeGate3QcReport } from "../src/orchestrator/gate3Qc.js";
import { assembleLocalMediaRun } from "../src/orchestrator/run.js";
import {
  createPlannedState,
  markGateAwaiting,
  recordGateDecision
} from "../src/orchestrator/state.js";
import { validateProject } from "../src/project/validateProject.js";

describe("assembled media render", () => {
  it("rejects render before Gate 2 approval", async () => {
    const validation = await validateProject("fixtures/projects/render-local-media.yaml");
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-render-"));

    const result = await renderAssembledMedia(validation.project!, {
      stateDir,
      state: createPlannedState("render-local-run")
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("render.invalid_state");
  });

  it("reports a missing assembled manifest for a rendering state", async () => {
    const validation = await validateProject("fixtures/projects/render-local-media.yaml");
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-render-"));
    const rendering = gate2ApprovedState("render-local-run");

    const result = await renderAssembledMedia(validation.project!, { stateDir, state: rendering });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("render.manifest_missing");
  });

  it("reports a backend without a render runner after assembly", async () => {
    const validation = await validateProject("fixtures/projects/render-local-media.yaml");
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-render-"));
    const gate1 = markGateAwaiting(createPlannedState("render-local-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const assembled = await assembleLocalMediaRun(validation.project!, validation.manifest!, {
      manifestPath: "fixtures/manifests/render-local.valid.json",
      stateDir,
      state: running
    });
    const rendering = recordGateDecision(assembled.state!, "gate_2", "approved");

    const result = await renderAssembledMedia(
      {
        ...validation.project!,
        edit: { backend: "missing-backend" }
      },
      { stateDir, state: rendering }
    );

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("render.backend_not_implemented");
  });

  it("rejects a backend that exits successfully without output files", async () => {
    const validation = await validateProject("fixtures/projects/render-local-media.yaml");
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-render-"));
    const gate1 = markGateAwaiting(createPlannedState("render-local-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const assembled = await assembleLocalMediaRun(validation.project!, validation.manifest!, {
      manifestPath: "fixtures/manifests/render-local.valid.json",
      stateDir,
      state: running
    });
    const rendering = recordGateDecision(assembled.state!, "gate_2", "approved");

    const result = await renderAssembledMedia(
      {
        ...validation.project!,
        edit: { backend: "no-output" }
      },
      { stateDir, state: rendering }
    );

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("render.output_missing");
  });

  it("preserves structured backend failure codes", async () => {
    const validation = await validateProject("fixtures/projects/render-local-media.yaml");
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-render-"));
    const gate1 = markGateAwaiting(createPlannedState("render-local-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const assembled = await assembleLocalMediaRun(validation.project!, validation.manifest!, {
      manifestPath: "fixtures/manifests/render-local.valid.json",
      stateDir,
      state: running
    });
    const rendering = recordGateDecision(assembled.state!, "gate_2", "approved");

    const result = await renderAssembledMedia(
      {
        ...validation.project!,
        edit: { backend: "structured-failure" }
      },
      { stateDir, state: rendering }
    );

    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({
      code: "backend.fixture_failed",
      message: "structured fixture failure"
    });
  });

  it("stops at Gate 3 with a failed QC report when the output cannot be probed", async () => {
    const validation = await validateProject("fixtures/projects/render-local-media.yaml");
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-render-"));
    const gate1 = markGateAwaiting(createPlannedState("render-local-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const assembled = await assembleLocalMediaRun(validation.project!, validation.manifest!, {
      manifestPath: "fixtures/manifests/render-local.valid.json",
      stateDir,
      state: running
    });
    const rendering = recordGateDecision(assembled.state!, "gate_2", "approved");

    const result = await renderAssembledMedia(
      {
        ...validation.project!,
        edit: { backend: "unprobeable" }
      },
      { stateDir, state: rendering }
    );

    expect(result.ok).toBe(true);
    expect(result.state?.status).toBe("awaiting_gate_3");
    const qc = JSON.parse(await readFile(join(stateDir, "render-local-run/gate3-qc.json"), "utf8"));
    expect(qc.ok).toBe(false);
    expect(qc.issues[0]?.code).toBe("gate3.output.probe_failed");
  });

  it("requires the Gate 3 QC report when resuming a rendered output", async () => {
    const validation = await validateProject("fixtures/projects/render-local-media.yaml");
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-render-"));
    await prepareRenderedArtifacts(stateDir);
    const awaitingGate3 = markGateAwaiting(gate2ApprovedState("render-local-run"), "gate_3");

    const result = await renderAssembledMedia(validation.project!, {
      stateDir,
      state: awaitingGate3
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("render.gate3_qc_missing");
  });

  it("rejects an invalid Gate 3 QC report when resuming a rendered output", async () => {
    const validation = await validateProject("fixtures/projects/render-local-media.yaml");
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-render-"));
    const { gate3QcReportPath } = await prepareRenderedArtifacts(stateDir);
    await writeFile(gate3QcReportPath, "{}\n");
    const awaitingGate3 = markGateAwaiting(gate2ApprovedState("render-local-run"), "gate_3");

    const result = await renderAssembledMedia(validation.project!, {
      stateDir,
      state: awaitingGate3
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("render.gate3_qc_invalid");
  });

  it("returns the Gate 3 QC report path when resuming verified output artifacts", async () => {
    const validation = await validateProject("fixtures/projects/render-local-media.yaml");
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-render-"));
    const { manifest, outputPath, gate3QcReportPath } = await prepareRenderedArtifacts(stateDir);
    await writeGate3QcReport(manifest, outputPath, gate3QcReportPath);
    const awaitingGate3 = markGateAwaiting(gate2ApprovedState("render-local-run"), "gate_3");

    const result = await renderAssembledMedia(validation.project!, {
      stateDir,
      state: awaitingGate3
    });

    expect(result.ok).toBe(true);
    expect(result.gate3QcReportPath).toBe(gate3QcReportPath);
    expect(result.alreadyRendered).toBe(true);
  });

  it("rejects a stale Gate 3 QC report after the final output changes", async () => {
    const validation = await validateProject("fixtures/projects/render-local-media.yaml");
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-render-"));
    const { manifest, outputPath, gate3QcReportPath } = await prepareRenderedArtifacts(stateDir);
    await writeGate3QcReport(manifest, outputPath, gate3QcReportPath);
    await writeFile(outputPath, "corrupted after QC\n");
    const awaitingGate3 = markGateAwaiting(gate2ApprovedState("render-local-run"), "gate_3");

    const result = await renderAssembledMedia(validation.project!, {
      stateDir,
      state: awaitingGate3
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("render.gate3_qc_stale");
  });
});

function gate2ApprovedState(runId: string) {
  const gate1 = markGateAwaiting(createPlannedState(runId), "gate_1");
  const running = recordGateDecision(gate1, "gate_1", "approved");
  const gate2 = markGateAwaiting(running, "gate_2");
  return recordGateDecision(gate2, "gate_2", "approved");
}

async function prepareRenderedArtifacts(stateDir: string) {
  const runDir = join(stateDir, "render-local-run");
  const manifestPath = join(runDir, "manifest.json");
  const outputPath = join(runDir, "final.mp4");
  const reportPath = join(runDir, "render-report.json");
  const gate3QcReportPath = join(runDir, "gate3-qc.json");
  const assetPath = join(runDir, "assets/clips/render-001.mp4");
  await mkdir(join(runDir, "assets/clips"), { recursive: true });
  await copyFile("fixtures/media/render-001.mp4", outputPath);
  await copyFile("fixtures/media/render-001.mp4", assetPath);
  const manifest = JSON.parse(await readFile("fixtures/manifests/render-local.valid.json", "utf8"));
  manifest.clips[0].src = "assets/clips/render-001.mp4";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    reportPath,
    `${JSON.stringify({
      backend: "remotion",
      output_path: outputPath,
      manifest_path: manifestPath,
      duration_seconds: 1,
      width: 320,
      height: 180,
      fps: 30,
      clip_count: 1
    })}\n`
  );
  return { runDir, manifest, manifestPath, outputPath, reportPath, gate3QcReportPath };
}
