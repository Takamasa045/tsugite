import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { preflightFinalizeApplyBoundary } from "../src/orchestrator/finalize.js";
import { acquireRunLock, RunLockBoundaryError } from "../src/orchestrator/state.js";
import type { Project } from "../src/project/schema.js";

const originalProjectsHome = process.env.TSUGITE_PROJECTS_HOME;

afterEach(() => {
  if (originalProjectsHome === undefined) delete process.env.TSUGITE_PROJECTS_HOME;
  else process.env.TSUGITE_PROJECTS_HOME = originalProjectsHome;
});

describe("pipeline finalize command", () => {
  it("previews plan_digest and requires coordinator authority before applying deletion", async () => {
    const fixture = await cliFixture();

    const preview = await capture(["finalize", "--config", fixture.configPath, "--json"]);
    expect(preview.status).toBe(0);
    const previewJson = JSON.parse(preview.stdout);
    expect(previewJson).toMatchObject({
      command: "finalize",
      applied: false,
      media_files: ["dist/demo-v1/old.mp4"]
    });
    expect(previewJson.plan_digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(stat(fixture.oldMedia)).resolves.toBeDefined();

    const denied = await capture([
      "finalize",
      "--config", fixture.configPath,
      "--apply",
      "--expected-plan-digest", previewJson.plan_digest,
      "--json"
    ]);
    expect(denied.status).toBe(1);
    expect(JSON.parse(denied.stderr).issues[0]?.code).toBe("cli.coordinator_required");
    await expect(stat(fixture.oldMedia)).resolves.toBeDefined();

    const applied = await capture([
      "finalize",
      "--config", fixture.configPath,
      "--apply",
      "--actor", "coordinator",
      "--expected-plan-digest", previewJson.plan_digest,
      "--json"
    ]);
    expect(applied.status).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      command: "finalize",
      applied: true,
      deleted_files: 1,
      plan_digest: previewJson.plan_digest,
      launcher_visible: true,
      launcher_already_home: true,
      promoted_to_launcher_home: false
    });
    await expect(stat(fixture.oldMedia)).rejects.toThrow();
    await expect(stat(join(fixture.root, "dist/demo-v2/completion-record.json"))).resolves.toBeDefined();
  });

  it("rejects apply without expected-plan-digest without changing files", async () => {
    const fixture = await cliFixture();

    const denied = await capture([
      "finalize",
      "--config", fixture.configPath,
      "--apply",
      "--actor", "coordinator",
      "--json"
    ]);
    expect(denied.status).toBe(1);
    const body = JSON.parse(denied.stderr);
    expect(body.issues[0]?.code).toBe("finalize.expected_plan_digest_required");
    expect(body.deleted_files).toBe(0);
    await expect(stat(fixture.oldMedia)).resolves.toBeDefined();
    await expect(stat(join(fixture.root, "dist/demo-v2/completion-record.json"))).rejects.toThrow();
  });

  it("rejects apply when expected-plan-digest does not match the live plan", async () => {
    const fixture = await cliFixture();

    const denied = await capture([
      "finalize",
      "--config", fixture.configPath,
      "--apply",
      "--actor", "coordinator",
      "--expected-plan-digest", "0".repeat(64),
      "--json"
    ]);
    expect(denied.status).toBe(1);
    const body = JSON.parse(denied.stderr);
    expect(body.issues[0]?.code).toBe("finalize.plan_stale");
    expect(body.deleted_files).toBe(0);
    expect(body.plan_digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(stat(fixture.oldMedia)).resolves.toBeDefined();
  });

  it("rejects apply when candidates change after preview", async () => {
    const fixture = await cliFixture();

    const preview = await capture(["finalize", "--config", fixture.configPath, "--json"]);
    expect(preview.status).toBe(0);
    const previewJson = JSON.parse(preview.stdout);
    expect(previewJson.plan_digest).toMatch(/^[a-f0-9]{64}$/);

    await writeFile(join(fixture.root, "media/extra-old.mp4"), "new candidate after preview");

    const stale = await capture([
      "finalize",
      "--config", fixture.configPath,
      "--apply",
      "--actor", "coordinator",
      "--expected-plan-digest", previewJson.plan_digest,
      "--json"
    ]);
    expect(stale.status).toBe(1);
    const body = JSON.parse(stale.stderr);
    expect(body.issues[0]?.code).toBe("finalize.plan_stale");
    expect(body.deleted_files).toBe(0);
    await expect(stat(fixture.oldMedia)).resolves.toBeDefined();
    await expect(stat(join(fixture.root, "media/extra-old.mp4"))).resolves.toBeDefined();
    await expect(stat(join(fixture.root, "dist/demo-v2/completion-record.json"))).rejects.toThrow();
  });

  it("rejects unapproved stateDir before creating a run lock", async () => {
    const fixture = await cliFixture();
    const outside = await mkdtemp(join(tmpdir(), "tsugite-finalize-cli-state-"));
    const outsideRunDir = join(outside, "demo-v2");
    await mkdir(outsideRunDir, { recursive: true });

    // Hold a lock under the unapproved stateDir. If finalize acquired it before rejection,
    // a second acquire would fail with run.locked instead of state_dir_unapproved.
    const strayLock = await acquireRunLock(outside, "demo-v2");
    try {
      const denied = await capture([
        "finalize",
        "--config", fixture.configPath,
        "--state-dir", outside,
        "--apply",
        "--actor", "coordinator",
        "--expected-plan-digest", "0".repeat(64),
        "--json"
      ]);
      expect(denied.status).toBe(1);
      const body = JSON.parse(denied.stderr);
      expect(body.issues[0]?.code).toBe("finalize.state_dir_unapproved");
      expect(body.issues.some((issue: { code: string }) => issue.code === "run.locked")).toBe(false);
      await expect(stat(fixture.oldMedia)).resolves.toBeDefined();
      // Unapproved outside stateDir must not receive a completion record from finalize.
      await expect(stat(join(outsideRunDir, "completion-record.json"))).rejects.toThrow();
    } finally {
      await strayLock.release();
    }
  });

  it("fail-closes lock acquire when stateDir is swapped to an external symlink after preflight", async () => {
    const fixture = await cliFixture();
    const project: Project = {
      slug: "demo",
      name: "demo",
      run_id: "demo-v2",
      manifest: "manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" }
    };
    const boundary = await preflightFinalizeApplyBoundary({
      configPath: fixture.configPath,
      project
    });
    expect(boundary.ok).toBe(true);
    if (!boundary.ok) return;

    const external = await mkdtemp(join(tmpdir(), "tsugite-finalize-state-swap-"));
    const realDist = join(fixture.root, "dist");
    const distBackup = join(fixture.root, "dist.real-backup");
    await rename(realDist, distBackup);
    await symlink(external, realDist);

    await expect(
      acquireRunLock(boundary.stateDir, boundary.runId, undefined, {
        expectedStateDir: boundary.stateDirIdentity,
        containWithin: fixture.root
      })
    ).rejects.toBeInstanceOf(RunLockBoundaryError);

    // Zero external mkdir/write/rename/unlink side effects from lock acquire.
    expect(await readdir(external)).toEqual([]);
  });
});

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

