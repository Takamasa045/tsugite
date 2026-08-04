import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import {
  auditAndCleanupWorktrees,
  summarizeWorktreeCleanupWarning,
  type GitCommandRunner
} from "../src/worktree/lifecycle.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("worktree lifecycle core", () => {
  it("previews registered worktrees with stable fields and refuses unsafe apply targets", async () => {
    const fixture = await createGitFixture();
    const preview = await auditAndCleanupWorktrees({ cwd: fixture.mainRoot });

    expect(preview.ok).toBe(true);
    expect(preview.applied).toBe(false);
    expect(preview.removed).toEqual([]);
    expect(preview.main_branch).toBe("main");
    expect(preview.worktrees.map((entry) => entry.path).sort()).toEqual(
      (await Promise.all([
        fixture.mainRoot,
        fixture.cleanMerged,
        fixture.dirty,
        fixture.unmerged,
        fixture.locked
      ].map((path) => canon(path)))).sort()
    );

    const primary = preview.worktrees.find((entry) => entry.is_primary);
    const clean = await byPath(preview.worktrees, fixture.cleanMerged);
    const dirty = await byPath(preview.worktrees, fixture.dirty);
    const unmerged = await byPath(preview.worktrees, fixture.unmerged);
    const locked = await byPath(preview.worktrees, fixture.locked);

    expect(primary).toMatchObject({
      is_primary: true,
      is_current: true,
      branch: "main",
      removable: false
    });
    expect(primary?.block_reasons).toEqual(expect.arrayContaining(["primary", "current"]));

    expect(clean).toMatchObject({
      is_primary: false,
      branch: "codex/clean-merged",
      merged_into_main: true,
      dirty_tracked: false,
      dirty_untracked: false,
      locked: false,
      missing: false,
      removable: true,
      block_reasons: []
    });
    expect(clean.ignored_other.some((path) => path === "node_modules/" || path.startsWith("node_modules/"))).toBe(true);

    expect(dirty).toMatchObject({
      dirty_tracked: true,
      dirty_untracked: true,
      removable: false
    });
    expect(dirty.block_reasons).toEqual(
      expect.arrayContaining(["dirty_tracked", "dirty_untracked"])
    );
    expect(dirty.status_entries.some((entry) => entry.kind === "tracked")).toBe(true);
    expect(dirty.status_entries.some((entry) => entry.kind === "untracked")).toBe(true);

    expect(unmerged).toMatchObject({
      merged_into_main: false,
      removable: false
    });
    expect(unmerged.block_reasons).toContain("unmerged");

    expect(locked).toMatchObject({
      locked: true,
      removable: false
    });
    expect(locked.block_reasons).toContain("locked");
  });

  it("removes only clean merged worktrees without force, branch delete, or protected content", async () => {
    const fixture = await createGitFixture();
    const outside = join(fixture.base, "outside-target");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "keep\n");
    const calls: string[][] = [];
    const runner: GitCommandRunner = async (args, options) => {
      calls.push([...args]);
      return defaultGitRunner(args, options);
    };

    const applied = await auditAndCleanupWorktrees({
      cwd: fixture.mainRoot,
      apply: true,
      paths: [fixture.cleanMerged],
      runGit: runner
    });

    expect(applied.ok).toBe(true);
    expect(applied.applied).toBe(true);
    expect(applied.removed).toHaveLength(1);
    expect(samePath(applied.removed[0]!, fixture.cleanMerged)).toBe(true);
    await expect(access(fixture.cleanMerged)).rejects.toThrow();
    await expect(access(join(outside, "secret.txt"))).resolves.toBeUndefined();

    const removeCalls = calls.filter((args) => args[0] === "worktree" && args[1] === "remove");
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]?.[0]).toBe("worktree");
    expect(removeCalls[0]?.[1]).toBe("remove");
    expect(samePath(removeCalls[0]?.[2] ?? "", fixture.cleanMerged)).toBe(true);
    expect(removeCalls[0]).not.toContain("--force");
    expect(calls.some((args) => args[0] === "branch" && args.includes("-d"))).toBe(false);
    expect(calls.some((args) => args[0] === "stash")).toBe(false);
    expect(calls.some((args) => args[0] === "clean")).toBe(false);
    expect(calls.some((args) => args[0] === "reset")).toBe(false);
    expect(calls.some((args) => args[0] === "rebase")).toBe(false);

    const remaining = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: fixture.mainRoot,
      encoding: "utf8"
    });
    expect(remaining.stdout).not.toContain(await canon(fixture.cleanMerged));
    expect(remaining.stdout).toContain(await canon(fixture.dirty));

    const branches = spawnSync("git", ["branch", "--list", "codex/clean-merged"], {
      cwd: fixture.mainRoot,
      encoding: "utf8"
    });
    expect(branches.stdout).toContain("codex/clean-merged");
  });

  it("blocks protected ignored content and still surfaces dependency/build ignored paths", async () => {
    const fixture = await createGitFixture();
    await mkdir(join(fixture.cleanMerged, "projects", "demo"), { recursive: true });
    await writeFile(join(fixture.cleanMerged, "projects", "demo", "project.yaml"), "slug: demo\n");
    await mkdir(join(fixture.cleanMerged, "node_modules"), { recursive: true });
    await writeFile(join(fixture.cleanMerged, "node_modules", "pkg.js"), "module.exports = {}\n");
    await mkdir(join(fixture.cleanMerged, "build"), { recursive: true });
    await writeFile(join(fixture.cleanMerged, "build", "out.js"), "console.log(1)\n");
    await writeFile(join(fixture.cleanMerged, ".env"), "SECRET=1\n");

    const preview = await auditAndCleanupWorktrees({ cwd: fixture.mainRoot });
    const clean = await byPath(preview.worktrees, fixture.cleanMerged);

    expect(clean.removable).toBe(false);
    expect(clean.block_reasons).toContain("protected_content");
    expect(clean.ignored_protected).toEqual(expect.arrayContaining([".env"]));
    expect(
      clean.ignored_protected.some(
        (path) => path === "projects" || path === "projects/" || path.startsWith("projects/")
      )
    ).toBe(true);
    expect(clean.ignored_other.some((path) => path === "node_modules/" || path.startsWith("node_modules/"))).toBe(true);
    expect(clean.ignored_other.some((path) => path === "build/" || path.startsWith("build/"))).toBe(true);

    const applied = await auditAndCleanupWorktrees({
      cwd: fixture.mainRoot,
      apply: true,
      paths: [fixture.cleanMerged]
    });
    expect(applied.ok).toBe(false);
    expect(applied.applied).toBe(false);
    expect(applied.issues.some((issue) => issue.code === "worktrees.not_removable")).toBe(true);
    await expect(access(fixture.cleanMerged)).resolves.toBeUndefined();
  });

  it("reports ignored dependency roots without enumerating every nested file", async () => {
    const fixture = await createGitFixture();
    const nestedPkg = join(fixture.cleanMerged, "node_modules", "huge-pkg", "dist");
    await mkdir(nestedPkg, { recursive: true });
    const nestedFileCount = 250;
    for (let i = 0; i < nestedFileCount; i += 1) {
      await writeFile(join(nestedPkg, `file-${i}.js`), `export const n = ${i};\n`);
    }
    await mkdir(join(fixture.cleanMerged, "build", "chunks"), { recursive: true });
    for (let i = 0; i < 40; i += 1) {
      await writeFile(join(fixture.cleanMerged, "build", "chunks", `chunk-${i}.js`), `// ${i}\n`);
    }
    await mkdir(join(fixture.cleanMerged, "projects", "demo"), { recursive: true });
    await writeFile(join(fixture.cleanMerged, "projects", "demo", "project.yaml"), "slug: demo\n");
    await writeFile(join(fixture.cleanMerged, ".env"), "SECRET=keep\n");

    const preview = await auditAndCleanupWorktrees({ cwd: fixture.mainRoot });
    const clean = await byPath(preview.worktrees, fixture.cleanMerged);

    expect(
      clean.ignored_other.some(
        (path) => path === "node_modules" || path === "node_modules/" || path.startsWith("node_modules/")
      )
    ).toBe(true);
    expect(
      clean.ignored_other.some(
        (path) => path === "build" || path === "build/" || path.startsWith("build/")
      )
    ).toBe(true);

    // Directory-level reporting only: never list every nested ignored file.
    expect(clean.ignored_other.some((path) => /node_modules\/.+\/file-\d+\.js$/.test(path))).toBe(false);
    expect(clean.status_entries.some((entry) => /node_modules\/.+\/file-\d+\.js$/.test(entry.path))).toBe(false);
    expect(clean.ignored_other.some((path) => /build\/chunks\/chunk-\d+\.js$/.test(path))).toBe(false);
    expect(clean.status_entries.some((entry) => /build\/chunks\/chunk-\d+\.js$/.test(entry.path))).toBe(false);

    // Output stays bounded even when ignored trees contain hundreds of files.
    expect(clean.ignored_other.length).toBeLessThan(40);
    expect(clean.status_entries.length).toBeLessThan(80);
    expect(clean.ignored_other.length).toBeLessThan(nestedFileCount);
    expect(clean.status_entries.length).toBeLessThan(nestedFileCount);

    // Protected ignored detection must still block removal.
    expect(clean.removable).toBe(false);
    expect(clean.block_reasons).toContain("protected_content");
    expect(clean.ignored_protected).toEqual(expect.arrayContaining([".env"]));
    expect(
      clean.ignored_protected.some(
        (path) => path === "projects" || path === "projects/" || path.startsWith("projects/")
      )
    ).toBe(true);
  });

  it("refuses primary/current, missing, unregistered, and locked targets on apply", async () => {
    const fixture = await createGitFixture();

    const primary = await auditAndCleanupWorktrees({
      cwd: fixture.mainRoot,
      apply: true,
      paths: [fixture.mainRoot]
    });
    expect(primary.ok).toBe(false);
    expect(primary.issues[0]?.code).toBe("worktrees.not_removable");

    const locked = await auditAndCleanupWorktrees({
      cwd: fixture.mainRoot,
      apply: true,
      paths: [fixture.locked]
    });
    expect(locked.ok).toBe(false);
    expect(locked.issues.some((issue) => issue.message.includes("locked"))).toBe(true);

    const missingPath = join(fixture.base, "already-gone");
    const missing = await auditAndCleanupWorktrees({
      cwd: fixture.mainRoot,
      apply: true,
      paths: [missingPath]
    });
    expect(missing.ok).toBe(false);
    expect(missing.issues.some((issue) => issue.code === "worktrees.target_missing")).toBe(true);

    const outside = await mkdtemp(join(tmpdir(), "tsugite-wt-outside-"));
    temporaryRoots.push(outside);
    const unregistered = await auditAndCleanupWorktrees({
      cwd: fixture.mainRoot,
      apply: true,
      paths: [outside]
    });
    expect(unregistered.ok).toBe(false);
    expect(unregistered.issues.some((issue) => issue.code === "worktrees.not_registered")).toBe(true);
  });

  it("never issues git worktree remove --force even when a runner is injected", async () => {
    const fixture = await createGitFixture();
    const removeArgs: string[][] = [];
    const runner: GitCommandRunner = async (args, options) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        removeArgs.push([...args]);
        expect(args).not.toContain("--force");
        expect(args).not.toContain("-f");
      }
      return defaultGitRunner(args, options);
    };

    const applied = await auditAndCleanupWorktrees({
      cwd: fixture.mainRoot,
      apply: true,
      paths: [fixture.cleanMerged],
      runGit: runner
    });
    expect(applied.ok).toBe(true);
    expect(removeArgs).toHaveLength(1);
    expect(removeArgs[0]?.[0]).toBe("worktree");
    expect(removeArgs[0]?.[1]).toBe("remove");
    expect(samePath(removeArgs[0]?.[2] ?? "", fixture.cleanMerged)).toBe(true);
    expect(removeArgs[0]).not.toContain("--force");
  });

  it("matches macOS /var and /private/var forms for the same registered worktree", async () => {
    const fixture = await createGitFixture();
    const preview = await auditAndCleanupWorktrees({ cwd: fixture.mainRoot });
    const clean = await byPath(preview.worktrees, fixture.cleanMerged);
    const reported = clean.path;
    const alternate = alternateMacOsPathForm(reported);

    expect(samePath(reported, alternate)).toBe(true);
    expect(samePath(reported, fixture.cleanMerged)).toBe(true);

    // Apply must accept whichever form the caller provides (tmpdir vs realpath).
    const applied = await auditAndCleanupWorktrees({
      cwd: fixture.mainRoot,
      apply: true,
      paths: [alternate]
    });
    expect(applied.ok).toBe(true);
    expect(applied.applied).toBe(true);
    expect(applied.removed).toHaveLength(1);
    expect(samePath(applied.removed[0]!, fixture.cleanMerged)).toBe(true);
    await expect(access(fixture.cleanMerged)).rejects.toThrow();
  });

  it("keeps clean merged removable when only tracked projects scaffold files are present", async () => {
    const fixture = await createGitFixture({ trackedProjectsScaffold: true });
    const preview = await auditAndCleanupWorktrees({ cwd: fixture.mainRoot });
    const clean = await byPath(preview.worktrees, fixture.cleanMerged);

    await expect(access(join(fixture.cleanMerged, "projects", ".gitkeep"))).resolves.toBeUndefined();
    await expect(access(join(fixture.cleanMerged, "projects", "README.md"))).resolves.toBeUndefined();

    expect(clean.merged_into_main).toBe(true);
    expect(clean.dirty_tracked).toBe(false);
    expect(clean.dirty_untracked).toBe(false);
    expect(clean.removable).toBe(true);
    expect(clean.block_reasons).toEqual([]);
    expect(clean.ignored_protected).toEqual([]);
    expect(clean.ignored_protected).not.toEqual(
      expect.arrayContaining(["projects/.gitkeep", "projects/README.md"])
    );

    const removeCalls: string[][] = [];
    const runner: GitCommandRunner = async (args, options) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        removeCalls.push([...args]);
      }
      return defaultGitRunner(args, options);
    };
    const applied = await auditAndCleanupWorktrees({
      cwd: fixture.mainRoot,
      apply: true,
      paths: [fixture.cleanMerged],
      runGit: runner
    });
    expect(applied.ok).toBe(true);
    expect(applied.applied).toBe(true);
    expect(removeCalls).toHaveLength(1);
    await expect(access(fixture.cleanMerged)).rejects.toThrow();
  });

  it("revalidates each target immediately before remove and skips remove when state changes", async () => {
    const fixture = await createGitFixture();
    let statusHitsOnClean = 0;
    const removeCalls: string[][] = [];

    const runner: GitCommandRunner = async (args, options) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        removeCalls.push([...args]);
        return defaultGitRunner(args, options);
      }

      const result = await defaultGitRunner(args, options);
      if (
        args[0] === "status"
        && samePath(options.cwd, fixture.cleanMerged)
      ) {
        statusHitsOnClean += 1;
        // After the initial audit status pass, plant protected ignored content
        // so a TOCTOU revalidation must observe the new state and refuse remove.
        if (statusHitsOnClean === 1) {
          await mkdir(join(fixture.cleanMerged, "projects", "demo"), { recursive: true });
          await writeFile(
            join(fixture.cleanMerged, "projects", "demo", "project.yaml"),
            "slug: planted-after-audit\n"
          );
        }
      }
      return result;
    };

    const applied = await auditAndCleanupWorktrees({
      cwd: fixture.mainRoot,
      apply: true,
      paths: [fixture.cleanMerged],
      runGit: runner
    });

    expect(statusHitsOnClean).toBeGreaterThanOrEqual(2);
    expect(removeCalls).toEqual([]);
    expect(applied.ok).toBe(false);
    expect(applied.applied).toBe(false);
    expect(applied.removed).toEqual([]);
    expect(
      applied.issues.some((issue) =>
        issue.code === "worktrees.target_changed"
        || issue.code === "worktrees.not_removable"
      )
    ).toBe(true);
    await expect(access(fixture.cleanMerged)).resolves.toBeUndefined();
    await expect(
      access(join(fixture.cleanMerged, "projects", "demo", "project.yaml"))
    ).resolves.toBeUndefined();
  });

  it("returns revalidated worktrees on apply failure so cleanup warning reflects current state", async () => {
    const fixture = await createGitFixture();
    const secondClean = join(fixture.base, "clean-merged-2");
    const thirdClean = join(fixture.base, "clean-merged-3");
    runGit(fixture.mainRoot, ["worktree", "add", "-b", "codex/clean-merged-2", secondClean]);
    runGit(fixture.mainRoot, ["merge", "--ff-only", "codex/clean-merged-2"]);
    runGit(fixture.mainRoot, ["worktree", "add", "-b", "codex/clean-merged-3", thirdClean]);
    runGit(fixture.mainRoot, ["merge", "--ff-only", "codex/clean-merged-3"]);

    const preview = await auditAndCleanupWorktrees({ cwd: fixture.mainRoot });
    const initialWarning = summarizeWorktreeCleanupWarning(preview.worktrees);
    expect(initialWarning).toMatchObject({
      active: true,
      threshold: 3,
      removable_count: 3
    });

    let statusHitsOnClean = 0;
    const removeCalls: string[][] = [];
    const runner: GitCommandRunner = async (args, options) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        removeCalls.push([...args]);
        return defaultGitRunner(args, options);
      }
      const result = await defaultGitRunner(args, options);
      if (args[0] === "status" && samePath(options.cwd, fixture.cleanMerged)) {
        statusHitsOnClean += 1;
        // After the initial audit, dirt the target so revalidation refuses remove
        // and the returned worktree list must reflect only 2 remaining removable.
        if (statusHitsOnClean === 1) {
          await writeFile(join(fixture.cleanMerged, "late-dirty.txt"), "planted after audit\n");
        }
      }
      return result;
    };

    const applied = await auditAndCleanupWorktrees({
      cwd: fixture.mainRoot,
      apply: true,
      paths: [fixture.cleanMerged],
      runGit: runner
    });

    expect(statusHitsOnClean).toBeGreaterThanOrEqual(2);
    expect(removeCalls).toEqual([]);
    expect(applied.ok).toBe(false);
    expect(applied.applied).toBe(false);
    expect(applied.removed).toEqual([]);
    expect(
      applied.issues.some((issue) =>
        issue.code === "worktrees.target_changed"
        || issue.code === "worktrees.not_removable"
      )
    ).toBe(true);

    const dirtyTarget = await byPath(applied.worktrees, fixture.cleanMerged);
    expect(dirtyTarget.removable).toBe(false);
    expect(dirtyTarget.block_reasons).toEqual(
      expect.arrayContaining(["dirty_untracked"])
    );

    const warning = summarizeWorktreeCleanupWarning(applied.worktrees);
    expect(warning).toMatchObject({
      active: false,
      threshold: 3,
      removable_count: 2
    });
    expect(warning.removable_paths).toHaveLength(2);
    expect(
      warning.removable_paths.some((path) => samePath(path, fixture.cleanMerged))
    ).toBe(false);
    await expect(access(fixture.cleanMerged)).resolves.toBeUndefined();
  });

  it("revalidates before every remove when multiple targets are requested", async () => {
    const fixture = await createGitFixture();
    const secondClean = join(fixture.base, "clean-merged-2");
    runGit(fixture.mainRoot, ["worktree", "add", "-b", "codex/clean-merged-2", secondClean]);
    runGit(fixture.mainRoot, ["merge", "--ff-only", "codex/clean-merged-2"]);

    let statusHitsOnFirst = 0;
    const removeCalls: string[][] = [];
    const runner: GitCommandRunner = async (args, options) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        removeCalls.push([...args]);
        return defaultGitRunner(args, options);
      }
      const result = await defaultGitRunner(args, options);
      if (args[0] === "status" && samePath(options.cwd, fixture.cleanMerged)) {
        statusHitsOnFirst += 1;
        if (statusHitsOnFirst === 1) {
          await writeFile(join(fixture.cleanMerged, "late-untracked.txt"), "planted\n");
        }
      }
      return result;
    };

    const applied = await auditAndCleanupWorktrees({
      cwd: fixture.mainRoot,
      apply: true,
      paths: [fixture.cleanMerged, secondClean],
      runGit: runner
    });

    expect(removeCalls).toEqual([]);
    expect(applied.ok).toBe(false);
    expect(applied.removed).toEqual([]);
    expect(
      applied.issues.some((issue) =>
        issue.code === "worktrees.target_changed"
        || issue.code === "worktrees.not_removable"
      )
    ).toBe(true);
    await expect(access(fixture.cleanMerged)).resolves.toBeUndefined();
    await expect(access(secondClean)).resolves.toBeUndefined();
  });

  it("resolves relative --path against options.cwd and dedupes duplicate paths before remove", async () => {
    const fixture = await createGitFixture();
    const relativeClean = join("..", "clean-merged");
    const removeCalls: string[][] = [];
    const runner: GitCommandRunner = async (args, options) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        removeCalls.push([...args]);
      }
      return defaultGitRunner(args, options);
    };

    const applied = await auditAndCleanupWorktrees({
      cwd: fixture.mainRoot,
      apply: true,
      paths: [relativeClean, fixture.cleanMerged, alternateMacOsPathForm(fixture.cleanMerged)],
      runGit: runner
    });

    expect(applied.ok).toBe(true);
    expect(applied.applied).toBe(true);
    expect(applied.removed).toHaveLength(1);
    expect(removeCalls).toHaveLength(1);
    expect(samePath(applied.removed[0]!, fixture.cleanMerged)).toBe(true);
    await expect(access(fixture.cleanMerged)).rejects.toThrow();
  });
});

