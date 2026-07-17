import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAdapterDefinition } from "../src/adapters/registry.js";
import { analyzeProject } from "../src/orchestrator/analyze.js";
import { validateProject } from "../src/project/validateProject.js";

describe("analysis orchestrator", () => {
  it("writes a backend-neutral offline artifact and local agent handoff", async () => {
    const validation = await validateProject("fixtures/projects/local-media-analysis.yaml");
    const adapter = await loadAdapterDefinition("mock-cli-analysis", ["fixtures/adapters", "adapters"]);
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-analysis-orchestrator-"));

    const result = await analyzeProject(
      "fixtures/projects/local-media-analysis.yaml",
      validation.project!,
      validation.manifest!,
      adapter,
      stateDir
    );

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ actualCredits: 0, apiUsed: false, networkUsed: false, resultCount: 1 });
    const artifact = JSON.parse(await readFile(result.analysisPath!, "utf8"));
    expect(artifact.input_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.results[0].source).toMatchObject({ clip_id: "render-001" });
    const proposal = JSON.parse(await readFile(result.proposalPath!, "utf8"));
    expect(proposal).toMatchObject({
      status: "proposed",
      analysis_input_digest: artifact.input_digest,
      outputs: { cut_points: [expect.objectContaining({ action: "review" })] }
    });
    expect(proposal.raw_analysis_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(proposal.proposal_digest).toMatch(/^[a-f0-9]{64}$/);
    const handoff = await readFile(result.handoffPath!, "utf8");
    expect(handoff).toContain("editorial-proposal.json");
    expect(handoff).toContain("selected editing backend");
    expect(handoff).toContain("Gate 1");
  });

  it("fails closed when analysis is not configured", async () => {
    const validation = await validateProject("fixtures/projects/local-media-only.yaml");

    const result = await analyzeProject(
      "fixtures/projects/local-media-only.yaml",
      validation.project!,
      validation.manifest!,
      undefined
    );

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("analysis.not_configured");
  });

  it("routes request groups through multiple selected local adapters", async () => {
    const validation = await validateProject("fixtures/projects/multi-analysis-adapters.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-multi-analysis-"));

    const result = await analyzeProject(
      "fixtures/projects/multi-analysis-adapters.yaml",
      validation.project!,
      validation.manifest!,
      validation.analysisAdapters,
      stateDir
    );

    expect(result.ok).toBe(true);
    const artifact = JSON.parse(await readFile(result.analysisPath!, "utf8"));
    expect(artifact.adapters).toEqual(["mock-cli-transcription", "mock-cli-analysis"]);
    expect(artifact.results.map((entry: { request_id: string; adapter: string }) => [entry.request_id, entry.adapter])).toEqual([
      ["transcript", "mock-cli-transcription"],
      ["silence", "mock-cli-analysis"],
      ["chapters", "mock-cli-transcription"]
    ]);
  });
});
