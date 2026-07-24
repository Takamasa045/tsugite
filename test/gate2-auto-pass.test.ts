import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleLocalMediaRun } from "../src/orchestrator/run.js";
import { createPlannedState, markGateAwaiting, recordGateDecision } from "../src/orchestrator/state.js";
import { projectSchema } from "../src/project/schema.js";
import { validateProject } from "../src/project/validateProject.js";

const AUTO_PASS_CONFIG = "fixtures/projects/gate2-auto-pass.yaml";
const AUTO_PASS_MANIFEST = "fixtures/manifests/render-local.valid.json";

function runningState(runId: string) {
  return recordGateDecision(markGateAwaiting(createPlannedState(runId), "gate_1"), "gate_1", "approved");
}

describe("Gate 2 auto-pass opt-in schema", () => {
  it("accepts the documented auto-pass policy on a local-media project", () => {
    const parsed = projectSchema.safeParse({
      slug: "auto-pass",
      manifest: "manifest.json",
      edit: { backend: "remotion" },
      gates: { gate_2: { auto_pass: "qc_ok_no_new_assets" } }
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.gates?.gate_2?.auto_pass).toBe("qc_ok_no_new_assets");
  });

  it("rejects an unknown auto-pass policy value", () => {
    const parsed = projectSchema.safeParse({
      slug: "auto-pass",
      manifest: "manifest.json",
      edit: { backend: "remotion" },
      gates: { gate_2: { auto_pass: true } }
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects auto-pass on a project that always consumes credits through generation", () => {
    const parsed = projectSchema.safeParse({
      slug: "auto-pass",
      manifest: "manifest.json",
      edit: { backend: "remotion" },
      generation: {
        adapter: "mock-cli",
        requests: [{ id: "clip-1", prompt: "fixture", model: "fixture-model", params: {} }]
      },
      gates: { gate_2: { auto_pass: "qc_ok_no_new_assets" } }
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(
      "gates.gate_2.auto_pass cannot be combined with generation requests"
    );
  });
});

describe("Gate 2 auto-pass during local media run", () => {
  it("records an automatic Gate 2 approval when nothing was generated and QC passed", async () => {
    const validation = await validateProject(AUTO_PASS_CONFIG);
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-gate2-auto-pass-"));

    const result = await assembleLocalMediaRun(validation.project!, validation.manifest!, {
      manifestPath: AUTO_PASS_MANIFEST,
      stateDir,
      state: runningState("gate2-auto-pass-run")
    });

    expect(result.ok).toBe(true);
    expect(result.gate2AutoPassed).toBe(true);
    expect(result.gate2AutoPassBlockedReason).toBeUndefined();
    expect(result.state?.status).toBe("rendering");
    expect(result.state?.gates.gate_2.status).toBe("approved");
    expect(result.state?.gates.gate_2.decision_source).toBe("auto_qc");
    expect(result.state?.gates.gate_2.approved_input_digest).toMatch(/^[a-f0-9]{64}$/);

    const runLog = await readFile(result.runLogPath!, "utf8");
    expect(runLog).toContain("- gate_2_auto_pass: qc_ok_no_new_assets");
    expect(runLog).toContain("- gate_2_auto_pass_credits: 0");
    expect(runLog).toContain("- gate_2_auto_pass_generated_assets: 0");
    expect(runLog).toContain("- gate_2_auto_pass_qc_issues: 0");
    // Gate 2 evidence must precede ## Requests. Viewer parsing treats everything after
    // Requests as request lines, so a trailing section breaks pipeline viewer rebuilds.
    const gate2Section = runLog.indexOf("## Gate 2");
    const requestsSection = runLog.indexOf("## Requests");
    expect(gate2Section).toBeGreaterThan(-1);
    expect(requestsSection).toBeGreaterThan(gate2Section);
  });

  it("stops at Gate 2 with a reason when QC reports an issue", async () => {
    const validation = await validateProject(AUTO_PASS_CONFIG);
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-gate2-auto-pass-qc-"));
    const manifest = {
      ...validation.manifest!,
      meta: { ...validation.manifest!.meta, target_duration_seconds: 60 }
    };

    const result = await assembleLocalMediaRun(validation.project!, manifest, {
      manifestPath: AUTO_PASS_MANIFEST,
      stateDir,
      state: runningState("gate2-auto-pass-run")
    });

    expect(result.ok).toBe(true);
    expect(result.gate2AutoPassed).toBe(false);
    expect(result.gate2AutoPassBlockedReason).toBe("qc_issues: 1");
    expect(result.actualCredits).toBe(0);
    expect(result.state?.status).toBe("awaiting_gate_2");
    expect(result.state?.gates.gate_2.status).toBe("awaiting_approval");
    expect(result.state?.gates.gate_2.approved_input_digest).toBeUndefined();
    expect(result.state?.gates.gate_2.decision_source).toBeUndefined();

    const qcReport = JSON.parse(await readFile(result.qcReportPath!, "utf8"));
    expect(qcReport.ok).toBe(false);
    expect(qcReport.issues).toHaveLength(1);

    const runLog = await readFile(result.runLogPath!, "utf8");
    expect(runLog).not.toContain("gate_2_auto_pass");
  });

  it("stops at Gate 2 when the run consumed credits", async () => {
    const validation = await validateProject("fixtures/projects/audio-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-gate2-auto-pass-credits-"));
    const project = {
      ...validation.project!,
      gates: { gate_2: { auto_pass: "qc_ok_no_new_assets" as const } }
    };
    const audioAdapter = {
      ...validation.audioAdapter!,
      command: {
        ...validation.audioAdapter!.command!,
        args: ["fixtures/adapters/mock-cli-audio/generate-paid.mjs"]
      }
    };

    const result = await assembleLocalMediaRun(project, validation.manifest!, {
      manifestPath: "fixtures/manifests/minimal.valid.json",
      stateDir,
      state: runningState("audio-generation-run")
    }, validation.adapter, audioAdapter);

    expect(result.ok).toBe(true);
    expect(result.actualCredits).toBe(0.5);
    expect(result.gate2AutoPassed).toBe(false);
    expect(result.gate2AutoPassBlockedReason).toBe("credits: 0.5");
    expect(result.state?.gates.gate_2.status).toBe("awaiting_approval");
  });

  it("stops at Gate 2 when free assets were newly generated", async () => {
    const validation = await validateProject("fixtures/projects/audio-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-gate2-auto-pass-assets-"));
    const project = {
      ...validation.project!,
      gates: { gate_2: { auto_pass: "qc_ok_no_new_assets" as const } }
    };

    const result = await assembleLocalMediaRun(project, validation.manifest!, {
      manifestPath: "fixtures/manifests/minimal.valid.json",
      stateDir,
      state: runningState("audio-generation-run")
    }, validation.adapter, validation.audioAdapter);

    expect(result.ok).toBe(true);
    expect(result.actualCredits).toBe(0);
    expect(result.gate2AutoPassed).toBe(false);
    expect(result.gate2AutoPassBlockedReason).toBe("generated_assets: 2");
    expect(result.state?.gates.gate_2.status).toBe("awaiting_approval");
  });

  it("keeps the human Gate 2 stop for a project without the opt-in", async () => {
    const validation = await validateProject("fixtures/projects/render-local-media.yaml");
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-gate2-no-opt-in-"));

    const result = await assembleLocalMediaRun(validation.project!, validation.manifest!, {
      manifestPath: AUTO_PASS_MANIFEST,
      stateDir,
      state: runningState("render-local-run")
    });

    expect(result.ok).toBe(true);
    expect(result.gate2AutoPassed).toBe(false);
    expect(result.gate2AutoPassBlockedReason).toBe("not_configured");
    expect(result.state?.status).toBe("awaiting_gate_2");
    expect(result.state?.gates.gate_2.status).toBe("awaiting_approval");
    expect(result.state?.gates.gate_2.decision_source).toBeUndefined();
  });
});
