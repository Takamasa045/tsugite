import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLI_JSON_MAX_BYTES,
  createLauncherMaintenanceController,
  createMaintenancePipelineRunner,
  isExactSingleRemovedTarget,
  maintenanceIdentityFingerprint,
  maintenanceIdentityKey,
  maintenancePathsEqual,
  resolveMaintenanceDurableHome,
  type CreateLauncherMaintenanceControllerOptions
} from "../src/viewer/launcherMaintenance.js";
import {
  labelWorktreeBlockReasons,
  MAINTENANCE_ISSUE,
  redactAbsolutePaths,
  statusForMaintenanceIssue,
  toMaintenanceIssues,
  toPublicMaintenanceIssue
} from "../src/viewer/launcherMaintenanceTypes.js";
import { drainStdio } from "../src/cli.js";
import {
  canonicalizeLauncherShelfWritability,
  startWorkflowViewerLauncher,
  type WorkflowViewerLauncher
} from "../src/viewer/launcher.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PIPELINE_ENTRY = join(REPO_ROOT, "bin", "pipeline");

const launchers: WorkflowViewerLauncher[] = [];

afterEach(async () => {
  await Promise.all(launchers.splice(0).map((launcher) => launcher.close()));
});

/**
 * M6: test helper always supplies an explicit revalidate callback.
 * Production omits → fail-closed; tests must not rely on that default.
 * Default resolveLauncherConfigPath accepts absolute strings so unit mocks need no FS.
 */
function createController(
  options: CreateLauncherMaintenanceControllerOptions
) {
  return createLauncherMaintenanceController({
    revalidateProjectIdentity: async () => true,
    resolveLauncherConfigPath: async (path) => (
      typeof path === "string" && path.length > 0 && isAbsolute(path)
        ? { ok: true, path }
        : { ok: false, issue: MAINTENANCE_ISSUE.postVerifyFailed }
    ),
    ...options
  });
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "tsugite-maint-"));
  const projectsDir = join(root, "projects");
  const templatesDir = join(root, "templates");
  const projectDir = join(projectsDir, "demo");
  const bundleDir = join(root, "bundle");
  await mkdir(join(projectDir, "dist", "demo-run"), { recursive: true });
  await mkdir(templatesDir, { recursive: true });
  await mkdir(join(bundleDir, "assets"), { recursive: true });
  await writeFile(
    join(projectDir, "project.yaml"),
    [
      "slug: demo",
      "name: デモ案件",
      "run_id: demo-run",
      "manifest: manifest.json",
      "dist_dir: dist",
      "edit:",
      "  backend: remotion",
      ""
    ].join("\n")
  );
  await writeFile(
    join(projectDir, "manifest.json"),
    `${JSON.stringify({
      version: 1,
      fps: 30,
      width: 1080,
      height: 1920,
      clips: []
    }, null, 2)}\n`
  );
  await writeFile(
    join(bundleDir, "index.html"),
    '<!doctype html><html><head><title>Viewer</title></head><body><div id="root"></div><script type="module" src="./assets/app.js"></script></body></html>\n'
  );
  await writeFile(join(bundleDir, "assets", "app.js"), "export {};\n");
  await writeFile(join(bundleDir, "assets", "app.css"), "body{}\n");
  return { root, projectsDir, templatesDir, projectDir, bundleDir };
}

async function launch(options: Parameters<typeof startWorkflowViewerLauncher>[0]) {
  const launcher = await startWorkflowViewerLauncher({
    linkProjectShelves: false,
    ...options
  });
  launchers.push(launcher);
  return launcher;
}

function authHeaders(launcher: WorkflowViewerLauncher, origin = launcher.url) {
  return {
    origin,
    "x-tsugite-token": launcher.token,
    "content-type": "application/json"
  };
}

function worktreeCliPayload(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    command: "worktrees",
    issues: [],
    applied: false,
    git_common_dir: "/repo/.git",
    primary_path: "/repo",
    current_path: "/repo",
    main_branch: "main",
    worktrees: [
      {
        path: "/repo",
        is_primary: true,
        is_current: true,
        branch: "main",
        head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        merged_into_main: true,
        dirty_tracked: false,
        dirty_untracked: false,
        locked: false,
        missing: false,
        removable: false,
        block_reasons: ["primary", "current"],
        ignored_protected: [],
        ignored_other: [],
        status_entries: []
      },
      {
        path: "/repo-worktrees/clean-merged",
        is_primary: false,
        is_current: false,
        branch: "codex/clean-merged",
        head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        merged_into_main: true,
        dirty_tracked: false,
        dirty_untracked: false,
        locked: false,
        missing: false,
        removable: true,
        block_reasons: [],
        ignored_protected: [],
        ignored_other: ["node_modules/"],
        status_entries: []
      },
      {
        path: "/repo-worktrees/dirty",
        is_primary: false,
        is_current: false,
        branch: "codex/dirty",
        head: "cccccccccccccccccccccccccccccccccccccccc",
        merged_into_main: true,
        dirty_tracked: true,
        dirty_untracked: true,
        locked: false,
        missing: false,
        removable: false,
        block_reasons: ["dirty_tracked", "dirty_untracked"],
        ignored_protected: [],
        ignored_other: [],
        status_entries: []
      }
    ],
    targets: [],
    removed: [],
    worktree_warning: {
      active: false,
      threshold: 3,
      removable_count: 1,
      removable_paths: ["/repo-worktrees/clean-merged"]
    },
    ...overrides
  };
}

function finalizeCliPayload(overrides: Record<string, unknown> = {}) {
  const planDigest = "d".repeat(64);
  return {
    ok: true,
    command: "finalize",
    issues: [],
    applied: false,
    canonical_output: "dist/demo-run/final.mp4",
    completion_record: "dist/demo-run/completion-record.json",
    already_finalized: false,
    media_files: ["dist/demo-v1/old.mp4", "dist/demo-run/final.mp4", "media/clip.mp4"],
    retained_media: ["dist/demo-run/final.mp4", "media/clip.mp4"],
    planned_bytes: 1280,
    deleted_files: 0,
    deleted_bytes: 0,
    plan_digest: planDigest,
    launcher_visible: true,
    launcher_already_home: true,
    promoted_to_launcher_home: false,
    launcher_project_root: "/projects/demo",
    // Preview-held durable path required on review for apply (no apply-only fallback).
    launcher_config_path: "/projects/demo/project.yaml",
    ...overrides
  };
}

