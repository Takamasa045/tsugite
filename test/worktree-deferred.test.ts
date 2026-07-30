import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main as pipelineMain } from "../src/cli.js";
import {
  deferWorktreeIntegration,
  readDeferredWorktreeQueue,
  reconcileDeferredWorktrees
} from "../src/worktree/deferred.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("deferred worktree integration", () => {
  it("reports git-unavailable outside a repository", async () => {
    const outside = await mkdtemp(join(tmpdir(), "tsugite-deferred-outside-"));
    temporaryRoots.push(outside);

    const result = await readDeferredWorktreeQueue({ cwd: outside });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("worktrees.git_unavailable");
  });

  it("reports an empty queue before any completed worktree is authorized", async () => {
    const fixture = await createFixture();

    const result = await reconcileDeferredWorktrees({
      cwd: fixture.main,
      apply: true,
      verifyCandidate: async () => {
        throw new Error("verification should not run");
      }
    });

    expect(result).toMatchObject({
      ok: true,
      applied: false,
      status: "empty",
      entries: []
    });
  });

  it("records an exact clean worktree identity once", async () => {
    const fixture = await createFixture();

    const first = await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true,
      now: "2026-07-30T14:00:00.000Z"
    });
    const second = await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true,
      now: "2026-07-30T14:01:00.000Z"
    });

    expect(first).toMatchObject({ ok: true, applied: true, queued: true });
    expect(second).toMatchObject({ ok: true, applied: false, queued: false });
    const queue = await readDeferredWorktreeQueue({ cwd: fixture.main });
    expect(queue.ok).toBe(true);
    expect(queue.entries).toHaveLength(1);
    expect(queue.entries[0]).toMatchObject({
      branch: "codex/deferred-fixture",
      head: fixture.featureHead,
      main_branch: "main",
      authorized_at: "2026-07-30T14:00:00.000Z",
      status: "pending"
    });
    expect(samePath(queue.entries[0]!.path, fixture.feature)).toBe(true);
  });

  it("does not silently replace an authorized identity after its HEAD changes", async () => {
    const fixture = await createFixture();
    await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });
    await writeFile(join(fixture.feature, "later.txt"), "later\n");
    runGit(fixture.feature, ["add", "later.txt"]);
    runGit(fixture.feature, ["commit", "-m", "later change"]);

    const result = await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });

    expect(result.ok).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.issues[0]?.code).toBe("worktrees.deferred_identity_changed");
    expect((await readDeferredWorktreeQueue({ cwd: fixture.main })).entries[0]?.head)
      .toBe(fixture.featureHead);
  });

  it("returns queue-busy instead of racing another queue writer", async () => {
    const fixture = await createFixture();
    const first = await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });
    const second = join(fixture.base, "second-feature");
    runGit(fixture.main, ["worktree", "add", "-b", "codex/deferred-lock", second]);
    await writeFile(join(second, "second.txt"), "second\n");
    runGit(second, ["add", "second.txt"]);
    runGit(second, ["commit", "-m", "second feature"]);
    await writeFile(`${first.queue_path}.lock`, "held\n");

    const result = await deferWorktreeIntegration({
      cwd: second,
      path: second,
      apply: true
    });

    expect(result.ok).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.issues[0]?.code).toBe("worktrees.deferred_queue_busy");
    expect((await readDeferredWorktreeQueue({ cwd: fixture.main })).entries).toHaveLength(1);
  });

  it("rejects a queue that has reached its bounded entry limit", async () => {
    const fixture = await createFixture();
    const first = await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });
    const entries = Array.from({ length: 128 }, (_, index) => ({
      id: `entry-${index}`,
      path: `/tmp/tsugite-deferred-${index}`,
      branch: `codex/deferred-${index}`,
      head: fixture.featureHead,
      main_branch: "main",
      authorized_at: "2026-07-30T14:00:00.000Z",
      status: "pending"
    }));
    await writeFile(
      first.queue_path,
      `${JSON.stringify({ schema_version: 1, entries })}\n`
    );

    const result = await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("worktrees.deferred_queue_full");
  });

  it("refuses to authorize a dirty worktree", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.feature, "uncommitted.txt"), "keep\n");

    const result = await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });

    expect(result.ok).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.issues[0]?.code).toBe("worktrees.deferred_target_unsafe");
    expect((await readDeferredWorktreeQueue({ cwd: fixture.main })).entries).toEqual([]);
    await expect(access(join(fixture.feature, "uncommitted.txt"))).resolves.toBeUndefined();
  });

  it("waits without mutation while main has uncommitted work", async () => {
    const fixture = await createFixture();
    await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });
    await writeFile(join(fixture.main, "busy.txt"), "other task\n");
    let verificationCalls = 0;

    const result = await reconcileDeferredWorktrees({
      cwd: fixture.main,
      apply: true,
      verifyCandidate: async () => {
        verificationCalls += 1;
        return { ok: true, checks: ["fixture"] };
      }
    });

    expect(result).toMatchObject({
      ok: true,
      applied: false,
      status: "waiting",
      waiting_reason: "main_dirty"
    });
    expect(verificationCalls).toBe(0);
    await expect(access(fixture.feature)).resolves.toBeUndefined();
    expect(runGit(fixture.main, ["rev-parse", "HEAD"])).toBe(fixture.mainHead);
    expect((await readDeferredWorktreeQueue({ cwd: fixture.main })).entries).toHaveLength(1);
  });

  it("waits when reconcile is not invoked from the primary main worktree", async () => {
    const fixture = await createFixture();
    await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });

    const result = await reconcileDeferredWorktrees({
      cwd: fixture.feature,
      apply: true,
      verifyCandidate: async () => {
        throw new Error("verification should not run");
      }
    });

    expect(result).toMatchObject({
      ok: true,
      applied: false,
      status: "waiting",
      waiting_reason: "run_from_primary_main"
    });
    expect((await readDeferredWorktreeQueue({ cwd: fixture.main })).entries).toHaveLength(1);
  });

  it("previews the oldest ready entry without changing either worktree", async () => {
    const fixture = await createFixture();
    await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });

    const result = await reconcileDeferredWorktrees({
      cwd: fixture.main,
      apply: false,
      verifyCandidate: async () => {
        throw new Error("verification should not run during preview");
      }
    });

    expect(result).toMatchObject({
      ok: true,
      applied: false,
      status: "ready",
      processed: { head: fixture.featureHead }
    });
    expect(runGit(fixture.main, ["rev-parse", "HEAD"])).toBe(fixture.mainHead);
    await expect(access(fixture.feature)).resolves.toBeUndefined();
  });

  it("tests an isolated merge, fast-forwards main, and removes the merged worktree", async () => {
    const fixture = await createFixture();
    await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });
    const featurePath = await canonical(fixture.feature);
    let candidatePath = "";

    const result = await reconcileDeferredWorktrees({
      cwd: fixture.main,
      apply: true,
      verifyCandidate: async (cwd) => {
        candidatePath = cwd;
        await expect(readFile(join(cwd, "README.md"), "utf8")).resolves.toContain("fixture");
        await expect(readFile(join(cwd, "feature.txt"), "utf8")).resolves.toBe("feature\n");
        return { ok: true, checks: ["fixture"] };
      }
    });

    expect(result).toMatchObject({
      ok: true,
      applied: true,
      status: "reconciled",
      removed: [featurePath]
    });
    expect(candidatePath).not.toBe("");
    await expect(access(fixture.feature)).rejects.toThrow();
    expect(runGit(fixture.main, ["merge-base", "--is-ancestor", fixture.featureHead, "main"], false).status)
      .toBe(0);
    expect((await readDeferredWorktreeQueue({ cwd: fixture.main })).entries).toEqual([]);
  });

  it("removes an already merged registered worktree without running verification", async () => {
    const fixture = await createFixture();
    await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });
    runGit(fixture.main, ["merge", "--ff-only", fixture.featureHead]);

    const result = await reconcileDeferredWorktrees({
      cwd: fixture.main,
      apply: true,
      verifyCandidate: async () => {
        throw new Error("verification should not run");
      }
    });

    expect(result).toMatchObject({
      ok: true,
      applied: true,
      status: "reconciled"
    });
    await expect(access(fixture.feature)).rejects.toThrow();
    expect((await readDeferredWorktreeQueue({ cwd: fixture.main })).entries).toEqual([]);
  });

  it("keeps the queue and both worktrees unchanged when the merge conflicts", async () => {
    const fixture = await createFixture({ conflicting: true });
    await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });
    const mainBefore = runGit(fixture.main, ["rev-parse", "HEAD"]);

    const result = await reconcileDeferredWorktrees({
      cwd: fixture.main,
      apply: true,
      verifyCandidate: async () => ({ ok: true, checks: ["fixture"] })
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.issues.some((issue) => issue.code === "worktrees.deferred_merge_conflict")).toBe(true);
    expect(runGit(fixture.main, ["rev-parse", "HEAD"])).toBe(mainBefore);
    await expect(access(fixture.feature)).resolves.toBeUndefined();
    expect((await readDeferredWorktreeQueue({ cwd: fixture.main })).entries).toHaveLength(1);
  });

  it("keeps main and the queued worktree when isolated verification fails", async () => {
    const fixture = await createFixture();
    await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });
    const mainBefore = runGit(fixture.main, ["rev-parse", "HEAD"]);

    const result = await reconcileDeferredWorktrees({
      cwd: fixture.main,
      apply: true,
      verifyCandidate: async () => ({
        ok: false,
        checks: ["fixture"],
        message: "fixture verification failed"
      })
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.issues.some((issue) => issue.code === "worktrees.deferred_verification_failed"))
      .toBe(true);
    expect(runGit(fixture.main, ["rev-parse", "HEAD"])).toBe(mainBefore);
    await expect(access(fixture.feature)).resolves.toBeUndefined();
    expect((await readDeferredWorktreeQueue({ cwd: fixture.main })).entries).toHaveLength(1);
    expect(runGit(fixture.main, ["worktree", "list", "--porcelain"])).not.toContain(
      "tsugite-reconcile-"
    );
  });

  it("rechecks ignored protected content added during verification before changing main", async () => {
    const fixture = await createFixture();
    await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });
    const mainBefore = runGit(fixture.main, ["rev-parse", "HEAD"]);

    const result = await reconcileDeferredWorktrees({
      cwd: fixture.main,
      apply: true,
      verifyCandidate: async () => {
        await mkdir(join(fixture.feature, "projects", "demo"), { recursive: true });
        await writeFile(join(fixture.feature, "projects", "demo", "final.mp4"), "keep");
        return { ok: true, checks: ["fixture"] };
      }
    });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "worktrees.deferred_target_changed"))
      .toBe(true);
    expect(runGit(fixture.main, ["rev-parse", "HEAD"])).toBe(mainBefore);
    await expect(access(fixture.feature)).resolves.toBeUndefined();
    await expect(access(join(fixture.feature, "projects", "demo", "final.mp4")))
      .resolves.toBeUndefined();
    expect((await readDeferredWorktreeQueue({ cwd: fixture.main })).entries).toHaveLength(1);
  });

  it("does not fast-forward a different branch checked out during verification", async () => {
    const fixture = await createFixture();
    await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });

    const result = await reconcileDeferredWorktrees({
      cwd: fixture.main,
      apply: true,
      verifyCandidate: async () => {
        runGit(fixture.main, ["switch", "-c", "other-task"]);
        return { ok: true, checks: ["fixture"] };
      }
    });

    expect(result).toMatchObject({
      ok: true,
      applied: false,
      status: "waiting",
      waiting_reason: "main_changed"
    });
    expect(runGit(fixture.main, ["branch", "--show-current"])).toBe("other-task");
    expect(runGit(fixture.main, ["rev-parse", "other-task"])).toBe(fixture.mainHead);
    expect(runGit(fixture.main, ["rev-parse", "main"])).toBe(fixture.mainHead);
    await expect(access(fixture.feature)).resolves.toBeUndefined();
    expect((await readDeferredWorktreeQueue({ cwd: fixture.main })).entries).toHaveLength(1);
  });

  it("preserves a concurrently authorized entry when completing the oldest entry", async () => {
    const fixture = await createFixture();
    const second = join(fixture.base, "second-feature");
    runGit(fixture.main, ["worktree", "add", "-b", "codex/deferred-second", second]);
    await writeFile(join(second, "second.txt"), "second\n");
    runGit(second, ["add", "second.txt"]);
    runGit(second, ["commit", "-m", "second feature"]);
    const secondHead = runGit(second, ["rev-parse", "HEAD"]);
    await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });

    const result = await reconcileDeferredWorktrees({
      cwd: fixture.main,
      apply: true,
      verifyCandidate: async () => {
        const concurrent = await deferWorktreeIntegration({
          cwd: second,
          path: second,
          apply: true
        });
        expect(concurrent.ok).toBe(true);
        return { ok: true, checks: ["fixture"] };
      }
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("reconciled");
    const queue = await readDeferredWorktreeQueue({ cwd: fixture.main });
    expect(queue.entries).toHaveLength(1);
    expect(queue.entries[0]).toMatchObject({
      branch: "codex/deferred-second",
      head: secondHead
    });
    await expect(access(second)).resolves.toBeUndefined();
  });

  it.each([
    ["path", "/tmp/changed-after-verification"],
    ["branch", "codex/changed-after-verification"],
    ["head", "ffffffffffffffffffffffffffffffffffffffff"],
    ["main_branch", "trunk"],
    ["authorized_at", "2026-07-30T15:00:00.000Z"]
  ])("detects a queue %s change before removing the processed entry", async (field, value) => {
    const fixture = await createFixture();
    const queued = await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });

    const result = await reconcileDeferredWorktrees({
      cwd: fixture.main,
      apply: true,
      verifyCandidate: async () => {
        const payload = JSON.parse(await readFile(queued.queue_path, "utf8"));
        payload.entries[0][field] = value;
        await writeFile(queued.queue_path, `${JSON.stringify(payload)}\n`);
        return { ok: true, checks: ["fixture"] };
      }
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.issues[0]?.code).toBe("worktrees.deferred_queue_changed");
    expect(runGit(fixture.main, ["merge-base", "--is-ancestor", fixture.featureHead, "main"], false).status)
      .toBe(0);
    await expect(access(fixture.feature)).rejects.toThrow();
    expect((await readDeferredWorktreeQueue({ cwd: fixture.main })).entries).toHaveLength(1);
  });

  it("reports queue corruption detected while completing an entry", async () => {
    const fixture = await createFixture();
    const queued = await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });

    const result = await reconcileDeferredWorktrees({
      cwd: fixture.main,
      apply: true,
      verifyCandidate: async () => {
        await writeFile(queued.queue_path, "{broken\n");
        return { ok: true, checks: ["fixture"] };
      }
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.issues[0]?.code).toBe("worktrees.deferred_queue_invalid");
    expect(runGit(fixture.main, ["merge-base", "--is-ancestor", fixture.featureHead, "main"], false).status)
      .toBe(0);
    await expect(access(fixture.feature)).rejects.toThrow();
  });

  it("rejects a symlinked queue directory", async () => {
    const fixture = await createFixture();
    const outside = join(fixture.base, "outside-queue");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(fixture.main, ".git", "tsugite"), "dir");

    const result = await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "worktrees.deferred_queue_unsafe")).toBe(true);
    await expect(access(join(outside, "deferred-worktrees.json"))).rejects.toThrow();
  });

  it("rejects a readable queue reached through a symlinked parent before changing main", async () => {
    const fixture = await createFixture();
    const outside = join(fixture.base, "outside-readable-queue");
    await mkdir(outside, { recursive: true });
    await writeFile(
      join(outside, "deferred-worktrees.json"),
      `${JSON.stringify({
        schema_version: 1,
        entries: [{
          id: "outside-entry",
          path: fixture.feature,
          branch: "codex/deferred-fixture",
          head: fixture.featureHead,
          main_branch: "main",
          authorized_at: "2026-07-30T14:00:00.000Z",
          status: "pending"
        }]
      })}\n`
    );
    await symlink(outside, join(fixture.main, ".git", "tsugite"), "dir");

    const result = await reconcileDeferredWorktrees({
      cwd: fixture.main,
      apply: true,
      verifyCandidate: async () => ({ ok: true, checks: ["fixture"] })
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("worktrees.deferred_queue_unsafe");
    expect(runGit(fixture.main, ["rev-parse", "HEAD"])).toBe(fixture.mainHead);
    await expect(access(fixture.feature)).resolves.toBeUndefined();
  });

  it("rejects a symlinked queue file without reading its target", async () => {
    const fixture = await createFixture();
    const queued = await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });
    const outside = join(fixture.base, "outside-queue.json");
    await writeFile(outside, await readFile(queued.queue_path, "utf8"));
    await rm(queued.queue_path);
    await symlink(outside, queued.queue_path, "file");

    const result = await readDeferredWorktreeQueue({ cwd: fixture.main });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("worktrees.deferred_queue_unsafe");
  });

  it("rejects a queue path that is a directory", async () => {
    const fixture = await createFixture();
    const queued = await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });
    await rm(queued.queue_path);
    await mkdir(queued.queue_path);

    const result = await readDeferredWorktreeQueue({ cwd: fixture.main });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("worktrees.deferred_queue_unsafe");
  });

  it("rejects a queue file larger than one MiB before parsing", async () => {
    const fixture = await createFixture();
    const queued = await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });
    await writeFile(queued.queue_path, "x".repeat((1024 * 1024) + 1));

    const result = await readDeferredWorktreeQueue({ cwd: fixture.main });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("worktrees.deferred_queue_too_large");
  });

  it("rejects malformed bounded queue fields", async () => {
    const fixture = await createFixture();
    const queued = await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });
    const payload = JSON.parse(await readFile(queued.queue_path, "utf8"));
    payload.entries[0].branch = `codex/deferred-fixture\n${"x".repeat(300)}`;
    await writeFile(queued.queue_path, `${JSON.stringify(payload)}\n`);

    const result = await readDeferredWorktreeQueue({ cwd: fixture.main });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("worktrees.deferred_queue_invalid");
  });

  it.each([
    ["branch", "bad\nbranch"],
    ["main_branch", ""],
    ["authorized_at", "not-a-date"]
  ])("rejects an invalid queue %s", async (field, value) => {
    const fixture = await createFixture();
    const queued = await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });
    const payload = JSON.parse(await readFile(queued.queue_path, "utf8"));
    payload.entries[0][field] = value;
    await writeFile(queued.queue_path, `${JSON.stringify(payload)}\n`);

    const result = await readDeferredWorktreeQueue({ cwd: fixture.main });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("worktrees.deferred_queue_invalid");
  });

  it.each(["id", "path"])("rejects duplicate queue %s values", async (duplicateField) => {
    const fixture = await createFixture();
    const queued = await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });
    const payload = JSON.parse(await readFile(queued.queue_path, "utf8"));
    const duplicate = {
      ...payload.entries[0],
      id: duplicateField === "id" ? payload.entries[0].id : "second-id",
      path: duplicateField === "path" ? payload.entries[0].path : "/tmp/second-path"
    };
    payload.entries.push(duplicate);
    await writeFile(queued.queue_path, `${JSON.stringify(payload)}\n`);

    const result = await readDeferredWorktreeQueue({ cwd: fixture.main });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("worktrees.deferred_queue_invalid");
  });

  it.each([
    ["invalid JSON", "{not-json\n"],
    ["an unsupported schema", `${JSON.stringify({ schema_version: 2, entries: [] })}\n`]
  ])("rejects %s in the durable queue", async (_label, payload) => {
    const fixture = await createFixture();
    const queued = await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });
    await writeFile(queued.queue_path, payload);

    const result = await readDeferredWorktreeQueue({ cwd: fixture.main });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("worktrees.deferred_queue_invalid");
  });

  it("blocks when the queued worktree HEAD changes after authorization", async () => {
    const fixture = await createFixture();
    await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });
    await writeFile(join(fixture.feature, "later.txt"), "later\n");
    runGit(fixture.feature, ["add", "later.txt"]);
    runGit(fixture.feature, ["commit", "-m", "later change"]);

    const result = await reconcileDeferredWorktrees({
      cwd: fixture.main,
      apply: true,
      verifyCandidate: async () => {
        throw new Error("verification should not run");
      }
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.issues[0]?.code).toBe("worktrees.deferred_target_changed");
    expect(runGit(fixture.main, ["rev-parse", "HEAD"])).toBe(fixture.mainHead);
    await expect(access(fixture.feature)).resolves.toBeUndefined();
  });

  it("blocks when the queued main branch no longer matches the repository main branch", async () => {
    const fixture = await createFixture();
    const queued = await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });
    const payload = JSON.parse(await readFile(queued.queue_path, "utf8"));
    payload.entries[0].main_branch = "trunk";
    await writeFile(queued.queue_path, `${JSON.stringify(payload)}\n`);

    const result = await reconcileDeferredWorktrees({
      cwd: fixture.main,
      apply: true,
      verifyCandidate: async () => {
        throw new Error("verification should not run");
      }
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.issues[0]?.code).toBe("worktrees.deferred_main_changed");
    expect(runGit(fixture.main, ["rev-parse", "HEAD"])).toBe(fixture.mainHead);
    await expect(access(fixture.feature)).resolves.toBeUndefined();
  });

  it("clears an idempotently completed entry when its commit is already on main", async () => {
    const fixture = await createFixture();
    await deferWorktreeIntegration({
      cwd: fixture.feature,
      path: fixture.feature,
      apply: true
    });
    runGit(fixture.main, ["merge", "--ff-only", fixture.featureHead]);
    runGit(fixture.main, ["worktree", "remove", fixture.feature]);

    const result = await reconcileDeferredWorktrees({
      cwd: fixture.main,
      apply: true,
      verifyCandidate: async () => {
        throw new Error("verification should not run");
      }
    });

    expect(result).toMatchObject({
      ok: true,
      applied: true,
      status: "reconciled",
      removed: []
    });
    expect((await readDeferredWorktreeQueue({ cwd: fixture.main })).entries).toEqual([]);
  });
});

