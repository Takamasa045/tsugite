import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureFinalizedProjectInLauncherHome,
  recoverPromotionTransactions,
  type PromotionTransactionTestHooks
} from "../src/project/projectsHome.js";
import {
  acquireDestinationLock,
  DestinationLockedError,
  destinationLockPath
} from "../src/project/destinationLock.js";
import {
  clearPromotionJournal,
  hasSymlinkAlongPath,
  hasSymlinkAncestor,
  loadPromotionJournal,
  parsePromotionJournalSchema,
  PROMOTION_BACKUP_PREFIX,
  PROMOTION_JOURNAL_DIR_NAME,
  PROMOTION_STAGING_PREFIX,
  promotionJournalPath,
  writePromotionJournal
} from "../src/project/promotionJournal.js";

async function seedWorktreeProject(root: string, slug: string, body = "new-final"): Promise<{
  projectsHome: string;
  projectRoot: string;
  configPath: string;
}> {
  const projectsHome = join(root, "durable-projects");
  const projectRoot = join(root, "feature-worktree", "projects", slug);
  const configPath = join(projectRoot, "project.yaml");
  const runDir = join(projectRoot, "dist", `${slug}-r1`);
  await mkdir(runDir, { recursive: true });
  await writeFile(configPath, `slug: ${slug}\n`, "utf8");
  await writeFile(join(runDir, "final.mp4"), body, "utf8");
  return { projectsHome, projectRoot, configPath };
}

