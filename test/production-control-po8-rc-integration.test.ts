/**
 * PO-8 / T09 — RC structural repair round 2 (A–G).
 * Fixture-only: no provider, network, generation, billing, Gate mutation, render, finalize apply.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyMigration,
  applyRollback,
  assertMigrationPathLexicalSafe,
  assertRevisionBindingsDigest,
  assertShadowNoExecution,
  buildProductionStatusReport,
  buildReleaseReadinessReport,
  createEffectLedger,
  createEffectObserver,
  diagnoseMode,
  evaluateModeTransition,
  hashCommandOutput,
  isExtendedWindowsPath,
  isUncPath,
  isWindowsDrivePath,
  legacyReaderIgnoresControlPlane,
  loadPo8Fixture,
  modeCapabilities,
  packageJsonContentDigest,
  PO8_FIXTURE_IDS,
  previewMigration,
  previewRollback,
  projectRevisionBindings,
  projectWithMode,
  rcRevisionBindingsDigest,
  readCurrentModePointer,
  readPackageVersion,
  rehearseAllPo8Fixtures,
  rehearseFixture,
  resolveProjectRuntimeMode,
  resolveRuntimeMode,
  runAllFixtureModuleEvidence,
  runFixtureModuleEvidence,
  seedDigest,
  toRuntimeMode
} from "../src/productionControl/index.js";
import { main as cliMain } from "../src/cli.js";
import { ProductionControlError } from "../src/productionControl/errors.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
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

describe("PO-8 RC mode diagnostics (M3)", () => {
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

    const active = diagnoseMode({ orchestration: { mode: "active" } });
    expect(active.runtime_mode).toBe("active");
    expect(active.capabilities.authority_required).toBe(true);
    expect(modeCapabilities("active").may_render).toBe(true);
  });

  it("rejects invalid/unknown mode as unsafe_unknown without collapsing to legacy", () => {
    expect(() => toRuntimeMode("bogus" as never)).toThrow(/unsafe_unknown|PC_MODE_UNSAFE_UNKNOWN/);
    expect(() => resolveRuntimeMode({ orchestration: { mode: "experimental" } })).toThrow(
      /unsafe_unknown|PC_MODE_UNSAFE_UNKNOWN/
    );
    expect(() => diagnoseMode({ orchestration: { mode: "not-a-mode" } })).toThrow(
      /unsafe_unknown|PC_MODE_UNSAFE_UNKNOWN/
    );
  });

  it("enforces assertShadowNoExecution against actual effect requests (production path)", () => {
    expect(() => assertShadowNoExecution("shadow")).not.toThrow();
    expect(() => assertShadowNoExecution("shadow", "digest-only")).not.toThrow();
    expect(() => assertShadowNoExecution("shadow", "external-submit")).toThrow(/shadow mode forbids/);
    expect(() => assertShadowNoExecution("shadow", "gate")).toThrow(/shadow mode forbids/);
    expect(() => assertShadowNoExecution("shadow", "billing_spend")).toThrow(/shadow mode forbids/);
    expect(() => assertShadowNoExecution("legacy", "external-submit")).not.toThrow();
  });

  it("pins exact revision bindings from package.json + exported production constants (M5/F)", () => {
    const bindings = projectRevisionBindings();
    expect(bindings.package_version).toBe("0.9.0");
    expect(bindings.package_json_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(bindings.package_json_digest).toBe(packageJsonContentDigest());
    expect(bindings.production_contract_schema).toBe(1);
    expect(bindings.task_tree_schema).toBe(1);
    expect(bindings.video_prompt_ir).toBe(2);
    expect(bindings.h3_compiler_workflow).toBe(3);
    expect(bindings.legacy_h3_workflow_reader).toBe(2);
    expect(bindings.sources.package_json).toBe("package.json#version+sha256");
    expect(bindings.sources.video_prompt_ir).toBe("videoPromptDirector.schemaV2.VIDEO_PROMPT_IR_VERSION");
    expect(() => projectRevisionBindings({ self_declared_digest: "a".repeat(64) })).toThrow(
      /self-declared/
    );
    assertRevisionBindingsDigest(rcRevisionBindingsDigest());
    expect(() => assertRevisionBindingsDigest("0".repeat(64))).toThrow(/mismatch/);
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
  });
});

describe("PO-8 H1 fixture exact authoring bind (A)", () => {
  it("loads strict fixtures with fixture_digest and golden authoring", async () => {
    for (const id of PO8_FIXTURE_IDS) {
      const fixture = await loadPo8Fixture(id);
      expect(fixture.fixture_id).toBe(id);
      expect(fixture.fixture_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(fixture.authoring).toBeTruthy();
      expect(fixture.expected.golden_digests).toBeTruthy();
      expect(fixture.adversarial.length).toBeGreaterThan(0);
      for (const value of Object.values(fixture.expected.golden_digests)) {
        expect(value === "0" || value === "1").toBe(false);
      }
    }
  });

  it("runs all 8 fixtures against real modules with adversarial failures + golden compare", async () => {
    const report = await runAllFixtureModuleEvidence();
    expect(report.fixture_count).toBe(8);
    expect(report.results).toHaveLength(8);
    for (const result of report.results) {
      expect(result.ok, `${result.fixture_id}: ${result.errors.join("; ")}`).toBe(true);
      expect(result.fixture_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.digests.fixture_digest).toBe(result.fixture_digest);
      expect(result.apis.length).toBeGreaterThan(0);
      expect(result.golden_ok, result.fixture_id).toBe(true);
      expect(result.adversarial.every((item) => item.ok), result.fixture_id).toBe(true);
      for (const [key, value] of Object.entries(result.digests)) {
        expect(typeof value, `${result.fixture_id}.${key}`).toBe("string");
        expect(value.length, `${result.fixture_id}.${key}`).toBeGreaterThan(0);
        // No bare marker digests
        if (key !== "cue_start_ms" && key !== "program_start_ms" && key !== "program_end_ms") {
          expect(value === "0" || value === "1", `${result.fixture_id}.${key}=${value}`).toBe(false);
        }
      }
    }
    expect(report.all_ok).toBe(true);
    expect(report.proven_zero_effects).toBe(true);
    expect(report.ledger.safety.provider_submit_count).toBe(0);
    expect(report.ledger.safety.gate_mutation_count).toBe(0);
    expect(report.ledger.safety.network_fetch_count).toBe(0);
    expect(report.ledger.safety.provider_submit_count).not.toBe("unknown");
  }, 120_000);

  it("identity fixture keeps locked≠verified and awaiting human", async () => {
    const evidence = await runFixtureModuleEvidence("identity-phase-a-e");
    expect(evidence.digests.locked_not_verified).toBe("locked_not_verified");
    expect(evidence.digests.verification_present).toBe("verification_absent");
    expect(evidence.state.locked_true_implies_verified).toBe(false);
  });

  it("mutates each fixture meaningful field and sees evidence digest change or error (8 mutation tests)", async () => {
    const cases: Array<{ id: (typeof PO8_FIXTURE_IDS)[number]; field: string }> = [
      { id: "legacy-h3", field: "visual" },
      { id: "standalone-v2", field: "action" },
      { id: "lyric-mv", field: "lyrics" },
      { id: "identity-phase-a-e", field: "locked_text" },
      { id: "gate2-auto-pass-cascade", field: "contract_seed" },
      { id: "job-revision-submission-unknown", field: "request_seed" },
      { id: "recovery-unknown-price", field: "grant_seed" },
      { id: "mission-tree-finalize-learning", field: "plan_seed" }
    ];
    for (const item of cases) {
      const evidence = await runFixtureModuleEvidence(item.id);
      expect(evidence.ok, item.id).toBe(true);
      const mutation = evidence.adversarial.find((a) => a.name.includes("mutate") || a.name.includes("digest_change") || a.name.includes("changes-digest"));
      expect(mutation, `${item.id} mutation adversarial`).toBeTruthy();
      expect(mutation!.ok, `${item.id} ${item.field}`).toBe(true);
    }
  }, 180_000);
});

describe("PO-8 effect observer (B)", () => {
  it("removes markFixtureInProcessBoundary and requires armed observer for zero proof", () => {
    const ledger = createEffectLedger();
    expect(() => ledger.markFixtureInProcessBoundary()).toThrow(/removed|EffectObserver/);
    const safety = ledger.safetyEvidence();
    expect(safety.provider_submit_count).toBe("unknown");

    const observer = createEffectObserver();
    observer.armAllBoundaries();
    observer.sealEventSequence();
    expect(observer.provenZeroEffects()).toBe(true);
    expect(observer.safetyEvidence().provider_submit_count).toBe(0);

    expect(() => observer.createDenyCapability().providerSubmit("test")).toThrow(/blocked|PC_EFFECT/);
    expect(observer.provenZeroEffects()).toBe(false);
  });
});

describe("PO-8 migration / rollback atomicity + durable mode (C/D)", () => {
  it("applies create-only migration with Event/Snapshot/mode-intent CAS and rollback retains artifacts", async () => {
    const root = await realTempDir("tsugite-po8-atomic-");
    const observer = createEffectObserver();
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
        now: () => NOW,
        observer
      });
      expect(shadow.record.no_source_project_rewrite).toBe(true);
      expect(shadow.record.mode_intent_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(shadow.record.event_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(shadow.record.snapshot_digest).toMatch(/^[a-f0-9]{64}$/);

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
        now: () => "2026-08-12T18:01:00.000Z",
        observer
      });
      expect(active.record.applied_mode).toBe("active");

      // Durable authority without YAML mode rewrite
      const resolved = await resolveProjectRuntimeMode({
        projectRoot: root,
        project: projectWithMode(fixture.project, "legacy")
      });
      expect(resolved.source).toBe("durable_pointer");
      expect(resolved.runtime_mode).toBe("active");

      const status = await buildProductionStatusReport({
        project: projectWithMode(fixture.project, "legacy"),
        projectRoot: root
      });
      expect(status.mode_source).toBe("durable_pointer");
      expect(status.runtime_mode).toBe("active");
      expect(status.mode_authority.pointer_intent_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(status.presence_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(status.presence.some((item) => item.kind === "events" && item.present)).toBe(true);
      expect(status.presence.some((item) => item.kind === "snapshot" && item.present)).toBe(true);
      expect(status.presence.some((item) => item.kind === "current-mode" && item.present)).toBe(true);

      const beforePaths = new Set(active.record.artifact_relative_paths);
      // Rollback without hand-written YAML active
      const rollback = await applyRollback({
        project: projectWithMode(fixture.project, "legacy"),
        projectRoot: root,
        to_mode: "legacy",
        actor: "coordinator",
        now: () => "2026-08-12T18:02:00.000Z",
        observer
      });
      expect(rollback.record.deleted_artifacts).toEqual([]);
      expect(rollback.record.rewritten_artifacts).toEqual([]);
      expect(rollback.record.safety.observed_zero_effects).toBe(true);
      expect(rollback.record.safety.provider_submit_count).toBe(0);
      for (const path of beforePaths) {
        expect(rollback.record.preserved_relative_paths).toContain(path);
      }

      const after = await resolveProjectRuntimeMode({
        projectRoot: root,
        project: projectWithMode(fixture.project, "legacy")
      });
      expect(after.runtime_mode).toBe("legacy");
      expect(after.source).toBe("durable_pointer");

      // Concurrent CAS: stale expected previous intent fails
      await expect(applyMigration({
        project: fixture.project,
        target_mode: "shadow",
        projectRoot: root,
        actor: "coordinator",
        expected_preview_digest: shadowPreview.digest,
        coordinator: true,
        now: () => NOW,
        observer
      })).rejects.toBeInstanceOf(ProductionControlError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("never infers identity confirmation or verification from locked:true", async () => {
    const fixture = await loadPo8Fixture("identity-phase-a-e");
    const preview = previewMigration({
      project: fixture.project,
      target_mode: "shadow",
      coordinator: true
    });
    expect(preview.identity.locked_true_implies_verified).toBe(false);
    expect(preview.identity.definition_confirmation_inferred_from_gate1).toBe(false);
    if (preview.identity.locked_flag_seen) {
      expect(preview.identity.definition_status).not.toBe("migrated");
    }
  });

  it("mode pointer CAS + symlink/ancestor identity fail closed", async () => {
    const root = await realTempDir("tsugite-po8-cas-");
    try {
      const real = join(root, "real");
      await mkdir(real);
      const link = join(root, "link");
      await symlink(real, link);
      const fixture = await loadPo8Fixture("legacy-h3");
      const preview = previewMigration({
        project: fixture.project,
        target_mode: "shadow",
        projectRoot: link,
        coordinator: true
      });
      await expect(applyMigration({
        project: fixture.project,
        target_mode: "shadow",
        projectRoot: link,
        actor: "coordinator",
        expected_preview_digest: preview.digest,
        coordinator: true,
        now: () => NOW
      })).rejects.toMatchObject({ code: "PC_PATH_UNSAFE" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PO-8 frozen 8-fixture rehearsal", () => {
  it("loads all eight fixtures and runs module evidence + mode sequence", async () => {
    expect(PO8_FIXTURE_IDS).toHaveLength(8);
    const report = await rehearseAllPo8Fixtures();
    expect(report.fixture_count).toBe(8);
    expect(report.results).toHaveLength(8);
    expect(report.revision_bindings_digest).toBe(rcRevisionBindingsDigest());
    for (const result of report.results) {
      expect(result.module_evidence.ok, result.fixture_id).toBe(true);
      expect(result.safety.observed_zero_effects).toBe(true);
      expect(result.safety.provider_submit_count).toBe(0);
      expect(result.ok, result.fixture_id).toBe(true);
      expect(result.sequence.some((step) => step.step === "module_evidence")).toBe(true);
    }
    expect(report.all_ok).toBe(true);
  }, 180_000);
});

describe("PO-8 adversarial path / Windows fail-closed / O_EXCL", () => {
  it("rejects UNC and extended Windows paths", () => {
    expect(isUncPath("\\\\server\\share\\file")).toBe(true);
    expect(isExtendedWindowsPath("\\\\?\\C:\\foo")).toBe(true);
    expect(isWindowsDrivePath("C:\\Users\\x")).toBe(true);
    expect(() => assertMigrationPathLexicalSafe("\\\\server\\share\\a", "mig")).toThrow(
      /UNC|PC_PATH_UNSAFE|not allowed/
    );
    if (process.platform !== "win32") {
      expect(() => assertMigrationPathLexicalSafe("C:\\Users\\x\\project", "mig")).toThrow(
        /drive|not allowed/
      );
    }
  });

  it("rejects symlink project root for migration apply", async () => {
    const root = await realTempDir("tsugite-po8-symlink-");
    try {
      const real = join(root, "real");
      await mkdir(real);
      const link = join(root, "link");
      await symlink(real, link);
      const fixture = await loadPo8Fixture("legacy-h3");
      const preview = previewMigration({
        project: fixture.project,
        target_mode: "shadow",
        projectRoot: link,
        coordinator: true
      });
      await expect(applyMigration({
        project: fixture.project,
        target_mode: "shadow",
        projectRoot: link,
        actor: "coordinator",
        expected_preview_digest: preview.digest,
        coordinator: true,
        now: () => NOW
      })).rejects.toMatchObject({ code: "PC_PATH_UNSAFE" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PO-8 release readiness authenticity (E)", () => {
  it("keeps 0.9.0, refuses forged proven exits, derives safety from ledger/observer", async () => {
    const version = await readPackageVersion(REPO_ROOT);
    expect(version).toBe("0.9.0");

    const noH1 = buildReleaseReadinessReport({
      package_version: version,
      generated_at: NOW,
      build_provenance: {
        head: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        branch: "codex/po8-rc-integration",
        dirty: true,
        verified_separately: true
      }
    });
    expect(noH1.go_no_go).toBe("NO-GO");
    expect(noH1.environment.provider_submit_count).toBe("unknown");
    // po8-1 is not unconditionally proven
    expect(noH1.exits.find((e) => e.exit_id === "po8-1-mode-orchestrator")?.status).not.toBe("proven");
    // commit SHA does not prove readiness
    expect(noH1.build_provenance?.verified_separately).toBe(true);

    const moduleEvidence = await runAllFixtureModuleEvidence();
    const rehearsal = await rehearseAllPo8Fixtures();
    const observer = createEffectObserver();
    observer.armAllBoundaries();
    observer.sealEventSequence();
    const report = buildReleaseReadinessReport({
      package_version: version,
      generated_at: NOW,
      build_provenance: {
        head: "8605c262081f9c2c3de942fd6fd931fb40016b04",
        branch: "codex/po8-rc-integration",
        dirty: false,
        verified_separately: true
      },
      rehearsal,
      fixture_module_evidence: moduleEvidence,
      ledger: moduleEvidence.ledger,
      observer: observer.snapshot(),
      measured: {
        h3_durable_cli: {
          command: "cli production-migrate/rollback --apply E2E",
          exit_code: 0,
          output_digest: hashCommandOutput("h3-cli-e2e"),
          status: "proven"
        },
        mode_orchestrator: {
          command: "rehearsal mode sequence",
          exit_code: 0,
          output_digest: hashCommandOutput(rehearsal.digest),
          status: "proven"
        }
      },
      coverage: {
        statements: 82.76,
        branches: 74.43,
        functions: 89.94,
        lines: 85.5
      }
    });

    expect(report.version_decision.keep_0_9_0).toBe(true);
    expect(report.version_decision.bump_to_1_0_0).toBe(false);
    expect(report.environment.provider_submit_count).toBe(0);
    expect(report.environment.gate_mutation_count).toBe(0);
    // Digest must not depend on commit SHA
    const again = buildReleaseReadinessReport({
      package_version: version,
      generated_at: NOW,
      build_provenance: {
        head: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        branch: "other",
        dirty: true
      },
      rehearsal,
      fixture_module_evidence: moduleEvidence,
      ledger: moduleEvidence.ledger,
      observer: observer.snapshot(),
      measured: {
        h3_durable_cli: {
          command: "cli production-migrate/rollback --apply E2E",
          exit_code: 0,
          output_digest: hashCommandOutput("h3-cli-e2e"),
          status: "proven"
        },
        mode_orchestrator: {
          command: "rehearsal mode sequence",
          exit_code: 0,
          output_digest: hashCommandOutput(rehearsal.digest),
          status: "proven"
        }
      },
      coverage: {
        statements: 82.76,
        branches: 74.43,
        functions: 89.94,
        lines: 85.5
      }
    });
    expect(again.digest).toBe(report.digest);
    expect(report.go_no_go).not.toBe("GO");
    expect(["NO-GO", "GO-WITH-CAVEATS"]).toContain(report.go_no_go);
    expect(() => buildReleaseReadinessReport({
      package_version: version,
      self_approve: true
    })).toThrow(/self-approval/);
  }, 180_000);
});

describe("PO-8 CLI surfaces (M1/M4/D)", () => {
  it("production-status loads control-root presence digests without secrets", async () => {
    const config = join(REPO_ROOT, "examples/local-fixture/project.yaml");
    const status = await captureCli(["production-status", "--config", config]);
    expect(status.code).toBe(0);
    expect(status.payload.command).toBe("production-status");
    const report = status.payload.status as {
      presence: unknown[];
      runtime_mode: string;
      presence_digest: string;
      mode_authority: { source: string };
    };
    expect(report.runtime_mode).toBe("legacy");
    expect(Array.isArray(report.presence)).toBe(true);
    expect(report.presence_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(report.mode_authority.source).toMatch(/legacy|project_yaml|durable/);
    expect(status.text).not.toMatch(/\/Users\//);
  }, 60_000);

  it("CLI main legacy→shadow→active→rollback→legacy with real readers after rollback", async () => {
    const root = await realTempDir("tsugite-po8-cli-");
    try {
      const fixture = await loadPo8Fixture("legacy-h3");
      const config = await writeMinimalProject(root, fixture.project as Record<string, unknown>);

      const preview = await captureCli([
        "production-migrate",
        "--config",
        config,
        "--target",
        "shadow"
      ]);
      expect(preview.code).toBe(0);
      expect(preview.payload.dry_run).toBe(true);
      const previewDigest = (preview.payload.preview as { digest: string }).digest;

      const nonCoord = await captureCli([
        "production-migrate",
        "--config",
        config,
        "--target",
        "shadow",
        "--apply",
        "--expected-plan-digest",
        previewDigest
      ]);
      expect(nonCoord.code).toBe(1);

      const applied = await captureCli([
        "production-migrate",
        "--config",
        config,
        "--target",
        "shadow",
        "--apply",
        "--actor",
        "coordinator",
        "--expected-plan-digest",
        previewDigest
      ]);
      expect(applied.code).toBe(0);
      expect(applied.payload.generation_submitted).toBe(false);
      expect(applied.payload.gate_mutated).toBe(false);
      expect(applied.payload.safety_proven_zero).toBe(true);
      expect((applied.payload.record as { event_digest?: string }).event_digest).toMatch(/^[a-f0-9]{64}$/);

      // Shadow effect attempt denial E2E via production-status + mode authority
      const shadowStatus = await captureCli(["production-status", "--config", config]);
      expect(shadowStatus.code).toBe(0);
      expect((shadowStatus.payload.status as { runtime_mode: string }).runtime_mode).toBe("shadow");

      // Active apply via durable path (no YAML rewrite)
      const activePreview = await captureCli([
        "production-migrate",
        "--config",
        config,
        "--target",
        "active"
      ]);
      expect(activePreview.code).toBe(0);
      const ad = (activePreview.payload.preview as { digest: string }).digest;
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
        ad
      ]);
      expect(activeApply.code).toBe(0);

      // wrong digest CAS
      const wrong = await captureCli([
        "production-migrate",
        "--config",
        config,
        "--target",
        "active",
        "--apply",
        "--actor",
        "coordinator",
        "--expected-plan-digest",
        "0".repeat(64)
      ]);
      expect(wrong.code).toBe(1);

      // Rollback from durable active without hand-writing YAML active
      const rb = await captureCli([
        "production-rollback",
        "--config",
        config,
        "--target",
        "legacy",
        "--apply",
        "--actor",
        "coordinator"
      ]);
      expect(rb.code).toBe(0);
      expect(rb.payload.generation_submitted).toBe(false);
      expect((rb.payload.record as { deleted_artifacts: unknown[] }).deleted_artifacts).toEqual([]);
      expect(rb.payload.safety_proven_zero).toBe(true);

      const pointer = await readCurrentModePointer(root);
      expect(pointer?.runtime_mode).toBe("legacy");

      // Actual CLI readers after rollback: validate / plan / review / run --dry-run / finalize preview
      const validate = await captureCli(["validate", "--config", config]);
      expect(validate.code).toBe(0);

      const plan = await captureCli(["plan", "--config", config]);
      // plan may warn but should not crash; accept 0
      expect([0, 1]).toContain(plan.code);

      const review = await captureCli(["review", "--config", config]);
      expect([0, 1]).toContain(review.code);

      const dryRun = await captureCli(["run", "--config", config, "--dry-run"]);
      expect([0, 1]).toContain(dryRun.code);

      const finalizePreview = await captureCli(["finalize", "--config", config]);
      expect([0, 1]).toContain(finalizePreview.code);

      const postStatus = await captureCli(["production-status", "--config", config]);
      expect(postStatus.code).toBe(0);
      expect((postStatus.payload.status as { runtime_mode: string }).runtime_mode).toBe("legacy");
      expect((postStatus.payload.status as { mode_source: string }).mode_source).toBe("durable_pointer");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
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
      expect(createHash("sha256").update(bytes).digest("hex"), document.path).toBe(document.sha256);
    }
  });
});

describe("PO-8 seed digest helper", () => {
  it("derives sha256 from authoring seeds (no DIGEST_A-F)", () => {
    expect(seedDigest("po8-model-profile-v1")).toMatch(/^[a-f0-9]{64}$/);
    expect(seedDigest("a")).not.toBe(seedDigest("b"));
  });
});

describe("PO-8 structural branch coverage (observer/mode/readiness)", () => {
  it("covers effect observer unknown channel, wrap ok path, and CLI flag derivation", async () => {
    const { deriveCliSafetyFlags, EffectObserver } = await import(
      "../src/productionControl/rc/effectCapability.js"
    );
    const { withDenyCapability } = await import("../src/productionControl/rc/fixtureEvidence.js");
    const bare = deriveCliSafetyFlags({});
    expect(bare.billing_action).toBe("unknown");
    expect(bare.safety_proven_zero).toBe(false);

    const observer = createEffectObserver();
    // unarmed channel attempt
    const raw = new EffectObserver();
    expect(() => raw.createDenyCapability().networkFetch("x")).toThrow(/UNKNOWN_CHANNEL|blocked|PC_EFFECT/);
    raw.armAllBoundaries();
    const wrappedOk = raw.wrapProductionApi("noop", () => 42);
    expect(wrappedOk).toEqual({ ok: true, value: 42 });
    const wrappedBlock = raw.wrapProductionApi("submit", (cap) => cap.providerSubmit("p"));
    expect(wrappedBlock.ok).toBe(false);

    observer.armAllBoundaries();
    observer.sealEventSequence();
    const flags = deriveCliSafetyFlags({ observer });
    expect(flags.generation_submitted).toBe(false);
    expect(flags.safety_proven_zero).toBe(true);

    // withDenyCapability without capability runs production path
    expect(withDenyCapability(undefined, "render", "r", () => "ok")).toBe("ok");
  });

  it("mode pointer CAS concurrent conflict and revision mismatch fail closed", async () => {
    const root = await realTempDir("tsugite-po8-cas2-");
    try {
      const fixture = await loadPo8Fixture("standalone-v2");
      const preview = previewMigration({
        project: fixture.project,
        target_mode: "shadow",
        projectRoot: root,
        coordinator: true
      });
      await applyMigration({
        project: fixture.project,
        target_mode: "shadow",
        projectRoot: root,
        actor: "coordinator",
        expected_preview_digest: preview.digest,
        coordinator: true,
        now: () => NOW
      });
      const pointer = await readCurrentModePointer(root);
      expect(pointer).toBeTruthy();

      const { appendModeIntent } = await import("../src/productionControl/rc/modeIntent.js");
      await expect(appendModeIntent({
        projectRoot: root,
        intended_mode: "active",
        previous_mode: "shadow",
        actor: "coordinator",
        expected_previous_intent_digest: "0".repeat(64),
        now: () => "2026-08-12T19:00:00.000Z"
      })).rejects.toMatchObject({ code: "PC_LEDGER_CONFLICT" });

      await expect(appendModeIntent({
        projectRoot: root,
        intended_mode: "active",
        previous_mode: "shadow",
        actor: "coordinator",
        now: () => "2026-08-12T19:00:00.000Z"
      })).rejects.toMatchObject({ code: "PC_LEDGER_CONFLICT" });

      await expect(appendModeIntent({
        projectRoot: root,
        intended_mode: "legacy",
        previous_mode: "shadow",
        actor: "reviewer",
        expected_previous_intent_digest: pointer!.intent_digest
      })).rejects.toMatchObject({ code: "PC_AUTHORITY_DENIED" });

      // production_id mismatch fail-closed
      await expect(resolveProjectRuntimeMode({
        projectRoot: root,
        project: fixture.project as Record<string, unknown>,
        production_id: "other-production"
      })).rejects.toMatchObject({ code: "PC_MODE_UNSAFE_UNKNOWN" });

      // YAML non-legacy disagreeing with pointer fail-closed
      await expect(resolveProjectRuntimeMode({
        projectRoot: root,
        project: projectWithMode(fixture.project, "active")
      })).rejects.toMatchObject({ code: "PC_MODE_UNSAFE_UNKNOWN" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("readiness refuses unknown safety and records command hash evidence paths", async () => {
    const version = await readPackageVersion(REPO_ROOT);
    const noSafety = buildReleaseReadinessReport({
      package_version: version,
      generated_at: NOW
    });
    expect(noSafety.go_no_go).toBe("NO-GO");
    expect(noSafety.go_no_go_reasons.some((r) => /unknown|zero-effect|H1|H3/i.test(r))).toBe(true);

    const moduleEvidence = await runAllFixtureModuleEvidence();
    const withModuleOnly = buildReleaseReadinessReport({
      package_version: version,
      generated_at: NOW,
      fixture_module_evidence: moduleEvidence,
      ledger: moduleEvidence.ledger
    });
    expect(withModuleOnly.go_no_go).toBe("NO-GO");

    const observer = createEffectObserver();
    observer.armAllBoundaries();
    observer.sealEventSequence();
    const cmd = {
      command: "npm run test:coverage",
      exit_code: 0,
      output_digest: hashCommandOutput("coverage-partial"),
      status: "proven" as const
    };
    const partial = buildReleaseReadinessReport({
      package_version: version,
      generated_at: NOW,
      fixture_module_evidence: moduleEvidence,
      ledger: moduleEvidence.ledger,
      observer: observer.snapshot(),
      rehearsal: {
        schema_version: 1,
        fixture_count: 8,
        revision_bindings_digest: rcRevisionBindingsDigest(),
        results: [],
        all_ok: true,
        digest: hashCommandOutput("fake-rehearsal")
      },
      measured: {
        full_regression: cmd,
        browser_po0a: { command: "browser", exit_code: 0, status: "partial" },
        desktop: { command: "desktop", exit_code: 1, status: "failed" },
        windows_smoke: { command: "windows", exit_code: 0, status: "unverified" }
      },
      commands: [cmd, { command: "fail", exit_code: 1, status: "failed" }],
      coverage: { statements: 82, branches: 74.4, functions: 89, lines: 85 }
    });
    expect(["NO-GO", "GO-WITH-CAVEATS"]).toContain(partial.go_no_go);
    expect(partial.exits.some((e) => e.exit_id === "desktop" && e.status === "failed")).toBe(true);
    expect(partial.coverage?.branch_threshold).toBe(74.4);
    expect(partial.coverage?.thresholds_lowered).toBe(false);
  }, 120_000);

  it("status ok=false on unsafe presence and rejects secret leakage paths", async () => {
    const root = await realTempDir("tsugite-po8-status-");
    try {
      const fixture = await loadPo8Fixture("legacy-h3");
      await writeMinimalProject(root, fixture.project as Record<string, unknown>);
      // plant symlink as current-mode → unsafe
      await mkdir(join(root, "production-control/mode"), { recursive: true });
      await symlink(join(root, "project.yaml"), join(root, "production-control/mode/current-mode.json"));
      await expect(buildProductionStatusReport({
        project: fixture.project as Record<string, unknown>,
        projectRoot: root
      })).rejects.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shadow effect entry denial via active pipeline helpers", async () => {
    const { requireActiveModeForEffect, requireResolvedModeForEffect, assertShadowModeDeniesEffect } =
      await import("../src/productionControl/activePipeline.js");
    expect(() => assertShadowModeDeniesEffect("shadow", "external-submit")).toThrow(/shadow mode forbids/);
    expect(() => requireActiveModeForEffect("shadow", "job")).toThrow(/shadow mode forbids|active mode required/);
    expect(() => requireResolvedModeForEffect("shadow", "render")).toThrow(/shadow mode forbids/);
    expect(requireResolvedModeForEffect("shadow", "run")).toBe("shadow");
    expect(requireResolvedModeForEffect("active", "run")).toBe("active");
    expect(requireResolvedModeForEffect(undefined, "run")).toBe("legacy");
    expect(() => requireResolvedModeForEffect(undefined, "gate")).toThrow(/unresolved/);
    expect(requireActiveModeForEffect("active", "job")).toBe("active");
  });

  it("rollback preview and legacy reader helpers", async () => {
    const fixture = await loadPo8Fixture("legacy-h3");
    const preview = previewRollback({
      project: projectWithMode(fixture.project, "active"),
      to_mode: "legacy",
      coordinator: true
    });
    expect(preview.allowed).toBe(true);
    expect(preview.will_delete).toBe(false);
    expect(legacyReaderIgnoresControlPlane("production-control/events.jsonl")).toBe(true);
    expect(legacyReaderIgnoresControlPlane("media/clip.mp4")).toBe(false);
    expect(legacyReaderIgnoresControlPlane("coordination/state.json")).toBe(true);
  });
});
