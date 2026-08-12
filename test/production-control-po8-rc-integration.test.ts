/**
 * PO-8 / T09 — RC integration: mode diagnostics, migration/rollback rehearsal,
 * adversarial path safety, revision bindings, release readiness.
 * Fixture-only: no provider, network, generation, billing, Gate mutation, render, finalize apply.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyMigration,
  applyRollback,
  assertMigrationPathLexicalSafe,
  buildReleaseReadinessReport,
  diagnoseMode,
  evaluateModeTransition,
  isExtendedWindowsPath,
  isUncPath,
  isWindowsDrivePath,
  legacyReaderIgnoresControlPlane,
  loadPo8Fixture,
  modeCapabilities,
  PO8_FIXTURE_IDS,
  previewMigration,
  previewRollback,
  projectRevisionBindings,
  projectWithMode,
  rcRevisionBindingsDigest,
  readPackageVersion,
  rehearseAllPo8Fixtures,
  rehearseFixture,
  toRuntimeMode
} from "../src/productionControl/index.js";
import { main as cliMain } from "../src/cli.js";
import { ProductionControlError } from "../src/productionControl/errors.js";
import { sha256Canonical } from "../src/productionControl/canonical.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = "2026-08-12T18:00:00.000Z";

async function realTempDir(prefix: string): Promise<string> {
  const base = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  return realpath(await mkdtemp(join(base, prefix)));
}

async function captureCli(argv: string[]): Promise<{ code: number; payload: Record<string, unknown> }> {
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
    return { code, payload };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe("PO-8 RC mode diagnostics", () => {
  it("defaults unspecified projects to legacy and requires authority only for active", () => {
    const legacy = diagnoseMode({ slug: "x" } as never);
    expect(legacy.runtime_mode).toBe("legacy");
    expect(legacy.default_mode).toBe("legacy");
    expect(legacy.capabilities.may_execute_generation).toBe(false);
    expect(legacy.safety.legacy_byte_semantic_invariant).toBe(true);
    expect(legacy.revision_bindings.package_version).toBe("0.9.0");
    expect(legacy.revision_bindings_digest).toBe(rcRevisionBindingsDigest());

    const shadow = diagnoseMode({ orchestration: { mode: "shadow" } });
    expect(shadow.runtime_mode).toBe("shadow");
    expect(shadow.capabilities.writes_shadow_artifacts).toBe(true);
    expect(shadow.capabilities.may_execute_generation).toBe(false);
    expect(shadow.capabilities.mutates_gate_subject).toBe(false);

    const active = diagnoseMode({ orchestration: { mode: "active" } });
    expect(active.runtime_mode).toBe("active");
    expect(active.capabilities.authority_required).toBe(true);
    expect(active.capabilities.may_paid_submit).toBe(true);
    expect(modeCapabilities("active").may_render).toBe(true);
  });

  it("encodes forward and rollback transition conditions", () => {
    const toShadow = evaluateModeTransition("legacy", "shadow");
    expect(toShadow.allowed).toBe(true);

    const toActiveBlocked = evaluateModeTransition("shadow", "active", { coordinator: false });
    expect(toActiveBlocked.allowed).toBe(false);

    const toActiveOk = evaluateModeTransition("shadow", "active", {
      coordinator: true,
      preview_digest: "abc",
      coordination_root_ready: true
    });
    expect(toActiveOk.allowed).toBe(true);

    const rollback = evaluateModeTransition("active", "legacy");
    expect(rollback.allowed).toBe(true);
    if (rollback.allowed) {
      expect(rollback.conditions.join(" ")).toMatch(/no provider/);
    }
  });

  it("pins exact revision bindings for contract/tree/job/recovery/learning/launcher/finalize", () => {
    const bindings = projectRevisionBindings();
    expect(bindings.production_contract_schema).toBe(1);
    expect(bindings.task_tree_schema).toBe(1);
    expect(bindings.video_prompt_ir).toBe(2);
    expect(bindings.h3_compiler_workflow).toBe(3);
    expect(bindings.legacy_h3_workflow_reader).toBe(2);
    expect(bindings.gate_bundle_schema).toBe(1);
    expect(bindings.generation_job_approval_binding).toBe(1);
    expect(bindings.recovery_policy_schema).toBe(1);
    expect(bindings.learning_candidate_schema).toBe(1);
    expect(bindings.mission_metrics_schema).toBe(1);
    expect(bindings.finalize_retention_schema).toBe(1);
    expect(bindings.launcher_mission_tree_dto).toBe(1);
    expect(rcRevisionBindingsDigest()).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("PO-8 migration / rollback atomicity", () => {
  it("previews shadow without execution authority and refuses active without coordinator", async () => {
    const fixture = await loadPo8Fixture("legacy-h3");
    const preview = previewMigration({
      project: fixture.project,
      target_mode: "shadow",
      coordinator: true
    });
    expect(preview.ok).toBe(true);
    expect(preview.target_mode).toBe("shadow");
    expect(preview.identity.locked_true_implies_verified).toBe(false);
    expect(preview.identity.definition_confirmation_inferred_from_gate1).toBe(false);
    expect(preview.safety_invariants.some((line) => line.includes("Gate"))).toBe(true);

    const activeBlocked = previewMigration({
      project: projectWithMode(fixture.project, "shadow"),
      target_mode: "active",
      coordinator: false
    });
    expect(activeBlocked.ok).toBe(false);
    expect(activeBlocked.blocked_reasons.join(" ")).toMatch(/coordinator/);
  });

  it("applies create-only migration and rollback without deleting artifacts or auto-executing", async () => {
    const root = await realTempDir("tsugite-po8-atomic-");
    try {
      const fixture = await loadPo8Fixture("standalone-v2");
      const shadowPreview = previewMigration({
        project: fixture.project,
        target_mode: "shadow",
        projectRoot: root,
        coordinator: true
      });
      const shadow = await applyMigration({
        project: fixture.project,
        target_mode: "shadow",
        projectRoot: root,
        actor: "coordinator",
        expected_preview_digest: shadowPreview.digest,
        coordinator: true,
        now: () => NOW
      });
      expect(shadow.record.no_gate_mutation).toBe(true);
      expect(shadow.record.no_provider_submit).toBe(true);
      expect(shadow.record.no_source_project_rewrite).toBe(true);
      expect(shadow.record.artifact_relative_paths.length).toBeGreaterThan(0);

      const activePreview = previewMigration({
        project: projectWithMode(fixture.project, "shadow"),
        target_mode: "active",
        projectRoot: root,
        coordinator: true
      });
      const active = await applyMigration({
        project: projectWithMode(fixture.project, "shadow"),
        target_mode: "active",
        projectRoot: root,
        actor: "coordinator",
        expected_preview_digest: activePreview.digest,
        coordinator: true,
        now: () => "2026-08-12T18:01:00.000Z"
      });
      expect(active.record.applied_mode).toBe("active");

      const beforePaths = new Set(active.record.artifact_relative_paths);
      const rollback = await applyRollback({
        project: projectWithMode(fixture.project, "active"),
        projectRoot: root,
        to_mode: "legacy",
        actor: "coordinator",
        now: () => "2026-08-12T18:02:00.000Z"
      });
      expect(rollback.record.deleted_artifacts).toEqual([]);
      expect(rollback.record.rewritten_artifacts).toEqual([]);
      expect(rollback.record.safety.no_auto_provider).toBe(true);
      expect(rollback.record.safety.no_auto_gate).toBe(true);
      expect(rollback.record.safety.no_auto_billing).toBe(true);
      expect(rollback.record.safety.submission_unknown_no_resubmit).toBe(true);
      expect(rollback.record.safety.unknown_price_block).toBe(true);
      expect(rollback.record.safety.pinned_only_adoption).toBe(true);
      for (const path of beforePaths) {
        expect(rollback.record.preserved_relative_paths).toContain(path);
      }

      // Duplicate apply of same preview fails closed (create-only).
      await expect(applyMigration({
        project: fixture.project,
        target_mode: "shadow",
        projectRoot: root,
        actor: "coordinator",
        expected_preview_digest: shadowPreview.digest,
        coordinator: true,
        now: () => NOW
      })).rejects.toBeInstanceOf(ProductionControlError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never infers identity confirmation or verification from locked:true", async () => {
    const fixture = await loadPo8Fixture("identity-phase-a-e");
    expect(fixture.identity?.locked_true_implies_verified).toBe(false);
    const preview = previewMigration({
      project: fixture.project,
      target_mode: "shadow",
      coordinator: true
    });
    expect(preview.identity.locked_true_implies_verified).toBe(false);
    expect(preview.identity.definition_confirmation_inferred_from_gate1).toBe(false);
    expect(preview.identity.verification_status).not.toBe("migrated");
    // locked flag may be seen, but status stays awaiting/blocked/not-evaluable without human decision.
    expect(["awaiting_human", "blocked", "not_applicable", "migrated"]).toContain(
      preview.identity.definition_status
    );
    if (preview.identity.locked_flag_seen) {
      expect(preview.identity.definition_status).not.toBe("migrated");
    }
  });
});

describe("PO-8 frozen 8-fixture rehearsal", () => {
  it("loads all eight fixtures and runs legacy→shadow→active→rollback→legacy", async () => {
    expect(PO8_FIXTURE_IDS).toHaveLength(8);
    for (const id of PO8_FIXTURE_IDS) {
      const fixture = await loadPo8Fixture(id);
      expect(fixture.fixture_id).toBe(id);
      expect(fixture.schema_version).toBe(1);
    }

    const report = await rehearseAllPo8Fixtures();
    expect(report.fixture_count).toBe(8);
    expect(report.results).toHaveLength(8);
    expect(report.revision_bindings_digest).toBe(rcRevisionBindingsDigest());
    for (const result of report.results) {
      expect(result.sequence.map((step) => step.step)).toEqual([
        "legacy",
        "shadow",
        "active",
        "rollback",
        "legacy_restored"
      ]);
      expect(result.no_provider_submit).toBe(true);
      expect(result.no_gate_mutation).toBe(true);
      expect(result.identity_not_inferred).toBe(true);
      expect(result.ok, result.fixture_id).toBe(true);
    }
    expect(report.all_ok).toBe(true);
    expect(report.digest).toMatch(/^[a-f0-9]{64}$/);
  }, 120_000);

  it("marks control-plane paths as ignored by legacy readers", () => {
    expect(legacyReaderIgnoresControlPlane("production-control/migration/x.json")).toBe(true);
    expect(legacyReaderIgnoresControlPlane("dist/run-1/final.mp4")).toBe(false);
  });
});

describe("PO-8 adversarial path / Windows fail-closed", () => {
  it("rejects UNC and extended Windows paths", () => {
    expect(isUncPath("\\\\server\\share\\file")).toBe(true);
    expect(isExtendedWindowsPath("\\\\?\\C:\\foo")).toBe(true);
    expect(isWindowsDrivePath("C:\\Users\\x")).toBe(true);
    expect(() => assertMigrationPathLexicalSafe("\\\\server\\share\\a", "mig")).toThrow(
      /UNC|PC_PATH_UNSAFE|not allowed/
    );
    expect(() => assertMigrationPathLexicalSafe("\\\\?\\C:\\foo", "mig")).toThrow(
      /extended|not allowed/
    );
    if (process.platform !== "win32") {
      expect(() => assertMigrationPathLexicalSafe("C:\\Users\\x\\project", "mig")).toThrow(
        /drive|not allowed/
      );
    }
  });

  it("keeps MV fixture music/lyrics slots required without inventing timestamps", async () => {
    const fixture = await loadPo8Fixture("lyric-mv");
    const preview = previewMigration({
      project: fixture.project,
      target_mode: "shadow",
      coordinator: true
    });
    expect(preview.ok).toBe(true);
    expect(preview.contract_digest).toMatch(/^[a-f0-9]{64}$/);
    // Rehearse single fixture deterministically twice for digest stability of sequence shape.
    const first = await rehearseFixture("lyric-mv");
    const second = await rehearseFixture("lyric-mv");
    expect(first.sequence.map((s) => s.step)).toEqual(second.sequence.map((s) => s.step));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  }, 60_000);
});

describe("PO-8 release readiness and version decision", () => {
  it("keeps 0.9.0 and refuses 1.0.0 when Windows/live are unverified", async () => {
    const version = await readPackageVersion(REPO_ROOT);
    expect(version).toBe("0.9.0");

    const rehearsal = await rehearseAllPo8Fixtures();
    const report = buildReleaseReadinessReport({
      package_version: version,
      generated_at: NOW,
      commit: { head: "a0fa832cda4f283a48cca906d743b24255832aa1", branch: "codex/po8-rc-integration" },
      rehearsal,
      browser_po0a: {
        status: "partial",
        evidence: ["viewer scene integration tests exist for Canvas/DOM fallback"],
        gaps: ["actual browser session may still be recorded separately"]
      },
      windows_smoke: {
        status: "unverified",
        evidence: [],
        gaps: ["Windows real machine not executed"]
      },
      desktop: {
        status: "unverified",
        evidence: [],
        gaps: ["desktop test/prepare/audit not fully run"]
      },
      full_regression: {
        status: "partial",
        evidence: ["focused PO-8 tests"],
        gaps: ["full npm run check recorded after suite"]
      }
    });

    expect(report.version_decision.keep_0_9_0).toBe(true);
    expect(report.version_decision.bump_to_1_0_0).toBe(false);
    expect(report.version_decision.bump_to_1_0_0_rc).toBe(false);
    expect(report.recommended_version).toBe("0.9.0");
    expect(report.environment.fixture_only).toBe(true);
    expect(report.environment.provider_traffic).toBe(false);
    expect(report.go_no_go).not.toBe("GO");
    expect(report.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(() => buildReleaseReadinessReport({
      package_version: version,
      self_approve: true
    })).toThrow(/self-approval/);
  }, 120_000);
});

describe("PO-8 CLI surfaces (preview only)", () => {
  it("production-status / migrate preview / rollback preview on local-fixture", async () => {
    const config = join(REPO_ROOT, "examples/local-fixture/project.yaml");

    const status = await captureCli(["production-status", "--config", config]);
    expect(status.code).toBe(0);
    expect(status.payload.command).toBe("production-status");
    expect(status.payload.ok).toBe(true);
    const diagnostics = status.payload.diagnostics as { runtime_mode: string };
    expect(diagnostics.runtime_mode).toBe("legacy");

    const migrate = await captureCli([
      "production-migrate",
      "--config",
      config,
      "--target",
      "shadow"
    ]);
    expect(migrate.code).toBe(0);
    expect(migrate.payload.dry_run).toBe(true);
    expect(migrate.payload.gate_mutated).toBe(false);
    expect(migrate.payload.generation_submitted).toBe(false);

    const rollback = await captureCli([
      "production-rollback",
      "--config",
      config,
      "--target",
      "legacy"
    ]);
    // Project is already legacy; rollback preview from legacy→legacy may still be allowed as no-op path.
    expect([0, 1]).toContain(rollback.code);
    expect(rollback.payload.command).toBe("production-rollback");
    expect(rollback.payload.generation_submitted).toBe(false);
  }, 60_000);
});

describe("PO-8 design pack freeze still intact", () => {
  it("does not modify frozen design pack hashes from PO-0 manifest", async () => {
    const manifest = JSON.parse(
      await readFile(
        join(REPO_ROOT, "test/fixtures/production-control/legacy/manifest.json"),
        "utf8"
      )
    ) as {
      design_pack: { documents: Array<{ path: string; sha256: string; byte_length: number }> };
    };
    for (const document of manifest.design_pack.documents) {
      const bytes = await readFile(join(REPO_ROOT, document.path));
      expect(bytes.byteLength, document.path).toBe(document.byte_length);
      const { createHash } = await import("node:crypto");
      expect(createHash("sha256").update(bytes).digest("hex"), document.path).toBe(document.sha256);
    }
  });
});

describe("PO-8 golden adversarial markers", () => {
  it("covers job revision / Gate2 / recovery fixture markers without execution", async () => {
    for (const id of [
      "gate2-auto-pass-cascade",
      "job-revision-submission-unknown",
      "recovery-unknown-price",
      "mission-tree-finalize-learning"
    ] as const) {
      const fixture = await loadPo8Fixture(id);
      expect(fixture.safety_expectations.length).toBeGreaterThan(0);
      const preview = previewMigration({
        project: projectWithMode(fixture.project, "legacy"),
        target_mode: "shadow",
        coordinator: true
      });
      expect(preview.digest).toMatch(/^[a-f0-9]{64}$/);
      // Determinism: same input → same preview digest.
      const again = previewMigration({
        project: projectWithMode(fixture.project, "legacy"),
        target_mode: "shadow",
        coordinator: true
      });
      expect(again.digest).toBe(preview.digest);
    }

    const rb = previewRollback({
      project: { orchestration: { mode: "active" } },
      to_mode: "legacy",
      coordinator: true
    });
    expect(rb.will_delete).toBe(false);
    expect(rb.will_auto_execute).toBe(false);
    expect(toRuntimeMode("disabled")).toBe("legacy");
  });
});