describe("pipeline worktrees command", () => {
  it("defaults to preview JSON and requires coordinator + path for apply", async () => {
    const fixture = await createGitFixture();

    const preview = await capture(["worktrees", "--json"], fixture.mainRoot);
    expect(preview.status).toBe(0);
    const previewJson = JSON.parse(preview.stdout);
    expect(previewJson).toMatchObject({
      ok: true,
      command: "worktrees",
      applied: false,
      worktree_warning: {
        active: false,
        threshold: 3,
        removable_count: 1,
        removable_paths: [expect.any(String)]
      },
      warnings: []
    });
    expect(Array.isArray(previewJson.worktrees)).toBe(true);
    expect(previewJson.worktrees.length).toBeGreaterThanOrEqual(2);

    const missingActor = await capture(
      ["worktrees", "--apply", "--path", fixture.cleanMerged, "--json"],
      fixture.mainRoot
    );
    expect(missingActor.status).toBe(1);
    expect(JSON.parse(missingActor.stderr).issues[0]?.code).toBe("cli.coordinator_required");

    const missingPath = await capture(
      ["worktrees", "--apply", "--actor", "coordinator", "--json"],
      fixture.mainRoot
    );
    expect(missingPath.status).toBe(1);
    expect(JSON.parse(missingPath.stderr).issues[0]?.code).toBe("worktrees.path_required");

    const applied = await capture(
      [
        "worktrees",
        "--apply",
        "--actor", "coordinator",
        "--path", fixture.cleanMerged,
        "--json"
      ],
      fixture.mainRoot
    );
    expect(applied.status).toBe(0);
    const appliedJson = JSON.parse(applied.stdout);
    expect(appliedJson).toMatchObject({
      ok: true,
      command: "worktrees",
      applied: true
    });
    expect(appliedJson.removed).toHaveLength(1);
    expect(samePath(appliedJson.removed[0], fixture.cleanMerged)).toBe(true);
    await expect(access(fixture.cleanMerged)).rejects.toThrow();
  });

  it("warns only when at least three worktrees are safely removable", async () => {
    const fixture = await createGitFixture();
    const secondClean = join(fixture.base, "clean-merged-2");
    const thirdClean = join(fixture.base, "clean-merged-3");
    runGit(fixture.mainRoot, ["worktree", "add", "-b", "codex/cleanup-alert-2", secondClean]);

    const belowThreshold = await capture(["worktrees", "--json"], fixture.mainRoot);
    expect(belowThreshold.status).toBe(0);
    expect(JSON.parse(belowThreshold.stdout)).toMatchObject({
      warnings: [],
      worktree_warning: {
        active: false,
        threshold: 3,
        removable_count: 2
      }
    });

    runGit(fixture.mainRoot, ["worktree", "add", "-b", "codex/cleanup-alert-3", thirdClean]);

    const preview = await capture(["worktrees", "--json"], fixture.mainRoot);
    expect(preview.status).toBe(0);
    const payload = JSON.parse(preview.stdout);
    expect(payload.worktree_warning).toMatchObject({
      active: true,
      threshold: 3,
      removable_count: 3
    });
    expect(payload.worktree_warning.removable_paths).toHaveLength(3);
    expect(payload.warnings).toEqual([{
      code: "worktrees.cleanup_candidates_accumulated",
      message: expect.stringContaining("3")
    }]);
  });

  it("rejects unknown options for worktrees", async () => {
    const fixture = await createGitFixture();
    const result = await capture(
      ["worktrees", "--config", "project.yaml", "--json"],
      fixture.mainRoot
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).issues[0]?.code).toBe("cli.option_unsupported");
  });
});

