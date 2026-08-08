/**
 * Media evidence path safety, integrity verification, analyzer license, gate advisory rules.
 * Fail closed on path escape, symlink, hash mismatch, tool metadata drift, oversized source.
 */
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join, relative, resolve, sep, isAbsolute } from "node:path";
import { isWithin } from "../../platform/fsSafe.js";
import type { Issue, Result } from "../../types.js";
import {
  computeFramesManifestDigest,
  computeMediaEvidenceBundleDigest
} from "./contactSheet.js";
import { sha256FileStreaming } from "./extractFrames.js";
import { contactSheetCellLabel } from "./framePlan.js";
import {
  ACCEPTED_ANALYZER_LICENSES,
  MEDIA_EVIDENCE_LIMITS,
  type AnalyzerWeightsLicense,
  type ContactSheetLayoutV1,
  type FramesManifestV1
} from "./schema.js";

export type MediaEvidenceBundleResult = {
  evidence_digest: string;
  frames_manifest_digest: string;
  contact_sheet_sha256?: string;
  source_video_sha256: string;
};

/**
 * Resolve a relative evidence path under root.
 * Rejects absolute paths, `..`, backslashes, and symlink escapes.
 */
export async function resolveSafeEvidencePath(
  rootDir: string,
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
          code: "media_evidence.path_escape",
          message: "evidence path escaped the allowed root",
          path: relativePath
        }
      ]
    };
  }

  const absolutePath = resolve(rootDir, relativePath);
  if (!isWithin(absolutePath, rootDir)) {
    return {
      ok: false,
      issues: [
        {
          code: "media_evidence.path_escape",
          message: "evidence path escaped the allowed root",
          path: relativePath
        }
      ]
    };
  }

  try {
    if (await hasSymlinkAlongPath(rootDir, absolutePath)) {
      return {
        ok: false,
        issues: [
          {
            code: "media_evidence.symlink_forbidden",
            message: "evidence path must not traverse symbolic links",
            path: relativePath
          }
        ]
      };
    }
    try {
      const [realRoot, realFile] = await Promise.all([realpath(rootDir), realpath(absolutePath)]);
      if (!isWithin(realFile, realRoot)) {
        return {
          ok: false,
          issues: [
            {
              code: "media_evidence.path_escape",
              message: "evidence realpath escaped the allowed root",
              path: relativePath
            }
          ]
        };
      }
    } catch {
      // Missing file: still return resolved path for callers that create files.
    }
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: "media_evidence.path_unsafe",
          message: error instanceof Error ? error.message : String(error),
          path: relativePath
        }
      ]
    };
  }

  const normalizedRelative = relative(rootDir, absolutePath).split(sep).join("/");
  return {
    ok: true,
    issues: [],
    absolutePath,
    relativePath: normalizedRelative
  };
}

/**
 * Production integrity check for a frame file: size cap before streaming hash.
 */
async function hashEvidenceFileWithSizeCap(
  absolutePath: string,
  relativePath: string,
  maxBytes: number
): Promise<Result<{ sha256: string; size: number }>> {
  try {
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      return {
        ok: false,
        issues: [
          {
            code: "media_evidence.symlink_forbidden",
            message: "evidence file must not be a symbolic link",
            path: relativePath
          }
        ]
      };
    }
    if (!stats.isFile()) {
      return {
        ok: false,
        issues: [
          {
            code: "media_evidence.file_missing",
            message: "evidence path is not a regular file",
            path: relativePath
          }
        ]
      };
    }
    if (stats.size > maxBytes) {
      return {
        ok: false,
        issues: [
          {
            code: "media_evidence.size_limit",
            message: `file exceeds size limit (${maxBytes} bytes) before hash`,
            path: relativePath
          }
        ]
      };
    }
    const sha256 = await sha256FileStreaming(absolutePath);
    return { ok: true, issues: [], sha256, size: stats.size };
  } catch {
    return {
      ok: false,
      issues: [
        {
          code: "media_evidence.file_missing",
          message: "evidence file is missing or unreadable",
          path: relativePath
        }
      ]
    };
  }
}