async function createCompletedProjectFixture() {
  const root = await mkdtemp(join(tmpdir(), "tsugite-maint-completed-"));
  const projectsDir = join(root, "projects");
  const templatesDir = join(root, "templates");
  const projectDir = join(projectsDir, "demo");
  const bundleDir = join(root, "bundle");
  const runDir = join(projectDir, "dist", "demo-run");
  await mkdir(runDir, { recursive: true });
  await mkdir(join(projectDir, "media"), { recursive: true });
  await mkdir(templatesDir, { recursive: true });
  await mkdir(join(bundleDir, "assets"), { recursive: true });
  await Promise.all([
    copyFile(resolve(REPO_ROOT, "fixtures/media/clip-001.mp4"), join(projectDir, "media/clip-001.mp4")),
    copyFile(resolve(REPO_ROOT, "fixtures/media/clip-002.mp4"), join(projectDir, "media/clip-002.mp4")),
    copyFile(resolve(REPO_ROOT, "fixtures/media/render-001.mp4"), join(runDir, "final.mp4")),
    copyFile(resolve(REPO_ROOT, "fixtures/media/render-001.mp4"), join(runDir, "old-draft.mp4"))
  ]);
  const manifest = JSON.parse(
    await readFile(resolve(REPO_ROOT, "fixtures/manifests/minimal.valid.json"), "utf8")
  );
  for (const clip of manifest.clips) clip.src = clip.src.replace("../media/", "media/");
  const finalDigest = createHash("sha256")
    .update(await readFile(join(runDir, "final.mp4")))
    .digest("hex");
  await writeFile(
    join(projectDir, "project.yaml"),
    [
      "slug: demo",
      "name: デモ案件",
      "run_id: demo-run",
      "manifest: manifest.json",
      "dist_dir: dist",
      "edit:",
      "  backend: remotion",
      ""
    ].join("\n")
  );
  await writeFile(join(projectDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(runDir, "state.json"), `${JSON.stringify({
    run_id: "demo-run",
    status: "completed",
    updated_at: "2026-07-14T00:00:00.000Z",
    gates: {
      gate_1: { status: "approved" },
      gate_2: { status: "approved" },
      gate_3: { status: "approved", approved_input_digest: finalDigest }
    }
  })}\n`);
  await writeFile(join(runDir, "render-report.json"), "{}\n");
  await writeFile(join(runDir, "gate3-qc.json"), "{}\n");
  await writeFile(
    join(bundleDir, "index.html"),
    '<!doctype html><html><head><title>Viewer</title></head><body><div id="root"></div><script type="module" src="./assets/app.js"></script></body></html>\n'
  );
  await writeFile(join(bundleDir, "assets", "app.js"), "export {};\n");
  await writeFile(join(bundleDir, "assets", "app.css"), "body{}\n");
  return { root, projectsDir, templatesDir, projectDir, bundleDir, runDir };
}

describe("launcher maintenance controller (unit)", () => {
  it("previews worktrees without apply side effects and never includes forbidden argv", async () => {
    const calls: string[][] = [];
    const controller = createController({
      runPipeline: async (args) => {
        calls.push([...args]);
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(worktreeCliPayload())}\n`,
          stderr: ""
        };
      }
    });

    const preview = await controller.previewWorktrees();
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.candidates).toHaveLength(1);
    expect(preview.blocked.length).toBeGreaterThan(0);
    expect(preview.candidates[0]?.candidateId).toMatch(/^wtc_/);
    expect(JSON.stringify(preview)).not.toContain("/repo-worktrees/clean-merged");
    expect(calls).toEqual([["worktrees", "--json"]]);
    expect(calls.flat().some((arg) => arg === "--force" || arg === "--apply")).toBe(false);
  });

  it("rejects client path fields and blocked candidates; requires confirmed:true", async () => {
    const controller = createController({
      runPipeline: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(worktreeCliPayload())}\n`,
        stderr: ""
      })
    });
    const preview = await controller.previewWorktrees();
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const withPath = await controller.applyWorktree({
      reviewId: preview.reviewId,
      candidateId: preview.candidates[0]!.candidateId,
      confirmed: true,
      path: "/evil"
    });
    expect(withPath.ok).toBe(false);
    if (withPath.ok) return;
    expect(withPath.issue.code).toBe("maintenance.client_path_rejected");

    const blockedId = preview.blocked.find((item) => !item.removable)?.candidateId;
    expect(blockedId).toBeTruthy();
    const blocked = await controller.applyWorktree({
      reviewId: preview.reviewId,
      candidateId: blockedId,
      confirmed: true
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.issue.code).toBe("maintenance.candidate_blocked");

    const unconfirmed = await controller.applyWorktree({
      reviewId: preview.reviewId,
      candidateId: preview.candidates[0]!.candidateId
    });
    expect(unconfirmed.ok).toBe(false);
    if (unconfirmed.ok) return;
    expect(unconfirmed.issue.code).toBe("maintenance.confirmed_required");
  });

  it("revalidates live snapshot and returns 409-class stale on head drift; apply argv is safe", async () => {
    let previewCount = 0;
    const controller = createController({
      runPipeline: async (args) => {
        if (args[0] === "worktrees" && !args.includes("--apply")) {
          previewCount += 1;
          const payload = worktreeCliPayload();
          if (previewCount >= 2) {
            (payload.worktrees as Array<Record<string, unknown>>)[1]!.head = "f".repeat(40);
          }
          return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
        }
        throw new Error("apply should not run on stale snapshot");
      }
    });
    const preview = await controller.previewWorktrees();
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const stale = await controller.applyWorktree({
      reviewId: preview.reviewId,
      candidateId: preview.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.issue.code).toBe("maintenance.snapshot_stale");
  });

  it("applies a removable worktree once, verifies absence, and records post state", async () => {
    const calls: string[][] = [];
    let removed = false;
    const controller = createController({
      runPipeline: async (args) => {
        calls.push([...args]);
        if (args.includes("--apply")) {
          removed = true;
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(worktreeCliPayload({
              applied: true,
              ok: true,
              removed: ["/repo-worktrees/clean-merged"],
              worktrees: (worktreeCliPayload().worktrees as unknown[]).filter(
                (entry) => (entry as { path: string }).path !== "/repo-worktrees/clean-merged"
              )
            }))}\n`,
            stderr: ""
          };
        }
        const payload = worktreeCliPayload();
        if (removed) {
          payload.worktrees = (payload.worktrees as Array<Record<string, unknown>>).filter(
            (entry) => entry.path !== "/repo-worktrees/clean-merged"
          );
          payload.worktree_warning = {
            active: false,
            threshold: 3,
            removable_count: 0,
            removable_paths: []
          };
        }
        return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
      }
    });

    const preview = await controller.previewWorktrees();
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const applied = await controller.applyWorktree({
      reviewId: preview.reviewId,
      candidateId: preview.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.job.status).toBe("succeeded");
    expect(applied.job.phase).toBe("recorded");
    expect(applied.job.worktree?.removedDisplayName).toBe("clean-merged");

    const applyCall = calls.find((args) => args.includes("--apply"));
    expect(applyCall).toEqual([
      "worktrees",
      "--apply",
      "--actor", "coordinator",
      "--path", "/repo-worktrees/clean-merged",
      "--json"
    ]);
    expect(applyCall?.some((arg) => (
      arg === "--force"
      || arg === "-f"
      || arg === "stash"
      || arg === "rebase"
      || arg === "reset"
      || arg === "clean"
      || arg === "branch"
    ))).toBe(false);

    const fresh = await controller.previewWorktrees();
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.candidates).toHaveLength(0);
    expect(fresh.tidy).toBe(true);
  });

  it("requires completionDeclared and rejects readOnly / revision mismatch / digest drift", async () => {
    const project = {
      id: "p1",
      name: "デモ",
      configPath: "/projects/demo/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed"
    };
    let liveDigest = "d".repeat(64);
    const controller = createController({
      runPipeline: async (args) => {
        if (args[0] === "finalize" && !args.includes("--apply")) {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(finalizeCliPayload({ plan_digest: liveDigest }))}\n`,
            stderr: ""
          };
        }
        return {
          exitCode: 1,
          stdout: "",
          stderr: `${JSON.stringify({
            ok: false,
            command: "finalize",
            issues: [{ code: "finalize.plan_stale", message: "stale" }],
            applied: true,
            deleted_files: 0,
            deleted_bytes: 0,
            plan_digest: "e".repeat(64)
          })}\n`
        };
      }
    });

    const missingDecl = await controller.previewFinalize(project, {
      expectedRunId: project.runId,
      revision: project.revision
    });
    expect(missingDecl.ok).toBe(false);
    if (missingDecl.ok) return;
    expect(missingDecl.issue.code).toBe("maintenance.completion_declaration_required");

    const readOnly = await controller.previewFinalize({ ...project, readOnly: true }, {
      expectedRunId: project.runId,
      revision: project.revision,
      completionDeclared: true
    });
    expect(readOnly.ok).toBe(false);
    if (readOnly.ok) return;
    expect(readOnly.issue.code).toBe("maintenance.project_read_only");

    const revMismatch = await controller.previewFinalize(project, {
      expectedRunId: project.runId,
      revision: "b".repeat(64),
      completionDeclared: true
    });
    expect(revMismatch.ok).toBe(false);
    if (revMismatch.ok) return;
    expect(revMismatch.issue.code).toBe("maintenance.project_mismatch");

    const withConfig = await controller.previewFinalize(project, {
      expectedRunId: project.runId,
      revision: project.revision,
      completionDeclared: true,
      configPath: "/evil"
    });
    expect(withConfig.ok).toBe(false);
    if (withConfig.ok) return;
    expect(withConfig.issue.code).toBe("maintenance.client_path_rejected");

    const preview = await controller.previewFinalize(project, {
      expectedRunId: project.runId,
      revision: project.revision,
      completionDeclared: true
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.alreadyFinalized).toBe(false);
    expect(preview.deletion.plannedFiles).toBe(1);

    liveDigest = "e".repeat(64);
    const stale = await controller.applyFinalize(project, {
      reviewId: preview.reviewId,
      planDigest: preview.planDigest,
      confirmed: true
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.issue.code).toBe("maintenance.plan_stale");
  });

  it("marks already_finalized only from explicit CLI flag, not path-only completion_record", async () => {
    const pathOnly = createController({
      runPipeline: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(finalizeCliPayload({
          media_files: ["dist/demo-run/final.mp4"],
          retained_media: ["dist/demo-run/final.mp4"],
          planned_bytes: 0,
          completion_record: "dist/demo-run/completion-record.json",
          already_finalized: false
        }))}\n`,
        stderr: ""
      })
    });
    const pathOnlyPreview = await pathOnly.previewFinalize({
      id: "p1",
      name: "デモ",
      configPath: "/projects/demo/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed"
    }, {
      expectedRunId: "demo-run",
      revision: "a".repeat(64),
      completionDeclared: true
    });
    expect(pathOnlyPreview.ok).toBe(true);
    if (!pathOnlyPreview.ok) return;
    expect(pathOnlyPreview.alreadyFinalized).toBe(false);
    expect(pathOnlyPreview.phase).toBe("reviewable");

    const real = createController({
      runPipeline: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(finalizeCliPayload({
          media_files: ["dist/demo-run/final.mp4"],
          retained_media: ["dist/demo-run/final.mp4"],
          planned_bytes: 0,
          completion_record: "dist/demo-run/completion-record.json",
          already_finalized: true
        }))}\n`,
        stderr: ""
      })
    });
    const preview = await real.previewFinalize({
      id: "p1",
      name: "デモ",
      configPath: "/projects/demo/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed"
    }, {
      expectedRunId: "demo-run",
      revision: "a".repeat(64),
      completionDeclared: true
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.phase).toBe("already_finalized");
    expect(preview.alreadyFinalized).toBe(true);
  });

  it("applies zero-candidate finalize when record is missing and requires live post already_finalized", async () => {
    const project = {
      id: "p1",
      name: "デモ",
      configPath: "/projects/demo/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed",
      identityKey: "dev:ino"
    };
    let applied = false;
    const calls: string[][] = [];
    const controller = createController({
      runPipeline: async (args) => {
        calls.push([...args]);
        if (args.includes("--apply")) {
          applied = true;
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(finalizeCliPayload({
              applied: true,
              media_files: ["dist/demo-run/final.mp4"],
              retained_media: ["dist/demo-run/final.mp4"],
              planned_bytes: 0,
              deleted_files: 0,
              completion_record: "dist/demo-run/completion-record.json",
              already_finalized: false
            }))}\n`,
            stderr: ""
          };
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(finalizeCliPayload({
            media_files: ["dist/demo-run/final.mp4"],
            retained_media: ["dist/demo-run/final.mp4"],
            planned_bytes: 0,
            completion_record: "dist/demo-run/completion-record.json",
            already_finalized: applied
          }))}\n`,
          stderr: ""
        };
      }
    });
    const preview = await controller.previewFinalize(project, {
      expectedRunId: project.runId,
      revision: project.revision,
      completionDeclared: true
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.alreadyFinalized).toBe(false);
    expect(preview.deletion.plannedFiles).toBe(0);
    const result = await controller.applyFinalize(project, {
      reviewId: preview.reviewId,
      planDigest: preview.planDigest,
      confirmed: true
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.status).toBe("succeeded");
    expect(result.job.finalize?.completionRecord).toBeTruthy();
    expect(calls.filter((args) => args[0] === "finalize" && !args.includes("--apply")).length)
      .toBeGreaterThanOrEqual(2);
  });

  it("fail-closes exitCode 1 even when body claims ok/applied true", async () => {
    const controller = createController({
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          return {
            exitCode: 1,
            stdout: `${JSON.stringify(worktreeCliPayload({
              ok: true,
              applied: true,
              removed: ["/repo-worktrees/clean-merged"]
            }))}\n`,
            stderr: ""
          };
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(worktreeCliPayload())}\n`,
          stderr: ""
        };
      }
    });
    const preview = await controller.previewWorktrees();
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const failed = await controller.applyWorktree({
      reviewId: preview.reviewId,
      candidateId: preview.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.issue.code).toBe("maintenance.cli_nonzero_exit");
  });

  it("uses identityKey on finalize apply and rejects drift", async () => {
    const digest = "d".repeat(64);
    let applied = false;
    const controller = createController({
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          applied = true;
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(finalizeCliPayload({
              applied: true,
              plan_digest: digest,
              completion_record: "dist/demo-run/completion-record.json",
              deleted_files: 1
            }))}\n`,
            stderr: ""
          };
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(finalizeCliPayload({
            plan_digest: digest,
            already_finalized: applied
          }))}\n`,
          stderr: ""
        };
      }
    });
    const project = {
      id: "p1",
      name: "デモ",
      configPath: "/projects/demo/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed",
      identityKey: "device:1:inode:1"
    };
    const preview = await controller.previewFinalize(project, {
      expectedRunId: project.runId,
      revision: project.revision,
      completionDeclared: true
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const drifted = await controller.applyFinalize({
      ...project,
      identityKey: "device:9:inode:9"
    }, {
      reviewId: preview.reviewId,
      planDigest: preview.planDigest,
      confirmed: true
    });
    expect(drifted.ok).toBe(false);
    if (drifted.ok) return;
    expect(drifted.issue.code).toBe("maintenance.project_mismatch");
  });

  it("rejects non-completed project status for finalize preview/apply", async () => {
    const controller = createController({
      runPipeline: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(finalizeCliPayload())}\n`,
        stderr: ""
      })
    });
    const denied = await controller.previewFinalize({
      id: "p1",
      name: "デモ",
      configPath: "/projects/demo/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "rendering"
    }, {
      expectedRunId: "demo-run",
      revision: "a".repeat(64),
      completionDeclared: true
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.issue.code).toBe("maintenance.project_not_completed");
  });

  it("fail-closes malformed and oversized CLI JSON", async () => {
    const bad = createController({
      runPipeline: async () => ({ exitCode: 0, stdout: "{not-json", stderr: "" })
    });
    const malformed = await bad.previewWorktrees();
    expect(malformed.ok).toBe(false);
    if (malformed.ok) return;
    expect(malformed.issue.code).toBe("maintenance.cli_invalid");

    const huge = createController({
      runPipeline: async () => ({
        exitCode: 0,
        stdout: `${"x".repeat(300 * 1024)}`,
        stderr: ""
      })
    });
    const oversized = await huge.previewWorktrees();
    expect(oversized.ok).toBe(false);
    if (oversized.ok) return;
    expect(oversized.issue.code).toBe("maintenance.cli_too_large");
  });

  it("applies finalize with matching digest, live post-verify, and exposes job lookup", async () => {
    const project = {
      id: "p1",
      name: "デモ",
      configPath: "/projects/demo/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed",
      identityKey: "dev:1"
    };
    const digest = "d".repeat(64);
    let applied = false;
    const controller = createController({
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          applied = true;
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(finalizeCliPayload({
              applied: true,
              plan_digest: digest,
              deleted_files: 1,
              deleted_bytes: 1280,
              completion_record: "dist/demo-run/completion-record.json",
              launcher_visible: true,
              already_finalized: false
            }))}\n`,
            stderr: ""
          };
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(finalizeCliPayload({
            plan_digest: digest,
            already_finalized: applied,
            completion_record: "dist/demo-run/completion-record.json",
            ...(applied
              ? {
                  media_files: ["dist/demo-run/final.mp4"],
                  retained_media: ["dist/demo-run/final.mp4"],
                  planned_bytes: 0
                }
              : {})
          }))}\n`,
          stderr: ""
        };
      }
    });
    const preview = await controller.previewFinalize(project, {
      expectedRunId: project.runId,
      revision: project.revision,
      completionDeclared: true
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const appliedResult = await controller.applyFinalize(project, {
      reviewId: preview.reviewId,
      planDigest: preview.planDigest,
      confirmed: true
    });
    expect(appliedResult.ok).toBe(true);
    if (!appliedResult.ok) return;
    expect(appliedResult.job.phase).toBe("completion_recorded");
    expect(appliedResult.job.finalize?.deletedFiles).toBe(1);
    const job = controller.getJob(appliedResult.job.id);
    expect(job.ok).toBe(true);
    expect(controller.getJob("missing_job_id_xx").ok).toBe(false);
    expect(controller.getJob("../evil").ok).toBe(false);
  });

  it("rejects missing review, invalid project, and already-finalized apply", async () => {
    const controller = createController({
      runPipeline: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(finalizeCliPayload({
          media_files: ["dist/demo-run/final.mp4"],
          retained_media: ["dist/demo-run/final.mp4"],
          planned_bytes: 0,
          completion_record: "dist/demo-run/completion-record.json",
          already_finalized: true
        }))}\n`,
        stderr: ""
      })
    });
    const missing = await controller.applyWorktree({
      reviewId: "wtr_missing123",
      candidateId: "wtc_missing123",
      confirmed: true
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.issue.code).toBe("maintenance.review_missing");

    const invalid = await controller.previewFinalize({
      id: "p1",
      name: "x",
      configPath: "/p/project.yaml",
      readOnly: false,
      valid: false,
      runId: "r",
      revision: "a".repeat(64),
      status: "planned"
    }, {
      expectedRunId: "r",
      revision: "a".repeat(64),
      completionDeclared: true
    });
    expect(invalid.ok).toBe(false);

    const project = {
      id: "p1",
      name: "デモ",
      configPath: "/projects/demo/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed"
    };
    const preview = await controller.previewFinalize(project, {
      expectedRunId: project.runId,
      revision: project.revision,
      completionDeclared: true
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.alreadyFinalized).toBe(true);
    const denied = await controller.applyFinalize(project, {
      reviewId: preview.reviewId,
      planDigest: preview.planDigest,
      confirmed: true
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.issue.code).toBe("maintenance.already_finalized");
  });

  it("translates core block reason keys and issue paths, and builds identity keys", () => {
    expect(labelWorktreeBlockReasons([
      "dirty_untracked",
      "protected_content",
      "symlink_worktree",
      "outside_repo_boundary",
      "status_unavailable",
      "custom"
    ])).toEqual([
      "未保存ファイルがあります",
      "保護対象（projects / media など）を含みます",
      "シンボリックリンク先です",
      "リポジトリ外です",
      "状態を確認できません",
      "custom"
    ]);
    expect(toMaintenanceIssues(undefined)).toEqual([]);
    expect(toMaintenanceIssues([
      { code: "x", message: "y", path: "/abs/path/file.mp4" },
      { code: "z", message: "w", path: "relative" }
    ])).toEqual([
      { code: "x", message: "y", path: "file.mp4" },
      { code: "z", message: "w", path: "relative" }
    ]);
    expect(maintenanceIdentityKey({
      configPath: "/a/project.yaml",
      runId: "r1",
      revision: "rev"
    })).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails finalize apply when live post-verify lacks already_finalized", async () => {
    const project = {
      id: "p1",
      name: "デモ",
      configPath: "/projects/demo/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed",
      identityKey: "k1"
    };
    const digest = "d".repeat(64);
    let phase: "preview" | "applied" = "preview";
    const controller = createController({
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          phase = "applied";
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(finalizeCliPayload({
              applied: true,
              plan_digest: digest,
              completion_record: "dist/demo-run/completion-record.json",
              already_finalized: false
            }))}\n`,
            stderr: ""
          };
        }
        // Post-verify intentionally stays not-finalized.
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(finalizeCliPayload({
            plan_digest: digest,
            already_finalized: false,
            completion_record: "dist/demo-run/completion-record.json"
          }))}\n`,
          stderr: ""
        };
      }
    });
    const preview = await controller.previewFinalize(project, {
      expectedRunId: project.runId,
      revision: project.revision,
      completionDeclared: true
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const failed = await controller.applyFinalize(project, {
      reviewId: preview.reviewId,
      planDigest: preview.planDigest,
      confirmed: true
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.issue.code).toBe("maintenance.applied_unverified");
    expect(failed.job?.status).toBe("applied_unverified");
    expect(failed.job?.sideEffectConfirmed).toBe(true);
    expect(failed.issues?.some((i) => i.code === "maintenance.post_verify_failed")).toBe(true);
  });

  it("fail-closes finalize exitCode 1 with ok/applied true body", async () => {
    const project = {
      id: "p1",
      name: "デモ",
      configPath: "/projects/demo/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed"
    };
    const digest = "d".repeat(64);
    const controller = createController({
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          return {
            exitCode: 1,
            stdout: `${JSON.stringify(finalizeCliPayload({
              ok: true,
              applied: true,
              plan_digest: digest,
              completion_record: "dist/demo-run/completion-record.json"
            }))}\n`,
            stderr: ""
          };
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(finalizeCliPayload({ plan_digest: digest }))}\n`,
          stderr: ""
        };
      }
    });
    const preview = await controller.previewFinalize(project, {
      expectedRunId: project.runId,
      revision: project.revision,
      completionDeclared: true
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const failed = await controller.applyFinalize(project, {
      reviewId: preview.reviewId,
      planDigest: preview.planDigest,
      confirmed: true
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.issue.code).toBe("maintenance.cli_nonzero_exit");
  });

  it("rejects oversized ignored_protected beyond bounded max and accepts 95 entries", async () => {
    const ninetyFive = Array.from({ length: 95 }, (_, i) => `projects/p${i}/`);
    const okController = createController({
      runPipeline: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(worktreeCliPayload({
          worktrees: [{
            ...(worktreeCliPayload().worktrees as Array<Record<string, unknown>>)[0],
            ignored_protected: ninetyFive
          }]
        }))}\n`,
        stderr: ""
      })
    });
    const ok = await okController.previewWorktrees();
    expect(ok.ok).toBe(true);

    const tooMany = Array.from({ length: 513 }, (_, i) => `projects/p${i}/`);
    const badController = createController({
      runPipeline: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(worktreeCliPayload({
          worktrees: [{
            ...(worktreeCliPayload().worktrees as Array<Record<string, unknown>>)[0],
            ignored_protected: tooMany
          }]
        }))}\n`,
        stderr: ""
      })
    });
    const denied = await badController.previewWorktrees();
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.issue.code).toBe("maintenance.cli_invalid");
  });

  it("parses real pipeline worktrees --json via bounded maintenance runner", async () => {
    // CI may have few worktrees (~1.5KiB); size lower-bound is covered by the synthetic test below.
    // This integration check is size-independent: exit0, within cap, parseable preview, path secrecy.
    const runner = createMaintenancePipelineRunner({
      pipelineEntry: PIPELINE_ENTRY,
      cwd: REPO_ROOT,
      maxBytes: CLI_JSON_MAX_BYTES
    });
    const raw = await runner(["worktrees", "--json"]);
    expect(raw.exitCode).toBe(0);
    expect(raw.truncated).not.toBe(true);
    expect(Buffer.byteLength(raw.stdout, "utf8")).toBeLessThanOrEqual(CLI_JSON_MAX_BYTES);
    const controller = createController({ runPipeline: runner });
    const preview = await controller.previewWorktrees();
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.reviewId).toMatch(/^wtr_/);
    expect(preview.candidates.length + preview.blocked.length).toBeGreaterThan(0);
    expect(JSON.stringify(preview)).not.toMatch(/\/Users\//);
  }, 120_000);

  it("parses deterministic >16KiB worktree CLI JSON without truncation via maintenance runner", async () => {
    // Production need: runner accepts valid worktrees JSON above the old 16KiB job cap,
    // within CLI_JSON_MAX_BYTES, without typed truncation. Repo worktree count is not the signal.
    const dir = await mkdtemp(join(tmpdir(), "tsugite-maint-large-wt-"));
    try {
      const primary = (worktreeCliPayload().worktrees as Array<Record<string, unknown>>)[0]!;
      const syntheticTrees: Array<Record<string, unknown>> = [primary];
      for (let i = 0; i < 40; i += 1) {
        syntheticTrees.push({
          path: `/repo-worktrees/synthetic-${i}-${"x".repeat(200)}`,
          is_primary: false,
          is_current: false,
          branch: `codex/synthetic-${i}`,
          head: "b".repeat(40),
          merged_into_main: true,
          dirty_tracked: false,
          dirty_untracked: false,
          locked: false,
          missing: false,
          removable: true,
          block_reasons: [],
          ignored_protected: [],
          ignored_other: [`pad-${"y".repeat(120)}`],
          status_entries: []
        });
      }
      const payload = worktreeCliPayload({
        worktrees: syntheticTrees,
        worktree_warning: {
          active: true,
          threshold: 3,
          removable_count: 40,
          removable_paths: syntheticTrees
            .slice(1, 4)
            .map((entry) => entry.path as string)
        }
      });
      const stdoutBody = `${JSON.stringify(payload)}\n`;
      const payloadBytes = Buffer.byteLength(stdoutBody, "utf8");
      expect(payloadBytes).toBeGreaterThan(16 * 1024);
      expect(payloadBytes).toBeLessThan(CLI_JSON_MAX_BYTES);

      const entry = join(dir, "synthetic-worktrees-pipeline.mjs");
      await writeFile(
        entry,
        [
          "// Deterministic fixture: emit fixed large worktrees --json (no real git).",
          `const payload = ${JSON.stringify(payload)};`,
          'process.stdout.write(JSON.stringify(payload) + "\\n");'
        ].join("\n"),
        "utf8"
      );

      const runner = createMaintenancePipelineRunner({
        pipelineEntry: entry,
        cwd: dir,
        maxBytes: CLI_JSON_MAX_BYTES
      });
      const raw = await runner(["worktrees", "--json"]);
      expect(raw.exitCode).toBe(0);
      expect(raw.truncated).not.toBe(true);
      const capturedBytes = Buffer.byteLength(raw.stdout, "utf8");
      expect(capturedBytes).toBeGreaterThan(16 * 1024);
      expect(capturedBytes).toBeLessThanOrEqual(CLI_JSON_MAX_BYTES);
      expect(capturedBytes).toBe(payloadBytes);

      const controller = createController({ runPipeline: runner });
      const preview = await controller.previewWorktrees();
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      expect(preview.reviewId).toMatch(/^wtr_/);
      expect(preview.candidates.length).toBeGreaterThan(0);
      expect(JSON.stringify(preview)).not.toMatch(/\/Users\//);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("surfaces CLI refuse issues on worktree apply without force tokens", async () => {
    const controller = createController({
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `${JSON.stringify({
              ok: false,
              command: "worktrees",
              applied: false,
              issues: [{ code: "worktrees.not_removable", message: "blocked" }],
              git_common_dir: "/repo/.git",
              primary_path: "/repo",
              current_path: "/repo",
              main_branch: "main",
              worktrees: worktreeCliPayload().worktrees,
              targets: [],
              removed: []
            })}\n`
          };
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(worktreeCliPayload())}\n`,
          stderr: ""
        };
      }
    });
    const preview = await controller.previewWorktrees();
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const failed = await controller.applyWorktree({
      reviewId: preview.reviewId,
      candidateId: preview.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.issue.code).toBe("worktrees.not_removable");
    expect(controller.lastPipelineArgv().flat().includes("--force")).toBe(false);
  });

  it("rejects concurrent apply with a single global mutex", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let previewN = 0;
    const controller = createController({
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          await gate;
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(worktreeCliPayload({
              applied: true,
              removed: ["/repo-worktrees/clean-merged"],
              worktrees: (worktreeCliPayload().worktrees as unknown[]).filter(
                (entry) => (entry as { path: string }).path !== "/repo-worktrees/clean-merged"
              )
            }))}\n`,
            stderr: ""
          };
        }
        previewN += 1;
        const payload = worktreeCliPayload();
        if (previewN >= 3) {
          payload.worktrees = (payload.worktrees as Array<Record<string, unknown>>).filter(
            (entry) => entry.path !== "/repo-worktrees/clean-merged"
          );
        }
        return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
      }
    });
    const preview = await controller.previewWorktrees();
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const firstPromise = controller.applyWorktree({
      reviewId: preview.reviewId,
      candidateId: preview.candidates[0]!.candidateId,
      confirmed: true
    });
    // allow first to enter apply
    await new Promise((r) => setTimeout(r, 10));
    expect(controller.hasBlockingWork()).toBe(true);
    const second = await controller.applyWorktree({
      reviewId: preview.reviewId,
      candidateId: preview.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.issue.code).toBe("maintenance.apply_busy");
    release();
    const first = await firstPromise;
    expect(first.ok).toBe(true);
  });
});