describe(".claude/worktrees ignore contract", () => {
  it("keeps .claude/worktrees out of untracked main status via .gitignore", async () => {
    const gitignore = await readFile(resolve(".gitignore"), "utf8");
    expect(gitignore).toMatch(/(?:^|\n)\.claude\/worktrees\/?(?:\n|$)/);

    const fixture = await createGitFixture({ includeRepoGitignore: true });
    const nested = join(fixture.mainRoot, ".claude", "worktrees", "agent-task");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "notes.txt"), "local agent worktree path\n");

    const check = spawnSync(
      "git",
      ["check-ignore", "-v", ".claude/worktrees/agent-task/notes.txt"],
      { cwd: fixture.mainRoot, encoding: "utf8" }
    );
    expect(check.status).toBe(0);
    expect(check.stdout).toContain(".claude/worktrees");

    const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: fixture.mainRoot,
      encoding: "utf8"
    });
    expect(status.stdout).not.toContain(".claude/worktrees");
  });
});

/**
 * Mirror lifecycle path stability: macOS often reports `/private/var` while
 * Node tmpdir()/resolve keep the logical `/var` form. Compare on the logical form.
 */
function normalizePath(path: string): string {
  const resolved = resolve(path);
  if (process.platform === "darwin" && resolved.startsWith("/private/var/")) {
    return resolved.slice("/private".length);
  }
  if (process.platform === "darwin" && resolved.startsWith("/private/tmp/")) {
    return resolved.slice("/private".length);
  }
  if (process.platform === "darwin" && resolved === "/private/tmp") {
    return "/tmp";
  }
  return resolved;
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

/** Prefer the opposite of the common macOS logical/realpath form when both exist. */
function alternateMacOsPathForm(path: string): string {
  const resolved = resolve(path);
  if (process.platform === "darwin" && resolved.startsWith("/private/var/")) {
    return resolved.slice("/private".length);
  }
  if (process.platform === "darwin" && resolved.startsWith("/var/")) {
    return `/private${resolved}`;
  }
  if (process.platform === "darwin" && resolved.startsWith("/private/tmp/")) {
    return resolved.slice("/private".length);
  }
  if (process.platform === "darwin" && resolved.startsWith("/tmp/")) {
    return `/private${resolved}`;
  }
  return resolved;
}

async function byPath<T extends { path: string }>(entries: readonly T[], path: string): Promise<T> {
  const resolved = await canon(path);
  const found = entries.find((entry) => entry.path === resolved || samePath(entry.path, path));
  if (!found) throw new Error(`missing worktree report for ${path}`);
  return found;
}

async function canon(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return normalizePath(await realpath(absolute));
  } catch {
    return normalizePath(absolute);
  }
}