async function promote(
  configPath: string,
  slug: string,
  projectsHome: string,
  hooks?: PromotionTransactionTestHooks
) {
  return ensureFinalizedProjectInLauncherHome({
    configPath,
    projectSlug: slug,
    apply: true,
    env: { TSUGITE_PROJECTS_HOME: projectsHome },
    now: "2026-08-01T00:00:00.000Z",
    _testHooks: hooks
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Simulate a crashed holder so recovery can reclaim a leftover destination lock. */
async function simulateDeadDestinationLock(
  projectsHome: string,
  destinationRoot: string
): Promise<void> {
  const lockPath = destinationLockPath(projectsHome, destinationRoot);
  await writeFile(
    lockPath,
    `${JSON.stringify({
      pid: 2_147_483_647,
      token: "dead-crash-sim",
      destination_root: resolve(destinationRoot),
      projects_home: resolve(projectsHome),
      acquired_at: new Date().toISOString()
    })}\n`,
    "utf8"
  );
}

describe("durable promotion transaction (Unit 7B)", () => {
  it("commits a createdFresh promotion and clears the journal without leftover backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-fresh-"));
    const { projectsHome, configPath } = await seedWorktreeProject(root, "fresh-job", "fresh-bytes");

    const applied = await promote(configPath, "fresh-job", projectsHome);
    expect(applied.ok).toBe(true);
    expect(applied.promoted).toBe(true);
    expect(applied.promotionTransaction?.createdFresh).toBe(true);
    expect(applied.promotionTransaction?.backupPath).toBeUndefined();

    const journalBefore = await loadPromotionJournal(projectsHome, applied.destinationRoot);
    expect(journalBefore.status).toBe("ok");
    if (journalBefore.status === "ok") {
      expect(journalBefore.journal.phase).toBe("open");
      expect(journalBefore.journal.created_fresh).toBe(true);
      expect(journalBefore.journal.backup_path).toBeNull();
    }

    await applied.promotionTransaction!.commit();
    expect(await readFile(join(projectsHome, "fresh-job", "dist", "fresh-job-r1", "final.mp4"), "utf8"))
      .toBe("fresh-bytes");
    await expect(loadPromotionJournal(projectsHome, applied.destinationRoot))
      .resolves.toMatchObject({ status: "missing" });
    const leftover = (await readdir(projectsHome)).filter((name) => name.startsWith(PROMOTION_BACKUP_PREFIX));
    expect(leftover).toEqual([]);
  });

  it("rolls back a createdFresh promotion by removing the destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-fresh-rb-"));
    const { projectsHome, configPath } = await seedWorktreeProject(root, "fresh-rb", "temp");

    const applied = await promote(configPath, "fresh-rb", projectsHome);
    expect(applied.ok).toBe(true);
    await applied.promotionTransaction!.rollback();

    await expect(stat(join(projectsHome, "fresh-rb"))).rejects.toThrow();
    await expect(loadPromotionJournal(projectsHome, applied.destinationRoot))
      .resolves.toMatchObject({ status: "missing" });
  });

  it("promotes through an existing same-source shelf symlink into a real durable tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-shelf-link-"));
    const { projectsHome, projectRoot, configPath } = await seedWorktreeProject(root, "shelf-link", "shelf-final");
    const shelf = join(projectsHome, "shelf-link");
    await mkdir(projectsHome, { recursive: true });
    await symlink(projectRoot, shelf, "dir");

    const applied = await promote(configPath, "shelf-link", projectsHome);
    expect(applied.ok).toBe(true);
    expect(applied.promoted).toBe(true);
    expect(applied.promotionTransaction?.createdFresh).toBe(false);
    expect(applied.promotionTransaction?.backupPath).toMatch(
      new RegExp(`${PROMOTION_BACKUP_PREFIX}shelf-link-`)
    );
    // Prior shelf link is preserved as the backup node (not followed/removed).
    expect((await lstat(applied.promotionTransaction!.backupPath!)).isSymbolicLink()).toBe(true);
    expect((await lstat(shelf)).isSymbolicLink()).toBe(false);
    expect(await readFile(join(shelf, "dist", "shelf-link-r1", "final.mp4"), "utf8")).toBe("shelf-final");

    await applied.promotionTransaction!.commit();
    await expect(loadPromotionJournal(projectsHome, applied.destinationRoot))
      .resolves.toMatchObject({ status: "missing" });
    const leftover = (await readdir(projectsHome)).filter((name) => name.startsWith(PROMOTION_BACKUP_PREFIX));
    expect(leftover).toEqual([]);
    // Source worktree remains intact after unlinking the backup shelf node.
    expect(await readFile(join(projectRoot, "dist", "shelf-link-r1", "final.mp4"), "utf8")).toBe("shelf-final");
  });

  it("backs up an existing destination, keeps it until commit, and restores on rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-backup-"));
    const { projectsHome, configPath, projectRoot } = await seedWorktreeProject(root, "myth", "new-v2");
    const existing = join(projectsHome, "myth");
    await mkdir(join(existing, "dist", "old"), { recursive: true });
    await writeFile(join(existing, "project.yaml"), "slug: myth\n", "utf8");
    await writeFile(join(existing, "dist", "old", "final.mp4"), "old-v1", "utf8");

    const applied = await promote(configPath, "myth", projectsHome);
    expect(applied.ok).toBe(true);
    expect(applied.promotionTransaction?.createdFresh).toBe(false);
    expect(applied.promotionTransaction?.backupPath).toMatch(new RegExp(`${PROMOTION_BACKUP_PREFIX}myth-`));
    expect(await readFile(join(projectsHome, "myth", "dist", "myth-r1", "final.mp4"), "utf8")).toBe("new-v2");
    expect(await readFile(join(applied.promotionTransaction!.backupPath!, "dist", "old", "final.mp4"), "utf8"))
      .toBe("old-v1");

    // Explicit rollback restores the prior durable tree.
    await applied.promotionTransaction!.rollback();
    expect(await readFile(join(projectsHome, "myth", "dist", "old", "final.mp4"), "utf8")).toBe("old-v1");
    await expect(stat(join(projectsHome, "myth", "dist", "myth-r1", "final.mp4"))).rejects.toThrow();
    await expect(loadPromotionJournal(projectsHome, applied.destinationRoot))
      .resolves.toMatchObject({ status: "missing" });

    // Promote again and commit — backup must disappear, new tree remains.
    await writeFile(join(projectRoot, "dist", "myth-r1", "final.mp4"), "new-v3", "utf8");
    const second = await promote(configPath, "myth", projectsHome);
    expect(second.ok).toBe(true);
    await second.promotionTransaction!.commit();
    expect(await readFile(join(projectsHome, "myth", "dist", "myth-r1", "final.mp4"), "utf8")).toBe("new-v3");
    const leftover = (await readdir(projectsHome)).filter((name) => name.startsWith(PROMOTION_BACKUP_PREFIX));
    expect(leftover).toEqual([]);
    await expect(loadPromotionJournal(projectsHome, second.destinationRoot))
      .resolves.toMatchObject({ status: "missing" });
  });

  it("propagates commit unlink failures without settling, then recovers by dropping the backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-commit-fail-"));
    const { projectsHome, configPath } = await seedWorktreeProject(root, "commit-fail", "new");
    const existing = join(projectsHome, "commit-fail");
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, "project.yaml"), "slug: commit-fail\n", "utf8");
    await writeFile(join(existing, "old.txt"), "prior", "utf8");

    const unlinkError = Object.assign(new Error("simulated backup unlink failure"), { code: "EACCES" });
    const applied = await promote(configPath, "commit-fail", projectsHome, {
      rm: async (path, options) => {
        if (String(path).includes(PROMOTION_BACKUP_PREFIX)) throw unlinkError;
        return rm(path, options);
      }
    });
    expect(applied.ok).toBe(true);
    const tx = applied.promotionTransaction!;
    await expect(tx.commit()).rejects.toThrow(/simulated backup unlink failure/);

    // Not settled: second commit still attempts work; journal stuck at committing.
    const journalAfterFail = await loadPromotionJournal(projectsHome, applied.destinationRoot);
    expect(journalAfterFail.status).toBe("ok");
    if (journalAfterFail.status === "ok") {
      expect(journalAfterFail.journal.phase).toBe("committing");
    }

    // Crash-recovery path finishes the commit by removing the leftover backup.
    const recovery = await recoverPromotionTransactions(projectsHome);
    expect(recovery.ok).toBe(true);
    expect(recovery.recovered).toBe(1);
    expect(await readFile(join(projectsHome, "commit-fail", "dist", "commit-fail-r1", "final.mp4"), "utf8"))
      .toBe("new");
    const leftover = (await readdir(projectsHome)).filter((name) => name.startsWith(PROMOTION_BACKUP_PREFIX));
    expect(leftover).toEqual([]);
    await expect(loadPromotionJournal(projectsHome, applied.destinationRoot))
      .resolves.toMatchObject({ status: "missing" });
  });

  it("propagates rollback rename failures without settling, then recovers by restoring the backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-rb-fail-"));
    const { projectsHome, configPath } = await seedWorktreeProject(root, "rb-fail", "new");
    const existing = join(projectsHome, "rb-fail");
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, "project.yaml"), "slug: rb-fail\n", "utf8");
    await writeFile(join(existing, "old.txt"), "prior-content", "utf8");

    const renameError = Object.assign(new Error("simulated restore rename failure"), { code: "EIO" });
    const applied = await promote(configPath, "rb-fail", projectsHome, {
      rename: async (from, to) => {
        if (String(from).includes(PROMOTION_BACKUP_PREFIX)) throw renameError;
        return rename(from, to);
      }
    });
    expect(applied.ok).toBe(true);
    const tx = applied.promotionTransaction!;
    const backupPath = tx.backupPath!;
    await expect(tx.rollback()).rejects.toThrow(/simulated restore rename failure/);

    // Destination was removed; backup still holds the prior tree; not settled.
    await expect(stat(join(projectsHome, "rb-fail"))).rejects.toThrow();
    expect(await readFile(join(backupPath, "old.txt"), "utf8")).toBe("prior-content");
    const journalAfterFail = await loadPromotionJournal(projectsHome, applied.destinationRoot);
    expect(journalAfterFail.status).toBe("ok");
    if (journalAfterFail.status === "ok") {
      expect(journalAfterFail.journal.phase).toBe("rolling_back");
    }

    const recovery = await recoverPromotionTransactions(projectsHome);
    expect(recovery.ok).toBe(true);
    expect(recovery.recovered).toBe(1);
    expect(await readFile(join(projectsHome, "rb-fail", "old.txt"), "utf8")).toBe("prior-content");
    await expect(stat(backupPath)).rejects.toThrow();
    await expect(loadPromotionJournal(projectsHome, applied.destinationRoot))
      .resolves.toMatchObject({ status: "missing" });
  });

  it("recovers an open promotion after a simulated post-promote crash by restoring the old tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-crash-"));
    const { projectsHome, configPath } = await seedWorktreeProject(root, "crash", "promoted-new");
    const existing = join(projectsHome, "crash");
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, "project.yaml"), "slug: crash\n", "utf8");
    await writeFile(join(existing, "kept.txt"), "old-durable", "utf8");

    const applied = await promote(configPath, "crash", projectsHome);
    expect(applied.ok).toBe(true);
    // Simulate process exit: drop the in-memory transaction without commit/rollback,
    // and mark the destination lock as a dead holder so recovery can reclaim it.
    expect(applied.promotionTransaction).toBeDefined();
    await simulateDeadDestinationLock(projectsHome, applied.destinationRoot);

    const journal = await loadPromotionJournal(projectsHome, applied.destinationRoot);
    expect(journal.status).toBe("ok");
    if (journal.status === "ok") expect(journal.journal.phase).toBe("open");

    // Next startup / ensure recovers open → rollback.
    const recoveredEnsure = await ensureFinalizedProjectInLauncherHome({
      configPath,
      projectSlug: "crash",
      apply: false,
      env: { TSUGITE_PROJECTS_HOME: projectsHome }
    });
    expect(recoveredEnsure.ok).toBe(true);
    expect(await readFile(join(projectsHome, "crash", "kept.txt"), "utf8")).toBe("old-durable");
    await expect(stat(join(projectsHome, "crash", "dist", "crash-r1", "final.mp4"))).rejects.toThrow();
    await expect(loadPromotionJournal(projectsHome, applied.destinationRoot))
      .resolves.toMatchObject({ status: "missing" });
  });

  it("refuses to act on a broken promotion journal (fail-closed)", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-broken-"));
    const projectsHome = join(root, "durable-projects");
    await mkdir(join(projectsHome, PROMOTION_JOURNAL_DIR_NAME), { recursive: true });
    const brokenPath = join(projectsHome, PROMOTION_JOURNAL_DIR_NAME, "broken.json");
    await writeFile(brokenPath, "{not-json", "utf8");

    // Place a real project sibling that must not be touched.
    const safe = join(projectsHome, "safe-job");
    await mkdir(safe, { recursive: true });
    await writeFile(join(safe, "project.yaml"), "slug: safe-job\n", "utf8");

    const recovery = await recoverPromotionTransactions(projectsHome);
    expect(recovery.ok).toBe(false);
    expect(recovery.issues.some((issue) => issue.code === "promotion.journal_invalid")).toBe(true);
    expect(await readFile(join(safe, "project.yaml"), "utf8")).toContain("safe-job");

    const { configPath } = await seedWorktreeProject(root, "blocked", "x");
    const blocked = await promote(configPath, "blocked", projectsHome);
    expect(blocked.ok).toBe(false);
    expect(blocked.issues.some((issue) => issue.code === "promotion.journal_invalid")).toBe(true);
  });

  it("refuses open-phase destination leaf symlinks; switching allows shelf links only as leaf", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-symlink-"));
    const projectsHome = join(root, "durable-projects");
    const realChild = join(projectsHome, "real-child");
    const linkChild = join(projectsHome, "link-child");
    const worktreeSource = join(root, "feature-worktree", "projects", "shelf-job");
    const shelfLink = join(projectsHome, "shelf-job");
    await mkdir(realChild, { recursive: true });
    await writeFile(join(realChild, "project.yaml"), "slug: real-child\n", "utf8");
    await mkdir(projectsHome, { recursive: true });
    await mkdir(worktreeSource, { recursive: true });
    await writeFile(join(worktreeSource, "project.yaml"), "slug: shelf-job\n", "utf8");
    await symlink(realChild, linkChild, "dir");
    await symlink(worktreeSource, shelfLink, "dir");

    const now = "2026-08-01T12:00:00.000Z";
    // Settled phases must never treat a leaf symlink as a durable destination.
    await expect(
      writePromotionJournal({
        projectsHome,
        journal: {
          schema_version: 1,
          projects_home: resolve(projectsHome),
          destination_root: resolve(linkChild),
          backup_path: null,
          staging_path: null,
          created_fresh: true,
          phase: "open",
          created_at: now,
          updated_at: now
        }
      })
    ).rejects.toMatchObject({ code: "promotion.journal_path_unsafe" });

    // Write-ahead switching journal may observe the pre-production shelf symlink
    // still at destination (before dest→backup rename). Link node only — no follow.
    const staging = join(projectsHome, `${PROMOTION_STAGING_PREFIX}shelf-job-staging`);
    const backup = join(projectsHome, `${PROMOTION_BACKUP_PREFIX}shelf-job-1`);
    await mkdir(staging, { recursive: true });
    const switching = await writePromotionJournal({
      projectsHome,
      journal: {
        schema_version: 1,
        projects_home: resolve(projectsHome),
        destination_root: resolve(shelfLink),
        backup_path: resolve(backup),
        staging_path: resolve(staging),
        created_fresh: false,
        phase: "switching",
        project_slug: "shelf-job",
        created_at: now,
        updated_at: now
      }
    });
    expect(switching.phase).toBe("switching");
    expect(switching.destination_root).toBe(resolve(shelfLink));
    expect((await lstat(shelfLink)).isSymbolicLink()).toBe(true);
    await clearPromotionJournal(projectsHome, shelfLink);
    await rm(staging, { recursive: true, force: true });

    // External backup path must be rejected.
    const external = join(root, "outside-backup");
    await mkdir(external, { recursive: true });
    await expect(
      writePromotionJournal({
        projectsHome,
        journal: {
          schema_version: 1,
          projects_home: resolve(projectsHome),
          destination_root: resolve(realChild),
          backup_path: resolve(external),
          staging_path: null,
          created_fresh: false,
          phase: "open",
          created_at: now,
          updated_at: now
        }
      })
    ).rejects.toMatchObject({ code: "promotion.journal_path_unsafe" });

    // Plant an invalid on-disk open-phase journal pointing at the leaf symlink and ensure recovery is fail-closed.
    await mkdir(join(projectsHome, PROMOTION_JOURNAL_DIR_NAME), { recursive: true });
    await writeFile(
      promotionJournalPath(projectsHome, linkChild),
      `${JSON.stringify({
        schema_version: 1,
        projects_home: resolve(projectsHome),
        destination_root: resolve(linkChild),
        backup_path: null,
        staging_path: null,
        created_fresh: true,
        phase: "open",
        created_at: now,
        updated_at: now
      }, null, 2)}\n`,
      "utf8"
    );
    const recovery = await recoverPromotionTransactions(projectsHome);
    expect(recovery.ok).toBe(false);
    expect(recovery.issues.some((issue) => issue.code === "promotion.journal_path_unsafe")).toBe(true);
    // Symlink target content must remain untouched.
    expect(await readFile(join(realChild, "project.yaml"), "utf8")).toContain("real-child");
    expect((await lstat(linkChild)).isSymbolicLink()).toBe(true);
  });

  it("does not mark settled when commit fails before backup removal completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-settled-"));
    const { projectsHome, configPath } = await seedWorktreeProject(root, "settled", "n");
    const existing = join(projectsHome, "settled");
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, "project.yaml"), "slug: settled\n", "utf8");

    let attempts = 0;
    const applied = await promote(configPath, "settled", projectsHome, {
      afterCommitPhase: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("hook abort before unlink");
      }
    });
    const tx = applied.promotionTransaction!;
    await expect(tx.commit()).rejects.toThrow(/hook abort before unlink/);
    // Retry succeeds once the hook stops failing — proves settled was not set early.
    await expect(tx.commit()).resolves.toBeUndefined();
    await expect(loadPromotionJournal(projectsHome, applied.destinationRoot))
      .resolves.toMatchObject({ status: "missing" });
  });

  it("clears committed/rolled_back journals on recovery and tolerates missing journal dirs", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-clear-"));
    const projectsHome = join(root, "durable-projects");
    const destination = join(projectsHome, "done-job");
    await mkdir(destination, { recursive: true });
    const now = "2026-08-01T15:00:00.000Z";

    await writePromotionJournal({
      projectsHome,
      journal: {
        schema_version: 1,
        projects_home: resolve(projectsHome),
        destination_root: resolve(destination),
        backup_path: null,
        staging_path: null,
        created_fresh: true,
        phase: "committed",
        created_at: now,
        updated_at: now
      }
    });
    const recovered = await recoverPromotionTransactions(projectsHome);
    expect(recovered.ok).toBe(true);
    expect(recovered.cleared).toBe(1);
    await expect(loadPromotionJournal(projectsHome, destination)).resolves.toMatchObject({ status: "missing" });

    // No journal directory at all.
    const emptyHome = join(root, "empty-home");
    await mkdir(emptyHome, { recursive: true });
    await expect(recoverPromotionTransactions(emptyHome)).resolves.toMatchObject({
      ok: true,
      recovered: 0,
      cleared: 0
    });

    // clear on missing path is a no-op.
    await expect(clearPromotionJournal(emptyHome, join(emptyHome, "x"))).resolves.toBeUndefined();
  });

  it("parses promotion journals fail-closed for schema and path mismatches", async () => {
    const journalPath = "/tmp/fake-journal.json";
    expect(parsePromotionJournalSchema(null, journalPath).ok).toBe(false);
    expect(parsePromotionJournalSchema([], journalPath).ok).toBe(false);
    expect(parsePromotionJournalSchema({ schema_version: 2 }, journalPath).ok).toBe(false);
    expect(parsePromotionJournalSchema({
      schema_version: 1,
      projects_home: "",
      destination_root: "/x",
      backup_path: null,
      staging_path: null,
      created_fresh: true,
      phase: "open",
      created_at: "t",
      updated_at: "t"
    }, journalPath).ok).toBe(false);
    expect(parsePromotionJournalSchema({
      schema_version: 1,
      projects_home: "/home",
      destination_root: "",
      backup_path: null,
      staging_path: null,
      created_fresh: true,
      phase: "open",
      created_at: "t",
      updated_at: "t"
    }, journalPath).ok).toBe(false);
    expect(parsePromotionJournalSchema({
      schema_version: 1,
      projects_home: "/home",
      destination_root: "/home/job",
      backup_path: 12,
      created_fresh: true,
      phase: "open",
      created_at: "t",
      updated_at: "t"
    }, journalPath).ok).toBe(false);
    expect(parsePromotionJournalSchema({
      schema_version: 1,
      projects_home: "/home",
      destination_root: "/home/job",
      backup_path: "/home/backup",
      created_fresh: true,
      phase: "open",
      created_at: "t",
      updated_at: "t"
    }, journalPath).ok).toBe(false);
    expect(parsePromotionJournalSchema({
      schema_version: 1,
      projects_home: "/home",
      destination_root: "/home/job",
      backup_path: null,
      staging_path: null,
      created_fresh: false,
      phase: "open",
      created_at: "t",
      updated_at: "t"
    }, journalPath).ok).toBe(false);
    expect(parsePromotionJournalSchema({
      schema_version: 1,
      projects_home: "/home",
      destination_root: "/home/job",
      backup_path: null,
      staging_path: null,
      created_fresh: "yes",
      phase: "open",
      created_at: "t",
      updated_at: "t"
    }, journalPath).ok).toBe(false);
    expect(parsePromotionJournalSchema({
      schema_version: 1,
      projects_home: "/home",
      destination_root: "/home/job",
      backup_path: null,
      staging_path: null,
      created_fresh: true,
      phase: "unknown",
      created_at: "t",
      updated_at: "t"
    }, journalPath).ok).toBe(false);
    expect(parsePromotionJournalSchema({
      schema_version: 1,
      projects_home: "/home",
      destination_root: "/home/job",
      backup_path: null,
      staging_path: null,
      created_fresh: true,
      phase: "open",
      project_slug: "",
      created_at: "t",
      updated_at: "t"
    }, journalPath).ok).toBe(false);
    expect(parsePromotionJournalSchema({
      schema_version: 1,
      projects_home: "/home",
      destination_root: "/home/job",
      backup_path: null,
      staging_path: null,
      created_fresh: true,
      phase: "open",
      created_at: 1,
      updated_at: "t"
    }, journalPath).ok).toBe(false);
    // Valid shape (path safety is checked separately).
    expect(parsePromotionJournalSchema({
      schema_version: 1,
      projects_home: "/home",
      destination_root: "/home/job",
      backup_path: null,
      staging_path: null,
      created_fresh: true,
      phase: "open",
      created_at: "t",
      updated_at: "t"
    }, journalPath).ok).toBe(true);

    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-parse-"));
    const projectsHome = join(root, "durable-projects");
    const destination = join(projectsHome, "weird folder");
    await mkdir(destination, { recursive: true });
    const now = "2026-08-01T16:00:00.000Z";
    // Odd destination basenames still get a stable journal file via hex fallback.
    await writePromotionJournal({
      projectsHome,
      journal: {
        schema_version: 1,
        projects_home: resolve(projectsHome),
        destination_root: resolve(destination),
        backup_path: null,
        staging_path: null,
        created_fresh: true,
        phase: "rolled_back",
        project_slug: "weird",
        created_at: now,
        updated_at: now
      }
    });
    const loaded = await loadPromotionJournal(projectsHome, destination);
    expect(loaded.status).toBe("ok");
    const recovery = await recoverPromotionTransactions(projectsHome);
    expect(recovery.cleared).toBe(1);

    // projects_home mismatch is unsafe.
    await mkdir(join(projectsHome, PROMOTION_JOURNAL_DIR_NAME), { recursive: true });
    await writeFile(
      promotionJournalPath(projectsHome, destination),
      `${JSON.stringify({
        schema_version: 1,
        projects_home: resolve(join(root, "other-home")),
        destination_root: resolve(destination),
        backup_path: null,
        staging_path: null,
        created_fresh: true,
        phase: "open",
        created_at: now,
        updated_at: now
      }, null, 2)}\n`,
      "utf8"
    );
    const mismatch = await loadPromotionJournal(projectsHome, destination);
    expect(mismatch.status).toBe("invalid");
  });

  it("detects symlink ancestors and refuses journal writes through leaf symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-anc-"));
    const projectsHome = join(root, "durable-projects");
    const realDir = join(projectsHome, "real");
    const mid = join(projectsHome, "mid");
    await mkdir(realDir, { recursive: true });
    await mkdir(projectsHome, { recursive: true });
    await symlink(realDir, mid, "dir");
    const nested = join(mid, "nested");
    await mkdir(join(realDir, "nested"), { recursive: true });

    expect(await hasSymlinkAncestor(projectsHome, nested)).toBe(true);
    expect(await hasSymlinkAlongPath(projectsHome, nested)).toBe(true);
    expect(await hasSymlinkAncestor(projectsHome, realDir)).toBe(false);

    // Journal leaf as symlink is refused.
    await mkdir(join(projectsHome, PROMOTION_JOURNAL_DIR_NAME), { recursive: true });
    const targetFile = join(projectsHome, PROMOTION_JOURNAL_DIR_NAME, "real-child.json");
    await writeFile(targetFile, "{}\n", "utf8");
    const linkJournal = join(projectsHome, PROMOTION_JOURNAL_DIR_NAME, "real-child.json.link");
    // Use destination basename that maps to a journal path we replace with a symlink.
    const dest = join(projectsHome, "leaf-dest");
    await mkdir(dest, { recursive: true });
    const journalFile = promotionJournalPath(projectsHome, dest);
    await symlink(targetFile, journalFile);
    await expect(
      writePromotionJournal({
        projectsHome,
        journal: {
          schema_version: 1,
          projects_home: resolve(projectsHome),
          destination_root: resolve(dest),
          backup_path: null,
          staging_path: null,
          created_fresh: true,
          phase: "open",
          created_at: "2026-08-01T17:00:00.000Z",
          updated_at: "2026-08-01T17:00:00.000Z"
        }
      })
    ).rejects.toMatchObject({ code: "promotion.journal_path_unsafe" });
    // External content behind the symlink stays intact.
    expect(await readFile(targetFile, "utf8")).toBe("{}\n");
    void linkJournal;
  });

  it("writes switching journal before the first destination→backup rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-wal-order-"));
    const { projectsHome, configPath } = await seedWorktreeProject(root, "wal-order", "new-bytes");
    const existing = join(projectsHome, "wal-order");
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, "project.yaml"), "slug: wal-order\n", "utf8");
    await writeFile(join(existing, "kept.txt"), "old-durable", "utf8");

    let sawSwitchingBeforeFirstBackupRename = false;
    const applied = await promote(configPath, "wal-order", projectsHome, {
      rename: async (from, to) => {
        // First dest→backup rename: destination still at from, backup at to.
        if (
          resolve(String(from)) === resolve(existing)
          && basename(String(to)).startsWith(PROMOTION_BACKUP_PREFIX)
        ) {
          const journal = await loadPromotionJournal(projectsHome, existing);
          expect(journal.status).toBe("ok");
          if (journal.status === "ok") {
            expect(journal.journal.phase).toBe("switching");
            expect(journal.journal.destination_root).toBe(resolve(existing));
            expect(journal.journal.backup_path).toBe(resolve(String(to)));
            expect(journal.journal.staging_path).toEqual(expect.any(String));
            expect(journal.journal.created_fresh).toBe(false);
            // Destination must still be the old tree when the write-ahead journal is durable.
            expect(await readFile(join(existing, "kept.txt"), "utf8")).toBe("old-durable");
            sawSwitchingBeforeFirstBackupRename = true;
          }
        }
        return rename(from, to);
      }
    });
    expect(applied.ok).toBe(true);
    expect(sawSwitchingBeforeFirstBackupRename).toBe(true);
    // After a successful switch the journal settles at open (switch complete).
    const openJournal = await loadPromotionJournal(projectsHome, applied.destinationRoot);
    expect(openJournal.status).toBe("ok");
    if (openJournal.status === "ok") {
      expect(openJournal.journal.phase).toBe("open");
      expect(openJournal.journal.staging_path).toBeNull();
    }
    await applied.promotionTransaction!.rollback();
  });

  it("recovers switching crash after first rename without losing the prior destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-switch-a-"));
    const projectsHome = join(root, "durable-projects");
    const destination = join(projectsHome, "switch-a");
    const backup = join(projectsHome, `${PROMOTION_BACKUP_PREFIX}switch-a-1`);
    const staging = join(projectsHome, `.promote-switch-a-crash`);
    await mkdir(join(destination), { recursive: true });
    await writeFile(join(destination, "kept.txt"), "prior-a", "utf8");
    await mkdir(join(staging, "project"), { recursive: true });
    await writeFile(join(staging, "project", "new.txt"), "staged-new", "utf8");
    // Crash after first rename: dest gone, backup holds prior, staging still present.
    await rename(destination, backup);
    const now = "2026-08-01T19:00:00.000Z";
    await writePromotionJournal({
      projectsHome,
      journal: {
        schema_version: 1,
        projects_home: resolve(projectsHome),
        destination_root: resolve(destination),
        backup_path: resolve(backup),
        staging_path: resolve(staging),
        created_fresh: false,
        phase: "switching",
        created_at: now,
        updated_at: now
      }
    });

    const recovery = await recoverPromotionTransactions(projectsHome);
    expect(recovery.ok).toBe(true);
    expect(recovery.recovered).toBe(1);
    expect(await readFile(join(destination, "kept.txt"), "utf8")).toBe("prior-a");
    await expect(stat(backup)).rejects.toThrow();
    await expect(stat(staging)).rejects.toThrow();
    await expect(loadPromotionJournal(projectsHome, destination)).resolves.toMatchObject({ status: "missing" });

    // Idempotent second recovery is a no-op.
    const again = await recoverPromotionTransactions(projectsHome);
    expect(again.ok).toBe(true);
    expect(again.recovered).toBe(0);
    expect(await readFile(join(destination, "kept.txt"), "utf8")).toBe("prior-a");
  });

  it("recovers switching crash between renames and after destination switch", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-switch-bc-"));
    const projectsHome = join(root, "durable-projects");
    const now = "2026-08-01T19:30:00.000Z";

    // (b) Between renames: same topology as after first rename (dest missing).
    const destB = join(projectsHome, "switch-b");
    const backupB = join(projectsHome, `${PROMOTION_BACKUP_PREFIX}switch-b-1`);
    const stagingB = join(projectsHome, `.promote-switch-b-mid`);
    await mkdir(backupB, { recursive: true });
    await writeFile(join(backupB, "kept.txt"), "prior-b", "utf8");
    await mkdir(join(stagingB, "project"), { recursive: true });
    await writeFile(join(stagingB, "project", "new.txt"), "staged-b", "utf8");
    await writePromotionJournal({
      projectsHome,
      journal: {
        schema_version: 1,
        projects_home: resolve(projectsHome),
        destination_root: resolve(destB),
        backup_path: resolve(backupB),
        staging_path: resolve(stagingB),
        created_fresh: false,
        phase: "switching",
        project_slug: "switch-b",
        created_at: now,
        updated_at: now
      }
    });

    // (c) Right after switch: new dest in place, backup still held, staging may be empty/partial.
    const destC = join(projectsHome, "switch-c");
    const backupC = join(projectsHome, `${PROMOTION_BACKUP_PREFIX}switch-c-1`);
    const stagingC = join(projectsHome, `.promote-switch-c-done`);
    await mkdir(destC, { recursive: true });
    await writeFile(join(destC, "new.txt"), "promoted-c", "utf8");
    await mkdir(backupC, { recursive: true });
    await writeFile(join(backupC, "kept.txt"), "prior-c", "utf8");
    await mkdir(stagingC, { recursive: true });
    await writePromotionJournal({
      projectsHome,
      journal: {
        schema_version: 1,
        projects_home: resolve(projectsHome),
        destination_root: resolve(destC),
        backup_path: resolve(backupC),
        staging_path: resolve(stagingC),
        created_fresh: false,
        phase: "switching",
        project_slug: "switch-c",
        created_at: now,
        updated_at: now
      }
    });

    const recovery = await recoverPromotionTransactions(projectsHome);
    expect(recovery.ok).toBe(true);
    expect(recovery.recovered).toBe(2);
    expect(await readFile(join(destB, "kept.txt"), "utf8")).toBe("prior-b");
    expect(await readFile(join(destC, "kept.txt"), "utf8")).toBe("prior-c");
    await expect(stat(join(destC, "new.txt"))).rejects.toThrow();
    await expect(stat(backupB)).rejects.toThrow();
    await expect(stat(backupC)).rejects.toThrow();
    await expect(stat(stagingB)).rejects.toThrow();
    await expect(stat(stagingC)).rejects.toThrow();
  });

  it("rejects nested destinations/backups and recovers idempotently when rename already finished", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-nested-"));
    const projectsHome = join(root, "durable-projects");
    const destination = join(projectsHome, "nested-job");
    await mkdir(destination, { recursive: true });
    const now = "2026-08-01T18:00:00.000Z";

    await expect(
      writePromotionJournal({
        projectsHome,
        journal: {
          schema_version: 1,
          projects_home: resolve(projectsHome),
          destination_root: resolve(join(destination, "child")),
          backup_path: null,
          staging_path: null,
          created_fresh: true,
          phase: "open",
          created_at: now,
          updated_at: now
        }
      })
    ).rejects.toMatchObject({ code: "promotion.journal_path_unsafe" });

    await expect(
      writePromotionJournal({
        projectsHome,
        journal: {
          schema_version: 1,
          projects_home: resolve(projectsHome),
          destination_root: resolve(destination),
          backup_path: resolve(join(projectsHome, "not-a-backup-name")),
          staging_path: null,
          created_fresh: false,
          phase: "open",
          created_at: now,
          updated_at: now
        }
      })
    ).rejects.toMatchObject({ code: "promotion.journal_path_unsafe" });

    // rolling_back with backup already renamed into destination → recovery clears journal only.
    const backupName = `${PROMOTION_BACKUP_PREFIX}nested-job-1`;
    const backupPath = join(projectsHome, backupName);
    await mkdir(backupPath, { recursive: true });
    await writeFile(join(backupPath, "marker.txt"), "restored", "utf8");
    await writePromotionJournal({
      projectsHome,
      journal: {
        schema_version: 1,
        projects_home: resolve(projectsHome),
        destination_root: resolve(destination),
        backup_path: resolve(backupPath),
        staging_path: null,
        created_fresh: false,
        phase: "rolling_back",
        created_at: now,
        updated_at: now
      }
    });
    // Simulate completed rename: backup moved to destination.
    await rm(destination, { recursive: true, force: true });
    await rename(backupPath, destination);
    const recovery = await recoverPromotionTransactions(projectsHome);
    expect(recovery.ok).toBe(true);
    expect(recovery.recovered).toBe(1);
    expect(await readFile(join(destination, "marker.txt"), "utf8")).toBe("restored");
    await expect(loadPromotionJournal(projectsHome, destination)).resolves.toMatchObject({ status: "missing" });
  });

  it("BLOCK: open-phase active transaction keeps destination lock until commit/rollback settles", async () => {
    // Repro: A reaches phase=open then (buggy) releases the destination lock before
    // returning promotionTransaction. While A is still open, B recovery rolls A's
    // journal back and B promote installs a new tree. A.commit then either clears B's
    // journal / restores A's backup while reporting success, or both report ok with
    // only B's tree left and A's journal missing. Fail closed: B cannot intervene.
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-open-lock-gap-"));
    const { projectsHome, configPath } = await seedWorktreeProject(root, "open-gap", "bytes-a");
    const dest = join(projectsHome, "open-gap");
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "project.yaml"), "slug: open-gap\n", "utf8");
    await writeFile(join(dest, "prior.txt"), "prior-durable", "utf8");

    const bRoot = join(root, "feature-worktree-b", "projects", "open-gap");
    const bConfig = join(bRoot, "project.yaml");
    const bRun = join(bRoot, "dist", "open-gap-r1");
    await mkdir(bRun, { recursive: true });
    await writeFile(bConfig, "slug: open-gap\n", "utf8");
    await writeFile(join(bRun, "final.mp4"), "bytes-b", "utf8");

    const appliedA = await promote(configPath, "open-gap", projectsHome);
    expect(appliedA.ok).toBe(true);
    expect(appliedA.promoted).toBe(true);
    const journalA = await loadPromotionJournal(projectsHome, dest);
    expect(journalA.status).toBe("ok");
    if (journalA.status === "ok") {
      expect(journalA.journal.phase).toBe("open");
      expect(journalA.journal.created_at).toBe("2026-08-01T00:00:00.000Z");
    }
    const aBackup = appliedA.promotionTransaction?.backupPath;
    expect(aBackup).toBeTruthy();

    // Active open holder must still own the destination lock (fail closed for peers).
    await expect(acquireDestinationLock(projectsHome, dest)).rejects.toBeInstanceOf(DestinationLockedError);

    const recoveryWhileAOpen = await recoverPromotionTransactions(projectsHome);
    expect(recoveryWhileAOpen.ok).toBe(false);
    expect(recoveryWhileAOpen.recovered).toBe(0);
    expect(recoveryWhileAOpen.issues.some((issue) =>
      issue.code === "promotion.destination_locked"
      || issue.code === "promotion.recovery_failed"
    )).toBe(true);

    const appliedB = await promote(bConfig, "open-gap", projectsHome);
    expect(appliedB.ok).toBe(false);
    expect(appliedB.promoted).toBe(false);
    expect(appliedB.promotionTransaction).toBeUndefined();
    expect(appliedB.issues.some((issue) => issue.code === "promotion.destination_locked")).toBe(true);

    // A's journal/backup/destination must be untouched by the rejected peers.
    const journalStillA = await loadPromotionJournal(projectsHome, dest);
    expect(journalStillA.status).toBe("ok");
    if (journalStillA.status === "ok") {
      expect(journalStillA.journal.phase).toBe("open");
      expect(journalStillA.journal.created_at).toBe("2026-08-01T00:00:00.000Z");
      expect(journalStillA.journal.backup_path).toBe(resolve(aBackup!));
    }
    expect(await readFile(join(dest, "dist", "open-gap-r1", "final.mp4"), "utf8")).toBe("bytes-a");
    expect(await readFile(join(aBackup!, "prior.txt"), "utf8")).toBe("prior-durable");

    await appliedA.promotionTransaction!.commit();
    expect(await readFile(join(dest, "dist", "open-gap-r1", "final.mp4"), "utf8")).toBe("bytes-a");
    await expect(loadPromotionJournal(projectsHome, dest)).resolves.toMatchObject({ status: "missing" });
    await expect(stat(aBackup!)).rejects.toThrow();
    // After settle, a new promote may proceed.
    const appliedBAfter = await promote(bConfig, "open-gap", projectsHome);
    expect(appliedBAfter.ok).toBe(true);
    await appliedBAfter.promotionTransaction!.commit();
    expect(await readFile(join(dest, "dist", "open-gap-r1", "final.mp4"), "utf8")).toBe("bytes-b");
  }, 15_000);

  it("BLOCK: commit refuses to clear a foreign journal when ownership identity diverges", async () => {
    // Defense in depth if a lock gap ever reappears: clear/persist must not delete
    // another transaction's journal by destination path alone.
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-foreign-journal-"));
    const { projectsHome, configPath } = await seedWorktreeProject(root, "foreign-j", "bytes-a");
    const dest = join(projectsHome, "foreign-j");
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "project.yaml"), "slug: foreign-j\n", "utf8");
    await writeFile(join(dest, "prior.txt"), "prior", "utf8");

    const appliedA = await promote(configPath, "foreign-j", projectsHome);
    expect(appliedA.ok).toBe(true);
    const tx = appliedA.promotionTransaction!;

    // Replace on-disk journal with a different transaction identity (same destination).
    // Backup stays destination-slug-bound (legacy numeric) but created_at/path differ.
    const foreignBackup = join(projectsHome, `${PROMOTION_BACKUP_PREFIX}foreign-j-9999`);
    await mkdir(foreignBackup, { recursive: true });
    await writeFile(join(foreignBackup, "other.txt"), "other-backup", "utf8");
    await writePromotionJournal({
      projectsHome,
      journal: {
        schema_version: 1,
        projects_home: resolve(projectsHome),
        destination_root: resolve(dest),
        backup_path: resolve(foreignBackup),
        staging_path: null,
        created_fresh: false,
        phase: "open",
        project_slug: "foreign-j",
        transaction_id: undefined,
        created_at: "2099-01-01T00:00:00.000Z",
        updated_at: "2099-01-01T00:00:00.000Z"
      }
    });

    await expect(tx.commit()).rejects.toThrow(/foreign|ownership|identity|journal/i);
    // Foreign journal and its backup must remain; A's commit must not settle as success.
    const stillForeign = await loadPromotionJournal(projectsHome, dest);
    expect(stillForeign.status).toBe("ok");
    if (stillForeign.status === "ok") {
      expect(stillForeign.journal.created_at).toBe("2099-01-01T00:00:00.000Z");
      expect(stillForeign.journal.backup_path).toBe(resolve(foreignBackup));
    }
    expect(await readFile(join(foreignBackup, "other.txt"), "utf8")).toBe("other-backup");
    // A's own backup path must not have been removed by the aborted commit.
    if (tx.backupPath) {
      expect(await pathExists(tx.backupPath)).toBe(true);
    }
  });

  it("HIGH: concurrent promote to the same destination rejects one side without corrupting journal/backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-concurrent-"));
    const projectsHome = join(root, "durable-projects");
    // Seed two independent worktrees that both target the same durable slug/destination.
    const a = await seedWorktreeProject(root, "shared-dest", "bytes-a");
    // Force both to the same projects home and same destination name.
    const bRoot = join(root, "feature-worktree-b", "projects", "shared-dest");
    const bConfig = join(bRoot, "project.yaml");
    const bRun = join(bRoot, "dist", "shared-dest-r1");
    await mkdir(bRun, { recursive: true });
    await writeFile(bConfig, "slug: shared-dest\n", "utf8");
    await writeFile(join(bRun, "final.mp4"), "bytes-b", "utf8");

    // Hold the destination lock so both promotes contend deterministically.
    const dest = join(projectsHome, "shared-dest");
    const held = await acquireDestinationLock(projectsHome, dest);
    try {
      const [first, second] = await Promise.all([
        promote(a.configPath, "shared-dest", projectsHome),
        promote(bConfig, "shared-dest", projectsHome)
      ]);
      const results = [first, second];
      const locked = results.filter((result) =>
        result.issues.some((issue) => issue.code === "promotion.destination_locked")
      );
      const succeeded = results.filter((result) => result.ok);
      expect(locked.length).toBe(2);
      expect(succeeded.length).toBe(0);
      // No promotion journal/backup partials while the external holder owns the lock.
      await expect(loadPromotionJournal(projectsHome, dest)).resolves.toMatchObject({ status: "missing" });
      const leftovers = (await readdir(projectsHome)).filter((name) =>
        name.startsWith(PROMOTION_BACKUP_PREFIX) || name.startsWith(".promote-")
      );
      expect(leftovers).toEqual([]);
    } finally {
      await held.release();
    }
  });

  it("HIGH: sequential promote to the same destination succeeds after prior commit releases the lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-sequential-"));
    const { projectsHome, configPath } = await seedWorktreeProject(root, "seq-dest", "v1");

    const first = await promote(configPath, "seq-dest", projectsHome);
    expect(first.ok).toBe(true);
    expect(first.promoted).toBe(true);
    await first.promotionTransaction!.commit();
    await expect(readFile(join(projectsHome, "seq-dest", "dist", "seq-dest-r1", "final.mp4"), "utf8"))
      .resolves.toBe("v1");

    // Second worktree revision promotes after the first settled.
    const secondRoot = join(root, "feature-worktree-2", "projects", "seq-dest");
    const secondConfig = join(secondRoot, "project.yaml");
    const secondRun = join(secondRoot, "dist", "seq-dest-r1");
    await mkdir(secondRun, { recursive: true });
    await writeFile(secondConfig, "slug: seq-dest\n", "utf8");
    await writeFile(join(secondRun, "final.mp4"), "v2", "utf8");

    const second = await promote(secondConfig, "seq-dest", projectsHome);
    expect(second.ok).toBe(true);
    expect(second.promoted).toBe(true);
    await second.promotionTransaction!.commit();
    await expect(readFile(join(projectsHome, "seq-dest", "dist", "seq-dest-r1", "final.mp4"), "utf8"))
      .resolves.toBe("v2");
    await expect(loadPromotionJournal(projectsHome, second.destinationRoot))
      .resolves.toMatchObject({ status: "missing" });
  });

  it("HIGH: recovery waits for destination lock then finishes without corrupting journal state", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-recovery-lock-"));
    const { projectsHome, configPath } = await seedWorktreeProject(root, "recover-lock", "stable");
    // Pre-seed durable destination so promote keeps a backup (non-fresh open journal).
    const dest = join(projectsHome, "recover-lock");
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "project.yaml"), "slug: recover-lock\n", "utf8");
    await writeFile(join(dest, "prior.txt"), "prior-durable", "utf8");

    const applied = await promote(configPath, "recover-lock", projectsHome);
    expect(applied.ok).toBe(true);
    expect(applied.promotionTransaction?.createdFresh).toBe(false);
    // Active open transaction holds the destination lock. Simulate a crash (dead holder)
    // so an external waiter can acquire, then recovery must wait for that waiter.
    await simulateDeadDestinationLock(projectsHome, dest);
    const recordPath = join(dest, "dist", "recover-lock-r1", "completion-record.json");
    await mkdir(join(dest, "dist", "recover-lock-r1"), { recursive: true });
    await writeFile(recordPath, JSON.stringify({ ok: true, note: "audit" }), "utf8");

    const journal = await loadPromotionJournal(projectsHome, dest);
    expect(journal.status).toBe("ok");

    const held = await acquireDestinationLock(projectsHome, dest);
    const recoveryPromise = recoverPromotionTransactions(projectsHome);
    // Give recovery a moment to block on the lock, then release.
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    await held.release();
    const recovery = await recoveryPromise;
    expect(recovery.ok).toBe(true);
    expect(recovery.recovered).toBe(1);
    // Open uncommitted promotion rolls back to the prior durable tree; journal cleared.
    await expect(loadPromotionJournal(projectsHome, dest)).resolves.toMatchObject({ status: "missing" });
    expect(await readFile(join(dest, "prior.txt"), "utf8")).toBe("prior-durable");
    // The provisional completion-record on the promoted tree is gone with the rollback.
    await expect(stat(recordPath)).rejects.toThrow();
  });

  it("BLOCK: reloads journal after destination lock — open→committing during wait keeps NEW (commit recovery)", async () => {
    // Race: recovery discovers phase=open, then waits for destination lock while a live
    // promote advances the same journal to phase=committing (switch already applied).
    // Stale open snapshot would rollback and destroy NEW; post-lock reload must commit.
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-reload-race-"));
    const { projectsHome, configPath } = await seedWorktreeProject(root, "reload-race", "NEW-bytes");
    const dest = join(projectsHome, "reload-race");
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "project.yaml"), "slug: reload-race\n", "utf8");
    await writeFile(join(dest, "prior.txt"), "OLD-bytes", "utf8");

    const applied = await promote(configPath, "reload-race", projectsHome);
    expect(applied.ok).toBe(true);
    expect(applied.promotionTransaction?.createdFresh).toBe(false);
    const backupPath = applied.promotionTransaction!.backupPath!;
    expect(await readFile(join(dest, "dist", "reload-race-r1", "final.mp4"), "utf8")).toBe("NEW-bytes");
    expect(await readFile(join(backupPath, "prior.txt"), "utf8")).toBe("OLD-bytes");

    // Crash the in-memory holder so recovery can later reclaim; keep journal open on disk.
    await simulateDeadDestinationLock(projectsHome, dest);
    const initial = await loadPromotionJournal(projectsHome, dest);
    expect(initial.status).toBe("ok");
    if (initial.status !== "ok") throw new Error("expected open journal");
    expect(initial.journal.phase).toBe("open");
    const journalPath = initial.journalPath;

    let resolveSawOpenLoad: () => void;
    const sawOpenLoad = new Promise<void>((resolveSaw) => {
      resolveSawOpenLoad = resolveSaw;
    });
    let resolveAllowAcquire: () => void;
    const allowAcquire = new Promise<void>((resolveAllow) => {
      resolveAllowAcquire = resolveAllow;
    });

    // External holder blocks recovery after its initial journal discovery.
    const held = await acquireDestinationLock(projectsHome, dest);
    const recoveryPromise = recoverPromotionTransactions(projectsHome, {
      _testHooks: {
        afterInitialLoadBeforeLock: async ({ journal, journalPath: path }) => {
          expect(path).toBe(journalPath);
          expect(journal.phase).toBe("open");
          resolveSawOpenLoad();
          // Stay blocked here until the test rewrites the journal to committing.
          await allowAcquire;
        }
      }
    });

    await sawOpenLoad;
    // Live promote path: same identity, phase advanced to committing while recovery waits.
    await writePromotionJournal({
      projectsHome,
      journal: {
        ...initial.journal,
        phase: "committing",
        staging_path: null,
        updated_at: "2026-08-01T00:00:01.000Z"
      }
    });
    const midWait = await loadPromotionJournal(projectsHome, dest);
    expect(midWait.status).toBe("ok");
    if (midWait.status === "ok") expect(midWait.journal.phase).toBe("committing");

    resolveAllowAcquire!();
    await held.release();
    const recovery = await recoveryPromise;

    expect(recovery.ok).toBe(true);
    expect(recovery.recovered).toBe(1);
    expect(recovery.cleared).toBe(0);
    // Commit recovery: NEW destination kept, backup dropped, journal cleared.
    expect(await readFile(join(dest, "dist", "reload-race-r1", "final.mp4"), "utf8")).toBe("NEW-bytes");
    await expect(stat(join(dest, "prior.txt"))).rejects.toThrow();
    expect(await pathExists(backupPath)).toBe(false);
    await expect(loadPromotionJournal(projectsHome, dest)).resolves.toMatchObject({ status: "missing" });
  });

  it("BLOCK: post-lock journal reload fail-closes on missing / invalid / transaction_id swap", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-reload-fail-"));
    const projectsHome = join(root, "durable-projects");
    const dest = join(projectsHome, "reload-fail");
    const backup = join(projectsHome, `${PROMOTION_BACKUP_PREFIX}reload-fail--tx1`);
    const now = "2026-08-01T22:00:00.000Z";
    await mkdir(join(dest, "dist"), { recursive: true });
    await writeFile(join(dest, "marker.txt"), "NEW-keep", "utf8");
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, "prior.txt"), "OLD", "utf8");

    const baseJournal = {
      schema_version: 1 as const,
      projects_home: resolve(projectsHome),
      destination_root: resolve(dest),
      backup_path: resolve(backup),
      staging_path: null as string | null,
      created_fresh: false,
      phase: "open" as const,
      project_slug: "reload-fail",
      transaction_id: "tx1",
      created_at: now,
      updated_at: now
    };
    await writePromotionJournal({ projectsHome, journal: baseJournal });
    const journalPath = promotionJournalPath(projectsHome, dest);

    async function recoverAfterMutate(
      mutate: () => Promise<void>
    ): Promise<Awaited<ReturnType<typeof recoverPromotionTransactions>>> {
      let resolveSaw: () => void;
      const saw = new Promise<void>((resolvePromise) => {
        resolveSaw = resolvePromise;
      });
      let resolveGo: () => void;
      const go = new Promise<void>((resolvePromise) => {
        resolveGo = resolvePromise;
      });
      const recoveryPromise = recoverPromotionTransactions(projectsHome, {
        _testHooks: {
          afterInitialLoadBeforeLock: async () => {
            resolveSaw!();
            await go;
          }
        }
      });
      await saw;
      await mutate();
      resolveGo!();
      return recoveryPromise;
    }

    // Missing after discovery: no rollback of NEW.
    const missing = await recoverAfterMutate(async () => {
      await rm(journalPath, { force: true });
    });
    expect(missing.ok).toBe(false);
    expect(missing.recovered).toBe(0);
    expect(missing.issues.some((issue) =>
      issue.code === "promotion.journal_invalid"
      && /disappeared after destination lock/i.test(issue.message)
    )).toBe(true);
    expect(await readFile(join(dest, "marker.txt"), "utf8")).toBe("NEW-keep");
    expect(await pathExists(backup)).toBe(true);

    // Invalid JSON after discovery: fail-closed, trees untouched.
    await writePromotionJournal({ projectsHome, journal: baseJournal });
    const invalid = await recoverAfterMutate(async () => {
      await writeFile(journalPath, "{not-json", "utf8");
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.recovered).toBe(0);
    expect(invalid.issues.some((issue) => issue.code === "promotion.journal_invalid")).toBe(true);
    expect(await readFile(join(dest, "marker.txt"), "utf8")).toBe("NEW-keep");
    expect(await pathExists(backup)).toBe(true);

    // Same destination but swapped transaction_id (and matching backup name): identity fail-closed.
    const swappedBackup = join(projectsHome, `${PROMOTION_BACKUP_PREFIX}reload-fail--tx2`);
    await mkdir(swappedBackup, { recursive: true });
    await writeFile(join(swappedBackup, "prior.txt"), "OTHER", "utf8");
    await writePromotionJournal({ projectsHome, journal: baseJournal });
    const swapped = await recoverAfterMutate(async () => {
      await writePromotionJournal({
        projectsHome,
        journal: {
          ...baseJournal,
          backup_path: resolve(swappedBackup),
          transaction_id: "tx2",
          phase: "committing",
          updated_at: "2026-08-01T22:00:01.000Z"
        }
      });
    });
    expect(swapped.ok).toBe(false);
    expect(swapped.recovered).toBe(0);
    expect(swapped.issues.some((issue) =>
      issue.code === "promotion.journal_identity_mismatch"
      && /transaction_id changed/i.test(issue.message)
    )).toBe(true);
    expect(await readFile(join(dest, "marker.txt"), "utf8")).toBe("NEW-keep");
    expect(await pathExists(backup)).toBe(true);
    expect(await pathExists(swappedBackup)).toBe(true);
    expect(await pathExists(journalPath)).toBe(true);
  });

  it("HIGH: destination lock rejects concurrent second holder and exposes lock path", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-dest-lock-unit-"));
    const projectsHome = join(root, "projects");
    const destinationRoot = join(projectsHome, "job-a");
    await mkdir(destinationRoot, { recursive: true });

    const first = await acquireDestinationLock(projectsHome, destinationRoot);
    await expect(acquireDestinationLock(projectsHome, destinationRoot))
      .rejects.toBeInstanceOf(DestinationLockedError);
    expect(destinationLockPath(projectsHome, destinationRoot)).toContain(PROMOTION_JOURNAL_DIR_NAME);
    await first.release();
    const second = await acquireDestinationLock(projectsHome, destinationRoot);
    await second.release();
  });

  it("BLOCK: job-a tampered journal never mutates job-b backup/staging/destination/sentinel", async () => {
    // Repro: job-a journal can name a job-b-format backup (prefix only, wrong slug).
    // Recovery historically treated that as success and deleted/restored job-b assets.
    // Fail-closed: identity binding must reject before any rename/rm/clear.
    const root = await mkdtemp(join(tmpdir(), "tsugite-promo-cross-job-identity-"));
    const projectsHome = join(root, "durable-projects");
    const destA = join(projectsHome, "job-a");
    const destB = join(projectsHome, "job-b");
    // job-b format names (destination-bound slug job-b, not job-a).
    const backupB = join(projectsHome, `${PROMOTION_BACKUP_PREFIX}job-b-9001`);
    const stagingB = join(projectsHome, `${PROMOTION_STAGING_PREFIX}job-b-stage1`);
    const now = "2026-08-01T21:00:00.000Z";

    await mkdir(destA, { recursive: true });
    await writeFile(join(destA, "sentinel-a.txt"), "job-a-destination", "utf8");
    await mkdir(destB, { recursive: true });
    await writeFile(join(destB, "sentinel-b.txt"), "job-b-destination", "utf8");
    await mkdir(backupB, { recursive: true });
    await writeFile(join(backupB, "sentinel-backup-b.txt"), "job-b-backup", "utf8");
    await mkdir(stagingB, { recursive: true });
    await writeFile(join(stagingB, "sentinel-staging-b.txt"), "job-b-staging", "utf8");

    // write path must refuse cross-job binding (not only recovery).
    await expect(
      writePromotionJournal({
        projectsHome,
        journal: {
          schema_version: 1,
          projects_home: resolve(projectsHome),
          destination_root: resolve(destA),
          backup_path: resolve(backupB),
          staging_path: null,
          created_fresh: false,
          phase: "open",
          project_slug: "job-a",
          created_at: now,
          updated_at: now
        }
      })
    ).rejects.toMatchObject({ code: /promotion\.journal_(path_unsafe|identity)/ });

    // On-disk tamper: job-a journal file claiming job-b backup (committing → would rm backup).
    const journalPathA = promotionJournalPath(projectsHome, destA);
    await mkdir(join(projectsHome, PROMOTION_JOURNAL_DIR_NAME), { recursive: true });
    const tamperedCommitting = {
      schema_version: 1 as const,
      projects_home: resolve(projectsHome),
      destination_root: resolve(destA),
      backup_path: resolve(backupB),
      staging_path: null as string | null,
      created_fresh: false,
      phase: "committing",
      project_slug: "job-a",
      created_at: now,
      updated_at: now
    };
    await writeFile(journalPathA, `${JSON.stringify(tamperedCommitting, null, 2)}\n`, "utf8");

    const recoveryCommit = await recoverPromotionTransactions(projectsHome);
    expect(recoveryCommit.ok).toBe(false);
    expect(recoveryCommit.recovered).toBe(0);
    expect(recoveryCommit.cleared).toBe(0);
    expect(recoveryCommit.issues.some((issue) =>
      /identity|path_unsafe|journal/i.test(issue.code) || /identity|bind|backup|slug/i.test(issue.message)
    )).toBe(true);

    // job-b assets and job-a destination must be byte-identical sentinels; journal not cleared.
    expect(await readFile(join(backupB, "sentinel-backup-b.txt"), "utf8")).toBe("job-b-backup");
    expect(await readFile(join(stagingB, "sentinel-staging-b.txt"), "utf8")).toBe("job-b-staging");
    expect(await readFile(join(destB, "sentinel-b.txt"), "utf8")).toBe("job-b-destination");
    expect(await readFile(join(destA, "sentinel-a.txt"), "utf8")).toBe("job-a-destination");
    expect(await pathExists(journalPathA)).toBe(true);
    expect(await pathExists(backupB)).toBe(true);
    expect(await pathExists(stagingB)).toBe(true);
    expect(await pathExists(destB)).toBe(true);

    // Second attack shape: open/rolling_back would restore foreign backup onto job-a and drop staging.
    const tamperedOpen = {
      ...tamperedCommitting,
      phase: "open" as const,
      staging_path: resolve(stagingB)
    };
    await writeFile(journalPathA, `${JSON.stringify(tamperedOpen, null, 2)}\n`, "utf8");
    const recoveryOpen = await recoverPromotionTransactions(projectsHome);
    expect(recoveryOpen.ok).toBe(false);
    expect(recoveryOpen.recovered).toBe(0);
    expect(recoveryOpen.cleared).toBe(0);
    expect(await readFile(join(backupB, "sentinel-backup-b.txt"), "utf8")).toBe("job-b-backup");
    expect(await readFile(join(stagingB, "sentinel-staging-b.txt"), "utf8")).toBe("job-b-staging");
    expect(await readFile(join(destB, "sentinel-b.txt"), "utf8")).toBe("job-b-destination");
    expect(await readFile(join(destA, "sentinel-a.txt"), "utf8")).toBe("job-a-destination");
    expect(await pathExists(journalPathA)).toBe(true);
    // job-a must not have been replaced by job-b backup contents.
    await expect(stat(join(destA, "sentinel-backup-b.txt"))).rejects.toThrow();
  });
});
