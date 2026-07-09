import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPlannedState,
  markGateAwaiting,
  readState,
  recordGateDecision,
  writeState
} from "../src/orchestrator/state.js";

describe("run state", () => {
  it("writes and reads state by run id", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-state-"));
    const path = await writeState(root, {
      run_id: "run-001",
      status: "dry_run",
      updated_at: "2026-07-09T00:00:00.000Z",
      gates: {
        gate_1: { status: "pending" },
        gate_2: { status: "pending" },
        gate_3: { status: "pending" }
      }
    });

    const state = await readState(path);

    expect(state.run_id).toBe("run-001");
    expect(state.status).toBe("dry_run");
  });

  it("tracks gate 1-3 decisions without skipping approval states", () => {
    const planned = createPlannedState("run-002", "2026-07-09T00:00:00.000Z");
    const awaitingGate1 = markGateAwaiting(planned, "gate_1", "2026-07-09T00:01:00.000Z");
    const approvedGate1 = recordGateDecision(awaitingGate1, "gate_1", "approved", "2026-07-09T00:02:00.000Z");

    expect(awaitingGate1.status).toBe("awaiting_gate_1");
    expect(awaitingGate1.gates.gate_1.status).toBe("awaiting_approval");
    expect(approvedGate1.status).toBe("running");
    expect(approvedGate1.gates.gate_1.status).toBe("approved");
    expect(() => recordGateDecision(planned, "gate_2", "approved", "2026-07-09T00:03:00.000Z")).toThrow(
      "cannot decide gate_2 before gate_1 is approved"
    );
  });

  it("rejects out-of-order gate progression", () => {
    const planned = createPlannedState("run-003", "2026-07-09T00:00:00.000Z");
    const gate1 = markGateAwaiting(planned, "gate_1", "2026-07-09T00:01:00.000Z");
    const afterGate1 = recordGateDecision(gate1, "gate_1", "approved", "2026-07-09T00:02:00.000Z");

    expect(() => markGateAwaiting(planned, "gate_3", "2026-07-09T00:03:00.000Z")).toThrow(
      "cannot await gate_3 before gate_2 is approved"
    );
    expect(() => markGateAwaiting(afterGate1, "gate_3", "2026-07-09T00:04:00.000Z")).toThrow(
      "cannot await gate_3 before gate_2 is approved"
    );
  });

  it("migrates legacy state files without gate details", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-state-"));
    const path = join(root, "state.json");
    await writeFile(
      path,
      JSON.stringify({
        run_id: "legacy-run",
        status: "dry_run",
        updated_at: "2026-07-09T00:00:00.000Z"
      })
    );

    const state = await readState(path);

    expect(state.gates.gate_1.status).toBe("pending");
    expect(state.gates.gate_2.status).toBe("pending");
    expect(state.gates.gate_3.status).toBe("pending");
  });

  it("rejects persisted state files that skip gate order", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-state-"));
    const path = join(root, "state.json");
    await writeFile(
      path,
      JSON.stringify({
        run_id: "bad-run",
        status: "awaiting_gate_2",
        updated_at: "2026-07-09T00:00:00.000Z",
        gates: {
          gate_1: { status: "pending" },
          gate_2: { status: "awaiting_approval" },
          gate_3: { status: "pending" }
        }
      })
    );

    await expect(readState(path)).rejects.toThrow("invalid run state: gate_2 requires gate_1 approval");
  });

  it("rejects unsafe state run ids before writing paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-state-"));

    await expect(
      writeState(root, {
        run_id: "../escaped",
        status: "planned",
        updated_at: "2026-07-09T00:00:00.000Z",
        gates: {
          gate_1: { status: "pending" },
          gate_2: { status: "pending" },
          gate_3: { status: "pending" }
        }
      })
    ).rejects.toThrow("must be a safe id");
  });

  it("rejects persisted planned states with approved gates", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-state-"));
    const path = join(root, "state.json");
    await writeFile(
      path,
      JSON.stringify({
        run_id: "bad-run",
        status: "planned",
        updated_at: "2026-07-09T00:00:00.000Z",
        gates: {
          gate_1: { status: "approved" },
          gate_2: { status: "pending" },
          gate_3: { status: "pending" }
        }
      })
    );

    await expect(readState(path)).rejects.toThrow("invalid run state: planned cannot contain progressed gates");
  });

  it("resets gate decisions after a downstream revise so approval can restart", () => {
    const planned = createPlannedState("run-004", "2026-07-09T00:00:00.000Z");
    const gate1 = markGateAwaiting(planned, "gate_1", "2026-07-09T00:01:00.000Z");
    const running = recordGateDecision(gate1, "gate_1", "approved", "2026-07-09T00:02:00.000Z");
    const gate2 = markGateAwaiting(running, "gate_2", "2026-07-09T00:03:00.000Z");
    const revised = recordGateDecision(gate2, "gate_2", "revise", "2026-07-09T00:04:00.000Z");
    const restarted = recordGateDecision(
      markGateAwaiting(revised, "gate_1", "2026-07-09T00:05:00.000Z"),
      "gate_1",
      "approved",
      "2026-07-09T00:06:00.000Z"
    );

    expect(revised.status).toBe("planned");
    expect(revised.gates.gate_1.status).toBe("pending");
    expect(revised.gates.gate_2.status).toBe("pending");
    expect(restarted.status).toBe("running");
    expect(restarted.gates.gate_2.status).toBe("pending");
  });

  it("returns only Gate 3 to rendering when a re-render is requested", () => {
    const planned = createPlannedState("run-005", "2026-07-09T00:00:00.000Z");
    const gate1 = markGateAwaiting(planned, "gate_1", "2026-07-09T00:01:00.000Z");
    const running = recordGateDecision(gate1, "gate_1", "approved", "2026-07-09T00:02:00.000Z");
    const gate2 = markGateAwaiting(running, "gate_2", "2026-07-09T00:03:00.000Z");
    const rendering = recordGateDecision(gate2, "gate_2", "approved", "2026-07-09T00:04:00.000Z");
    const gate3 = markGateAwaiting(rendering, "gate_3", "2026-07-09T00:05:00.000Z");

    const rerendering = recordGateDecision(gate3, "gate_3", "re_render", "2026-07-09T00:06:00.000Z");

    expect(rerendering.status).toBe("rendering");
    expect(rerendering.gates.gate_1.status).toBe("approved");
    expect(rerendering.gates.gate_2.status).toBe("approved");
    expect(rerendering.gates.gate_3.status).toBe("pending");
  });

  it("rejects a re-render decision outside Gate 3", () => {
    const planned = createPlannedState("run-006", "2026-07-09T00:00:00.000Z");
    const gate1 = markGateAwaiting(planned, "gate_1", "2026-07-09T00:01:00.000Z");

    expect(() => recordGateDecision(gate1, "gate_1", "re_render", "2026-07-09T00:02:00.000Z")).toThrow(
      "re_render is only valid for gate_3"
    );
  });
});
