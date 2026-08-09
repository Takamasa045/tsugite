/**
 * Sol P5 — common QA evidence / integrity (model & provider neutral).
 * Fixture / mock / tmp only. No real video generation. No network.
 */
import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Canonical } from "../src/integrity/canonical.js";
import {
  MEDIA_EVIDENCE_LIMITS,
  buildContactSheetLayout,
  buildMediaFramePlan,
  buildFixedFfmpegExtractArgv,
  buildFixedContactSheetArgv,
  canPassGateWithEvidence,
  computeContactSheetLayoutDigest,
  computeFramesManifestDigest,
  computeMediaEvidenceBundleDigest,
  evaluateLocalAnalyzerStatus,
  parseContactSheetLayout,
  parseFramesManifest,
  planMediaFrameExtraction,
  resolveSafeEvidencePath,
  sha256FileStreaming,
  validateAnalyzerWeightsLicense,
  verifyContactSheetIntegrity,
  verifyFramesManifestIntegrity,
  verifyMediaEvidenceBundle,
  verifyMediaEvidenceBundleForTests,
  type ContactSheetLayoutV1,
  type FramesManifestV1
} from "../src/qa/mediaEvidence/index.js";
import {
  inspectPersonConsistencyForGate,
  parsePersonConsistencyReport,
  type PersonConsistencyReportV1
} from "../src/qa/personConsistency/index.js";

const HEX = "a".repeat(64);
const HEX_B = "b".repeat(64);

