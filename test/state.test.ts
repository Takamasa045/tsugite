import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readState, writeState } from "../src/orchestrator/state.js";

describe("run state", () => {
  it("writes and reads state by run id", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-state-"));
    const path = await writeState(root, {
      run_id: "run-001",
      status: "dry_run",
      updated_at: "2026-07-09T00:00:00.000Z"
    });

    const state = await readState(path);

    expect(state.run_id).toBe("run-001");
    expect(state.status).toBe("dry_run");
  });
});