describe("pipeline deferred worktree command", () => {
  it("requires coordinator approval and exposes durable queue state as JSON", async () => {
    const fixture = await createFixture();
    const denied = await capture(
      ["worktrees", "--defer", "--apply", "--path", fixture.feature, "--json"],
      fixture.feature
    );
    expect(denied.status).toBe(1);
    expect(JSON.parse(denied.stderr).issues[0]?.code).toBe("cli.coordinator_required");

    const queued = await capture(
      [
        "worktrees",
        "--defer",
        "--apply",
        "--actor", "coordinator",
        "--path", fixture.feature,
        "--json"
      ],
      fixture.feature
    );
    expect(queued.status).toBe(0);
    expect(JSON.parse(queued.stdout)).toMatchObject({
      ok: true,
      command: "worktrees",
      mode: "defer",
      applied: true,
      queued: true
    });

    await writeFile(join(fixture.main, "busy.txt"), "other task\n");
    const waiting = await capture(
      ["worktrees", "--reconcile", "--apply", "--actor", "coordinator", "--json"],
      fixture.main
    );
    expect(waiting.status).toBe(0);
    expect(JSON.parse(waiting.stdout)).toMatchObject({
      ok: true,
      command: "worktrees",
      mode: "reconcile",
      applied: false,
      status: "waiting",
      waiting_reason: "main_dirty"
    });
  });

  it("rejects ambiguous deferred modes", async () => {
    const fixture = await createFixture();
    const result = await capture(
      [
        "worktrees",
        "--defer",
        "--reconcile",
        "--apply",
        "--actor", "coordinator",
        "--path", fixture.feature,
        "--json"
      ],
      fixture.main
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).issues[0]?.code).toBe("worktrees.mode_conflict");
  });
});

