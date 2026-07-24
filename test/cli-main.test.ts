import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBackendCapabilities } from "../src/backends/capabilities.js";
import { main } from "../src/cli.js";
import {
  acquireRunLock,
  LAUNCHER_EXPECTED_APPROVAL_DIGEST_ENV
} from "../src/orchestrator/state.js";

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

async function prepareReview(config: string, stateDir: string) {
  const result = await capture(["review", "--config", config, "--state-dir", stateDir, "--json"]);
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

describe("pipeline main", () => {
  it("reports doctor checks", async () => {
    const result = await capture(["doctor", "--json"]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).command).toBe("doctor");
    expect(JSON.parse(result.stdout).checks.map((check: { name: string }) => check.name)).toEqual(
      expect.arrayContaining(["node", "ffprobe"])
    );
  });

  it("reports config-aware doctor checks without generation or render commands", async () => {
    const result = await capture([
      "doctor",
      "--config",
      "fixtures/projects/local-media-only.yaml",
      "--json"
    ]);

    const payload = JSON.parse(result.stdout);
    expect(result.status).toBe(0);
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "project", ok: true }),
        expect.objectContaining({ name: "backend:remotion", ok: true })
      ])
    );
  });

  it("lists registered presentation presets for a backend without requiring a project", async () => {
    const backend = await loadBackendCapabilities("remotion");
    const result = await capture(["presets", "--backend", "remotion", "--json"]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      command: "presets",
      backend: "remotion",
      presets: backend?.capabilities.presets
    });
    expect(backend?.capabilities.presets).toEqual(expect.arrayContaining([
      "article-dialogue-16x9",
      "street-dialogue-16x9"
    ]));
  });

  it("validates the backend argument for the read-only presets command", async () => {
    const missing = await capture(["presets", "--json"]);
    const missingValue = await capture(["presets", "--backend", "--json"]);
    const unknown = await capture(["presets", "--backend", "unknown-backend", "--json"]);
    const safeUnknown = await capture(["presets", "--backend", "Unknown_backend.v2", "--json"]);
    const unsafe = await capture(["presets", "--backend", "../outside", "--json"]);
    const unsupported = await capture([
      "presets",
      "--backend",
      "remotion",
      "--config",
      "fixtures/projects/local-valid.yaml",
      "--json"
    ]);

    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stderr).issues[0].code).toBe("cli.backend_missing");
    expect(missingValue.status).toBe(1);
    expect(JSON.parse(missingValue.stderr).issues[0].code).toBe("cli.option_value_missing");
    expect(unknown.status).toBe(1);
    expect(JSON.parse(unknown.stderr).issues[0].code).toBe("backend.not_found");
    expect(safeUnknown.status).toBe(1);
    expect(JSON.parse(safeUnknown.stderr).issues[0].code).toBe("backend.not_found");
    expect(unsafe.status).toBe(1);
    expect(JSON.parse(unsafe.stderr).issues[0].code).toBe("cli.backend_invalid");
    expect(unsupported.status).toBe(1);
    expect(JSON.parse(unsupported.stderr).issues[0].code).toBe("cli.option_unsupported");
  });

  it("requires a command and config where appropriate", async () => {
    const noCommand = await capture([]);
    const noConfig = await capture(["validate", "--json"]);

    expect(noCommand.status).toBe(1);
    expect(noConfig.status).toBe(1);
    expect(JSON.parse(noConfig.stderr).issues[0].code).toBe("cli.config_missing");
  });

  it("rejects unknown options and missing option values", async () => {
    const unknown = await capture([
      "validate",
      "--bogus",
      "--config",
      "fixtures/projects/local-valid.yaml",
      "--json"
    ]);
    const missingValue = await capture(["validate", "--config", "--json"]);

    expect(unknown.status).toBe(1);
    expect(JSON.parse(unknown.stderr).issues[0].code).toBe("cli.option_unknown");
    expect(missingValue.status).toBe(1);
    expect(JSON.parse(missingValue.stderr).issues[0].code).toBe("cli.option_value_missing");
  });

  it("rejects --dry-run outside run without changing gate state", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-cli-state-"));
    const gate = await capture([
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
      "--dry-run",
      "--json"
    ]);
    const render = await capture([
      "render",
      "--config",
      "fixtures/projects/local-media-only.yaml",
      "--actor",
      "coordinator",
      "--state-dir",
      stateDir,
      "--dry-run",
      "--json"
    ]);

    expect(gate.status).toBe(1);
    expect(render.status).toBe(1);
    expect(JSON.parse(gate.stderr).issues[0]?.code).toBe("cli.option_unsupported");
    expect(JSON.parse(render.stderr).issues[0]?.code).toBe("cli.option_unsupported");
    await expect(stat(join(stateDir, "local-media-only-run/state.json"))).rejects.toThrow();
  });

  it("fails mutating run commands immediately while another process lock is held", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-cli-state-"));
    const config = "fixtures/projects/local-media-only.yaml";
    const lock = await acquireRunLock(stateDir, "local-media-only-run");
    let results: Awaited<ReturnType<typeof capture>>[] = [];
    let dryRun: Awaited<ReturnType<typeof capture>> | undefined;

    try {
      results = [
        await capture(["review", "--config", config, "--state-dir", stateDir, "--json"]),
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
        ]),
        await capture(["run", "--config", config, "--actor", "coordinator", "--state-dir", stateDir, "--json"]),
        await capture(["render", "--config", config, "--actor", "coordinator", "--state-dir", stateDir, "--json"])
      ];
      dryRun = await capture(["run", "--config", config, "--dry-run", "--state-dir", stateDir, "--json"]);
    } finally {
      await lock.release();
    }

    for (const result of results) {
      const issue = JSON.parse(result.stderr).issues[0];
      expect(result.status).toBe(1);
      expect(issue).toEqual({ code: "run.locked", message: "run is locked by another process" });
      expect(result.stderr).not.toContain(stateDir);
    }
    expect(dryRun?.status).toBe(0);

    const afterRelease = await capture(["review", "--config", config, "--state-dir", stateDir, "--json"]);
    expect(afterRelease.status).toBe(0);
  });

  it("accepts explicit external-analysis permission only on analyze without changing local behavior", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-cli-local-analysis-"));
    const local = await capture([
      "analyze",
      "--config",
      "examples/local-analysis/project.yaml",
      "--actor",
      "coordinator",
      "--state-dir",
      stateDir,
      "--allow-external-analysis",
      "--json"
    ]);
    const unsupported = await capture([
      "validate",
      "--config",
      "examples/local-analysis/project.yaml",
      "--allow-external-analysis",
      "--json"
    ]);

    expect(local.status).toBe(0);
    expect(JSON.parse(local.stdout)).toMatchObject({ api_used: false, network_used: false, actual_credits: 0 });
    expect(unsupported.status).toBe(1);
    expect(JSON.parse(unsupported.stderr).issues[0]?.code).toBe("cli.option_unsupported");
  });

  it("rejects unsupported retry_specific and Gate 2 approval without verified artifacts", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-cli-state-"));
    const runDir = join(stateDir, "local-media-only-run");
    await mkdir(runDir);
    await writeFile(
      join(runDir, "state.json"),
      JSON.stringify({
        run_id: "local-media-only-run",
        status: "awaiting_gate_2",
        updated_at: "2026-07-09T00:00:00.000Z",
        gates: {
          gate_1: { status: "approved" },
          gate_2: { status: "awaiting_approval" },
          gate_3: { status: "pending" }
        }
      })
    );

    const unsupported = await capture([
      "gate",
      "--config",
      "fixtures/projects/local-media-only.yaml",
      "--gate",
      "gate-2",
      "--decision",
      "retry_specific",
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
      "gate-2",
      "--decision",
      "approve_all",
      "--actor",
      "coordinator",
      "--state-dir",
      stateDir,
      "--json"
    ]);

    expect(unsupported.status).toBe(1);
    expect(JSON.parse(unsupported.stderr).issues[0].code).toBe("cli.decision_unsupported");
    expect(approved.status).toBe(1);
    expect(JSON.parse(approved.stderr).issues[0].code).toBe("run.manifest_missing");
  });

  it("accepts Gate 3 re-render without resetting earlier approvals", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-cli-state-"));
    const runDir = join(stateDir, "local-media-only-run");
    await mkdir(runDir);
    await writeFile(
      join(runDir, "state.json"),
      JSON.stringify({
        run_id: "local-media-only-run",
        status: "awaiting_gate_3",
        updated_at: "2026-07-09T00:00:00.000Z",
        gates: {
          gate_1: { status: "approved" },
          gate_2: { status: "approved" },
          gate_3: { status: "awaiting_approval" }
        }
      })
    );

    const result = await capture([
      "gate",
      "--config",
      "fixtures/projects/local-media-only.yaml",
      "--gate",
      "gate-3",
      "--decision",
      "re-render",
      "--actor",
      "coordinator",
      "--state-dir",
      stateDir,
      "--json"
    ]);

    const state = JSON.parse(result.stdout).state;
    expect(result.status).toBe(0);
    expect(state.status).toBe("rendering");
    expect(state.gates.gate_1.status).toBe("approved");
    expect(state.gates.gate_2.status).toBe("approved");
    expect(state.gates.gate_3.status).toBe("pending");
  });

  it("rejects Gate 3 approval without verified render and QC artifacts", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-cli-state-"));
    const runDir = join(stateDir, "local-media-only-run");
    await mkdir(runDir);
    await writeFile(
      join(runDir, "state.json"),
      JSON.stringify({
        run_id: "local-media-only-run",
        status: "awaiting_gate_3",
        updated_at: "2026-07-09T00:00:00.000Z",
        gates: {
          gate_1: { status: "approved" },
          gate_2: { status: "approved" },
          gate_3: { status: "awaiting_approval" }
        }
      })
    );

    const result = await capture([
      "gate",
      "--config",
      "fixtures/projects/local-media-only.yaml",
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

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).issues[0].code).toBe("render.output_missing");
  });

  it("returns plan output", async () => {
    const result = await capture(["plan", "--config", "fixtures/projects/local-valid.yaml", "--json"]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).plan.steps[1].name).toBe("creative-review");
    expect(JSON.parse(result.stdout).plan.steps[2].name).toBe("gate-1");
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
    await prepareReview("fixtures/projects/local-media-only.yaml", stateDir);
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

  it("requires a creative review artifact before Gate 1 approval", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-cli-state-"));
    const reviewDir = join(stateDir, "local-media-only-run", "review");
    const missing = await capture([
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

    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stderr).issues[0]).toMatchObject({
      code: "gate.review_required",
      path: join(reviewDir, "index.html")
    });
    await expect(stat(join(stateDir, "local-media-only-run", "state.json"))).rejects.toThrow();

    const review = await capture([
      "review",
      "--config",
      "fixtures/projects/local-media-only.yaml",
      "--state-dir",
      stateDir,
      "--json"
    ]);
    expect(review.status).toBe(0);

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
    expect(JSON.parse(approved.stdout)).toMatchObject({
      state: { status: "running" },
      review_path: join(reviewDir, "index.html"),
      review_data_path: join(reviewDir, "review-data.json")
    });
  });

  it("rejects a review artifact for a different project at Gate 1", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-cli-state-"));
    const review = await prepareReview("fixtures/projects/local-media-only.yaml", stateDir);
    const reviewData = JSON.parse(await readFile(review.review_data_path, "utf8"));
    reviewData.run_id = "other-run";
    await writeFile(review.review_data_path, `${JSON.stringify(reviewData, null, 2)}\n`);

    const result = await capture([
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

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).issues[0]).toMatchObject({
      code: "gate.review_invalid",
      path: review.review_data_path
    });
  });

  it("rechecks the storyboard review before run", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-cli-state-"));
    const review = await prepareReview("fixtures/projects/local-media-only.yaml", stateDir);
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
    const reviewHtml = await readFile(review.review_path, "utf8");
    await writeFile(review.review_path, reviewHtml.replace("映像の流れ", "改ざんされた表示"));

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
    expect(JSON.parse(result.stderr).issues[0]).toMatchObject({ code: "gate.review_invalid", path: review.review_path });
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
    await prepareReview("fixtures/projects/local-media-only.yaml", stateDir);
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
    expect(run.status, run.stderr).toBe(0);
    expect(rerun.status, rerun.stderr).toBe(0);
    const payload = JSON.parse(run.stdout);
    const rerunPayload = JSON.parse(rerun.stdout);
    const assembledManifest = JSON.parse(await readFile(payload.manifest_path, "utf8"));
    const qcReport = JSON.parse(await readFile(payload.qc_report_path, "utf8"));
    const copiedClip = join(stateDir, "local-media-only-run", assembledManifest.clips[0].src);

    expect(blocked.status).toBe(1);
    expect(JSON.parse(blocked.stderr).issues[0].code).toBe("run.requires_gate_1_approval");
    expect(payload.state.status).toBe("awaiting_gate_2");
    expect(payload.asset_count).toBe(2);
    expect(assembledManifest.clips[0].src).toBe("assets/clips/001-clip-001.mp4");
    expect(rerunPayload.already_assembled).toBe(true);
    expect(rerunPayload.state.status).toBe("awaiting_gate_2");
    expect(qcReport.asset_count).toBe(2);
    await expect(stat(copiedClip)).resolves.toMatchObject({ size: expect.any(Number) });
  });

  it("reports TopView MCP as a gated pipeline execution without submitting on dry run", async () => {
    const config = "fixtures/projects/topview-image-generation.yaml";
    const run = await capture([
      "run",
      "--config",
      config,
      "--actor",
      "coordinator",
      "--dry-run",
      "--json"
    ]);

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).dry_run.plan.agent_handoffs[0]).toMatchObject({
      phase: "generation",
      connection: "topview",
      transport: "mcp",
      execution: "pipeline-mcp"
    });
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

      await prepareReview(config, stateDir);
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
        "approve_all",
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
      process.env[LAUNCHER_EXPECTED_APPROVAL_DIGEST_ENV] = "0".repeat(64);
      const changedAfterConfirmation = await capture([
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
      expect(payload.gate3_qc_report_path).toBeTruthy();
      await expect(stat(payload.gate3_qc_report_path)).resolves.toMatchObject({ size: expect.any(Number) });
      await expect(stat(payload.output_path)).resolves.toMatchObject({ size: expect.any(Number) });
      expect(rerender.status).toBe(0);
      expect(rerenderPayload.already_rendered).toBe(true);
      expect(changedAfterConfirmation.status).toBe(1);
      expect(JSON.parse(changedAfterConfirmation.stderr).issues[0].code)
        .toBe("gate.approval_artifacts_changed");
      expect(process.env[LAUNCHER_EXPECTED_APPROVAL_DIGEST_ENV]).toBeUndefined();
      expect(JSON.parse(completed.stdout).state.status).toBe("completed");
      expect(JSON.parse(completed.stdout).state.gates.gate_3.approved_input_digest)
        .toMatch(/^[a-f0-9]{64}$/);
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
    await prepareReview("fixtures/projects/local-media-only.yaml", stateDir);
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
