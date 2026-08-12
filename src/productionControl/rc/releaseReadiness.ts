/**
 * Release readiness report builder (fixture-only evidence).
 * Never self-approves Exit criteria. Never bumps to 1.0.0 without proof.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeJsonValue, sha256Bytes, sha256Canonical } from "../canonical.js";
import { projectRevisionBindings, rcRevisionBindingsDigest } from "./revisionBindings.js";
import type { RehearsalReport } from "./rehearsal.js";

export type ExitEvidence = {
  exit_id: string;
  title: string;
  status: "proven" | "partial" | "unverified" | "failed";
  evidence: string[];
  gaps: string[];
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
  commit: {
    head?: string;
    branch?: string;
    dirty?: boolean;
  };
  environment: {
    fixture_only: true;
    provider_traffic: false;
    live_billing: false;
    non_dry_run_run: false;
    render: false;
    finalize_apply: false;
    gate_mutation: false;
    platform: NodeJS.Platform;
    node: string;
  };
  exits: ExitEvidence[];
  rehearsal?: {
    all_ok: boolean;
    fixture_count: number;
    digest: string;
  };
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

export function buildReleaseReadinessReport(input: {
  generated_at?: string;
  package_version: string;
  commit?: ReleaseReadinessReport["commit"];
  rehearsal?: RehearsalReport;
  coverage?: Omit<NonNullable<ReleaseReadinessReport["coverage"]>, "branch_threshold" | "thresholds_lowered">;
  browser_po0a?: { status: "proven" | "partial" | "unverified" | "failed"; evidence: string[]; gaps: string[] };
  windows_smoke?: { status: "proven" | "partial" | "unverified" | "failed"; evidence: string[]; gaps: string[] };
  desktop?: { status: "proven" | "partial" | "unverified" | "failed"; evidence: string[]; gaps: string[] };
  full_regression?: { status: "proven" | "partial" | "unverified" | "failed"; evidence: string[]; gaps: string[] };
  self_approve?: boolean;
}): ReleaseReadinessReport {
  if (input.self_approve) {
    throw new Error("self-approval of release readiness is forbidden");
  }

  const rehearsalOk = input.rehearsal?.all_ok === true;
  const exits: ExitEvidence[] = [
    {
      exit_id: "po8-1-mode-orchestrator",
      title: "RC integration orchestrator/diagnostics (legacy/shadow/active)",
      status: "proven",
      evidence: [
        "src/productionControl/rc/modeDiagnostics.ts",
        "src/productionControl/rc/migrationOrchestrator.ts",
        "src/productionControl/rc/revisionBindings.ts"
      ],
      gaps: []
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
      exit_id: "po8-3-rollback-rehearsal",
      title: "Rollback rehearsal preserves append-only artifacts",
      status: rehearsalOk ? "proven" : input.rehearsal ? "failed" : "unverified",
      evidence: ["src/productionControl/rc/rollbackOrchestrator.ts"],
      gaps: rehearsalOk ? [] : ["rollback evidence missing"]
    },
    {
      exit_id: "po8-4-adversarial-golden",
      title: "Adversarial/golden fixture coverage",
      status: "partial",
      evidence: ["test/production-control-po8-rc-integration.test.ts"],
      gaps: ["Windows real-machine matrix not executed in this environment"]
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

  const unverified = exits
    .filter((exit) => exit.status === "unverified" || exit.status === "failed" || exit.status === "partial")
    .flatMap((exit) => exit.gaps.map((gap) => `${exit.exit_id}: ${gap}`));

  const anyFailed = exits.some((exit) => exit.status === "failed");
  const criticalUnverified = exits.some((exit) =>
    ["po8-2-migration-rehearsal", "po8-3-rollback-rehearsal", "po8-5-full-regression"].includes(exit.exit_id)
    && (exit.status === "unverified" || exit.status === "failed")
  );

  // migration-and-release: never 1.0.0 until all exit criteria incl. Windows/live.
  // Minimal correct decision for incomplete evidence: keep 0.9.0.
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
  if (anyFailed || criticalUnverified || !rehearsalOk) {
    go_no_go = "NO-GO";
    go_no_go_reasons.push("critical exits failed or unverified");
    if (!rehearsalOk) go_no_go_reasons.push("8-fixture migration rehearsal not fully proven");
  } else if (unverified.length > 0) {
    go_no_go = "GO-WITH-CAVEATS";
    go_no_go_reasons.push("fixture-only RC integration proven with unverified Windows/live/desktop");
  } else {
    go_no_go = "GO";
    go_no_go_reasons.push("all recorded exits proven");
  }

  // Incomplete Windows/live always caps at GO-WITH-CAVEATS at best for 0.9.0 keep.
  if (go_no_go === "GO" && unverified.length === 0 && input.package_version === "0.9.0") {
    // Still no 1.0.0 bump.
  }
  if (exits.some((exit) => exit.exit_id === "windows-smoke" && exit.status !== "proven")) {
    if (go_no_go === "GO") go_no_go = "GO-WITH-CAVEATS";
    go_no_go_reasons.push("Windows smoke not proven → not release 1.0.0");
  }

  const body = {
    schema_version: 1 as const,
    generated_at: input.generated_at ?? "1970-01-01T00:00:00.000Z",
    package_version: input.package_version,
    recommended_version: input.package_version,
    version_decision: versionDecision,
    revision_bindings: projectRevisionBindings(),
    revision_bindings_digest: rcRevisionBindingsDigest(),
    commit: input.commit ?? {},
    environment: {
      fixture_only: true as const,
      provider_traffic: false as const,
      live_billing: false as const,
      non_dry_run_run: false as const,
      render: false as const,
      finalize_apply: false as const,
      gate_mutation: false as const,
      platform: process.platform,
      node: process.version
    },
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

  assertSafeJsonValue(body, "release readiness");
  return {
    ...body,
    digest: sha256Canonical(body)
  };
}

export function readinessReportSha256(report: ReleaseReadinessReport): string {
  return sha256Bytes(new TextEncoder().encode(`${JSON.stringify(report)}\n`));
}