export async function verifyFramesManifestIntegrity(options: {
  runDir: string;
  framesManifest: FramesManifestV1;
}): Promise<Result<{ frames_manifest_digest: string }>> {
  // Frame PNGs are small relative to video; cap each frame at max video bytes as a hard ceiling.
  for (const frame of options.framesManifest.frames) {
    const resolved = await resolveSafeEvidencePath(options.runDir, frame.relative_path);
    if (!resolved.ok) return resolved;

    const hashed = await hashEvidenceFileWithSizeCap(
      resolved.absolutePath,
      frame.relative_path,
      MEDIA_EVIDENCE_LIMITS.max_video_bytes
    );
    if (!hashed.ok) {
      if (hashed.issues[0]?.code === "media_evidence.file_missing") {
        return {
          ok: false,
          issues: [
            {
              code: "media_evidence.frame_missing",
              message: "frame file is missing",
              path: frame.relative_path
            }
          ]
        };
      }
      return hashed;
    }

    if (hashed.sha256 !== frame.sha256) {
      return {
        ok: false,
        issues: [
          {
            code: "media_evidence.frame_tampered",
            message: "frame hash does not match frames manifest entry",
            path: frame.relative_path
          }
        ]
      };
    }
  }

  return {
    ok: true,
    issues: [],
    frames_manifest_digest: computeFramesManifestDigest(options.framesManifest)
  };
}

export async function verifyContactSheetIntegrity(options: {
  runDir: string;
  layout: ContactSheetLayoutV1;
  framesManifest: FramesManifestV1;
  expectedGenerator?: ContactSheetLayoutV1["generator"];
}): Promise<Result<{ contact_sheet_sha256: string }>> {
  const frames = options.framesManifest.frames;
  const expectedDigests = frames.map((frame) => frame.sha256);

  // Full cell ↔ manifest order integrity (length, index, order, digest, label).
  if (options.layout.cells.length !== frames.length) {
    return {
      ok: false,
      issues: [
        {
          code: "media_evidence.contact_sheet_cells_mismatch",
          message: "contact sheet cells length does not match frames manifest"
        }
      ]
    };
  }

  if (
    options.layout.frame_digests_in_order.length !== expectedDigests.length
    || options.layout.frame_digests_in_order.some(
      (digest, index) => digest !== expectedDigests[index]
    )
  ) {
    return {
      ok: false,
      issues: [
        {
          code: "media_evidence.contact_sheet_frame_mismatch",
          message: "contact sheet frame digests do not match frames manifest order"
        }
      ]
    };
  }

  for (let i = 0; i < frames.length; i += 1) {
    const cell = options.layout.cells[i]!;
    const frame = frames[i]!;
    const expectedLabel = contactSheetCellLabel(frame);
    if (cell.frame_index !== i) {
      return {
        ok: false,
        issues: [
          {
            code: "media_evidence.contact_sheet_cells_mismatch",
            message: `contact sheet cell[${i}].frame_index does not match manifest order`,
            path: `cells[${i}].frame_index`
          }
        ]
      };
    }
    if (cell.order !== i) {
      return {
        ok: false,
        issues: [
          {
            code: "media_evidence.contact_sheet_cells_mismatch",
            message: `contact sheet cell[${i}].order does not match manifest order`,
            path: `cells[${i}].order`
          }
        ]
      };
    }
    if (cell.label !== expectedLabel) {
      return {
        ok: false,
        issues: [
          {
            code: "media_evidence.contact_sheet_cells_mismatch",
            message: `contact sheet cell[${i}].label does not match frames manifest entry`,
            path: `cells[${i}].label`
          }
        ]
      };
    }
    if (options.layout.frame_digests_in_order[i] !== frame.sha256) {
      return {
        ok: false,
        issues: [
          {
            code: "media_evidence.contact_sheet_frame_mismatch",
            message: `contact sheet frame_digests_in_order[${i}] does not match frames manifest`,
            path: `frame_digests_in_order[${i}]`
          }
        ]
      };
    }
  }

  if (options.expectedGenerator) {
    const gen = options.layout.generator;
    const expected = options.expectedGenerator;
    if (
      gen.tool !== expected.tool
      || gen.version !== expected.version
      || gen.argv.length !== expected.argv.length
      || gen.argv.some((part, index) => part !== expected.argv[index])
    ) {
      return {
        ok: false,
        issues: [
          {
            code: "media_evidence.tool_version_mismatch",
            message: "contact sheet generator tool/version/argv does not match expected metadata"
          }
        ]
      };
    }
  }

  const resolved = await resolveSafeEvidencePath(
    options.runDir,
    options.layout.output.relative_path
  );
  if (!resolved.ok) return resolved;

  const hashed = await hashEvidenceFileWithSizeCap(
    resolved.absolutePath,
    options.layout.output.relative_path,
    MEDIA_EVIDENCE_LIMITS.max_video_bytes
  );
  if (!hashed.ok) {
    if (hashed.issues[0]?.code === "media_evidence.file_missing") {
      return {
        ok: false,
        issues: [
          {
            code: "media_evidence.contact_sheet_missing",
            message: "contact sheet artifact is missing",
            path: options.layout.output.relative_path
          }
        ]
      };
    }
    return hashed;
  }

  if (hashed.sha256 !== options.layout.output.sha256) {
    return {
      ok: false,
      issues: [
        {
          code: "media_evidence.contact_sheet_tampered",
          message: "contact sheet hash does not match layout output digest",
          path: options.layout.output.relative_path
        }
      ]
    };
  }

  return {
    ok: true,
    issues: [],
    contact_sheet_sha256: hashed.sha256
  };
}

