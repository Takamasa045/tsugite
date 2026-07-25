import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureFinalizedProjectInLauncherHome,
  ensureProjectVisibleOnLauncherShelf,
  isWithinDirectory,
  planLauncherHome,
  resolveDurableProjectsHome
} from "../src/project/projectsHome.js";

describe("durable launcher projects home", () => {
  it("detects path containment for relative and absolute comparisons", () => {
    const parent = resolve("/tmp/tsugite-home");
    expect(isWithinDirectory(parent, join(parent, "child"))).toBe(true);
    expect(isWithinDirectory(parent, parent)).toBe(true);
    expect(isWithinDirectory(parent, resolve("/tmp/other"))).toBe(false);
  });

  it("prefers TSUGITE_PROJECTS_HOME over workspace and cwd", async () => {
    const home = await resolveDurableProjectsHome({
      cwd: resolve("/tmp/not-used"),
      env: {
        TSUGITE_PROJECTS_HOME: resolve("/var/tsugite/projects-home"),
        TSUGITE_WORKSPACE_ROOT: resolve("/var/tsugite-workspace")
      }
    });
    expect(home).toBe(resolve("/var/tsugite/projects-home"));
  });

  it("uses TSUGITE_WORKSPACE_ROOT/projects when home env is unset", async () => {
    const home = await resolveDurableProjectsHome({
      cwd: resolve("/tmp/not-used"),
      env: {
        TSUGITE_WORKSPACE_ROOT: resolve("/Users/me/workspace")
      }
    });
    expect(home).toBe(join(resolve("/Users/me/workspace"), "projects"));
  });

  it("plans promotion when the project is outside the durable home", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-home-plan-"));
    const projectsHome = join(root, "durable-projects");
    const projectRoot = join(root, "worktree-projects", "myth-battle");
    const configPath = join(projectRoot, "project.yaml");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(configPath, "slug: myth-battle\n", "utf8");

    const plan = await planLauncherHome(configPath, "myth-battle", {
      env: { TSUGITE_PROJECTS_HOME: projectsHome }
    });

    expect(plan.alreadyHome).toBe(false);
    expect(plan.willPromote).toBe(true);
    expect(plan.destinationRoot).toBe(join(projectsHome, "myth-battle"));
    expect(isWithinDirectory(projectsHome, plan.destinationRoot)).toBe(true);
  });

  it("copies a finalized worktree project into the durable launcher home", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-home-promote-"));
    const projectsHome = join(root, "durable-projects");
    const projectRoot = join(root, "feature-worktree", "projects", "myth-battle");
    const configPath = join(projectRoot, "project.yaml");
    const runDir = join(projectRoot, "dist", "myth-battle-r13");
    await mkdir(runDir, { recursive: true });
    await writeFile(configPath, "slug: myth-battle\nrun_id: myth-battle-r13\n", "utf8");
    await writeFile(join(runDir, "final.mp4"), "final-bytes", "utf8");
    await writeFile(join(runDir, "completion-record.json"), "{\"ok\":true}\n", "utf8");

    const preview = await ensureFinalizedProjectInLauncherHome({
      configPath,
      projectSlug: "myth-battle",
      apply: false,
      env: { TSUGITE_PROJECTS_HOME: projectsHome }
    });
    expect(preview.ok).toBe(true);
    expect(preview.alreadyHome).toBe(false);
    expect(preview.promoted).toBe(false);
    await expect(stat(join(projectsHome, "myth-battle"))).rejects.toThrow();

    const applied = await ensureFinalizedProjectInLauncherHome({
      configPath,
      projectSlug: "myth-battle",
      apply: true,
      env: { TSUGITE_PROJECTS_HOME: projectsHome },
      now: "2026-07-25T00:00:00.000Z"
    });
    expect(applied.ok).toBe(true);
    expect(applied.promoted).toBe(true);
    expect(applied.destinationRoot).toBe(join(projectsHome, "myth-battle"));
    await expect(stat(join(projectsHome, "myth-battle", "dist", "myth-battle-r13", "final.mp4")))
      .resolves.toBeDefined();
    await expect(stat(join(projectsHome, "myth-battle", "project.yaml"))).resolves.toBeDefined();
    const marker = JSON.parse(
      await readFile(join(projectsHome, "myth-battle", "launcher-home.json"), "utf8")
    );
    expect(marker).toMatchObject({
      schema_version: 1,
      project_slug: "myth-battle",
      source_project_root: await realpath(projectRoot)
    });
  });

  it("does not promote when the project is already under the durable home", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-home-local-"));
    const projectsHome = join(root, "projects");
    const projectRoot = join(projectsHome, "local-job");
    const configPath = join(projectRoot, "project.yaml");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(configPath, "slug: local-job\n", "utf8");

    const result = await ensureFinalizedProjectInLauncherHome({
      configPath,
      projectSlug: "local-job",
      apply: true,
      env: { TSUGITE_PROJECTS_HOME: projectsHome }
    });

    expect(result.ok).toBe(true);
    expect(result.alreadyHome).toBe(true);
    expect(result.promoted).toBe(false);
    expect(result.destinationRoot).toBe(await realpath(projectRoot));
  });

  it("registers a pre-production worktree project onto the durable shelf via directory link", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-home-link-"));
    const projectsHome = join(root, "durable-projects");
    const projectRoot = join(root, "feature-worktree", "projects", "early-draft");
    const configPath = join(projectRoot, "project.yaml");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(configPath, "slug: early-draft\nrun_id: early-draft-r1\n", "utf8");
    await writeFile(join(projectRoot, "manifest.json"), "{}\n", "utf8");

    const first = await ensureProjectVisibleOnLauncherShelf({
      configPath,
      projectSlug: "early-draft",
      env: { TSUGITE_PROJECTS_HOME: projectsHome }
    });
    expect(first.ok).toBe(true);
    expect(first.alreadyHome).toBe(false);
    expect(first.linked).toBe(true);
    await expect(stat(join(projectsHome, "early-draft", "project.yaml"))).resolves.toBeDefined();
    expect(await readFile(join(projectsHome, "early-draft", "project.yaml"), "utf8"))
      .toContain("slug: early-draft");

    const second = await ensureProjectVisibleOnLauncherShelf({
      configPath,
      projectSlug: "early-draft",
      env: { TSUGITE_PROJECTS_HOME: projectsHome }
    });
    expect(second.ok).toBe(true);
    expect(second.linked).toBe(false);
  });

  it("treats an already-registered durable directory with the same slug as visible without re-link", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-home-existing-"));
    const projectsHome = join(root, "durable-projects");
    const projectRoot = join(root, "feature-worktree", "projects", "draft-a");
    const existing = join(projectsHome, "draft-a");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(existing, { recursive: true });
    await writeFile(join(projectRoot, "project.yaml"), "slug: draft-a\n", "utf8");
    await writeFile(join(existing, "project.yaml"), "slug: draft-a\n", "utf8");

    const result = await ensureProjectVisibleOnLauncherShelf({
      configPath: join(projectRoot, "project.yaml"),
      projectSlug: "draft-a",
      env: { TSUGITE_PROJECTS_HOME: projectsHome }
    });
    expect(result.ok).toBe(true);
    expect(result.linked).toBe(false);
    expect(result.launcherProjectRoot).toBe(existing);
  });

  it("refuses to overwrite a durable shelf directory that belongs to another slug", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-home-conflict-"));
    const projectsHome = join(root, "durable-projects");
    const projectRoot = join(root, "feature-worktree", "projects", "draft-b");
    const existing = join(projectsHome, "draft-b");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(existing, { recursive: true });
    await writeFile(join(projectRoot, "project.yaml"), "slug: draft-b\n", "utf8");
    await writeFile(join(existing, "project.yaml"), "slug: other-project\n", "utf8");

    const result = await ensureProjectVisibleOnLauncherShelf({
      configPath: join(projectRoot, "project.yaml"),
      projectSlug: "draft-b",
      env: { TSUGITE_PROJECTS_HOME: projectsHome }
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("launcher_home.register_failed");
  });

  it("uses the project folder name when the slug is not path-safe", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-home-slug-"));
    const projectsHome = join(root, "durable-projects");
    const projectRoot = join(root, "feature-worktree", "projects", "weird folder");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, "project.yaml"), "slug: 変な slug\n", "utf8");

    const plan = await planLauncherHome(join(projectRoot, "project.yaml"), "変な slug", {
      env: { TSUGITE_PROJECTS_HOME: projectsHome }
    });
    expect(plan.destinationRoot).toBe(join(projectsHome, "weird folder"));
  });

  it("refuses finalize promotion when the durable destination belongs to another slug", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-home-promote-conflict-"));
    const projectsHome = join(root, "durable-projects");
    const projectRoot = join(root, "feature-worktree", "projects", "myth");
    const existing = join(projectsHome, "myth");
    await mkdir(join(projectRoot, "dist", "myth-r1"), { recursive: true });
    await mkdir(existing, { recursive: true });
    await writeFile(join(projectRoot, "project.yaml"), "slug: myth\n", "utf8");
    await writeFile(join(projectRoot, "dist", "myth-r1", "final.mp4"), "final", "utf8");
    await writeFile(join(existing, "project.yaml"), "slug: other\n", "utf8");

    const result = await ensureFinalizedProjectInLauncherHome({
      configPath: join(projectRoot, "project.yaml"),
      projectSlug: "myth",
      apply: true,
      env: { TSUGITE_PROJECTS_HOME: projectsHome }
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("finalize.launcher_home_promote_failed");
  });

  it("refuses shelf registration when the destination path is an ordinary file", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-home-file-"));
    const projectsHome = join(root, "durable-projects");
    const projectRoot = join(root, "feature-worktree", "projects", "draft-c");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(projectsHome, { recursive: true });
    await writeFile(join(projectRoot, "project.yaml"), "slug: draft-c\n", "utf8");
    await writeFile(join(projectsHome, "draft-c"), "not-a-directory", "utf8");

    const result = await ensureProjectVisibleOnLauncherShelf({
      configPath: join(projectRoot, "project.yaml"),
      projectSlug: "draft-c",
      env: { TSUGITE_PROJECTS_HOME: projectsHome }
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("launcher_home.register_failed");
  });

  it("replaces a dangling shelf link and promotes through an existing shelf symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-home-dangling-"));
    const projectsHome = join(root, "durable-projects");
    const gone = join(root, "gone-worktree", "projects", "myth");
    const projectRoot = join(root, "feature-worktree", "projects", "myth");
    const shelf = join(projectsHome, "myth");
    await mkdir(gone, { recursive: true });
    await mkdir(join(projectRoot, "dist", "myth-r1"), { recursive: true });
    await mkdir(projectsHome, { recursive: true });
    await writeFile(join(projectRoot, "project.yaml"), "slug: myth\n", "utf8");
    await writeFile(join(projectRoot, "dist", "myth-r1", "final.mp4"), "final", "utf8");
    await symlink(gone, shelf, "dir");
    await rm(gone, { recursive: true, force: true });

    const linked = await ensureProjectVisibleOnLauncherShelf({
      configPath: join(projectRoot, "project.yaml"),
      projectSlug: "myth",
      env: { TSUGITE_PROJECTS_HOME: projectsHome }
    });
    expect(linked.ok).toBe(true);
    expect(linked.linked).toBe(true);

    // Config path via shelf symlink must still promote a real durable copy.
    const promoted = await ensureFinalizedProjectInLauncherHome({
      configPath: join(shelf, "project.yaml"),
      projectSlug: "myth",
      apply: true,
      env: { TSUGITE_PROJECTS_HOME: projectsHome },
      now: "2026-07-25T12:00:00.000Z"
    });
    expect(promoted.ok).toBe(true);
    expect(promoted.promoted).toBe(true);
    const { lstat } = await import("node:fs/promises");
    expect((await lstat(shelf)).isSymbolicLink()).toBe(false);
    await expect(stat(join(shelf, "dist", "myth-r1", "final.mp4"))).resolves.toBeDefined();
    await expect(stat(join(shelf, "launcher-home.json"))).resolves.toBeDefined();
  });
});