async function capture(args: string[], cwd: string) {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    const status = await main(args);
    return {
      status,
      stdout: log.mock.calls.map((call) => String(call[0])).join("\n"),
      stderr: error.mock.calls.map((call) => String(call[0])).join("\n")
    };
  } finally {
    process.chdir(previousCwd);
    log.mockRestore();
    error.mockRestore();
  }
}

async function defaultGitRunner(args: readonly string[], options: { cwd: string }) {
  const result = spawnSync("git", [...args], {
    cwd: options.cwd,
    encoding: "utf8"
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1
  };
}

async function createGitFixture(
  options: {
    includeRepoGitignore?: boolean;
    trackedProjectsScaffold?: boolean;
  } = {}
) {
  const base = await mkdtemp(join(tmpdir(), "tsugite-worktree-lifecycle-"));
  temporaryRoots.push(base);
  const mainRoot = join(base, "main");
  await mkdir(mainRoot, { recursive: true });

  runGit(mainRoot, ["init", "-b", "main"]);
  runGit(mainRoot, ["config", "user.email", "worktree@example.com"]);
  runGit(mainRoot, ["config", "user.name", "Worktree Tester"]);
  await writeFile(join(mainRoot, "README.md"), "# fixture\n");
  await writeFile(
    join(mainRoot, ".gitignore"),
    [
      "node_modules/",
      "build/",
      options.trackedProjectsScaffold ? "projects/*" : "projects/",
      options.trackedProjectsScaffold ? "!projects/.gitkeep" : "",
      options.trackedProjectsScaffold ? "!projects/README.md" : "",
      "media/",
      "output/",
      "tmp/",
      "templates/",
      ".env",
      ".env.*",
      options.includeRepoGitignore ? ".claude/worktrees/" : "",
      ""
    ].filter(Boolean).join("\n")
  );
  runGit(mainRoot, ["add", "README.md", ".gitignore"]);
  runGit(mainRoot, ["commit", "-m", "init"]);

  if (options.trackedProjectsScaffold) {
    await mkdir(join(mainRoot, "projects"), { recursive: true });
    await writeFile(join(mainRoot, "projects", ".gitkeep"), "");
    await writeFile(join(mainRoot, "projects", "README.md"), "# durable projects home\n");
    runGit(mainRoot, ["add", "projects/.gitkeep", "projects/README.md"]);
    runGit(mainRoot, ["commit", "-m", "tracked projects scaffold"]);
  }

  const cleanMerged = join(base, "clean-merged");
  const dirty = join(base, "dirty");
  const unmerged = join(base, "unmerged");
  const locked = join(base, "locked");

  runGit(mainRoot, ["worktree", "add", "-b", "codex/clean-merged", cleanMerged]);
  await mkdir(join(cleanMerged, "node_modules"), { recursive: true });
  await writeFile(join(cleanMerged, "node_modules", "dep.txt"), "dep\n");
  runGit(mainRoot, ["merge", "--ff-only", "codex/clean-merged"]);

  runGit(mainRoot, ["worktree", "add", "-b", "codex/dirty", dirty]);
  await writeFile(join(dirty, "README.md"), "# dirty tracked\n");
  await writeFile(join(dirty, "untracked.txt"), "untracked\n");

  runGit(mainRoot, ["worktree", "add", "-b", "codex/unmerged", unmerged]);
  await writeFile(join(unmerged, "feature.txt"), "only on feature\n");
  runGit(unmerged, ["add", "feature.txt"]);
  runGit(unmerged, ["commit", "-m", "unmerged commit"]);

  runGit(mainRoot, ["worktree", "add", "-b", "codex/locked", locked]);
  runGit(mainRoot, ["worktree", "lock", locked]);

  return { base, mainRoot, cleanMerged, dirty, unmerged, locked };
}

function runGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}
