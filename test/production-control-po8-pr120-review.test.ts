/**
 * PR #120 review regressions (P1 rollback dispatch, P2 create-only publish).
 * Fixture-only: no provider DNS, billing, real Gate, non-dry-run run/render/finalize.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { main as cliMain } from "../src/cli.js";
import {
  applyMigration,
  journalIsComplete,
  previewMigration,
  readCurrentModePointer,
  readMigrationJournal
} from "../src/productionControl/rc/index.js";
import { loadPo8Fixture } from "../src/productionControl/rc/po8Fixtures.js";
import { resolveCanonicalProductionControlRoot } from "../src/productionControl/activeRunGeneration.js";

const NOW = "2026-08-12T18:00:00.000Z";

async function realTempDir(prefix: string): Promise<string> {
  const base = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  return realpath(await mkdtemp(join(base, prefix)));
}

async function captureCli(argv: string[]): Promise<{ code: number; payload: Record<string, unknown>; text: string }> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const code = await cliMain([...argv, "--json"]);
    const text = lines.join("\n").trim();
    const payload = text ? JSON.parse(text) as Record<string, unknown> : {};
    return { code, payload, text };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function writeMinimalProject(root: string, project: Record<string, unknown>): Promise<string> {
  const slug = String(project.slug ?? "po8-temp");
  const yaml = [
    `slug: ${slug}`,
    `name: ${String(project.name ?? slug)}`,
    "manifest: manifest.json",
    "dist_dir: dist",
    "edit:",
    "  backend: remotion",
    ...(project.orchestration && typeof project.orchestration === "object"
      ? [
        "orchestration:",
        `  mode: ${String((project.orchestration as { mode?: string }).mode ?? "disabled")}`
      ]
      : []),
    ""
  ].join("\n");
  await writeFile(join(root, "project.yaml"), yaml);
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      meta: { aspect: "16:9", fps: 30, target_duration_seconds: 6, slug },
      clips: [{
        id: "clip-1",
        src: "media/clip.mp4",
        in: 0,
        out: 6,
        duration: 6,
        fps: 30,
        resolution: { width: 1920, height: 1080 },
        audio: false
      }]
    }, null, 2)}\n`
  );
  await mkdir(join(root, "media"), { recursive: true });
  await writeFile(join(root, "media/clip.mp4"), Buffer.alloc(64));
  await mkdir(join(root, "dist"), { recursive: true });
  return join(root, "project.yaml");
}

async function migrateToActive(config: string): Promise<void> {
  const shadowPreview = await captureCli([
    "production-migrate",
    "--config",
    config,
    "--target",
    "shadow"
  ]);
  expect(shadowPreview.code).toBe(0);
  const shadowDigest = (shadowPreview.payload.preview as { digest: string }).digest;
  const shadowApply = await captureCli([
    "production-migrate",
    "--config",
    config,
    "--target",
    "shadow",
    "--apply",
    "--actor",
    "coordinator",
    "--expected-plan-digest",
    shadowDigest
  ]);
  expect(shadowApply.code).toBe(0);

  const activePreview = await captureCli([
    "production-migrate",
    "--config",
    config,
    "--target",
    "active"
  ]);
  expect(activePreview.code).toBe(0);
  const activeDigest = (activePreview.payload.preview as { digest: string }).digest;
  const activeApply = await captureCli([
    "production-migrate",
    "--config",
    config,
    "--target",
    "active",
    "--apply",
    "--actor",
    "coordinator",
    "--expected-plan-digest",
    activeDigest
  ]);
  expect(activeApply.code).toBe(0);
}

describe("PR #120 P1: production-rollback stays callable with broken project content", () => {
  it("rolls back from durable active after manifest/YAML break without bypassing actor, dry-run, or other commands", async () => {
    const root = await realTempDir("tsugite-po8-p1-rollback-");
    try {
      const fixture = await loadPo8Fixture("legacy-h3");
      const config = await writeMinimalProject(root, fixture.project as Record<string, unknown>);
      await migrateToActive(config);
      expect((await readCurrentModePointer(root))?.runtime_mode).toBe("active");

      await writeFile(join(root, "manifest.json"), "{ not-valid-manifest\n");
      const validateBroken = await captureCli(["validate", "--config", config]);
      expect(validateBroken.code).toBe(1);
      expect(validateBroken.payload.command).toBe("validate");

      const migrateBlocked = await captureCli([
        "production-migrate",
        "--config",
        config,
        "--target",
        "shadow"
      ]);
      expect(migrateBlocked.code).toBe(1);
      expect(migrateBlocked.payload.command).toBe("production-migrate");

      const preview = await captureCli([
        "production-rollback",
        "--config",
        config,
        "--target",
        "legacy"
      ]);
      expect(preview.code).toBe(0);
      expect(preview.payload.command).toBe("production-rollback");
      expect(preview.payload.dry_run).toBe(true);
      expect(preview.payload.ok).toBe(true);
      expect((preview.payload.preview as { to_mode?: string }).to_mode).toBe("legacy");

      const nonCoord = await captureCli([
        "production-rollback",
        "--config",
        config,
        "--target",
        "legacy",
        "--apply"
      ]);
      expect(nonCoord.code).toBe(1);
      expect(JSON.stringify(nonCoord.payload.issues ?? [])).toMatch(/coordinator/i);
      expect((await readCurrentModePointer(root))?.runtime_mode).toBe("active");

      const applyDryRun = await captureCli([
        "production-rollback",
        "--config",
        config,
        "--target",
        "legacy",
        "--apply",
        "--dry-run",
        "--actor",
        "coordinator"
      ]);
      expect(applyDryRun.code).toBe(1);
      expect(JSON.stringify(applyDryRun.payload.issues ?? [])).toMatch(/dry-run|apply/i);
      expect((await readCurrentModePointer(root))?.runtime_mode).toBe("active");

      await writeFile(config, "this: is: [not: valid: yaml\n");
      const brokenYamlValidate = await captureCli(["validate", "--config", config]);
      expect(brokenYamlValidate.code).toBe(1);

      const applied = await captureCli([
        "production-rollback",
        "--config",
        config,
        "--target",
        "legacy",
        "--apply",
        "--actor",
        "coordinator"
      ]);
      expect(applied.code).toBe(0);
      expect(applied.payload.command).toBe("production-rollback");
      expect(applied.payload.ok).toBe(true);
      expect(applied.payload.dry_run).toBe(false);
      expect(applied.payload.generation_submitted).toBe("unknown");
      expect(applied.payload.gate_mutated).toBe("unknown");
      expect((applied.payload.record as { deleted_artifacts?: unknown[] }).deleted_artifacts).toEqual([]);
      expect((await readCurrentModePointer(root))?.runtime_mode).toBe("legacy");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("fails closed when rollback has no durable pointer and project content cannot be loaded", async () => {
    const root = await realTempDir("tsugite-po8-p1-noptr-");
    try {
      const fixture = await loadPo8Fixture("legacy-h3");
      const config = await writeMinimalProject(root, fixture.project as Record<string, unknown>);
      await writeFile(config, "not: a: [tsugite: project\n");
      const preview = await captureCli([
        "production-rollback",
        "--config",
        config,
        "--target",
        "legacy"
      ]);
      expect(preview.code).toBe(1);
      expect(preview.payload.ok).toBe(false);
      expect(preview.payload.command).toBe("production-rollback");
      expect(JSON.stringify(preview.payload.issues ?? [])).toMatch(/pointer|project/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("PR #120 P2: create-only reservation crash does not block journal resume", () => {
  it("resumes the same preview after crash between reservation close and publish", async () => {
    const root = await realTempDir("tsugite-po8-p2-crash-");
    try {
      const fixture = await loadPo8Fixture("legacy-h3");
      await writeMinimalProject(root, fixture.project as Record<string, unknown>);
      const preview = previewMigration({
        project: fixture.project,
        target_mode: "shadow",
        projectRoot: root,
        coordinator: true
      });

      let reservedFinal = "";
      let reservedSibling = "";
      await expect(applyMigration({
        project: fixture.project,
        target_mode: "shadow",
        projectRoot: root,
        actor: "coordinator",
        expected_preview_digest: preview.digest,
        coordinator: true,
        now: () => NOW,
        artifact_reserve_hook: async (info) => {
          reservedFinal = info.finalPath;
          reservedSibling = info.reservePath;
          throw new Error("crash-after-artifact-reserve");
        }
      })).rejects.toThrow(/crash-after-artifact-reserve/);

      expect(reservedFinal).toMatch(/preview-|production-contract-|task-tree-/);
      const leftoverFinal = await stat(reservedFinal).catch(() => undefined);
      if (leftoverFinal) {
        expect(leftoverFinal.isFile()).toBe(true);
        expect(leftoverFinal.size).toBe(0);
      }

      const journal = await readMigrationJournal(root);
      expect(journalIsComplete(journal, preview.digest)).toBe(false);

      const resumed = await applyMigration({
        project: fixture.project,
        target_mode: "shadow",
        projectRoot: root,
        actor: "coordinator",
        expected_preview_digest: preview.digest,
        coordinator: true,
        now: () => "2026-08-12T18:05:00.000Z"
      });
      expect(resumed.journal_complete).toBe(true);
      expect(journalIsComplete(await readMigrationJournal(root), preview.digest)).toBe(true);

      const published = await readFile(reservedFinal, "utf8");
      expect(published.trim().length).toBeGreaterThan(2);
      expect(() => JSON.parse(published)).not.toThrow();
      if (reservedSibling && reservedSibling !== reservedFinal) {
        await expect(stat(reservedSibling)).rejects.toBeTruthy();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("recovers an empty final leftover and rejects different-bytes / symlink finals", async () => {
    const root = await realTempDir("tsugite-po8-p2-leftover-");
    try {
      const fixture = await loadPo8Fixture("legacy-h3");
      await writeMinimalProject(root, fixture.project as Record<string, unknown>);
      const preview = previewMigration({
        project: fixture.project,
        target_mode: "shadow",
        projectRoot: root,
        coordinator: true
      });

      await expect(applyMigration({
        project: fixture.project,
        target_mode: "shadow",
        projectRoot: root,
        actor: "coordinator",
        expected_preview_digest: preview.digest,
        coordinator: true,
        now: () => NOW,
        crash_after_stage: "snapshot",
        crash_hook: async () => {
          throw new Error("crash-after-snapshot");
        }
      })).rejects.toThrow(/crash-after-snapshot/);

      const controlRoot = resolveCanonicalProductionControlRoot(root);
      const previewPath = join(controlRoot, "migration", `preview-${preview.digest.slice(0, 16)}.json`);
      await mkdir(dirname(previewPath), { recursive: true });
      await writeFile(previewPath, "");
      expect((await stat(previewPath)).size).toBe(0);

      const resumed = await applyMigration({
        project: fixture.project,
        target_mode: "shadow",
        projectRoot: root,
        actor: "coordinator",
        expected_preview_digest: preview.digest,
        coordinator: true,
        now: () => "2026-08-12T18:06:00.000Z"
      });
      expect(resumed.journal_complete).toBe(true);
      const recovered = await readFile(previewPath, "utf8");
      expect(recovered).toContain(preview.digest);
      expect((await stat(previewPath)).size).toBeGreaterThan(0);

      const conflictRoot = await realTempDir("tsugite-po8-p2-conflict-");
      try {
        await writeMinimalProject(conflictRoot, fixture.project as Record<string, unknown>);
        const conflictPreview = previewMigration({
          project: fixture.project,
          target_mode: "shadow",
          projectRoot: conflictRoot,
          coordinator: true
        });
        await expect(applyMigration({
          project: fixture.project,
          target_mode: "shadow",
          projectRoot: conflictRoot,
          actor: "coordinator",
          expected_preview_digest: conflictPreview.digest,
          coordinator: true,
          now: () => NOW,
          crash_after_stage: "snapshot",
          crash_hook: async () => {
            throw new Error("crash-after-snapshot-conflict");
          }
        })).rejects.toThrow(/crash-after-snapshot-conflict/);
        const conflictPreviewPath = join(
          resolveCanonicalProductionControlRoot(conflictRoot),
          "migration",
          `preview-${conflictPreview.digest.slice(0, 16)}.json`
        );
        await mkdir(dirname(conflictPreviewPath), { recursive: true });
        await writeFile(conflictPreviewPath, `${JSON.stringify({ not: "the-preview" }, null, 2)}\n`);
        await expect(applyMigration({
          project: fixture.project,
          target_mode: "shadow",
          projectRoot: conflictRoot,
          actor: "coordinator",
          expected_preview_digest: conflictPreview.digest,
          coordinator: true,
          now: () => "2026-08-12T18:08:00.000Z"
        })).rejects.toMatchObject({ code: "PC_ARTIFACT_DUPLICATE" });
      } finally {
        await rm(conflictRoot, { recursive: true, force: true });
      }

      const linkRoot = await realTempDir("tsugite-po8-p2-symlink-");
      try {
        await writeMinimalProject(linkRoot, fixture.project as Record<string, unknown>);
        const linkPreview = previewMigration({
          project: fixture.project,
          target_mode: "shadow",
          projectRoot: linkRoot,
          coordinator: true
        });
        await expect(applyMigration({
          project: fixture.project,
          target_mode: "shadow",
          projectRoot: linkRoot,
          actor: "coordinator",
          expected_preview_digest: linkPreview.digest,
          coordinator: true,
          now: () => NOW,
          crash_after_stage: "snapshot",
          crash_hook: async () => {
            throw new Error("crash-after-snapshot-link");
          }
        })).rejects.toThrow(/crash-after-snapshot-link/);
        const linkPreviewPath = join(
          resolveCanonicalProductionControlRoot(linkRoot),
          "migration",
          `preview-${linkPreview.digest.slice(0, 16)}.json`
        );
        await mkdir(dirname(linkPreviewPath), { recursive: true });
        await symlink(join(linkRoot, "project.yaml"), linkPreviewPath);
        await expect(applyMigration({
          project: fixture.project,
          target_mode: "shadow",
          projectRoot: linkRoot,
          actor: "coordinator",
          expected_preview_digest: linkPreview.digest,
          coordinator: true,
          now: () => "2026-08-12T18:09:00.000Z"
        })).rejects.toMatchObject({ code: "PC_PATH_UNSAFE" });
      } finally {
        await rm(linkRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
