import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Manifest } from "../src/manifest/schema.js";
import {
  inspectGate3Sidecars,
  normalizedSidecarReportEntries,
  verifyGate3SidecarApproval,
  type Gate3SidecarReference
} from "../src/orchestrator/gate3Sidecars.js";
import {
  inspectGate3Output,
  type Gate3QcProbe
} from "../src/orchestrator/gate3Qc.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Gate 3 sidecar approval contract", () => {
  it("requires exact manifest↔report membership and hashes files into a stable approval digest", async () => {
    const fixture = await sidecarFixture();
    const manifest = sidecarManifest();
    const probe = () => validProResProbe();
    const good = await inspectGate3Sidecars({
      manifest,
      reportedSidecars: [{ kind: "prores_mov", path: "final-prores.mov" }],
      runDir: fixture.runDir,
      probe
    });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.sidecars[0]).toMatchObject({
      kind: "prores_mov",
      path: "final-prores.mov",
      expected: { video_codec: "prores" }
    });
    expect(good.sidecars[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(good.sidecarApprovalDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(normalizedSidecarReportEntries(good.sidecars)).toEqual([
      expect.objectContaining({ kind: "prores_mov", path: "final-prores.mov", sha256: good.sidecars[0]?.sha256 })
    ]);

    const omitted = await inspectGate3Sidecars({
      manifest,
      reportedSidecars: [],
      runDir: fixture.runDir,
      probe
    });
    expect(omitted.ok).toBe(false);
    if (!omitted.ok) expect(omitted.issues[0]?.code).toBe("render.sidecar_set_mismatch");
  });

  it("binds the Gate 1 sidecar expectations into the approval digest", async () => {
    const fixture = await sidecarFixture();
    const manifest = sidecarManifest();
    const reportedSidecars = [{ kind: "prores_mov", path: "final-prores.mov" }];
    const first = await inspectGate3Sidecars({
      manifest,
      reportedSidecars,
      runDir: fixture.runDir,
      probe: () => validProResProbe()
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const changedExpectation = sidecarManifest({ duration_seconds: 1.01 });
    const second = await inspectGate3Sidecars({
      manifest: changedExpectation,
      reportedSidecars,
      runDir: fixture.runDir,
      probe: () => validProResProbe()
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.sidecars[0]?.sha256).toBe(first.sidecars[0]?.sha256);
    expect(second.sidecarApprovalDigest).not.toBe(first.sidecarApprovalDigest);
  });

  it.each([
    ["codec", { codec: "h264" }, false],
    ["fps", { fps: 30 }, false],
    ["duration", { duration_seconds: 1.1 }, false],
    ["missing alpha", { has_alpha: false }, true],
    ["unexpected audio", { has_audio: true }, true]
  ] as const)("rejects sidecar %s mismatches", async (_label, change, isAlpha) => {
    const fixture = await sidecarFixture();
    const manifest = isAlpha
      ? sidecarManifest({}, true)
      : sidecarManifest();
    const path = isAlpha ? "final-prores-alpha.mov" : "final-prores.mov";
    const kind = isAlpha ? "alpha_solo_prores_mov" : "prores_mov";
    if (isAlpha) await writeFile(join(fixture.runDir, path), "alpha mov fixture");
    const expectedProbe = isAlpha
      ? { ...validProResProbe(), has_alpha: true, pixel_format: "yuva444p10le", has_audio: false }
      : validProResProbe();
    const actual = { ...expectedProbe, ...change } as Gate3QcProbe;
    const result = await inspectGate3Sidecars({
      manifest,
      reportedSidecars: [{ kind, path }],
      runDir: fixture.runDir,
      probe: () => actual
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe("gate3.sidecar.probe_mismatch");
  });

  it("rejects symlink outputs and finalize evidence drift", async () => {
    const fixture = await sidecarFixture();
    const manifest = sidecarManifest();
    const sidecarPath = join(fixture.runDir, "final-prores.mov");
    const outside = join(fixture.root, "outside.mov");
    await writeFile(outside, "external media");
    await rm(sidecarPath);
    await symlink(outside, sidecarPath);
    const symlinkResult = await inspectGate3Sidecars({
      manifest,
      reportedSidecars: [{ kind: "prores_mov", path: "final-prores.mov" }],
      runDir: fixture.runDir,
      probe: () => validProResProbe()
    });
    expect(symlinkResult.ok).toBe(false);
    if (!symlinkResult.ok) expect(symlinkResult.issues[0]?.code).toBe("render.sidecar_file_unsafe");

    await rm(sidecarPath);
    await writeFile(sidecarPath, "prores mov fixture");
    await writeFile(join(fixture.runDir, "final.mp4"), "final mp4 fixture");
    const reportSidecars = [{ kind: "prores_mov", path: "final-prores.mov" }];
    const inspected = await inspectGate3Sidecars({
      manifest,
      reportedSidecars: reportSidecars,
      runDir: fixture.runDir,
      probe: () => validProResProbe()
    });
    expect(inspected.ok).toBe(true);
    if (!inspected.ok || !inspected.sidecarApprovalDigest) return;
    await writeFile(join(fixture.runDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    await writeFile(join(fixture.runDir, "render-report.json"), `${JSON.stringify({ sidecars: normalizedSidecarReportEntries(inspected.sidecars) })}\n`);
    const finalQc = inspectGate3Output(manifest, join(fixture.runDir, "final.mp4"), {
      probe: () => ({ ...validProResProbe(), width: 1920, height: 1080, fps: 60, has_audio: false }),
      contentProbe: () => ({ ok: true }),
      sidecars: inspected.sidecars,
      sidecar_approval_digest: inspected.sidecarApprovalDigest
    });
    await writeFile(join(fixture.runDir, "gate3-qc.json"), `${JSON.stringify(finalQc)}\n`);
    const approved = await verifyGate3SidecarApproval({
      runDir: fixture.runDir,
      expectedSidecarApprovalDigest: inspected.sidecarApprovalDigest,
      probe: () => validProResProbe()
    });
    expect(approved.ok).toBe(true);

    await writeFile(sidecarPath, "changed after approval");
    const changedFile = await verifyGate3SidecarApproval({
      runDir: fixture.runDir,
      expectedSidecarApprovalDigest: inspected.sidecarApprovalDigest,
      probe: () => validProResProbe()
    });
    expect(changedFile.ok).toBe(false);

    await writeFile(sidecarPath, "prores mov fixture");
    const changedManifest = sidecarManifest({ duration_seconds: 1.01 });
    await writeFile(join(fixture.runDir, "manifest.json"), `${JSON.stringify(changedManifest)}\n`);
    const changedExpectation = await verifyGate3SidecarApproval({
      runDir: fixture.runDir,
      expectedSidecarApprovalDigest: inspected.sidecarApprovalDigest,
      probe: () => validProResProbe()
    });
    expect(changedExpectation.ok).toBe(false);
    if (!changedExpectation.ok) {
      expect(changedExpectation.issues[0]?.code).toBe("finalize.sidecar_qc_changed");
    }
  });
});

async function sidecarFixture(): Promise<{ root: string; runDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "tsugite-gate3-sidecar-"));
  tempRoots.push(root);
  const runDir = join(root, "run");
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "final-prores.mov"), "prores mov fixture");
  return { root, runDir };
}

function sidecarManifest(
  changes: Partial<Gate3SidecarReference["expected"]> = {},
  alpha = false
): Manifest {
  const expected = {
    duration_seconds: 1,
    width: 1920,
    height: 1080,
    fps: 60,
    video_codec: "prores",
    alpha_required: alpha,
    audio_required: false,
    ...changes
  };
  const kind = alpha ? "alpha_solo_prores_mov" : "prores_mov";
  const path = alpha ? "final-prores-alpha.mov" : "final-prores.mov";
  return {
    meta: { aspect: "16:9", fps: 60, target_duration_seconds: 1, slug: "native-sidecar" },
    clips: [],
    images: [],
    speakers: [],
    native_edit: {
      mode: "replace",
      payload: {},
      primary_output: { width: 1920, height: 1080, fps: 60, audio_required: false },
      outputs: [{ kind, path, ...expected }]
    }
  } as unknown as Manifest;
}

function validProResProbe(): Gate3QcProbe {
  return {
    ok: true,
    duration_seconds: 1,
    width: 1920,
    height: 1080,
    fps: 60,
    has_video: true,
    has_audio: false,
    codec: "prores",
    pixel_format: "yuv422p10le",
    has_alpha: false
  };
}