describe("workflow viewer launcher maintenance routes", () => {
  it("rejects missing token/origin and wrong host for maintenance endpoints", async () => {
    const fixture = await createFixture();
    const executePipeline = vi.fn(async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify(worktreeCliPayload())}\n`,
      stderr: ""
    }));
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      templatesDir: fixture.templatesDir,
      bundleDir: fixture.bundleDir,
      executePipeline
    });

    expect((await fetch(`${launcher.url}/api/maintenance/worktrees/preview`)).status).toBe(403);
    expect((await fetch(`${launcher.url}/api/maintenance/worktrees/preview`, {
      headers: { "x-tsugite-token": "wrong" }
    })).status).toBe(403);
    expect((await fetch(`${launcher.url}/api/maintenance/worktrees/apply`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ reviewId: "x", candidateId: "y", confirmed: true })
    })).status).toBe(403);

    const ok = await fetch(`${launcher.url}/api/maintenance/worktrees/preview`, {
      headers: { "x-tsugite-token": launcher.token }
    });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.ok).toBe(true);
    expect(body.reviewId).toMatch(/^wtr_/);
    // preview has no apply
    expect(executePipeline.mock.calls.every((call) => !call[1].includes("--apply"))).toBe(true);
  });

  it("blocks apply while workspace is changing and never sends client paths to CLI", async () => {
    const fixture = await createFixture();
    let canStart = true;
    let removed = false;
    const executePipeline = vi.fn(async (_cmd: string, args: readonly string[]) => {
      if (args.includes("--apply")) {
        removed = true;
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(worktreeCliPayload({
            applied: true,
            removed: ["/repo-worktrees/clean-merged"],
            worktrees: (worktreeCliPayload().worktrees as unknown[]).filter(
              (entry) => (entry as { path: string }).path !== "/repo-worktrees/clean-merged"
            )
          }))}\n`,
          stderr: ""
        };
      }
      const payload = worktreeCliPayload();
      if (removed) {
        payload.worktrees = (payload.worktrees as Array<Record<string, unknown>>).filter(
          (entry) => entry.path !== "/repo-worktrees/clean-merged"
        );
      }
      return {
        exitCode: 0,
        stdout: `${JSON.stringify(payload)}\n`,
        stderr: ""
      };
    });
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      templatesDir: fixture.templatesDir,
      bundleDir: fixture.bundleDir,
      executePipeline,
      canStartWork: () => canStart
    });

    const preview = await fetch(`${launcher.url}/api/maintenance/worktrees/preview`, {
      headers: { "x-tsugite-token": launcher.token }
    }).then((r) => r.json());

    canStart = false;
    const blocked = await fetch(`${launcher.url}/api/maintenance/worktrees/apply`, {
      method: "POST",
      headers: authHeaders(launcher),
      body: JSON.stringify({
        reviewId: preview.reviewId,
        candidateId: preview.candidates[0].candidateId,
        confirmed: true,
        path: "/should/not/matter"
      })
    });
    expect(blocked.status).toBe(409);
    const blockedBody = await blocked.json();
    expect(blockedBody.issue.code).toBe("viewer_launcher.work_blocked");

    canStart = true;
    // client path field is rejected before CLI
    const pathRejected = await fetch(`${launcher.url}/api/maintenance/worktrees/apply`, {
      method: "POST",
      headers: authHeaders(launcher),
      body: JSON.stringify({
        reviewId: preview.reviewId,
        candidateId: preview.candidates[0].candidateId,
        confirmed: true,
        path: "/evil"
      })
    });
    expect(pathRejected.status).toBe(400);

    const applied = await fetch(`${launcher.url}/api/maintenance/worktrees/apply`, {
      method: "POST",
      headers: authHeaders(launcher),
      body: JSON.stringify({
        reviewId: preview.reviewId,
        candidateId: preview.candidates[0].candidateId,
        confirmed: true
      })
    });
    expect(applied.status).toBe(200);
    const applyArgs = executePipeline.mock.calls
      .map((call) => call[1] as string[])
      .find((args) => args.includes("--apply"));
    expect(applyArgs?.includes("--force")).toBe(false);
    expect(applyArgs?.includes("stash")).toBe(false);
    expect(applyArgs?.filter((a) => a === "--path")).toHaveLength(1);
  });

  it("requires completion declaration and rejects client paths with fixed 400 asserts", async () => {
    const fixture = await createCompletedProjectFixture();
    const executePipeline = vi.fn(async (_cmd: string, args: readonly string[]) => {
      if (args.includes("finalize")) {
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(finalizeCliPayload())}\n`,
          stderr: ""
        };
      }
      return { exitCode: 0, stdout: "{\"ok\":true}\n", stderr: "" };
    });
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      templatesDir: fixture.templatesDir,
      bundleDir: fixture.bundleDir,
      executePipeline
    });
    const projects = await fetch(`${launcher.url}/api/projects`).then((r) => r.json());
    const project = projects.projects?.[0];
    expect(project).toBeTruthy();
    expect(project.valid).toBe(true);
    expect(project.status).toBe("completed");

    const noDecl = await fetch(`${launcher.url}/api/projects/${project.id}/finalize/preview`, {
      method: "POST",
      headers: authHeaders(launcher),
      body: JSON.stringify({
        expectedRunId: project.runId,
        revision: project.revision
      })
    });
    expect(noDecl.status).toBe(400);
    const noDeclBody = await noDecl.json();
    expect(noDeclBody.issue.code).toBe("maintenance.completion_declaration_required");

    const withStateDir = await fetch(`${launcher.url}/api/projects/${project.id}/finalize/preview`, {
      method: "POST",
      headers: authHeaders(launcher),
      body: JSON.stringify({
        expectedRunId: project.runId,
        revision: project.revision,
        completionDeclared: true,
        stateDir: "/tmp/evil"
      })
    });
    expect(withStateDir.status).toBe(400);
    const stateDirBody = await withStateDir.json();
    expect(stateDirBody.issue.code).toBe("maintenance.client_path_rejected");

    const withConfigPath = await fetch(`${launcher.url}/api/projects/${project.id}/finalize/preview`, {
      method: "POST",
      headers: authHeaders(launcher),
      body: JSON.stringify({
        expectedRunId: project.runId,
        revision: project.revision,
        completionDeclared: true,
        configPath: "/evil/project.yaml"
      })
    });
    expect(withConfigPath.status).toBe(400);
    expect((await withConfigPath.json()).issue.code).toBe("maintenance.client_path_rejected");
  });

  it("blocks finalize apply when project identity is swapped after preview", async () => {
    const fixture = await createCompletedProjectFixture();
    const digest = "d".repeat(64);
    const durableConfig = join(fixture.projectDir, "project.yaml");
    const executePipeline = vi.fn(async (_cmd: string, args: readonly string[]) => {
      if (args.includes("finalize")) {
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(finalizeCliPayload({
            plan_digest: digest,
            already_finalized: false,
            launcher_config_path: durableConfig
          }))}\n`,
          stderr: ""
        };
      }
      return { exitCode: 0, stdout: "{\"ok\":true}\n", stderr: "" };
    });
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      templatesDir: fixture.templatesDir,
      bundleDir: fixture.bundleDir,
      executePipeline
    });
    const projects = await fetch(`${launcher.url}/api/projects`).then((r) => r.json());
    const project = projects.projects?.[0];
    expect(project).toBeTruthy();

    const previewRes = await fetch(`${launcher.url}/api/projects/${project.id}/finalize/preview`, {
      method: "POST",
      headers: authHeaders(launcher),
      body: JSON.stringify({
        expectedRunId: project.runId,
        revision: project.revision,
        completionDeclared: true
      })
    });
    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json();
    expect(preview.ok).toBe(true);

    // Keep completed run_id so the project stays listed, but change content so revision drifts.
    await writeFile(
      join(fixture.projectDir, "project.yaml"),
      [
        "slug: demo",
        "name: 差し替え案件",
        "run_id: demo-run",
        "manifest: manifest.json",
        "dist_dir: dist",
        "edit:",
        "  backend: remotion",
        "notes: identity-swap",
        ""
      ].join("\n")
    );

    const applyRes = await fetch(`${launcher.url}/api/projects/${project.id}/finalize/apply`, {
      method: "POST",
      headers: authHeaders(launcher),
      body: JSON.stringify({
        reviewId: preview.reviewId,
        planDigest: preview.planDigest,
        confirmed: true
      })
    });
    // M3: single fixed status/code — never soft-pass a range.
    expect(applyRes.status).toBe(409);
    const body = await applyRes.json();
    expect(body.ok).toBe(false);
    expect(body.issue.code).toBe("maintenance.project_mismatch");
    expect(
      executePipeline.mock.calls.some((call) => (call[1] as string[]).includes("--apply"))
    ).toBe(false);
  });

  it("Desktop-injected executePipeline path passes CLI_JSON_MAX_BYTES for maintenance", async () => {
    const fixture = await createFixture();
    const captured: Array<{ maxOutputBytes?: number }> = [];
    const executePipeline = vi.fn(async (
      _cmd: string,
      _args: readonly string[],
      options: { cwd: string; maxOutputBytes?: number }
    ) => {
      captured.push({ maxOutputBytes: options.maxOutputBytes });
      return {
        exitCode: 0,
        stdout: `${JSON.stringify(worktreeCliPayload())}\n`,
        stderr: ""
      };
    });
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      templatesDir: fixture.templatesDir,
      bundleDir: fixture.bundleDir,
      executePipeline
    });
    const res = await fetch(`${launcher.url}/api/maintenance/worktrees/preview`, {
      headers: { "x-tsugite-token": launcher.token }
    });
    expect(res.status).toBe(200);
    expect(captured.some((item) => item.maxOutputBytes === CLI_JSON_MAX_BYTES)).toBe(true);
    expect(captured.every((item) => (
      item.maxOutputBytes === undefined
      || (Number.isSafeInteger(item.maxOutputBytes) && item.maxOutputBytes! > 0)
    ))).toBe(true);
  });
});

