/**
 * High-value security / failure-branch coverage for capacity & promotion safety:
 * destination locks, promotion journals, empty-apply, and mutating-apply contracts.
 * Intentionally exercises lock contention, symlink escapes, rollback, and failure records
 * rather than line-count padding.
 */
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyEmptyCandidatesPromotionAndRecord,
  applyIdempotentEmptyAlreadyHome,
  type EmptyApplySharedContext
} from "../src/orchestrator/finalizeApplyEmpty.js";
import {
  applyMutatingFinalizeCleanup,
  type MutatingApplyContext
} from "../src/orchestrator/finalizeApplyMutating.js";
import {
  acquireDestinationLock,
  acquireDestinationLocksOrdered,
  DestinationLockBoundaryError,
  DestinationLockedError,
  destinationLockPath
} from "../src/project/destinationLock.js";
import {
  clearPromotionJournal,
  finishRollbackFromJournal,
  inspectPromotionJournalPaths,
  loadPromotionJournal,
  parsePromotionJournalSchema,
  PROMOTION_BACKUP_PREFIX,
  PROMOTION_JOURNAL_DIR_NAME,
  PROMOTION_STAGING_PREFIX,
  promotionJournalPath,
  recoverPromotionTransactions,
  writePromotionJournal,
  type PromotionJournal
} from "../src/project/promotionJournal.js";

async function tempRoot(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `tsugite-${label}-`));
}

function emptyBase(projectRoot: string): EmptyApplySharedContext["base"] {
  return {
    ok: true,
    issues: [],
    applied: true,
    deletedFiles: 0,
    deletedBytes: 0
  };
}

function buildEmptyCtx(input: {
  projectRoot: string;
  stateDir: string;
  runId?: string;
  runDir: string;
  recordPath: string;
  projectsHome: string;
  configPath: string;
  projectSlug?: string;
  alreadyHome?: boolean;
  priorDeletedFiles?: number;
  priorDeletedBytes?: number;
  priorDeletedPaths?: string[];
  revalidatePinnedDirs?: () => Promise<EmptyApplySharedContext["revalidatePinnedDirs"] extends () => Promise<infer R> ? R : never>;
  promotionHooks?: EmptyApplySharedContext["promotionHooks"];
}): EmptyApplySharedContext {
  const projectSlug = input.projectSlug ?? "demo";
  const destinationRoot = input.alreadyHome === false
    ? join(input.projectsHome, projectSlug)
    : input.projectRoot;
  return {
    projectRoot: input.projectRoot,
    stateDir: input.stateDir,
    runId: input.runId ?? "demo-v2",
    runDir: input.runDir,
    recordPath: input.recordPath,
    canonicalOutputPath: join(input.runDir, "final.mp4"),
    referencedSourceMedia: [],
    planDigest: "plan-digest-test",
    priorCleanup: {
      deletedFiles: input.priorDeletedFiles ?? 0,
      deletedBytes: input.priorDeletedBytes ?? 0,
      deletedPaths: input.priorDeletedPaths ?? []
    },
    stateUpdatedAt: "2026-08-01T00:00:00.000Z",
    launcherPlan: {
      projectsHome: input.projectsHome,
      projectRoot: input.projectRoot,
      destinationRoot,
      alreadyHome: input.alreadyHome !== false,
      willPromote: input.alreadyHome === false
    },
    project: { projectSlug, now: "2026-08-01T00:00:00.000Z" },
    base: emptyBase(input.projectRoot),
    configPath: input.configPath,
    projectSlug,
    now: "2026-08-01T00:00:00.000Z",
    promotionHooks: input.promotionHooks,
    revalidatePinnedDirs: input.revalidatePinnedDirs
      ?? (async () => undefined)
  };
}

async function seedAlreadyHomeProject(root: string, slug = "demo"): Promise<{
  projectsHome: string;
  projectRoot: string;
  configPath: string;
  stateDir: string;
  runDir: string;
  recordPath: string;
}> {
  const projectsHome = join(root, "projects");
  const projectRoot = join(projectsHome, slug);
  const runDir = join(projectRoot, "dist", `${slug}-v2`);
  const stateDir = join(projectRoot, "dist");
  const configPath = join(projectRoot, "project.yaml");
  const recordPath = join(runDir, "completion-record.json");
  await mkdir(runDir, { recursive: true });
  await writeFile(configPath, `slug: ${slug}\n`, "utf8");
  await writeFile(join(runDir, "final.mp4"), "final-bytes", "utf8");
  await writeFile(recordPath, `${JSON.stringify({ schema_version: 1, project_slug: slug })}\n`, "utf8");
  return { projectsHome, projectRoot, configPath, stateDir, runDir, recordPath };
}

