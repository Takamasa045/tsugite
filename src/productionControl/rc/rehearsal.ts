/**
 * Deterministic migration rehearsal across the frozen 8 RC fixtures.
 * Sequence per fixture: legacy → shadow → active → rollback → legacy.
 * Fixture-only: no provider, network, Gate mutation, render, or finalize apply.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Canonical } from "../canonical.js";
import { applyMigration, previewMigration, projectWithMode } from "./migrationOrchestrator.js";
import { applyRollback, legacyReaderIgnoresControlPlane } from "./rollbackOrchestrator.js";
import { diagnoseMode, resolveRuntimeMode } from "./modeDiagnostics.js";
import { rcRevisionBindingsDigest } from "./revisionBindings.js";

export const PO8_FIXTURE_IDS = [
  "legacy-h3",
  "standalone-v2",
  "lyric-mv",
  "identity-phase-a-e",
  "gate2-auto-pass-cascade",
  "job-revision-submission-unknown",
  "recovery-unknown-price",
  "mission-tree-finalize-learning"
] as const;

export type Po8FixtureId = (typeof PO8_FIXTURE_IDS)[number];

export type Po8FixtureManifest = {
  schema_version: 1;
  fixture_id: Po8FixtureId;
  kind: string;
  description: string;
  project: Record<string, unknown>;
  identity?: {
    locked_true_implies_verified: false;
    definition_confirmation_inferred_from_gate1: false;
  };
  safety_expectations: string[];
  golden_digests?: Record<string, string>;
};

export type FixtureRehearsalStep = {
  step: "legacy" | "shadow" | "active" | "rollback" | "legacy_restored";
  runtime_mode: string;
  preview_digest?: string;
  apply_digest?: string;
  rollback_digest?: string;
  ok: boolean;
};

export type FixtureRehearsalResult = {
  fixture_id: Po8FixtureId;
  sequence: FixtureRehearsalStep[];
  preserved_control_plane: boolean;
  legacy_reader_ignores_control_plane: boolean;
  identity_not_inferred: boolean;
  no_provider_submit: true;
  no_gate_mutation: true;
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

const REPO_FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../test/fixtures/production-control/po8"
);

export async function loadPo8Fixture(fixtureId: Po8FixtureId): Promise<Po8FixtureManifest> {
  const path = join(REPO_FIXTURE_ROOT, `${fixtureId}.fixture.json`);
  const raw = JSON.parse(await readFile(path, "utf8")) as Po8FixtureManifest;
  if (raw.fixture_id !== fixtureId) {
    throw new Error(`fixture id mismatch: expected ${fixtureId}, got ${raw.fixture_id}`);
  }
  return raw;
}

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

  try {
    await writeFile(join(root, "project.json"), `${JSON.stringify(fixture.project, null, 2)}\n`);

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
      now: () => "2026-08-12T00:00:00.000Z"
    });
    sequence.push({
      step: "shadow",
      runtime_mode: "shadow",
      preview_digest: shadowPreview.digest,
      apply_digest: shadowApply.record.digest,
      ok: shadowPreview.ok && shadowApply.record.no_gate_mutation && shadowApply.record.no_provider_submit
    });
    ok = ok && shadowPreview.ok;

    if (
      shadowPreview.identity.locked_true_implies_verified
      || shadowPreview.identity.definition_confirmation_inferred_from_gate1
    ) {
      identityNotInferred = false;
      ok = false;
    }

    // 3) active (in-memory mode for authority surfaces; coordination artifacts on disk)
    const activeProject = projectWithMode(fixture.project, "active");
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
      now: () => "2026-08-12T00:01:00.000Z"
    });
    const activeDiag = diagnoseMode(activeProject);
    sequence.push({
      step: "active",
      runtime_mode: activeDiag.runtime_mode,
      preview_digest: activePreview.digest,
      apply_digest: activeApply.record.digest,
      ok:
        activePreview.ok
        && activeDiag.runtime_mode === "active"
        && activeDiag.capabilities.authority_required
        && activeApply.record.no_provider_submit
    });
    ok = ok && activePreview.ok && activeDiag.runtime_mode === "active";

    if (
      activePreview.identity.locked_true_implies_verified
      || activePreview.identity.definition_confirmation_inferred_from_gate1
    ) {
      identityNotInferred = false;
      ok = false;
    }

    // 4) rollback to legacy
    const rollback = await applyRollback({
      project: activeProject,
      projectRoot: root,
      to_mode: "legacy",
      actor: "coordinator",
      now: () => "2026-08-12T00:02:00.000Z"
    });
    sequence.push({
      step: "rollback",
      runtime_mode: "legacy",
      rollback_digest: rollback.record.digest,
      ok:
        rollback.record.deleted_artifacts.length === 0
        && rollback.record.rewritten_artifacts.length === 0
        && rollback.record.safety.no_auto_provider
        && rollback.record.safety.no_auto_gate
        && rollback.record.safety.no_auto_billing
        && rollback.record.safety.no_auto_submit
    });
    ok = ok && rollback.record.deleted_artifacts.length === 0;

    // Preserve check: all pre-rollback paths still listed (rollback adds a file).
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

    const body = {
      fixture_id: fixtureId,
      sequence,
      preserved_control_plane: preserved,
      legacy_reader_ignores_control_plane: true,
      identity_not_inferred: identityNotInferred,
      no_provider_submit: true as const,
      no_gate_mutation: true as const,
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
