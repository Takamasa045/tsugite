/**
 * Fixture-only PO-8 RC readiness CLI.
 * Records measured command/browser evidence and regenerates the digest-bound report.
 * Never self-approves, never bumps to 1.0.0, never talks to providers.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DEFAULT_EVIDENCE_RELATIVE_ROOT,
  DEFAULT_READINESS_RELATIVE_PATH,
  assertEvidenceArtifactsConsistent,
  buildReadinessFromStore,
  ingestBrowserRuntimeEvidence,
  publicStructuralProjection,
  readEvidenceStore,
  recordCommandEvidence,
  recordCoverage,
  validateReadinessReportFile,
  writeEvidenceStore,
  writeReadinessReportFile,
  type DurableEvidenceStore
} from "./evidenceStore.js";
import { readPackageVersion, type CommandEvidence } from "./releaseReadiness.js";

export type ReadinessCliResult = {
  ok: boolean;
  action: string;
  detail?: Record<string, unknown>;
};

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function has(argv: string[], name: string): boolean {
  return argv.includes(name);
}

export async function runReadinessCli(argv: string[]): Promise<number> {
  const action = argv[0];
  const json = has(argv, "--json");
  try {
    const result = await dispatch(argv);
    if (json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(`${result.action} ok=${result.ok}\n`);
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const payload = { ok: false, action: action ?? "unknown", error: message };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    return 1;
  }
}

async function dispatch(argv: string[]): Promise<ReadinessCliResult> {
  const action = argv[0];
  const storeRoot = resolve(flag(argv, "--store") ?? DEFAULT_EVIDENCE_RELATIVE_ROOT);
  if (action === "record-command") {
    const id = flag(argv, "--id");
    const command = flag(argv, "--command");
    const exit = flag(argv, "--exit-code");
    const outputFile = flag(argv, "--output-file");
    if (!id || !command || exit === undefined || !outputFile) {
      throw new Error("record-command requires --id --command --exit-code --output-file");
    }
    const status = flag(argv, "--status") as CommandEvidence["status"] | undefined;
    const detail = flag(argv, "--detail");
    const output = await readFile(resolve(outputFile), "utf8");
    const recorded = await recordCommandEvidence({
      storeRoot,
      id: id as "browser_po0a",
      command,
      exit_code: Number(exit),
      output,
      status,
      detail
    });
    return { ok: true, action, detail: { output_digest: recorded.evidence.output_digest } };
  }
  if (action === "ingest-browser") {
    const from = flag(argv, "--from");
    if (!from) throw new Error("ingest-browser requires --from <runtime-dir>");
    const ingested = await ingestBrowserRuntimeEvidence({
      runtimeDir: resolve(from),
      storeRoot
    });
    return {
      ok: true,
      action,
      detail: {
        output_digest: ingested.output_digest,
        artifact_count: ingested.artifact_refs.length
      }
    };
  }
  if (action === "write-report") {
    const output = resolve(flag(argv, "--output") ?? DEFAULT_READINESS_RELATIVE_PATH);
    const store = await loadOrInitStore(storeRoot);
    if (has(argv, "--recompute-structural")) {
      const { collectStructuralEvidence } = await import("./structuralEvidence.js");
      const structural = await collectStructuralEvidence();
      const publicStructural = publicStructuralProjection({
        rehearsal: structural.rehearsal,
        fixture_module_evidence: structural.fixture_module_evidence
      });
      store.rehearsal = publicStructural.rehearsal;
      store.fixture_module_evidence = publicStructural.fixture_module_evidence;
      store.ledger = structural.ledger;
      store.observer = structural.observer;
      store.migration_journal = structural.migration_journal;
      if (!store.measured.mode_orchestrator) {
        store.measured.mode_orchestrator = structural.mode_orchestrator;
      }
      if (!store.measured.h3_durable_cli) {
        store.measured.h3_durable_cli = structural.h3_durable_cli;
      }
      if (!store.measured.reader_commands && structural.reader_commands) {
        store.measured.reader_commands = structural.reader_commands;
      }
      await writeEvidenceStore(storeRoot, store);
    }
    const head = flag(argv, "--provenance-head");
    await assertEvidenceArtifactsConsistent(storeRoot);
    const report = buildReadinessFromStore(store, {
      generated_at: flag(argv, "--generated-at") ?? new Date().toISOString(),
      build_provenance: {
        ...(head ? { head } : {}),
        branch: flag(argv, "--provenance-branch") ?? "HEAD",
        dirty: has(argv, "--dirty"),
        verified_separately: true
      }
    });
    const written = await writeReadinessReportFile(output, report);
    return {
      ok: true,
      action,
      detail: {
        digest: written.digest,
        canonical_digest: written.canonical_digest,
        go_no_go: report.go_no_go
      }
    };
  }
  if (action === "record-coverage") {
    const statements = Number(flag(argv, "--statements"));
    const branches = Number(flag(argv, "--branches"));
    const functions = Number(flag(argv, "--functions"));
    const lines = Number(flag(argv, "--lines"));
    if (![statements, branches, functions, lines].every(Number.isFinite)) {
      throw new Error("record-coverage requires --statements --branches --functions --lines");
    }
    await recordCoverage(storeRoot, { statements, branches, functions, lines });
    return { ok: true, action, detail: { statements, branches, functions, lines } };
  }
  if (action === "validate-report") {
    const path = resolve(flag(argv, "--path") ?? DEFAULT_READINESS_RELATIVE_PATH);
    const validated = await validateReadinessReportFile(path);
    return { ok: true, action, detail: validated };
  }
  throw new Error("usage: record-command | ingest-browser | record-coverage | write-report | validate-report");
}

async function loadOrInitStore(storeRoot: string): Promise<DurableEvidenceStore> {
  try {
    return await readEvidenceStore(storeRoot);
  } catch {
    const package_version = await readPackageVersion();
    const store: DurableEvidenceStore = {
      schema_version: 1,
      fixture_only: true,
      package_version,
      measured: {}
    };
    await writeEvidenceStore(storeRoot, store);
    return store;
  }
}

const isDirect = process.argv[1] && resolve(process.argv[1]).endsWith("readinessCli.js");
if (isDirect) {
  process.exit(await runReadinessCli(process.argv.slice(2)));
}