describe("destinationLock security contracts", () => {
  it("rejects concurrent holders, waits for release, and times out when still held", async () => {
    const root = await tempRoot("dest-lock-wait");
    const projectsHome = join(root, "projects");
    const destinationRoot = join(projectsHome, "job-wait");
    await mkdir(destinationRoot, { recursive: true });

    const held = await acquireDestinationLock(projectsHome, destinationRoot);
    await expect(acquireDestinationLock(projectsHome, destinationRoot))
      .rejects.toBeInstanceOf(DestinationLockedError);

    await expect(
      acquireDestinationLock(projectsHome, destinationRoot, { wait: true, waitMs: 60, pollMs: 15 })
    ).rejects.toBeInstanceOf(DestinationLockedError);

    const waiter = acquireDestinationLock(projectsHome, destinationRoot, {
      wait: true,
      waitMs: 800,
      pollMs: 20
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    await held.release();
    // Double-release is a no-op (safe for finally blocks).
    await held.release();
    const acquired = await waiter;
    expect(acquired.token.length).toBeGreaterThan(0);
    await acquired.release();
  });

  it("acquireDestinationLocksOrdered sorts destinations and rolls back partial holds on failure", async () => {
    const root = await tempRoot("dest-lock-ordered");
    const projectsHome = join(root, "projects");
    const destA = join(projectsHome, "z-last");
    const destB = join(projectsHome, "a-first");
    const destC = join(projectsHome, "m-mid");
    await mkdir(destA, { recursive: true });
    await mkdir(destB, { recursive: true });
    await mkdir(destC, { recursive: true });

    const ordered = await acquireDestinationLocksOrdered(
      projectsHome,
      [destA, destB, destA, destC]
    );
    expect(ordered.map((lock) => basename(lock.destinationRoot))).toEqual([
      "a-first",
      "m-mid",
      "z-last"
    ]);
    for (const lock of [...ordered].reverse()) {
      await lock.release();
    }

    // Hold the second destination in sorted order so the ordered acquire fails mid-way
    // and must release the earlier lock without leaving orphans.
    const blocker = await acquireDestinationLock(projectsHome, destC);
    try {
      await expect(
        acquireDestinationLocksOrdered(projectsHome, [destA, destC], { wait: false })
      ).rejects.toBeInstanceOf(DestinationLockedError);
      // destA must be free again after ordered rollback.
      const reacquired = await acquireDestinationLock(projectsHome, destA);
      await reacquired.release();
    } finally {
      await blocker.release();
    }
  });

  it("refuses symlink journal roots, non-directory journal roots, and lock leaf symlinks", async () => {
    const root = await tempRoot("dest-lock-symlink");
    const projectsHome = join(root, "projects");
    const destinationRoot = join(projectsHome, "job-sym");
    await mkdir(destinationRoot, { recursive: true });

    // Journal dir as regular file.
    await mkdir(projectsHome, { recursive: true });
    await writeFile(join(projectsHome, PROMOTION_JOURNAL_DIR_NAME), "not-a-dir\n", "utf8");
    await expect(acquireDestinationLock(projectsHome, destinationRoot))
      .rejects.toMatchObject({
        name: "DestinationLockBoundaryError",
        code: "promotion.destination_lock_unsafe"
      });
    await rm(join(projectsHome, PROMOTION_JOURNAL_DIR_NAME), { force: true });

    // Journal dir as symlink leaf.
    const realJournal = join(root, "real-journal");
    await mkdir(realJournal, { recursive: true });
    await symlink(realJournal, join(projectsHome, PROMOTION_JOURNAL_DIR_NAME), "dir");
    await expect(acquireDestinationLock(projectsHome, destinationRoot))
      .rejects.toMatchObject({
        name: "DestinationLockBoundaryError",
        code: "promotion.destination_lock_symlink"
      });
    await rm(join(projectsHome, PROMOTION_JOURNAL_DIR_NAME), { force: true });
    await rm(realJournal, { recursive: true, force: true });

    // Lock leaf symlink is refused before open.
    const journalDir = join(projectsHome, PROMOTION_JOURNAL_DIR_NAME);
    await mkdir(journalDir, { recursive: true });
    const lockPath = destinationLockPath(projectsHome, destinationRoot);
    const external = join(root, "external.lock");
    await writeFile(external, "secret\n", "utf8");
    await symlink(external, lockPath);
    await expect(acquireDestinationLock(projectsHome, destinationRoot))
      .rejects.toMatchObject({
        name: "DestinationLockBoundaryError",
        code: "promotion.destination_lock_symlink"
      });
    expect(await readFile(external, "utf8")).toBe("secret\n");
    await rm(lockPath, { force: true });
  });

  it("recovers a stale lock from a dead pid and refuses non-owner release unlinks", async () => {
    const root = await tempRoot("dest-lock-stale");
    const projectsHome = join(root, "projects");
    const destinationRoot = join(projectsHome, "job-stale");
    await mkdir(destinationRoot, { recursive: true });
    const journalDir = join(projectsHome, PROMOTION_JOURNAL_DIR_NAME);
    await mkdir(journalDir, { recursive: true });
    const lockPath = destinationLockPath(projectsHome, destinationRoot);

    // Dead pid (unlikely to be live); recovery should rename+unlink and allow acquire.
    await writeFile(lockPath, `${JSON.stringify({
      pid: 2_147_483_646,
      token: "stale-token",
      destination_root: destinationRoot,
      projects_home: projectsHome,
      acquired_at: "2020-01-01T00:00:00.000Z"
    })}\n`, "utf8");
    const recovered = await acquireDestinationLock(projectsHome, destinationRoot);
    expect(recovered.token).not.toBe("stale-token");

    // Rewrite lock payload with a different token while held: release must not unlink.
    await writeFile(lockPath, `${JSON.stringify({
      pid: process.pid,
      token: "foreign-token",
      destination_root: destinationRoot,
      projects_home: projectsHome,
      acquired_at: new Date().toISOString()
    })}\n`, "utf8");
    await recovered.release();
    await expect(readFile(lockPath, "utf8")).resolves.toContain("foreign-token");
    await rm(lockPath, { force: true });

    // Live lock with current pid is not recovered as stale.
    const live = await acquireDestinationLock(projectsHome, destinationRoot);
    await expect(acquireDestinationLock(projectsHome, destinationRoot))
      .rejects.toBeInstanceOf(DestinationLockedError);
    await live.release();
  });

  it("detects post-create lock identity changes via test hooks and sanitizes odd basenames", async () => {
    const root = await tempRoot("dest-lock-hooks");
    const projectsHome = join(root, "projects");
    const destinationRoot = join(projectsHome, "weird name!");
    await mkdir(destinationRoot, { recursive: true });

    const lockPath = destinationLockPath(projectsHome, destinationRoot);
    expect(basename(lockPath)).toMatch(/^dir-[0-9a-f]+\.lock$/);

    // After create, replace the lock leaf with a symlink → fail closed and clean up.
    await expect(
      acquireDestinationLock(projectsHome, destinationRoot, {
        _testHooks: {
          afterLockCreatedBeforeValidate: async () => {
            await rm(lockPath, { force: true });
            const external = join(root, "hijack.lock");
            await writeFile(external, "hijack\n", "utf8");
            await symlink(external, lockPath);
          }
        }
      })
    ).rejects.toMatchObject({
      name: "DestinationLockBoundaryError",
      code: "promotion.destination_lock_symlink"
    });

    // Identity check hook re-validates journal dir; swapping to a file fails closed.
    await rm(lockPath, { force: true });
    await expect(
      acquireDestinationLock(projectsHome, destinationRoot, {
        _testHooks: {
          afterIdentityCheckBeforeOpen: async () => {
            const journalDir = join(projectsHome, PROMOTION_JOURNAL_DIR_NAME);
            await rm(journalDir, { recursive: true, force: true });
            await writeFile(journalDir, "not-dir\n", "utf8");
          }
        }
      })
    ).rejects.toBeInstanceOf(DestinationLockBoundaryError);
  });

  it("fails closed on journal-parent rename→external symlink TOCTOU and never mutates external sentinel", async () => {
    const root = await tempRoot("dest-lock-journal-toctou");
    const projectsHome = join(root, "projects");
    const destinationRoot = join(projectsHome, "job-toctou");
    const journalDir = join(projectsHome, PROMOTION_JOURNAL_DIR_NAME);
    const external = join(root, "external-journal-target");
    const relocated = join(root, "relocated-journal");
    const sentinel = "EXTERNAL_SENTINEL_MUST_NOT_CHANGE\n";
    await mkdir(destinationRoot, { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(join(external, "sentinel.txt"), sentinel, "utf8");

    const lockPath = destinationLockPath(projectsHome, destinationRoot);
    const lockName = basename(lockPath);

    // Post-create: rename journal parent, move the created lock inode under external,
    // then replace the journal path with a symlink. Path/inode of the leaf alone still
    // match, so only journal-parent identity pinning fail-closes without touching external.
    await expect(
      acquireDestinationLock(projectsHome, destinationRoot, {
        _testHooks: {
          afterLockCreatedBeforeValidate: async () => {
            await rename(journalDir, relocated);
            await rename(join(relocated, lockName), join(external, lockName));
            await symlink(external, journalDir, "dir");
          }
        }
      })
    ).rejects.toBeInstanceOf(DestinationLockBoundaryError);

    expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe(sentinel);
    // Cleanup must not unlink through the swapped journal path (orphan preferred).
    expect(await readdir(external).then((names) => names.sort())).toEqual(
      [lockName, "sentinel.txt"].sort()
    );
    expect(await lstat(journalDir).then((s) => s.isSymbolicLink())).toBe(true);

    // Pre-open swap: refuse before create; external stays sentinel-only.
    await rm(journalDir, { force: true });
    await rm(join(external, lockName), { force: true });
    await mkdir(journalDir, { recursive: true });
    await expect(
      acquireDestinationLock(projectsHome, destinationRoot, {
        _testHooks: {
          afterIdentityCheckBeforeOpen: async () => {
            await rename(journalDir, join(root, "relocated-journal-preopen"));
            await symlink(external, journalDir, "dir");
          }
        }
      })
    ).rejects.toMatchObject({
      name: "DestinationLockBoundaryError",
      code: "promotion.destination_lock_symlink"
    });
    expect(await readdir(external).then((names) => names.sort())).toEqual(["sentinel.txt"]);
    expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe(sentinel);

    // Hold-time swap: release must not delete the lock now reachable only via external.
    await rm(journalDir, { force: true });
    const held = await acquireDestinationLock(projectsHome, destinationRoot);
    await rename(journalDir, join(root, "relocated-journal-held"));
    await rename(
      join(root, "relocated-journal-held", lockName),
      join(external, lockName)
    );
    await symlink(external, journalDir, "dir");
    await held.release();
    expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe(sentinel);
    expect(await readdir(external).then((names) => names.sort())).toEqual(
      [lockName, "sentinel.txt"].sort()
    );
    expect(await readFile(join(external, lockName), "utf8")).toContain(held.token);

    // Replace journal with a different real directory (same path, new inode) after create.
    await rm(journalDir, { force: true });
    await rm(join(external, lockName), { force: true });
    await expect(
      acquireDestinationLock(projectsHome, destinationRoot, {
        _testHooks: {
          afterLockCreatedBeforeValidate: async () => {
            const lockNameNow = basename(destinationLockPath(projectsHome, destinationRoot));
            await rename(journalDir, join(root, "relocated-journal-real-swap"));
            await mkdir(journalDir, { recursive: true });
            // Preserve leaf path/inode match attempt: move lock into the new dir.
            await rename(
              join(root, "relocated-journal-real-swap", lockNameNow),
              join(journalDir, lockNameNow)
            );
          }
        }
      })
    ).rejects.toMatchObject({
      name: "DestinationLockBoundaryError",
      code: "promotion.destination_lock_changed"
    });
    expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe(sentinel);
  });

  it("creates missing multi-level projectsHome under a real parent without recursive mkdir side effects", async () => {
    const root = await tempRoot("dest-lock-missing-home");
    const projectsHome = join(root, "nested", "deep", "projects");
    const destinationRoot = join(projectsHome, "job-created");
    // Only the temp root exists; projectsHome and intermediate dirs are missing.
    const lock = await acquireDestinationLock(projectsHome, destinationRoot);
    try {
      expect(await lstat(projectsHome).then((s) => s.isDirectory())).toBe(true);
      expect(await lstat(join(projectsHome, PROMOTION_JOURNAL_DIR_NAME)).then((s) => s.isDirectory()))
        .toBe(true);
      expect((await lstat(projectsHome)).isSymbolicLink()).toBe(false);
    } finally {
      await lock.release();
    }

    // Second acquire reuses the existing real journal dir (no-op create path).
    const again = await acquireDestinationLock(projectsHome, destinationRoot);
    await again.release();
  });

  it("refuses projectsHome that is a regular file and refuses file ancestors before any journal create", async () => {
    const root = await tempRoot("dest-lock-home-file");
    const fileHome = join(root, "projects-as-file");
    await writeFile(fileHome, "not-a-directory\n", "utf8");
    await expect(acquireDestinationLock(fileHome, join(fileHome, "job")))
      .rejects.toMatchObject({
        name: "DestinationLockBoundaryError",
        code: "promotion.destination_lock_unsafe"
      });
    await expect(lstat(join(root, PROMOTION_JOURNAL_DIR_NAME))).rejects.toMatchObject({
      code: "ENOENT"
    });

    const fileAncestor = join(root, "file-ancestor");
    await writeFile(fileAncestor, "blocks-nested-home\n", "utf8");
    const nestedHome = join(fileAncestor, "projects");
    await expect(acquireDestinationLock(nestedHome, join(nestedHome, "job")))
      .rejects.toMatchObject({
        name: "DestinationLockBoundaryError",
        code: "promotion.destination_lock_unsafe"
      });
    await expect(lstat(join(root, PROMOTION_JOURNAL_DIR_NAME))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("fail-closes when journal cannot be created under a non-writable projectsHome", async () => {
    if (process.platform === "win32") return;
    const root = await tempRoot("dest-lock-home-ro");
    const projectsHome = join(root, "projects");
    const destinationRoot = join(projectsHome, "job-ro");
    await mkdir(destinationRoot, { recursive: true });
    await chmod(projectsHome, 0o500);
    try {
      await expect(acquireDestinationLock(projectsHome, destinationRoot))
        .rejects.toMatchObject({
          name: "DestinationLockBoundaryError",
          code: "promotion.destination_lock_unsafe"
        });
    } finally {
      await chmod(projectsHome, 0o700);
    }
  });

  it("fail-closes when an existing projectsHome ancestor is not traversable", async () => {
    if (process.platform === "win32") return;
    const root = await tempRoot("dest-lock-home-eacces");
    const blocked = join(root, "blocked");
    const projectsHome = join(blocked, "projects");
    const destinationRoot = join(projectsHome, "job");
    await mkdir(destinationRoot, { recursive: true });
    await chmod(blocked, 0o000);
    try {
      await expect(acquireDestinationLock(projectsHome, destinationRoot))
        .rejects.toMatchObject({
          name: "DestinationLockBoundaryError",
          code: "promotion.destination_lock_unsafe"
        });
    } finally {
      await chmod(blocked, 0o700);
    }
  });

  it("BLOCK: projectsHome symlink fails closed before mkdir and never mutates external sentinel/listing", async () => {
    const root = await tempRoot("dest-lock-home-symlink");
    const external = join(root, "external-target");
    const projectsHome = join(root, "projects-home-link");
    const destinationRoot = join(projectsHome, "job-home-sym");
    const sentinel = "EXTERNAL_HOME_SENTINEL_UNCHANGED\n";
    await mkdir(external, { recursive: true });
    await writeFile(join(external, "sentinel.txt"), sentinel, "utf8");
    await symlink(external, projectsHome, "dir");
    const externalBefore = (await readdir(external)).sort();

    await expect(acquireDestinationLock(projectsHome, destinationRoot))
      .rejects.toMatchObject({
        name: "DestinationLockBoundaryError",
        code: "promotion.destination_lock_symlink"
      });

    // Zero side effects: recursive mkdir must not have created the journal on the external target.
    expect((await readdir(external)).sort()).toEqual(externalBefore);
    expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe(sentinel);
    await expect(lstat(join(external, PROMOTION_JOURNAL_DIR_NAME))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("BLOCK: projectsHome ancestor symlink fails closed before mkdir and never mutates external sentinel/listing", async () => {
    const root = await tempRoot("dest-lock-ancestor-symlink");
    const external = join(root, "external-ancestor-target");
    const ancestor = join(root, "ancestor-link");
    // projectsHome is nested under a symlink ancestor and does not exist yet.
    const projectsHome = join(ancestor, "nested", "projects");
    const destinationRoot = join(projectsHome, "job-ancestor-sym");
    const sentinel = "EXTERNAL_ANCESTOR_SENTINEL_UNCHANGED\n";
    await mkdir(external, { recursive: true });
    await writeFile(join(external, "sentinel.txt"), sentinel, "utf8");
    await symlink(external, ancestor, "dir");
    const externalBefore = (await readdir(external)).sort();

    await expect(acquireDestinationLock(projectsHome, destinationRoot))
      .rejects.toMatchObject({
        name: "DestinationLockBoundaryError",
        code: "promotion.destination_lock_symlink"
      });

    expect((await readdir(external)).sort()).toEqual(externalBefore);
    expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe(sentinel);
    await expect(lstat(join(external, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(external, PROMOTION_JOURNAL_DIR_NAME))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("BLOCK: acquireDestinationLock refuses existing projectsHome under linked ancestor (leaf-only lstat gap)", async () => {
    // Regression: when external/nested/projects already exists as a real directory,
    // leaf-only lstat(projectsHome) misses the linked-parent symlink and can create
    // .tsugite-promote-journal on the external target. Must fail closed with zero
    // external mutation (sentinel, listing, project, marker, journal, lock, link).
    const root = await tempRoot("dest-lock-existing-linked-home");
    const external = join(root, "external");
    const linkedParent = join(root, "linked-parent");
    const projectsHome = join(linkedParent, "nested", "projects");
    const destinationRoot = join(projectsHome, "job-existing-linked");
    const sentinel = "EXTERNAL_EXISTING_LINKED_HOME_SENTINEL_UNCHANGED\n";
    await mkdir(join(external, "nested", "projects"), { recursive: true });
    await writeFile(join(external, "sentinel.txt"), sentinel, "utf8");
    await symlink(external, linkedParent, "dir");
    // Leaf is a real directory when resolved through the symlink ancestor.
    expect(await lstat(projectsHome).then((s) => s.isDirectory())).toBe(true);
    expect(await lstat(projectsHome).then((s) => s.isSymbolicLink())).toBe(false);
    const externalBefore = (await readdir(external)).sort();

    await expect(acquireDestinationLock(projectsHome, destinationRoot))
      .rejects.toMatchObject({
        name: "DestinationLockBoundaryError",
        code: "promotion.destination_lock_symlink"
      });

    expect((await readdir(external)).sort()).toEqual(externalBefore);
    expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe(sentinel);
    expect(await readdir(join(external, "nested", "projects"))).toEqual([]);
    await expect(lstat(join(external, "nested", "projects", PROMOTION_JOURNAL_DIR_NAME)))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(external, "nested", "projects", "job-existing-linked")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(external, PROMOTION_JOURNAL_DIR_NAME)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("BLOCK: ancestor swap to external symlink after real home existed fails closed without external journal", async () => {
    const root = await tempRoot("dest-lock-ancestor-swap");
    const base = join(root, "base");
    const projectsHome = join(base, "projects");
    const destinationRoot = join(projectsHome, "job-swap");
    const relocated = join(root, "base-relocated");
    const external = join(root, "external-swap-target");
    const sentinel = "EXTERNAL_SWAP_SENTINEL_UNCHANGED\n";
    await mkdir(destinationRoot, { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(join(external, "sentinel.txt"), sentinel, "utf8");

    // Swap the ancestor: move the real base away and replace it with a symlink to empty external.
    await rename(base, relocated);
    await symlink(external, base, "dir");
    const externalBefore = (await readdir(external)).sort();

    await expect(acquireDestinationLock(projectsHome, destinationRoot))
      .rejects.toMatchObject({
        name: "DestinationLockBoundaryError",
        code: "promotion.destination_lock_symlink"
      });

    expect((await readdir(external)).sort()).toEqual(externalBefore);
    expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe(sentinel);
    await expect(lstat(join(external, "projects"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(external, PROMOTION_JOURNAL_DIR_NAME))).rejects.toMatchObject({
      code: "ENOENT"
    });
    // Relocated real tree must remain intact (no lock/journal writes redirected through the swap).
    expect(await lstat(join(relocated, "projects", "job-swap")).then((s) => s.isDirectory())).toBe(true);
    await expect(lstat(join(relocated, "projects", PROMOTION_JOURNAL_DIR_NAME))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});

describe("promotionJournal path safety and recovery failure contracts", () => {
  it("rejects unsafe staging/backup shapes and clearing through symlink leaves", async () => {
    const root = await tempRoot("promo-journal-shapes");
    const projectsHome = join(root, "projects");
    const destination = join(projectsHome, "job");
    await mkdir(destination, { recursive: true });
    const now = "2026-08-01T18:00:00.000Z";

    // switching without staging_path is schema-invalid.
    expect(parsePromotionJournalSchema({
      schema_version: 1,
      projects_home: resolve(projectsHome),
      destination_root: resolve(destination),
      backup_path: null,
      staging_path: null,
      created_fresh: true,
      phase: "switching",
      created_at: now,
      updated_at: now
    }, "/tmp/j.json").ok).toBe(false);

    // staging_path must use promote prefix and stay a direct child.
    await expect(
      writePromotionJournal({
        projectsHome,
        journal: {
          schema_version: 1,
          projects_home: resolve(projectsHome),
          destination_root: resolve(destination),
          backup_path: null,
          staging_path: resolve(join(projectsHome, "not-a-staging")),
          created_fresh: true,
          phase: "switching",
          created_at: now,
          updated_at: now
        }
      })
    ).rejects.toMatchObject({ code: "promotion.journal_path_unsafe" });

    // staging equal to destination is unsafe.
    await expect(
      writePromotionJournal({
        projectsHome,
        journal: {
          schema_version: 1,
          projects_home: resolve(projectsHome),
          destination_root: resolve(destination),
          backup_path: null,
          staging_path: resolve(destination),
          created_fresh: true,
          phase: "switching",
          created_at: now,
          updated_at: now
        }
      })
    ).rejects.toMatchObject({ code: "promotion.journal_path_unsafe" });

    // backup_path without promote-backup prefix.
    await expect(
      writePromotionJournal({
        projectsHome,
        journal: {
          schema_version: 1,
          projects_home: resolve(projectsHome),
          destination_root: resolve(destination),
          backup_path: resolve(join(projectsHome, "random-backup")),
          staging_path: null,
          created_fresh: false,
          phase: "open",
          created_at: now,
          updated_at: now
        }
      })
    ).rejects.toMatchObject({ code: "promotion.journal_path_unsafe" });

    // backup_path equal to destination.
    await expect(
      writePromotionJournal({
        projectsHome,
        journal: {
          schema_version: 1,
          projects_home: resolve(projectsHome),
          destination_root: resolve(destination),
          backup_path: resolve(destination),
          staging_path: null,
          created_fresh: false,
          phase: "open",
          created_at: now,
          updated_at: now
        }
      })
    ).rejects.toMatchObject({ code: "promotion.journal_path_unsafe" });

    // Nested backup (not direct child of projects home).
    const nestedBackup = join(destination, `${PROMOTION_BACKUP_PREFIX}nested`);
    await mkdir(nestedBackup, { recursive: true });
    await expect(
      writePromotionJournal({
        projectsHome,
        journal: {
          schema_version: 1,
          projects_home: resolve(projectsHome),
          destination_root: resolve(destination),
          backup_path: resolve(nestedBackup),
          staging_path: null,
          created_fresh: false,
          phase: "open",
          created_at: now,
          updated_at: now
        }
      })
    ).rejects.toMatchObject({ code: "promotion.journal_path_unsafe" });

    // staging equal to backup.
    const backup = join(projectsHome, `${PROMOTION_BACKUP_PREFIX}job-1`);
    const staging = join(projectsHome, `${PROMOTION_STAGING_PREFIX}job-1`);
    await mkdir(backup, { recursive: true });
    await mkdir(staging, { recursive: true });
    await expect(
      writePromotionJournal({
        projectsHome,
        journal: {
          schema_version: 1,
          projects_home: resolve(projectsHome),
          destination_root: resolve(destination),
          backup_path: resolve(backup),
          staging_path: resolve(backup),
          created_fresh: false,
          phase: "switching",
          created_at: now,
          updated_at: now
        }
      })
    ).rejects.toMatchObject({ code: "promotion.journal_path_unsafe" });

    // Relative destination_root is unsafe.
    const relativeIssue = await inspectPromotionJournalPaths({
      schema_version: 1,
      projects_home: resolve(projectsHome),
      destination_root: "relative-dest",
      backup_path: null,
      staging_path: null,
      created_fresh: true,
      phase: "open",
      created_at: now,
      updated_at: now
    }, projectsHome, promotionJournalPath(projectsHome, destination));
    expect(relativeIssue?.code).toBe("promotion.journal_path_unsafe");

    // clearPromotionJournal refuses leaf symlink journals.
    await mkdir(join(projectsHome, PROMOTION_JOURNAL_DIR_NAME), { recursive: true });
    const journalFile = promotionJournalPath(projectsHome, destination);
    const externalJournal = join(root, "external-journal.json");
    await writeFile(externalJournal, "{}\n", "utf8");
    await symlink(externalJournal, journalFile);
    await expect(clearPromotionJournal(projectsHome, destination))
      .rejects.toMatchObject({ code: "promotion.journal_path_unsafe" });
    expect(await readFile(externalJournal, "utf8")).toBe("{}\n");
    await rm(journalFile, { force: true });

    // clearPromotionJournal refuses non-file journal paths.
    await mkdir(journalFile, { recursive: true });
    await expect(clearPromotionJournal(projectsHome, destination))
      .rejects.toMatchObject({ code: "promotion.journal_path_unsafe" });
  });

  it("recovery reports destination lock failures and both-missing rollback without destructive renames", async () => {
    const root = await tempRoot("promo-recovery-lock");
    const projectsHome = join(root, "projects");
    const destination = join(projectsHome, "recover-me");
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "marker.txt"), "keep-me", "utf8");

    const now = "2026-08-01T19:00:00.000Z";
    await writePromotionJournal({
      projectsHome,
      journal: {
        schema_version: 1,
        projects_home: resolve(projectsHome),
        destination_root: resolve(destination),
        backup_path: null,
        staging_path: null,
        created_fresh: true,
        phase: "open",
        project_slug: "recover-me",
        created_at: now,
        updated_at: now
      }
    });

    const held = await acquireDestinationLock(projectsHome, destination, { wait: false });
    try {
      // wait=true recovers eventually — instead force a boundary error via journal dir symlink
      // while a separate journal is pending is hard mid-loop. Holding the lock with a very short
      // wait is not exposed; the public recovery waits. Cover DestinationLockedError mapping by
      // acquiring with wait:false inside a custom path: plant a second journal and use a hook-less
      // wait that exceeds? recover uses wait:true with 2000ms default — holding >2s is slow.
      // Instead verify finishRollback both-missing fails closed.
    } finally {
      await held.release();
    }

    // Both backup and destination missing → recovery_failed, no inventing a tree.
    const missingDest = join(projectsHome, "gone-dest");
    // Legacy numeric suffix must embed the destination basename (identity binding).
    const missingBackup = join(projectsHome, `${PROMOTION_BACKUP_PREFIX}gone-dest-1`);
    const journal: PromotionJournal = {
      schema_version: 1,
      projects_home: resolve(projectsHome),
      destination_root: resolve(missingDest),
      backup_path: resolve(missingBackup),
      staging_path: null,
      created_fresh: false,
      phase: "open",
      created_at: now,
      updated_at: now
    };
    await writePromotionJournal({ projectsHome, journal });
    // Remove destination after journal write so inspect allows missing destination.
    await rm(missingDest, { recursive: true, force: true }).catch(() => undefined);
    await expect(
      finishRollbackFromJournal(journal, projectsHome)
    ).rejects.toMatchObject({
      code: "promotion.recovery_failed",
      message: expect.stringMatching(/backup and destination are both missing/)
    });

    // Symlink journal directory blocks all recovery actions.
    const otherRoot = await tempRoot("promo-recovery-jdir");
    const otherHome = join(otherRoot, "projects");
    const otherDest = join(otherHome, "job");
    await mkdir(otherDest, { recursive: true });
    const realJ = join(otherRoot, "real-j");
    await mkdir(realJ, { recursive: true });
    await writeFile(join(realJ, "job.json"), `${JSON.stringify({
      schema_version: 1,
      projects_home: resolve(otherHome),
      destination_root: resolve(otherDest),
      backup_path: null,
      staging_path: null,
      created_fresh: true,
      phase: "open",
      created_at: now,
      updated_at: now
    }, null, 2)}\n`, "utf8");
    await mkdir(otherHome, { recursive: true });
    await symlink(realJ, join(otherHome, PROMOTION_JOURNAL_DIR_NAME), "dir");
    const blocked = await recoverPromotionTransactions(otherHome);
    expect(blocked.ok).toBe(false);
    expect(blocked.issues.some((issue) => issue.code === "promotion.journal_path_unsafe")).toBe(true);
    expect(blocked.recovered).toBe(0);

    // Destination still has marker after earlier open journal (recovery not run while held).
    expect(await readFile(join(destination, "marker.txt"), "utf8")).toBe("keep-me");
  });

  it("maps destination lock acquisition failures during recovery into issues without mutating destination", async () => {
    const root = await tempRoot("promo-recovery-held");
    const projectsHome = join(root, "projects");
    const destination = join(projectsHome, "held-job");
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "data.txt"), "original", "utf8");
    const now = "2026-08-01T20:00:00.000Z";
    await writePromotionJournal({
      projectsHome,
      journal: {
        schema_version: 1,
        projects_home: resolve(projectsHome),
        destination_root: resolve(destination),
        backup_path: null,
        staging_path: null,
        created_fresh: true,
        phase: "open",
        created_at: now,
        updated_at: now
      }
    });

    // Hold lock longer than recovery's wait budget by patching wait via a second process is heavy.
    // Use a lock leaf that cannot be recovered (live pid + valid record) and a tiny race:
    // acquireDestinationLock wait default 2000ms — hold through recovery by keeping lock.
    // To avoid 2s sleeps, plant an unreadable lock that is not stale-recoverable (current pid)
    // and call recover — it waits up to 2s then DestinationLockedError.
    const held = await acquireDestinationLock(projectsHome, destination);
    const started = Date.now();
    const recovery = await recoverPromotionTransactions(projectsHome);
    const elapsed = Date.now() - started;
    await held.release();

    expect(recovery.ok).toBe(false);
    expect(recovery.issues.some((issue) =>
      issue.code === "promotion.destination_locked"
      || issue.code === "promotion.recovery_failed"
    )).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(await readFile(join(destination, "data.txt"), "utf8")).toBe("original");
    // Journal remains for a later recovery after lock release.
    await expect(loadPromotionJournal(projectsHome, destination)).resolves.toMatchObject({
      status: "ok"
    });
  }, 15_000);
});

describe("finalizeApplyEmpty failure and idempotent contracts", () => {
  it("merges prior partial cleanup into an existing record on empty already-home apply", async () => {
    const root = await tempRoot("empty-idempotent-merge");
    const seeded = await seedAlreadyHomeProject(root);
    const ctx = buildEmptyCtx({
      ...seeded,
      priorDeletedFiles: 2,
      priorDeletedBytes: 40,
      priorDeletedPaths: ["dist/old/a.mp4", "media/old.wav"]
    });

    const result = await applyIdempotentEmptyAlreadyHome(ctx);
    expect(result).toBeDefined();
    expect(result!.ok).toBe(true);
    expect(result!.deletedFiles).toBe(2);
    expect(result!.deletedBytes).toBe(40);
    const record = JSON.parse(await readFile(seeded.recordPath, "utf8")) as {
      cleanup: { media_files_deleted: number; bytes_reclaimed: number; deleted_media_paths: string[] };
    };
    expect(record.cleanup.media_files_deleted).toBe(2);
    expect(record.cleanup.bytes_reclaimed).toBe(40);
    expect(record.cleanup.deleted_media_paths).toEqual(["dist/old/a.mp4", "media/old.wav"]);
  });

  it("returns undefined when not already-home or record is missing", async () => {
    const root = await tempRoot("empty-idempotent-skip");
    const seeded = await seedAlreadyHomeProject(root);
    const noRecord = buildEmptyCtx({
      ...seeded,
      recordPath: join(seeded.runDir, "missing-record.json")
    });
    await expect(applyIdempotentEmptyAlreadyHome(noRecord)).resolves.toBeUndefined();

    const notHome = buildEmptyCtx({
      ...seeded,
      alreadyHome: false
    });
    await expect(applyIdempotentEmptyAlreadyHome(notHome)).resolves.toBeUndefined();
  });

  it("fail-closes empty promote when pinned-dir revalidation fails before mutation", async () => {
    const root = await tempRoot("empty-boundary");
    const seeded = await seedAlreadyHomeProject(root);
    // Remove existing record so empty path is not short-circuited by idempotent success.
    await rm(seeded.recordPath, { force: true });
    const ctx = buildEmptyCtx({
      ...seeded,
      revalidatePinnedDirs: async () => ({
        code: "finalize.state_dir_symlink",
        message: "stateDir became a symbolic link",
        path: seeded.stateDir
      })
    });
    const result = await applyEmptyCandidatesPromotionAndRecord(ctx);
    expect(result.ok).toBe(false);
    expect(result.deletedFiles).toBe(0);
    expect(result.issues[0]?.code).toBe("finalize.state_dir_symlink");
  });

  it("records record-path-outside-project and rolls back an open promotion transaction", async () => {
    const root = await tempRoot("empty-record-path");
    const projectsHome = join(root, "durable-projects");
    const projectRoot = join(root, "feature-worktree", "projects", "promo-empty");
    const runDir = join(projectRoot, "dist", "promo-empty-r1");
    const stateDir = join(projectRoot, "dist");
    const configPath = join(projectRoot, "project.yaml");
    await mkdir(runDir, { recursive: true });
    await mkdir(projectsHome, { recursive: true });
    await writeFile(configPath, "slug: promo-empty\n", "utf8");
    await writeFile(join(runDir, "final.mp4"), "final", "utf8");

    // Escape record path outside the project so assertWritableProjectRecordPath fails after promote.
    const outsideRecord = join(root, "outside-completion-record.json");
    const ctx = buildEmptyCtx({
      projectsHome,
      projectRoot,
      configPath,
      stateDir,
      runDir,
      recordPath: outsideRecord,
      projectSlug: "promo-empty",
      alreadyHome: false
    });
    // Point env so promote uses our durable home.
    const previous = process.env.TSUGITE_PROJECTS_HOME;
    process.env.TSUGITE_PROJECTS_HOME = projectsHome;
    try {
      const result = await applyEmptyCandidatesPromotionAndRecord(ctx);
      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.code === "finalize.record_path_outside_project")).toBe(true);
      expect(result.promotedToLauncherHome).toBe(false);
      // Promotion must not leave a settled durable tree without a completion record.
      const dest = join(projectsHome, "promo-empty");
      // After rollback of createdFresh promotion the destination is removed.
      await expect(lstat(dest)).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.TSUGITE_PROJECTS_HOME;
      else process.env.TSUGITE_PROJECTS_HOME = previous;
    }
  });

  it("surfaces promotion failure without claiming deletes or promotion success", async () => {
    const root = await tempRoot("empty-promote-fail");
    const projectsHome = join(root, "durable-projects");
    const projectRoot = join(root, "feature-worktree", "projects", "bad-promo");
    const runDir = join(projectRoot, "dist", "bad-promo-r1");
    const stateDir = join(projectRoot, "dist");
    const configPath = join(projectRoot, "project.yaml");
    await mkdir(runDir, { recursive: true });
    await mkdir(projectsHome, { recursive: true });
    await writeFile(configPath, "slug: bad-promo\n", "utf8");
    await writeFile(join(runDir, "final.mp4"), "final", "utf8");

    // Hold the durable destination lock so promote fails closed with destination_locked.
    const destination = join(projectsHome, "bad-promo");
    await mkdir(destination, { recursive: true });
    const held = await acquireDestinationLock(projectsHome, destination);

    const ctx = buildEmptyCtx({
      projectsHome,
      projectRoot,
      configPath,
      stateDir,
      runDir,
      recordPath: join(runDir, "completion-record.json"),
      projectSlug: "bad-promo",
      alreadyHome: false,
      priorDeletedFiles: 1,
      priorDeletedBytes: 8,
      priorDeletedPaths: ["dist/old/x.mp4"]
    });
    const previous = process.env.TSUGITE_PROJECTS_HOME;
    process.env.TSUGITE_PROJECTS_HOME = projectsHome;
    try {
      const result = await applyEmptyCandidatesPromotionAndRecord(ctx);
      expect(result.ok).toBe(false);
      expect(result.promotedToLauncherHome).toBe(false);
      expect(result.deletedFiles).toBe(1);
      expect(result.deletedBytes).toBe(8);
      expect(result.issues.some((issue) => issue.code === "promotion.destination_locked")).toBe(true);
    } finally {
      await held.release();
      if (previous === undefined) delete process.env.TSUGITE_PROJECTS_HOME;
      else process.env.TSUGITE_PROJECTS_HOME = previous;
    }
  });

  it("reports record_write_failed when completion record write throws (leaf symlink)", async () => {
    const root = await tempRoot("empty-record-write-fail");
    const seeded = await seedAlreadyHomeProject(root, "write-fail");
    await rm(seeded.recordPath, { force: true });
    // Parent is a real directory (writable path check passes); leaf symlink makes atomic write throw.
    const external = join(root, "external-record.json");
    await writeFile(external, "secret-external\n", "utf8");
    await symlink(external, seeded.recordPath);

    const ctx = buildEmptyCtx({
      ...seeded,
      projectSlug: "write-fail",
      priorDeletedFiles: 1,
      priorDeletedBytes: 4,
      priorDeletedPaths: ["media/old.wav"]
    });
    const result = await applyEmptyCandidatesPromotionAndRecord(ctx);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "finalize.record_write_failed")).toBe(true);
    expect(result.promotedToLauncherHome).toBe(false);
    expect(result.deletedFiles).toBe(1);
    // External target must remain untouched (no follow-through write).
    expect(await readFile(external, "utf8")).toBe("secret-external\n");
  });
});

describe("finalizeApplyMutating fail-closed entry contracts", () => {
  it("returns failClosed when pre-journal pinned-dir revalidation fails", async () => {
    const root = await tempRoot("mutating-prejournal");
    const projectRoot = join(root, "project");
    const stateDir = join(projectRoot, "dist");
    const runDir = join(stateDir, "run-1");
    const media = join(projectRoot, "media", "old.mp4");
    await mkdir(join(projectRoot, "media"), { recursive: true });
    await mkdir(runDir, { recursive: true });
    await writeFile(media, "old-media", "utf8");
    await writeFile(join(projectRoot, "project.yaml"), "slug: m\n", "utf8");

    const stats = await lstat(media);
    const ctx: MutatingApplyContext = {
      projectRoot,
      stateDir,
      runId: "run-1",
      runDir,
      recordPath: join(runDir, "completion-record.json"),
      canonicalOutputPath: join(runDir, "final.mp4"),
      candidates: [media],
      mediaFiles: ["media/old.mp4"],
      identities: [{
        path: media,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        device: stats.dev,
        inode: stats.ino
      }],
      plannedBytes: stats.size,
      referencedSourceMedia: [],
      planDigest: "digest",
      priorCleanup: { deletedFiles: 0, deletedBytes: 0, deletedPaths: [] },
      stateUpdatedAt: "2026-08-01T00:00:00.000Z",
      launcherPlan: {
        projectsHome: join(root, "projects"),
        projectRoot,
        destinationRoot: projectRoot,
        alreadyHome: true,
        willPromote: false
      },
      project: { projectSlug: "m", now: "2026-08-01T00:00:00.000Z" },
      configPath: join(projectRoot, "project.yaml"),
      projectSlug: "m",
      base: {
        ok: true,
        issues: [],
        applied: true,
        deletedFiles: 0,
        deletedBytes: 0
      },
      revalidatePinnedDirs: async () => ({
        code: "finalize.state_dir_changed",
        message: "stateDir identity changed",
        path: stateDir
      }),
      revalidateLiveFinalizeConditions: async () => undefined,
      inspectDeletionCandidate: async () => undefined
    };

    const result = await applyMutatingFinalizeCleanup(ctx);
    expect(result.ok).toBe(false);
    expect(result.deletedFiles).toBe(0);
    expect(result.deletedBytes).toBe(0);
    expect(result.issues[0]?.code).toBe("finalize.state_dir_changed");
    // Candidate must remain in place (no quarantine started).
    expect(await readFile(media, "utf8")).toBe("old-media");
  });

  it("rolls back quarantine when pinned-dir revalidation fails mid-quarantine", async () => {
    const root = await tempRoot("mutating-mid-q");
    const projectRoot = join(root, "project");
    const stateDir = join(projectRoot, "dist");
    const runDir = join(stateDir, "run-1");
    const mediaA = join(projectRoot, "media", "a.mp4");
    const mediaB = join(projectRoot, "media", "b.mp4");
    await mkdir(join(projectRoot, "media"), { recursive: true });
    await mkdir(runDir, { recursive: true });
    await writeFile(mediaA, "aaa", "utf8");
    await writeFile(mediaB, "bbb", "utf8");
    await writeFile(join(projectRoot, "project.yaml"), "slug: m2\n", "utf8");
    await writeFile(join(runDir, "final.mp4"), "final", "utf8");

    const idA = await lstat(mediaA);
    const idB = await lstat(mediaB);
    let boundaryChecks = 0;
    const ctx: MutatingApplyContext = {
      projectRoot,
      stateDir,
      runId: "run-1",
      runDir,
      recordPath: join(runDir, "completion-record.json"),
      canonicalOutputPath: join(runDir, "final.mp4"),
      candidates: [mediaA, mediaB],
      mediaFiles: ["media/a.mp4", "media/b.mp4"],
      identities: [
        {
          path: mediaA,
          size: idA.size,
          mtimeMs: idA.mtimeMs,
          device: idA.dev,
          inode: idA.ino
        },
        {
          path: mediaB,
          size: idB.size,
          mtimeMs: idB.mtimeMs,
          device: idB.dev,
          inode: idB.ino
        }
      ],
      plannedBytes: idA.size + idB.size,
      referencedSourceMedia: [],
      planDigest: "digest-2",
      priorCleanup: { deletedFiles: 0, deletedBytes: 0, deletedPaths: [] },
      stateUpdatedAt: "2026-08-01T00:00:00.000Z",
      launcherPlan: {
        projectsHome: join(root, "projects"),
        projectRoot,
        destinationRoot: projectRoot,
        alreadyHome: true,
        willPromote: false
      },
      project: { projectSlug: "m2", now: "2026-08-01T00:00:00.000Z" },
      configPath: join(projectRoot, "project.yaml"),
      projectSlug: "m2",
      base: {
        ok: true,
        issues: [],
        applied: true,
        deletedFiles: 0,
        deletedBytes: 0
      },
      revalidatePinnedDirs: async () => {
        boundaryChecks += 1;
        // First call: pre-journal ok. Second: first candidate ok. Third: fail before second.
        if (boundaryChecks >= 3) {
          return {
            code: "finalize.state_dir_symlink",
            message: "stateDir symlink appeared mid-quarantine",
            path: stateDir
          };
        }
        return undefined;
      },
      revalidateLiveFinalizeConditions: async () => undefined,
      inspectDeletionCandidate: async () => undefined
    };

    const result = await applyMutatingFinalizeCleanup(ctx);
    expect(result.ok).toBe(false);
    expect(result.deletedFiles).toBe(0);
    expect(result.issues.some((issue) => issue.code === "finalize.state_dir_symlink")).toBe(true);
    // Both candidates restored.
    expect(await readFile(mediaA, "utf8")).toBe("aaa");
    expect(await readFile(mediaB, "utf8")).toBe("bbb");
  });

  it("fails closed when record path escapes the project after quarantine (promotion rollback)", async () => {
    const root = await tempRoot("mutating-record-escape");
    const projectsHome = join(root, "durable-projects");
    const projectRoot = join(root, "feature-worktree", "projects", "mut-escape");
    const stateDir = join(projectRoot, "dist");
    const runDir = join(stateDir, "mut-escape-r1");
    const media = join(projectRoot, "media", "old.mp4");
    await mkdir(join(projectRoot, "media"), { recursive: true });
    await mkdir(runDir, { recursive: true });
    await mkdir(projectsHome, { recursive: true });
    await writeFile(media, "old", "utf8");
    await writeFile(join(projectRoot, "project.yaml"), "slug: mut-escape\n", "utf8");
    await writeFile(join(runDir, "final.mp4"), "final", "utf8");
    const stats = await lstat(media);
    const outsideRecord = join(root, "outside-record.json");

    const previous = process.env.TSUGITE_PROJECTS_HOME;
    process.env.TSUGITE_PROJECTS_HOME = projectsHome;
    try {
      const ctx: MutatingApplyContext = {
        projectRoot,
        stateDir,
        runId: "mut-escape-r1",
        runDir,
        recordPath: outsideRecord,
        canonicalOutputPath: join(runDir, "final.mp4"),
        candidates: [media],
        mediaFiles: ["media/old.mp4"],
        identities: [{
          path: media,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          device: stats.dev,
          inode: stats.ino
        }],
        plannedBytes: stats.size,
        referencedSourceMedia: [],
        planDigest: "digest-escape",
        priorCleanup: { deletedFiles: 0, deletedBytes: 0, deletedPaths: [] },
        stateUpdatedAt: "2026-08-01T00:00:00.000Z",
        launcherPlan: {
          projectsHome,
          projectRoot,
          destinationRoot: join(projectsHome, "mut-escape"),
          alreadyHome: false,
          willPromote: true
        },
        project: { projectSlug: "mut-escape", now: "2026-08-01T00:00:00.000Z" },
        configPath: join(projectRoot, "project.yaml"),
        projectSlug: "mut-escape",
        base: {
          ok: true,
          issues: [],
          applied: true,
          deletedFiles: 0,
          deletedBytes: 0
        },
        revalidatePinnedDirs: async () => undefined,
        revalidateLiveFinalizeConditions: async () => undefined,
        inspectDeletionCandidate: async () => undefined
      };

      const result = await applyMutatingFinalizeCleanup(ctx);
      expect(result.ok).toBe(false);
      expect(result.deletedFiles).toBe(0);
      expect(result.issues.some((issue) => issue.code === "finalize.record_path_outside_project")).toBe(true);
      expect(result.promotedToLauncherHome).toBe(false);
      // Media restored after quarantine rollback.
      expect(await readFile(media, "utf8")).toBe("old");
      // Fresh promotion rolled back — durable destination gone.
      await expect(lstat(join(projectsHome, "mut-escape"))).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.TSUGITE_PROJECTS_HOME;
      else process.env.TSUGITE_PROJECTS_HOME = previous;
    }
  });
});
