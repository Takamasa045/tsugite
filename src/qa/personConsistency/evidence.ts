/**
 * Artifact path safety, report load/validate, contact-sheet contract, digest binding.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sha256Canonical } from "../../h3/hash.js";
import { isWithin } from "../../platform/fsSafe.js";
import type { Issue, Result } from "../../types.js";
import {
  parsePersonConsistencyReport,
  type PersonConsistencyReportV1,
  type PersonConsistencyStage
} from "./schema.js";

export function personConsistencyArtifactDir(
  runDir: string,
  stage: PersonConsistencyStage
): string {
  const stageDir = stage === "gate_2" ? "gate2" : "gate3";
  return join(runDir, "qa", "person-consistency", stageDir);
}

export function personConsistencyReportRelativePath(
  stage: PersonConsistencyStage,
  requestId?: string
): string {
  if (stage === "gate_2" && requestId) {
    return `qa/person-consistency/gate2/${requestId}/report.json`;
  }
  if (stage === "gate_2") {
    return "qa/person-consistency/gate2/report.json";
  }
  return "qa/person-consistency/gate3/report.json";
}

export function personConsistencyContactSheetRelativePath(
  stage: PersonConsistencyStage,
  requestId?: string
): string {
  if (stage === "gate_2" && requestId) {
    return `qa/person-consistency/gate2/${requestId}/contact-sheet.webp`;
  }
  if (stage === "gate_2") {
    return "qa/person-consistency/gate2/contact-sheet.webp";
  }
  return "qa/person-consistency/gate3/contact-sheet.webp";
}

/**
 * Resolve a relative artifact path under runDir.
 * Rejects absolute paths, `..`, backslashes, and symlink escapes.
 */
export async function resolveSafeRunArtifactPath(
  runDir: string,
  relativePath: string
): Promise<Result<{ absolutePath: string; relativePath: string }>> {
  if (
    !relativePath
    || isAbsolute(relativePath)
    || relativePath.includes("\\")
    || relativePath.split(/[/\\]/).includes("..")
    || relativePath.startsWith("/")
  ) {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.path_escape",
          message: "person consistency artifact path escaped the run directory",
          path: relativePath
        }
      ]
    };
  }

  const absolutePath = resolve(runDir, relativePath);
  if (!isWithin(absolutePath, runDir)) {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.path_escape",
          message: "person consistency artifact path escaped the run directory",
          path: relativePath
        }
      ]
    };
  }

  try {
    // Reject symlink leaf or any symlink ancestor between runDir and target.
    if (await hasSymlinkAlongPath(runDir, absolutePath)) {
      return {
        ok: false,
        issues: [
          {
            code: "person_qa.symlink_forbidden",
            message: "person consistency artifact path must not traverse symbolic links",
            path: relativePath
          }
        ]
      };
    }
    // If the file exists, also verify realpath containment.
    try {
      const [realRoot, realFile] = await Promise.all([realpath(runDir), realpath(absolutePath)]);
      if (!isWithin(realFile, realRoot)) {
        return {
          ok: false,
          issues: [
            {
              code: "person_qa.path_escape",
              message: "person consistency artifact realpath escaped the run directory",
              path: relativePath
            }
          ]
        };
      }
    } catch {
      // Missing file is handled by callers (missing vs escape).
    }
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.path_unsafe",
          message: error instanceof Error ? error.message : String(error),
          path: relativePath
        }
      ]
    };
  }

  const normalizedRelative = relative(runDir, absolutePath).split(sep).join("/");
  return {
    ok: true,
    issues: [],
    absolutePath,
    relativePath: normalizedRelative
  };
}

export async function loadPersonConsistencyReport(options: {
  runDir: string;
  relativePath: string;
  expectedInputDigest?: string;
  expectedStage?: PersonConsistencyStage;
}): Promise<Result<{ report: PersonConsistencyReportV1; reportSha256: string; absolutePath: string }>> {
  const resolved = await resolveSafeRunArtifactPath(options.runDir, options.relativePath);
  if (!resolved.ok) return resolved;

  let raw: string;
  try {
    raw = await readFile(resolved.absolutePath, "utf8");
  } catch {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.report_missing",
          message: "person consistency report is missing",
          path: options.relativePath
        }
      ]
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.report_invalid",
          message: "person consistency report is not valid JSON",
          path: options.relativePath
        }
      ]
    };
  }

  const parsed = parsePersonConsistencyReport(json);
  if (!parsed.ok) {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.report_invalid",
          message: parsed.message,
          path: options.relativePath
        }
      ]
    };
  }

  const reportSha256 = createHash("sha256").update(raw).digest("hex");
  const report = parsed.report;

  if (options.expectedStage && report.stage !== options.expectedStage) {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.report_stage_mismatch",
          message: `report stage '${report.stage}' does not match expected '${options.expectedStage}'`,
          path: options.relativePath
        }
      ]
    };
  }

  if (options.expectedInputDigest && report.input_digest !== options.expectedInputDigest) {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.input_digest_mismatch",
          message: "person consistency report input_digest does not match compiled requirements",
          path: options.relativePath
        }
      ]
    };
  }

  // Optional self-declared report_digest must match canonical content without the digest field.
  if (report.report_digest) {
    const { report_digest: _omit, ...withoutDigest } = report;
    const expected = sha256Canonical(withoutDigest);
    if (report.report_digest !== expected) {
      return {
        ok: false,
        issues: [
          {
            code: "person_qa.report_tampered",
            message: "person consistency report_digest does not match report body",
            path: options.relativePath
          }
        ]
      };
    }
  }

  return {
    ok: true,
    issues: [],
    report,
    reportSha256,
    absolutePath: resolved.absolutePath
  };
}

