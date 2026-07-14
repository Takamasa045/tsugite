import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

describe("pipeline finalize command", () => {
  it("previews safely and requires coordinator authority before applying deletion", async () => {
    const fixture = await cliFixture();

    const preview = await capture(["finalize", "--config", fixture.configPath, "--json"]);
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      command: "finalize",
      applied: false,
      media_files: ["dist/demo-v1/old.mp4"]
    });
    await expect(stat(fixture.oldMedia)).resolves.toBeDefined();

    const denied = await capture([
      "finalize",
      "--config", fixture.configPath,
      "--apply",
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
      "--json"
    ]);
    expect(applied.status).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      command: "finalize",
      applied: true,
      deleted_files: 1
    });
    await expect(stat(fixture.oldMedia)).rejects.toThrow();
    await expect(stat(join(fixture.root, "dist/demo-v2/completion-record.json"))).resolves.toBeDefined();
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
  const root = await mkdtemp(join(tmpdir(), "tsugite-finalize-cli-"));
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
  await Promise.all([
    writeFile(configPath, [
      "slug: demo",
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
        gate_3: { status: "approved" }
      }
    })}\n`),
    writeFile(join(runDir, "render-report.json"), "{}\n"),
    writeFile(join(runDir, "gate3-qc.json"), "{}\n")
  ]);
  return { root, configPath, oldMedia };
}