async function createFixture(options: { conflicting?: boolean } = {}) {
  const base = await mkdtemp(join(tmpdir(), "tsugite-deferred-fixture-"));
  temporaryRoots.push(base);
  const main = join(base, "main");
  const feature = join(base, "feature");
  await mkdir(main, { recursive: true });
  runGit(main, ["init", "-b", "main"]);
  runGit(main, ["config", "user.email", "worktree@example.com"]);
  runGit(main, ["config", "user.name", "Worktree Tester"]);
  await writeFile(join(main, "README.md"), "# fixture\n");
  await writeFile(join(main, ".gitignore"), "node_modules/\nbuild/\nprojects/\n");
  if (options.conflicting) await writeFile(join(main, "shared.txt"), "base\n");
  runGit(main, ["add", "."]);
  runGit(main, ["commit", "-m", "init"]);
  const mainHead = runGit(main, ["rev-parse", "HEAD"]);

  runGit(main, ["worktree", "add", "-b", "codex/deferred-fixture", feature]);
  await writeFile(join(feature, "feature.txt"), "feature\n");
  if (options.conflicting) await writeFile(join(feature, "shared.txt"), "feature\n");
  runGit(feature, ["add", "."]);
  runGit(feature, ["commit", "-m", "feature"]);
  const featureHead = runGit(feature, ["rev-parse", "HEAD"]);

  if (options.conflicting) {
    await writeFile(join(main, "shared.txt"), "main\n");
    runGit(main, ["add", "shared.txt"]);
    runGit(main, ["commit", "-m", "main conflict"]);
  }

  return { base, main, feature, mainHead, featureHead };
}

async function canonical(path: string): Promise<string> {
  return normalizePath(await realpath(path));
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function normalizePath(path: string): string {
  const absolute = resolve(path);
  if (process.platform === "darwin" && absolute.startsWith("/private/var/")) {
    return absolute.slice("/private".length);
  }
  if (process.platform === "darwin" && absolute.startsWith("/private/tmp/")) {
    return absolute.slice("/private".length);
  }
  return absolute;
}

function runGit(
  cwd: string,
  args: string[],
  checked?: true
): string;
function runGit(
  cwd: string,
  args: string[],
  checked: false
): ReturnType<typeof spawnSync>;
function runGit(cwd: string, args: string[], checked = true) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (!checked) return result;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function capture(args: string[], cwd: string) {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    const status = await pipelineMain(args);
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