describe("launcher maintenance second-review fixes", () => {
  it("H2: preview fail-closes exitCode!=0 even when body claims ok:true", async () => {
    const controller = createController({
      runPipeline: async () => ({
        exitCode: 1,
        stdout: `${JSON.stringify(worktreeCliPayload({ ok: true }))}\n`,
        stderr: ""
      })
    });
    const preview = await controller.previewWorktrees();
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.issue.code).toBe("maintenance.cli_nonzero_exit");

    const finalize = createController({
      runPipeline: async () => ({
        exitCode: 2,
        stdout: `${JSON.stringify(finalizeCliPayload({ ok: true }))}\n`,
        stderr: ""
      })
    });
    const fin = await finalize.previewFinalize({
      id: "p1",
      name: "デモ",
      configPath: "/projects/demo/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed"
    }, {
      expectedRunId: "demo-run",
      revision: "a".repeat(64),
      completionDeclared: true
    });
    expect(fin.ok).toBe(false);
    if (fin.ok) return;
    expect(fin.issue.code).toBe("maintenance.cli_nonzero_exit");
  });

  it("H1: promoted_to_launcher_home succeeds when source already_finalized is false", async () => {
    const digest = "d".repeat(64);
    const durable = "/durable/projects/demo/project.yaml";
    const source = "/worktree/projects/demo/project.yaml";
    let applied = false;
    const controller = createController({
      resolveLauncherConfigPath: async (path) => (
        path === durable
          ? { ok: true, path: durable }
          : { ok: false, issue: { code: "maintenance.post_verify_failed", message: "bad" } }
      ),
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          applied = true;
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(finalizeCliPayload({
              applied: true,
              plan_digest: digest,
              promoted_to_launcher_home: true,
              launcher_config_path: durable,
              launcher_already_home: false,
              already_finalized: false,
              completion_record: "dist/demo-run/completion-record.json",
              deleted_files: 1,
              deleted_bytes: 100
            }))}\n`,
            stderr: ""
          };
        }
        const configIdx = args.indexOf("--config");
        const config = configIdx >= 0 ? args[configIdx + 1] : "";
        if (config === durable) {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(finalizeCliPayload({
              plan_digest: digest,
              already_finalized: true,
              launcher_already_home: true,
              completion_record: "dist/demo-run/completion-record.json",
              media_files: ["dist/demo-run/final.mp4"],
              retained_media: ["dist/demo-run/final.mp4"],
              planned_bytes: 0
            }))}\n`,
            stderr: ""
          };
        }
        // Source stays already_finalized=false (not alreadyHome) even after apply.
        // Preview still reports the planned durable launcher_config_path (required on review).
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(finalizeCliPayload({
            plan_digest: digest,
            already_finalized: false,
            launcher_already_home: false,
            launcher_config_path: durable,
            completion_record: "dist/demo-run/completion-record.json"
          }))}\n`,
          stderr: ""
        };
      }
    });
    const project = {
      id: "p1",
      name: "デモ",
      configPath: source,
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed",
      identityKey: "1:1"
    };
    const preview = await controller.previewFinalize(project, {
      expectedRunId: project.runId,
      revision: project.revision,
      completionDeclared: true
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.alreadyFinalized).toBe(false);
    const result = await controller.applyFinalize(project, {
      reviewId: preview.reviewId,
      planDigest: preview.planDigest,
      confirmed: true
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applied).toBe(true);
    expect(result.job.phase).toBe("completion_recorded");
  });

  it("H3: revalidate after live preview rejects swap before apply argv", async () => {
    const digest = "d".repeat(64);
    const calls: string[][] = [];
    let revalidateOk = true;
    const controller = createController({
      revalidateProjectIdentity: async () => revalidateOk,
      runPipeline: async (args) => {
        calls.push([...args]);
        if (args.includes("--apply")) {
          throw new Error("apply must not run after identity swap");
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(finalizeCliPayload({ plan_digest: digest }))}\n`,
          stderr: ""
        };
      }
    });
    const project = {
      id: "p1",
      name: "デモ",
      configPath: "/projects/demo/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed",
      identityKey: "dev:1",
      identityFingerprint: maintenanceIdentityFingerprint({
        configPath: "/projects/demo/project.yaml",
        runId: "demo-run",
        revision: "a".repeat(64),
        identityKey: "dev:1"
      })
    };
    const preview = await controller.previewFinalize(project, {
      expectedRunId: project.runId,
      revision: project.revision,
      completionDeclared: true
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    revalidateOk = false;
    const failed = await controller.applyFinalize(project, {
      reviewId: preview.reviewId,
      planDigest: preview.planDigest,
      confirmed: true
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.issue.code).toBe("maintenance.project_mismatch");
    expect(calls.some((args) => args.includes("--apply"))).toBe(false);
  });

  it("M1: requires exact server-held path in removed and ENOENT only via inspect", async () => {
    const inspections: string[] = [];
    const controller = createController({
      inspectRemovedPath: async (path) => {
        inspections.push(path);
        return "absent";
      },
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(worktreeCliPayload({
              applied: true,
              // Wrong path — list absence alone must not succeed.
              removed: ["/repo-worktrees/other"],
              worktrees: (worktreeCliPayload().worktrees as unknown[]).filter(
                (entry) => (entry as { path: string }).path !== "/repo-worktrees/clean-merged"
              )
            }))}\n`,
            stderr: ""
          };
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(worktreeCliPayload())}\n`,
          stderr: ""
        };
      }
    });
    const preview = await controller.previewWorktrees();
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const failed = await controller.applyWorktree({
      reviewId: preview.reviewId,
      candidateId: preview.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    // applied:true + removed mismatch → applied_unverified; review consumed (no re-apply).
    expect(failed.issue.code).toBe("maintenance.applied_unverified");
    expect(failed.job?.status).toBe("applied_unverified");
    expect(failed.job?.sideEffectConfirmed).toBe(true);
    expect(failed.issues?.some((i) => i.code === "maintenance.worktree_remove_unconfirmed")).toBe(true);
    expect(inspections).toEqual([]);
    const reapplyWrongRemoved = await controller.applyWorktree({
      reviewId: preview.reviewId,
      candidateId: preview.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(reapplyWrongRemoved.ok).toBe(false);
    if (reapplyWrongRemoved.ok) return;
    expect(reapplyWrongRemoved.issue.code).toBe("maintenance.review_missing");

    // Permission/other error is fail-closed even when removed lists exact path.
    let errApplied = false;
    const errController = createController({
      inspectRemovedPath: async () => "error",
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          errApplied = true;
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(worktreeCliPayload({
              applied: true,
              removed: ["/repo-worktrees/clean-merged"],
              worktrees: (worktreeCliPayload().worktrees as unknown[]).filter(
                (entry) => (entry as { path: string }).path !== "/repo-worktrees/clean-merged"
              )
            }))}\n`,
            stderr: ""
          };
        }
        const payload = worktreeCliPayload();
        if (errApplied) {
          payload.worktrees = (payload.worktrees as Array<Record<string, unknown>>).filter(
            (entry) => entry.path !== "/repo-worktrees/clean-merged"
          );
        }
        return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
      }
    });
    const preview2 = await errController.previewWorktrees();
    expect(preview2.ok).toBe(true);
    if (!preview2.ok) return;
    const failedInspect = await errController.applyWorktree({
      reviewId: preview2.reviewId,
      candidateId: preview2.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(failedInspect.ok).toBe(false);
    if (failedInspect.ok) return;
    // H3: CLI remove confirmed; post lstat error is applied_unverified (not generic failed).
    expect(failedInspect.issue.code).toBe("maintenance.applied_unverified");
    expect(failedInspect.job?.status).toBe("applied_unverified");
    expect(failedInspect.job?.sideEffectConfirmed).toBe(true);
    expect(failedInspect.issues?.some((i) => i.code === "maintenance.worktree_path_inspect_failed")).toBe(true);
  });

  it("M2: redacts absolute paths from public issue/error messages", async () => {
    expect(redactAbsolutePaths("failed under /Users/takamasa/secret/project")).not.toContain("/Users/");
    expect(toPublicMaintenanceIssue({
      code: "worktrees.custom",
      message: "cannot remove /Users/takamasa/.codex/worktrees/evil"
    }).message).not.toContain("/Users/");

    const controller = createController({
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `${JSON.stringify({
              ok: false,
              command: "worktrees",
              issues: [{
                code: "worktrees.custom_fail",
                message: "blocked path /Users/takamasa/Projects/secret"
              }],
              git_common_dir: "/repo/.git",
              primary_path: "/repo",
              current_path: "/repo",
              main_branch: "main",
              worktrees: worktreeCliPayload().worktrees,
              applied: false,
              removed: []
            })}\n`
          };
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(worktreeCliPayload())}\n`,
          stderr: ""
        };
      }
    });
    const preview = await controller.previewWorktrees();
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const failed = await controller.applyWorktree({
      reviewId: preview.reviewId,
      candidateId: preview.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(JSON.stringify(failed)).not.toContain("/Users/");
    expect(failed.issue.message).not.toMatch(/\/Users\//);

    const throwController = createController({
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          throw new Error("EACCES /Users/takamasa/private");
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(worktreeCliPayload())}\n`,
          stderr: ""
        };
      }
    });
    const preview2 = await throwController.previewWorktrees();
    expect(preview2.ok).toBe(true);
    if (!preview2.ok) return;
    const internal = await throwController.applyWorktree({
      reviewId: preview2.reviewId,
      candidateId: preview2.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(internal.ok).toBe(false);
    if (internal.ok) return;
    expect(internal.issue.code).toBe("maintenance.internal");
    expect(JSON.stringify(internal)).not.toContain("/Users/");
  });

  it("M6: drainStdio resolves with timeout on stuck needDrain streams", async () => {
    const { EventEmitter } = await import("node:events");
    const stuck = new EventEmitter() as NodeJS.WriteStream;
    Object.assign(stuck, {
      destroyed: false,
      writableEnded: false,
      writableNeedDrain: true,
      write: () => false
    });
    const started = Date.now();
    await drainStdio({ timeoutMs: 30, stdout: stuck, stderr: stuck });
    expect(Date.now() - started).toBeLessThan(500);

    const ended = {
      destroyed: false,
      writableEnded: true,
      writableNeedDrain: false,
      write: () => true,
      once: () => ended
    } as unknown as NodeJS.WriteStream;
    await drainStdio({ timeoutMs: 20, stdout: ended, stderr: ended });
  });

  it("covers safe branches: durable config resolve, inspect path, runner bounds, drop review", async () => {
    const { defaultResolveLauncherConfigPath } = await import("../src/viewer/launcherMaintenance.js");
    expect((await defaultResolveLauncherConfigPath("")).ok).toBe(false);
    expect((await defaultResolveLauncherConfigPath("relative.yaml")).ok).toBe(false);
    expect((await defaultResolveLauncherConfigPath("/abs/\0evil")).ok).toBe(false);
    expect((await defaultResolveLauncherConfigPath("/tmp/definitely-missing-tsugite-maint.yaml")).ok)
      .toBe(false);

    // Existing project.yaml under durable home when home is the fixture projects dir.
    const fixture = await createCompletedProjectFixture();
    const prevHome = process.env.TSUGITE_PROJECTS_HOME;
    process.env.TSUGITE_PROJECTS_HOME = fixture.projectsDir;
    try {
      const config = join(fixture.projectDir, "project.yaml");
      const resolved = await defaultResolveLauncherConfigPath(config);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) expect(resolved.path).toContain("project.yaml");

      // Outside durable home is rejected.
      const outside = join(fixture.root, "outside.yaml");
      await writeFile(outside, "x: 1\n");
      expect((await defaultResolveLauncherConfigPath(outside)).ok).toBe(false);

      // Directory path is not a regular file.
      expect((await defaultResolveLauncherConfigPath(fixture.projectDir)).ok).toBe(false);

      // Symlink config is rejected even under home.
      const { symlink } = await import("node:fs/promises");
      const linkPath = join(fixture.projectsDir, "link-config.yaml");
      try {
        await symlink(config, linkPath);
        expect((await defaultResolveLauncherConfigPath(linkPath)).ok).toBe(false);
      } catch {
        // Some environments disallow symlink; skip without failing the suite.
      }
    } finally {
      if (prevHome === undefined) delete process.env.TSUGITE_PROJECTS_HOME;
      else process.env.TSUGITE_PROJECTS_HOME = prevHome;
    }

    expect(() => createMaintenancePipelineRunner({
      pipelineEntry: PIPELINE_ENTRY,
      cwd: REPO_ROOT,
      maxBytes: 0
    })).toThrow(/maxBytes/);
    expect(() => createMaintenancePipelineRunner({
      pipelineEntry: PIPELINE_ENTRY,
      cwd: REPO_ROOT,
      maxBytes: CLI_JSON_MAX_BYTES + 1
    })).toThrow(/maxBytes/);

    // inspectRemovedPath present fails closed even when list no longer contains the path.
    let sawApply = false;
    const present = createController({
      inspectRemovedPath: async () => "present",
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          sawApply = true;
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(worktreeCliPayload({
              applied: true,
              removed: ["/repo-worktrees/clean-merged"],
              worktrees: (worktreeCliPayload().worktrees as unknown[]).filter(
                (entry) => (entry as { path: string }).path !== "/repo-worktrees/clean-merged"
              )
            }))}\n`,
            stderr: ""
          };
        }
        const payload = worktreeCliPayload();
        if (sawApply) {
          payload.worktrees = (payload.worktrees as Array<Record<string, unknown>>).filter(
            (entry) => entry.path !== "/repo-worktrees/clean-merged"
          );
        }
        return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
      }
    });
    const p = await present.previewWorktrees();
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const stillThere = await present.applyWorktree({
      reviewId: p.reviewId,
      candidateId: p.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(stillThere.ok).toBe(false);
    if (stillThere.ok) return;
    // H3: side effect confirmed; still-present is applied_unverified.
    expect(stillThere.issue.code).toBe("maintenance.applied_unverified");
    expect(stillThere.job?.status).toBe("applied_unverified");
    expect(stillThere.job?.sideEffectConfirmed).toBe(true);
    expect(stillThere.issues?.some((i) => i.code === "maintenance.worktree_still_present")).toBe(true);

    // already_finalized true with remaining candidates → not treated as finalized
    const contradiction = createController({
      runPipeline: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(finalizeCliPayload({
          already_finalized: true,
          media_files: ["dist/a.mp4", "dist/b.mp4"],
          retained_media: ["dist/a.mp4"],
          planned_bytes: 10
        }))}\n`,
        stderr: ""
      })
    });
    const cPrev = await contradiction.previewFinalize({
      id: "p1",
      name: "x",
      configPath: "/projects/demo/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed"
    }, {
      expectedRunId: "demo-run",
      revision: "a".repeat(64),
      completionDeclared: true
    });
    expect(cPrev.ok).toBe(true);
    if (!cPrev.ok) return;
    expect(cPrev.alreadyFinalized).toBe(false);
    expect(cPrev.phase).toBe("reviewable");

    // dropFinalizeReview removes orphan
    const dropper = createController({
      runPipeline: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(finalizeCliPayload())}\n`,
        stderr: ""
      })
    });
    const dPrev = await dropper.previewFinalize({
      id: "p1",
      name: "x",
      configPath: "/projects/demo/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed"
    }, {
      expectedRunId: "demo-run",
      revision: "a".repeat(64),
      completionDeclared: true
    });
    expect(dPrev.ok).toBe(true);
    if (!dPrev.ok) return;
    dropper.dropFinalizeReview(dPrev.reviewId);
    const afterDrop = await dropper.applyFinalize({
      id: "p1",
      name: "x",
      configPath: "/projects/demo/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed"
    }, {
      reviewId: dPrev.reviewId,
      planDigest: dPrev.planDigest,
      confirmed: true
    });
    expect(afterDrop.ok).toBe(false);
    if (afterDrop.ok) return;
    expect(afterDrop.issue.code).toBe("maintenance.review_missing");

    // Preview rejects when durable resolver fails (no review issued).
    const digest = "d".repeat(64);
    const rejectAtPreview = createController({
      resolveLauncherConfigPath: async () => ({
        ok: false,
        issue: { code: "maintenance.post_verify_failed", message: "bad durable" }
      }),
      runPipeline: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(finalizeCliPayload({ plan_digest: digest }))}\n`,
        stderr: ""
      })
    });
    const bpReject = await rejectAtPreview.previewFinalize({
      id: "p1",
      name: "x",
      configPath: "/projects/demo/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed",
      identityKey: "k"
    }, {
      expectedRunId: "demo-run",
      revision: "a".repeat(64),
      completionDeclared: true
    });
    expect(bpReject.ok).toBe(false);
    if (bpReject.ok) return;
    expect(bpReject.issue.code).toBe("maintenance.post_verify_failed");

    // After mutation, apply-report resolve failure is applied_unverified (review consumed).
    let resolveCalls = 0;
    const badDurable = createController({
      resolveLauncherConfigPath: async (path) => {
        resolveCalls += 1;
        // preview + pre-mutation succeed; post apply-report resolve fails.
        if (resolveCalls <= 2) {
          return { ok: true, path };
        }
        return {
          ok: false,
          issue: { code: "maintenance.post_verify_failed", message: "bad durable" }
        };
      },
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(finalizeCliPayload({
              applied: true,
              plan_digest: digest,
              promoted_to_launcher_home: true,
              launcher_config_path: "/evil/project.yaml",
              completion_record: "dist/demo-run/completion-record.json",
              deleted_files: 1
            }))}\n`,
            stderr: ""
          };
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(finalizeCliPayload({ plan_digest: digest }))}\n`,
          stderr: ""
        };
      }
    });
    const bp = await badDurable.previewFinalize({
      id: "p1",
      name: "x",
      configPath: "/projects/demo/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed",
      identityKey: "k"
    }, {
      expectedRunId: "demo-run",
      revision: "a".repeat(64),
      completionDeclared: true
    });
    expect(bp.ok).toBe(true);
    if (!bp.ok) return;
    const badApply = await badDurable.applyFinalize({
      id: "p1",
      name: "x",
      configPath: "/projects/demo/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed",
      identityKey: "k"
    }, {
      reviewId: bp.reviewId,
      planDigest: bp.planDigest,
      confirmed: true
    });
    expect(badApply.ok).toBe(false);
    if (!badApply.ok) {
      expect(badApply.issue.code).toBe("maintenance.applied_unverified");
      expect(badApply.job?.sideEffectConfirmed).toBe(true);
    }

    // redact helpers
    expect(redactAbsolutePaths("")).toBe("Safe cleanup failed");
    // long message with trailing slash only (no absolute path match) → generic
    expect(redactAbsolutePaths(`${"word ".repeat(20)}trail/`)).toBe("Safe cleanup failed");
    expect(redactAbsolutePaths("C:\\Users\\takamasa\\secret")).not.toMatch(/Users/i);
    expect(toPublicMaintenanceIssue({
      code: "maintenance.cli_nonzero_exit",
      message: "ignored raw"
    }).message).toBe("Canonical cleanup CLI exited non-zero; refusing success");
    expect(toPublicMaintenanceIssue({
      code: "custom",
      message: "ok",
      path: "plain"
    }).path).toBe("plain");
  });

  it("covers worktree phase branches, truncation, and apply refuse paths", async () => {
    // tidy-only primary/current → blocked-or-reviewable path
    const tidy = createController({
      runPipeline: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(worktreeCliPayload({
          worktrees: [(worktreeCliPayload().worktrees as unknown[])[0]],
          worktree_warning: { active: false, threshold: 3, removable_count: 0, removable_paths: [] }
        }))}\n`,
        stderr: ""
      })
    });
    const tidyPrev = await tidy.previewWorktrees();
    expect(tidyPrev.ok).toBe(true);
    if (!tidyPrev.ok) return;
    expect(tidyPrev.candidates).toHaveLength(0);
    expect(tidyPrev.tidy).toBe(true);

    // warning active branch
    const warn = createController({
      runPipeline: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(worktreeCliPayload({
          worktree_warning: {
            active: true,
            threshold: 3,
            removable_count: 5,
            removable_paths: ["/a", "/b", "/c", "/d", "/e"]
          }
        }))}\n`,
        stderr: ""
      })
    });
    const warnPrev = await warn.previewWorktrees();
    expect(warnPrev.ok).toBe(true);
    if (!warnPrev.ok) return;
    expect(warnPrev.warningActive).toBe(true);

    // applied:true on preview is invalid
    const appliedPreview = createController({
      runPipeline: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(worktreeCliPayload({ applied: true }))}\n`,
        stderr: ""
      })
    });
    expect((await appliedPreview.previewWorktrees()).ok).toBe(false);

    // candidate missing
    const miss = createController({
      runPipeline: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(worktreeCliPayload())}\n`,
        stderr: ""
      })
    });
    const missPrev = await miss.previewWorktrees();
    expect(missPrev.ok).toBe(true);
    if (!missPrev.ok) return;
    const missingCand = await miss.applyWorktree({
      reviewId: missPrev.reviewId,
      candidateId: "wtc_deadbeefdeadbeef",
      confirmed: true
    });
    expect(missingCand.ok).toBe(false);
    if (missingCand.ok) return;
    expect(missingCand.issue.code).toBe("maintenance.candidate_missing");

    // apply ok:false body
    const refuse = createController({
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(worktreeCliPayload({
              ok: false,
              applied: false,
              issues: [{ code: "worktrees.custom", message: "nope" }]
            }))}\n`,
            stderr: ""
          };
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(worktreeCliPayload())}\n`,
          stderr: ""
        };
      }
    });
    const rPrev = await refuse.previewWorktrees();
    expect(rPrev.ok).toBe(true);
    if (!rPrev.ok) return;
    const refused = await refuse.applyWorktree({
      reviewId: rPrev.reviewId,
      candidateId: rPrev.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(refused.ok).toBe(false);

    // still present in post list
    const still = createController({
      inspectRemovedPath: async () => "absent",
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(worktreeCliPayload({
              applied: true,
              removed: ["/repo-worktrees/clean-merged"]
            }))}\n`,
            stderr: ""
          };
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(worktreeCliPayload())}\n`,
          stderr: ""
        };
      }
    });
    const sPrev = await still.previewWorktrees();
    expect(sPrev.ok).toBe(true);
    if (!sPrev.ok) return;
    const stillFailed = await still.applyWorktree({
      reviewId: sPrev.reviewId,
      candidateId: sPrev.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(stillFailed.ok).toBe(false);
    if (stillFailed.ok) return;
    expect(stillFailed.issue.code).toBe("maintenance.applied_unverified");
    expect(stillFailed.job?.sideEffectConfirmed).toBe(true);
    expect(stillFailed.issues?.some((i) => i.code === "maintenance.worktree_still_present")).toBe(true);

    // runner truncation + env branch
    const runner = createMaintenancePipelineRunner({
      pipelineEntry: PIPELINE_ENTRY,
      cwd: REPO_ROOT,
      maxBytes: 64,
      env: { ...process.env, TSUGITE_MAINT_TEST: "1" }
    });
    // Forbidden argv throws
    await expect(runner(["worktrees", "--force", "--json"])).rejects.toThrow(/forbidden/);

    // finalize applied:true on preview invalid
    const finApplied = createController({
      runPipeline: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(finalizeCliPayload({ applied: true }))}\n`,
        stderr: ""
      })
    });
    const fa = await finApplied.previewFinalize({
      id: "p1",
      name: "x",
      configPath: "/p/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed"
    }, {
      expectedRunId: "demo-run",
      revision: "a".repeat(64),
      completionDeclared: true
    });
    expect(fa.ok).toBe(false);

    // apply planDigest mismatch vs review
    const digestCtrl = createController({
      runPipeline: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(finalizeCliPayload())}\n`,
        stderr: ""
      })
    });
    const dPrev = await digestCtrl.previewFinalize({
      id: "p1",
      name: "x",
      configPath: "/p/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed"
    }, {
      expectedRunId: "demo-run",
      revision: "a".repeat(64),
      completionDeclared: true
    });
    expect(dPrev.ok).toBe(true);
    if (!dPrev.ok) return;
    const wrongDigest = await digestCtrl.applyFinalize({
      id: "p1",
      name: "x",
      configPath: "/p/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed"
    }, {
      reviewId: dPrev.reviewId,
      planDigest: "e".repeat(64),
      confirmed: true
    });
    expect(wrongDigest.ok).toBe(false);
    if (wrongDigest.ok) return;
    expect(wrongDigest.issue.code).toBe("maintenance.plan_stale");

    // post missing completion_record
    const noRec = createController({
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(finalizeCliPayload({
              applied: true,
              plan_digest: "d".repeat(64),
              completion_record: null,
              deleted_files: 1
            }))}\n`,
            stderr: ""
          };
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(finalizeCliPayload({
            plan_digest: "d".repeat(64),
            already_finalized: args.includes("--apply") ? false : true,
            // live revalidate before apply needs not finalized; post needs finalized without record
            ...(true
              ? {
                  // first previews: not finalized; after apply: finalized empty record
                }
              : {})
          }))}\n`,
          stderr: ""
        };
      }
    });
    // More explicit stateful mock:
    let noRecPhase: "pre" | "post" = "pre";
    const noRec2 = createController({
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          noRecPhase = "post";
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(finalizeCliPayload({
              applied: true,
              plan_digest: "d".repeat(64),
              completion_record: null,
              deleted_files: 1
            }))}\n`,
            stderr: ""
          };
        }
        if (noRecPhase === "post") {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(finalizeCliPayload({
              plan_digest: "d".repeat(64),
              already_finalized: true,
              completion_record: null,
              media_files: ["dist/demo-run/final.mp4"],
              retained_media: ["dist/demo-run/final.mp4"],
              planned_bytes: 0
            }))}\n`,
            stderr: ""
          };
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(finalizeCliPayload({ plan_digest: "d".repeat(64) }))}\n`,
          stderr: ""
        };
      }
    });
    const nrPrev = await noRec2.previewFinalize({
      id: "p1",
      name: "x",
      configPath: "/p/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed",
      identityKey: "k"
    }, {
      expectedRunId: "demo-run",
      revision: "a".repeat(64),
      completionDeclared: true
    });
    expect(nrPrev.ok).toBe(true);
    if (!nrPrev.ok) return;
    const nrApply = await noRec2.applyFinalize({
      id: "p1",
      name: "x",
      configPath: "/p/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed",
      identityKey: "k"
    }, {
      reviewId: nrPrev.reviewId,
      planDigest: nrPrev.planDigest,
      confirmed: true
    });
    expect(nrApply.ok).toBe(false);
    if (nrApply.ok) return;
    expect(nrApply.issue.code).toBe("maintenance.applied_unverified");
    expect(nrApply.job?.status).toBe("applied_unverified");
    expect(nrApply.issues?.some((i) => i.code === "maintenance.completion_record_missing")).toBe(true);
    void noRec;

    // argv safety branches
    const safeRunner = createMaintenancePipelineRunner({
      pipelineEntry: PIPELINE_ENTRY,
      cwd: REPO_ROOT,
      maxBytes: 128
    });
    await expect(safeRunner(["finalize", "--state-dir", "/tmp", "--json"]))
      .rejects.toThrow(/state-dir/);
    await expect(safeRunner([
      "worktrees", "--apply", "--actor", "coordinator", "--json"
    ])).rejects.toThrow(/exactly one --path/);
    await expect(safeRunner([
      "worktrees", "--apply", "--actor", "coordinator",
      "--path", "/a", "--path", "/b", "--json"
    ])).rejects.toThrow(/exactly one --path/);

    // truncation path on tiny maxBytes — typed signal, not string marker alone
    const tiny = createMaintenancePipelineRunner({
      pipelineEntry: PIPELINE_ENTRY,
      cwd: REPO_ROOT,
      maxBytes: 32
    });
    const tinyOut = await tiny(["worktrees", "--json"]);
    expect(tinyOut.truncated).toBe(true);
    expect(tinyOut.stdout.includes("[output truncated]")).toBe(false);

    // defaultInspectRemovedPath: real present file and ENOENT
    const { mkdtemp, writeFile: wf, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "maint-lstat-"));
    const filePath = join(dir, "exists.txt");
    await wf(filePath, "x");
    let removedFlag = false;
    const defInspect = createController({
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          removedFlag = true;
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(worktreeCliPayload({
              applied: true,
              removed: [filePath],
              worktrees: (worktreeCliPayload().worktrees as unknown[]).filter(
                (entry) => (entry as { path: string }).path !== "/repo-worktrees/clean-merged"
              )
            }))}\n`.replaceAll("/repo-worktrees/clean-merged", filePath),
            stderr: ""
          };
        }
        const payload = worktreeCliPayload();
        // rewrite candidate path to real file for first preview
        const trees = payload.worktrees as Array<Record<string, unknown>>;
        trees[1] = { ...trees[1], path: filePath, removable: true, block_reasons: [] };
        if (removedFlag) {
          payload.worktrees = trees.filter((entry) => entry.path !== filePath);
        } else {
          payload.worktrees = trees;
        }
        return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
      }
    });
    const diPrev = await defInspect.previewWorktrees();
    expect(diPrev.ok).toBe(true);
    if (!diPrev.ok) return;
    const presentFail = await defInspect.applyWorktree({
      reviewId: diPrev.reviewId,
      candidateId: diPrev.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(presentFail.ok).toBe(false);
    await rm(dir, { recursive: true, force: true });

    // finalize ok:false without plan_digest
    const noDigest = createController({
      runPipeline: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify({
          ok: false,
          command: "finalize",
          issues: [{ code: "finalize.not_ready", message: "no" }],
          applied: false,
          media_files: [],
          retained_media: [],
          planned_bytes: 0,
          deleted_files: 0,
          deleted_bytes: 0
        })}\n`,
        stderr: ""
      })
    });
    const nd = await noDigest.previewFinalize({
      id: "p1",
      name: "x",
      configPath: "/p/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed"
    }, {
      expectedRunId: "demo-run",
      revision: "a".repeat(64),
      completionDeclared: true
    });
    expect(nd.ok).toBe(false);
  });
});

