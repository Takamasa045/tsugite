import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderAssembledMedia } from "../src/orchestrator/render.js";
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
});

function gate2ApprovedState(runId: string) {
  const gate1 = markGateAwaiting(createPlannedState(runId), "gate_1");
  const running = recordGateDecision(gate1, "gate_1", "approved");
  const gate2 = markGateAwaiting(running, "gate_2");
  return recordGateDecision(gate2, "gate_2", "approved");
}