type VerifyMediaEvidenceBundleBase = {
  runDir: string;
  framesManifest: FramesManifestV1;
  contactSheetLayout?: ContactSheetLayoutV1;
  sourceVideoRelativePath: string;
};

/**
 * Production verification (default).
 * Always resolves `sourceVideoRelativePath` under runDir and streaming-rehashes the real file.
 * Declared `source_video_sha256` alone is never enough — missing/unreadable/symlink/hash mismatch fail closed.
 * Size is re-checked via lstat before hashing so oversized files are never fully hashed.
 */
export async function verifyMediaEvidenceBundle(
  options: VerifyMediaEvidenceBundleBase
): Promise<Result<MediaEvidenceBundleResult>> {
  return verifyMediaEvidenceBundleInternal({
    ...options,
    mode: "production"
  });
}

/**
 * Test-only API: allows an in-memory source fixture when the source file is intentionally absent.
 * Must not be mixed into production call sites or production schema options.
 * Live file, when present, is still path-resolved and streaming-rehashed and must match.
 */
export async function verifyMediaEvidenceBundleForTests(
  options: VerifyMediaEvidenceBundleBase & {
    sourceVideoBytes: Buffer | string;
  }
): Promise<Result<MediaEvidenceBundleResult>> {
  return verifyMediaEvidenceBundleInternal({
    runDir: options.runDir,
    framesManifest: options.framesManifest,
    contactSheetLayout: options.contactSheetLayout,
    sourceVideoRelativePath: options.sourceVideoRelativePath,
    mode: "test-fixture",
    sourceVideoBytes: options.sourceVideoBytes
  });
}

