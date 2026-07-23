import { copyFile, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("multi-source composition CLI", () => {
  it("compares proposals, requires a selection, and writes the EDL only after Gate 1 approval", async () => {
    const fixture = await createCompositionProject();
    const manifestBefore = await readFile(fixture.manifestPath, "utf8");
    const sourceBefore = await Promise.all(fixture.sourcePaths.map((path) => readFile(path)));

    const analyzed = runPipeline([
      "analyze", "--config", fixture.configPath, "--actor", "coordinator", "--json"
    ]);
    expect(analyzed.status).toBe(0);
    expect(JSON.parse(analyzed.stdout)).toMatchObject({
      api_used: false,
      network_used: false,
      actual_credits: 0
    });

    const unauthorizedCompose = runPipeline(["compose", "--config", fixture.configPath, "--json"]);
    expect(unauthorizedCompose.status).toBe(1);
    expect(JSON.parse(unauthorizedCompose.stderr).issues[0].code).toBe("cli.coordinator_required");

    const composed = runPipeline([
      "compose", "--config", fixture.configPath, "--actor", "coordinator", "--json"
    ]);
    expect(composed.status).toBe(0);
    const composedPayload = JSON.parse(composed.stdout);
    expect(composedPayload).toMatchObject({
      ok: true,
      command: "compose",
      gate_state: "unchanged"
    });
    expect(composedPayload.proposal_count).toBeGreaterThanOrEqual(2);
    expect(composedPayload.proposal_count).toBeLessThanOrEqual(3);

    const proposalArtifact = JSON.parse(await readFile(composedPayload.proposal_path, "utf8"));
    for (const proposal of proposalArtifact.proposals) {
      expect(proposal.segments.length).toBeGreaterThan(0);
      expect(proposal.segments.some((segment: { source_clip_id: string }) => segment.source_clip_id === "clip-c")).toBe(false);
      expect(proposal.segments.some((segment: { source_clip_id: string }) => segment.source_clip_id === "clip-a")).toBe(true);
      expect(proposal.segments.every((segment: Record<string, unknown>) =>
        typeof segment.source_clip_id === "string"
        && typeof segment.source_start === "number"
        && typeof segment.source_end === "number"
        && typeof segment.role === "string"
        && typeof segment.reason === "string"
        && Array.isArray(segment.observation_ids)
      )).toBe(true);
    }

    const comparisonReview = runPipeline(["review", "--config", fixture.configPath, "--json"]);
    expect(comparisonReview.status).toBe(0);
    const comparisonPayload = JSON.parse(comparisonReview.stdout);
    const comparisonData = JSON.parse(await readFile(comparisonPayload.review_data_path, "utf8"));
    expect(comparisonData).toMatchObject({
      schema_version: 3,
      composition: {
        status: "selection-required",
        proposals: expect.arrayContaining([
          expect.objectContaining({
            estimated_duration_seconds: expect.any(Number),
            segments: expect.arrayContaining([
              expect.objectContaining({
                source_clip_id: expect.any(String),
                source_start: expect.any(Number),
                source_end: expect.any(Number),
                role: expect.any(String),
                reason: expect.any(String)
              })
            ])
          })
        ])
      }
    });
    expect(await readFile(comparisonPayload.review_path, "utf8")).toContain("構成案比較");

    const unselectedGate = runPipeline([
      "gate", "--config", fixture.configPath, "--actor", "coordinator",
      "--gate", "gate-1", "--decision", "approved", "--json"
    ]);
    expect(unselectedGate.status).toBe(1);
    expect(JSON.parse(unselectedGate.stderr).issues[0].code).toBe("gate.composition_selection_required");

    await writeProject(fixture.configPath, "highlight-v1");
    const selectedReview = runPipeline(["review", "--config", fixture.configPath, "--json"]);
    expect(selectedReview.status).toBe(0);
    const selectedData = JSON.parse(await readFile(JSON.parse(selectedReview.stdout).review_data_path, "utf8"));
    expect(selectedData.composition).toMatchObject({
      status: "ready",
      selected_proposal_id: "highlight-v1",
      edl_digest: expect.stringMatching(/^[a-f0-9]{64}$/)
    });

    const approved = runPipeline([
      "gate", "--config", fixture.configPath, "--actor", "coordinator",
      "--gate", "gate-1", "--decision", "approved", "--json"
    ]);
    expect(approved.status).toBe(0);
    await expect(stat(fixture.edlPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.assembledManifestPath)).rejects.toMatchObject({ code: "ENOENT" });

    const run = runPipeline([
      "run", "--config", fixture.configPath, "--actor", "coordinator", "--json"
    ]);
    expect(run.status).toBe(0);
    const runPayload = JSON.parse(run.stdout);
    expect(runPayload.edl_path).toBe(fixture.edlPath);
    const edl = JSON.parse(await readFile(fixture.edlPath, "utf8"));
    const assembled = JSON.parse(await readFile(fixture.assembledManifestPath, "utf8"));
    expect(edl.proposal_id).toBe("highlight-v1");
    expect(edl.output_manifest_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(assembled.clips.map((clip: { source_clip_id: string }) => clip.source_clip_id))
      .toEqual(edl.segments.map((segment: { source_clip_id: string }) => segment.source_clip_id));

    const gate2Approved = runPipeline([
      "gate", "--config", fixture.configPath, "--actor", "coordinator",
      "--gate", "gate-2", "--decision", "approve_all", "--json"
    ]);
    expect(gate2Approved.status).toBe(0);
    expect(JSON.parse(gate2Approved.stdout).state.gates.gate_2.approved_input_digest)
      .toMatch(/^[a-f0-9]{64}$/);

    const rendered = runPipeline([
      "render", "--config", fixture.configPath, "--actor", "coordinator", "--json"
    ]);
    expect(rendered.status).toBe(0);
    const renderedPayload = JSON.parse(rendered.stdout);
    expect(renderedPayload.state.status).toBe("awaiting_gate_3");
    await expect(stat(renderedPayload.output_path)).resolves.toMatchObject({ size: expect.any(Number) });
    const renderReport = JSON.parse(await readFile(renderedPayload.report_path, "utf8"));
    expect(renderReport.duration_seconds).toBeGreaterThan(0);
    await expect(stat(renderedPayload.gate3_qc_report_path))
      .resolves.toMatchObject({ size: expect.any(Number) });

    const gate3Approved = runPipeline([
      "gate", "--config", fixture.configPath, "--actor", "coordinator",
      "--gate", "gate-3", "--decision", "approve", "--json"
    ]);
    expect(gate3Approved.status).toBe(0);
    expect(JSON.parse(gate3Approved.stdout).state.status).toBe("completed");

    expect(await readFile(fixture.manifestPath, "utf8")).toBe(manifestBefore);
    for (const [index, path] of fixture.sourcePaths.entries()) {
      expect(await readFile(path)).toEqual(sourceBefore[index]);
    }
  }, 60_000);

  it("rejects a changed brief after Gate 1 without materializing composition outputs", async () => {
    const fixture = await createCompositionProject();
    expect(runPipeline([
      "analyze", "--config", fixture.configPath, "--actor", "coordinator", "--json"
    ]).status).toBe(0);
    expect(runPipeline([
      "compose", "--config", fixture.configPath, "--actor", "coordinator", "--json"
    ]).status).toBe(0);
    await writeProject(fixture.configPath, "highlight-v1");
    expect(runPipeline(["review", "--config", fixture.configPath, "--json"]).status).toBe(0);
    expect(runPipeline([
      "gate", "--config", fixture.configPath, "--actor", "coordinator",
      "--gate", "gate-1", "--decision", "approved", "--json"
    ]).status).toBe(0);

    await writeProject(fixture.configPath, "highlight-v1", "Changed goal");
    const stale = runPipeline([
      "run", "--config", fixture.configPath, "--actor", "coordinator", "--json"
    ]);
    expect(stale.status).toBe(1);
    expect(JSON.parse(stale.stderr).issues.map((issue: { code: string }) => issue.code))
      .toEqual(expect.arrayContaining(["gate.analysis_changed"]));
    await expect(stat(fixture.edlPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.assembledManifestPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("rejects review when source bytes change after proposals are composed", async () => {
    const fixture = await createCompositionProject();
    expect(runPipeline([
      "analyze", "--config", fixture.configPath, "--actor", "coordinator", "--json"
    ]).status).toBe(0);
    expect(runPipeline([
      "compose", "--config", fixture.configPath, "--actor", "coordinator", "--json"
    ]).status).toBe(0);

    await writeFile(fixture.sourcePaths[0], "changed after compose");
    await writeProject(fixture.configPath, "highlight-v1");
    const staleReview = runPipeline(["review", "--config", fixture.configPath, "--json"]);
    expect(staleReview.status).toBe(0);
    const staleReviewData = JSON.parse(
      await readFile(JSON.parse(staleReview.stdout).review_data_path, "utf8")
    );
    expect(staleReviewData.composition.status).toBe("missing");
    const staleGate = runPipeline([
      "gate", "--config", fixture.configPath, "--actor", "coordinator",
      "--gate", "gate-1", "--decision", "approved", "--json"
    ]);
    expect(staleGate.status).toBe(1);
    expect(JSON.parse(staleGate.stderr).issues[0].code).toBe("gate.composition_stale");
    await expect(stat(fixture.edlPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.assembledManifestPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);
});

async function createCompositionProject() {
  const root = await mkdtemp(join(tmpdir(), "tsugite-composition-cli-"));
  const configPath = join(root, "project.yaml");
  const manifestPath = join(root, "manifest.json");
  const sourcePaths = ["a.mp4", "b.mp4", "c.mp4"].map((name) => join(root, name));
  for (const path of sourcePaths) {
    await copyFile(resolve("fixtures/media/render-001.mp4"), path);
  }
  await writeFile(manifestPath, `${JSON.stringify({
    meta: { aspect: "16:9", fps: 30, target_duration_seconds: 2, slug: "composition-cli" },
    clips: sourcePaths.map((path, index) => ({
      id: `clip-${String.fromCharCode(97 + index)}`,
      src: path.split("/").at(-1),
      in: 0,
      out: 1,
      duration: 1,
      fps: 30,
      resolution: { width: 320, height: 180 },
      audio: false
    })),
    audio: { bgm: [], narration: [], sfx: [] },
    captions: [],
    chapters: [],
    provenance: []
  }, null, 2)}\n`);
  await writeProject(configPath);
  const runDir = join(root, "dist", "composition-cli-run");
  return {
    root,
    configPath,
    manifestPath,
    sourcePaths,
    edlPath: join(runDir, "composition-edl.json"),
    assembledManifestPath: join(runDir, "manifest.json")
  };
}

async function writeProject(configPath: string, proposalId?: string, goal = "Introduce the activity") {
  await writeFile(
    configPath,
    `slug: composition-cli
run_id: composition-cli-run
manifest: manifest.json
dist_dir: dist
edit:
  backend: remotion
${proposalId ? `  composition:\n    proposal_id: ${proposalId}\n` : ""}analysis:
  adapter: local-media-analysis
  requests:
    - { id: scenes-a, output: scene_observations, source_clip_id: clip-a }
    - { id: scenes-b, output: scene_observations, source_clip_id: clip-b }
    - { id: scenes-c, output: scene_observations, source_clip_id: clip-c }
composition:
  brief:
    goal: "${goal}"
    audience: "First-time visitors"
    target_duration_seconds: 2
    priority: highlight
    required_clip_ids: [clip-a]
    excluded_clip_ids: [clip-c]
  proposals:
    max_count: 3
`
  );
}

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
