/**
 * Gate 3 sidecar identity and safety checks.
 *
 * Sidecar kinds are opaque backend-neutral strings. The approved manifest is the
 * authority for which sidecars must exist; a backend report cannot add or omit one.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { sha256Canonical } from "../integrity/canonical.js";
import { readJsonFile } from "../io.js";
import type { Manifest } from "../manifest/schema.js";
import { validateManifest } from "../manifest/validate.js";
import type { Issue, Result } from "../types.js";
import { probeGate3Output, validateGate3QcReport, type Gate3QcProbe } from "./gate3Qc.js";

export type Gate3SidecarReference = {
  kind: string;
  path: string;
  sha256?: string;
  expected?: {
    duration_seconds: number;
    width: number;
    height: number;
    fps: number;
    video_codec: string;
    alpha_required: boolean;
    audio_required: boolean;
  };
};

export type Gate3SidecarEvidence = {
  kind: string;
  path: string;
  sha256: string;
  expected: NonNullable<Gate3SidecarReference["expected"]>;
  actual: Gate3QcProbe;
};

export type Gate3SidecarInspection = {
  sidecars: Gate3SidecarEvidence[];
  sidecarApprovalDigest?: string;
};

export async function inspectGate3Sidecars(input: {
  manifest: Manifest;
  reportedSidecars: unknown;
  runDir: string;
  probe?: (path: string) => Gate3QcProbe;
  requireReportedSha256?: boolean;
  probeFiles?: boolean;
}): Promise<Result<Gate3SidecarInspection>> {
  const expected = readReferences(
    (input.manifest as Manifest & { native_edit?: { outputs?: unknown } }).native_edit?.outputs,
    "manifest",
    true
  );
  if (!expected.ok) return expected;
  const reported = readReferences(input.reportedSidecars, "render report", false);
  if (!reported.ok) return reported;

  const expectedIdentity = referenceIdentity(expected.references);
  const reportedIdentity = referenceIdentity(reported.references);
  if (expectedIdentity !== reportedIdentity) {
    return failed("render.sidecar_set_mismatch", "renderer sidecars do not match the Gate 1-approved manifest outputs");
  }

  if (expected.references.length === 0) {
    return { ok: true, issues: [], sidecars: [] };
  }

  let realRunDir: string;
  try {
    realRunDir = await realpath(input.runDir);
  } catch (error) {
    return failed("render.sidecar_run_dir_invalid", errorMessage(error), input.runDir);
  }

  const probe = input.probe ?? probeGate3Output;
  const evidence: Gate3SidecarEvidence[] = [];
  for (const ref of expected.references) {
    const outputPath = join(input.runDir, ref.path);
    let before;
    let realOutputPath: string;
    try {
      before = await lstat(outputPath);
      if (before.isSymbolicLink() || !before.isFile()) {
        return failed("render.sidecar_file_unsafe", "declared sidecar must be a regular non-symlink file", outputPath);
      }
      realOutputPath = await realpath(outputPath);
    } catch (error) {
      return failed("render.sidecar_file_missing", errorMessage(error), outputPath);
    }
    const relativeOutput = relative(realRunDir, realOutputPath);
    if (relativeOutput === ".." || relativeOutput.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || resolve(realRunDir, relativeOutput) !== realOutputPath) {
      return failed("render.sidecar_path_unsafe", "declared sidecar resolved outside the run directory", outputPath);
    }

    let sha256: string;
    try {
      sha256 = await sha256RegularFile(outputPath);
    } catch (error) {
      return failed("render.sidecar_hash_failed", errorMessage(error), outputPath);
    }
    try {
      const after = await lstat(outputPath);
      if (!sameFileIdentity(before, after)) {
        return failed("render.sidecar_changed", "declared sidecar changed while it was being fingerprinted", outputPath);
      }
    } catch (error) {
      return failed("render.sidecar_changed", errorMessage(error), outputPath);
    }

    const reportRef = reported.references.find((candidate) => candidate.kind === ref.kind && candidate.path === ref.path)!;
    if (input.requireReportedSha256 && !reportRef.sha256) {
      return failed("render.sidecar_report_digest_missing", "normalized render report is missing a declared sidecar digest", outputPath);
    }
    if (reportRef.sha256 && reportRef.sha256 !== sha256) {
      return failed("render.sidecar_report_digest_mismatch", "render report sidecar digest no longer matches the file", outputPath);
    }

    const actual = input.probeFiles === false
      ? { ok: true as const }
      : safeProbe(probe, outputPath);
    if (input.probeFiles !== false) {
      const probeIssue = inspectSidecarProbe(actual, ref.expected!, outputPath);
      if (probeIssue) return { ok: false, issues: [probeIssue] };
    }
    evidence.push({ kind: ref.kind, path: ref.path, sha256, expected: ref.expected!, actual });
  }

  evidence.sort(compareReference);
  return {
    ok: true,
    issues: [],
    sidecars: evidence,
    sidecarApprovalDigest: sha256Canonical({
      sidecars: evidence.map(({ kind, path, sha256: digest, expected }) => ({
        kind,
        path,
        sha256: digest,
        expected
      }))
    })
  };
}

/** Recompute all Gate 3 sidecar proof from the run directory for finalize checks. */
export async function verifyGate3SidecarApproval(input: {
  runDir: string;
  expectedSidecarApprovalDigest?: string;
  probe?: (path: string) => Gate3QcProbe;
}): Promise<Result<Gate3SidecarInspection>> {
  const manifestPath = join(input.runDir, "manifest.json");
  const reportPath = join(input.runDir, "render-report.json");
  const qcPath = join(input.runDir, "gate3-qc.json");
  try {
    let manifestValue: unknown;
    try {
      manifestValue = await readJsonFile(manifestPath);
    } catch (error) {
      const [reportValue, qcValue] = await Promise.all([
        readJsonFile(reportPath).catch(() => undefined),
        readJsonFile(qcPath).catch(() => undefined)
      ]);
      const report = asRecord(reportValue);
      const qc = asRecord(qcValue);
      const hasSidecarEvidence = hasSidecarEntries(report?.sidecars)
        || hasSidecarEntries(qc?.sidecars)
        || typeof qc?.sidecar_approval_digest === "string";
      // Keep legacy finalize fixtures/runs without a run manifest compatible only when
      // no Gate 3 sidecar evidence/binding exists. A bound run must retain the authority.
      if (input.expectedSidecarApprovalDigest === undefined && !hasSidecarEvidence) {
        return { ok: true, issues: [], sidecars: [] };
      }
      return failed("finalize.sidecar_manifest_missing", errorMessage(error), manifestPath);
    }
    const parsedManifest = validateManifest(manifestValue);
    if (!parsedManifest.ok || !parsedManifest.manifest) {
      return { ok: false, issues: parsedManifest.issues };
    }
    const renderReport = await readJsonFile(reportPath) as Record<string, unknown>;
    const qcValue = await readJsonFile(qcPath).catch(() => undefined);
    const qcRecord = asRecord(qcValue);
    const manifestOutputs = (parsedManifest.manifest as Manifest & { native_edit?: { outputs?: unknown } })
      .native_edit?.outputs;
    const hasDeclaredSidecars = Array.isArray(manifestOutputs) && manifestOutputs.length > 0;
    const hasReportedSidecars = hasSidecarEntries(renderReport.sidecars);
    const hasQcSidecarEvidence = hasSidecarEntries(qcRecord?.sidecars)
      || typeof qcRecord?.sidecar_approval_digest === "string";
    if (
      !hasDeclaredSidecars
      && !hasReportedSidecars
      && !hasQcSidecarEvidence
      && input.expectedSidecarApprovalDigest === undefined
    ) {
      // Old non-sidecar Gate 3 reports need not contain the new QC shape.
      return { ok: true, issues: [], sidecars: [] };
    }
    const inspected = await inspectGate3Sidecars({
      manifest: parsedManifest.manifest,
      reportedSidecars: renderReport.sidecars,
      runDir: input.runDir,
      ...(input.probe ? { probe: input.probe } : {}),
      requireReportedSha256: true,
      probeFiles: true
    });
    if (!inspected.ok) return inspected;
    const gate3Qc = validateGate3QcReport(await readJsonFile(qcPath), join(input.runDir, "final.mp4"));
    if (!gate3Qc.ok) return gate3Qc;
    if (
      gate3Qc.report.ok !== true
      || JSON.stringify(gate3Qc.report.sidecars ?? []) !== JSON.stringify(inspected.sidecars)
      || gate3Qc.report.sidecar_approval_digest !== inspected.sidecarApprovalDigest
    ) {
      return failed("finalize.sidecar_qc_changed", "Gate 3 sidecar evidence no longer matches the declared files and fresh probes", qcPath);
    }
    if (inspected.sidecarApprovalDigest !== input.expectedSidecarApprovalDigest) {
      return failed("finalize.sidecar_approval_changed", "declared sidecars no longer match the Gate 3 approved sidecar binding", reportPath);
    }
    return inspected;
  } catch (error) {
    return failed("finalize.sidecar_evidence_invalid", errorMessage(error), reportPath);
  }
}