async function verifyMediaEvidenceBundleInternal(options: {
  runDir: string;
  framesManifest: FramesManifestV1;
  contactSheetLayout?: ContactSheetLayoutV1;
  sourceVideoRelativePath: string;
  mode: "production" | "test-fixture";
  sourceVideoBytes?: Buffer | string;
}): Promise<Result<MediaEvidenceBundleResult>> {
  const sourceResolved = await resolveSafeEvidencePath(
    options.runDir,
    options.sourceVideoRelativePath
  );
  if (!sourceResolved.ok) return sourceResolved;

  let sourceHash: string | undefined;
  let sourceReadable = false;

  try {
    const stats = await lstat(sourceResolved.absolutePath);
    if (stats.isSymbolicLink()) {
      return {
        ok: false,
        issues: [
          {
            code: "media_evidence.symlink_forbidden",
            message: "source video must not be a symbolic link",
            path: options.sourceVideoRelativePath
          }
        ]
      };
    }
    if (!stats.isFile()) {
      return {
        ok: false,
        issues: [
          {
            code: "media_evidence.source_missing",
            message: "source video is not a regular file",
            path: options.sourceVideoRelativePath
          }
        ]
      };
    }
    if (stats.size > MEDIA_EVIDENCE_LIMITS.max_video_bytes) {
      return {
        ok: false,
        issues: [
          {
            code: "media_evidence.size_limit",
            message: `source video exceeds max_video_bytes limit (${MEDIA_EVIDENCE_LIMITS.max_video_bytes}) before hash`,
            path: options.sourceVideoRelativePath
          }
        ]
      };
    }
    sourceHash = await sha256FileStreaming(sourceResolved.absolutePath);
    sourceReadable = true;
  } catch {
    sourceReadable = false;
  }

  if (!sourceReadable) {
    if (options.mode === "production") {
      return {
        ok: false,
        issues: [
          {
            code: "media_evidence.source_missing",
            message: "source video is missing or unreadable; streaming rehash is required",
            path: options.sourceVideoRelativePath
          }
        ]
      };
    }
    // test-fixture only: hash the provided bytes (still not a production bypass flag).
    if (options.sourceVideoBytes === undefined) {
      return {
        ok: false,
        issues: [
          {
            code: "media_evidence.source_missing",
            message: "source video fixture bytes are required when file is absent",
            path: options.sourceVideoRelativePath
          }
        ]
      };
    }
    sourceHash = createHash("sha256").update(options.sourceVideoBytes).digest("hex");
  }

  if (sourceHash !== options.framesManifest.source_video_sha256) {
    return {
      ok: false,
      issues: [
        {
          code: sourceReadable
            ? "media_evidence.source_tampered"
            : "media_evidence.source_hash_mismatch",
          message: sourceReadable
            ? "source video on disk does not match frames manifest digest"
            : "source video hash does not match frames manifest",
          path: options.sourceVideoRelativePath
        }
      ]
    };
  }

  const frames = await verifyFramesManifestIntegrity({
    runDir: options.runDir,
    framesManifest: options.framesManifest
  });
  if (!frames.ok) return frames;

  let contact_sheet_sha256: string | undefined;
  if (options.contactSheetLayout) {
    const sheet = await verifyContactSheetIntegrity({
      runDir: options.runDir,
      layout: options.contactSheetLayout,
      framesManifest: options.framesManifest
    });
    if (!sheet.ok) return sheet;
    contact_sheet_sha256 = sheet.contact_sheet_sha256;
  }

  const evidence_digest = computeMediaEvidenceBundleDigest({
    frames_manifest_digest: frames.frames_manifest_digest,
    source_video_sha256: options.framesManifest.source_video_sha256,
    extractor: options.framesManifest.extractor,
    contact_sheet_sha256: contact_sheet_sha256 ?? null
  });

  return {
    ok: true,
    issues: [],
    evidence_digest,
    frames_manifest_digest: frames.frames_manifest_digest,
    source_video_sha256: sourceHash!,
    ...(contact_sheet_sha256 ? { contact_sheet_sha256 } : {})
  };
}

/**
 * Unknown / missing commercial license for weight-backed analyzers is rejected.
 * Fixture/manual without weights may omit license.
 */