async function cliFixture() {
  const base = await mkdtemp(join(tmpdir(), "tsugite-finalize-cli-"));
  const projectsHome = join(base, "projects");
  const root = join(projectsHome, "demo");
  process.env.TSUGITE_PROJECTS_HOME = projectsHome;
  const configPath = join(root, "project.yaml");
  const runDir = join(root, "dist/demo-v2");
  const oldMedia = join(root, "dist/demo-v1/old.mp4");
  await Promise.all([
    mkdir(join(root, "media"), { recursive: true }),
    mkdir(runDir, { recursive: true }),
    mkdir(join(root, "dist/demo-v1"), { recursive: true })
  ]);
  await Promise.all([
    copyFile(resolve("fixtures/media/clip-001.mp4"), join(root, "media/clip-001.mp4")),
    copyFile(resolve("fixtures/media/clip-002.mp4"), join(root, "media/clip-002.mp4")),
    copyFile(resolve("fixtures/media/render-001.mp4"), join(runDir, "final.mp4")),
    copyFile(resolve("fixtures/media/render-001.mp4"), oldMedia)
  ]);
  const manifest = JSON.parse(await readFile(resolve("fixtures/manifests/minimal.valid.json"), "utf8"));
  for (const clip of manifest.clips) clip.src = clip.src.replace("../media/", "media/");
  const finalDigest = createHash("sha256")
    .update(await readFile(join(runDir, "final.mp4")))
    .digest("hex");
  await Promise.all([
    writeFile(configPath, [
      "slug: demo",
      "name: デモ",
      "run_id: demo-v2",
      "manifest: manifest.json",
      "dist_dir: dist",
      "edit:",
      "  backend: remotion",
      ""
    ].join("\n")),
    writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(join(runDir, "state.json"), `${JSON.stringify({
      run_id: "demo-v2",
      status: "completed",
      updated_at: "2026-07-14T00:00:00.000Z",
      gates: {
        gate_1: { status: "approved" },
        gate_2: { status: "approved" },
        gate_3: { status: "approved", approved_input_digest: finalDigest }
      }
    })}\n`),
    writeFile(join(runDir, "render-report.json"), "{}\n"),
    writeFile(join(runDir, "gate3-qc.json"), "{}\n")
  ]);
  return { root, configPath, oldMedia };
}
