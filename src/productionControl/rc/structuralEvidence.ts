/**
 * Fixture-only structural RC evidence: rehearsal, H1 modules, observer, journal.
 * Does not talk to providers, mutate real Gates, or run non-dry-run render/finalize.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEffectObserver } from "./effectCapability.js";
import { registerBoundariesViaProductionWrappers, runAllFixtureModuleEvidence } from "./fixtureEvidence.js";
import { applyMigration, previewMigration } from "./migrationOrchestrator.js";
import { journalIsComplete, readMigrationJournal } from "./migrationJournal.js";
import { loadPo8Fixture } from "./po8Fixtures.js";
import { rehearseAllPo8Fixtures } from "./rehearsal.js";
import { hashCommandOutput, type CommandEvidence } from "./releaseReadiness.js";
import type { DurableEvidenceStore } from "./evidenceStore.js";

export async function collectStructuralEvidence(): Promise<{
  rehearsal: NonNullable<DurableEvidenceStore["rehearsal"]>;
  fixture_module_evidence: NonNullable<DurableEvidenceStore["fixture_module_evidence"]>;
  ledger: NonNullable<DurableEvidenceStore["ledger"]>;
  observer: NonNullable<DurableEvidenceStore["observer"]>;
  migration_journal: NonNullable<DurableEvidenceStore["migration_journal"]>;
  mode_orchestrator: CommandEvidence;
  h3_durable_cli: CommandEvidence;
  reader_commands?: CommandEvidence;
}> {
  const fixture_module_evidence = await runAllFixtureModuleEvidence();
  const rehearsal = await rehearseAllPo8Fixtures();
  const observer = createEffectObserver();
  const armRoot = await mkdtemp(join(tmpdir(), "tsugite-po8-struct-arm-"));
  const journalRoot = await mkdtemp(join(tmpdir(), "tsugite-po8-struct-journal-"));
  try {
    await registerBoundariesViaProductionWrappers({ kind: "noop", observer }, armRoot);
    observer.sealEventSequence();

    const fixture = await loadPo8Fixture("legacy-h3");
    const preview = previewMigration({
      project: fixture.project,
      target_mode: "shadow",
      projectRoot: journalRoot,
      coordinator: true
    });
    const applied = await applyMigration({
      project: fixture.project,
      target_mode: "shadow",
      projectRoot: journalRoot,
      actor: "coordinator",
      expected_preview_digest: preview.digest,
      coordinator: true
    });
    const journal = await readMigrationJournal(journalRoot);
    const complete = journalIsComplete(journal, preview.digest);
    const journalDigest = journal && "digest" in journal && typeof journal.digest === "string"
      ? journal.digest
      : hashCommandOutput(JSON.stringify({ preview: preview.digest, applied: applied.journal_complete }));

    return {
      rehearsal,
      fixture_module_evidence,
      ledger: fixture_module_evidence.ledger,
      observer: observer.snapshot(),
      migration_journal: {
        complete,
        preview_digest: preview.digest,
        stage: journal?.stage,
        digest: journalDigest
      },
      mode_orchestrator: {
        command: "rehearsal mode sequence",
        exit_code: rehearsal.all_ok ? 0 : 1,
        output_digest: rehearsal.digest,
        status: rehearsal.all_ok ? "proven" : "failed"
      },
      h3_durable_cli: {
        command: "production applyMigration shadow journal (in-process fixture)",
        exit_code: applied.journal_complete && complete ? 0 : 1,
        output_digest: journalDigest,
        status: applied.journal_complete && complete ? "proven" : "partial",
        detail: "in-process fixture migrate apply; CLI E2E recorded separately when present"
      }
    };
  } finally {
    await rm(armRoot, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
  }
}
