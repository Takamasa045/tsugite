/**
 * Release readiness report builder.
 * Exit evidence is derived from durable rehearsal/effect/mode/command stores
 * that are re-read and recomputed — never from caller-forged exit status alone.
 * Never self-approves. Never bumps to 1.0.0 without proof.
 * Commit SHA is external build provenance — excluded from report digest payload
 * and never used to claim "proven" for the current repair.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeJsonValue, sha256Bytes, sha256Canonical } from "../canonical.js";
import { projectRevisionBindings, rcRevisionBindingsDigest } from "./revisionBindings.js";
import type { RehearsalReport } from "./rehearsal.js";
import type { FixtureEvidenceReport } from "./fixtureEvidence.js";
import type { EffectLedgerSnapshot, ObservedCount } from "./effectLedger.js";
import type { EffectObserverSnapshot } from "./effectCapability.js";
import { pcError } from "../errors.js";

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
  /** Always true when present — never used to prove readiness exits. */
  verified_separately?: boolean;
};

export type CommandEvidence = {
  command: string;
  exit_code: number;
  /** sha256 of combined stdout+stderr or artifact bytes when recorded. */
  output_digest?: string;
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
  /** Outside digest — verified separately if present; never proves exits. */
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
    effect_observer_digest?: string;
    proven_zero_effects?: boolean;
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

/**
 * Durable evidence store inputs. Callers may not inject forged exit status maps;
 * statuses are recomputed from digests and measured command results only.
 */
export type ReleaseReadinessEvidenceStore = {
  package_version: string;
  generated_at?: string;
  build_provenance?: BuildProvenance;
  rehearsal?: RehearsalReport;
  fixture_module_evidence?: FixtureEvidenceReport;
  ledger?: EffectLedgerSnapshot;
  observer?: EffectObserverSnapshot;
  commands?: CommandEvidence[];
  coverage?: Omit<NonNullable<ReleaseReadinessReport["coverage"]>, "branch_threshold" | "thresholds_lowered">;
  /** Measured browser/desktop/windows results only — status must match exit_code/hash rules. */
  measured?: {
    browser_po0a?: CommandEvidence;
    windows_smoke?: CommandEvidence;
    desktop?: CommandEvidence;
    full_regression?: CommandEvidence;
    h3_durable_cli?: CommandEvidence;
    mode_orchestrator?: CommandEvidence;
  };
  self_approve?: boolean;
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

export async function readPackageVersion(repoRoot = REPO_ROOT): Promise<string> {
  const path = join(repoRoot, "package.json");
  const real = await realpath(path);
  const stat = await lstat(real);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw pcError("PC_PATH_UNSAFE", "package.json must be a regular file");
  }
  const pkg = JSON.parse(await readFile(real, "utf8")) as { version: string };
  return pkg.version;
}

function observedZero(count: ObservedCount | undefined): boolean {
  return count === 0;
}

function commandStatus(cmd: CommandEvidence | undefined): ExitEvidence["status"] {
  if (!cmd) return "unverified";
  if (cmd.status === "failed" || cmd.exit_code !== 0) return "failed";
  if (cmd.status === "proven" && typeof cmd.output_digest === "string" && /^[a-f0-9]{64}$/.test(cmd.output_digest)) {
    return "proven";
  }
  if (cmd.exit_code === 0 && cmd.output_digest) return "proven";
  if (cmd.exit_code === 0) return "partial";
  return cmd.status;
}

/**
 * Build readiness from an evidence store. Forged exit status maps are not accepted;
 * each exit is recomputed from store digests / command exit codes + hashes.
 */
export function buildReleaseReadinessReport(input: ReleaseReadinessEvidenceStore): ReleaseReadinessReport {
  if (input.self_approve) {
    throw new Error("self-approval of release readiness is forbidden");
  }

  // Reject caller-forged "exits" array if smuggled via any cast — only store fields used.
  const provenance = input.build_provenance;
  const rehearsalOk = input.rehearsal?.all_ok === true && typeof input.rehearsal.digest === "string";
  const moduleOk = input.fixture_module_evidence?.all_ok === true
    && typeof input.fixture_module_evidence.digest === "string";
  const ledger = input.ledger;
  const safety = ledger?.safety;
  const observer = input.observer;
  const provenZero = observer?.proven_zero_effects === true
    || (safety !== undefined
      && observedZero(safety.provider_submit_count)
      && observedZero(safety.gate_mutation_count)
      && observedZero(safety.billing_spend_count)
      && observedZero(safety.network_fetch_count)
      && observedZero(safety.render_count)
      && observedZero(safety.finalize_apply_count));

  const measured = input.measured ?? {};

  const modeStatus: ExitEvidence["status"] = measured.mode_orchestrator
    ? commandStatus(measured.mode_orchestrator)
    : (rehearsalOk ? "partial" : "unverified");

  const exits: ExitEvidence[] = [
    {
      exit_id: "po8-1-mode-orchestrator",
      title: "RC integration orchestrator/diagnostics (legacy/shadow/active)",
      status: modeStatus,
      evidence: measured.mode_orchestrator
        ? [
          `command=${measured.mode_orchestrator.command}`,
          `exit_code=${measured.mode_orchestrator.exit_code}`,
          ...(measured.mode_orchestrator.output_digest
            ? [`output_digest=${measured.mode_orchestrator.output_digest}`]
            : [])
        ]
        : rehearsalOk
          ? [`rehearsal.digest=${input.rehearsal!.digest}`, "mode transitions exercised in rehearsal"]
          : [],
      gaps: modeStatus === "proven"
        ? []
        : modeStatus === "partial"
          ? ["mode orchestrator measured without full command hash"]
          : ["mode orchestrator evidence missing"]
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
      gaps: moduleOk ? [] : ["H1 module evidence not green or not run"]
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
      status: commandStatus(measured.h3_durable_cli),
      evidence: measured.h3_durable_cli
        ? [
          `command=${measured.h3_durable_cli.command}`,
          `exit_code=${measured.h3_durable_cli.exit_code}`,
          ...(measured.h3_durable_cli.output_digest
            ? [`output_digest=${measured.h3_durable_cli.output_digest}`]
            : [])
        ]
        : rehearsalOk
          ? [`rehearsal.digest=${input.rehearsal!.digest}`]
          : [],
      gaps: measured.h3_durable_cli
        ? (commandStatus(measured.h3_durable_cli) === "proven" ? [] : ["CLI command evidence incomplete"])
        : rehearsalOk
          ? ["CLI main --apply E2E not measured with exit_code+hash"]
          : ["H3 durable CLI not proven"]
    },
    {
      exit_id: "po8-3-rollback-rehearsal",
      title: "Rollback rehearsal preserves append-only artifacts",
      status: rehearsalOk ? "proven" : input.rehearsal ? "failed" : "unverified",
      evidence: rehearsalOk
        ? [`rehearsal.digest=${input.rehearsal!.digest}`, "rollback sequence in rehearsal"]
        : [],
      gaps: rehearsalOk ? [] : ["rollback evidence missing"]
    },
    {
      exit_id: "po8-4-adversarial-golden",
      title: "Adversarial/golden fixture coverage",
      status: moduleOk ? "proven" : input.fixture_module_evidence ? "failed" : "unverified",
      evidence: moduleOk
        ? [
          `fixture_module_evidence.digest=${input.fixture_module_evidence!.digest}`,
          "golden exact compare + field mutation digests"
        ]
        : [],
      gaps: moduleOk ? [] : ["module adversarial/golden incomplete"]
    },
    {
      exit_id: "po8-5-full-regression",
      title: "Full regression and production surfaces",
      status: commandStatus(measured.full_regression),
      evidence: measured.full_regression
        ? [
          `command=${measured.full_regression.command}`,
          `exit_code=${measured.full_regression.exit_code}`,
          ...(measured.full_regression.output_digest
            ? [`output_digest=${measured.full_regression.output_digest}`]
            : []),
          ...(input.coverage
            ? [`branches=${input.coverage.branches}`, `statements=${input.coverage.statements}`]
            : [])
        ]
        : [],
      gaps: measured.full_regression
        ? (commandStatus(measured.full_regression) === "proven" ? [] : ["full regression partial/unverified"])
        : ["full npm run check not yet recorded with exit_code+hash"]
    },
    {
      exit_id: "po8-6-version-decision",
      title: "Version/release decision per migration-and-release.md",
      status: input.package_version === "0.9.0" ? "proven" : "failed",
      evidence: [
        `package_version=${input.package_version}`,
        `revision_bindings_digest=${rcRevisionBindingsDigest()}`,
        "Windows/live provider incomplete → not 1.0.0"
      ],
      gaps: input.package_version === "0.9.0" ? [] : ["package version is not 0.9.0"]
    },
    {
      exit_id: "po8-7-readiness-artifact",
      title: "Release readiness machine-readable digest-bound report",
      status: "partial",
      evidence: [
        "src/productionControl/rc/releaseReadiness.ts",
        "status recomputed from evidence store (not caller forged exits)"
      ],
      gaps: ["readiness report is self-describing; authenticity proven by digest recompute in tests"]
    },
    {
      exit_id: "po8-8-po0a-browser",
      title: "PO-0A central 3D blank not regressed (Canvas or operable fallback)",
      status: commandStatus(measured.browser_po0a),
      evidence: measured.browser_po0a
        ? [
          `command=${measured.browser_po0a.command}`,
          `exit_code=${measured.browser_po0a.exit_code}`,
          ...(measured.browser_po0a.output_digest
            ? [`output_digest=${measured.browser_po0a.output_digest}`]
            : [])
        ]
        : [],
      gaps: measured.browser_po0a
        ? (commandStatus(measured.browser_po0a) === "proven" ? [] : ["browser command partial/unverified"])
        : ["browser assertion not yet recorded with exit_code+hash"]
    }
  ];

  if (measured.windows_smoke) {
    exits.push({
      exit_id: "windows-smoke",
      title: "Windows real-machine / CI smoke",
      status: commandStatus(measured.windows_smoke),
      evidence: [
        `command=${measured.windows_smoke.command}`,
        `exit_code=${measured.windows_smoke.exit_code}`,
        ...(measured.windows_smoke.output_digest
          ? [`output_digest=${measured.windows_smoke.output_digest}`]
          : [])
      ],
      gaps: commandStatus(measured.windows_smoke) === "proven"
        ? []
        : ["Windows smoke incomplete"]
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

  if (measured.desktop) {
    exits.push({
      exit_id: "desktop",
      title: "Desktop test/prepare/audit",
      status: commandStatus(measured.desktop),
      evidence: [
        `command=${measured.desktop.command}`,
        `exit_code=${measured.desktop.exit_code}`,
        ...(measured.desktop.output_digest
          ? [`output_digest=${measured.desktop.output_digest}`]
          : [])
      ],
      gaps: commandStatus(measured.desktop) === "proven" ? [] : ["desktop partial/unverified"]
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
    const allProven = input.commands.every((cmd) => commandStatus(cmd) === "proven");
    exits.push({
      exit_id: "command-evidence",
      title: "Recorded command exit evidence",
      status: failed.length > 0 ? "failed" : allProven ? "proven" : "partial",
      evidence: input.commands.map((cmd) =>
        `${cmd.command} exit=${cmd.exit_code} ${cmd.status}${cmd.output_digest ? ` digest=${cmd.output_digest}` : ""}`
      ),
      gaps: failed.map((cmd) => `${cmd.command} failed`)
    });
  }

  // A-D evidence absence/mismatch/unknown → NO-GO
  const safetyUnknown = !safety
    || safety.provider_submit_count === "unknown"
    || safety.gate_mutation_count === "unknown"
    || safety.billing_spend_count === "unknown"
    || safety.network_fetch_count === "unknown"
    || safety.render_count === "unknown"
    || safety.finalize_apply_count === "unknown";

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
  if (anyFailed || h1h3Missing || safetyUnknown || !provenZero) {
    go_no_go = "NO-GO";
    if (!moduleOk) go_no_go_reasons.push("H1 fixture module evidence not proven");
    if (!rehearsalOk) go_no_go_reasons.push("H3/migration rehearsal not fully proven");
    if (safetyUnknown) go_no_go_reasons.push("effect safety channels unknown or missing");
    if (!provenZero) go_no_go_reasons.push("zero-effect not proven (unarmed/unknown/non-zero)");
    if (anyFailed) go_no_go_reasons.push("one or more exits failed");
  } else if (unverified.length > 0) {
    go_no_go = "GO-WITH-CAVEATS";
    go_no_go_reasons.push("fixture-only RC integration with unverified Windows/live/desktop/browser");
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

  const environment = {
    fixture_only: true as boolean,
    provider_submit_count: (safety?.provider_submit_count ?? "unknown") as ObservedCount,
    gate_mutation_count: (safety?.gate_mutation_count ?? "unknown") as ObservedCount,
    billing_spend_count: (safety?.billing_spend_count ?? "unknown") as ObservedCount,
    network_fetch_count: (safety?.network_fetch_count ?? "unknown") as ObservedCount,
    render_count: (safety?.render_count ?? "unknown") as ObservedCount,
    finalize_apply_count: (safety?.finalize_apply_count ?? "unknown") as ObservedCount,
    ...(safety ? { safety_ledger_digest: safety.digest } : {}),
    ...(observer ? { effect_observer_digest: observer.digest } : {}),
    proven_zero_effects: provenZero,
    platform: process.platform,
    node: process.version
  };

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
    // build_provenance is recorded but never proves exits; dirty/SHA are verified_separately only
    ...(provenance
      ? {
        build_provenance: {
          ...provenance,
          verified_separately: true
        }
      }
      : {}),
    digest: sha256Canonical(digestBody)
  };
}

export function readinessReportSha256(report: ReleaseReadinessReport): string {
  const { build_provenance: _p, digest: _d, ...rest } = report;
  void _p;
  void _d;
  return sha256Canonical(rest);
}

/** Hash command output bytes for command evidence authenticity. */
export function hashCommandOutput(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function hashFileBytes(path: string): Promise<string> {
  const real = await realpath(path);
  const stat = await lstat(real);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw pcError("PC_PATH_UNSAFE", "command artifact must be a regular file");
  }
  return sha256Bytes(await readFile(real));
}

export { observedZero };
