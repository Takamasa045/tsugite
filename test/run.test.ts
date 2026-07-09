import { mkdtemp } from "node:fs/promises";
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
});