/**
 * Contact sheet must exist as a regular non-symlink file under the run dir.
 * This phase does not generate contact sheets; missing files fail closed.
 */
export async function validateContactSheetArtifact(options: {
  runDir: string;
  relativePath: string;
  expectedSha256?: string;
}): Promise<Result<{ absolutePath: string; sha256: string }>> {
  const resolved = await resolveSafeRunArtifactPath(options.runDir, options.relativePath);
  if (!resolved.ok) return resolved;

  try {
    const stats = await lstat(resolved.absolutePath);
    if (stats.isSymbolicLink()) {
      return {
        ok: false,
        issues: [
          {
            code: "person_qa.symlink_forbidden",
            message: "contact sheet must not be a symbolic link",
            path: options.relativePath
          }
        ]
      };
    }
    if (!stats.isFile()) {
      return {
        ok: false,
        issues: [
          {
            code: "person_qa.contact_sheet_missing",
            message: "contact sheet is not a regular file",
            path: options.relativePath
          }
        ]
      };
    }
  } catch {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.contact_sheet_missing",
          message: "contact sheet artifact is missing",
          path: options.relativePath
        }
      ]
    };
  }

  const bytes = await readFile(resolved.absolutePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (options.expectedSha256 && options.expectedSha256 !== sha256) {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.contact_sheet_tampered",
          message: "contact sheet hash does not match the bound digest",
          path: options.relativePath
        }
      ]
    };
  }

  return {
    ok: true,
    issues: [],
    absolutePath: resolved.absolutePath,
    sha256
  };
}

/**
 * Bind report + optional contact sheet into a gate evidence record.
 * Fail closed on missing/stale/tampered/path-escape/symlink.
 */
export async function bindPersonConsistencyEvidence(options: {
  runDir: string;
  stage: PersonConsistencyStage;
  reportRelativePath: string;
  contactSheetRelativePath?: string;
  expectedInputDigest?: string;
  expectedReportSha256?: string;
}): Promise<
  Result<{
    report: PersonConsistencyReportV1;
    report_relative_path: string;
    report_sha256: string;
    contact_sheet_relative_path?: string;
    contact_sheet_sha256?: string;
  }>
> {
  const loaded = await loadPersonConsistencyReport({
    runDir: options.runDir,
    relativePath: options.reportRelativePath,
    expectedInputDigest: options.expectedInputDigest,
    expectedStage: options.stage
  });
  if (!loaded.ok) return loaded;

  if (options.expectedReportSha256 && options.expectedReportSha256 !== loaded.reportSha256) {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.report_stale",
          message: "person consistency report hash does not match the bound digest",
          path: options.reportRelativePath
        }
      ]
    };
  }

  let contact_sheet_relative_path: string | undefined;
  let contact_sheet_sha256: string | undefined;

  if (options.contactSheetRelativePath || loaded.report.artifacts.contact_sheet_relative_path) {
    const sheetPath =
      options.contactSheetRelativePath
      ?? loaded.report.artifacts.contact_sheet_relative_path!;
    const sheet = await validateContactSheetArtifact({
      runDir: options.runDir,
      relativePath: sheetPath
    });
    if (!sheet.ok) return sheet;
    contact_sheet_relative_path = sheetPath;
    contact_sheet_sha256 = sheet.sha256;
  }

  return {
    ok: true,
    issues: [],
    report: loaded.report,
    report_relative_path: options.reportRelativePath,
    report_sha256: loaded.reportSha256,
    ...(contact_sheet_relative_path
      ? { contact_sheet_relative_path, contact_sheet_sha256 }
      : {})
  };
}

export function computeReportBodyDigest(report: PersonConsistencyReportV1): string {
  const { report_digest: _omit, ...withoutDigest } = report;
  return sha256Canonical(withoutDigest);
}

async function hasSymlinkAlongPath(root: string, target: string): Promise<boolean> {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (!isWithin(resolvedTarget, resolvedRoot)) return true;

  let current = resolvedRoot;
  const relativePath = relative(resolvedRoot, resolvedTarget);
  if (!relativePath || relativePath === "") {
    const rootStat = await lstat(resolvedRoot);
    return rootStat.isSymbolicLink();
  }

  for (const part of relativePath.split(sep)) {
    current = join(current, part);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) return true;
    } catch {
      // Missing intermediate is ok for pure path validation of missing files;
      // leaf missing is reported by loaders.
      return false;
    }
  }
  return false;
}

// Keep dirname import used for potential future relative helpers.
void dirname;
