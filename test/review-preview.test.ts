import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { inspectGate1Review } from "../src/orchestrator/review.js";
import { validateProject } from "../src/project/validateProject.js";

const configPath = "fixtures/projects/dialogue-remotion.yaml";

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

async function writeReview(outputDir: string) {
  const result = await capture([
    "review",
    "--config",
    configPath,
    "--state-dir",
    outputDir,
    "--json"
  ]);
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as {
    review_path: string;
    review_data_path: string;
  };
}

describe("pipeline review-preview", () => {
  it("keeps a normal Gate 1 review renderer-free", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "tsugite-review-preview-normal-"));
    const review = await writeReview(outputDir);
    const data = JSON.parse(await readFile(review.review_data_path, "utf8"));
    const html = await readFile(review.review_path, "utf8");

    expect(data.storyboard).toHaveLength(2);
    expect(data.storyboard.every((shot: { preview_video_src?: string }) => !shot.preview_video_src)).toBe(true);
    expect(html).not.toContain("<video");
    await expect(stat(join(dirname(review.review_path), "previews"))).rejects.toThrow();
  });

  it("rejects a shot that is not present in the reviewed storyboard", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "tsugite-review-preview-invalid-"));
    const review = await writeReview(outputDir);

    const result = await capture([
      "review-preview",
      "--config",
      configPath,
      "--actor",
      "coordinator",
      "--state-dir",
      outputDir,
      "--shot",
      "missing-shot",
      "--json"
    ]);

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stderr);
    expect(payload).toMatchObject({ ok: false, command: "review-preview" });
    expect(payload.issues[0].message).toContain("missing-shot");
    await expect(stat(join(dirname(review.review_path), "previews", "missing-shot.mp4"))).rejects.toThrow();
  });

  it("requires the coordinator role before rendering a preview", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "tsugite-review-preview-role-"));
    await writeReview(outputDir);
    const result = await capture([
      "review-preview",
      "--config",
      configPath,
      "--state-dir",
      outputDir,
      "--shot",
      "s01",
      "--json"
    ]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).issues[0].code).toBe("cli.coordinator_required");
  });

  it("omits a stale cached preview when normal review is regenerated", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "tsugite-review-preview-stale-"));
    const review = await writeReview(outputDir);
    const preview = await capture([
      "review-preview",
      "--config",
      configPath,
      "--actor",
      "coordinator",
      "--state-dir",
      outputDir,
      "--shot",
      "s01",
      "--json"
    ]);
    expect(preview.status).toBe(0);
    const recordPath = join(dirname(review.review_path), "previews", "s01.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.digest = "stale";
    await writeFile(recordPath, `${JSON.stringify(record)}\n`);

    await writeReview(outputDir);
    const data = JSON.parse(await readFile(review.review_data_path, "utf8"));
    expect(data.storyboard.find((shot: { id: string }) => shot.id === "s01").preview_video_src).toBeUndefined();
  }, 60_000);

  it("renders an MP4 once, safely reuses an unchanged digest, and embeds it in review HTML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "tsugite-review-preview-render-"));
    const review = await writeReview(outputDir);
    const args = [
      "review-preview",
      "--config",
      configPath,
      "--actor",
      "coordinator",
      "--state-dir",
      outputDir,
      "--shot",
      "s01",
      "--json"
    ];

    const first = await capture(args);
    expect(first.status).toBe(0);
    const firstPayload = JSON.parse(first.stdout);
    expect(firstPayload).toMatchObject({
      ok: true,
      command: "review-preview",
      shot_id: "s01",
      reused: false
    });
    expect(firstPayload.preview_path).toBe(join(dirname(review.review_path), "previews", "s01.mp4"));
    expect(firstPayload.digest).toEqual(expect.any(String));
    const initialStat = await stat(firstPayload.preview_path);
    expect(initialStat.size).toBeGreaterThan(0);

    const second = await capture(args);
    expect(second.status).toBe(0);
    const secondPayload = JSON.parse(second.stdout);
    expect(secondPayload).toMatchObject({
      ok: true,
      command: "review-preview",
      shot_id: "s01",
      preview_path: firstPayload.preview_path,
      digest: firstPayload.digest,
      reused: true
    });
    expect((await stat(secondPayload.preview_path)).mtimeMs).toBe(initialStat.mtimeMs);

    const data = JSON.parse(await readFile(review.review_data_path, "utf8"));
    expect(data.storyboard.find((shot: { id: string }) => shot.id === "s01")).toMatchObject({
      preview_video_src: "previews/s01.mp4"
    });
    const html = await readFile(review.review_path, "utf8");
    expect(html).toContain("<video");
    expect(html).toContain('src="previews/s01.mp4"');
    expect(html).toContain("controls");
    expect(html).toContain("muted");
    expect(html).toContain("playsinline");

    const validation = await validateProject(configPath);
    if (!validation.project || !validation.manifest) throw new Error("fixture project is invalid");
    const initialGate1 = await inspectGate1Review({
      configPath,
      project: validation.project,
      manifest: validation.manifest,
      stateDir: outputDir
    });
    expect(initialGate1.ok).toBe(true);
    if (!initialGate1.ok) throw new Error("Gate 1 review inspection unexpectedly failed");

    await writeFile(firstPayload.preview_path, "tampered preview media\n");
    const changedGate1 = await inspectGate1Review({
      configPath,
      project: validation.project,
      manifest: validation.manifest,
      stateDir: outputDir
    });
    expect(changedGate1.ok).toBe(true);
    if (!changedGate1.ok) throw new Error("Gate 1 review inspection unexpectedly failed after preview mutation");
    expect(changedGate1.approvalDigest).not.toBe(initialGate1.approvalDigest);
  }, 60_000);
});
