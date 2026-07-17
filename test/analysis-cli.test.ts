import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("pipeline analyze", () => {
  it("requires the coordinator role", async () => {
    const fixture = await createAnalysisProject();
    const result = runPipeline(["analyze", "--config", fixture.configPath, "--json"]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).issues[0].code).toBe("cli.coordinator_required");
  });

  it("writes offline raw analysis and an agent handoff without mutating source inputs or Gate state", async () => {
    const fixture = await createAnalysisProject();
    const beforeManifest = await readFile(fixture.manifestPath, "utf8");
    const beforeSource = await readFile(fixture.sourcePath);

    const result = runPipeline([
      "analyze",
      "--config",
      fixture.configPath,
      "--actor",
      "coordinator",
      "--json"
    ]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      ok: true,
      command: "analyze",
      actual_credits: 0,
      api_used: false,
      network_used: false
    });

    const artifact = JSON.parse(await readFile(parsed.analysis_path, "utf8"));
    expect(artifact).toMatchObject({
      schema_version: 1,
      run_id: "offline-analysis-run",
      adapter: "local-media-analysis",
      actual_credits: 0,
      api_used: false,
      network_used: false
    });
    expect(artifact.results[0].data.cut_points[0]).toMatchObject({
      kind: "silence",
      action: "review"
    });
    expect(JSON.parse(await readFile(parsed.proposal_path, "utf8"))).toMatchObject({
      status: "proposed",
      outputs: { cut_points: [expect.objectContaining({ kind: "silence", action: "review" })] }
    });
    expect(await readFile(parsed.handoff_path, "utf8")).toContain("source_start");
    expect(await readFile(fixture.manifestPath, "utf8")).toBe(beforeManifest);
    expect(await readFile(fixture.sourcePath)).toEqual(beforeSource);
    await expect(stat(join(fixture.distDir, "offline-analysis-run", "state.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps detected timestamps on the original source timeline for a trimmed source clip", async () => {
    const fixture = await createAnalysisProject({ clipIn: 0.5, clipOut: 1.5 });

    const result = runPipeline([
      "analyze",
      "--config",
      fixture.configPath,
      "--actor",
      "coordinator",
      "--json"
    ]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const artifact = JSON.parse(await readFile(parsed.analysis_path, "utf8"));
    expect(artifact.results[0].source).toMatchObject({
      analysis_start_seconds: 0.5,
      analysis_end_seconds: 1.5,
      duration_seconds: 1
    });
    expect(artifact.results[0].data.cut_points[0]).toMatchObject({
      source_start: 0.5,
      source_end: 1.5
    });
  });

  it("returns a structured error without leaking a stack trace when artifacts cannot be written", async () => {
    const fixture = await createAnalysisProject();
    const blockedOutput = join(fixture.root, "blocked-output");
    await writeFile(blockedOutput, "not a directory");

    const result = runPipeline([
      "analyze",
      "--config",
      fixture.configPath,
      "--actor",
      "coordinator",
      "--state-dir",
      blockedOutput,
      "--json"
    ]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).issues[0].code).toBe("analysis.artifact_write_failed");
    expect(result.stderr).not.toContain("src/orchestrator/analyze.ts");
    expect(result.stderr).not.toContain("Error:");
  });

  it("binds Gate 1 approval to the current editorial proposal digest", async () => {
    const fixture = await createAnalysisProject();
    expect(runPipeline([
      "analyze",
      "--config",
      fixture.configPath,
      "--actor",
      "coordinator",
      "--json"
    ]).status).toBe(0);

    const reviewed = runPipeline(["review", "--config", fixture.configPath, "--json"]);
    expect(reviewed.status).toBe(0);
    const reviewPayload = JSON.parse(reviewed.stdout);
    const reviewData = JSON.parse(await readFile(reviewPayload.review_data_path, "utf8"));
    expect(reviewData).toMatchObject({
      schema_version: 2,
      analysis: {
        status: "ready",
        outputs: { cut_points: [expect.objectContaining({ action: "review" })] }
      }
    });
    expect(reviewData.approval_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(reviewPayload.review_path, "utf8")).toContain("フィラー・カット確認候補");

    const originalManifest = await readFile(fixture.manifestPath, "utf8");
    const changedManifest = JSON.parse(originalManifest);
    changedManifest.meta.target_duration_seconds = 3;
    await writeFile(fixture.manifestPath, `${JSON.stringify(changedManifest, null, 2)}\n`);
    const staleReview = runPipeline([
      "gate",
      "--config",
      fixture.configPath,
      "--actor",
      "coordinator",
      "--gate",
      "gate-1",
      "--decision",
      "approved",
      "--json"
    ]);
    expect(staleReview.status).toBe(1);
    expect(JSON.parse(staleReview.stderr).issues[0].code).toBe("gate.analysis_changed");
    await writeFile(fixture.manifestPath, originalManifest);

    const approved = runPipeline([
      "gate",
      "--config",
      fixture.configPath,
      "--actor",
      "coordinator",
      "--gate",
      "gate-1",
      "--decision",
      "approved",
      "--json"
    ]);
    expect(approved.status).toBe(0);
    expect(JSON.parse(approved.stdout).state.gates.gate_1.approved_input_digest).toBe(reviewData.approval_digest);

    const proposalPath = join(fixture.distDir, "offline-analysis-run", "analysis", "editorial-proposal.json");
    const proposal = JSON.parse(await readFile(proposalPath, "utf8"));
    proposal.outputs.cut_points[0].source_end = 1.5;
    await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);

    const blocked = runPipeline([
      "run",
      "--config",
      fixture.configPath,
      "--actor",
      "coordinator",
      "--json"
    ]);
    expect(blocked.status).toBe(1);
    expect(JSON.parse(blocked.stderr).issues[0].code).toMatch(/gate\.analysis_(?:stale|changed)/);
  }, 15_000);

  it("compiles only Gate 1 approved editorial selections into an auditable EDL", async () => {
    const fixture = await createAnalysisProject({ editorial: true, mixedAudio: true });
    expect(runPipeline([
      "analyze",
      "--config",
      fixture.configPath,
      "--actor",
      "coordinator",
      "--json"
    ]).status).toBe(0);

    const reviewed = runPipeline(["review", "--config", fixture.configPath, "--json"]);
    expect(reviewed.status).toBe(0);
    expect(await readFile(JSON.parse(reviewed.stdout).review_path, "utf8")).toContain("適用予定");
    expect(runPipeline([
      "gate",
      "--config",
      fixture.configPath,
      "--actor",
      "coordinator",
      "--gate",
      "gate-1",
      "--decision",
      "approved",
      "--json"
    ]).status).toBe(0);

    const run = runPipeline(["run", "--config", fixture.configPath, "--actor", "coordinator", "--json"]);
    expect(run.status).toBe(0);
    const payload = JSON.parse(run.stdout);
    expect(payload.edl_path).toMatch(/editorial-edl\.json$/);
    const [manifestText, edlText] = await Promise.all([
      readFile(payload.manifest_path, "utf8"),
      readFile(payload.edl_path, "utf8")
    ]);
    const manifest = JSON.parse(manifestText);
    const edl = JSON.parse(edlText);
    expect(manifest.clips.length).toBeGreaterThanOrEqual(2);
    expect(new Set(manifest.clips.map((clip: { src: string }) => clip.src)).size).toBe(1);
    expect(manifest.meta.target_duration_seconds).toBeLessThan(2);
    expect(edl).toMatchObject({
      schema_version: 1,
      source_duration_seconds: 2,
      removed_ranges: [expect.objectContaining({ kinds: expect.arrayContaining(["silence"]) })]
    });
    expect(edl.duration_seconds).toBe(manifest.meta.target_duration_seconds);

    const resumed = runPipeline(["run", "--config", fixture.configPath, "--actor", "coordinator", "--json"]);
    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.stdout).already_assembled).toBe(true);

    manifest.meta.slug = "tampered-after-gate-1";
    await writeFile(payload.manifest_path, `${JSON.stringify(manifest, null, 2)}\n`);
    const manifestTampered = runPipeline([
      "gate",
      "--config",
      fixture.configPath,
      "--actor",
      "coordinator",
      "--gate",
      "gate-2",
      "--decision",
      "approve_all",
      "--json"
    ]);
    expect(manifestTampered.status).toBe(1);
    expect(JSON.parse(manifestTampered.stderr).issues[0].code).toBe("run.edl_inconsistent");
    await writeFile(payload.manifest_path, manifestText);

    edl.duration_seconds += 0.1;
    await writeFile(payload.edl_path, `${JSON.stringify(edl, null, 2)}\n`);
    const tampered = runPipeline([
      "gate",
      "--config",
      fixture.configPath,
      "--actor",
      "coordinator",
      "--gate",
      "gate-2",
      "--decision",
      "approve_all",
      "--json"
    ]);
    expect(tampered.status).toBe(1);
    expect(JSON.parse(tampered.stderr).issues[0].code).toBe("run.edl_invalid");

    await writeFile(payload.edl_path, edlText);
    const gate2Approved = runPipeline([
      "gate",
      "--config",
      fixture.configPath,
      "--actor",
      "coordinator",
      "--gate",
      "gate-2",
      "--decision",
      "approve_all",
      "--json"
    ]);
    expect(gate2Approved.status).toBe(0);
    expect(JSON.parse(gate2Approved.stdout).state.gates.gate_2.approved_input_digest).toMatch(/^[a-f0-9]{64}$/);

    manifest.meta.slug = "tampered-after-gate-2";
    await writeFile(payload.manifest_path, `${JSON.stringify(manifest, null, 2)}\n`);
    const renderTampered = runPipeline([
      "render",
      "--config",
      fixture.configPath,
      "--actor",
      "coordinator",
      "--json"
    ]);
    expect(renderTampered.status).toBe(1);
    expect(JSON.parse(renderTampered.stderr).issues[0].code).toBe("run.edl_inconsistent");
  }, 15_000);
});