export function sidecarApprovalSubjectDigest(
  finalOutputSha256: string,
  sidecarApprovalDigest: string | undefined
): string {
  return sidecarApprovalDigest
    ? sha256Canonical({ final_output_sha256: finalOutputSha256, sidecar_approval_digest: sidecarApprovalDigest })
    : finalOutputSha256;
}

export function normalizedSidecarReportEntries(
  sidecars: readonly Gate3SidecarEvidence[]
): Gate3SidecarReference[] {
  return [...sidecars]
    .sort(compareReference)
    .map(({ kind, path, sha256 }) => ({ kind, path, sha256 }));
}

function readReferences(
  input: unknown,
  label: string,
  requireExpectation: boolean
): Result<{ references: Gate3SidecarReference[] }> {
  if (input === undefined) return { ok: true, issues: [], references: [] };
  if (!Array.isArray(input)) {
    return failed("render.sidecar_declaration_invalid", `${label} sidecars must be an array`);
  }
  const references: Gate3SidecarReference[] = [];
  const seen = new Set<string>();
  for (const [index, value] of input.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return failed("render.sidecar_declaration_invalid", `${label} sidecar ${index + 1} must be an object`);
    }
    const item = value as Record<string, unknown>;
    if (typeof item.kind !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.kind)) {
      return failed("render.sidecar_declaration_invalid", `${label} sidecar ${index + 1} kind must be a safe identifier`);
    }
    if (!isSafeRunRelativePath(item.path)) {
      return failed("render.sidecar_path_invalid", `${label} sidecar ${index + 1} path must be a safe run-relative file path`);
    }
    if (item.sha256 !== undefined && (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256))) {
      return failed("render.sidecar_declaration_invalid", `${label} sidecar ${index + 1} sha256 must be a lowercase SHA-256 digest`);
    }
    let expected: Gate3SidecarReference["expected"];
    if (requireExpectation) {
      const { duration_seconds, width, height, fps, video_codec, alpha_required, audio_required } = item;
      if (
        typeof duration_seconds !== "number" || !Number.isFinite(duration_seconds) || duration_seconds <= 0 || duration_seconds > 86_400
        || !Number.isSafeInteger(width) || Number(width) <= 0 || Number(width) > 16_384
        || !Number.isSafeInteger(height) || Number(height) <= 0 || Number(height) > 16_384
        || typeof fps !== "number" || !Number.isFinite(fps) || fps < 1 || fps > 240
        || typeof video_codec !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(video_codec)
        || typeof alpha_required !== "boolean"
        || typeof audio_required !== "boolean"
      ) {
        return failed("render.sidecar_expectation_invalid", `manifest sidecar ${index + 1} must declare duration, dimensions, fps, codec, alpha, and audio expectations`, item.path);
      }
      expected = {
        duration_seconds,
        width: Number(width),
        height: Number(height),
        fps,
        video_codec,
        alpha_required,
        audio_required
      };
    }
    const key = `${item.kind}\0${item.path}`;
    if (seen.has(key)) {
      return failed("render.sidecar_declaration_duplicate", `${label} contains a duplicate sidecar declaration`, item.path);
    }
    seen.add(key);
    references.push({
      kind: item.kind,
      path: item.path,
      ...(typeof item.sha256 === "string" ? { sha256: item.sha256 } : {}),
      ...(expected ? { expected } : {})
    });
  }
  references.sort(compareReference);
  return { ok: true, issues: [], references };
}

function isSafeRunRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || isAbsolute(value)
    || value.includes("\\")
    || /[\0-\x1f\x7f]/.test(value)
  ) return false;
  const segments = value.split("/");
  return segments.every((segment) =>
    segment.length > 0
    && segment !== "."
    && segment !== ".."
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment)
  );
}

function referenceIdentity(references: readonly Gate3SidecarReference[]): string {
  return JSON.stringify([...references]
    .sort(compareReference)
    .map(({ kind, path }) => ({ kind, path })));
}

function compareReference(left: { kind: string; path: string }, right: { kind: string; path: string }): number {
  return left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path);
}

function sameFileIdentity(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function safeProbe(probe: (path: string) => Gate3QcProbe, path: string): Gate3QcProbe {
  try {
    return probe(path);
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function inspectSidecarProbe(
  actual: Gate3QcProbe,
  expected: NonNullable<Gate3SidecarReference["expected"]>,
  path: string
): Issue | undefined {
  if (!actual.ok || !actual.has_video) {
    return {
      code: "gate3.sidecar.probe_failed",
      message: actual.error ?? "declared sidecar has no readable video stream",
      path
    };
  }
  const hasAlpha = actual.has_alpha ?? pixelFormatHasAlpha(actual.pixel_format);
  if (
    actual.codec !== expected.video_codec
    || actual.width !== expected.width
    || actual.height !== expected.height
    || actual.fps === undefined
    || Math.abs(actual.fps - expected.fps) > 1e-6
    || actual.duration_seconds === undefined
      || Math.abs(actual.duration_seconds - expected.duration_seconds) > (1 / expected.fps + 0.03)
      || (expected.alpha_required && !hasAlpha)
      || actual.has_audio !== expected.audio_required
  ) {
    return {
      code: "gate3.sidecar.probe_mismatch",
      message: "declared sidecar video does not match its Gate 1-approved codec, duration, dimensions, frame rate, alpha, and audio expectations",
      path
    };
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasSidecarEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function pixelFormatHasAlpha(pixelFormat: string | undefined): boolean {
  if (!pixelFormat) return false;
  return /^(?:yuva|rgba|argb|bgra|abgr|gbrap|ayuv|ya\d)/i.test(pixelFormat);
}

async function sha256RegularFile(path: string): Promise<string> {
  return await new Promise<string>((resolveDigest, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolveDigest(hash.digest("hex")));
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failed<T>(code: string, message: string, path?: string): Result<T> {
  return { ok: false, issues: [{ code, message, ...(path ? { path } : {}) }] };
}
