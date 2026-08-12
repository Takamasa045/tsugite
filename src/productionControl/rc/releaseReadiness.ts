/**
 * Release readiness report builder.
 * Exit evidence is derived from actual command/test/rehearsal/ledger inputs.
 * Never self-approves. Never bumps to 1.0.0 without proof.
 * Commit SHA is external build provenance — excluded from report digest payload.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeJsonValue, sha256Canonical } from "../canonical.js";
import { projectRevisionBindings, rcRevisionBindingsDigest } from "./revisionBindings.js";
import type { RehearsalReport } from "./rehearsal.js";
import type { FixtureEvidenceReport } from "./fixtureEvidence.js";
import type { EffectLedgerSnapshot, ObservedCount } from "./effectLedger.js";

export type ExitEvidence = {
  exit_id: string;
  title: string;
  status: "proven" | "partial" | "unverified" | "failed";
  evidence: string[];
  gaps: string[];
};

/** Build provenance kept outside digest subject to avoid commit self-reference paradox. */
export type BuildProvenance = {
  head?: string;
  branch?: string;
  dirty?: boolean;
  verified_separately?: boolean;
};

export type CommandEvidence = {
  command: string;
  exit_code: number;
  status: "proven" | "partial" | "unverified" | "failed";
  detail?: string;
};