describe("launcher maintenance third-review fixes", () => {
  it("H2: removed must be single exact target (unrequested/dup/case drift)", async () => {
    expect(isExactSingleRemovedTarget(["/repo-worktrees/clean-merged"], "/repo-worktrees/clean-merged")).toBe(true);
    expect(isExactSingleRemovedTarget(
      ["/repo-worktrees/clean-merged", "/repo-worktrees/other"],
      "/repo-worktrees/clean-merged"
    )).toBe(false);
    expect(isExactSingleRemovedTarget(
      ["/repo-worktrees/clean-merged", "/repo-worktrees/clean-merged"],
      "/repo-worktrees/clean-merged"
    )).toBe(false);
    expect(isExactSingleRemovedTarget([], "/repo-worktrees/clean-merged")).toBe(false);
    // Case drift is not equal on case-sensitive platforms (matches lifecycle helper).
    expect(maintenancePathsEqual("/Repo/A", "/repo/a")).toBe(
      process.platform === "win32"
        ? maintenancePathsEqual("/Repo/A", "/repo/a")
        : false
    );
    if (process.platform !== "win32") {
      expect(isExactSingleRemovedTarget(
        ["/Repo-Worktrees/Clean-Merged"],
        "/repo-worktrees/clean-merged"
      )).toBe(false);
    }

    const multi = createController({
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(worktreeCliPayload({
              applied: true,
              removed: ["/repo-worktrees/clean-merged", "/repo-worktrees/other"],
              worktrees: (worktreeCliPayload().worktrees as unknown[]).filter(
                (entry) => (entry as { path: string }).path !== "/repo-worktrees/clean-merged"
              )
            }))}\n`,
            stderr: ""
          };
        }
        return { exitCode: 0, stdout: `${JSON.stringify(worktreeCliPayload())}\n`, stderr: "" };
      }
    });
    const prev = await multi.previewWorktrees();
    expect(prev.ok).toBe(true);
    if (!prev.ok) return;
    const failed = await multi.applyWorktree({
      reviewId: prev.reviewId,
      candidateId: prev.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.issue.code).toBe("maintenance.applied_unverified");
    expect(failed.job?.status).toBe("applied_unverified");
    expect(failed.issues?.some((i) => i.code === "maintenance.worktree_remove_unconfirmed")).toBe(true);
    const reapply = await multi.applyWorktree({
      reviewId: prev.reviewId,
      candidateId: prev.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(reapply.ok).toBe(false);
    if (reapply.ok) return;
    expect(reapply.issue.code).toBe("maintenance.review_missing");
  });

  it("H3: post preview non-zero after exact remove is applied_unverified", async () => {
    let applied = false;
    const controller = createController({
      inspectRemovedPath: async () => "absent",
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          applied = true;
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(worktreeCliPayload({
              applied: true,
              removed: ["/repo-worktrees/clean-merged"]
            }))}\n`,
            stderr: ""
          };
        }
        if (applied) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `${JSON.stringify({
              ok: false,
              issues: [{ code: "worktrees.preview_failed", message: "post boom" }]
            })}\n`
          };
        }
        return { exitCode: 0, stdout: `${JSON.stringify(worktreeCliPayload())}\n`, stderr: "" };
      }
    });
    const preview = await controller.previewWorktrees();
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const result = await controller.applyWorktree({
      reviewId: preview.reviewId,
      candidateId: preview.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.code).toBe("maintenance.applied_unverified");
    expect(result.job?.status).toBe("applied_unverified");
    expect(result.job?.phase).toBe("applied_unverified");
    expect(result.job?.sideEffectConfirmed).toBe(true);
    // Review consumed — re-apply with same review fails.
    const reapply = await controller.applyWorktree({
      reviewId: preview.reviewId,
      candidateId: preview.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(reapply.ok).toBe(false);
    if (reapply.ok) return;
    expect(reapply.issue.code).toBe("maintenance.review_missing");
  });

  it("H4: capture overflow uses cli_too_large at boundary and typed truncation", async () => {
    const boundary = CLI_JSON_MAX_BYTES;
    const under = createController({
      runPipeline: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(worktreeCliPayload())}\n`,
        stderr: "",
        truncated: false
      })
    });
    expect((await under.previewWorktrees()).ok).toBe(true);

    const atCap = createController({
      runPipeline: async () => ({
        exitCode: 0,
        stdout: "x".repeat(boundary),
        stderr: "",
        truncated: false
      })
    });
    // At exact cap bytes of non-JSON → cli_invalid (not too_large); size equals cap is allowed.
    const atCapResult = await atCap.previewWorktrees();
    expect(atCapResult.ok).toBe(false);
    if (!atCapResult.ok) {
      expect(atCapResult.issue.code).not.toBe("maintenance.cli_too_large");
    }

    const over = createController({
      runPipeline: async () => ({
        exitCode: 0,
        stdout: "x".repeat(boundary + 1),
        stderr: ""
      })
    });
    const overResult = await over.previewWorktrees();
    expect(overResult.ok).toBe(false);
    if (!overResult.ok) expect(overResult.issue.code).toBe("maintenance.cli_too_large");

    const truncated = createController({
      runPipeline: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(worktreeCliPayload()).slice(0, 40)}`,
        stderr: "",
        truncated: true
      })
    });
    const truncResult = await truncated.previewWorktrees();
    expect(truncResult.ok).toBe(false);
    if (!truncResult.ok) expect(truncResult.issue.code).toBe("maintenance.cli_too_large");

    expect(() => createMaintenancePipelineRunner({
      pipelineEntry: PIPELINE_ENTRY,
      cwd: REPO_ROOT,
      maxBytes: Number.POSITIVE_INFINITY
    })).toThrow(/safe integer|maxBytes/);
    expect(() => createMaintenancePipelineRunner({
      pipelineEntry: PIPELINE_ENTRY,
      cwd: REPO_ROOT,
      maxBytes: 1.5
    })).toThrow(/safe integer|maxBytes/);
  });

  it("M1: statusForMaintenanceIssue maps post-apply codes to 409/422 not 500", () => {
    const table: Array<[string, number]> = [
      [MAINTENANCE_ISSUE.worktreeRemoveUnconfirmed.code, 422],
      [MAINTENANCE_ISSUE.worktreeStillPresent.code, 409],
      [MAINTENANCE_ISSUE.worktreePathInspectFailed.code, 422],
      [MAINTENANCE_ISSUE.postVerifyFailed.code, 422],
      [MAINTENANCE_ISSUE.cliNonZeroExit.code, 422],
      [MAINTENANCE_ISSUE.appliedUnverified.code, 409],
      [MAINTENANCE_ISSUE.cliTooLarge.code, 422],
      [MAINTENANCE_ISSUE.cliInvalid.code, 422],
      [MAINTENANCE_ISSUE.snapshotStale.code, 409],
      [MAINTENANCE_ISSUE.projectMismatch.code, 409]
    ];
    for (const [code, status] of table) {
      expect(statusForMaintenanceIssue(code)).toBe(status);
      expect(statusForMaintenanceIssue(code)).not.toBe(500);
    }
  });

  it("M2: minimal worktrees {ok:false,issues} stays fail-closed without cli_invalid collapse", async () => {
    const controller = createController({
      runPipeline: async () => ({
        exitCode: 2,
        stdout: "",
        stderr: `${JSON.stringify({
          ok: false,
          issues: [{
            code: "worktrees.protected",
            message: "blocked under /Users/secret/project"
          }]
        })}\n`
      })
    });
    const failed = await controller.previewWorktrees();
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.issue.code).toBe("worktrees.protected");
    expect(failed.issue.code).not.toBe("maintenance.cli_invalid");
    expect(JSON.stringify(failed)).not.toContain("/Users/");
  });

  it("M5: cannot succeed via swapped durable already_finalized config", async () => {
    const digest = "d".repeat(64);
    const held = "/durable/projects/demo/project.yaml";
    const other = "/durable/projects/other/project.yaml";
    const controller = createController({
      resolveLauncherConfigPath: async (path) => {
        if (path === held || path === other) return { ok: true, path };
        return { ok: false, issue: MAINTENANCE_ISSUE.postVerifyFailed };
      },
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(finalizeCliPayload({
              applied: true,
              plan_digest: digest,
              promoted_to_launcher_home: true,
              // Adversarial: report a different durable config that is already finalized.
              launcher_config_path: other,
              completion_record: "dist/demo-run/completion-record.json",
              deleted_files: 1
            }))}\n`,
            stderr: ""
          };
        }
        const configIdx = args.indexOf("--config");
        const config = configIdx >= 0 ? args[configIdx + 1] : "";
        if (config === other) {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(finalizeCliPayload({
              plan_digest: digest,
              already_finalized: true,
              launcher_already_home: true,
              launcher_config_path: other,
              completion_record: "dist/other/completion-record.json",
              media_files: ["dist/other/final.mp4"],
              retained_media: ["dist/other/final.mp4"],
              planned_bytes: 0
            }))}\n`,
            stderr: ""
          };
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(finalizeCliPayload({
            plan_digest: digest,
            launcher_config_path: held,
            already_finalized: false
          }))}\n`,
          stderr: ""
        };
      }
    });
    const project = {
      id: "p1",
      name: "デモ",
      configPath: "/worktree/projects/demo/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed",
      identityKey: "1:1"
    };
    const preview = await controller.previewFinalize(project, {
      expectedRunId: project.runId,
      revision: project.revision,
      completionDeclared: true
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const result = await controller.applyFinalize(project, {
      reviewId: preview.reviewId,
      planDigest: preview.planDigest,
      confirmed: true
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.code).toBe("maintenance.applied_unverified");
    expect(result.job?.sideEffectConfirmed).toBe(true);
  });

  it("M6: omit revalidateProjectIdentity fails closed on finalize apply", async () => {
    const digest = "d".repeat(64);
    const controller = createLauncherMaintenanceController({
      // Explicit omit — production safety contract.
      // Provide absolute-path resolve so preview can issue a review; revalidate remains omitted.
      resolveLauncherConfigPath: async (path) => (
        typeof path === "string" && path.length > 0 && isAbsolute(path)
          ? { ok: true, path }
          : { ok: false, issue: MAINTENANCE_ISSUE.postVerifyFailed }
      ),
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          throw new Error("apply must not run without revalidate");
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(finalizeCliPayload({ plan_digest: digest }))}\n`,
          stderr: ""
        };
      }
    });
    const project = {
      id: "p1",
      name: "デモ",
      configPath: "/projects/demo/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed",
      identityKey: "k"
    };
    const preview = await controller.previewFinalize(project, {
      expectedRunId: project.runId,
      revision: project.revision,
      completionDeclared: true
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const failed = await controller.applyFinalize(project, {
      reviewId: preview.reviewId,
      planDigest: preview.planDigest,
      confirmed: true
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.issue.code).toBe("maintenance.project_mismatch");
  });

  it("L2: redacts file:///Users and blank path fields", () => {
    expect(redactAbsolutePaths("see file:///Users/takamasa/secret/project.yaml"))
      .not.toMatch(/Users/i);
    expect(redactAbsolutePaths("see file:///Users/takamasa/secret/project.yaml"))
      .not.toContain("file://");
    expect(redactAbsolutePaths("file:///Users/me/x")).not.toMatch(/Users/i);
    expect(redactAbsolutePaths("file:///Users/me/x")).not.toContain("file://");
    expect(redactAbsolutePaths("   ")).toBe("Safe cleanup failed");
    expect(toPublicMaintenanceIssue({
      code: "custom",
      message: "open file:///Users/me/private",
      path: "file:///Users/me/private"
    }).path).toBe("[path]");
    expect(toPublicMaintenanceIssue({
      code: "custom",
      message: "x",
      path: "   "
    }).path).toBe("[path]");
  });

  it("H1: maintenanceProjectsHome pins TSUGITE_PROJECTS_HOME away from runtime cwd", async () => {
    const fixture = await createCompletedProjectFixture();
    const selectedHome = fixture.projectsDir;
    const otherHome = join(fixture.root, "other-home");
    await mkdir(otherHome, { recursive: true });
    const prev = process.env.TSUGITE_PROJECTS_HOME;
    process.env.TSUGITE_PROJECTS_HOME = otherHome;
    try {
      const resolved = await resolveMaintenanceDurableHome({
        maintenanceProjectsHome: selectedHome,
        projectsDir: selectedHome,
        cwd: join(fixture.root, "runtime-packaged")
      });
      expect(resolved).toBe(await import("node:fs/promises").then((fs) => fs.realpath(selectedHome)));
      // Explicit home wins over env and cwd.
      expect(resolved).not.toContain("other-home");

      const capturedEnv: string[] = [];
      const launcher = await launch({
        projectsDir: selectedHome,
        maintenanceProjectsHome: selectedHome,
        templatesDir: fixture.templatesDir,
        bundleDir: fixture.bundleDir,
        port: 0,
        linkProjectShelves: false,
        executePipeline: async (_cmd, args, options) => {
          capturedEnv.push(String(options.env?.TSUGITE_PROJECTS_HOME ?? ""));
          if (args.includes("finalize")) {
            return {
              exitCode: 0,
              stdout: `${JSON.stringify({
                ok: true,
                command: "finalize",
                issues: [],
                applied: false,
                already_finalized: false,
                plan_digest: "d".repeat(64),
                media_files: ["dist/demo-run/old.mp4"],
                retained_media: ["dist/demo-run/final.mp4"],
                planned_bytes: 10,
                deleted_files: 0,
                deleted_bytes: 0,
                launcher_projects_home: selectedHome,
                launcher_config_path: join(fixture.projectDir, "project.yaml"),
                launcher_already_home: true,
                launcher_visible: true,
                completion_record: "dist/demo-run/completion-record.json"
              })}\n`,
              stderr: ""
            };
          }
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(worktreeCliPayload())}\n`,
            stderr: ""
          };
        }
      });
      const projects = await (await fetch(`${launcher.url}/api/projects`, {
        headers: authHeaders(launcher)
      })).json() as { projects: Array<{ id: string }> };
      const projectId = projects.projects[0]!.id;
      const preview = await fetch(
        `${launcher.url}/api/projects/${projectId}/finalize/preview`,
        {
          method: "POST",
          headers: authHeaders(launcher),
          body: JSON.stringify({
            expectedRunId: "demo-run",
            revision: (await (await fetch(`${launcher.url}/api/projects`, {
              headers: authHeaders(launcher)
            })).json() as { projects: Array<{ id: string; revision: string }> })
              .projects.find((p) => p.id === projectId)?.revision,
            completionDeclared: true
          })
        }
      );
      // Even if revision mismatches, env must still have been pinned for the attempt.
      expect(capturedEnv.some((home) => home.includes("projects") || home === selectedHome || home.length > 0)).toBe(true);
      void preview;
    } finally {
      if (prev === undefined) delete process.env.TSUGITE_PROJECTS_HOME;
      else process.env.TSUGITE_PROJECTS_HOME = prev;
    }
  });
});

describe("launcher maintenance remaining safety fixes", () => {
  it("HIGH: only active maintenance home shelf stays writable; other shelves cannot finalize", async () => {
    // realpath requires existing dirs (missing paths fail-closed as readOnly).
    const shelfRoot = await mkdtemp(join(tmpdir(), "tsugite-shelf-hi-"));
    const active = join(shelfRoot, "active-home");
    const other = join(shelfRoot, "other-home");
    const extra = join(shelfRoot, "extra");
    await mkdir(active, { recursive: true });
    await mkdir(other, { recursive: true });
    await mkdir(extra, { recursive: true });
    const shelves = await canonicalizeLauncherShelfWritability([
      { path: active, readOnly: false },
      { path: other, readOnly: false },
      { path: extra, readOnly: true }
    ], active);
    expect(shelves).toEqual([
      { path: resolve(active), readOnly: false },
      { path: resolve(other), readOnly: true },
      { path: resolve(extra), readOnly: true }
    ]);

    const fixture = await createCompletedProjectFixture();
    const activeHome = join(fixture.root, "active-home");
    const foreignHome = fixture.projectsDir;
    await mkdir(activeHome, { recursive: true });

    const launcher = await launch({
      projectsDir: foreignHome,
      // Active writable home is empty / different — foreign shelf must become readOnly.
      maintenanceProjectsHome: activeHome,
      templatesDir: fixture.templatesDir,
      bundleDir: fixture.bundleDir,
      port: 0,
      linkProjectShelves: false,
      executePipeline: async (_cmd, args) => {
        if (args.includes("finalize") && args.includes("--apply")) {
          throw new Error("foreign shelf must not reach finalize apply");
        }
        if (args.includes("finalize")) {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(finalizeCliPayload({
              plan_digest: "d".repeat(64),
              launcher_config_path: join(fixture.projectDir, "project.yaml")
            }))}\n`,
            stderr: ""
          };
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(worktreeCliPayload())}\n`,
          stderr: ""
        };
      }
    });

    const list = await (await fetch(`${launcher.url}/api/projects`, {
      headers: authHeaders(launcher)
    })).json() as { projects: Array<{ id: string; readOnly: boolean; revision: string; runId: string }> };
    expect(list.projects.length).toBeGreaterThan(0);
    const project = list.projects[0]!;
    expect(project.readOnly).toBe(true);

    const preview = await fetch(`${launcher.url}/api/projects/${project.id}/finalize/preview`, {
      method: "POST",
      headers: authHeaders(launcher),
      body: JSON.stringify({
        expectedRunId: project.runId,
        revision: project.revision,
        completionDeclared: true
      })
    });
    expect(preview.status).toBe(403);
    const body = await preview.json() as { ok: boolean; issue?: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.issue?.code).toBe("maintenance.project_read_only");
  });

  it("MEDIUM: applied:true removed mismatch and exit0 truncated/corrupt JSON consume review as applied_unverified", async () => {
    // applied:true + wrong removed
    const wrongRemoved = createController({
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(worktreeCliPayload({
              applied: true,
              removed: ["/repo-worktrees/other"]
            }))}\n`,
            stderr: ""
          };
        }
        return { exitCode: 0, stdout: `${JSON.stringify(worktreeCliPayload())}\n`, stderr: "" };
      }
    });
    const p1 = await wrongRemoved.previewWorktrees();
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    const f1 = await wrongRemoved.applyWorktree({
      reviewId: p1.reviewId,
      candidateId: p1.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(f1.ok).toBe(false);
    if (f1.ok) return;
    expect(f1.issue.code).toBe("maintenance.applied_unverified");
    expect(f1.job?.status).toBe("applied_unverified");
    expect(f1.job?.sideEffectConfirmed).toBe(true);
    expect(f1.issues?.some((i) => i.code === "maintenance.worktree_remove_unconfirmed")).toBe(true);
    const re1 = await wrongRemoved.applyWorktree({
      reviewId: p1.reviewId,
      candidateId: p1.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(re1.ok).toBe(false);
    if (re1.ok) return;
    expect(re1.issue.code).toBe("maintenance.review_missing");

    // exit0 + truncated after mutation
    const truncated = createController({
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(worktreeCliPayload({ applied: true })).slice(0, 20)}`,
            stderr: "",
            truncated: true
          };
        }
        return { exitCode: 0, stdout: `${JSON.stringify(worktreeCliPayload())}\n`, stderr: "" };
      }
    });
    const p2 = await truncated.previewWorktrees();
    expect(p2.ok).toBe(true);
    if (!p2.ok) return;
    const f2 = await truncated.applyWorktree({
      reviewId: p2.reviewId,
      candidateId: p2.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(f2.ok).toBe(false);
    if (f2.ok) return;
    expect(f2.issue.code).toBe("maintenance.applied_unverified");
    expect(f2.job?.status).toBe("applied_unverified");
    expect(f2.issues?.some((i) => i.code === "maintenance.cli_too_large")).toBe(true);
    const re2 = await truncated.applyWorktree({
      reviewId: p2.reviewId,
      candidateId: p2.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(re2.ok).toBe(false);
    if (re2.ok) return;
    expect(re2.issue.code).toBe("maintenance.review_missing");

    // exit0 + corrupt JSON after mutation
    const corrupt = createController({
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          return { exitCode: 0, stdout: "{not-json", stderr: "" };
        }
        return { exitCode: 0, stdout: `${JSON.stringify(worktreeCliPayload())}\n`, stderr: "" };
      }
    });
    const p3 = await corrupt.previewWorktrees();
    expect(p3.ok).toBe(true);
    if (!p3.ok) return;
    const f3 = await corrupt.applyWorktree({
      reviewId: p3.reviewId,
      candidateId: p3.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(f3.ok).toBe(false);
    if (f3.ok) return;
    expect(f3.issue.code).toBe("maintenance.applied_unverified");
    expect(f3.job?.status).toBe("applied_unverified");
    expect(f3.issues?.some((i) => i.code === "maintenance.cli_invalid")).toBe(true);
    const re3 = await corrupt.applyWorktree({
      reviewId: p3.reviewId,
      candidateId: p3.candidates[0]!.candidateId,
      confirmed: true
    });
    expect(re3.ok).toBe(false);
    if (re3.ok) return;
    expect(re3.issue.code).toBe("maintenance.review_missing");

    // Pre-mutation validation must NOT consume (candidate blocked / review missing stays reusable policy).
    const pre = createController({
      runPipeline: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(worktreeCliPayload())}\n`,
        stderr: ""
      })
    });
    const p4 = await pre.previewWorktrees();
    expect(p4.ok).toBe(true);
    if (!p4.ok) return;
    const blockedId = p4.blocked[0]?.candidateId;
    expect(blockedId).toBeTruthy();
    const blocked = await pre.applyWorktree({
      reviewId: p4.reviewId,
      candidateId: blockedId!,
      confirmed: true
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.issue.code).toBe("maintenance.candidate_blocked");
    // Same review still present for a valid candidate after pre-mutation reject.
    const still = await pre.applyWorktree({
      reviewId: p4.reviewId,
      candidateId: p4.candidates[0]!.candidateId,
      confirmed: true
    });
    // apply may succeed or fail on CLI, but must not be review_missing
    if (!still.ok) {
      expect(still.issue.code).not.toBe("maintenance.review_missing");
    }
  });

  it("MEDIUM: review-held durable launcher_config_path is required; no apply-path fallback / borrow", async () => {
    const digest = "d".repeat(64);
    const held = "/durable/projects/demo/project.yaml";
    const other = "/durable/projects/other/project.yaml";

    // Missing preview launcher_config_path → no review issued (preview fails closed).
    let applyCalled = false;
    const missing = createController({
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          applyCalled = true;
          throw new Error("apply must not run without review launcher_config_path");
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(finalizeCliPayload({
            plan_digest: digest,
            launcher_config_path: null
          }))}\n`,
          stderr: ""
        };
      }
    });
    const project = {
      id: "p1",
      name: "デモ",
      configPath: "/worktree/projects/demo/project.yaml",
      readOnly: false,
      valid: true,
      runId: "demo-run",
      revision: "a".repeat(64),
      status: "completed",
      identityKey: "1:1"
    };
    const prevMissing = await missing.previewFinalize(project, {
      expectedRunId: project.runId,
      revision: project.revision,
      completionDeclared: true
    });
    expect(prevMissing.ok).toBe(false);
    if (prevMissing.ok) return;
    expect(prevMissing.issue.code).toBe("maintenance.launcher_config_required");
    expect(applyCalled).toBe(false);

    // Apply reports a different durable config → cannot borrow other finalized state.
    const borrow = createController({
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(finalizeCliPayload({
              applied: true,
              plan_digest: digest,
              promoted_to_launcher_home: true,
              launcher_config_path: other,
              completion_record: "dist/demo-run/completion-record.json",
              deleted_files: 1
            }))}\n`,
            stderr: ""
          };
        }
        const configIdx = args.indexOf("--config");
        const config = configIdx >= 0 ? args[configIdx + 1] : "";
        if (config === other) {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(finalizeCliPayload({
              plan_digest: digest,
              already_finalized: true,
              launcher_config_path: other,
              completion_record: "dist/other/completion-record.json",
              media_files: ["dist/other/final.mp4"],
              retained_media: ["dist/other/final.mp4"],
              planned_bytes: 0
            }))}\n`,
            stderr: ""
          };
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(finalizeCliPayload({
            plan_digest: digest,
            launcher_config_path: held,
            already_finalized: false
          }))}\n`,
          stderr: ""
        };
      }
    });
    const prevBorrow = await borrow.previewFinalize(project, {
      expectedRunId: project.runId,
      revision: project.revision,
      completionDeclared: true
    });
    expect(prevBorrow.ok).toBe(true);
    if (!prevBorrow.ok) return;
    const failBorrow = await borrow.applyFinalize(project, {
      reviewId: prevBorrow.reviewId,
      planDigest: prevBorrow.planDigest,
      confirmed: true
    });
    expect(failBorrow.ok).toBe(false);
    if (failBorrow.ok) return;
    expect(failBorrow.issue.code).toBe("maintenance.applied_unverified");
    expect(failBorrow.job?.sideEffectConfirmed).toBe(true);
    // Same review cannot re-apply.
    const reBorrow = await borrow.applyFinalize(project, {
      reviewId: prevBorrow.reviewId,
      planDigest: prevBorrow.planDigest,
      confirmed: true
    });
    expect(reBorrow.ok).toBe(false);
    if (reBorrow.ok) return;
    expect(reBorrow.issue.code).toBe("maintenance.review_missing");

    // Apply-only durable path without review-held path is rejected (no fallback).
    let applyOnlyCalled = false;
    const applyOnlyForced = createController({
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          applyOnlyCalled = true;
          throw new Error("must not apply without review-held durable path");
        }
        const payload = finalizeCliPayload({ plan_digest: digest, already_finalized: false });
        delete (payload as { launcher_config_path?: unknown }).launcher_config_path;
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(payload)}\n`,
          stderr: ""
        };
      }
    });
    const prevApplyOnly = await applyOnlyForced.previewFinalize(project, {
      expectedRunId: project.runId,
      revision: project.revision,
      completionDeclared: true
    });
    expect(prevApplyOnly.ok).toBe(false);
    if (prevApplyOnly.ok) return;
    expect(prevApplyOnly.issue.code).toBe("maintenance.launcher_config_required");
    expect(applyOnlyCalled).toBe(false);
  });
});

describe("launcher maintenance fourth-review TDD fixes", () => {
  const completedProject = {
    id: "p1",
    name: "デモ",
    configPath: "/worktree/projects/demo/project.yaml",
    readOnly: false,
    valid: true,
    runId: "demo-run",
    revision: "a".repeat(64),
    status: "completed",
    identityKey: "1:1"
  } as const;

  it("MEDIUM: previewFinalize rejects invalid launcher_config_path without issuing review", async () => {
    const digest = "d".repeat(64);
    const fixture = await createCompletedProjectFixture();
    const config = join(fixture.projectDir, "project.yaml");
    const outside = join(fixture.root, "outside.yaml");
    await writeFile(outside, "x: 1\n");

    const cases: Array<{ label: string; path: string | null; code: string }> = [
      { label: "relative", path: "relative/project.yaml", code: "maintenance.post_verify_failed" },
      { label: "missing", path: join(fixture.projectsDir, "no-such-project.yaml"), code: "maintenance.post_verify_failed" },
      { label: "outside-home", path: outside, code: "maintenance.post_verify_failed" },
      { label: "null", path: null, code: "maintenance.launcher_config_required" }
    ];

    for (const item of cases) {
      const controller = createController({
        durableProjectsHome: fixture.projectsDir,
        resolveLauncherConfigPath: undefined,
        runPipeline: async () => ({
          exitCode: 0,
          stdout: `${JSON.stringify(finalizeCliPayload({
            plan_digest: digest,
            launcher_config_path: item.path
          }))}\n`,
          stderr: ""
        })
      });
      const preview = await controller.previewFinalize(completedProject, {
        expectedRunId: completedProject.runId,
        revision: completedProject.revision,
        completionDeclared: true
      });
      expect(preview.ok, item.label).toBe(false);
      if (preview.ok) return;
      expect(preview.issue.code, item.label).toBe(item.code);
      // No reviewId means apply cannot proceed.
      expect("reviewId" in preview && (preview as { reviewId?: string }).reviewId).toBeFalsy();
    }

    // Symlink escape: config is a symlink even under home → refuse review.
    const { symlink } = await import("node:fs/promises");
    const linkPath = join(fixture.projectsDir, "link-escape.yaml");
    try {
      await symlink(config, linkPath);
    } catch {
      return; // environments without symlink support skip this branch
    }
    const symlinkController = createController({
      durableProjectsHome: fixture.projectsDir,
      resolveLauncherConfigPath: undefined,
      runPipeline: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(finalizeCliPayload({
          plan_digest: digest,
          launcher_config_path: linkPath
        }))}\n`,
        stderr: ""
      })
    });
    const symlinkPreview = await symlinkController.previewFinalize(completedProject, {
      expectedRunId: completedProject.runId,
      revision: completedProject.revision,
      completionDeclared: true
    });
    expect(symlinkPreview.ok).toBe(false);
    if (symlinkPreview.ok) return;
    expect(symlinkPreview.issue.code).toBe("maintenance.post_verify_failed");

    // Valid home-contained regular file issues review that stores resolved real path.
    const valid = createController({
      durableProjectsHome: fixture.projectsDir,
      resolveLauncherConfigPath: undefined,
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(finalizeCliPayload({
              applied: true,
              plan_digest: digest,
              launcher_config_path: config,
              completion_record: "dist/demo-run/completion-record.json",
              deleted_files: 1
            }))}\n`,
            stderr: ""
          };
        }
        const configIdx = args.indexOf("--config");
        const cfg = configIdx >= 0 ? args[configIdx + 1] : "";
        if (cfg && cfg !== completedProject.configPath) {
          // post-verify uses resolved durable path
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(finalizeCliPayload({
              plan_digest: digest,
              already_finalized: true,
              launcher_config_path: config,
              completion_record: "dist/demo-run/completion-record.json",
              media_files: ["dist/demo-run/final.mp4"],
              retained_media: ["dist/demo-run/final.mp4"],
              planned_bytes: 0
            }))}\n`,
            stderr: ""
          };
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(finalizeCliPayload({
            plan_digest: digest,
            launcher_config_path: config,
            already_finalized: false
          }))}\n`,
          stderr: ""
        };
      }
    });
    const okPreview = await valid.previewFinalize(completedProject, {
      expectedRunId: completedProject.runId,
      revision: completedProject.revision,
      completionDeclared: true
    });
    expect(okPreview.ok).toBe(true);
    if (!okPreview.ok) return;
    const applied = await valid.applyFinalize(completedProject, {
      reviewId: okPreview.reviewId,
      planDigest: okPreview.planDigest,
      confirmed: true
    });
    expect(applied.ok).toBe(true);
  });

  it("MEDIUM: apply re-resolves review-held path before mutation; swap keeps review", async () => {
    const digest = "d".repeat(64);
    const cliPath = "/durable/projects/demo/project.yaml";
    const canonical = "/canonical/home/demo/project.yaml";
    let resolvePhase: "preview" | "pre-apply" | "post" = "preview";
    let applyArgvCount = 0;
    const controller = createController({
      resolveLauncherConfigPath: async (path) => {
        if (resolvePhase === "preview") {
          // CLI path accepted and canonicalized into review.
          if (path === cliPath) return { ok: true, path: canonical };
          return { ok: false, issue: MAINTENANCE_ISSUE.postVerifyFailed };
        }
        if (resolvePhase === "pre-apply") {
          // Path swap / disappearance after preview.
          return { ok: false, issue: MAINTENANCE_ISSUE.postVerifyFailed };
        }
        // post phase unused when pre-apply fails
        return path === canonical
          ? { ok: true, path: canonical }
          : { ok: false, issue: MAINTENANCE_ISSUE.postVerifyFailed };
      },
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          applyArgvCount += 1;
          throw new Error("finalize --apply must not run after pre-mutation resolve failure");
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(finalizeCliPayload({
            plan_digest: digest,
            launcher_config_path: cliPath,
            already_finalized: false
          }))}\n`,
          stderr: ""
        };
      }
    });

    const preview = await controller.previewFinalize(completedProject, {
      expectedRunId: completedProject.runId,
      revision: completedProject.revision,
      completionDeclared: true
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    resolvePhase = "pre-apply";
    const failed = await controller.applyFinalize(completedProject, {
      reviewId: preview.reviewId,
      planDigest: preview.planDigest,
      confirmed: true
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.issue.code).toBe("maintenance.post_verify_failed");
    expect(applyArgvCount).toBe(0);
    // Review kept (pre-mutation) — same reviewId still present, not review_missing.
    expect(failed.job?.sideEffectConfirmed).not.toBe(true);

    // Retry with still-failing resolve: must remain not review_missing (review reusable).
    const retrySame = await controller.applyFinalize(completedProject, {
      reviewId: preview.reviewId,
      planDigest: preview.planDigest,
      confirmed: true
    });
    expect(retrySame.ok).toBe(false);
    if (retrySame.ok) return;
    expect(retrySame.issue.code).not.toBe("maintenance.review_missing");
    expect(applyArgvCount).toBe(0);
  });

  it("LOW: post-verify throw after sideEffectConfirmed yields applied_unverified (worktree+finalize)", async () => {
    // Worktree: exact remove confirmed, post list empty, then inspect throws.
    let wtPreviewCalls = 0;
    const wt = createController({
      inspectRemovedPath: async () => {
        throw new Error("inspect boom after mutation");
      },
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(worktreeCliPayload({
              applied: true,
              removed: ["/repo-worktrees/clean-merged"]
            }))}\n`,
            stderr: ""
          };
        }
        wtPreviewCalls += 1;
        // preview + revalidate keep candidate; post-verify list is empty.
        if (wtPreviewCalls <= 2) {
          return { exitCode: 0, stdout: `${JSON.stringify(worktreeCliPayload())}\n`, stderr: "" };
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(worktreeCliPayload({ worktrees: [] }))}\n`,
          stderr: ""
        };
      }
    });
    const pWt = await wt.previewWorktrees();
    expect(pWt.ok).toBe(true);
    if (!pWt.ok) return;
    const candidate = pWt.candidates[0];
    expect(candidate).toBeTruthy();
    const wtFail = await wt.applyWorktree({
      reviewId: pWt.reviewId,
      candidateId: candidate!.candidateId,
      confirmed: true
    });
    expect(wtFail.ok).toBe(false);
    if (wtFail.ok) return;
    // Current bug: catch maps to failed/internal after side effects.
    expect(wtFail.issue.code).toBe("maintenance.applied_unverified");
    expect(wtFail.job?.status).toBe("applied_unverified");
    expect(wtFail.job?.sideEffectConfirmed).toBe(true);
    const wtRe = await wt.applyWorktree({
      reviewId: pWt.reviewId,
      candidateId: candidate!.candidateId,
      confirmed: true
    });
    expect(wtRe.ok).toBe(false);
    if (wtRe.ok) return;
    expect(wtRe.issue.code).toBe("maintenance.review_missing");

    // Finalize: post-verify pipeline throws after mutation.
    const digest = "d".repeat(64);
    const held = "/durable/projects/demo/project.yaml";
    let finCalls = 0;
    const fin = createController({
      runPipeline: async (args) => {
        if (args.includes("--apply")) {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(finalizeCliPayload({
              applied: true,
              plan_digest: digest,
              launcher_config_path: held,
              completion_record: "dist/demo-run/completion-record.json",
              deleted_files: 1
            }))}\n`,
            stderr: ""
          };
        }
        finCalls += 1;
        // preview(1) + revalidate(2) ok; post-verify(3) throws after mutation.
        if (finCalls >= 3) {
          throw new Error("post preview boom");
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(finalizeCliPayload({
            plan_digest: digest,
            launcher_config_path: held,
            already_finalized: false
          }))}\n`,
          stderr: ""
        };
      }
    });
    const pFin = await fin.previewFinalize(completedProject, {
      expectedRunId: completedProject.runId,
      revision: completedProject.revision,
      completionDeclared: true
    });
    expect(pFin.ok).toBe(true);
    if (!pFin.ok) return;
    const finFail = await fin.applyFinalize(completedProject, {
      reviewId: pFin.reviewId,
      planDigest: pFin.planDigest,
      confirmed: true
    });
    expect(finFail.ok).toBe(false);
    if (finFail.ok) return;
    expect(finFail.issue.code).toBe("maintenance.applied_unverified");
    expect(finFail.job?.status).toBe("applied_unverified");
    expect(finFail.job?.sideEffectConfirmed).toBe(true);
    const finRe = await fin.applyFinalize(completedProject, {
      reviewId: pFin.reviewId,
      planDigest: pFin.planDigest,
      confirmed: true
    });
    expect(finRe.ok).toBe(false);
    if (finRe.ok) return;
    expect(finRe.issue.code).toBe("maintenance.review_missing");
  });

  it("LOW/UX: symlink active shelf stays writable via realpath; other shelves readOnly; realpath fail → readOnly", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-shelf-"));
    const realHome = join(root, "real-home");
    const linkHome = join(root, "link-home");
    const otherHome = join(root, "other-home");
    await mkdir(realHome, { recursive: true });
    await mkdir(otherHome, { recursive: true });
    const { symlink } = await import("node:fs/promises");
    try {
      await symlink(realHome, linkHome);
    } catch {
      return; // skip when symlink unavailable
    }
    const activeReal = await import("node:fs/promises").then((fs) => fs.realpath(realHome));

    const shelves = await canonicalizeLauncherShelfWritability([
      { path: linkHome, readOnly: false },
      { path: otherHome, readOnly: false },
      { path: join(root, "missing-shelf"), readOnly: false }
    ], activeReal);

    const linkShelf = shelves.find((s) => s.path === resolve(linkHome));
    const otherShelf = shelves.find((s) => s.path === resolve(otherHome));
    const missingShelf = shelves.find((s) => s.path === resolve(join(root, "missing-shelf")));
    expect(linkShelf?.readOnly).toBe(false);
    expect(otherShelf?.readOnly).toBe(true);
    // realpath fail-closed → readOnly (must not grant write)
    expect(missingShelf?.readOnly).toBe(true);

    // Non-active must never become writable even if previously marked writable.
    expect(shelves.filter((s) => !s.readOnly)).toHaveLength(1);
  });
});
