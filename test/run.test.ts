import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleLocalMediaRun } from "../src/orchestrator/run.js";
import {
  createPlannedState,
  markGateAwaiting,
  recordGateDecision
} from "../src/orchestrator/state.js";
import { validateProject } from "../src/project/validateProject.js";

describe("local media run assembly", () => {
  it("rejects assembly before Gate 1 has approved a running state", async () => {
    const validation = await validateProject("fixtures/projects/local-media-only.yaml");
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-run-"));

    const result = await assembleLocalMediaRun(validation.project!, validation.manifest!, {
      manifestPath: "fixtures/manifests/minimal.valid.json",
      stateDir,
      state: createPlannedState("local-media-only-run")
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.invalid_state");
  });

  it("reports a missing assembled manifest for an awaiting Gate 2 state", async () => {
    const validation = await validateProject("fixtures/projects/local-media-only.yaml");
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-run-"));
    const gate1 = markGateAwaiting(createPlannedState("local-media-only-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const awaitingGate2 = markGateAwaiting(running, "gate_2");

    const result = await assembleLocalMediaRun(validation.project!, validation.manifest!, {
      manifestPath: "fixtures/manifests/minimal.valid.json",
      stateDir,
      state: awaitingGate2
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.manifest_missing");
  });

  it("assembles generated clips from a cli adapter command", async () => {
    const validation = await validateProject("fixtures/projects/cli-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-run-"));
    const gate1 = markGateAwaiting(createPlannedState("cli-generation-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");

    const result = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: running
      },
      validation.adapter
    );

    expect(result.ok).toBe(true);
    expect(result.assetCount).toBe(1);
    expect(result.actualCredits).toBe(0.25);
    expect(result.state?.status).toBe("awaiting_gate_2");

    const manifest = JSON.parse(await readFile(result.manifestPath!, "utf8"));
    const qc = JSON.parse(await readFile(result.qcReportPath!, "utf8"));
    const runLog = await readFile(result.runLogPath!, "utf8");

    expect(manifest.clips[0].id).toBe("generated-001-clip");
    expect(manifest.clips[0].src).toBe("assets/clips/001-generated-001-clip.mp4");
    expect(manifest.provenance[0].credits).toBe(0.25);
    expect(qc.asset_count).toBe(1);
    expect(runLog).toContain("actual_credits: 0.25");
  });

  it("retries retryable cli adapter exits", async () => {
    const validation = await validateProject("fixtures/projects/cli-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-run-"));
    const gate1 = markGateAwaiting(createPlannedState("cli-generation-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const project = {
      ...validation.project!,
      generation: {
        adapter: validation.project!.generation!.adapter,
        requests: [
          {
            ...validation.project!.generation!.requests[0],
            params: { fail_once: true }
          }
        ]
      }
    };

    const result = await assembleLocalMediaRun(
      project,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: running
      },
      validation.adapter
    );
    const runLog = await readFile(result.runLogPath!, "utf8");

    expect(result.ok).toBe(true);
    expect(runLog).toContain("attempts=2");
  });

  it("rejects cli generation adapters without a command", async () => {
    const validation = await validateProject("fixtures/projects/no-command-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-run-"));
    const gate1 = markGateAwaiting(createPlannedState("no-command-generation-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");

    const result = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: running
      },
      validation.adapter
    );

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.adapter_command_missing");
  });
});