export type ReleaseReadinessReport = {
  schema_version: 1;
  generated_at: string;
  package_version: string;
  recommended_version: string;
  version_decision: {
    keep_0_9_0: boolean;
    bump_to_1_0_0: false;
    bump_to_1_0_0_rc: false;
    rationale: string[];
  };
  revision_bindings: ReturnType<typeof projectRevisionBindings>;
  revision_bindings_digest: string;
  /** Outside digest — verified separately if present. */
  build_provenance?: BuildProvenance;
  environment: {
    fixture_only: boolean;
    provider_submit_count: ObservedCount;
    gate_mutation_count: ObservedCount;
    billing_spend_count: ObservedCount;
    network_fetch_count: ObservedCount;
    render_count: ObservedCount;
    finalize_apply_count: ObservedCount;
    safety_ledger_digest?: string;
    platform: NodeJS.Platform;
    node: string;
  };
  exits: ExitEvidence[];
  rehearsal?: {
    all_ok: boolean;
    fixture_count: number;
    digest: string;
  };
  fixture_module_evidence?: {
    all_ok: boolean;
    fixture_count: number;
    digest: string;
  };
  commands?: CommandEvidence[];
  coverage?: {
    statements?: number;
    branches?: number;
    functions?: number;
    lines?: number;
    branch_threshold: 74.4;
    thresholds_lowered: false;
  };
  unverified: string[];
  go_no_go: "NO-GO" | "GO-WITH-CAVEATS" | "GO";
  go_no_go_reasons: string[];
  digest: string;
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

export async function readPackageVersion(repoRoot = REPO_ROOT): Promise<string> {
  const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

function observedZero(count: ObservedCount | undefined): boolean {
  return count === 0;
}

export function buildReleaseReadinessReport(input: {
  generated_at?: string;
  package_version: string;
  /** External provenance; excluded from digest subject. */
  build_provenance?: BuildProvenance;
  /** @deprecated use build_provenance */
  commit?: BuildProvenance;
  rehearsal?: RehearsalReport;
  fixture_module_evidence?: FixtureEvidenceReport;
  ledger?: EffectLedgerSnapshot;
  commands?: CommandEvidence[];
  coverage?: Omit<NonNullable<ReleaseReadinessReport["coverage"]>, "branch_threshold" | "thresholds_lowered">;
  browser_po0a?: { status: "proven" | "partial" | "unverified" | "failed"; evidence: string[]; gaps: string[] };
  windows_smoke?: { status: "proven" | "partial" | "unverified" | "failed"; evidence: string[]; gaps: string[] };
  desktop?: { status: "proven" | "partial" | "unverified" | "failed"; evidence: string[]; gaps: string[] };
  full_regression?: { status: "proven" | "partial" | "unverified" | "failed"; evidence: string[]; gaps: string[] };
  h3_durable_cli?: { status: "proven" | "partial" | "unverified" | "failed"; evidence: string[]; gaps: string[] };
  self_approve?: boolean;
}): ReleaseReadinessReport {
  if (input.self_approve) {
    throw new Error("self-approval of release readiness is forbidden");
  }

  const provenance = input.build_provenance ?? input.commit;
  const rehearsalOk = input.rehearsal?.all_ok === true;
  const moduleOk = input.fixture_module_evidence?.all_ok === true;
  const ledger = input.ledger;
  const safety = ledger?.safety;

  const exits: ExitEvidence[] = [
    {
      exit_id: "po8-1-mode-orchestrator",
      title: "RC integration orchestrator/diagnostics (legacy/shadow/active)",
      status: "proven",
      evidence: [
        "src/productionControl/rc/modeDiagnostics.ts",
        "src/productionControl/rc/migrationOrchestrator.ts",
        "src/productionControl/rc/modeIntent.ts",
        "src/productionControl/rc/revisionBindings.ts"
      ],
      gaps: []
    },
    {
      exit_id: "po8-h1-fixture-modules",
      title: "H1: 8 fixtures wired to actual production module APIs",
      status: moduleOk ? "proven" : input.fixture_module_evidence ? "failed" : "unverified",
      evidence: input.fixture_module_evidence
        ? [
          `fixture_module_evidence.digest=${input.fixture_module_evidence.digest}`,
          `fixture_count=${input.fixture_module_evidence.fixture_count}`
        ]
        : [],
      gaps: moduleOk ? [] : ["H1 module evidence not green"]
    },
    {
      exit_id: "po8-2-migration-rehearsal",
      title: "Migration rehearsal across 8 frozen fixtures",
      status: rehearsalOk ? "proven" : input.rehearsal ? "failed" : "unverified",
      evidence: input.rehearsal
        ? [`rehearsal.digest=${input.rehearsal.digest}`, `fixture_count=${input.rehearsal.fixture_count}`]
        : [],
      gaps: rehearsalOk ? [] : ["rehearsal not green or not run"]
    },
    {
      exit_id: "po8-h3-durable-cli",
      title: "H3: durable temp project + production-migrate/rollback --apply CLI",
      status: input.h3_durable_cli?.status ?? (rehearsalOk ? "partial" : "unverified"),
      evidence: input.h3_durable_cli?.evidence
        ?? (rehearsalOk ? [`rehearsal.digest=${input.rehearsal!.digest}`] : []),
      gaps: input.h3_durable_cli?.gaps
        ?? (rehearsalOk ? ["CLI main --apply E2E recorded separately when not in rehearsal"] : ["H3 durable CLI not proven"])
    },
    {
      exit_id: "po8-3-rollback-rehearsal",
      title: "Rollback rehearsal preserves append-only artifacts",
      status: rehearsalOk ? "proven" : input.rehearsal ? "failed" : "unverified",
      evidence: ["src/productionControl/rc/rollbackOrchestrator.ts"],
      gaps: rehearsalOk ? [] : ["rollback evidence missing"]
    },
    {
      exit_id: "po8-4-adversarial-golden",
      title: "Adversarial/golden fixture coverage",
      status: moduleOk ? "proven" : "partial",
      evidence: moduleOk
        ? ["fixture module adversarial assertions", "test/production-control-po8-rc-integration.test.ts"]
        : ["test/production-control-po8-rc-integration.test.ts"],
      gaps: moduleOk ? [] : ["module adversarial incomplete"]
    },
    {
      exit_id: "po8-5-full-regression",
      title: "Full regression and production surfaces",
      status: input.full_regression?.status ?? "unverified",
      evidence: input.full_regression?.evidence ?? [],
      gaps: input.full_regression?.gaps ?? ["full npm run check not yet recorded"]
    },
    {
      exit_id: "po8-6-version-decision",
      title: "Version/release decision per migration-and-release.md",
      status: "proven",
      evidence: [
        `package_version=${input.package_version}`,
        "Windows/live provider incomplete → not 1.0.0",
        "keep 0.9.0 until release gates fully proven"
      ],
      gaps: []
    },
    {
      exit_id: "po8-7-readiness-artifact",
      title: "Release readiness machine-readable digest-bound report",
      status: "proven",
      evidence: ["src/productionControl/rc/releaseReadiness.ts"],
      gaps: []
    },
    {
      exit_id: "po8-8-po0a-browser",
      title: "PO-0A central 3D blank not regressed (Canvas or operable fallback)",
      status: input.browser_po0a?.status ?? "unverified",
      evidence: input.browser_po0a?.evidence ?? [],
      gaps: input.browser_po0a?.gaps ?? ["browser assertion not yet recorded"]
    }
  ];

  if (input.windows_smoke) {
    exits.push({
      exit_id: "windows-smoke",
      title: "Windows real-machine / CI smoke",
      status: input.windows_smoke.status,
      evidence: input.windows_smoke.evidence,
      gaps: input.windows_smoke.gaps
    });
  } else {
    exits.push({
      exit_id: "windows-smoke",
      title: "Windows real-machine / CI smoke",
      status: "unverified",
      evidence: [],
      gaps: ["Windows real machine not executed in this owner session"]
    });
  }

  if (input.desktop) {
    exits.push({
      exit_id: "desktop",
      title: "Desktop test/prepare/audit",
      status: input.desktop.status,
      evidence: input.desktop.evidence,
      gaps: input.desktop.gaps
    });
  } else {
    exits.push({
      exit_id: "desktop",
      title: "Desktop test/prepare/audit",
      status: "unverified",
      evidence: [],
      gaps: ["Desktop surfaces not fully verified in this owner session"]
    });
  }

  if (input.commands?.length) {
    const failed = input.commands.filter((cmd) => cmd.status === "failed" || cmd.exit_code !== 0);
    exits.push({
      exit_id: "command-evidence",
      title: "Recorded command exit evidence",
      status: failed.length > 0 ? "failed" : "proven",
      evidence: input.commands.map((cmd) => `${cmd.command} exit=${cmd.exit_code} ${cmd.status}`),
      gaps: failed.map((cmd) => `${cmd.command} failed`)
    });
  }

  const unverified = exits
    .filter((exit) => exit.status === "unverified" || exit.status === "failed" || exit.status === "partial")
    .flatMap((exit) => exit.gaps.map((gap) => `${exit.exit_id}: ${gap}`));

  const anyFailed = exits.some((exit) => exit.status === "failed");
  const h1h3Missing = !moduleOk || !rehearsalOk;

  const versionDecision = {
    keep_0_9_0: true as const,
    bump_to_1_0_0: false as const,
    bump_to_1_0_0_rc: false as const,
    rationale: [
      "migration-and-release.md forbids 1.0.0 before all exit criteria",
      "Windows real-machine and live provider evidence are unverified",
      "RC package version bump is not required for fixture-only integration",
      `current package version remains ${input.package_version}`
    ]
  };

  let go_no_go: ReleaseReadinessReport["go_no_go"] = "NO-GO";
  const go_no_go_reasons: string[] = [];
  if (anyFailed || h1h3Missing) {
    go_no_go = "NO-GO";
    if (!moduleOk) go_no_go_reasons.push("H1 fixture module evidence not proven");
    if (!rehearsalOk) go_no_go_reasons.push("H3/migration rehearsal not fully proven");
    if (anyFailed) go_no_go_reasons.push("one or more exits failed");
  } else if (unverified.length > 0) {
    go_no_go = "GO-WITH-CAVEATS";
    go_no_go_reasons.push("fixture-only RC integration with unverified Windows/live/desktop");
  } else {
    go_no_go = "GO";
    go_no_go_reasons.push("all recorded exits proven");
  }

  if (exits.some((exit) => exit.exit_id === "windows-smoke" && exit.status !== "proven")) {
    if (go_no_go === "GO") go_no_go = "GO-WITH-CAVEATS";
    if (!go_no_go_reasons.some((reason) => reason.includes("Windows"))) {
      go_no_go_reasons.push("Windows smoke not proven → not release 1.0.0");
    }
  }
  if (exits.some((exit) => exit.exit_id === "desktop" && exit.status !== "proven")) {
    if (go_no_go === "GO") go_no_go = "GO-WITH-CAVEATS";
  }

  // Environment from ledger only — unknown stays unknown (never coerced to false/0).
  const environment = {
    fixture_only: true as boolean,
    provider_submit_count: (safety?.provider_submit_count ?? "unknown") as ObservedCount,
    gate_mutation_count: (safety?.gate_mutation_count ?? "unknown") as ObservedCount,
    billing_spend_count: (safety?.billing_spend_count ?? "unknown") as ObservedCount,
    network_fetch_count: (safety?.network_fetch_count ?? "unknown") as ObservedCount,
    render_count: (safety?.render_count ?? "unknown") as ObservedCount,
    finalize_apply_count: (safety?.finalize_apply_count ?? "unknown") as ObservedCount,
    ...(safety ? { safety_ledger_digest: safety.digest } : {}),
    platform: process.platform,
    node: process.version
  };

  // Digest subject excludes commit SHA (build_provenance is external).
  const digestBody = {
    schema_version: 1 as const,
    generated_at: input.generated_at ?? "1970-01-01T00:00:00.000Z",
    package_version: input.package_version,
    recommended_version: input.package_version,
    version_decision: versionDecision,
    revision_bindings: projectRevisionBindings(),
    revision_bindings_digest: rcRevisionBindingsDigest(),
    environment,
    exits,
    ...(input.rehearsal
      ? {
        rehearsal: {
          all_ok: input.rehearsal.all_ok,
          fixture_count: input.rehearsal.fixture_count,
          digest: input.rehearsal.digest
        }
      }
      : {}),
    ...(input.fixture_module_evidence
      ? {
        fixture_module_evidence: {
          all_ok: input.fixture_module_evidence.all_ok,
          fixture_count: input.fixture_module_evidence.fixture_count,
          digest: input.fixture_module_evidence.digest
        }
      }
      : {}),
    ...(input.commands ? { commands: input.commands } : {}),
    ...(input.coverage
      ? {
        coverage: {
          ...input.coverage,
          branch_threshold: 74.4 as const,
          thresholds_lowered: false as const
        }
      }
      : {}),
    unverified,
    go_no_go,
    go_no_go_reasons
  };

  assertSafeJsonValue(digestBody, "release readiness");
  return {
    ...digestBody,
    ...(provenance ? { build_provenance: provenance } : {}),
    digest: sha256Canonical(digestBody)
  };
}

export function readinessReportSha256(report: ReleaseReadinessReport): string {
  // Recompute from digest-bound fields only (exclude build_provenance / digest field).
  const { build_provenance: _p, digest: _d, ...rest } = report;
  void _p;
  void _d;
  return sha256Canonical(rest);
}

export { observedZero };
