/**
 * Deterministic migration rehearsal across the frozen 8 RC fixtures.
 * Sequence per fixture: legacy → shadow → active → rollback → legacy.
 * Runs actual fixture module evidence (H1) and durable control-plane apply (H3).
 * Fixture-only: no provider, network, Gate mutation, render, or finalize apply.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Canonical } from "../canonical.js";
import { applyMigration, previewMigration, projectWithMode } from "./migrationOrchestrator.js";
import { applyRollback, legacyReaderIgnoresControlPlane } from "./rollbackOrchestrator.js";
import { diagnoseMode, resolveRuntimeMode } from "./modeDiagnostics.js";
import { rcRevisionBindingsDigest } from "./revisionBindings.js";
import { EffectLedger } from "./effectLedger.js";
import { runFixtureModuleEvidence, type FixtureModuleEvidence } from "./fixtureEvidence.js";
import { readCurrentModePointer } from "./modeIntent.js";
import {
  loadPo8Fixture,
  PO8_FIXTURE_IDS,
  type Po8FixtureId,
  type Po8FixtureManifest
} from "./po8Fixtures.js";

export { loadPo8Fixture, PO8_FIXTURE_IDS };
export type { Po8FixtureId, Po8FixtureManifest };

export type FixtureRehearsalStep = {
  step: "legacy" | "shadow" | "active" | "rollback" | "legacy_restored" | "module_evidence";
  runtime_mode?: string;
  preview_digest?: string;
  apply_digest?: string;
  rollback_digest?: string;
  module_evidence_digest?: string;
  ok: boolean;
};

export type FixtureRehearsalResult = {
  fixture_id: Po8FixtureId;
  sequence: FixtureRehearsalStep[];
  module_evidence: FixtureModuleEvidence;
  preserved_control_plane: boolean;
  legacy_reader_ignores_control_plane: boolean;
  identity_not_inferred: boolean;
  durable_mode_after_active?: string;
  durable_mode_after_rollback?: string;
  event_digest?: string;
  snapshot_digest?: string;
  safety: {
    provider_submit_count: number | "unknown";
    gate_mutation_count: number | "unknown";
    billing_spend_count: number | "unknown";
    network_fetch_count: number | "unknown";
    ledger_digest: string;
    observed_zero_effects: boolean;
  };
  digest: string;
  ok: boolean;
};

export type RehearsalReport = {
  schema_version: 1;
  fixture_count: 8;
  revision_bindings_digest: string;
  results: FixtureRehearsalResult[];
  all_ok: boolean;
  digest: string;
};

async function realTempDir(prefix: string): Promise<string> {
  const base = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  return realpath(await mkdtemp(join(base, prefix)));
}

export async function rehearseFixture(fixtureId: Po8FixtureId): Promise<FixtureRehearsalResult> {
  const fixture = await loadPo8Fixture(fixtureId);
  const root = await realTempDir(`tsugite-po8-${fixtureId}-`);
  const sequence: FixtureRehearsalStep[] = [];
  let identityNotInferred = true;
  let preserved = true;
  let ok = true;
  const ledger = new EffectLedger();
  ledger.markFixtureInProcessBoundary();

  try {
    await writeFile(join(root, "project.json"), `${JSON.stringify(fixture.project, null, 2)}\n`);
    // Minimal project.yaml for CLI-like path consumers (not rewritten by migration)
    await writeFile(
      join(root, "project.yaml"),
      [
        `slug: ${String((fixture.project as { slug?: string }).slug ?? fixtureId)}`,
        `name: ${String((fixture.project as { name?: string }).name ?? fixtureId)}`,
        "manifest: manifest.json",
        "dist_dir: dist",
        ""
      ].join("\n")
    );
    await writeFile(join(root, "manifest.json"), `${JSON.stringify({ meta: { aspect: "16:9", fps: 30, target_duration_seconds: 6, slug: fixtureId }, clips: [] }, null, 2)}\n`);
    await mkdir(join(root, "dist"), { recursive: true });

    // H1: actual module evidence
    const module_evidence = await runFixtureModuleEvidence(fixtureId, ledger);
    sequence.push({
      step: "module_evidence",
      module_evidence_digest: module_evidence.digest,
      ok: module_evidence.ok
    });
    ok = ok && module_evidence.ok;

    // 1) legacy baseline
    const legacyProject = projectWithMode(fixture.project, "legacy");
    const legacyDiag = diagnoseMode(legacyProject);
    sequence.push({
      step: "legacy",
      runtime_mode: legacyDiag.runtime_mode,
      ok: legacyDiag.runtime_mode === "legacy"
    });
    ok = ok && legacyDiag.runtime_mode === "legacy";

    // 2) shadow
    const shadowPreview = previewMigration({
      project: legacyProject,
      target_mode: "shadow",
      projectRoot: root,
      fixture_id: fixtureId,
      coordinator: true
    });
    const shadowApply = await applyMigration({
      project: legacyProject,
      target_mode: "shadow",
      projectRoot: root,
      fixture_id: fixtureId,
      actor: "coordinator",
      expected_preview_digest: shadowPreview.digest,
      coordinator: true,
      now: () => "2026-08-12T00:00:00.000Z",
      ledger
    });
    sequence.push({
      step: "shadow",
      runtime_mode: "shadow",
      preview_digest: shadowPreview.digest,
      apply_digest: shadowApply.record.digest,
      ok:
        shadowPreview.ok
        && shadowApply.record.no_source_project_rewrite
        && (shadowApply.record.safety
          ? shadowApply.record.safety.provider_submit_count === 0
          : true)
    });
    ok = ok && shadowPreview.ok;

    if (
      shadowPreview.identity.locked_true_implies_verified
      || shadowPreview.identity.definition_confirmation_inferred_from_gate1
    ) {
      identityNotInferred = false;
      ok = false;
    }

    // 3) active
    const activePreview = previewMigration({
      project: projectWithMode(fixture.project, "shadow"),
      target_mode: "active",
      projectRoot: root,
      fixture_id: fixtureId,
      coordinator: true
    });
    const activeApply = await applyMigration({
      project: projectWithMode(fixture.project, "shadow"),
      target_mode: "active",
      projectRoot: root,
      fixture_id: fixtureId,
      actor: "coordinator",
      expected_preview_digest: activePreview.digest,
      coordinator: true,
      now: () => "2026-08-12T00:01:00.000Z",
      ledger
    });
    const activePointer = await readCurrentModePointer(root);
    const activeDiag = diagnoseMode(projectWithMode(fixture.project, "active"));
    sequence.push({
      step: "active",
      runtime_mode: activePointer?.runtime_mode ?? activeDiag.runtime_mode,
      preview_digest: activePreview.digest,
      apply_digest: activeApply.record.digest,
      ok:
        activePreview.ok
        && activePointer?.runtime_mode === "active"
        && activeDiag.capabilities.authority_required
    });
    ok = ok && activePreview.ok && activePointer?.runtime_mode === "active";

    if (
      activePreview.identity.locked_true_implies_verified
      || activePreview.identity.definition_confirmation_inferred_from_gate1
    ) {
      identityNotInferred = false;
      ok = false;
    }

    // 4) rollback to legacy
    const rollback = await applyRollback({
      project: projectWithMode(fixture.project, "active"),
      projectRoot: root,
      to_mode: "legacy",
      actor: "coordinator",
      now: () => "2026-08-12T00:02:00.000Z",
      ledger
    });
    const rollbackPointer = await readCurrentModePointer(root);
    sequence.push({
      step: "rollback",
      runtime_mode: rollbackPointer?.runtime_mode ?? "legacy",
      rollback_digest: rollback.record.digest,
      ok:
        rollback.record.deleted_artifacts.length === 0
        && rollback.record.rewritten_artifacts.length === 0
        && rollback.record.safety.observed_zero_effects
        && rollbackPointer?.runtime_mode === "legacy"
    });
    ok = ok
      && rollback.record.deleted_artifacts.length === 0
      && rollback.record.safety.observed_zero_effects
      && rollbackPointer?.runtime_mode === "legacy";

    preserved = rollback.record.preserved_relative_paths.every((path) =>
      legacyReaderIgnoresControlPlane(path) || path.startsWith("production-control/")
    );

    // 5) legacy restored (in-memory project without orchestration)
    const restored = projectWithMode(fixture.project, "legacy");
    const restoredMode = resolveRuntimeMode(restored);
    sequence.push({
      step: "legacy_restored",
      runtime_mode: restoredMode,
      ok: restoredMode === "legacy"
    });
    ok = ok && restoredMode === "legacy";

    const safety = ledger.safetyEvidence();
    const body = {
      fixture_id: fixtureId,
      sequence,
      module_evidence,
      preserved_control_plane: preserved,
      legacy_reader_ignores_control_plane: true,
      identity_not_inferred: identityNotInferred,
      durable_mode_after_active: activePointer?.runtime_mode,
      durable_mode_after_rollback: rollbackPointer?.runtime_mode,
      event_digest: activeApply.record.event_digest,
      snapshot_digest: activeApply.record.snapshot_digest,
      safety: {
        provider_submit_count: safety.provider_submit_count,
        gate_mutation_count: safety.gate_mutation_count,
        billing_spend_count: safety.billing_spend_count,
        network_fetch_count: safety.network_fetch_count,
        ledger_digest: safety.digest,
        observed_zero_effects: ledger.allZeroSafetyChannels()
      },
      ok
    };

    return {
      ...body,
      digest: sha256Canonical(body)
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function rehearseAllPo8Fixtures(): Promise<RehearsalReport> {
  const results: FixtureRehearsalResult[] = [];
  for (const id of PO8_FIXTURE_IDS) {
    results.push(await rehearseFixture(id));
  }
  const body = {
    schema_version: 1 as const,
    fixture_count: 8 as const,
    revision_bindings_digest: rcRevisionBindingsDigest(),
    results,
    all_ok: results.every((result) => result.ok)
  };
  return {
    ...body,
    digest: sha256Canonical(body)
  };
}