async function tmpRunDir(label: string): Promise<string> {
  const root = join(tmpdir(), `media-ev-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

function baseFramesManifest(overrides: Partial<FramesManifestV1> = {}): FramesManifestV1 {
  return {
    schema_version: "media-evidence-frames-v1",
    source_video_sha256: HEX,
    ffprobe_metadata_digest: HEX_B,
    extractor: {
      tool: "ffmpeg",
      version: "fixture-1.0.0",
      argv: ["-y", "-ss", "0", "-i", "source.mp4", "-frames:v", "1", "frames/f000.png"]
    },
    timebase: "1/1000",
    duration_ms: 5000,
    frames: [
      {
        relative_path: "frames/f000.png",
        sha256: createHash("sha256").update("frame0").digest("hex"),
        width: 64,
        height: 36,
        timestamp_ms: 0,
        role: "boundary_start",
        shot_id: "shot_1"
      },
      {
        relative_path: "frames/f001.png",
        sha256: createHash("sha256").update("frame1").digest("hex"),
        width: 64,
        height: 36,
        timestamp_ms: 2500,
        role: "uniform",
        shot_id: "shot_1"
      },
      {
        relative_path: "frames/f002.png",
        sha256: createHash("sha256").update("frame2").digest("hex"),
        width: 64,
        height: 36,
        timestamp_ms: 4999,
        role: "boundary_end",
        shot_id: "shot_1"
      }
    ],
    ...overrides
  };
}

async function writeFramesAndSheet(
  runDir: string,
  manifest: FramesManifestV1,
  sheetBytes = "sheet-bytes"
): Promise<ContactSheetLayoutV1> {
  await mkdir(join(runDir, "frames"), { recursive: true });
  for (const [index, frame] of manifest.frames.entries()) {
    await writeFile(join(runDir, frame.relative_path), `frame${index}`);
  }
  const layout = buildContactSheetLayout({
    framesManifest: manifest,
    columns: 3,
    generator: { tool: "mock-sheet", version: "1.0.0", argv: ["layout", "grid"] },
    outputRelativePath: "contact-sheet.webp",
    outputSha256: createHash("sha256").update(sheetBytes).digest("hex")
  });
  await writeFile(join(runDir, "contact-sheet.webp"), sheetBytes);
  return layout;
}

describe("P5 mediaEvidence schema", () => {
  it("rejects invalid / unknown fields and embedding payloads", () => {
    const ok = parseFramesManifest(baseFramesManifest());
    expect(ok.ok).toBe(true);

    const unknown = parseFramesManifest({
      ...baseFramesManifest(),
      mystery: true
    });
    expect(unknown.ok).toBe(false);

    const embedding = parseFramesManifest({
      ...baseFramesManifest(),
      frames: [
        {
          ...baseFramesManifest().frames[0]!,
          embedding: [0.1, 0.2]
        }
      ]
    });
    expect(embedding.ok).toBe(false);
    expect(embedding.message).toMatch(/embedding|biometric|forbidden/i);

    const sheetUnknown = parseContactSheetLayout({
      schema_version: "media-evidence-contact-sheet-v1",
      layout_version: "grid-v1",
      rows: 1,
      columns: 3,
      cells: [],
      frame_digests_in_order: [],
      generator: { tool: "mock", version: "1", argv: ["a"] },
      output: { relative_path: "sheet.webp", sha256: HEX },
      extra: 1
    });
    expect(sheetUnknown.ok).toBe(false);
  });
});

describe("P5 deterministic frame plan", () => {
  it("produces boundary + uniform timestamps with stable ordering and hash", () => {
    const planA = buildMediaFramePlan(
      [{ id: "shot_1", start_ms: 0, end_ms: 5000 }],
      { frames_per_shot: 4, max_total_frames: 48 }
    );
    const planB = buildMediaFramePlan(
      [{ id: "shot_1", start_ms: 0, end_ms: 5000 }],
      { frames_per_shot: 4, max_total_frames: 48 }
    );
    expect(planA).toEqual(planB);
    expect(planA[0]?.role).toBe("boundary_start");
    expect(planA[0]?.timestamp_ms).toBe(0);
    expect(planA.some((f) => f.role === "boundary_end")).toBe(true);
    expect(planA.some((f) => f.role === "uniform")).toBe(true);
    for (let i = 1; i < planA.length; i += 1) {
      expect(planA[i]!.timestamp_ms).toBeGreaterThanOrEqual(planA[i - 1]!.timestamp_ms);
    }
  });

  it("rejects zero duration and guarantees non-decreasing timestamps on reverse/overlap", () => {
    expect(() =>
      buildMediaFramePlan([{ id: "z", start_ms: 10, end_ms: 10 }], { frames_per_shot: 2 })
    ).toThrow(/non-positive duration/i);

    expect(() =>
      buildMediaFramePlan([{ id: "z", start_ms: 20, end_ms: 10 }], { frames_per_shot: 2 })
    ).toThrow(/non-positive duration/i);

    // Reverse shot order: identity preserved, global timestamps non-decreasing
    const reverse = buildMediaFramePlan(
      [
        { id: "later", start_ms: 4000, end_ms: 6000 },
        { id: "earlier", start_ms: 0, end_ms: 2000 }
      ],
      { frames_per_shot: 2, max_total_frames: 48 }
    );
    expect(reverse.every((f) => f.shot_id === "later" || f.shot_id === "earlier")).toBe(true);
    for (let i = 1; i < reverse.length; i += 1) {
      expect(reverse[i]!.timestamp_ms).toBeGreaterThanOrEqual(reverse[i - 1]!.timestamp_ms);
    }
    expect(reverse[0]!.shot_id).toBe("earlier");

    // Overlapping ranges still yield non-decreasing timestamps without rewriting shot ids
    const overlap = buildMediaFramePlan(
      [
        { id: "a", start_ms: 0, end_ms: 5000 },
        { id: "b", start_ms: 1000, end_ms: 2000 }
      ],
      { frames_per_shot: 3, max_total_frames: 48 }
    );
    const ids = new Set(overlap.map((f) => f.shot_id));
    expect(ids.has("a")).toBe(true);
    expect(ids.has("b")).toBe(true);
    for (let i = 1; i < overlap.length; i += 1) {
      expect(overlap[i]!.timestamp_ms).toBeGreaterThanOrEqual(overlap[i - 1]!.timestamp_ms);
    }
  });
});

describe("P5 limits and path safety", () => {
  it("enforces max frame/size/duration/path/symlink limits", async () => {
    expect(() =>
      buildMediaFramePlan(
        [{ id: "s", start_ms: 0, end_ms: 1000 }],
        { frames_per_shot: MEDIA_EVIDENCE_LIMITS.max_frames_per_shot + 1, max_total_frames: 48 }
      )
    ).toThrow(/frames_per_shot|limit/i);

    const manyShots = Array.from({ length: 20 }, (_, i) => ({
      id: `s${i}`,
      start_ms: i * 1000,
      end_ms: i * 1000 + 1000
    }));
    expect(() =>
      buildMediaFramePlan(manyShots, { frames_per_shot: 4, max_total_frames: 10 })
    ).toThrow(/max_total_frames|limit/i);

    const planned = planMediaFrameExtraction({
      sourceRelativePath: "clips/source.mp4",
      sourceBytes: MEDIA_EVIDENCE_LIMITS.max_video_bytes + 1,
      durationMs: 1000,
      framePlan: [{ shot_id: "s", timestamp_ms: 0, role: "boundary_start" }],
      outputDirRelative: "frames"
    });
    expect(planned.ok).toBe(false);
    expect(planned.issues[0]?.code).toMatch(/size|limit/i);

    const long = planMediaFrameExtraction({
      sourceRelativePath: "clips/source.mp4",
      sourceBytes: 1024,
      durationMs: MEDIA_EVIDENCE_LIMITS.max_duration_ms + 1,
      framePlan: [{ shot_id: "s", timestamp_ms: 0, role: "boundary_start" }],
      outputDirRelative: "frames"
    });
    expect(long.ok).toBe(false);
    expect(long.issues[0]?.code).toMatch(/duration|limit/i);

    const runDir = await tmpRunDir("path");
    const escape = await resolveSafeEvidencePath(runDir, "../outside.png");
    expect(escape.ok).toBe(false);
    expect(escape.issues[0]?.code).toMatch(/path_escape|path/i);

    const abs = await resolveSafeEvidencePath(runDir, "/tmp/evil.png");
    expect(abs.ok).toBe(false);

    const leaf = join(runDir, "frames");
    await mkdir(leaf, { recursive: true });
    const external = join(tmpdir(), `media-ev-ext-${Date.now()}.png`);
    await writeFile(external, "x");
    const link = join(runDir, "frames", "link.png");
    await symlink(external, link);
    const sym = await resolveSafeEvidencePath(runDir, "frames/link.png");
    expect(sym.ok).toBe(false);
    expect(sym.issues[0]?.code).toMatch(/symlink/i);

    const argv = buildFixedFfmpegExtractArgv({
      sourcePath: "in.mp4",
      timestampMs: 1000,
      outputPath: "out.png"
    });
    expect(Array.isArray(argv)).toBe(true);
    expect(argv.every((part) => typeof part === "string")).toBe(true);
    expect(argv.join(" ")).not.toMatch(/;|&&|\|/);
  });
});

describe("P5 contact sheet order / digest / cell integrity / tool version", () => {
  it("uses frames-manifest order only and rejects cell meta tampering", async () => {
    const manifest = baseFramesManifest();
    const layoutA = buildContactSheetLayout({
      framesManifest: manifest,
      columns: 3,
      generator: { tool: "mock-sheet", version: "1.0.0", argv: ["layout", "grid"] },
      outputRelativePath: "contact-sheet.webp",
      outputSha256: createHash("sha256").update("sheet-bytes").digest("hex")
    });
    const layoutB = buildContactSheetLayout({
      framesManifest: manifest,
      columns: 3,
      generator: { tool: "mock-sheet", version: "1.0.0", argv: ["layout", "grid"] },
      outputRelativePath: "contact-sheet.webp",
      outputSha256: createHash("sha256").update("sheet-bytes").digest("hex")
    });
    expect(layoutA).toEqual(layoutB);
    expect(layoutA.frame_digests_in_order).toEqual(manifest.frames.map((f) => f.sha256));
    expect(layoutA.cells.map((c) => c.frame_index)).toEqual([0, 1, 2]);
    expect(layoutA.cells.map((c) => c.order)).toEqual([0, 1, 2]);
    expect(layoutA.cells[0]?.label).toBe("shot_1@0ms");
    expect(computeContactSheetLayoutDigest(layoutA)).toBe(computeContactSheetLayoutDigest(layoutB));

    const argv = buildFixedContactSheetArgv({
      framePaths: manifest.frames.map((f) => f.relative_path),
      outputPath: "contact-sheet.webp",
      columns: 3
    });
    expect(Array.isArray(argv)).toBe(true);

    const runDir = await tmpRunDir("sheet");
    await writeFramesAndSheet(runDir, manifest);

    const good = await verifyContactSheetIntegrity({
      runDir,
      layout: layoutA,
      framesManifest: manifest
    });
    expect(good.ok).toBe(true);

    const badTool: ContactSheetLayoutV1 = {
      ...layoutA,
      generator: { ...layoutA.generator, version: "9.9.9" }
    };
    const toolMismatch = await verifyContactSheetIntegrity({
      runDir,
      layout: badTool,
      framesManifest: manifest,
      expectedGenerator: layoutA.generator
    });
    expect(toolMismatch.ok).toBe(false);
    expect(toolMismatch.issues[0]?.code).toMatch(/tool|version|tamper/i);

    const badIndex: ContactSheetLayoutV1 = {
      ...layoutA,
      cells: layoutA.cells.map((cell, i) =>
        i === 1 ? { ...cell, frame_index: 99 } : cell
      )
    };
    const indexMismatch = await verifyContactSheetIntegrity({
      runDir,
      layout: badIndex,
      framesManifest: manifest
    });
    expect(indexMismatch.ok).toBe(false);
    expect(indexMismatch.issues[0]?.code).toMatch(/cells_mismatch|cell/i);

    const badOrder: ContactSheetLayoutV1 = {
      ...layoutA,
      cells: layoutA.cells.map((cell, i) => (i === 0 ? { ...cell, order: 7 } : cell))
    };
    const orderMismatch = await verifyContactSheetIntegrity({
      runDir,
      layout: badOrder,
      framesManifest: manifest
    });
    expect(orderMismatch.ok).toBe(false);
    expect(orderMismatch.issues[0]?.code).toMatch(/cells_mismatch|cell/i);

    const badLabel: ContactSheetLayoutV1 = {
      ...layoutA,
      cells: layoutA.cells.map((cell, i) =>
        i === 0 ? { ...cell, label: "TAMPERED-LABEL" } : cell
      )
    };
    const labelMismatch = await verifyContactSheetIntegrity({
      runDir,
      layout: badLabel,
      framesManifest: manifest
    });
    expect(labelMismatch.ok).toBe(false);
    expect(labelMismatch.issues[0]?.code).toMatch(/cells_mismatch|cell/i);

    const badLen: ContactSheetLayoutV1 = {
      ...layoutA,
      cells: layoutA.cells.slice(0, 1)
    };
    const lenMismatch = await verifyContactSheetIntegrity({
      runDir,
      layout: badLen,
      framesManifest: manifest
    });
    expect(lenMismatch.ok).toBe(false);

    await writeFile(join(runDir, "contact-sheet.webp"), "tampered-sheet");
    const tampered = await verifyContactSheetIntegrity({
      runDir,
      layout: layoutA,
      framesManifest: manifest
    });
    expect(tampered.ok).toBe(false);
    expect(tampered.issues[0]?.code).toMatch(/tamper|hash|mismatch/i);
  });
});

describe("P5 verifyMediaEvidenceBundle production path + rehash (M1)", () => {
  it("requires safe path resolve + streaming rehash; sourceVideoSha256 alone is not enough", async () => {
    const runDir = await tmpRunDir("bundle");
    const sourceBytes = "source-video-fixture";
    await writeFile(join(runDir, "source.mp4"), sourceBytes);
    const sourceHash = await sha256FileStreaming(join(runDir, "source.mp4"));
    const manifest = baseFramesManifest({ source_video_sha256: sourceHash });
    const layout = await writeFramesAndSheet(runDir, manifest);

    const ok = await verifyMediaEvidenceBundle({
      runDir,
      framesManifest: manifest,
      contactSheetLayout: layout,
      sourceVideoRelativePath: "source.mp4"
    });
    expect(ok.ok).toBe(true);

    // Missing source => reject (no production sha256-only bypass)
    const missingDir = await tmpRunDir("missing-src");
    const layoutMissing = await writeFramesAndSheet(missingDir, manifest);
    const missing = await verifyMediaEvidenceBundle({
      runDir: missingDir,
      framesManifest: manifest,
      contactSheetLayout: layoutMissing,
      sourceVideoRelativePath: "source.mp4"
    });
    expect(missing.ok).toBe(false);
    expect(missing.issues[0]?.code).toMatch(/source_missing|missing/i);

    // Unreadable path escape
    const escape = await verifyMediaEvidenceBundle({
      runDir,
      framesManifest: manifest,
      sourceVideoRelativePath: "../escape.mp4"
    });
    expect(escape.ok).toBe(false);
    expect(escape.issues[0]?.code).toMatch(/path_escape|path/i);

    // Symlink source rejected
    const symDir = await tmpRunDir("sym-src");
    const external = join(tmpdir(), `media-ev-src-${Date.now()}.mp4`);
    await writeFile(external, sourceBytes);
    await symlink(external, join(symDir, "source.mp4"));
    const layoutSym = await writeFramesAndSheet(symDir, manifest);
    const sym = await verifyMediaEvidenceBundle({
      runDir: symDir,
      framesManifest: manifest,
      contactSheetLayout: layoutSym,
      sourceVideoRelativePath: "source.mp4"
    });
    expect(sym.ok).toBe(false);
    expect(sym.issues[0]?.code).toMatch(/symlink|path/i);

    // Hash mismatch on disk
    await writeFile(join(runDir, "source.mp4"), "DIFFERENT-BYTES");
    const mismatch = await verifyMediaEvidenceBundle({
      runDir,
      framesManifest: manifest,
      contactSheetLayout: layout,
      sourceVideoRelativePath: "source.mp4"
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.issues[0]?.code).toMatch(/tamper|hash|mismatch/i);

    // Test-only fixture API when file is absent (not on production signature)
    const fixtureDir = await tmpRunDir("fixture-only");
    const fixtureLayout = await writeFramesAndSheet(fixtureDir, {
      ...manifest,
      source_video_sha256: createHash("sha256").update(sourceBytes).digest("hex")
    });
    const fixtureOk = await verifyMediaEvidenceBundleForTests({
      runDir: fixtureDir,
      framesManifest: {
        ...manifest,
        source_video_sha256: createHash("sha256").update(sourceBytes).digest("hex")
      },
      contactSheetLayout: fixtureLayout,
      sourceVideoRelativePath: "source.mp4",
      sourceVideoBytes: sourceBytes
    });
    expect(fixtureOk.ok).toBe(true);
  });

  it("re-checks size limit before hashing oversized source (L3)", async () => {
    const runDir = await tmpRunDir("size");
    // Sparse-ish small file is fine; we mock by writing and checking limit against stats.size.
    // Use a tiny oversize relative to a stub: write file larger than limit by monkey-patching is hard;
    // instead verify the code path rejects when planMediaFrameExtraction already gates, and
    // for verify: write a file and temporarily rely on MEDIA_EVIDENCE_LIMITS.
    // Practical approach: call hash path with a file whose size we claim exceeds by writing
    // many bytes is slow. Unit: size check uses stats.size > max — use a tiny custom by
    // verifying missing oversize isn't hashed: create large file only if limit is small enough.
    // We assert the planning gate and that verify rejects via size when stats exceed limit
    // by writing a moderately large buffer only when max is the production constant —
    // skip full 512MB write; instead test that size_limit code is returned by using
    // a spy-like approach: write frames and use source with correct hash then swap to
    // verifyFrames path. Direct unit: oversized via extracting the helper behavior
    // through planMediaFrameExtraction already covered; for verify, write 1 byte then
    // ensure limit check exists by testing with frames integrity after source ok.
    // Alternative: temporarily write a file of max+1 is too heavy. Test the reject message
    // path using a symlink-to-large is also heavy.
    // Use Object approach: write source, then replace with a file we cannot fully hash because
    // we patch? Keep a lightweight check that the function returns size_limit when size exceeds.
    // We'll write a 1KB file and document that full max_video_bytes+1 is covered in plan;
    // additionally call verify with a mocked size by creating a sparse file if supported.
    const sparse = join(runDir, "huge.mp4");
    // Fall back: write small and assert production verify does not accept declared-only hash.
    await writeFile(sparse, "tiny");
    const manifest = baseFramesManifest({
      source_video_sha256: createHash("sha256").update("tiny").digest("hex")
    });
    await writeFramesAndSheet(runDir, manifest);
    // Create a file that appears oversized using fd truncate (sparse)
    const { open } = await import("node:fs/promises");
    const handle = await open(sparse, "w");
    try {
      await handle.truncate(MEDIA_EVIDENCE_LIMITS.max_video_bytes + 1);
    } finally {
      await handle.close();
    }
    const oversized = await verifyMediaEvidenceBundle({
      runDir,
      framesManifest: manifest,
      sourceVideoRelativePath: "huge.mp4"
    });
    expect(oversized.ok).toBe(false);
    expect(oversized.issues[0]?.code).toBe("media_evidence.size_limit");
  });
});

describe("P5 evidence digest canonical (L2)", () => {
  it("uses shared sha256Canonical for P5 bundle digests with golden stability", async () => {
    const runDir = await tmpRunDir("digest");
    await writeFile(join(runDir, "source.mp4"), "source-video-fixture");
    const sourceHash = await sha256FileStreaming(join(runDir, "source.mp4"));
    const manifest = baseFramesManifest({ source_video_sha256: sourceHash });
    const layout = await writeFramesAndSheet(runDir, manifest);

    const verified = await verifyMediaEvidenceBundle({
      runDir,
      framesManifest: manifest,
      contactSheetLayout: layout,
      sourceVideoRelativePath: "source.mp4"
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    const expected = computeMediaEvidenceBundleDigest({
      frames_manifest_digest: verified.frames_manifest_digest,
      source_video_sha256: sourceHash,
      extractor: manifest.extractor,
      contact_sheet_sha256: verified.contact_sheet_sha256 ?? null
    });
    expect(verified.evidence_digest).toBe(expected);
    expect(verified.evidence_digest).toBe(
      sha256Canonical({
        contact_sheet_sha256: verified.contact_sheet_sha256 ?? null,
        extractor: manifest.extractor,
        frames_manifest_digest: verified.frames_manifest_digest,
        source_video_sha256: sourceHash
      })
    );

    // Golden: same payload always same digest
    expect(computeMediaEvidenceBundleDigest({
      frames_manifest_digest: "a".repeat(64),
      source_video_sha256: "b".repeat(64),
      extractor: { tool: "ffmpeg", version: "1", argv: ["-y"] },
      contact_sheet_sha256: null
    })).toBe(
      computeMediaEvidenceBundleDigest({
        frames_manifest_digest: "a".repeat(64),
        source_video_sha256: "b".repeat(64),
        extractor: { tool: "ffmpeg", version: "1", argv: ["-y"] },
        contact_sheet_sha256: null
      })
    );

    // Phase A/B person report digest remains on report schema path (compat)
    const report: PersonConsistencyReportV1 = {
      schema_version: "person-consistency-report-v1",
      stage: "gate_2",
      status: "ok",
      input_digest: HEX,
      subject_reference_hashes: {},
      tracks: [],
      subjects: [],
      sampling_plan: [],
      provenance: {
        adapter: "person-consistency-fixture",
        adapter_class: "semantic-qa",
        model: "fixture",
        version: "1.0.0",
        network_used: false,
        network_input_scope: "none"
      },
      artifacts: { report_relative_path: "qa/person-consistency/gate2/report.json" },
      ambiguities: [],
      blocked_reasons: []
    };
    expect(parsePersonConsistencyReport(report).ok).toBe(true);
  });
});

describe("P5 analyzer license and local failure", () => {
  it("rejects unknown-license weights and never falls back externally", () => {
    const unknown = validateAnalyzerWeightsLicense({
      analyzer_id: "local-fixture",
      version: "1.0.0",
      weights_sha256: HEX,
      license: "unknown",
      commercial_use: "unknown"
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.issues[0]?.code).toMatch(/license/i);

    const missing = validateAnalyzerWeightsLicense({
      analyzer_id: "local-fixture",
      version: "1.0.0",
      weights_sha256: HEX
    });
    expect(missing.ok).toBe(false);

    const ok = validateAnalyzerWeightsLicense({
      analyzer_id: "person-consistency-fixture",
      version: "1.0.0",
      license: "fixture",
      commercial_use: "n/a"
    });
    expect(ok.ok).toBe(true);

    const status = evaluateLocalAnalyzerStatus({
      localAnalyzerAvailable: false,
      localFailed: false
    });
    expect(status.status).toBe("not-run");
    expect(status.needs_human_review).toBe(true);
    expect(status.external_fallback).toBe(false);

    const failed = evaluateLocalAnalyzerStatus({
      localAnalyzerAvailable: true,
      localFailed: true
    });
    expect(failed.status).toBe("needs-human-review");
    expect(failed.external_fallback).toBe(false);
  });
});

describe("P5 gate binding: automatic score is advisory only", () => {
  it("does not pass Gate without human decision even with high automatic score", () => {
    const highScoreOnly = canPassGateWithEvidence({
      automatic_score: 0.99,
      evidence_digest: HEX,
      bound_evidence_digest: HEX
    });
    expect(highScoreOnly.passed).toBe(false);
    expect(highScoreOnly.reason).toMatch(/human|decision|review/i);

    const withHuman = canPassGateWithEvidence({
      automatic_score: 0.99,
      evidence_digest: HEX,
      bound_evidence_digest: HEX,
      human_decision: {
        decision: "accept",
        reason: "visual identity matches reference"
      },
      report_status: "ok"
    });
    expect(withHuman.passed).toBe(true);
  });
});

describe("P5 evidence frame tamper invalidates decision/gate", () => {
  it("fails closed when a frame hash changes after binding", async () => {
    const runDir = await tmpRunDir("tamper");
    await writeFile(join(runDir, "source.mp4"), "source-video-fixture");
    const sourceHash = await sha256FileStreaming(join(runDir, "source.mp4"));
    const manifest = baseFramesManifest({ source_video_sha256: sourceHash });
    const layout = await writeFramesAndSheet(runDir, manifest);

    const good2 = await verifyMediaEvidenceBundle({
      runDir,
      framesManifest: manifest,
      contactSheetLayout: layout,
      sourceVideoRelativePath: "source.mp4"
    });
    expect(good2.ok).toBe(true);

    await writeFile(join(runDir, manifest.frames[1]!.relative_path), "TAMPERED");
    const bad = await verifyMediaEvidenceBundle({
      runDir,
      framesManifest: manifest,
      contactSheetLayout: layout,
      sourceVideoRelativePath: "source.mp4"
    });
    expect(bad.ok).toBe(false);
    expect(bad.issues[0]?.code).toMatch(/frame|tamper|hash|mismatch/i);

    const decision = canPassGateWithEvidence({
      automatic_score: 0.99,
      evidence_digest: "c".repeat(64),
      bound_evidence_digest: HEX,
      human_decision: { decision: "accept", reason: "looks good" },
      report_status: "ok"
    });
    expect(decision.passed).toBe(false);
    expect(decision.reason).toMatch(/evidence|digest|tamper|stale|mismatch/i);
  });
});

describe("P5 provider-neutral QA contract", () => {
  it("handles the same evidence contract without model/provider imports", () => {
    const routes = ["route-alpha", "route-beta", "route-gamma"] as const;
    const digests = routes.map((route) => {
      const manifest = baseFramesManifest({
        extractor: {
          tool: "ffmpeg",
          version: "fixture-1.0.0",
          argv: ["-y", "-i", `${route}.mp4`, "-frames:v", "1", "out.png"]
        }
      });
      const parsed = parseFramesManifest(manifest);
      expect(parsed.ok).toBe(true);
      return computeFramesManifestDigest(manifest);
    });
    for (const route of routes) {
      const plan = buildMediaFramePlan(
        [{ id: `${route}-shot`, start_ms: 0, end_ms: 3000 }],
        { frames_per_shot: 3, max_total_frames: 48 }
      );
      expect(plan.length).toBeGreaterThanOrEqual(2);
      expect(plan.every((f) => typeof f.timestamp_ms === "number")).toBe(true);
    }
    expect(digests.every((d) => /^[a-f0-9]{64}$/.test(d))).toBe(true);

    const report: PersonConsistencyReportV1 = {
      schema_version: "person-consistency-report-v1",
      stage: "gate_2",
      status: "ok",
      input_digest: HEX,
      subject_reference_hashes: {},
      tracks: [],
      subjects: [
        {
          subject_id: "hero",
          basis: "reference",
          traits: [{ trait: "identity", status: "stable", level: "required" }],
          observations: [
            {
              timestamp_ms: 0,
              shot_id: "shot_1",
              visibility: "visible",
              face_evaluable: true,
              reason: "fixture"
            }
          ],
          evaluable_coverage: 1,
          ambiguity_codes: []
        }
      ],
      sampling_plan: [{ shot_id: "shot_1", timestamp_ms: 0, role: "boundary_start" }],
      provenance: {
        adapter: "person-consistency-fixture",
        adapter_class: "semantic-qa",
        model: "fixture",
        version: "1.0.0",
        network_used: false,
        network_input_scope: "none"
      },
      artifacts: { report_relative_path: "qa/person-consistency/gate2/report.json" },
      ambiguities: [],
      blocked_reasons: []
    };
    expect(parsePersonConsistencyReport(report).ok).toBe(true);
  });
});

describe("P5 frames integrity helper surface", () => {
  it("verifies frames against on-disk bytes with streaming hash", async () => {
    const runDir = await tmpRunDir("frames");
    await mkdir(join(runDir, "frames"), { recursive: true });
    const manifest = baseFramesManifest();
    for (const [index, frame] of manifest.frames.entries()) {
      await writeFile(join(runDir, frame.relative_path), `frame${index}`);
    }
    const ok = await verifyFramesManifestIntegrity({ runDir, framesManifest: manifest });
    expect(ok.ok).toBe(true);

    const hash = await sha256FileStreaming(join(runDir, manifest.frames[0]!.relative_path));
    expect(hash).toBe(manifest.frames[0]!.sha256);
  });
});

describe("P5 Gate inspect still requires human decision when QA enabled", () => {
  it("high-score style report without decision stays unpassed", async () => {
    const runDir = await tmpRunDir("gate");
    await mkdir(join(runDir, "qa", "person-consistency", "gate2"), { recursive: true });
    const report: PersonConsistencyReportV1 = {
      schema_version: "person-consistency-report-v1",
      stage: "gate_2",
      status: "ok",
      input_digest: HEX,
      subject_reference_hashes: {},
      tracks: [],
      subjects: [
        {
          subject_id: "hero",
          basis: "reference",
          traits: [{ trait: "identity", status: "stable", level: "required" }],
          observations: [
            {
              timestamp_ms: 0,
              shot_id: "shot_1",
              visibility: "visible",
              face_evaluable: true,
              reason: "high automatic score fixture"
            }
          ],
          evaluable_coverage: 1,
          ambiguity_codes: []
        }
      ],
      sampling_plan: [{ shot_id: "shot_1", timestamp_ms: 0, role: "boundary_start" }],
      provenance: {
        adapter: "person-consistency-fixture",
        adapter_class: "semantic-qa",
        model: "fixture",
        version: "1.0.0",
        network_used: false,
        network_input_scope: "none"
      },
      artifacts: {
        report_relative_path: "qa/person-consistency/gate2/report.json"
      },
      ambiguities: [],
      blocked_reasons: []
    };
    await writeFile(
      join(runDir, "qa", "person-consistency", "gate2", "report.json"),
      `${JSON.stringify(report, null, 2)}\n`
    );

    const project = {
      quality: {
        person_consistency: {
          enabled: true,
          adapter: "person-consistency-fixture",
          fallback: "fail" as const,
          stages: ["gate_2" as const],
          evidence: {
            sampling: "shot-boundaries-and-uniform" as const,
            frames_per_shot: 4,
            retain_face_embeddings: false as const
          },
          external: { allowed: false }
        }
      }
    };

    const noDecision = await inspectPersonConsistencyForGate({
      project,
      stage: "gate_2",
      runDir,
      reportRelativePath: "qa/person-consistency/gate2/report.json",
      requireHumanDecision: true
    });
    expect(noDecision.ok).toBe(false);
    expect(noDecision.issues[0]?.code).toBe("person_qa.human_decision_required");
  });
});
