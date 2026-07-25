import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureFinalizedProjectInLauncherHome,
  ensureProjectVisibleOnLauncherShelf,
  isWithinDirectory,
  planLauncherHome,
  resolveDurableProjectsHome
} from "../src/project/projectsHome.js";

describe("durable launcher projects home", () => {
  it("prefers TSUGITE_PROJECTS_HOME over workspace and cwd", async () => {
    const home = await resolveDurableProjectsHome({
      cwd: "/tmp/not-used",
      env: {
        TSUGITE_PROJECTS_HOME: "/var/tsugite/projects-home",
        TSUGITE_WORKSPACE_ROOT: "/var/tsugite-workspace"
      }
    });
    expect(home).toBe("/var/tsugite/projects-home");
  });

  it("uses TSUGITE_WORKSPACE_ROOT/projects when home env is unset", async () => {
    const home = await resolveDurableProjectsHome({
      cwd: "/tmp/not-used",
      env: {
        TSUGITE_WORKSPACE_ROOT: "/Users/me/workspace"
      }
    });
    expect(home).toBe("/Users/me/workspace/projects");
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
      source_project_root: projectRoot
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
    expect(result.destinationRoot).toBe(projectRoot);
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
});
