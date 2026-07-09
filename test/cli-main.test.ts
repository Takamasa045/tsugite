import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";

async function capture(args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

  const status = await main(args);
  const stdout = log.mock.calls.map((call) => String(call[0])).join("\n");
  const stderr = error.mock.calls.map((call) => String(call[0])).join("\n");

  log.mockRestore();
  error.mockRestore();

  return { status, stdout, stderr };
}

describe("pipeline main", () => {
  it("reports doctor checks", async () => {
    const result = await capture(["doctor", "--json"]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).command).toBe("doctor");
  });

  it("requires a command and config where appropriate", async () => {
    const noCommand = await capture([]);
    const noConfig = await capture(["validate", "--json"]);

    expect(noCommand.status).toBe(1);
    expect(noConfig.status).toBe(1);
    expect(JSON.parse(noConfig.stderr).issues[0].code).toBe("cli.config_missing");
  });

  it("returns plan output", async () => {
    const result = await capture(["plan", "--config", "fixtures/projects/local-valid.yaml", "--json"]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).plan.steps[1].name).toBe("gate-1");
  });

  it("blocks non-dry-run execution in Phase 0", async () => {
    const result = await capture(["run", "--config", "fixtures/projects/local-valid.yaml", "--json"]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).issues[0].code).toBe("cli.coordinator_required");
  });

  it("records gate 1 approval only for the coordinator", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-cli-state-"));
    const denied = await capture([
      "gate",
      "--config",
      "fixtures/projects/local-media-only.yaml",
      "--gate",
      "gate-1",
      "--decision",
      "approve",
      "--state-dir",
      stateDir,
      "--json"
    ]);
    const approved = await capture([
      "gate",
      "--config",
      "fixtures/projects/local-media-only.yaml",
      "--gate",
      "gate-1",
      "--decision",
      "approve",
      "--actor",
      "coordinator",
      "--state-dir",
      stateDir,
      "--json"
    ]);

    expect(denied.status).toBe(1);
    expect(JSON.parse(denied.stderr).issues[0].code).toBe("cli.coordinator_required");
    expect(approved.status).toBe(0);
    expect(JSON.parse(approved.stdout).state.status).toBe("running");
  });

  it("assembles a local-media run after gate 1 approval", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-cli-state-"));
    const blocked = await capture([
      "run",
      "--config",
      "fixtures/projects/local-media-only.yaml",
      "--actor",
      "coordinator",
      "--state-dir",
      stateDir,
      "--json"
    ]);
    await capture([
      "gate",
      "--config",
      "fixtures/projects/local-media-only.yaml",
      "--gate",
      "gate-1",
      "--decision",
      "approve",
      "--actor",
      "coordinator",
      "--state-dir",
      stateDir,
      "--json"
    ]);
    const run = await capture([
      "run",
      "--config",
      "fixtures/projects/local-media-only.yaml",
      "--actor",
      "coordinator",
      "--state-dir",
      stateDir,
      "--json"
    ]);
    const rerun = await capture([
      "run",
      "--config",
      "fixtures/projects/local-media-only.yaml",
      "--actor",
      "coordinator",
      "--state-dir",
      stateDir,
      "--json"
    ]);
    const payload = JSON.parse(run.stdout);
    const rerunPayload = JSON.parse(rerun.stdout);
    const assembledManifest = JSON.parse(await readFile(payload.manifest_path, "utf8"));
    const copiedClip = join(stateDir, "local-media-only-run", assembledManifest.clips[0].src);

    expect(blocked.status).toBe(1);
    expect(JSON.parse(blocked.stderr).issues[0].code).toBe("run.requires_gate_1_approval");
    expect(run.status).toBe(0);
    expect(payload.state.status).toBe("awaiting_gate_2");
    expect(payload.asset_count).toBe(2);
    expect(assembledManifest.clips[0].src).toBe("assets/clips/001-clip-001.mp4");
    expect(rerun.status).toBe(0);
    expect(rerunPayload.already_assembled).toBe(true);
    expect(rerunPayload.state.status).toBe("awaiting_gate_2");
    await expect(stat(copiedClip)).resolves.toMatchObject({ size: expect.any(Number) });
  });

  it("keeps generation runs behind the later implementation boundary", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-cli-state-"));
    await capture([
      "gate",
      "--config",
      "fixtures/projects/local-valid.yaml",
      "--gate",
      "gate-1",
      "--decision",
      "approve",
      "--actor",
      "coordinator",
      "--state-dir",
      stateDir,
      "--json"
    ]);
    const run = await capture([
      "run",
      "--config",
      "fixtures/projects/local-valid.yaml",
      "--actor",
      "coordinator",
      "--state-dir",
      stateDir,
      "--json"
    ]);

    expect(run.status).toBe(1);
    expect(JSON.parse(run.stderr).issues[0].code).toBe("run.generation_not_implemented");
  });

  it("requires gate 2 approval before render", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-cli-state-"));
    const blocked = await capture([
      "render",
      "--config",
      "fixtures/projects/local-media-only.yaml",
      "--actor",
      "coordinator",
      "--state-dir",
      stateDir,
      "--json"
    ]);
    const runDir = join(stateDir, "local-media-only-run");
    await mkdir(runDir);
    await writeFile(
      join(runDir, "state.json"),
      JSON.stringify({
        run_id: "local-media-only-run",
        status: "rendering",
        updated_at: "2026-07-09T00:00:00.000Z",
        gates: {
          gate_1: { status: "approved" },
          gate_2: { status: "approved" },
          gate_3: { status: "pending" }
        }
      })
    );
    const render = await capture([
      "render",
      "--config",
      "fixtures/projects/local-media-only.yaml",
      "--actor",
      "coordinator",
      "--state-dir",
      stateDir,
      "--json"
    ]);

    expect(blocked.status).toBe(1);
    expect(JSON.parse(blocked.stderr).issues[0].code).toBe("render.requires_gate_2_approval");
    expect(render.status).toBe(1);
    expect(JSON.parse(render.stderr).issues[0].code).toBe("render.manifest_missing");
  });

  it(
    "renders a local-media project after gate 2 approval",
    async () => {
      const stateDir = await mkdtemp(join(tmpdir(), "tsugite-cli-state-"));
      const config = "fixtures/projects/render-local-media.yaml";

      await capture([
        "gate",
        "--config",
        config,
        "--gate",
        "gate-1",
        "--decision",
        "approve",
        "--actor",
        "coordinator",
        "--state-dir",
        stateDir,
        "--json"
      ]);
      await capture(["run", "--config", config, "--actor", "coordinator", "--state-dir", stateDir, "--json"]);
      await capture([
        "gate",
        "--config",
        config,
        "--gate",
        "gate-2",
        "--decision",
        "approve",
        "--actor",
        "coordinator",
        "--state-dir",
        stateDir,
        "--json"
      ]);

      const render = await capture([
        "render",
        "--config",
        config,
        "--actor",
        "coordinator",
        "--state-dir",
        stateDir,
        "--json"
      ]);
      const rerender = await capture([
        "render",
        "--config",
        config,
        "--actor",
        "coordinator",
        "--state-dir",
        stateDir,
        "--json"
      ]);
      const payload = JSON.parse(render.stdout);
      const rerenderPayload = JSON.parse(rerender.stdout);
      const report = JSON.parse(await readFile(payload.report_path, "utf8"));
      const completed = await capture([
        "gate",
        "--config",
        config,
        "--gate",
        "gate-3",
        "--decision",
        "approve",
        "--actor",
        "coordinator",
        "--state-dir",
        stateDir,
        "--json"
      ]);

      expect(render.status).toBe(0);
      expect(payload.state.status).toBe("awaiting_gate_3");
      expect(payload.already_rendered).toBe(false);
      expect(report.width).toBe(320);
      expect(report.height).toBe(180);
      expect(report.duration_seconds).toBeGreaterThan(0);
      await expect(stat(payload.output_path)).resolves.toMatchObject({ size: expect.any(Number) });
      expect(rerender.status).toBe(0);
      expect(rerenderPayload.already_rendered).toBe(true);
      expect(JSON.parse(completed.stdout).state.status).toBe("completed");
    },
    60000
  );

  it("allows gate 1 to be approved again after revise returns to planning", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-cli-state-"));
    await capture([
      "gate",
      "--config",
      "fixtures/projects/local-media-only.yaml",
      "--gate",
      "gate-1",
      "--decision",
      "revise",
      "--actor",
      "coordinator",
      "--state-dir",
      stateDir,
      "--json"
    ]);
    const approved = await capture([
      "gate",
      "--config",
      "fixtures/projects/local-media-only.yaml",
      "--gate",
      "gate-1",
      "--decision",
      "approve",
      "--actor",
      "coordinator",
      "--state-dir",
      stateDir,
      "--json"
    ]);

    expect(approved.status).toBe(0);
    expect(JSON.parse(approved.stdout).state.status).toBe("running");
  });

  it("rejects state files from a different run id", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-cli-state-"));
    const runDir = join(stateDir, "local-media-only-run");
    await mkdir(runDir);
    await writeFile(
      join(runDir, "state.json"),
      JSON.stringify({
        run_id: "other-run",
        status: "running",
        updated_at: "2026-07-09T00:00:00.000Z",
        gates: {
          gate_1: { status: "approved" },
          gate_2: { status: "pending" },
          gate_3: { status: "pending" }
        }
      })
    );

    const result = await capture([
      "run",
      "--config",
      "fixtures/projects/local-media-only.yaml",
      "--actor",
      "coordinator",
      "--state-dir",
      stateDir,
      "--json"
    ]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).issues[0].code).toBe("state.run_id_mismatch");
  });

  it("reports render and unknown command as explicit errors", async () => {
    const render = await capture(["render", "--config", "fixtures/projects/local-valid.yaml", "--json"]);
    const unknown = await capture(["missing", "--config", "fixtures/projects/local-valid.yaml", "--json"]);

    expect(render.status).toBe(1);
    expect(unknown.status).toBe(1);
    expect(JSON.parse(render.stderr).issues[0].code).toBe("cli.coordinator_required");
    expect(JSON.parse(unknown.stderr).issues[0].code).toBe("cli.command_unknown");
  });
});
