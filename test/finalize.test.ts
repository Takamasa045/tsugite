import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { finalizeCompletedProject } from "../src/orchestrator/finalize.js";
import type { Manifest } from "../src/manifest/schema.js";
import type { Project } from "../src/project/schema.js";

const project: Project = {
  slug: "demo",
  run_id: "demo-v2",
  manifest: "manifest.json",
  dist_dir: "dist",
  edit: { backend: "remotion" }
};

describe("completed project finalization", () => {
  it("previews old media cleanup without changing files", async () => {
    const fixture = await completionFixture();

    const result = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false,
      now: "2026-07-14T00:00:00.000Z"
    });

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.mediaFiles).toEqual([
      "dist/demo-v1/assets/old.mp4",
      "media/unused-draft.wav",
      "qa/v1/contact-sheet.jpg"
    ]);
    expect(result.retainedMedia).toEqual(expect.arrayContaining([
      "dist/demo-v2/final.mp4",
      "dist/demo-v2/assets/current.mp4",
      "media/current.mp4"
    ]));
    await expect(stat(join(fixture.root, "dist/demo-v1/assets/old.mp4"))).resolves.toBeDefined();
    await expect(stat(join(fixture.root, "dist/demo-v2/completion-record.json"))).rejects.toThrow();
  });

  it("deletes only superseded media and writes an auditable completion record", async () => {
    const fixture = await completionFixture();

    const result = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      now: "2026-07-14T00:00:00.000Z"
    });

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.deletedFiles).toBe(3);
    await expect(stat(join(fixture.root, "dist/demo-v1/assets/old.mp4"))).rejects.toThrow();
    await expect(stat(join(fixture.root, "media/unused-draft.wav"))).rejects.toThrow();
    await expect(stat(join(fixture.root, "qa/v1/contact-sheet.jpg"))).rejects.toThrow();
    await expect(stat(join(fixture.root, "dist/demo-v1/run-log.md"))).resolves.toBeDefined();
    await expect(stat(join(fixture.root, "dist/demo-v2/final.mp4"))).resolves.toBeDefined();
    await expect(stat(join(fixture.root, "dist/demo-v2/assets/current.mp4"))).resolves.toBeDefined();
    await expect(stat(join(fixture.root, "media/current.mp4"))).resolves.toBeDefined();
    await expect(stat(join(fixture.root, "marketing/logo.png"))).resolves.toBeDefined();

    const recordPath = join(fixture.root, "dist/demo-v2/completion-record.json");
    const recordText = await readFile(recordPath, "utf8");
    const record = JSON.parse(recordText);
    expect(record).toMatchObject({
      schema_version: 1,
      project_slug: "demo",
      run_id: "demo-v2",
      completed_at: "2026-07-13T23:00:00.000Z",
      finalized_at: "2026-07-14T00:00:00.000Z",
      canonical_output: "dist/demo-v2/final.mp4",
      retained_run: "dist/demo-v2",
      cleanup: {
        media_files_deleted: 3,
        deleted_media_paths: [
          "dist/demo-v1/assets/old.mp4",
          "media/unused-draft.wav",
          "qa/v1/contact-sheet.jpg"
        ]
      }
    });

    const repeated = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      now: "2026-07-15T00:00:00.000Z"
    });
    expect(repeated.ok).toBe(true);
    expect(repeated.deletedFiles).toBe(0);
    expect(await readFile(recordPath, "utf8")).toBe(recordText);
  });

  it("refuses cleanup until the run is completed and Gate 3 is approved", async () => {
    const fixture = await completionFixture({ completed: false });

    const result = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("finalize.run_not_completed");
    await expect(stat(join(fixture.root, "dist/demo-v1/assets/old.mp4"))).resolves.toBeDefined();
  });

  it("refuses cleanup when the canonical final output or QA proof is missing", async () => {
    const fixture = await completionFixture({ omitFinal: true });

    const result = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("finalize.output_missing");
    await expect(stat(join(fixture.root, "dist/demo-v1/assets/old.mp4"))).resolves.toBeDefined();
  });

  it("refuses to use the whole project directory as the state cleanup root", async () => {
    const fixture = await completionFixture();

    const result = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      stateDir: fixture.root,
      apply: false
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("finalize.state_dir_unsafe");
  });
});

async function completionFixture(options: { completed?: boolean; omitFinal?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tsugite-finalize-"));
  const configPath = join(root, "project.yaml");
  const runDir = join(root, "dist/demo-v2");
  const oldRunDir = join(root, "dist/demo-v1");
  await Promise.all([
    mkdir(join(runDir, "assets"), { recursive: true }),
    mkdir(join(oldRunDir, "assets"), { recursive: true }),
    mkdir(join(root, "media"), { recursive: true }),
    mkdir(join(root, "qa/v1"), { recursive: true }),
    mkdir(join(root, "marketing"), { recursive: true })
  ]);

  const manifest = {
    meta: { aspect: "16:9", fps: 30, target_duration_seconds: 1 },
    clips: [
      {
        id: "current",
        src: "media/current.mp4",
        in: 0,
        out: 1,
        duration: 1,
        fps: 30,
        resolution: { width: 1280, height: 720 },
        audio: false
      }
    ],
    images: [],
    speakers: []
  } as Manifest;
  const finalContent = "canonical final video";
  const finalDigest = createHash("sha256").update(finalContent).digest("hex");

  await Promise.all([
    writeFile(configPath, "slug: demo\n"),
    writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest)}\n`),
    writeFile(join(runDir, "state.json"), `${JSON.stringify({
      run_id: "demo-v2",
      status: options.completed === false ? "awaiting_gate_3" : "completed",
      updated_at: "2026-07-13T23:00:00.000Z",
      gates: {
        gate_1: { status: "approved" },
        gate_2: { status: "approved" },
        gate_3: {
          status: options.completed === false ? "awaiting_approval" : "approved",
          ...(options.completed === false ? {} : { approved_input_digest: finalDigest })
        }
      }
    })}\n`),
    writeFile(join(runDir, "render-report.json"), "{}\n"),
    writeFile(join(runDir, "gate3-qc.json"), "{}\n"),
    writeFile(join(runDir, "assets/current.mp4"), "current assembled video"),
    writeFile(join(oldRunDir, "assets/old.mp4"), "old assembled video"),
    writeFile(join(oldRunDir, "run-log.md"), "old audit record\n"),
    writeFile(join(root, "media/current.mp4"), "current source video"),
    writeFile(join(root, "media/unused-draft.wav"), "old source audio"),
    writeFile(join(root, "qa/v1/contact-sheet.jpg"), "old qa image"),
    writeFile(join(root, "marketing/logo.png"), "unrelated project media")
  ]);
  if (!options.omitFinal) await writeFile(join(runDir, "final.mp4"), finalContent);

  return { root, configPath, manifest };
}