function runPipeline(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR
    }
  });
}

async function createAnalysisProject(options: {
  clipIn?: number;
  clipOut?: number;
  editorial?: boolean;
  mixedAudio?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "tsugite-offline-analysis-"));
  const sourcePath = join(root, "seminar.mp4");
  const manifestPath = join(root, "manifest.json");
  const configPath = join(root, "project.yaml");
  const distDir = join(root, "dist");
  createAnalysisMedia(sourcePath, options.mixedAudio ?? false);

  const clipIn = options.clipIn ?? 0;
  const clipOut = options.clipOut ?? 2;
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      meta: { aspect: "16:9", fps: 30, target_duration_seconds: 2, slug: "offline-analysis" },
      clips: [
        {
          id: "seminar-source",
          src: "seminar.mp4",
          in: clipIn,
          out: clipOut,
          duration: clipOut - clipIn,
          fps: 30,
          resolution: { width: 320, height: 180 },
          audio: true
        }
      ],
      audio: { bgm: [], narration: [], sfx: [] },
      captions: [],
      chapters: [],
      provenance: []
    }, null, 2)}\n`
  );
  await writeFile(
    configPath,
    `slug: offline-analysis\nrun_id: offline-analysis-run\nmanifest: manifest.json\ndist_dir: dist\nedit:\n  backend: remotion\n${options.editorial ? "  editorial:\n    remove_kinds: [silence]\n" : ""}analysis:\n  adapter: local-media-analysis\n  requests:\n    - id: silence-scan\n      output: cut_points\n      source_clip_id: seminar-source\n      params:\n        silence_noise_db: -35\n        silence_min_duration_seconds: 0.25\n`
  );

  return { root, sourcePath, manifestPath, configPath, distDir };
}

function createAnalysisMedia(path: string, mixedAudio: boolean): void {
  const audioInput = mixedAudio
    ? "aevalsrc=if(between(t\\,0.5\\,1.0)\\,0\\,0.2*sin(2*PI*440*t)):s=48000:d=2"
    : "anullsrc=r=48000:cl=stereo:d=2";
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=320x180:r=30:d=2",
      "-f",
      "lavfi",
      "-i",
      audioInput,
      "-shortest",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-y",
      resolve(path)
    ],
    { encoding: "utf8" }
  );
  if (result.status !== 0) throw new Error(result.stderr);
}
