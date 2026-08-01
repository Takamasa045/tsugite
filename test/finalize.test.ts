import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPlanDigest,
  finalizeCompletedProject,
  finalizeJournalPath,
  inspectFinalizeDeletionCandidate,
  preflightFinalizeApplyBoundary,
  readFinalizeJournal,
  sameFinalizeStorageIdentity
} from "../src/orchestrator/finalize.js";
import type { Manifest } from "../src/manifest/schema.js";
import type { Project } from "../src/project/schema.js";

const originalProjectsHome = process.env.TSUGITE_PROJECTS_HOME;

afterEach(() => {
  if (originalProjectsHome === undefined) delete process.env.TSUGITE_PROJECTS_HOME;
  else process.env.TSUGITE_PROJECTS_HOME = originalProjectsHome;
});

const project: Project = {
  slug: "demo",
  name: "demo",
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

  it("exposes a deterministic planDigest and regular-file identities on preview", async () => {
    const fixture = await completionFixture();

    const first = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    const second = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });

    expect(first.ok).toBe(true);
    expect(first.planDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.planDigest).toBe(second.planDigest);
    expect(first.candidateIdentities).toEqual(second.candidateIdentities);
    expect(first.candidateIdentities).toEqual([
      expect.objectContaining({
        path: "dist/demo-v1/assets/old.mp4",
        size: expect.any(Number),
        mtimeMs: expect.any(Number),
        device: expect.any(Number),
        inode: expect.any(Number)
      }),
      expect.objectContaining({ path: "media/unused-draft.wav" }),
      expect.objectContaining({ path: "qa/v1/contact-sheet.jpg" })
    ]);
    for (const identity of first.candidateIdentities ?? []) {
      const stats = await lstat(join(fixture.root, identity.path));
      expect(stats.isFile()).toBe(true);
      expect(stats.isSymbolicLink()).toBe(false);
      expect(identity.size).toBe(stats.size);
      expect(identity.device).toBe(stats.dev);
      expect(identity.inode).toBe(stats.ino);
    }
  });

  it("ignores symlink files and symlink directories for counting and deletion", async () => {
    const fixture = await completionFixture();
    const outsideDir = await mkdtemp(join(tmpdir(), "tsugite-finalize-outside-"));
    const outsideMedia = join(outsideDir, "escape.mp4");
    const linkedInside = join(fixture.root, "media/linked-escape.mp4");
    const linkedDirTarget = join(outsideDir, "linked-media");
    const linkedDir = join(fixture.root, "media/linked-dir");
    await writeFile(outsideMedia, "outside media bytes");
    await mkdir(linkedDirTarget, { recursive: true });
    await writeFile(join(linkedDirTarget, "hidden.mp4"), "hidden by symlink dir");
    await symlink(outsideMedia, linkedInside);
    await symlink(linkedDirTarget, linkedDir);

    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);
    expect(preview.mediaFiles).toEqual([
      "dist/demo-v1/assets/old.mp4",
      "media/unused-draft.wav",
      "qa/v1/contact-sheet.jpg"
    ]);
    expect(preview.mediaFiles).not.toContain("media/linked-escape.mp4");
    expect(preview.mediaFiles.some((path) => path.includes("linked-dir"))).toBe(false);
    expect(preview.candidateIdentities?.every((item) => !item.path.includes("linked"))).toBe(true);

    const applied = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });
    expect(applied.ok).toBe(true);
    expect(applied.deletedFiles).toBe(3);
    await expect(lstat(linkedInside)).resolves.toMatchObject({ isSymbolicLink: expect.any(Function) });
    expect((await lstat(linkedInside)).isSymbolicLink()).toBe(true);
    await expect(stat(outsideMedia)).resolves.toBeDefined();
    await expect(stat(join(linkedDirTarget, "hidden.mp4"))).resolves.toBeDefined();
    await expect(lstat(linkedDir)).resolves.toMatchObject({ isSymbolicLink: expect.any(Function) });
    expect((await lstat(linkedDir)).isSymbolicLink()).toBe(true);
  });

  it("never deletes media outside the fixed cleanup roots", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);

    const result = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });

    expect(result.ok).toBe(true);
    expect(result.mediaFiles).not.toContain("marketing/logo.png");
    await expect(stat(join(fixture.root, "marketing/logo.png"))).resolves.toBeDefined();
    await expect(stat(join(fixture.root, "dist/demo-v1/run-log.md"))).resolves.toBeDefined();
  });

  it("refuses apply without expectedPlanDigest and leaves candidates untouched", async () => {
    const fixture = await completionFixture();

    const denied = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      now: "2026-07-14T00:00:00.000Z"
    });

    expect(denied.ok).toBe(false);
    expect(denied.issues[0]?.code).toBe("finalize.expected_plan_digest_required");
    expect(denied.deletedFiles).toBe(0);
    await expect(stat(join(fixture.root, "dist/demo-v1/assets/old.mp4"))).resolves.toBeDefined();
    await expect(stat(join(fixture.root, "media/unused-draft.wav"))).resolves.toBeDefined();
    await expect(stat(join(fixture.root, "qa/v1/contact-sheet.jpg"))).resolves.toBeDefined();
    await expect(stat(join(fixture.root, "dist/demo-v2/completion-record.json"))).rejects.toThrow();
  });

  it("rejects candidate replacement as candidate_changed without deleting", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);
    const target = join(fixture.root, "media/unused-draft.wav");
    const expected = preview.candidateIdentities?.find((item) => item.path === "media/unused-draft.wav");
    expect(expected).toBeDefined();

    await writeFile(target, "replaced candidate bytes");

    const issue = await inspectFinalizeDeletionCandidate(
      target,
      expected!,
      fixture.root,
      [
        join(fixture.root, "dist"),
        join(fixture.root, "media"),
        join(fixture.root, "qa"),
        join(fixture.root, "references")
      ]
    );
    expect(issue?.code).toBe("finalize.candidate_changed");
    await expect(stat(target)).resolves.toBeDefined();

    const stale = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });
    expect(stale.ok).toBe(false);
    expect(stale.issues[0]?.code).toBe("finalize.plan_stale");
    expect(stale.deletedFiles).toBe(0);
    await expect(stat(target)).resolves.toBeDefined();
    await expect(stat(join(fixture.root, "dist/demo-v2/completion-record.json"))).rejects.toThrow();
  });

  it("rejects parent directory symlink swap and never deletes the external file", async () => {
    const fixture = await completionFixture();
    const nestedDir = join(fixture.root, "media/nested");
    const nestedMedia = join(nestedDir, "old-nested.mp4");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(nestedMedia, "nested candidate");

    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);
    expect(preview.mediaFiles).toContain("media/nested/old-nested.mp4");
    const expected = preview.candidateIdentities?.find((item) => item.path === "media/nested/old-nested.mp4");
    expect(expected).toBeDefined();

    const outsideDir = await mkdtemp(join(tmpdir(), "tsugite-finalize-parent-swap-"));
    const outsideMedia = join(outsideDir, "old-nested.mp4");
    await writeFile(outsideMedia, "external nested candidate");
    const backupDir = join(fixture.root, "media/nested-backup");
    await rename(nestedDir, backupDir);
    await symlink(outsideDir, nestedDir);

    const issue = await inspectFinalizeDeletionCandidate(
      nestedMedia,
      expected!,
      fixture.root,
      [
        join(fixture.root, "dist"),
        join(fixture.root, "media"),
        join(fixture.root, "qa"),
        join(fixture.root, "references")
      ]
    );
    expect(issue?.code).toBe("finalize.candidate_path_unsafe");
    await expect(stat(outsideMedia)).resolves.toBeDefined();

    const stale = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });
    expect(stale.ok).toBe(false);
    expect(stale.issues[0]?.code).toBe("finalize.plan_stale");
    expect(stale.deletedFiles).toBe(0);
    await expect(stat(outsideMedia)).resolves.toBeDefined();
    await expect(stat(join(backupDir, "old-nested.mp4"))).resolves.toBeDefined();
    await expect(stat(join(fixture.root, "dist/demo-v2/completion-record.json"))).rejects.toThrow();
    await rm(nestedDir, { force: true });
  });

  it("stops as a stale plan without changes when candidates change after preview", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);
    expect(preview.planDigest).toBeTruthy();

    await writeFile(join(fixture.root, "media/extra-old.mp4"), "new candidate after preview");

    const stale = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });

    expect(stale.ok).toBe(false);
    expect(stale.issues[0]?.code).toBe("finalize.plan_stale");
    expect(stale.deletedFiles).toBe(0);
    await expect(stat(join(fixture.root, "dist/demo-v1/assets/old.mp4"))).resolves.toBeDefined();
    await expect(stat(join(fixture.root, "media/unused-draft.wav"))).resolves.toBeDefined();
    await expect(stat(join(fixture.root, "qa/v1/contact-sheet.jpg"))).resolves.toBeDefined();
    await expect(stat(join(fixture.root, "dist/demo-v2/completion-record.json"))).rejects.toThrow();
  });

  it("stops as a stale plan without changes when final.mp4 changes after preview", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);

    await writeFile(join(fixture.root, "dist/demo-v2/final.mp4"), "tampered final video");

    const stale = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });

    expect(stale.ok).toBe(false);
    expect(["finalize.plan_stale", "finalize.gate3_output_changed"]).toContain(stale.issues[0]?.code);
    expect(stale.deletedFiles).toBe(0);
    await expect(stat(join(fixture.root, "dist/demo-v1/assets/old.mp4"))).resolves.toBeDefined();
    await expect(stat(join(fixture.root, "dist/demo-v2/completion-record.json"))).rejects.toThrow();
  });

  it("stops as a stale plan without changes when state changes after preview", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);

    const statePath = join(fixture.root, "dist/demo-v2/state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.status = "awaiting_gate_3";
    state.gates.gate_3.status = "awaiting_approval";
    delete state.gates.gate_3.approved_input_digest;
    await writeFile(statePath, `${JSON.stringify(state)}\n`);

    const stale = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });

    expect(stale.ok).toBe(false);
    expect(["finalize.plan_stale", "finalize.run_not_completed"]).toContain(stale.issues[0]?.code);
    expect(stale.deletedFiles).toBe(0);
    await expect(stat(join(fixture.root, "dist/demo-v1/assets/old.mp4"))).resolves.toBeDefined();
    await expect(stat(join(fixture.root, "dist/demo-v2/completion-record.json"))).rejects.toThrow();
  });

  it("stops as a stale plan without changes when manifest retention changes after preview", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);

    const changedManifest = {
      ...fixture.manifest,
      clips: [
        ...fixture.manifest.clips,
        {
          id: "unused",
          src: "media/unused-draft.wav",
          in: 0,
          out: 1,
          duration: 1,
          fps: 30,
          resolution: { width: 1280, height: 720 },
          audio: true
        }
      ]
    } as Manifest;

    const stale = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: changedManifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });

    expect(stale.ok).toBe(false);
    expect(stale.issues[0]?.code).toBe("finalize.plan_stale");
    expect(stale.deletedFiles).toBe(0);
    await expect(stat(join(fixture.root, "media/unused-draft.wav"))).resolves.toBeDefined();
    await expect(stat(join(fixture.root, "dist/demo-v2/completion-record.json"))).rejects.toThrow();
  });

  it("applies when expectedPlanDigest still matches the live plan", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);

    const applied = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });

    expect(applied.ok).toBe(true);
    expect(applied.planDigest).toBe(preview.planDigest);
    expect(applied.deletedFiles).toBe(3);
    await expect(stat(join(fixture.root, "dist/demo-v1/assets/old.mp4"))).rejects.toThrow();
  });

  it("deletes only superseded media and writes an auditable completion record", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);

    const result = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.launcherAlreadyHome).toBe(true);
    expect(result.promotedToLauncherHome).toBe(false);
    expect(result.deletedFiles).toBe(3);
    expect(result.planDigest).toMatch(/^[a-f0-9]{64}$/);
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
        ],
        plan_digest: preview.planDigest
      }
    });

    const emptyPreview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(emptyPreview.ok).toBe(true);

    const repeated = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: emptyPreview.planDigest,
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

  it("refuses project root and unrelated internal roots as stateDir", async () => {
    const fixture = await completionFixture();

    const projectRootDenied = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      stateDir: fixture.root,
      apply: false
    });
    expect(projectRootDenied.ok).toBe(false);
    expect(projectRootDenied.issues[0]?.code).toBe("finalize.state_dir_unapproved");

    const mediaRootDenied = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      stateDir: join(fixture.root, "media"),
      apply: false
    });
    expect(mediaRootDenied.ok).toBe(false);
    expect(mediaRootDenied.issues[0]?.code).toBe("finalize.state_dir_unapproved");
    await expect(stat(join(fixture.root, "dist/demo-v1/assets/old.mp4"))).resolves.toBeDefined();
  });

  it("refuses stateDir that is a symlink or has a symlink ancestor", async () => {
    const fixture = await completionFixture();
    const realDist = join(fixture.root, "dist");
    const shadow = join(fixture.root, "shadow-dist");
    await rename(realDist, shadow);
    await symlink(shadow, realDist);

    const result = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("finalize.state_dir_symlink");
    await expect(stat(join(shadow, "demo-v1/assets/old.mp4"))).resolves.toBeDefined();
  });

  it("refuses stateDir outside the project", async () => {
    const fixture = await completionFixture();
    const outside = await mkdtemp(join(tmpdir(), "tsugite-finalize-state-outside-"));

    const result = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      stateDir: outside,
      apply: false
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("finalize.state_dir_unapproved");
  });

  it("fail-closes when manifest references media outside the project", async () => {
    const fixture = await completionFixture();
    const outsideDir = await mkdtemp(join(tmpdir(), "tsugite-finalize-manifest-out-"));
    const outsideMedia = join(outsideDir, "shared.mp4");
    await writeFile(outsideMedia, "shared library media");
    const unsafeManifest = {
      ...fixture.manifest,
      clips: [
        ...fixture.manifest.clips,
        {
          id: "external",
          src: outsideMedia,
          in: 0,
          out: 1,
          duration: 1,
          fps: 30,
          resolution: { width: 1280, height: 720 },
          audio: false
        }
      ]
    } as Manifest;

    const result = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: unsafeManifest,
      apply: false
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("finalize.manifest_path_unsafe");
    await expect(stat(outsideMedia)).resolves.toBeDefined();
    await expect(stat(join(fixture.root, "dist/demo-v1/assets/old.mp4"))).resolves.toBeDefined();
  });

  it("fail-closes when manifest references a symlink media path", async () => {
    const fixture = await completionFixture();
    const outsideDir = await mkdtemp(join(tmpdir(), "tsugite-finalize-manifest-link-"));
    const outsideMedia = join(outsideDir, "linked-source.mp4");
    await writeFile(outsideMedia, "linked source");
    const linked = join(fixture.root, "media/linked-current.mp4");
    await symlink(outsideMedia, linked);
    const unsafeManifest = {
      ...fixture.manifest,
      clips: [
        {
          id: "linked",
          src: "media/linked-current.mp4",
          in: 0,
          out: 1,
          duration: 1,
          fps: 30,
          resolution: { width: 1280, height: 720 },
          audio: false
        }
      ]
    } as Manifest;

    const result = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: unsafeManifest,
      apply: false
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("finalize.manifest_path_unsafe");
    await expect(stat(outsideMedia)).resolves.toBeDefined();
    await expect(lstat(linked)).resolves.toMatchObject({ isSymbolicLink: expect.any(Function) });
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    await expect(stat(join(fixture.root, "dist/demo-v1/assets/old.mp4"))).resolves.toBeDefined();
  });

  it("rolls back quarantine when the second candidate fails mid-quarantine and reports zero permanent deletes", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);
    expect(preview.mediaFiles.length).toBeGreaterThanOrEqual(2);

    const failed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z",
      _testHooks: {
        afterQuarantineIndex: async (index) => {
          if (index === 0) {
            // Corrupt the next original candidate so the second quarantine revalidation fails.
            const next = preview.mediaFiles[1]!;
            await writeFile(join(fixture.root, next), "mutated before second quarantine");
          }
        }
      }
    });

    expect(failed.ok).toBe(false);
    expect(failed.deletedFiles).toBe(0);
    expect(failed.deletedBytes).toBe(0);
    expect(["finalize.candidate_changed", "finalize.plan_stale"]).toContain(failed.issues[0]?.code);
    for (const relativePath of preview.mediaFiles) {
      await expect(stat(join(fixture.root, relativePath))).resolves.toBeDefined();
    }
    await expect(stat(join(fixture.root, "dist/demo-v2/completion-record.json"))).rejects.toThrow();
  });

  it("refuses permanent delete and rolls back remaining when quarantined identity is swapped with retained media", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);
    expect(preview.mediaFiles.length).toBeGreaterThanOrEqual(2);
    const retainedPath = join(fixture.root, "dist/demo-v2/final.mp4");
    const retainedBytes = await readFile(retainedPath);

    const failed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z",
      _testHooks: {
        beforePermanentDeleteIndex: async (index, quarantinedPath) => {
          if (index === 0) {
            // Replace the quarantined candidate with a fresh copy of retained final.mp4
            // so device/inode/size/mtime no longer match the planned identity.
            await unlink(quarantinedPath);
            await writeFile(quarantinedPath, retainedBytes);
          }
        }
      }
    });

    expect(failed.ok).toBe(false);
    expect(failed.deletedFiles).toBe(0);
    expect(failed.deletedBytes).toBe(0);
    expect(failed.issues[0]?.code).toBe("finalize.candidate_changed");
    for (const relativePath of preview.mediaFiles) {
      await expect(stat(join(fixture.root, relativePath))).resolves.toBeDefined();
    }
    // Retained final output must remain untouched.
    await expect(readFile(retainedPath)).resolves.toEqual(retainedBytes);
  });

  it("rolls back after quarantine when final.mp4 changes before promotion", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);

    const failed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z",
      _testHooks: {
        beforePromote: async () => {
          await writeFile(join(fixture.root, "dist/demo-v2/final.mp4"), "tampered after quarantine");
        }
      }
    });

    expect(failed.ok).toBe(false);
    expect(failed.deletedFiles).toBe(0);
    expect(failed.issues[0]?.code).toBe("finalize.gate3_output_changed");
    for (const relativePath of preview.mediaFiles) {
      await expect(stat(join(fixture.root, relativePath))).resolves.toBeDefined();
    }
    await expect(stat(join(fixture.root, "dist/demo-v2/completion-record.json"))).rejects.toThrow();
  });

  it("rolls back after quarantine when state or manifest retention changes before permanent delete", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);

    const stateFailed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z",
      _testHooks: {
        beforePromote: async () => {
          const statePath = join(fixture.root, "dist/demo-v2/state.json");
          const state = JSON.parse(await readFile(statePath, "utf8"));
          state.status = "awaiting_gate_3";
          state.gates.gate_3.status = "awaiting_approval";
          delete state.gates.gate_3.approved_input_digest;
          await writeFile(statePath, `${JSON.stringify(state)}\n`);
        }
      }
    });
    expect(stateFailed.ok).toBe(false);
    expect(stateFailed.deletedFiles).toBe(0);
    expect(stateFailed.issues[0]?.code).toBe("finalize.run_not_completed");
    for (const relativePath of preview.mediaFiles) {
      await expect(stat(join(fixture.root, relativePath))).resolves.toBeDefined();
    }

    const fixture2 = await completionFixture();
    const preview2 = await finalizeCompletedProject({
      configPath: fixture2.configPath,
      project,
      manifest: fixture2.manifest,
      apply: false
    });
    expect(preview2.ok).toBe(true);

    const manifestFailed = await finalizeCompletedProject({
      configPath: fixture2.configPath,
      project,
      manifest: fixture2.manifest,
      apply: true,
      expectedPlanDigest: preview2.planDigest,
      now: "2026-07-14T00:00:00.000Z",
      _testHooks: {
        beforePromote: async () => {
          const changed = {
            ...fixture2.manifest,
            clips: [
              ...fixture2.manifest.clips,
              {
                id: "unused",
                src: "media/unused-draft.wav",
                in: 0,
                out: 1,
                duration: 1,
                fps: 30,
                resolution: { width: 1280, height: 720 },
                audio: true
              }
            ]
          };
          await writeFile(
            join(fixture2.root, "manifest.json"),
            `${JSON.stringify(changed)}\n`
          );
        }
      }
    });
    expect(manifestFailed.ok).toBe(false);
    expect(manifestFailed.deletedFiles).toBe(0);
    expect(manifestFailed.issues[0]?.code).toBe("finalize.plan_stale");
    for (const relativePath of preview2.mediaFiles) {
      await expect(stat(join(fixture2.root, relativePath))).resolves.toBeDefined();
    }
    await expect(stat(join(fixture2.root, "dist/demo-v2/completion-record.json"))).rejects.toThrow();
  });

  it("rejects projects-home / slug / config identity drift after preview as plan_stale", async () => {
    const fixture = await completionFixture({ outsideLauncherHome: true });
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);
    expect(preview.launcherAlreadyHome).toBe(false);

    // Projects home change after preview.
    const movedHome = join(fixture.projectsHome!, "..", "other-durable-projects");
    await mkdir(movedHome, { recursive: true });
    process.env.TSUGITE_PROJECTS_HOME = movedHome;
    const homeStale = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });
    expect(homeStale.ok).toBe(false);
    expect(homeStale.issues[0]?.code).toBe("finalize.plan_stale");
    expect(homeStale.deletedFiles).toBe(0);
    for (const relativePath of preview.mediaFiles) {
      await expect(stat(join(fixture.root, relativePath))).resolves.toBeDefined();
    }

    // Restore home and change slug (destination identity).
    process.env.TSUGITE_PROJECTS_HOME = fixture.projectsHome;
    const slugStale = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project: { ...project, slug: "demo-renamed" },
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });
    expect(slugStale.ok).toBe(false);
    expect(slugStale.issues[0]?.code).toBe("finalize.plan_stale");
    expect(slugStale.deletedFiles).toBe(0);

    // Config path identity change (same bytes, different path) still changes plan digest.
    const altConfig = join(fixture.root, "project.alt.yaml");
    await writeFile(altConfig, await readFile(fixture.configPath, "utf8"));
    const configStale = await finalizeCompletedProject({
      configPath: altConfig,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });
    expect(configStale.ok).toBe(false);
    expect(configStale.issues[0]?.code).toBe("finalize.plan_stale");
    expect(configStale.deletedFiles).toBe(0);
    for (const relativePath of preview.mediaFiles) {
      await expect(stat(join(fixture.root, relativePath))).resolves.toBeDefined();
    }
  });

  it("reports measured deletes when the second permanent delete fails after quarantine", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);
    expect(preview.mediaFiles.length).toBeGreaterThanOrEqual(2);
    const firstSize = preview.candidateIdentities?.[0]?.size;
    expect(firstSize).toBeGreaterThan(0);

    const failed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z",
      _testHooks: {
        beforePermanentDeleteIndex: async (index) => {
          if (index === 1) {
            throw new Error("injected permanent delete failure on second candidate");
          }
        }
      }
    });

    expect(failed.ok).toBe(false);
    expect(failed.deletedFiles).toBe(1);
    expect(failed.deletedBytes).toBe(firstSize);
    expect(failed.issues[0]?.code).toBe("finalize.cleanup_failed");
    // First candidate is gone permanently; remaining candidates are restored to original paths.
    await expect(stat(join(fixture.root, preview.mediaFiles[0]!))).rejects.toThrow();
    for (const relativePath of preview.mediaFiles.slice(1)) {
      await expect(stat(join(fixture.root, relativePath))).resolves.toBeDefined();
    }
    const record = JSON.parse(
      await readFile(join(fixture.root, "dist/demo-v2/completion-record.json"), "utf8")
    );
    expect(record.cleanup.media_files_deleted).toBe(1);
    expect(record.cleanup.bytes_reclaimed).toBe(firstSize);
    expect(record.cleanup.partial).toBe(true);
  });

  it("rolls back candidates when completion record write fails and does not zero an existing record", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);

    const recordPath = join(fixture.root, "dist/demo-v2/completion-record.json");
    const priorRecord = `${JSON.stringify({
      schema_version: 1,
      project_slug: "demo",
      run_id: "demo-v2",
      cleanup: { media_files_deleted: 9, bytes_reclaimed: 99, deleted_media_paths: ["kept"] }
    }, null, 2)}\n`;
    await writeFile(recordPath, priorRecord);

    const failed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z",
      _testHooks: {
        beforeRecordWrite: async () => {
          // Replace the record path with a directory so writeFile fails.
          await rm(recordPath, { force: true });
          await mkdir(recordPath);
        }
      }
    });

    expect(failed.ok).toBe(false);
    expect(failed.deletedFiles).toBe(0);
    expect(failed.issues[0]?.code).toBe("finalize.record_write_failed");
    for (const relativePath of preview.mediaFiles) {
      await expect(stat(join(fixture.root, relativePath))).resolves.toBeDefined();
    }
    // Directory still occupies the path after failed restore attempt; ensure not a zeroed JSON file.
    await expect(lstat(recordPath)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    expect((await lstat(recordPath)).isDirectory()).toBe(true);
  });

  it("leaves every cleanup candidate when launcher promotion fails before permanent delete", async () => {
    const fixture = await completionFixture({ outsideLauncherHome: true });
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);
    expect(preview.launcherAlreadyHome).toBe(false);

    // Block promotion by placing a non-directory at the durable destination path.
    await writeFile(join(fixture.projectsHome!, "demo"), "not a directory");

    const failed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });

    expect(failed.ok).toBe(false);
    expect(failed.deletedFiles).toBe(0);
    expect(failed.promotedToLauncherHome).toBe(false);
    expect(failed.issues[0]?.code).toBe("finalize.launcher_home_promote_failed");
    for (const relativePath of preview.mediaFiles) {
      await expect(stat(join(fixture.root, relativePath))).resolves.toBeDefined();
    }
    await expect(stat(join(fixture.root, "dist/demo-v2/completion-record.json"))).rejects.toThrow();
  });

  it("promotes a worktree project into the durable launcher home on apply", async () => {
    const fixture = await completionFixture({ outsideLauncherHome: true });

    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false,
      now: "2026-07-14T00:00:00.000Z"
    });
    expect(preview.ok).toBe(true);
    expect(preview.launcherAlreadyHome).toBe(false);
    expect(preview.promotedToLauncherHome).toBe(false);
    expect(preview.launcherProjectRoot).toBe(join(fixture.projectsHome!, "demo"));
    expect(preview.planDigest).toMatch(/^[a-f0-9]{64}$/);

    const result = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });
    expect(result.ok).toBe(true);
    expect(result.promotedToLauncherHome).toBe(true);
    expect(result.launcherProjectRoot).toBe(join(fixture.projectsHome!, "demo"));
    await expect(stat(join(fixture.projectsHome!, "demo", "dist/demo-v2/final.mp4"))).resolves.toBeDefined();
    await expect(stat(join(fixture.projectsHome!, "demo", "launcher-home.json"))).resolves.toBeDefined();
    await expect(stat(join(fixture.projectsHome!, "demo", "dist/demo-v1/assets/old.mp4"))).rejects.toThrow();
    // Superseded media is removed from the source tree after successful promote+delete.
    await expect(stat(join(fixture.root, "dist/demo-v1/assets/old.mp4"))).rejects.toThrow();
  });

  it("exports stable storage-identity comparison and plan digest launcher fields", () => {
    const left = { size: 10, mtimeMs: 1.5, device: 1, inode: 2 };
    const right = { size: 10, mtimeMs: 1.5, device: 1, inode: 2 };
    expect(sameFinalizeStorageIdentity(left, right)).toBe(true);
    expect(sameFinalizeStorageIdentity(left, { ...right, inode: 3 })).toBe(false);
    expect(sameFinalizeStorageIdentity(left, { ...right, size: 11 })).toBe(false);
    expect(sameFinalizeStorageIdentity(left, { ...right, mtimeMs: 2 })).toBe(false);
    expect(sameFinalizeStorageIdentity(left, { ...right, device: 9 })).toBe(false);

    const digestA = buildPlanDigest({
      projectRoot: "/proj",
      configPath: "/proj/project.yaml",
      manifestPath: "/proj/manifest.json",
      stateDir: "/proj/dist",
      projectsHome: "/durable",
      destinationRoot: "/durable/demo",
      alreadyHome: false,
      runId: "demo-v2",
      finalOutputDigest: "abc",
      gate3ApprovedInputDigest: "abc",
      retainedMedia: ["dist/demo-v2/final.mp4"],
      candidates: [{
        path: "media/old.mp4",
        size: 1,
        mtimeMs: 2,
        device: 3,
        inode: 4
      }]
    });
    const digestB = buildPlanDigest({
      projectRoot: "/proj",
      configPath: "/proj/project.yaml",
      manifestPath: "/proj/manifest.json",
      stateDir: "/proj/dist",
      projectsHome: "/other-durable",
      destinationRoot: "/other-durable/demo",
      alreadyHome: false,
      runId: "demo-v2",
      finalOutputDigest: "abc",
      gate3ApprovedInputDigest: "abc",
      retainedMedia: ["dist/demo-v2/final.mp4"],
      candidates: [{
        path: "media/old.mp4",
        size: 1,
        mtimeMs: 2,
        device: 3,
        inode: 4
      }]
    });
    expect(digestA).toMatch(/^[a-f0-9]{64}$/);
    expect(digestA).not.toBe(digestB);
  });

  it("rolls back when completion-record write fails after worktree promotion", async () => {
    const fixture = await completionFixture({ outsideLauncherHome: true });
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);

    const failed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z",
      _testHooks: {
        beforeRecordWrite: async (path) => {
          await rm(path, { force: true });
          await mkdir(path);
        }
      }
    });

    expect(failed.ok).toBe(false);
    expect(failed.deletedFiles).toBe(0);
    expect(failed.issues[0]?.code).toBe("finalize.record_write_failed");
    expect(failed.promotedToLauncherHome).toBe(false);
    for (const relativePath of preview.mediaFiles) {
      await expect(stat(join(fixture.root, relativePath))).resolves.toBeDefined();
    }
    // Transactional promotion: durable destination is rolled back (no partial promotion).
    await expect(stat(join(fixture.projectsHome!, "demo"))).rejects.toThrow();
    await expect(stat(join(fixture.projectsHome!, "demo", "launcher-home.json"))).rejects.toThrow();
  });

  it("refuses non-regular completion-record paths before journal creation", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);

    const recordPath = join(fixture.root, "dist/demo-v2/completion-record.json");
    await mkdir(recordPath, { recursive: true });

    const failed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });
    expect(failed.ok).toBe(false);
    expect(failed.issues.some((issue) => issue.code === "finalize.record_path_unsafe")).toBe(true);
    await expect(readFinalizeJournal(join(fixture.root, "dist"), "demo-v2")).resolves.toBeUndefined();
  });

  it("refuses completion-record leaf symlink before journal creation and never snapshots external content", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);

    const recordPath = join(fixture.root, "dist/demo-v2/completion-record.json");
    const external = join(fixture.root, "marketing/external-record.json");
    await writeFile(external, "external-secret-must-not-enter-journal\n");
    await symlink(external, recordPath);

    const failed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });

    expect(failed.ok).toBe(false);
    expect(failed.issues.some((issue) => issue.code === "finalize.record_path_symlink")).toBe(true);
    // Journal must not be created, so external content cannot land in previous_completion_record.
    await expect(readFinalizeJournal(join(fixture.root, "dist"), "demo-v2")).resolves.toBeUndefined();
    expect(await readFile(external, "utf8")).toBe("external-secret-must-not-enter-journal\n");
    for (const relativePath of preview.mediaFiles) {
      await expect(stat(join(fixture.root, relativePath))).resolves.toBeDefined();
    }
  });

  it("refuses journal leaf symlink and never writes through to the external target", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);

    const journalDir = join(fixture.root, "dist/.tsugite-finalize-journal");
    await mkdir(journalDir, { recursive: true });
    const journalPath = finalizeJournalPath(join(fixture.root, "dist"), "demo-v2");
    const external = join(fixture.root, "marketing/external-journal.json");
    await writeFile(external, "journal-secret\n");
    await symlink(external, journalPath);

    const failed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });

    expect(failed.ok).toBe(false);
    expect(await readFile(external, "utf8")).toBe("journal-secret\n");
    for (const relativePath of preview.mediaFiles) {
      await expect(stat(join(fixture.root, relativePath))).resolves.toBeDefined();
    }
  });

  it("writes source and durable completion-records only via non-symlink leaves after promotion", async () => {
    const fixture = await completionFixture({ outsideLauncherHome: true });
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);

    const applied = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });
    expect(applied.ok).toBe(true);

    const sourceRecord = join(fixture.root, "dist/demo-v2/completion-record.json");
    const durableRecord = join(fixture.projectsHome!, "demo", "dist/demo-v2/completion-record.json");
    await expect(lstat(sourceRecord)).resolves.toMatchObject({ isFile: expect.any(Function) });
    expect((await lstat(sourceRecord)).isSymbolicLink()).toBe(false);
    await expect(lstat(durableRecord)).resolves.toMatchObject({ isFile: expect.any(Function) });
    expect((await lstat(durableRecord)).isSymbolicLink()).toBe(false);
    const source = JSON.parse(await readFile(sourceRecord, "utf8"));
    const durable = JSON.parse(await readFile(durableRecord, "utf8"));
    expect(source.cleanup.plan_digest).toBe(preview.planDigest);
    expect(durable.cleanup.plan_digest).toBe(preview.planDigest);
    expect(durable.launcher.promoted).toBe(true);
  });

  it("writes a completion record when cleanup is already empty but the record is missing", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);
    const applied = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });
    expect(applied.ok).toBe(true);

    const recordPath = join(fixture.root, "dist/demo-v2/completion-record.json");
    await unlink(recordPath);

    const emptyPreview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(emptyPreview.ok).toBe(true);
    expect(emptyPreview.mediaFiles).toEqual([]);

    const rewritten = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: emptyPreview.planDigest,
      now: "2026-07-15T00:00:00.000Z"
    });
    expect(rewritten.ok).toBe(true);
    expect(rewritten.deletedFiles).toBe(0);
    await expect(stat(recordPath)).resolves.toBeDefined();
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    expect(record.cleanup.media_files_deleted).toBe(0);
    expect(record.cleanup.plan_digest).toBe(emptyPreview.planDigest);
  });

  it("rolls back remaining candidates when final/state/manifest drift is detected after promotion", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);

    const finalFailed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z",
      _testHooks: {
        afterPromote: async () => {
          await writeFile(join(fixture.root, "dist/demo-v2/final.mp4"), "changed after promote");
        }
      }
    });
    expect(finalFailed.ok).toBe(false);
    expect(finalFailed.deletedFiles).toBe(0);
    expect(finalFailed.issues[0]?.code).toBe("finalize.gate3_output_changed");
    for (const relativePath of preview.mediaFiles) {
      await expect(stat(join(fixture.root, relativePath))).resolves.toBeDefined();
    }

    const fixture2 = await completionFixture();
    const preview2 = await finalizeCompletedProject({
      configPath: fixture2.configPath,
      project,
      manifest: fixture2.manifest,
      apply: false
    });
    const digestFailed = await finalizeCompletedProject({
      configPath: fixture2.configPath,
      project,
      manifest: fixture2.manifest,
      apply: true,
      expectedPlanDigest: preview2.planDigest,
      now: "2026-07-14T00:00:00.000Z",
      _testHooks: {
        afterPromote: async () => {
          const statePath = join(fixture2.root, "dist/demo-v2/state.json");
          const state = JSON.parse(await readFile(statePath, "utf8"));
          state.gates.gate_3.approved_input_digest = "0".repeat(64);
          await writeFile(statePath, `${JSON.stringify(state)}\n`);
        }
      }
    });
    expect(digestFailed.ok).toBe(false);
    expect(digestFailed.deletedFiles).toBe(0);
    expect(digestFailed.issues[0]?.code).toBe("finalize.gate3_output_changed");
    for (const relativePath of preview2.mediaFiles) {
      await expect(stat(join(fixture2.root, relativePath))).resolves.toBeDefined();
    }

    const fixture3 = await completionFixture();
    const preview3 = await finalizeCompletedProject({
      configPath: fixture3.configPath,
      project,
      manifest: fixture3.manifest,
      apply: false
    });
    const retainedFailed = await finalizeCompletedProject({
      configPath: fixture3.configPath,
      project,
      manifest: fixture3.manifest,
      apply: true,
      expectedPlanDigest: preview3.planDigest,
      now: "2026-07-14T00:00:00.000Z",
      _testHooks: {
        afterPromote: async () => {
          // Drop a retained final-run media file (not only a manifest source).
          await unlink(join(fixture3.root, "dist/demo-v2/assets/current.mp4"));
        }
      }
    });
    expect(retainedFailed.ok).toBe(false);
    expect(retainedFailed.deletedFiles).toBe(0);
    expect(retainedFailed.issues[0]?.code).toBe("finalize.plan_stale");
    for (const relativePath of preview3.mediaFiles) {
      await expect(stat(join(fixture3.root, relativePath))).resolves.toBeDefined();
    }

    const fixture4 = await completionFixture();
    const preview4 = await finalizeCompletedProject({
      configPath: fixture4.configPath,
      project,
      manifest: fixture4.manifest,
      apply: false
    });
    const corruptManifest = await finalizeCompletedProject({
      configPath: fixture4.configPath,
      project,
      manifest: fixture4.manifest,
      apply: true,
      expectedPlanDigest: preview4.planDigest,
      now: "2026-07-14T00:00:00.000Z",
      _testHooks: {
        afterPromote: async () => {
          await writeFile(join(fixture4.root, "manifest.json"), "{not-json");
        }
      }
    });
    expect(corruptManifest.ok).toBe(false);
    expect(corruptManifest.deletedFiles).toBe(0);
    expect(corruptManifest.issues[0]?.code).toBe("finalize.plan_stale");
    for (const relativePath of preview4.mediaFiles) {
      await expect(stat(join(fixture4.root, relativePath))).resolves.toBeDefined();
    }
  });

  it("refuses permanent delete of a later candidate after identity swap and keeps measured progress", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);
    expect(preview.mediaFiles.length).toBeGreaterThanOrEqual(2);
    const firstSize = preview.candidateIdentities?.[0]?.size;
    expect(firstSize).toBeGreaterThan(0);
    const retainedBytes = await readFile(join(fixture.root, "dist/demo-v2/final.mp4"));

    const failed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z",
      _testHooks: {
        beforePermanentDeleteIndex: async (index, quarantinedPath) => {
          if (index === 1) {
            await unlink(quarantinedPath);
            await writeFile(quarantinedPath, retainedBytes);
          }
        }
      }
    });

    expect(failed.ok).toBe(false);
    expect(failed.deletedFiles).toBe(1);
    expect(failed.deletedBytes).toBe(firstSize);
    expect(failed.issues[0]?.code).toBe("finalize.candidate_changed");
    await expect(stat(join(fixture.root, preview.mediaFiles[0]!))).rejects.toThrow();
    for (const relativePath of preview.mediaFiles.slice(1)) {
      await expect(stat(join(fixture.root, relativePath))).resolves.toBeDefined();
    }
  });

  it("writes final/QA/completion-record on the durable copy after worktree promotion", async () => {
    const fixture = await completionFixture({ outsideLauncherHome: true });
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false,
      now: "2026-07-14T00:00:00.000Z"
    });
    expect(preview.ok).toBe(true);
    expect(preview.launcherAlreadyHome).toBe(false);

    const result = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });
    expect(result.ok).toBe(true);
    expect(result.promotedToLauncherHome).toBe(true);

    const durableRoot = join(fixture.projectsHome!, "demo");
    const durableRecord = join(durableRoot, "dist/demo-v2/completion-record.json");
    const durableFinal = join(durableRoot, "dist/demo-v2/final.mp4");
    const durableGate3 = join(durableRoot, "dist/demo-v2/gate3-qc.json");
    const durableRender = join(durableRoot, "dist/demo-v2/render-report.json");

    await expect(stat(durableFinal)).resolves.toBeDefined();
    await expect(stat(durableGate3)).resolves.toBeDefined();
    await expect(stat(durableRender)).resolves.toBeDefined();
    await expect(stat(durableRecord)).resolves.toBeDefined();
    // Returned record path must point at the durable completion record.
    expect(result.recordPath).toBe(durableRecord);

    const record = JSON.parse(await readFile(durableRecord, "utf8"));
    expect(record).toMatchObject({
      schema_version: 1,
      project_slug: "demo",
      run_id: "demo-v2",
      canonical_output: "dist/demo-v2/final.mp4",
      cleanup: {
        media_files_deleted: 3,
        plan_digest: preview.planDigest
      },
      launcher: {
        projects_home: fixture.projectsHome,
        project_root: durableRoot,
        promoted: true
      }
    });
    // Source tree also keeps a completion record for local audit continuity.
    await expect(stat(join(fixture.root, "dist/demo-v2/completion-record.json"))).resolves.toBeDefined();
  });

  it("records measured deleted files/bytes and never overwrites an existing record with zero on idempotent re-apply", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);
    const plannedBytes = preview.plannedBytes;
    expect(plannedBytes).toBeGreaterThan(0);

    const applied = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });
    expect(applied.ok).toBe(true);
    expect(applied.deletedFiles).toBe(3);
    expect(applied.deletedBytes).toBe(plannedBytes);

    const recordPath = join(fixture.root, "dist/demo-v2/completion-record.json");
    const recordText = await readFile(recordPath, "utf8");
    const record = JSON.parse(recordText);
    expect(record.cleanup.media_files_deleted).toBe(3);
    expect(record.cleanup.bytes_reclaimed).toBe(plannedBytes);

    const emptyPreview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(emptyPreview.ok).toBe(true);
    const repeated = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: emptyPreview.planDigest,
      now: "2026-07-15T00:00:00.000Z"
    });
    expect(repeated.ok).toBe(true);
    expect(repeated.deletedFiles).toBe(0);
    expect(repeated.deletedBytes).toBe(0);
    expect(await readFile(recordPath, "utf8")).toBe(recordText);
  });

  it("retains hardlinked and Unicode-aliased media by realpath/device/inode identity, not string path alone", async () => {
    const fixture = await completionFixture();
    const canonical = join(fixture.root, "media/current.mp4");
    const hardlinkAlias = join(fixture.root, "media/current-alias-link.mp4");
    await link(canonical, hardlinkAlias);

    const nfcName = "media/caf\u00e9-source.mp4"; // NFC é
    const nfdName = "media/cafe\u0301-source.mp4"; // NFD e + combining acute
    const nfcPath = join(fixture.root, nfcName);
    await writeFile(nfcPath, "unicode retained source");
    // On macOS APFS the NFD path often resolves to the same inode; create the alias path string for the scan set.
    const nfdPath = join(fixture.root, nfdName);
    let unicodeAliasPath = nfdPath;
    try {
      await link(nfcPath, nfdPath);
    } catch {
      // If the filesystem already unifies NFC/NFD, the NFD path may already exist or collide.
      unicodeAliasPath = nfcPath;
    }

    const unicodeManifest = {
      ...fixture.manifest,
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
        },
        {
          id: "unicode",
          src: nfcName,
          in: 0,
          out: 1,
          duration: 1,
          fps: 30,
          resolution: { width: 1280, height: 720 },
          audio: false
        }
      ]
    } as Manifest;
    await writeFile(join(fixture.root, "manifest.json"), `${JSON.stringify(unicodeManifest)}\n`);

    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: unicodeManifest,
      apply: false
    });
    expect(preview.ok).toBe(true);
    expect(preview.mediaFiles).not.toContain("media/current-alias-link.mp4");
    expect(preview.retainedMedia).toEqual(expect.arrayContaining([
      "media/current.mp4",
      "media/current-alias-link.mp4"
    ]));
    // Unicode alias of a referenced file must not be a deletion candidate.
    expect(preview.mediaFiles.some((path) => path.includes("caf") && path.endsWith(".mp4"))).toBe(false);

    const applied = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: unicodeManifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });
    expect(applied.ok).toBe(true);
    await expect(stat(hardlinkAlias)).resolves.toBeDefined();
    await expect(stat(canonical)).resolves.toBeDefined();
    await expect(stat(unicodeAliasPath)).resolves.toBeDefined();
  });

  it("recovers pre-delete journal phases by rolling quarantined files back on re-apply", async () => {
    const preDeletePhases = [
      "planned",
      "quarantining",
      "quarantined",
      "promoting",
      "promoted",
      "recording",
      "recorded"
    ] as const;

    for (const phase of preDeletePhases) {
      const fixture = await completionFixture();
      const originalRelative = "dist/demo-v1/assets/old.mp4";
      const originalPath = join(fixture.root, originalRelative);
      const originalBytes = await readFile(originalPath);
      const stats = await lstat(originalPath);
      const quarantineRoot = join(
        fixture.root,
        "dist/.tsugite-finalize-quarantine/demo-v2",
        "11111111-1111-4111-8111-111111111111"
      );
      const quarantinePath = join(quarantineRoot, "0000-old.mp4");
      await mkdir(quarantineRoot, { recursive: true });
      await rename(originalPath, quarantinePath);

      const journalPath = finalizeJournalPath(join(fixture.root, "dist"), "demo-v2");
      await mkdir(join(fixture.root, "dist/.tsugite-finalize-journal"), { recursive: true });
      await writeFile(journalPath, `${JSON.stringify({
        schema_version: 1,
        run_id: "demo-v2",
        plan_digest: "a".repeat(64),
        phase,
        quarantine_root: quarantineRoot,
        candidates: [{
          original_path: originalPath,
          original_relative: originalRelative,
          quarantine_path: quarantinePath,
          identity: {
            path: originalRelative,
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            device: stats.dev,
            inode: stats.ino
          },
          permanently_deleted: false
        }],
        deleted_files: 0,
        deleted_bytes: 0,
        deleted_paths: [],
        created_at: "2026-07-14T00:00:00.000Z",
        updated_at: "2026-07-14T00:00:00.000Z"
      }, null, 2)}\n`);

      const blockedPreview = await finalizeCompletedProject({
        configPath: fixture.configPath,
        project,
        manifest: fixture.manifest,
        apply: false
      });
      expect(blockedPreview.ok).toBe(false);
      expect(blockedPreview.issues[0]?.code).toBe("finalize.incomplete_journal");

      // Recovery runs before digest validation; wrong digest still restores pre-delete quarantine.
      const recovered = await finalizeCompletedProject({
        configPath: fixture.configPath,
        project,
        manifest: fixture.manifest,
        apply: true,
        expectedPlanDigest: "0".repeat(64),
        now: "2026-07-14T01:00:00.000Z"
      });
      expect(recovered.ok).toBe(false);
      expect(recovered.issues[0]?.code).toBe("finalize.plan_stale");
      await expect(readFile(originalPath)).resolves.toEqual(originalBytes);
      await expect(readFinalizeJournal(join(fixture.root, "dist"), "demo-v2")).resolves.toBeUndefined();
      await expect(stat(quarantinePath)).rejects.toThrow();
    }
  });

  it("accumulates measured deletes across partial permanent-delete failure and retry", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);
    expect(preview.mediaFiles.length).toBeGreaterThanOrEqual(2);
    const firstSize = preview.candidateIdentities?.[0]?.size ?? 0;
    expect(firstSize).toBeGreaterThan(0);

    const partial = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z",
      _testHooks: {
        beforePermanentDeleteIndex: async (index) => {
          if (index === 1) throw new Error("injected partial permanent delete failure");
        }
      }
    });
    expect(partial.ok).toBe(false);
    expect(partial.deletedFiles).toBe(1);
    expect(partial.deletedBytes).toBe(firstSize);
    const journal = await readFinalizeJournal(join(fixture.root, "dist"), "demo-v2");
    expect(journal).toBeDefined();
    expect(journal?.deleted_files).toBe(1);
    expect(journal?.deleted_bytes).toBe(firstSize);
    expect(journal?.deleted_paths).toEqual([preview.mediaFiles[0]]);

    // Preview is fail-closed while the partial journal remains.
    const blockedPreview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(blockedPreview.ok).toBe(false);
    expect(blockedPreview.issues[0]?.code).toBe("finalize.incomplete_journal");

    // Recovery keeps prior measured deletes, restores remaining candidates, then exposes the live plan.
    const recoverAttempt = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: "0".repeat(64),
      now: "2026-07-14T01:00:00.000Z"
    });
    expect(recoverAttempt.ok).toBe(false);
    expect(recoverAttempt.planDigest).toMatch(/^[a-f0-9]{64}$/);
    const retryDigest = recoverAttempt.planDigest;

    const finished = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: retryDigest,
      now: "2026-07-14T02:00:00.000Z"
    });
    expect(finished.ok).toBe(true);
    // Cumulative: first partial delete + remaining candidates.
    expect(finished.deletedFiles).toBe(preview.mediaFiles.length);
    expect(finished.deletedBytes).toBe(preview.plannedBytes);
    const record = JSON.parse(
      await readFile(join(fixture.root, "dist/demo-v2/completion-record.json"), "utf8")
    );
    expect(record.cleanup.media_files_deleted).toBe(preview.mediaFiles.length);
    expect(record.cleanup.bytes_reclaimed).toBe(preview.plannedBytes);
    expect(record.cleanup.deleted_media_paths).toEqual(
      expect.arrayContaining(preview.mediaFiles)
    );
    await expect(readFinalizeJournal(join(fixture.root, "dist"), "demo-v2")).resolves.toBeUndefined();
  });

  it("reports rollback_failed with unrestored paths instead of claiming a clean zero-delete restore", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);
    expect(preview.mediaFiles.length).toBeGreaterThanOrEqual(1);

    const failed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z",
      _testHooks: {
        afterQuarantineIndex: async (index, quarantinedPath) => {
          if (index !== 0) return;
          // Block restore of the original path so rollback cannot rename back.
          await mkdir(join(fixture.root, preview.mediaFiles[0]!), { recursive: true });
          // Keep the quarantined file in place; primary failure comes from later candidate mutation.
          void quarantinedPath;
        },
        afterJournalPhase: async (phase) => {
          if (phase === "quarantined") {
            // Force failure after quarantine so rollback is attempted.
            await writeFile(join(fixture.root, "dist/demo-v2/final.mp4"), "tampered to force rollback");
          }
        }
      }
    });

    expect(failed.ok).toBe(false);
    // Must not advertise a clean restore just because permanent deletes are still zero.
    expect(failed.issues.some((issue) => issue.code === "finalize.rollback_failed")).toBe(true);
    expect(failed.unrestoredPaths?.length).toBeGreaterThan(0);
    expect(failed.deletedFiles).toBe(0);
  });

  it("keeps measured deletes and journal truth when partial completion-record correction fails", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);
    expect(preview.mediaFiles.length).toBeGreaterThanOrEqual(2);
    const firstSize = preview.candidateIdentities?.[0]?.size ?? 0;
    const recordPath = join(fixture.root, "dist/demo-v2/completion-record.json");

    const failed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z",
      _testHooks: {
        beforePermanentDeleteIndex: async (index) => {
          if (index === 1) {
            // After the pre-delete record write, turn the record path into a directory so
            // partial correction cannot rewrite measured totals.
            await rm(recordPath, { force: true });
            await mkdir(recordPath);
            throw new Error("injected permanent delete failure after first unlink");
          }
        }
      }
    });

    expect(failed.ok).toBe(false);
    expect(failed.deletedFiles).toBe(1);
    expect(failed.deletedBytes).toBe(firstSize);
    expect(failed.issues.some((issue) => issue.code === "finalize.cleanup_failed")).toBe(true);
    expect(failed.issues.some((issue) => issue.code === "finalize.record_correction_failed")).toBe(true);
    const journal = await readFinalizeJournal(join(fixture.root, "dist"), "demo-v2");
    expect(journal).toBeDefined();
    expect(journal?.deleted_files).toBe(1);
    expect(journal?.deleted_bytes).toBe(firstSize);
    // Record path is a directory, so JSON truth lives in the journal.
    expect((await lstat(recordPath)).isDirectory()).toBe(true);
  });

  it("refuses runDir symlink / realpath escape before writing state or completion records", async () => {
    const fixture = await completionFixture();
    const realRun = join(fixture.root, "dist/demo-v2");
    const shadow = join(fixture.root, "shadow-run");
    await rename(realRun, shadow);
    await symlink(shadow, realRun);

    const result = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("finalize.run_dir_symlink");
    await expect(stat(join(shadow, "final.mp4"))).resolves.toBeDefined();
    await expect(stat(join(shadow, "completion-record.json"))).rejects.toThrow();
  });

  it("exports preflightFinalizeApplyBoundary that rejects unapproved stateDir without mutation", async () => {
    const fixture = await completionFixture();
    const outside = await mkdtemp(join(tmpdir(), "tsugite-finalize-preflight-"));
    const denied = await preflightFinalizeApplyBoundary({
      configPath: fixture.configPath,
      project,
      stateDir: outside
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.issues[0]?.code).toBe("finalize.state_dir_unapproved");
    }
    const allowed = await preflightFinalizeApplyBoundary({
      configPath: fixture.configPath,
      project
    });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.stateDir).toBe(join(fixture.root, "dist"));
      expect(allowed.runId).toBe("demo-v2");
    }
  });

  it("refuses orphan quarantine without a journal instead of ignoring it", async () => {
    const fixture = await completionFixture();
    const orphanRoot = join(fixture.root, "dist/.tsugite-finalize-quarantine/demo-v2/orphan-session");
    await mkdir(orphanRoot, { recursive: true });
    await writeFile(join(orphanRoot, "0000-old.mp4"), "stranded quarantine bytes");

    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(false);
    expect(preview.issues[0]?.code).toBe("finalize.orphan_quarantine");

    const applied = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: "0".repeat(64),
      now: "2026-07-14T00:00:00.000Z"
    });
    expect(applied.ok).toBe(false);
    expect(applied.issues[0]?.code).toBe("finalize.orphan_quarantine");
    await expect(stat(join(orphanRoot, "0000-old.mp4"))).resolves.toBeDefined();
    await expect(stat(join(fixture.root, "dist/demo-v1/assets/old.mp4"))).resolves.toBeDefined();
  });

  it("clears a completed journal on apply recovery and continues normally", async () => {
    const fixture = await completionFixture();
    const journalPath = finalizeJournalPath(join(fixture.root, "dist"), "demo-v2");
    await mkdir(join(fixture.root, "dist/.tsugite-finalize-journal"), { recursive: true });
    await writeFile(journalPath, `${JSON.stringify({
      schema_version: 1,
      run_id: "demo-v2",
      plan_digest: "b".repeat(64),
      phase: "completed",
      quarantine_root: join(
        fixture.root,
        "dist/.tsugite-finalize-quarantine/demo-v2",
        "22222222-2222-4222-8222-222222222222"
      ),
      candidates: [],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z"
    }, null, 2)}\n`);

    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    // completed journals are not incomplete; preview may still succeed.
    expect(preview.ok).toBe(true);

    const applied = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });
    expect(applied.ok).toBe(true);
    await expect(readFinalizeJournal(join(fixture.root, "dist"), "demo-v2")).resolves.toBeUndefined();
  });

  it("surfaces rollback_failed when pre-delete journal recovery cannot restore originals", async () => {
    const fixture = await completionFixture();
    const originalRelative = "dist/demo-v1/assets/old.mp4";
    const originalPath = join(fixture.root, originalRelative);
    const stats = await lstat(originalPath);
    const quarantineRoot = join(
      fixture.root,
      "dist/.tsugite-finalize-quarantine/demo-v2",
      "33333333-3333-4333-8333-333333333333"
    );
    const quarantinePath = join(quarantineRoot, "0000-old.mp4");
    await mkdir(quarantineRoot, { recursive: true });
    await rename(originalPath, quarantinePath);
    // Occupy the original path so rename-back fails.
    await mkdir(originalPath, { recursive: true });

    const journalPath = finalizeJournalPath(join(fixture.root, "dist"), "demo-v2");
    await mkdir(join(fixture.root, "dist/.tsugite-finalize-journal"), { recursive: true });
    await writeFile(journalPath, `${JSON.stringify({
      schema_version: 1,
      run_id: "demo-v2",
      plan_digest: "c".repeat(64),
      phase: "quarantined",
      quarantine_root: quarantineRoot,
      candidates: [{
        original_path: originalPath,
        original_relative: originalRelative,
        quarantine_path: quarantinePath,
        identity: {
          path: originalRelative,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          device: stats.dev,
          inode: stats.ino
        },
        permanently_deleted: false
      }],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z"
    }, null, 2)}\n`);

    const recovered = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: "0".repeat(64),
      now: "2026-07-14T01:00:00.000Z"
    });
    expect(recovered.ok).toBe(false);
    expect(recovered.issues.some((issue) => issue.code === "finalize.rollback_failed")).toBe(true);
    expect(recovered.unrestoredPaths).toContain(originalPath);
    await expect(readFinalizeJournal(join(fixture.root, "dist"), "demo-v2")).resolves.toBeDefined();
  });

  it("keeps prior measured deletes when partial recovery rollback fails", async () => {
    const fixture = await completionFixture();
    const originalRelative = "media/unused-draft.wav";
    const originalPath = join(fixture.root, originalRelative);
    const stats = await lstat(originalPath);
    const quarantineRoot = join(
      fixture.root,
      "dist/.tsugite-finalize-quarantine/demo-v2",
      "44444444-4444-4444-8444-444444444444"
    );
    const quarantinePath = join(quarantineRoot, "0000-unused-draft.wav");
    await mkdir(quarantineRoot, { recursive: true });
    await rename(originalPath, quarantinePath);
    await mkdir(originalPath, { recursive: true });

    const journalPath = finalizeJournalPath(join(fixture.root, "dist"), "demo-v2");
    await mkdir(join(fixture.root, "dist/.tsugite-finalize-journal"), { recursive: true });
    await writeFile(journalPath, `${JSON.stringify({
      schema_version: 1,
      run_id: "demo-v2",
      plan_digest: "d".repeat(64),
      phase: "deleting",
      quarantine_root: quarantineRoot,
      candidates: [
        {
          original_path: join(fixture.root, "dist/demo-v1/assets/old.mp4"),
          original_relative: "dist/demo-v1/assets/old.mp4",
          identity: {
            path: "dist/demo-v1/assets/old.mp4",
            size: 1,
            mtimeMs: 1,
            device: stats.dev,
            inode: 1
          },
          permanently_deleted: true
        },
        {
          original_path: originalPath,
          original_relative: originalRelative,
          quarantine_path: quarantinePath,
          identity: {
            path: originalRelative,
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            device: stats.dev,
            inode: stats.ino
          },
          permanently_deleted: false
        }
      ],
      deleted_files: 1,
      deleted_bytes: 19,
      deleted_paths: ["dist/demo-v1/assets/old.mp4"],
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z"
    }, null, 2)}\n`);

    const recovered = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: "0".repeat(64),
      now: "2026-07-14T01:00:00.000Z"
    });
    expect(recovered.ok).toBe(false);
    expect(recovered.issues.some((issue) => issue.code === "finalize.rollback_failed")).toBe(true);
    expect(recovered.deletedFiles).toBe(1);
    expect(recovered.deletedBytes).toBe(19);
    expect(recovered.unrestoredPaths).toContain(originalPath);
  });

  it("rejects preflight when runDir is a symlink even if stateDir itself is clean", async () => {
    const fixture = await completionFixture();
    const realRun = join(fixture.root, "dist/demo-v2");
    const shadow = join(fixture.root, "shadow-run-preflight");
    await rename(realRun, shadow);
    await symlink(shadow, realRun);

    const denied = await preflightFinalizeApplyBoundary({
      configPath: fixture.configPath,
      project
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.issues[0]?.code).toBe("finalize.run_dir_symlink");
    }
  });

  it("writes a journal with plan digest and candidate identities before quarantine mutations", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);

    let sawPlanned = false;
    const crashed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z",
      _testHooks: {
        afterJournalPhase: async (phase, journal) => {
          if (phase === "planned") {
            sawPlanned = true;
            expect(journal.plan_digest).toBe(preview.planDigest);
            expect(journal.candidates.length).toBe(preview.mediaFiles.length);
            expect(journal.candidates[0]?.identity.device).toEqual(expect.any(Number));
            expect(journal.candidates[0]?.identity.inode).toEqual(expect.any(Number));
            // No permanent deletes yet; originals still present at planned phase.
            for (const relativePath of preview.mediaFiles) {
              await expect(stat(join(fixture.root, relativePath))).resolves.toBeDefined();
            }
            throw new Error("stop after planned journal write");
          }
        }
      }
    });
    expect(sawPlanned).toBe(true);
    expect(crashed.ok).toBe(false);
    expect(crashed.deletedFiles).toBe(0);
    for (const relativePath of preview.mediaFiles) {
      await expect(stat(join(fixture.root, relativePath))).resolves.toBeDefined();
    }
  });

  it("keeps a broken journal fail-closed and refuses unvalidated absolute path recovery", async () => {
    const fixture = await completionFixture();
    const journalPath = finalizeJournalPath(join(fixture.root, "dist"), "demo-v2");
    await mkdir(join(fixture.root, "dist/.tsugite-finalize-journal"), { recursive: true });
    await writeFile(journalPath, "{not-json");

    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(false);
    expect(preview.issues[0]?.code).toBe("finalize.journal_invalid");
    await expect(readFile(journalPath, "utf8")).resolves.toBe("{not-json");

    // Outside-project original_path must not be renamed during recovery.
    const outsideDir = await mkdtemp(join(tmpdir(), "tsugite-finalize-outside-"));
    const outsideFile = join(outsideDir, "secret.mp4");
    await writeFile(outsideFile, "do-not-touch");
    const quarantineRoot = join(
      fixture.root,
      "dist/.tsugite-finalize-quarantine/demo-v2",
      "55555555-5555-4555-8555-555555555555"
    );
    await mkdir(quarantineRoot, { recursive: true });
    await writeFile(journalPath, `${JSON.stringify({
      schema_version: 1,
      run_id: "demo-v2",
      plan_digest: "e".repeat(64),
      phase: "quarantined",
      quarantine_root: quarantineRoot,
      candidates: [{
        original_path: outsideFile,
        original_relative: "../escape/secret.mp4",
        quarantine_path: join(quarantineRoot, "0000-secret.mp4"),
        identity: {
          path: "../escape/secret.mp4",
          size: 11,
          mtimeMs: 1,
          device: 1,
          inode: 1
        },
        permanently_deleted: false
      }],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z"
    }, null, 2)}\n`);

    const recovered = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: "0".repeat(64),
      now: "2026-07-14T01:00:00.000Z"
    });
    expect(recovered.ok).toBe(false);
    expect(recovered.issues.some((issue) => (
      issue.code === "finalize.journal_path_unsafe" || issue.code === "finalize.journal_invalid"
    ))).toBe(true);
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("do-not-touch");
    await expect(readFinalizeJournal(join(fixture.root, "dist"), "demo-v2")).resolves.toBeDefined();
  });

  it("refuses journal recovery through a symlink ancestor and does not mutate the external target", async () => {
    const fixture = await completionFixture();
    const outsideDir = await mkdtemp(join(tmpdir(), "tsugite-finalize-symlink-ancestor-"));
    const outsideFile = join(outsideDir, "secret.mp4");
    await writeFile(outsideFile, "symlink-ancestor-secret");

    // String containment under dist/ passes; realpath escapes via the symlink ancestor.
    const linkDir = join(fixture.root, "dist/evil-link");
    await symlink(outsideDir, linkDir);
    const poisonedOriginal = join(linkDir, "secret.mp4");

    const quarantineRoot = join(
      fixture.root,
      "dist/.tsugite-finalize-quarantine/demo-v2",
      "66666666-6666-4666-8666-666666666666"
    );
    const quarantinePath = join(quarantineRoot, "0000-secret.mp4");
    await mkdir(quarantineRoot, { recursive: true });
    // Plant a quarantine copy so an unvalidated recovery would rename it onto the symlink path.
    await writeFile(quarantinePath, "quarantined-copy");

    const journalPath = finalizeJournalPath(join(fixture.root, "dist"), "demo-v2");
    await mkdir(join(fixture.root, "dist/.tsugite-finalize-journal"), { recursive: true });
    await writeFile(journalPath, `${JSON.stringify({
      schema_version: 1,
      run_id: "demo-v2",
      plan_digest: "e".repeat(64),
      phase: "quarantined",
      quarantine_root: quarantineRoot,
      candidates: [{
        original_path: poisonedOriginal,
        original_relative: "dist/evil-link/secret.mp4",
        quarantine_path: quarantinePath,
        identity: {
          path: "dist/evil-link/secret.mp4",
          size: 15,
          mtimeMs: 1,
          device: 1,
          inode: 1
        },
        permanently_deleted: false
      }],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z"
    }, null, 2)}\n`);

    const recovered = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: "0".repeat(64),
      now: "2026-07-14T01:00:00.000Z"
    });
    expect(recovered.ok).toBe(false);
    expect(recovered.issues.some((issue) => issue.code === "finalize.journal_path_unsafe")).toBe(true);
    // External target and quarantine copy must remain untouched (no recovery rename).
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("symlink-ancestor-secret");
    await expect(readFile(quarantinePath, "utf8")).resolves.toBe("quarantined-copy");
    await expect(readFinalizeJournal(join(fixture.root, "dist"), "demo-v2")).resolves.toBeDefined();
  });

  it("refuses relative quarantine_root and file-shaped quarantine_root without mutation", async () => {
    const fixture = await completionFixture();
    const journalPath = finalizeJournalPath(join(fixture.root, "dist"), "demo-v2");
    await mkdir(join(fixture.root, "dist/.tsugite-finalize-journal"), { recursive: true });

    await writeFile(journalPath, `${JSON.stringify({
      schema_version: 1,
      run_id: "demo-v2",
      plan_digest: "e".repeat(64),
      phase: "quarantined",
      quarantine_root: "dist/.tsugite-finalize-quarantine/demo-v2/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      candidates: [],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z"
    }, null, 2)}\n`);

    const relativeRoot = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: "0".repeat(64),
      now: "2026-07-14T01:00:00.000Z"
    });
    expect(relativeRoot.ok).toBe(false);
    expect(relativeRoot.issues[0]?.code).toBe("finalize.journal_path_unsafe");

    const fileRoot = join(
      fixture.root,
      "dist/.tsugite-finalize-quarantine/demo-v2",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    );
    await mkdir(join(fixture.root, "dist/.tsugite-finalize-quarantine/demo-v2"), { recursive: true });
    await writeFile(fileRoot, "not-a-directory");
    await writeFile(journalPath, `${JSON.stringify({
      schema_version: 1,
      run_id: "demo-v2",
      plan_digest: "e".repeat(64),
      phase: "quarantined",
      quarantine_root: fileRoot,
      candidates: [],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z"
    }, null, 2)}\n`);

    const fileShaped = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: "0".repeat(64),
      now: "2026-07-14T01:00:00.000Z"
    });
    expect(fileShaped.ok).toBe(false);
    expect(fileShaped.issues[0]?.code).toBe("finalize.journal_path_unsafe");
    await expect(readFile(fileRoot, "utf8")).resolves.toBe("not-a-directory");
  });

  it("refuses non-UUID quarantine_root journals without filesystem mutation", async () => {
    const fixture = await completionFixture();
    const originalRelative = "dist/demo-v1/assets/old.mp4";
    const originalPath = join(fixture.root, originalRelative);
    const originalBytes = await readFile(originalPath);
    const stats = await lstat(originalPath);
    const quarantineRoot = join(fixture.root, "dist/.tsugite-finalize-quarantine/demo-v2/not-a-uuid");
    const quarantinePath = join(quarantineRoot, "0000-old.mp4");
    await mkdir(quarantineRoot, { recursive: true });
    await rename(originalPath, quarantinePath);

    const journalPath = finalizeJournalPath(join(fixture.root, "dist"), "demo-v2");
    await mkdir(join(fixture.root, "dist/.tsugite-finalize-journal"), { recursive: true });
    await writeFile(journalPath, `${JSON.stringify({
      schema_version: 1,
      run_id: "demo-v2",
      plan_digest: "e".repeat(64),
      phase: "quarantined",
      quarantine_root: quarantineRoot,
      candidates: [{
        original_path: originalPath,
        original_relative: originalRelative,
        quarantine_path: quarantinePath,
        identity: {
          path: originalRelative,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          device: stats.dev,
          inode: stats.ino
        },
        permanently_deleted: false
      }],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z"
    }, null, 2)}\n`);

    const recovered = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: "0".repeat(64),
      now: "2026-07-14T01:00:00.000Z"
    });
    expect(recovered.ok).toBe(false);
    expect(recovered.issues[0]?.code).toBe("finalize.journal_path_unsafe");
    // Must not restore via rename when quarantine_root shape is invalid.
    await expect(stat(originalPath)).rejects.toThrow();
    await expect(readFile(quarantinePath)).resolves.toEqual(originalBytes);
    await expect(readFinalizeJournal(join(fixture.root, "dist"), "demo-v2")).resolves.toBeDefined();
  });

  it("recovers a crash immediately after quarantine rename using write-ahead move intent", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);
    expect(preview.mediaFiles.length).toBeGreaterThanOrEqual(1);
    const firstRelative = preview.mediaFiles[0]!;
    const firstOriginal = join(fixture.root, firstRelative);
    const firstBytes = await readFile(firstOriginal);

    let sawPostRename = false;
    const crashed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z",
      _testHooks: {
        afterQuarantineIndex: async (index, quarantinedPath) => {
          if (index !== 0) return;
          sawPostRename = true;
          // Write-ahead journal already has quarantine_path before rename; crash right after rename.
          await expect(stat(quarantinedPath)).resolves.toBeDefined();
          await expect(stat(firstOriginal)).rejects.toThrow();
          const journal = await readFinalizeJournal(join(fixture.root, "dist"), "demo-v2");
          expect(journal?.candidates[0]?.quarantine_path).toBe(quarantinedPath);
          throw new Error("crash immediately after quarantine rename");
        }
      }
    });
    expect(sawPostRename).toBe(true);
    expect(crashed.ok).toBe(false);
    expect(crashed.deletedFiles).toBe(0);

    // Recovery must restore from write-ahead quarantine_path even though the process died post-rename.
    const recovered = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: "0".repeat(64),
      now: "2026-07-14T01:00:00.000Z"
    });
    expect(recovered.ok).toBe(false);
    expect(recovered.issues[0]?.code).toBe("finalize.plan_stale");
    await expect(readFile(firstOriginal)).resolves.toEqual(firstBytes);
    await expect(readFinalizeJournal(join(fixture.root, "dist"), "demo-v2")).resolves.toBeUndefined();
  });

  it("preserves cumulative deletes after a crash between delete intent and measured journal update", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);
    expect(preview.mediaFiles.length).toBeGreaterThanOrEqual(2);
    const firstRelative = preview.mediaFiles[0]!;
    const firstSize = preview.candidateIdentities?.[0]?.size ?? 0;
    expect(firstSize).toBeGreaterThan(0);

    let intentCount = 0;
    const crashed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z",
      _testHooks: {
        afterJournalPhase: async (phase, journal) => {
          if (phase !== "deleting") return;
          const withIntent = journal.candidates.filter((candidate) => candidate.delete_intent === true);
          if (withIntent.length === 1 && !withIntent[0]?.permanently_deleted) {
            intentCount += 1;
            if (intentCount === 1) {
              // Intent is durable before unlink. Simulate the post-unlink crash shape:
              // quarantine is gone, permanently_deleted not yet written.
              const target = withIntent[0]!;
              if (target.quarantine_path) {
                await unlink(target.quarantine_path).catch(() => undefined);
              }
              throw new Error("crash after delete intent / unlink");
            }
          }
        }
      }
    });
    expect(crashed.ok).toBe(false);

    const recoverAttempt = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: "0".repeat(64),
      now: "2026-07-14T01:00:00.000Z"
    });
    expect(recoverAttempt.ok).toBe(false);
    // plan_stale responses zero the result counters; journal is the durable measured truth.
    const journal = await readFinalizeJournal(join(fixture.root, "dist"), "demo-v2");
    expect(journal?.deleted_files).toBeGreaterThanOrEqual(1);
    expect(journal?.deleted_bytes).toBeGreaterThanOrEqual(firstSize);
    expect(journal?.deleted_paths).toEqual(expect.arrayContaining([firstRelative]));

    const finished = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: recoverAttempt.planDigest,
      now: "2026-07-14T02:00:00.000Z"
    });
    expect(finished.ok).toBe(true);
    expect(finished.deletedFiles).toBe(preview.mediaFiles.length);
    expect(finished.deletedBytes).toBe(preview.plannedBytes);
  });

  it("restores the previous completion-record when rolling back a recording-phase crash", async () => {
    const fixture = await completionFixture();
    const recordPath = join(fixture.root, "dist/demo-v2/completion-record.json");
    const priorRecord = `${JSON.stringify({ schema_version: 1, note: "prior-record" }, null, 2)}\n`;
    await writeFile(recordPath, priorRecord);

    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);

    const crashed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z",
      _testHooks: {
        afterJournalPhase: async (phase) => {
          if (phase === "recorded") {
            throw new Error("crash after provisional completion-record write");
          }
        }
      }
    });
    expect(crashed.ok).toBe(false);
    expect(crashed.deletedFiles).toBe(0);

    // Either the live failure path restored the prior record, or recovery must.
    const afterCrash = await readFile(recordPath, "utf8").catch(() => "");
    if (afterCrash !== priorRecord) {
      const recovered = await finalizeCompletedProject({
        configPath: fixture.configPath,
        project,
        manifest: fixture.manifest,
        apply: true,
        expectedPlanDigest: "0".repeat(64),
        now: "2026-07-14T01:00:00.000Z"
      });
      expect(recovered.ok).toBe(false);
    }
    await expect(readFile(recordPath, "utf8")).resolves.toBe(priorRecord);
    // Quarantined candidates must be restored; filesystem and record stay consistent.
    for (const relativePath of preview.mediaFiles) {
      await expect(stat(join(fixture.root, relativePath))).resolves.toBeDefined();
    }
  });

  it("refuses rollback overwrite when the original path was recreated and keeps the journal", async () => {
    const fixture = await completionFixture();
    const originalRelative = "dist/demo-v1/assets/old.mp4";
    const originalPath = join(fixture.root, originalRelative);
    const stats = await lstat(originalPath);
    const quarantineRoot = join(
      fixture.root,
      "dist/.tsugite-finalize-quarantine/demo-v2",
      "77777777-7777-4777-8777-777777777777"
    );
    const quarantinePath = join(quarantineRoot, "0000-old.mp4");
    await mkdir(quarantineRoot, { recursive: true });
    await rename(originalPath, quarantinePath);
    // Recreate a regular file at the original path — rollback must not overwrite it.
    await writeFile(originalPath, "user recreated this media");

    const journalPath = finalizeJournalPath(join(fixture.root, "dist"), "demo-v2");
    await mkdir(join(fixture.root, "dist/.tsugite-finalize-journal"), { recursive: true });
    await writeFile(journalPath, `${JSON.stringify({
      schema_version: 1,
      run_id: "demo-v2",
      plan_digest: "f".repeat(64),
      phase: "quarantined",
      quarantine_root: quarantineRoot,
      candidates: [{
        original_path: originalPath,
        original_relative: originalRelative,
        quarantine_path: quarantinePath,
        identity: {
          path: originalRelative,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          device: stats.dev,
          inode: stats.ino
        },
        permanently_deleted: false
      }],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      previous_completion_record: null,
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z"
    }, null, 2)}\n`);

    const recovered = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: "0".repeat(64),
      now: "2026-07-14T01:00:00.000Z"
    });
    expect(recovered.ok).toBe(false);
    expect(recovered.issues.some((issue) => issue.code === "finalize.rollback_failed")).toBe(true);
    expect(recovered.unrestoredPaths).toContain(originalPath);
    await expect(readFile(originalPath, "utf8")).resolves.toBe("user recreated this media");
    await expect(stat(quarantinePath)).resolves.toBeDefined();
    await expect(readFinalizeJournal(join(fixture.root, "dist"), "demo-v2")).resolves.toBeDefined();
  });

  it("treats missing prior completion-record as successful restore delete (ENOENT)", async () => {
    const fixture = await completionFixture();
    const originalRelative = "dist/demo-v1/assets/old.mp4";
    const originalPath = join(fixture.root, originalRelative);
    const originalBytes = await readFile(originalPath);
    const stats = await lstat(originalPath);
    const quarantineRoot = join(
      fixture.root,
      "dist/.tsugite-finalize-quarantine/demo-v2",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    );
    const quarantinePath = join(quarantineRoot, "0000-old.mp4");
    await mkdir(quarantineRoot, { recursive: true });
    await rename(originalPath, quarantinePath);

    const journalPath = finalizeJournalPath(join(fixture.root, "dist"), "demo-v2");
    await mkdir(join(fixture.root, "dist/.tsugite-finalize-journal"), { recursive: true });
    await writeFile(journalPath, `${JSON.stringify({
      schema_version: 1,
      run_id: "demo-v2",
      plan_digest: "a".repeat(64),
      phase: "quarantined",
      quarantine_root: quarantineRoot,
      candidates: [{
        original_path: originalPath,
        original_relative: originalRelative,
        quarantine_path: quarantinePath,
        identity: {
          path: originalRelative,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          device: stats.dev,
          inode: stats.ino
        },
        permanently_deleted: false
      }],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      previous_completion_record: null,
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z"
    }, null, 2)}\n`);

    const recovered = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: "0".repeat(64),
      now: "2026-07-14T01:00:00.000Z"
    });
    // Recovery restores media and clears journal; plan_stale follows because digest is wrong.
    expect(recovered.ok).toBe(false);
    expect(recovered.issues[0]?.code).toBe("finalize.plan_stale");
    await expect(readFile(originalPath)).resolves.toEqual(originalBytes);
    await expect(readFinalizeJournal(join(fixture.root, "dist"), "demo-v2")).resolves.toBeUndefined();
    await expect(stat(join(fixture.root, "dist/demo-v2/completion-record.json"))).rejects.toThrow();
  });

  it("surfaces record_restore_failed on completion-record write failure and keeps the journal", async () => {
    const fixture = await completionFixture();
    const originalRelative = "dist/demo-v1/assets/old.mp4";
    const originalPath = join(fixture.root, originalRelative);
    const originalBytes = await readFile(originalPath);
    const stats = await lstat(originalPath);
    const quarantineRoot = join(
      fixture.root,
      "dist/.tsugite-finalize-quarantine/demo-v2",
      "88888888-8888-4888-8888-888888888888"
    );
    const quarantinePath = join(quarantineRoot, "0000-old.mp4");
    await mkdir(quarantineRoot, { recursive: true });
    await rename(originalPath, quarantinePath);

    // Block restore write: leaf symlink at completion-record path.
    const recordPath = join(fixture.root, "dist/demo-v2/completion-record.json");
    const external = join(fixture.root, "marketing/restore-write-target.json");
    await writeFile(external, "do-not-overwrite\n");
    await symlink(external, recordPath);

    const priorRecord = `${JSON.stringify({ schema_version: 1, note: "prior" }, null, 2)}\n`;
    const journalPath = finalizeJournalPath(join(fixture.root, "dist"), "demo-v2");
    await mkdir(join(fixture.root, "dist/.tsugite-finalize-journal"), { recursive: true });
    await writeFile(journalPath, `${JSON.stringify({
      schema_version: 1,
      run_id: "demo-v2",
      plan_digest: "a".repeat(64),
      phase: "quarantined",
      quarantine_root: quarantineRoot,
      candidates: [{
        original_path: originalPath,
        original_relative: originalRelative,
        quarantine_path: quarantinePath,
        identity: {
          path: originalRelative,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          device: stats.dev,
          inode: stats.ino
        },
        permanently_deleted: false
      }],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      previous_completion_record: priorRecord,
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z"
    }, null, 2)}\n`);

    const recovered = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: "0".repeat(64),
      now: "2026-07-14T01:00:00.000Z"
    });
    expect(recovered.ok).toBe(false);
    expect(recovered.issues.some((issue) => issue.code === "finalize.record_restore_failed")).toBe(true);
    // Media restore may succeed; record restore failure must still keep the journal.
    await expect(readFile(originalPath)).resolves.toEqual(originalBytes);
    await expect(readFile(external, "utf8")).resolves.toBe("do-not-overwrite\n");
    await expect(readFinalizeJournal(join(fixture.root, "dist"), "demo-v2")).resolves.toBeDefined();
  });

  it("surfaces record_restore_failed on completion-record delete failure and keeps the journal", async () => {
    const fixture = await completionFixture();
    const originalRelative = "dist/demo-v1/assets/old.mp4";
    const originalPath = join(fixture.root, originalRelative);
    const originalBytes = await readFile(originalPath);
    const stats = await lstat(originalPath);
    const quarantineRoot = join(
      fixture.root,
      "dist/.tsugite-finalize-quarantine/demo-v2",
      "99999999-9999-4999-8999-999999999999"
    );
    const quarantinePath = join(quarantineRoot, "0000-old.mp4");
    await mkdir(quarantineRoot, { recursive: true });
    await rename(originalPath, quarantinePath);

    // Provisional record exists; journal says prior was absent so restore deletes it.
    const runDir = join(fixture.root, "dist/demo-v2");
    const recordPath = join(runDir, "completion-record.json");
    await writeFile(recordPath, `${JSON.stringify({ provisional: true }, null, 2)}\n`);
    // Make the run directory non-writable so unlink fails (non-ENOENT).
    await chmod(runDir, 0o555);

    const journalPath = finalizeJournalPath(join(fixture.root, "dist"), "demo-v2");
    await mkdir(join(fixture.root, "dist/.tsugite-finalize-journal"), { recursive: true });
    await writeFile(journalPath, `${JSON.stringify({
      schema_version: 1,
      run_id: "demo-v2",
      plan_digest: "a".repeat(64),
      phase: "quarantined",
      quarantine_root: quarantineRoot,
      candidates: [{
        original_path: originalPath,
        original_relative: originalRelative,
        quarantine_path: quarantinePath,
        identity: {
          path: originalRelative,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          device: stats.dev,
          inode: stats.ino
        },
        permanently_deleted: false
      }],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      previous_completion_record: null,
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z"
    }, null, 2)}\n`);

    try {
      const recovered = await finalizeCompletedProject({
        configPath: fixture.configPath,
        project,
        manifest: fixture.manifest,
        apply: true,
        expectedPlanDigest: "0".repeat(64),
        now: "2026-07-14T01:00:00.000Z"
      });
      expect(recovered.ok).toBe(false);
      expect(recovered.issues.some((issue) => issue.code === "finalize.record_restore_failed")).toBe(true);
      await expect(readFinalizeJournal(join(fixture.root, "dist"), "demo-v2")).resolves.toBeDefined();
      // Media restore still succeeds independently of record delete failure.
      await expect(readFile(originalPath)).resolves.toEqual(originalBytes);
    } finally {
      await chmod(runDir, 0o755);
    }
  });

  it("excludes finalize journal and quarantine from durable launcher promotion", async () => {
    const fixture = await completionFixture({ outsideLauncherHome: true });
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);

    // Seed local-only staging dirs that must never be promoted.
    // Use non-run journal filenames so apply recovery does not treat them as an incomplete run.
    const localJournal = join(fixture.root, "dist/.tsugite-finalize-journal");
    const localQuarantine = join(fixture.root, "dist/.tsugite-finalize-quarantine");
    await mkdir(localJournal, { recursive: true });
    await mkdir(join(localQuarantine, "seed-session"), { recursive: true });
    await writeFile(join(localJournal, "marker.txt"), "journal-seed\n");
    await writeFile(join(localQuarantine, "seed-session", "marker.txt"), "quarantine-seed\n");

    const result = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z"
    });
    expect(result.ok).toBe(true);
    expect(result.promotedToLauncherHome).toBe(true);

    const durableRoot = join(fixture.projectsHome!, "demo");
    await expect(stat(join(durableRoot, "dist/demo-v2/completion-record.json"))).resolves.toBeDefined();
    await expect(stat(join(durableRoot, "dist/.tsugite-finalize-journal"))).rejects.toThrow();
    await expect(stat(join(durableRoot, "dist/.tsugite-finalize-quarantine"))).rejects.toThrow();
  });

  it("Unit 7C: empty-candidate apply surfaces promotion_commit_failed without wiping the completion-record", async () => {
    const { recoverPromotionTransactions } = await import("../src/project/projectsHome.js");
    const {
      loadPromotionJournal,
      PROMOTION_BACKUP_PREFIX
    } = await import("../src/project/promotionJournal.js");
    const { readdir } = await import("node:fs/promises");

    const fixture = await completionFixture({ outsideLauncherHome: true });
    // Pre-delete every cleanup candidate so apply takes the empty-candidate promotion path.
    for (const relative of [
      "dist/demo-v1/assets/old.mp4",
      "media/unused-draft.wav",
      "qa/v1/contact-sheet.jpg"
    ]) {
      await unlink(join(fixture.root, relative));
    }
    const existing = join(fixture.projectsHome!, "demo");
    await mkdir(join(existing, "dist", "old"), { recursive: true });
    await writeFile(join(existing, "project.yaml"), "slug: demo\n", "utf8");
    await writeFile(join(existing, "dist", "old", "final.mp4"), "prior", "utf8");

    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);
    expect(preview.mediaFiles).toEqual([]);

    const unlinkError = Object.assign(new Error("simulated empty-path commit failure"), {
      code: "EACCES"
    });
    const failed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z",
      _testHooks: {
        promotion: {
          rm: async (path, options) => {
            if (String(path).includes(PROMOTION_BACKUP_PREFIX)) throw unlinkError;
            return rm(path, options);
          }
        }
      }
    });

    expect(failed.ok).toBe(false);
    expect(failed.issues.some((issue) => issue.code === "finalize.promotion_commit_failed")).toBe(true);
    expect(failed.deletedFiles).toBe(0);
    const durableRecord = join(fixture.projectsHome!, "demo", "dist/demo-v2/completion-record.json");
    await expect(stat(durableRecord)).resolves.toBeDefined();
    const journalAfter = await loadPromotionJournal(fixture.projectsHome!, existing);
    expect(journalAfter.status).toBe("ok");
    if (journalAfter.status === "ok") {
      expect(journalAfter.journal.phase).toBe("committing");
    }

    const recovery = await recoverPromotionTransactions(fixture.projectsHome!);
    expect(recovery.ok).toBe(true);
    expect(recovery.recovered).toBe(1);
    await expect(loadPromotionJournal(fixture.projectsHome!, existing))
      .resolves.toMatchObject({ status: "missing" });
    const leftovers = (await readdir(fixture.projectsHome!))
      .filter((name) => name.startsWith(PROMOTION_BACKUP_PREFIX));
    expect(leftovers).toEqual([]);
    await expect(stat(durableRecord)).resolves.toBeDefined();
  });

  it("HIGH: fail-closes apply when stateDir is swapped to an external symlink mid-mutation", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);
    expect(preview.planDigest).toMatch(/^[a-f0-9]{64}$/);

    const external = await mkdtemp(join(tmpdir(), "tsugite-finalize-mid-swap-ext-"));
    await writeFile(join(external, "trap.txt"), "external-secret\n");
    const stateDir = join(fixture.root, "dist");
    const stateBackup = join(fixture.root, "dist.real-backup");
    let revalidateCalls = 0;

    const failed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      _testHooks: {
        beforeBoundaryRevalidate: async () => {
          revalidateCalls += 1;
          // Call 1: pre-recovery. Call 2: pre-mutation. Swap just before pre-mutation.
          if (revalidateCalls !== 2) return;
          await rename(stateDir, stateBackup);
          await symlink(external, stateDir);
        }
      }
    });

    expect(failed.ok).toBe(false);
    expect(failed.issues.some((issue) =>
      issue.code === "finalize.state_dir_changed"
      || issue.code === "finalize.state_dir_symlink"
      || issue.code === "finalize.state_dir_unsafe"
    )).toBe(true);
    // External tree must not receive journal / quarantine / completion-record writes.
    expect(await readdir(external)).toEqual(["trap.txt"]);
    await expect(readFile(join(external, "trap.txt"), "utf8")).resolves.toBe("external-secret\n");
    // Original candidates remain under the renamed real stateDir (fail closed, no delete).
    await expect(stat(join(stateBackup, "demo-v1/assets/old.mp4"))).resolves.toBeDefined();
  });

  it("HIGH: fail-closes apply when runDir is replaced by a symlink after pin", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);

    const externalRun = await mkdtemp(join(tmpdir(), "tsugite-finalize-rundir-swap-ext-"));
    await writeFile(join(externalRun, "foreign.json"), "{\"foreign\":true}\n");
    const runDir = join(fixture.root, "dist/demo-v2");
    const runBackup = join(fixture.root, "dist/demo-v2.real-backup");
    let swapped = false;

    const failed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      _testHooks: {
        beforeBoundaryRevalidate: async () => {
          if (swapped) return;
          swapped = true;
          await rename(runDir, runBackup);
          await symlink(externalRun, runDir);
        }
      }
    });

    expect(failed.ok).toBe(false);
    expect(failed.issues.some((issue) =>
      issue.code === "finalize.run_dir_changed"
      || issue.code === "finalize.run_dir_symlink"
      || issue.code === "finalize.run_dir_unsafe"
    )).toBe(true);
    expect(await readdir(externalRun)).toEqual(["foreign.json"]);
    await expect(readFile(join(externalRun, "foreign.json"), "utf8")).resolves.toBe("{\"foreign\":true}\n");
    // Real run tree (with final.mp4) was moved aside, not deleted through the symlink.
    await expect(stat(join(runBackup, "final.mp4"))).resolves.toBeDefined();
  });

  it("HIGH: normal apply still succeeds when pinned stateDir/runDir identities stay stable", async () => {
    const fixture = await completionFixture();
    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);
    const boundary = await preflightFinalizeApplyBoundary({
      configPath: fixture.configPath,
      project
    });
    expect(boundary.ok).toBe(true);
    if (!boundary.ok) return;

    const applied = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      expectedStateDirIdentity: boundary.stateDirIdentity,
      expectedRunDirIdentity: boundary.runDirIdentity
    });
    expect(applied.ok).toBe(true);
    expect(applied.deletedFiles).toBeGreaterThan(0);
    await expect(stat(join(fixture.root, "dist/demo-v2/completion-record.json"))).resolves.toBeDefined();
  });

  it("Unit 7C: surfaces promotion_commit_failed, keeps journal/record/deletes, and recovery finishes commit", async () => {
    const { recoverPromotionTransactions } = await import("../src/project/projectsHome.js");
    const {
      loadPromotionJournal,
      PROMOTION_BACKUP_PREFIX
    } = await import("../src/project/promotionJournal.js");
    const { readdir } = await import("node:fs/promises");

    const fixture = await completionFixture({ outsideLauncherHome: true });
    // Existing durable tree forces a backup so commit's rm path can fail.
    const existing = join(fixture.projectsHome!, "demo");
    await mkdir(join(existing, "dist", "old"), { recursive: true });
    await writeFile(join(existing, "project.yaml"), "slug: demo\n", "utf8");
    await writeFile(join(existing, "dist", "old", "final.mp4"), "prior-final", "utf8");

    const preview = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: false
    });
    expect(preview.ok).toBe(true);
    expect(preview.launcherAlreadyHome).toBe(false);

    const unlinkError = Object.assign(new Error("simulated promotion commit unlink failure"), {
      code: "EACCES"
    });
    const failed = await finalizeCompletedProject({
      configPath: fixture.configPath,
      project,
      manifest: fixture.manifest,
      apply: true,
      expectedPlanDigest: preview.planDigest,
      now: "2026-07-14T00:00:00.000Z",
      _testHooks: {
        promotion: {
          rm: async (path, options) => {
            if (String(path).includes(PROMOTION_BACKUP_PREFIX)) throw unlinkError;
            return rm(path, options);
          }
        }
      }
    });

    expect(failed.ok).toBe(false);
    expect(failed.issues.some((issue) => issue.code === "finalize.promotion_commit_failed")).toBe(true);
    // Permanent deletes and completion-record must not be wiped by a commit failure.
    expect(failed.deletedFiles).toBeGreaterThan(0);
    const durableRecord = join(fixture.projectsHome!, "demo", "dist/demo-v2/completion-record.json");
    const sourceRecord = join(fixture.root, "dist/demo-v2/completion-record.json");
    await expect(stat(durableRecord)).resolves.toBeDefined();
    await expect(stat(sourceRecord)).resolves.toBeDefined();
    const record = JSON.parse(await readFile(durableRecord, "utf8")) as {
      cleanup: { media_files_deleted: number; bytes_reclaimed: number };
    };
    expect(record.cleanup.media_files_deleted).toBe(failed.deletedFiles);
    expect(record.cleanup.bytes_reclaimed).toBe(failed.deletedBytes);
    for (const relativePath of preview.mediaFiles) {
      await expect(stat(join(fixture.root, relativePath))).rejects.toThrow();
    }

    // Promotion journal remains in committing so restart recovery can finish the commit.
    const journalAfter = await loadPromotionJournal(fixture.projectsHome!, existing);
    expect(journalAfter.status).toBe("ok");
    if (journalAfter.status === "ok") {
      expect(journalAfter.journal.phase).toBe("committing");
    }
    const backupsBefore = (await readdir(fixture.projectsHome!))
      .filter((name) => name.startsWith(PROMOTION_BACKUP_PREFIX));
    expect(backupsBefore.length).toBe(1);

    const recovery = await recoverPromotionTransactions(fixture.projectsHome!);
    expect(recovery.ok).toBe(true);
    expect(recovery.recovered).toBe(1);
    await expect(loadPromotionJournal(fixture.projectsHome!, existing))
      .resolves.toMatchObject({ status: "missing" });
    const backupsAfter = (await readdir(fixture.projectsHome!))
      .filter((name) => name.startsWith(PROMOTION_BACKUP_PREFIX));
    expect(backupsAfter).toEqual([]);
    // Durable promoted tree and completion-record survive recovery.
    await expect(stat(join(fixture.projectsHome!, "demo", "dist/demo-v2/final.mp4"))).resolves.toBeDefined();
    await expect(stat(durableRecord)).resolves.toBeDefined();
  });
});

async function completionFixture(options: {
  completed?: boolean;
  omitFinal?: boolean;
  outsideLauncherHome?: boolean;
} = {}) {
  const base = await mkdtemp(join(tmpdir(), "tsugite-finalize-"));
  const projectsHome = options.outsideLauncherHome
    ? join(base, "durable-projects")
    : join(base, "projects");
  const root = options.outsideLauncherHome
    ? join(base, "feature-worktree", "projects", "demo")
    : join(projectsHome, "demo");
  process.env.TSUGITE_PROJECTS_HOME = projectsHome;
  const configPath = join(root, "project.yaml");
  const runDir = join(root, "dist/demo-v2");
  const oldRunDir = join(root, "dist/demo-v1");
  await Promise.all([
    mkdir(join(runDir, "assets"), { recursive: true }),
    mkdir(join(oldRunDir, "assets"), { recursive: true }),
    mkdir(join(root, "media"), { recursive: true }),
    mkdir(join(root, "qa/v1"), { recursive: true }),
    mkdir(join(root, "marketing"), { recursive: true }),
    mkdir(projectsHome, { recursive: true })
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

  return { root, configPath, manifest, projectsHome };
}