export function validateAnalyzerWeightsLicense(
  input: AnalyzerWeightsLicense
): Result<{ analyzer_id: string }> {
  const issues: Issue[] = [];

  if (input.weights_sha256) {
    if (!input.license || input.license === "unknown") {
      issues.push({
        code: "media_evidence.license_unknown",
        message: "analyzer weights with unknown or missing license are rejected"
      });
    } else if (!ACCEPTED_ANALYZER_LICENSES.has(input.license.toLowerCase())) {
      issues.push({
        code: "media_evidence.license_rejected",
        message: `analyzer weights license '${input.license}' is not accepted`
      });
    }

    if (!input.commercial_use || input.commercial_use === "unknown") {
      issues.push({
        code: "media_evidence.commercial_use_unknown",
        message: "analyzer weights require an explicit commercial-use status (unknown rejected)"
      });
    }
  } else if (input.license === "unknown") {
    issues.push({
      code: "media_evidence.license_unknown",
      message: "analyzer license 'unknown' is rejected"
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, issues: [], analyzer_id: input.analyzer_id };
}

export type LocalAnalyzerStatusResult = {
  status: "ok" | "not-run" | "needs-human-review" | "failed";
  needs_human_review: boolean;
  /** Always false — external fallback is forbidden from local failure. */
  external_fallback: false;
  message: string;
};

/**
 * Local / fixture / manual pluggable analyzer status.
 * Missing local analyzer => explicit not-run / needs-human-review.
 * Local failure never enables external fallback.
 */
export function evaluateLocalAnalyzerStatus(options: {
  localAnalyzerAvailable: boolean;
  localFailed: boolean;
}): LocalAnalyzerStatusResult {
  if (!options.localAnalyzerAvailable) {
    return {
      status: "not-run",
      needs_human_review: true,
      external_fallback: false,
      message: "local analyzer not available; needs-human-review (no external fallback)"
    };
  }
  if (options.localFailed) {
    return {
      status: "needs-human-review",
      needs_human_review: true,
      external_fallback: false,
      message: "local analyzer failed; needs-human-review (no external fallback)"
    };
  }
  return {
    status: "ok",
    needs_human_review: false,
    external_fallback: false,
    message: "local analyzer available"
  };
}

/**
 * Automatic scores are advisory. Gate pass requires human decision + matching evidence digest.
 * Viewer failures must not call this to mutate gate state (read-only evaluation).
 */
export function canPassGateWithEvidence(options: {
  automatic_score?: number;
  evidence_digest: string;
  bound_evidence_digest: string;
  human_decision?: {
    decision: "accept" | "revise" | "accept-not-evaluable";
    reason: string;
  };
  report_status?: "ok" | "review" | "not_evaluable" | "blocked";
}): { passed: boolean; reason: string } {
  if (options.evidence_digest !== options.bound_evidence_digest) {
    return {
      passed: false,
      reason: "evidence digest mismatch (stale or tampered); prior decision invalid"
    };
  }

  if (!options.human_decision) {
    return {
      passed: false,
      reason:
        options.automatic_score !== undefined
          ? `automatic score ${options.automatic_score} is advisory only; human decision required`
          : "human decision required for gate pass"
    };
  }

  if (!options.human_decision.reason.trim()) {
    return { passed: false, reason: "human decision reason is required" };
  }

  if (options.human_decision.decision === "revise") {
    return { passed: false, reason: "human decision is revise" };
  }

  if (options.human_decision.decision === "accept") {
    if (options.report_status && options.report_status !== "ok") {
      return {
        passed: false,
        reason: `accept requires report status ok (got ${options.report_status})`
      };
    }
    return { passed: true, reason: "human accept with matching evidence digest" };
  }

  // accept-not-evaluable
  if (
    options.report_status
    && options.report_status !== "not_evaluable"
    && options.report_status !== "review"
  ) {
    return {
      passed: false,
      reason: "accept-not-evaluable requires not_evaluable or review status"
    };
  }

  return { passed: true, reason: "human accept-not-evaluable with matching evidence digest" };
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
      return false;
    }
  }
  return false;
}
