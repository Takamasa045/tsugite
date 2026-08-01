import { lstat, mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FinalizePersistenceError,
  assertDirectoryIdentity,
  captureDirectoryIdentity,
  hasSymlinkAlongPath,
  isWithinPath,
  writeAtomicRegularFile
} from "../src/orchestrator/finalizePersistence.js";
import {
  clearFinalizeJournal,
  finalizeJournalPath,
  loadFinalizeJournalSchema,
  parseFinalizeJournalSchema,
  readFinalizeJournal,
  updateFinalizeJournalPhase,
  writeFinalizeJournal
} from "../src/orchestrator/finalizeJournal.js";
import {
  readOptionalRegularFileText,
  readPriorDurableCompletionRecordText,
  restoreCompletionRecordFromJournal,
  restoreRecordText,
  writeCompletionRecords
} from "../src/orchestrator/finalizeCompletionRecord.js";
import {
  captureApprovedStateDirIdentity,
  inspectApprovedStateDir,
  inspectProjectContainedPath,
  isRealDirectory,
  isRegularFile,
  resolveProjectStateDir
} from "../src/orchestrator/finalizePathSafety.js";
import type { FinalizeJournal } from "../src/orchestrator/finalizeJournal.js";

describe("finalize atomic persistence", () => {
  it("writes a regular file atomically and refuses leaf symlink overwrite of external targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-persist-"));
    const target = join(root, "completion-record.json");
    await writeAtomicRegularFile({
      path: target,
      contents: "{\"ok\":true}\n",
      containWithin: root
    });
    expect(await readFile(target, "utf8")).toBe("{\"ok\":true}\n");

    // Overwrite existing regular file is allowed.
    await writeAtomicRegularFile({
      path: target,
      contents: "{\"ok\":2}\n",
      containWithin: root
    });
    expect(await readFile(target, "utf8")).toBe("{\"ok\":2}\n");

    const external = join(root, "external.json");
    await writeFile(external, "secret\n");
    const linked = join(root, "linked-record.json");
    await symlink(external, linked);

    await expect(
      writeAtomicRegularFile({
        path: linked,
        contents: "{\"pwned\":true}\n",
        containWithin: root
      })
    ).rejects.toMatchObject({ code: "finalize.persist_leaf_symlink" });
    expect(await readFile(external, "utf8")).toBe("secret\n");

    // Missing parent fails closed.
    await expect(
      writeAtomicRegularFile({
        path: join(root, "missing-dir", "file.json"),
        contents: "x\n",
        containWithin: root
      })
    ).rejects.toMatchObject({ code: "finalize.persist_parent_missing" });

    // Parent as a regular file fails closed.
    const notDir = join(root, "not-a-dir");
    await writeFile(notDir, "file\n");
    await expect(
      writeAtomicRegularFile({
        path: join(notDir, "child.json"),
        contents: "x\n",
        containWithin: root
      })
    ).rejects.toMatchObject({ code: "finalize.persist_parent_not_directory" });

    // Parent symlink fails closed.
    const realParent = join(root, "real-parent");
    await mkdir(realParent);
    const linkParent = join(root, "link-parent");
    await symlink(realParent, linkParent);
    await expect(
      writeAtomicRegularFile({
        path: join(linkParent, "child.json"),
        contents: "x\n",
        containWithin: root
      })
    ).rejects.toMatchObject({ code: "finalize.persist_parent_symlink" });
  });

  it("rejects directory identity mismatches and non-directory paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-identity-"));
    const dir = join(root, "dist");
    await mkdir(dir);
    const identity = await captureDirectoryIdentity(dir);
    await expect(assertDirectoryIdentity(dir, identity)).resolves.toMatchObject(identity);

    const other = join(root, "other");
    await mkdir(other);
    await expect(assertDirectoryIdentity(other, identity)).rejects.toMatchObject({
      code: "finalize.state_dir_changed"
    });

    const file = join(root, "file");
    await writeFile(file, "x");
    await expect(captureDirectoryIdentity(file)).rejects.toMatchObject({
      code: "finalize.path_not_directory"
    });

    const linked = join(root, "linked");
    await symlink(dir, linked);
    await expect(captureDirectoryIdentity(linked)).rejects.toMatchObject({
      code: "finalize.path_symlink"
    });
  });

  it("detects path containment and symlink ancestors", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-within-"));
    const child = join(root, "a", "b");
    await mkdir(child, { recursive: true });
    expect(isWithinPath(root, child)).toBe(true);
    expect(isWithinPath(root, root)).toBe(true);
    expect(isWithinPath(child, root)).toBe(false);
    expect(isWithinPath(root, join(root, "..", "outside"))).toBe(false);

    expect(await hasSymlinkAlongPath(root, child)).toBe(false);
    expect(await hasSymlinkAlongPath(root, join(root, "..", "outside"))).toBe(true);

    const mid = join(root, "mid");
    const real = join(root, "real");
    await mkdir(real);
    await symlink(real, mid);
    expect(await hasSymlinkAlongPath(root, join(mid, "x"))).toBe(true);
  });

  it("persists finalize journals atomically and keeps measured counters readable", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-journal-"));
    const stateDir = join(root, "dist");
    await mkdir(stateDir, { recursive: true });

    let assignedPhase: string | undefined;
    const journal = await writeFinalizeJournal({
      stateDir,
      runId: "demo-v2",
      containWithin: root,
      assign: (value) => {
        assignedPhase = value.phase;
      },
      afterPhase: async (phase) => {
        expect(phase).toBe("deleting");
      },
      journal: {
        schema_version: 1,
        run_id: "demo-v2",
        plan_digest: "a".repeat(64),
        phase: "deleting",
        quarantine_root: join(stateDir, ".tsugite-finalize-quarantine", "demo-v2", "q"),
        candidates: [{
          original_path: join(root, "media/a.mp4"),
          original_relative: "media/a.mp4",
          identity: {
            path: "media/a.mp4",
            size: 1,
            mtimeMs: 2,
            device: 3,
            inode: 4
          },
          permanently_deleted: false,
          delete_intent: true
        }],
        deleted_files: 2,
        deleted_bytes: 40,
        deleted_paths: ["media/a.mp4", "media/b.mp4"],
        created_at: "2026-07-14T00:00:00.000Z",
        updated_at: "2026-07-14T00:00:00.000Z",
        previous_completion_record: null
      }
    });
    expect(journal.deleted_files).toBe(2);
    expect(assignedPhase).toBe("deleting");

    const loaded = await readFinalizeJournal(stateDir, "demo-v2");
    expect(loaded?.deleted_files).toBe(2);
    expect(loaded?.deleted_bytes).toBe(40);
    expect(loaded?.deleted_paths).toEqual(["media/a.mp4", "media/b.mp4"]);
    expect(loaded?.previous_completion_record).toBeNull();

    const updated = await updateFinalizeJournalPhase({
      stateDir,
      journal: loaded!,
      phase: "completed",
      containWithin: root
    });
    expect(updated.phase).toBe("completed");
    expect((await readFinalizeJournal(stateDir, "demo-v2"))?.phase).toBe("completed");

    const invalid = parseFinalizeJournalSchema({ schema_version: 2 }, "demo-v2", "x");
    expect(invalid.ok).toBe(false);
    const missing = await loadFinalizeJournalSchema(stateDir, "missing-run");
    expect(missing.status).toBe("missing");

    const external = join(root, "outside-journal.json");
    await writeFile(external, "keep\n");
    const journalPath = finalizeJournalPath(stateDir, "demo-v2");
    await clearFinalizeJournal(stateDir, "demo-v2");
    await mkdir(join(stateDir, ".tsugite-finalize-journal"), { recursive: true });
    await symlink(external, journalPath);

    await expect(
      writeFinalizeJournal({
        stateDir,
        runId: "demo-v2",
        containWithin: root,
        journal: {
          schema_version: 1,
          run_id: "demo-v2",
          plan_digest: "b".repeat(64),
          phase: "planned",
          quarantine_root: join(stateDir, "q"),
          candidates: [],
          deleted_files: 0,
          deleted_bytes: 0,
          deleted_paths: [],
          created_at: "2026-07-14T00:00:00.000Z",
          updated_at: "2026-07-14T00:00:00.000Z"
        }
      })
    ).rejects.toBeInstanceOf(FinalizePersistenceError);
    expect(await readFile(external, "utf8")).toBe("keep\n");
  });

  it("covers approved stateDir and project-contained path safety branches", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-path-safety-"));
    const stateDir = join(root, "dist");
    await mkdir(stateDir, { recursive: true });

    expect(await inspectApprovedStateDir(root, stateDir, join(root, "other"))).toMatchObject({
      code: "finalize.state_dir_unapproved"
    });
    expect(await inspectApprovedStateDir(root, root, root)).toMatchObject({
      code: "finalize.state_dir_unsafe"
    });
    expect(await inspectApprovedStateDir(root, join(root, "..", "outside"), join(root, "..", "outside")))
      .toMatchObject({ code: "finalize.state_dir_outside_project" });

    const fileAsState = join(root, "not-dir");
    await writeFile(fileAsState, "x");
    expect(await inspectApprovedStateDir(root, fileAsState, fileAsState)).toMatchObject({
      code: "finalize.state_dir_unsafe"
    });

    const shadow = join(root, "shadow-dist");
    await mkdir(shadow);
    const linkedDist = join(root, "linked-dist");
    await symlink(shadow, linkedDist);
    expect(await inspectApprovedStateDir(root, linkedDist, linkedDist)).toMatchObject({
      code: "finalize.state_dir_symlink"
    });

    const missing = join(root, "missing-dist");
    expect(await inspectApprovedStateDir(root, missing, missing)).toMatchObject({
      code: "finalize.state_dir_unsafe"
    });

    const issue = await inspectApprovedStateDir(root, stateDir, stateDir);
    expect(issue).toBeUndefined();
    const identity = await captureApprovedStateDirIdentity(stateDir);
    const live = await captureDirectoryIdentity(stateDir);
    expect(identity).toEqual(live);

    const runFile = join(stateDir, "run.json");
    await writeFile(runFile, "{}\n");
    expect(await inspectProjectContainedPath(root, runFile, {
      outsideCode: "out",
      symlinkCode: "sym",
      unsafeCode: "unsafe",
      requireDirectory: false
    })).toBeUndefined();
    expect(await inspectProjectContainedPath(root, runFile, {
      outsideCode: "out",
      symlinkCode: "sym",
      unsafeCode: "unsafe",
      requireDirectory: true
    })).toMatchObject({ code: "unsafe" });
    expect(await inspectProjectContainedPath(root, join(root, "..", "out"), {
      outsideCode: "out",
      symlinkCode: "sym",
      unsafeCode: "unsafe",
      requireDirectory: true
    })).toMatchObject({ code: "out" });

    const missingLeaf = join(stateDir, "new-run", "state.json");
    expect(await inspectProjectContainedPath(root, missingLeaf, {
      outsideCode: "out",
      symlinkCode: "sym",
      unsafeCode: "unsafe",
      requireDirectory: false,
      allowMissing: true
    })).toMatchObject({ code: "unsafe" });

    const linkedFile = join(stateDir, "linked.json");
    await symlink(runFile, linkedFile);
    expect(await inspectProjectContainedPath(root, linkedFile, {
      outsideCode: "out",
      symlinkCode: "sym",
      unsafeCode: "unsafe",
      requireDirectory: false
    })).toMatchObject({ code: "sym" });

    expect(await isRegularFile(runFile)).toBe(true);
    expect(await isRegularFile(linkedFile)).toBe(false);
    expect(await isRegularFile(join(root, "nope"))).toBe(false);
    expect(await isRealDirectory(stateDir)).toBe(true);
    expect(await isRealDirectory(runFile)).toBe(false);
    expect(await isRealDirectory(join(root, "nope"))).toBe(false);
    expect(resolveProjectStateDir(root, "dist")).toBe(resolve(root, "dist"));
  });

  it("rejects invalid journal schema shapes used by recovery", () => {
    const path = "/tmp/journal.json";
    expect(parseFinalizeJournalSchema(null, "r", path).ok).toBe(false);
    expect(parseFinalizeJournalSchema([], "r", path).ok).toBe(false);
    expect(parseFinalizeJournalSchema({ schema_version: 1, run_id: "other" }, "r", path).ok).toBe(false);
    expect(parseFinalizeJournalSchema({
      schema_version: 1,
      run_id: "r",
      plan_digest: "nope",
      phase: "planned",
      quarantine_root: "/q",
      candidates: [],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      created_at: "t",
      updated_at: "t"
    }, "r", path).ok).toBe(false);
    expect(parseFinalizeJournalSchema({
      schema_version: 1,
      run_id: "r",
      plan_digest: "a".repeat(64),
      phase: "not-a-phase",
      quarantine_root: "/q",
      candidates: [],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      created_at: "t",
      updated_at: "t"
    }, "r", path).ok).toBe(false);
    expect(parseFinalizeJournalSchema({
      schema_version: 1,
      run_id: "r",
      plan_digest: "a".repeat(64),
      phase: "planned",
      quarantine_root: "",
      candidates: [],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      created_at: "t",
      updated_at: "t"
    }, "r", path).ok).toBe(false);
    expect(parseFinalizeJournalSchema({
      schema_version: 1,
      run_id: "r",
      plan_digest: "a".repeat(64),
      phase: "planned",
      quarantine_root: "/q",
      candidates: "nope",
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      created_at: "t",
      updated_at: "t"
    }, "r", path).ok).toBe(false);
    expect(parseFinalizeJournalSchema({
      schema_version: 1,
      run_id: "r",
      plan_digest: "a".repeat(64),
      phase: "planned",
      quarantine_root: "/q",
      candidates: [{}],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      created_at: "t",
      updated_at: "t"
    }, "r", path).ok).toBe(false);
    expect(parseFinalizeJournalSchema({
      schema_version: 1,
      run_id: "r",
      plan_digest: "a".repeat(64),
      phase: "planned",
      quarantine_root: "/q",
      candidates: [{
        original_path: "/a",
        original_relative: "a",
        permanently_deleted: true,
        identity: { path: "a", size: 1, mtimeMs: 1, device: 1, inode: 1 }
      }],
      deleted_files: -1,
      deleted_bytes: 0,
      deleted_paths: [],
      created_at: "t",
      updated_at: "t"
    }, "r", path).ok).toBe(false);
    expect(parseFinalizeJournalSchema({
      schema_version: 1,
      run_id: "r",
      plan_digest: "a".repeat(64),
      phase: "planned",
      quarantine_root: "/q",
      candidates: [{
        original_path: "/a",
        original_relative: "a",
        permanently_deleted: true,
        identity: { path: "a", size: 1, mtimeMs: 1, device: 1, inode: 1 }
      }],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      created_at: "t",
      updated_at: "t",
      previous_completion_record: 123
    }, "r", path).ok).toBe(false);
    const ok = parseFinalizeJournalSchema({
      schema_version: 1,
      run_id: "r",
      plan_digest: "a".repeat(64),
      phase: "planned",
      quarantine_root: "/q",
      candidates: [{
        original_path: "/a",
        original_relative: "a",
        permanently_deleted: false,
        delete_intent: false,
        quarantine_path: "/q/a",
        identity: { path: "a", size: 1, mtimeMs: 1, device: 1, inode: 1 }
      }],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      created_at: "t",
      updated_at: "t",
      previous_completion_record: "{\"x\":1}",
      previous_durable_completion_record: "{\"d\":2}"
    }, "r", path);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.journal.candidates[0]?.delete_intent).toBe(false);
      expect(ok.journal.previous_completion_record).toBe("{\"x\":1}");
      expect(ok.journal.previous_durable_completion_record).toBe("{\"d\":2}");
    }
    expect(parseFinalizeJournalSchema({
      schema_version: 1,
      run_id: "r",
      plan_digest: "a".repeat(64),
      phase: "planned",
      quarantine_root: "/q",
      candidates: [],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      created_at: "t",
      updated_at: "t",
      previous_completion_record: null,
      previous_durable_completion_record: 99
    }, "r", path).ok).toBe(false);
  });

  it("BLOCK: restoreRecordText refuses ancestor symlink before mkdir and leaves external tree unchanged", async () => {
    const outer = await mkdtemp(join(tmpdir(), "tsugite-restore-ancestor-mkdir-"));
    const projectsHome = join(outer, "projects-home");
    const external = join(outer, "external-tree");
    await mkdir(projectsHome, { recursive: true });
    await mkdir(join(external, "demo"), { recursive: true });
    await writeFile(join(external, "sentinel.txt"), "EXTERNAL_SENTINEL_MUST_NOT_CHANGE\n");
    // Lexical path is under projectsHome, but demo is a symlink out of the home.
    await symlink(join(external, "demo"), join(projectsHome, "demo"));
    const durablePath = join(projectsHome, "demo", "dist", "run", "completion-record.json");

    await expect(
      restoreRecordText(durablePath, "{\"restored\":true}\n", projectsHome)
    ).rejects.toBeInstanceOf(FinalizePersistenceError);

    // Zero external side effects: no dist/run created via the symlink, sentinel intact.
    expect(await readdir(join(external, "demo"))).toEqual([]);
    expect(await readdir(external).then((names) => names.sort())).toEqual(["demo", "sentinel.txt"]);
    expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe(
      "EXTERNAL_SENTINEL_MUST_NOT_CHANGE\n"
    );
  });

  it("BLOCK: writeCompletionRecords refuses durable mkdir through ancestor symlink without external side effects", async () => {
    const outer = await mkdtemp(join(tmpdir(), "tsugite-write-records-ancestor-"));
    const projectsHome = join(outer, "projects-home");
    const projectRoot = join(outer, "worktree-project");
    const external = join(outer, "external-tree");
    const runDir = join(projectRoot, "dist", "run");
    await mkdir(runDir, { recursive: true });
    await mkdir(projectsHome, { recursive: true });
    await mkdir(join(external, "demo"), { recursive: true });
    await writeFile(join(external, "sentinel.txt"), "EXTERNAL_SENTINEL_MUST_NOT_CHANGE\n");
    await symlink(join(external, "demo"), join(projectsHome, "demo"));

    const sourcePath = join(runDir, "completion-record.json");
    const durablePath = join(projectsHome, "demo", "dist", "run", "completion-record.json");

    await expect(
      writeCompletionRecords({
        sourceRecordPath: sourcePath,
        durableRecordPath: durablePath,
        project: { projectSlug: "demo" },
        runId: "run",
        stateUpdatedAt: "2026-08-01T00:00:00.000Z",
        canonicalOutputPath: join(runDir, "final.mp4"),
        runDir,
        projectRoot,
        referencedSourceMedia: [],
        deletedFiles: 0,
        deletedBytes: 0,
        deletedMediaPaths: [],
        planDigest: "a".repeat(64),
        launcherPlan: {
          projectsHome,
          destinationRoot: join(projectsHome, "demo"),
          alreadyHome: false,
          willPromote: true
        }
      })
    ).rejects.toBeInstanceOf(FinalizePersistenceError);

    expect(await readdir(join(external, "demo"))).toEqual([]);
    expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe(
      "EXTERNAL_SENTINEL_MUST_NOT_CHANGE\n"
    );
  });

  it("BLOCK: prior durable completion-record read refuses ancestor symlink and never returns external content", async () => {
    const outer = await mkdtemp(join(tmpdir(), "tsugite-prior-durable-ancestor-"));
    const projectsHome = join(outer, "projects-home");
    const external = join(outer, "external-tree");
    await mkdir(projectsHome, { recursive: true });
    await mkdir(join(external, "demo", "dist", "run"), { recursive: true });
    await writeFile(
      join(external, "demo", "dist", "run", "completion-record.json"),
      "EXTERNAL_SECRET_MUST_NOT_LEAK\n"
    );
    await writeFile(join(external, "sentinel.txt"), "EXTERNAL_SENTINEL_MUST_NOT_CHANGE\n");
    await symlink(join(external, "demo"), join(projectsHome, "demo"));

    const durablePath = join(projectsHome, "demo", "dist", "run", "completion-record.json");
    const prior = await readPriorDurableCompletionRecordText(durablePath, projectsHome);
    expect(prior).toBeNull();

    // External content and layout unchanged.
    expect(await readFile(
      join(external, "demo", "dist", "run", "completion-record.json"),
      "utf8"
    )).toBe("EXTERNAL_SECRET_MUST_NOT_LEAK\n");
    expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe(
      "EXTERNAL_SENTINEL_MUST_NOT_CHANGE\n"
    );
  });

  it("BLOCK: source prior completion-record read refuses ancestor symlink and never returns external content", async () => {
    const outer = await mkdtemp(join(tmpdir(), "tsugite-prior-source-ancestor-"));
    const projectRoot = join(outer, "project");
    const external = join(outer, "external-tree");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(join(external, "run"), { recursive: true });
    await writeFile(join(external, "run", "completion-record.json"), "EXTERNAL_SECRET_MUST_NOT_LEAK\n");
    await writeFile(join(external, "sentinel.txt"), "EXTERNAL_SENTINEL_MUST_NOT_CHANGE\n");
    // dist is a symlink ancestor under the project root.
    await symlink(external, join(projectRoot, "dist"));

    const recordPath = join(projectRoot, "dist", "run", "completion-record.json");
    const result = await readOptionalRegularFileText(recordPath, {
      outsideCode: "finalize.record_path_outside_project",
      symlinkCode: "finalize.record_path_symlink",
      unsafeCode: "finalize.record_path_unsafe",
      projectRoot
    });
    expect(result.status).toBe("unsafe");
    if (result.status === "unsafe") {
      expect(result.issue.code).toBe("finalize.record_path_symlink");
    }
    expect(await readFile(join(external, "run", "completion-record.json"), "utf8")).toBe(
      "EXTERNAL_SECRET_MUST_NOT_LEAK\n"
    );
    expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe(
      "EXTERNAL_SENTINEL_MUST_NOT_CHANGE\n"
    );
  });

  it("refuses durable completion-record restore/delete when projectsHome is replaced by external symlink", async () => {
    const outer = await mkdtemp(join(tmpdir(), "tsugite-durable-escape-"));
    const projectsHome = join(outer, "projects-home");
    const external = join(outer, "external-home");
    await mkdir(join(projectsHome, "demo", "dist", "run"), { recursive: true });
    const durablePath = join(projectsHome, "demo", "dist", "run", "completion-record.json");
    await writeFile(durablePath, "provisional-inside-home\n");

    // Replace projectsHome with a symlink that points at an external tree with the same layout.
    await rename(projectsHome, join(outer, "projects-home-real"));
    await mkdir(join(external, "demo", "dist", "run"), { recursive: true });
    const externalRecord = join(external, "demo", "dist", "run", "completion-record.json");
    await writeFile(externalRecord, "external-secret-must-not-change\n");
    await writeFile(join(external, "marker.txt"), "must-not-touch\n");
    await symlink(external, projectsHome);

    await expect(
      restoreRecordText(durablePath, "{\"restored\":true}\n", projectsHome)
    ).rejects.toBeInstanceOf(FinalizePersistenceError);
    await expect(
      restoreRecordText(durablePath, undefined, projectsHome)
    ).rejects.toBeInstanceOf(FinalizePersistenceError);

    expect(await readFile(externalRecord, "utf8")).toBe("external-secret-must-not-change\n");
    expect(await readFile(join(external, "marker.txt"), "utf8")).toBe("must-not-touch\n");

    // Higher-level restore must also fail closed for the durable path.
    const journal: FinalizeJournal = {
      schema_version: 1,
      run_id: "run",
      plan_digest: "c".repeat(64),
      phase: "recording",
      quarantine_root: join(outer, "q"),
      candidates: [],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z",
      previous_completion_record: null
    };
    const issues = await restoreCompletionRecordFromJournal(
      join(outer, "worktree-project"),
      join(outer, "worktree-project", "dist", "run"),
      journal,
      {
        source: join(outer, "worktree-project", "dist", "run", "completion-record.json"),
        durable: durablePath,
        reported: durablePath
      },
      { durableContainWithin: projectsHome }
    );
    expect(issues.some((issue) => issue.code === "finalize.record_restore_failed")).toBe(true);
    expect(await readFile(externalRecord, "utf8")).toBe("external-secret-must-not-change\n");
  });

  it("restores and deletes durable completion-records inside a real projectsHome boundary", async () => {
    const outer = await mkdtemp(join(tmpdir(), "tsugite-durable-ok-"));
    const projectsHome = join(outer, "projects-home");
    const projectRoot = join(outer, "worktree-project");
    const runDir = join(projectRoot, "dist", "run");
    const durableDir = join(projectsHome, "demo", "dist", "run");
    await mkdir(runDir, { recursive: true });
    await mkdir(durableDir, { recursive: true });

    const sourcePath = join(runDir, "completion-record.json");
    const durablePath = join(durableDir, "completion-record.json");
    await writeFile(sourcePath, "source-provisional\n");
    await writeFile(durablePath, "durable-provisional\n");

    const prior = "{\"schema_version\":1,\"ok\":true}\n";
    await restoreRecordText(durablePath, prior, projectsHome);
    expect(await readFile(durablePath, "utf8")).toBe(prior);

    await restoreRecordText(durablePath, undefined, projectsHome);
    await expect(lstat(durablePath)).rejects.toMatchObject({ code: "ENOENT" });

    // Recreate durable provisional, then restore via journal helper (source + durable).
    await writeFile(durablePath, "durable-provisional-2\n");
    await writeFile(sourcePath, "source-provisional-2\n");
    const sourcePrior = "{\"schema_version\":1,\"side\":\"source\"}\n";
    const durablePrior = "{\"schema_version\":1,\"side\":\"durable\"}\n";
    const journal: FinalizeJournal = {
      schema_version: 1,
      run_id: "run",
      plan_digest: "d".repeat(64),
      phase: "recording",
      quarantine_root: join(projectRoot, "dist", ".q"),
      candidates: [],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z",
      previous_completion_record: sourcePrior,
      previous_durable_completion_record: durablePrior
    };
    const issues = await restoreCompletionRecordFromJournal(
      projectRoot,
      runDir,
      journal,
      {
        source: sourcePath,
        durable: durablePath,
        reported: durablePath
      },
      { durableContainWithin: projectsHome }
    );
    expect(issues).toEqual([]);
    expect(await readFile(sourcePath, "utf8")).toBe(sourcePrior);
    expect(await readFile(durablePath, "utf8")).toBe(durablePrior);
  });

  it("restores source and durable completion-records from separate journal snapshots", async () => {
    const outer = await mkdtemp(join(tmpdir(), "tsugite-dual-snap-"));
    const projectsHome = join(outer, "projects-home");
    const projectRoot = join(outer, "worktree-project");
    const runDir = join(projectRoot, "dist", "run");
    const durableDir = join(projectsHome, "demo", "dist", "run");
    await mkdir(runDir, { recursive: true });
    await mkdir(durableDir, { recursive: true });
    const sourcePath = join(runDir, "completion-record.json");
    const durablePath = join(durableDir, "completion-record.json");
    const sourcePrior = "{\"audit\":\"source-old\"}\n";
    const durablePrior = "{\"audit\":\"durable-old\"}\n";
    await writeFile(sourcePath, "source-provisional\n");
    await writeFile(durablePath, "durable-provisional\n");

    const journal: FinalizeJournal = {
      schema_version: 1,
      run_id: "run",
      plan_digest: "a".repeat(64),
      phase: "recording",
      quarantine_root: join(projectRoot, "dist", ".q"),
      candidates: [],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z",
      previous_completion_record: sourcePrior,
      previous_durable_completion_record: durablePrior
    };
    const issues = await restoreCompletionRecordFromJournal(
      projectRoot,
      runDir,
      journal,
      { source: sourcePath, durable: durablePath, reported: durablePath },
      { durableContainWithin: projectsHome }
    );
    expect(issues).toEqual([]);
    expect(await readFile(sourcePath, "utf8")).toBe(sourcePrior);
    expect(await readFile(durablePath, "utf8")).toBe(durablePrior);
  });

  it("does not re-apply source snapshot onto durable after promotion backup restore", async () => {
    const outer = await mkdtemp(join(tmpdir(), "tsugite-promo-rb-snap-"));
    const projectsHome = join(outer, "projects-home");
    const projectRoot = join(outer, "worktree-project");
    const runDir = join(projectRoot, "dist", "run");
    const durableDir = join(projectsHome, "demo", "dist", "run");
    await mkdir(runDir, { recursive: true });
    await mkdir(durableDir, { recursive: true });
    const sourcePath = join(runDir, "completion-record.json");
    const durablePath = join(durableDir, "completion-record.json");
    const sourcePrior = "{\"audit\":\"source-only\"}\n";
    // Promotion rollback already restored the durable tree with its own audit record.
    const restoredDurableAudit = "{\"audit\":\"durable-from-backup\"}\n";
    await writeFile(sourcePath, "source-provisional\n");
    await writeFile(durablePath, restoredDurableAudit);

    const journal: FinalizeJournal = {
      schema_version: 1,
      run_id: "run",
      plan_digest: "b".repeat(64),
      phase: "recording",
      quarantine_root: join(projectRoot, "dist", ".q"),
      candidates: [],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z",
      previous_completion_record: sourcePrior,
      // Explicit durable prior matches the restored backup content.
      previous_durable_completion_record: restoredDurableAudit
    };
    const issues = await restoreCompletionRecordFromJournal(
      projectRoot,
      runDir,
      journal,
      { source: sourcePath, durable: durablePath, reported: durablePath },
      {
        durableContainWithin: projectsHome,
        // Promotion backup already restored the durable tree; do not rewrite durable.
        skipDurableRestore: true
      }
    );
    expect(issues).toEqual([]);
    expect(await readFile(sourcePath, "utf8")).toBe(sourcePrior);
    // Must keep durable backup content, never source snapshot.
    expect(await readFile(durablePath, "utf8")).toBe(restoredDurableAudit);
  });

  it("legacy journals without durable snapshot keep existing durable records (fail-closed)", async () => {
    const outer = await mkdtemp(join(tmpdir(), "tsugite-legacy-snap-"));
    const projectsHome = join(outer, "projects-home");
    const projectRoot = join(outer, "worktree-project");
    const runDir = join(projectRoot, "dist", "run");
    const durableDir = join(projectsHome, "demo", "dist", "run");
    await mkdir(runDir, { recursive: true });
    await mkdir(durableDir, { recursive: true });
    const sourcePath = join(runDir, "completion-record.json");
    const durablePath = join(durableDir, "completion-record.json");
    const sourcePrior = "{\"audit\":\"source-legacy\"}\n";
    const durableExisting = "{\"audit\":\"durable-must-keep\"}\n";
    await writeFile(sourcePath, "source-provisional\n");
    await writeFile(durablePath, durableExisting);

    // Legacy: only previous_completion_record (no previous_durable_completion_record).
    const journal: FinalizeJournal = {
      schema_version: 1,
      run_id: "run",
      plan_digest: "c".repeat(64),
      phase: "recording",
      quarantine_root: join(projectRoot, "dist", ".q"),
      candidates: [],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z",
      previous_completion_record: sourcePrior
    };
    const issues = await restoreCompletionRecordFromJournal(
      projectRoot,
      runDir,
      journal,
      { source: sourcePath, durable: durablePath, reported: durablePath },
      { durableContainWithin: projectsHome }
    );
    expect(issues).toEqual([]);
    expect(await readFile(sourcePath, "utf8")).toBe(sourcePrior);
    // Ambiguous legacy durable side: keep on-disk durable audit, never apply source snapshot.
    expect(await readFile(durablePath, "utf8")).toBe(durableExisting);
  });

  it("does not read or clear a finalize journal leaf symlink to an external file", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-journal-leaf-"));
    const stateDir = join(root, "dist");
    await mkdir(stateDir, { recursive: true });
    const external = join(root, "external-journal.json");
    const externalBody = `${JSON.stringify({
      schema_version: 1,
      run_id: "demo-v2",
      plan_digest: "e".repeat(64),
      phase: "planned",
      quarantine_root: join(stateDir, "q"),
      candidates: [],
      deleted_files: 0,
      deleted_bytes: 0,
      deleted_paths: [],
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z"
    }, null, 2)}\n`;
    await writeFile(external, externalBody);

    const journalPath = finalizeJournalPath(stateDir, "demo-v2");
    await mkdir(join(stateDir, ".tsugite-finalize-journal"), { recursive: true });
    await symlink(external, journalPath);

    const loaded = await loadFinalizeJournalSchema(stateDir, "demo-v2");
    expect(loaded.status).not.toBe("ok");
    expect(await readFinalizeJournal(stateDir, "demo-v2")).toBeUndefined();

    await clearFinalizeJournal(stateDir, "demo-v2");
    expect(await readFile(external, "utf8")).toBe(externalBody);
    // Leaf symlink must not be followed away; external target stays intact.
    expect((await lstat(journalPath)).isSymbolicLink()).toBe(true);
  });

  it("does not read or clear a finalize journal when the journal parent is a symlink to external", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-journal-parent-"));
    const stateDir = join(root, "dist");
    await mkdir(stateDir, { recursive: true });
    const externalDir = join(root, "external-journal-dir");
    await mkdir(externalDir);
    const externalFile = join(externalDir, "demo-v2.json");
    const externalBody = "external-journal-must-remain\n";
    await writeFile(externalFile, externalBody);
    await symlink(externalDir, join(stateDir, ".tsugite-finalize-journal"));

    const loaded = await loadFinalizeJournalSchema(stateDir, "demo-v2");
    expect(loaded.status).not.toBe("ok");
    expect(await readFinalizeJournal(stateDir, "demo-v2")).toBeUndefined();

    await clearFinalizeJournal(stateDir, "demo-v2");
    expect(await readFile(externalFile, "utf8")).toBe(externalBody);
    expect((await lstat(join(stateDir, ".tsugite-finalize-journal"))).isSymbolicLink()).toBe(true);
  });

  it("reads and clears a normal finalize journal under stateDir", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-journal-ok-"));
    const stateDir = join(root, "dist");
    await mkdir(stateDir, { recursive: true });

    await writeFinalizeJournal({
      stateDir,
      runId: "demo-v2",
      containWithin: stateDir,
      journal: {
        schema_version: 1,
        run_id: "demo-v2",
        plan_digest: "f".repeat(64),
        phase: "planned",
        quarantine_root: join(stateDir, ".tsugite-finalize-quarantine", "demo-v2", "q"),
        candidates: [],
        deleted_files: 0,
        deleted_bytes: 0,
        deleted_paths: [],
        created_at: "2026-07-14T00:00:00.000Z",
        updated_at: "2026-07-14T00:00:00.000Z",
        previous_completion_record: null
      }
    });

    const loaded = await loadFinalizeJournalSchema(stateDir, "demo-v2");
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded.journal.phase).toBe("planned");
      expect(loaded.journal.previous_completion_record).toBeNull();
    }
    expect((await readFinalizeJournal(stateDir, "demo-v2"))?.run_id).toBe("demo-v2");

    await clearFinalizeJournal(stateDir, "demo-v2");
    expect(await loadFinalizeJournalSchema(stateDir, "demo-v2")).toEqual({ status: "missing" });
  });
});
