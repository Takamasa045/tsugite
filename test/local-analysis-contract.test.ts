import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { inspectEnvironment } from "../src/doctor.js";
import { createDryRun } from "../src/orchestrator/plan.js";
import { validateProject } from "../src/project/validateProject.js";

describe("local media analysis distribution contract", () => {
  it("validates as an offline CLI analysis handoff without changing backend selection", async () => {
    const validation = await validateProject("fixtures/projects/local-media-analysis.yaml");

    expect(validation.ok).toBe(true);
    expect(validation.analysisAdapter).toMatchObject({
      name: "local-media-analysis",
      kind: "cli",
      class: "analysis",
      offline: true,
      outputs: ["cut_points", "scene_observations"]
    });
    expect(validation.project?.edit.backend).toBe("remotion");

    const dryRun = createDryRun(
      validation.project!,
      validation.manifest!,
      validation.adapter,
      validation.analysisAdapter,
      validation.backend,
      validation.promptGuides
    );
    expect(dryRun.agent_handoffs).toContainEqual(
      expect.objectContaining({
        phase: "analysis",
        adapter: "local-media-analysis",
        execution: "pipeline-cli",
        outputs: ["cut_points"]
      })
    );
  });

  it("makes ffmpeg readiness machine-checkable without API credentials", async () => {
    const probedCommands: string[][] = [];
    const report = await inspectEnvironment("fixtures/projects/local-media-analysis.yaml", {
      nodeVersion: "v22.17.0",
      commandExists: async () => true,
      probeCommand: async (command) => {
        probedCommands.push(command);
        return { ok: true, version: "test" };
      },
      environment: {}
    });

    expect(report.ok).toBe(true);
    expect(probedCommands).toContainEqual(["ffmpeg", "-version"]);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "tool:ffmpeg-analysis (local-media-analysis)", status: "ready" })
    );
    expect(report.checks.some((check) => check.name.includes("auth"))).toBe(false);
  });

  it("rejects an unknown source clip before analysis starts", async () => {
    const validation = await validateProject("fixtures/projects/local-media-analysis-bad-source.yaml");

    expect(validation.ok).toBe(false);
    expect(validation.issues).toContainEqual(
      expect.objectContaining({ code: "analysis.source_clip_not_found" })
    );
  });

  it("rejects unsupported output types and ambiguous source clip ids before analysis", async () => {
    const unsupported = await validateProject("fixtures/projects/local-media-analysis-unsupported-output.yaml");
    const duplicate = await validateProject("fixtures/projects/local-media-analysis-duplicate-source.yaml");

    expect(unsupported.ok).toBe(false);
    expect(unsupported.issues).toContainEqual(expect.objectContaining({ code: "analysis.output_unsupported" }));
    expect(duplicate.ok).toBe(false);
    expect(duplicate.issues).toContainEqual(expect.objectContaining({ code: "analysis.source_clip_ambiguous" }));
  });

  it("keeps the shipped analyzer free of HTTP clients and provider keys", async () => {
    const source = await readFile("adapters/local-media-analysis/analyze.mjs", "utf8");

    expect(source).not.toMatch(/https?:\/\//i);
    expect(source).not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY|ELEVENLABS_API_KEY/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).toMatch(/"-protocol_whitelist",\s*"file,pipe"/);
  });
});
