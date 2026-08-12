import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { symlink } from "node:fs/promises";
import {
  assertRepoRelativePath,
  buildReadinessFromStore,
  commandOutputDigest,
  ingestBrowserRuntimeEvidence,
  readEvidenceStore,
  recordCommandEvidence,
  recordCoverage,
  sanitizePublicText,
  validateReadinessReportFile,
  writeEvidenceStore,
  writeReadinessReportFile,
  type DurableEvidenceStore
} from "../src/productionControl/rc/evidenceStore.js";
import { runReadinessCli } from "../src/productionControl/rc/readinessCli.js";
import { collectStructuralEvidence } from "../src/productionControl/rc/structuralEvidence.js";
import { hashCommandOutput } from "../src/productionControl/rc/releaseReadiness.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("PO-8 RC evidence store + readiness CLI", () => {
  it("redacts absolute paths and binds command output_digest", async () => {
    const storeRoot = await tempDir("tsugite-po8-ev-");
    const dirty = [
      "ok line",
      "path=/Users/example/secret/project",
      "token=not-a-real-secret-but-matches"
    ].join("\n");
    expect(sanitizePublicText(dirty)).not.toMatch(/\/Users\//);
    expect(sanitizePublicText(dirty)).toMatch(/redacted/);

    const recorded = await recordCommandEvidence({
      storeRoot,
      id: "full_regression",
      command: "npm run check",
      exit_code: 0,
      output: "check ok\n"
    });
    expect(recorded.evidence.output_digest).toBe(hashCommandOutput("check ok\n"));
    expect(recorded.evidence.artifact_refs?.[0]?.relative_path).toBe("commands/full_regression.log");
    const store = await readEvidenceStore(storeRoot);
    expect(store.measured.full_regression?.output_digest).toBe(recorded.evidence.output_digest);
    expect(await readFile(join(storeRoot, "commands/full_regression.log"), "utf8")).toBe("check ok\n");
  });

  it("ingests browser runtime evidence and refuses unmeasured paths", async () => {
    const storeRoot = await tempDir("tsugite-po8-br-");
    const runtime = await tempDir("tsugite-po8-br-run-");
    await writeFile(join(runtime, "actual-canvas.png"), "png-bytes");
    await writeFile(join(runtime, "manifest.json"), `${JSON.stringify({
      schema_version: 1,
      fixture_only: true,
      primary_mode: "fallback",
      measured: {
        webgl_unavailable: true,
        context_lost: true,
        initialization_failed: true,
        first_frame_timeout: true,
        non_blank_fallback: true,
        keyboard_selection: true,
        mission_tree_decision: true,
        mission_tree_exit: true
      }
    })}\n`);
    const ingested = await ingestBrowserRuntimeEvidence({ runtimeDir: runtime, storeRoot });
    expect(ingested.output_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(ingested.artifact_refs.some((ref) => ref.relative_path === "browser/actual-canvas.png")).toBe(true);
    await recordCommandEvidence({
      storeRoot,
      id: "browser_po0a",
      command: "npm --prefix apps/workflow-viewer run test:browser",
      exit_code: 0,
      output: "browser ok\n"
    });
    const merged = await readEvidenceStore(storeRoot);
    expect(merged.measured.browser_po0a?.artifact_refs?.some((ref) => ref.relative_path === "browser/actual-canvas.png")).toBe(true);
    expect(merged.measured.browser_po0a?.artifact_refs?.some((ref) => ref.relative_path === "commands/browser_po0a.log")).toBe(true);
    await recordCommandEvidence({
      storeRoot,
      id: "command",
      command: "npm run viewer:check",
      exit_code: 0,
      output: "viewer check ok\n"
    });
    expect(await readFile(join(storeRoot, "commands/npm_run_viewer_check.log"), "utf8")).toBe("viewer check ok\n");
    expect(JSON.parse(await readFile(join(storeRoot, "browser/manifest.json"), "utf8")).output_digest)
      .toBe(ingested.output_digest);

    const incomplete = await tempDir("tsugite-po8-br-bad-");
    await writeFile(join(incomplete, "manifest.json"), `${JSON.stringify({
      schema_version: 1,
      fixture_only: true,
      primary_mode: "fallback",
      measured: {
        webgl_unavailable: true,
        context_lost: false,
        initialization_failed: true,
        first_frame_timeout: true,
        non_blank_fallback: true,
        keyboard_selection: true,
        mission_tree_decision: true,
        mission_tree_exit: true
      }
    })}\n`);
    await expect(ingestBrowserRuntimeEvidence({
      runtimeDir: incomplete,
      storeRoot: await tempDir("tsugite-po8-br-bad-store-")
    })).rejects.toThrow(/context_lost/);
  });

  it("builds and validates a digest-bound report from the store without hand hashes", async () => {
    const storeRoot = await tempDir("tsugite-po8-rep-");
    const output = join(await tempDir("tsugite-po8-out-"), "po8-rc-release-readiness.json");
    const store: DurableEvidenceStore = {
      schema_version: 1,
      fixture_only: true,
      package_version: "0.9.0",
      generated_at: "2026-08-13T00:00:00.000Z",
      measured: {
        browser_po0a: {
          command: "npm --prefix apps/workflow-viewer run test:browser",
          exit_code: 0,
          output_digest: commandOutputDigest("browser-ok"),
          status: "proven",
          artifact_refs: [{
            kind: "screenshot",
            relative_path: "browser/actual-canvas.png",
            sha256: "a".repeat(64),
            bytes: 12
          }]
        }
      }
    };
    await writeEvidenceStore(storeRoot, store);
    const report = buildReadinessFromStore(store);
    expect(report.package_version).toBe("0.9.0");
    expect(report.version_decision.bump_to_1_0_0).toBe(false);
    const browser = report.exits.find((exit) => exit.exit_id === "po8-8-po0a-browser");
    expect(browser?.status).toBe("proven");
    expect(browser?.evidence.some((item) => item.startsWith("artifact=browser/actual-canvas.png:"))).toBe(true);
    const written = await writeReadinessReportFile(output, report);
    expect(written.digest).toBe(report.digest);
    const validated = await validateReadinessReportFile(output);
    expect(validated.canonical_digest).toBe(report.digest);
  });

  it("CLI record-command + validate-report stay fixture-only", async () => {
    const storeRoot = await tempDir("tsugite-po8-cli-store-");
    const outputDir = await tempDir("tsugite-po8-cli-out-");
    const log = join(outputDir, "check.log");
    const reportPath = join(outputDir, "report.json");
    await writeFile(log, "vendor check ok\n");
    const recordCode = await runReadinessCli([
      "record-command",
      "--store", storeRoot,
      "--id", "full_regression",
      "--command", "npm run vendor:check",
      "--exit-code", "0",
      "--output-file", log,
      "--json"
    ]);
    expect(recordCode).toBe(0);
    const writeCode = await runReadinessCli([
      "write-report",
      "--store", storeRoot,
      "--output", reportPath,
      "--generated-at", "2026-08-13T00:00:00.000Z",
      "--provenance-head", "b".repeat(40),
      "--json"
    ]);
    expect(writeCode).toBe(0);
    const validateCode = await runReadinessCli([
      "validate-report",
      "--path", reportPath,
      "--json"
    ]);
    expect(validateCode).toBe(0);
    const report = JSON.parse(await readFile(reportPath, "utf8")) as {
      digest: string;
      package_version: string;
      version_decision: { bump_to_1_0_0: boolean };
    };
    expect(report.package_version).toBe("0.9.0");
    expect(report.version_decision.bump_to_1_0_0).toBe(false);
    expect(report.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("records coverage, rejects unsafe relative paths, and covers CLI error/help branches", async () => {
    const storeRoot = await tempDir("tsugite-po8-cov-");
    await recordCoverage(storeRoot, { statements: 82.7, branches: 74.45, functions: 89.7, lines: 85.4 });
    expect((await readEvidenceStore(storeRoot)).coverage?.branches).toBe(74.45);
    expect(() => assertRepoRelativePath("/tmp/x", "x")).toThrow(/repo-relative/);
    expect(() => assertRepoRelativePath("../escape", "x")).toThrow(/escape/);

    const missing = await runReadinessCli(["record-command", "--json"]);
    expect(missing).toBe(1);
    const unknown = await runReadinessCli(["not-a-command", "--json"]);
    expect(unknown).toBe(1);
    const coverageCode = await runReadinessCli([
      "record-coverage",
      "--store", storeRoot,
      "--statements", "82.7",
      "--branches", "74.45",
      "--functions", "89.7",
      "--lines", "85.4",
      "--json"
    ]);
    expect(coverageCode).toBe(0);
    const badCoverage = await runReadinessCli(["record-coverage", "--store", storeRoot, "--json"]);
    expect(badCoverage).toBe(1);
    const ingestMissing = await runReadinessCli(["ingest-browser", "--store", storeRoot, "--json"]);
    expect(ingestMissing).toBe(1);

    const runtime = await tempDir("tsugite-po8-cli-br-");
    await writeFile(join(runtime, "actual-canvas.png"), "png");
    await writeFile(join(runtime, "manifest.json"), `${JSON.stringify({
      schema_version: 1,
      fixture_only: true,
      primary_mode: "canvas",
      measured: {
        webgl_unavailable: true,
        context_lost: true,
        initialization_failed: true,
        first_frame_timeout: true,
        non_blank_fallback: true,
        keyboard_selection: true,
        mission_tree_decision: true,
        mission_tree_exit: true
      }
    })}\n`);
    const ingestCode = await runReadinessCli([
      "ingest-browser",
      "--from", runtime,
      "--store", storeRoot,
      "--json"
    ]);
    expect(ingestCode).toBe(0);

    const emptyStore = await tempDir("tsugite-po8-empty-");
    const reportPath = join(emptyStore, "report.json");
    const writeCode = await runReadinessCli([
      "write-report",
      "--store", emptyStore,
      "--output", reportPath,
      "--generated-at", "2026-08-13T00:00:00.000Z",
      "--json"
    ]);
    expect(writeCode).toBe(0);

    const link = join(await tempDir("tsugite-po8-link-"), "link");
    await symlink(storeRoot, link);
    await expect(ingestBrowserRuntimeEvidence({
      runtimeDir: runtime,
      storeRoot: link
    })).rejects.toThrow(/symlink|real directory|PC_PATH/);
  });

  it("collects fixture-only structural rehearsal/journal evidence", async () => {
    const structural = await collectStructuralEvidence();
    expect(structural.rehearsal.all_ok).toBe(true);
    expect(structural.fixture_module_evidence.all_ok).toBe(true);
    expect(structural.migration_journal.complete).toBe(true);
    expect(structural.mode_orchestrator.status).toBe("proven");
    expect(structural.h3_durable_cli.output_digest).toMatch(/^[a-f0-9]{64}$/);
  }, 180_000);
});
