import { describe, expect, it } from "vitest";
import { loadAdapterDefinition } from "../src/adapters/registry.js";
import { validateGenerationConstraints } from "../src/adapters/constraints.js";
import { loadProject } from "../src/project/loadProject.js";

describe("adapter contract", () => {
  it("loads a declared cli adapter contract", async () => {
    const adapter = await loadAdapterDefinition("mock-cli", ["fixtures/adapters", "adapters"]);

    expect(adapter.kind).toBe("cli");
    expect(adapter.class).toBe("generation");
    expect(adapter.dry_run_estimate).toBe(true);
    expect(adapter.retry.max_attempts).toBe(2);
  });

  it("loads real cli generation adapters with command wrappers", async () => {
    const pixverse = await loadAdapterDefinition("pixverse", ["fixtures/adapters", "adapters"]);
    const kling = await loadAdapterDefinition("kling", ["fixtures/adapters", "adapters"]);

    expect(pixverse.command).toMatchObject({
      executable: "node",
      args: ["adapters/pixverse/generate.mjs"],
      input: "stdin-json"
    });
    expect(kling.command).toMatchObject({
      executable: "node",
      args: ["adapters/kling/generate.mjs"],
      input: "stdin-json"
    });
  });

  it("loads the Topview generation handoff adapter", async () => {
    const adapter = await loadAdapterDefinition("topview", ["fixtures/adapters", "adapters"]);

    expect(adapter.kind).toBe("mcp-agent");
    expect(adapter.class).toBe("generation");
    expect(adapter.dry_run_estimate).toBe(true);
  });

  it("loads a declared analysis adapter contract", async () => {
    const adapter = await loadAdapterDefinition("analysis-metadata", ["fixtures/adapters", "adapters"]);

    expect(adapter.kind).toBe("mcp-agent");
    expect(adapter.class).toBe("analysis");
    expect(adapter.dry_run_estimate).toBe(false);
  });

  it("applies adapter constraints before run", async () => {
    const project = await loadProject("fixtures/projects/local-valid.yaml");
    const result = await validateGenerationConstraints(project, ["fixtures/adapters", "adapters"]);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);

    const generation = project.generation!;
    const badProject = {
      ...project,
      generation: {
        adapter: generation.adapter,
        requests: [{ ...generation.requests[0], duration: 7 }]
      }
    };
    const badResult = await validateGenerationConstraints(badProject, ["fixtures/adapters", "adapters"]);

    expect(badResult.ok).toBe(false);
    expect(badResult.issues[0]?.code).toBe("adapter.constraint.duration-supported");
  });

  it("applies multiple adapter constraints and skips optional missing fields", async () => {
    const project = await loadProject("fixtures/projects/local-valid.yaml");
    const generation = project.generation!;
    const validWithoutSeed = {
      ...project,
      generation: {
        adapter: "kling",
        requests: [
          {
            ...generation.requests[0],
            duration: 5,
            aspect: "16:9" as const,
            seed: undefined
          }
        ]
      }
    };
    const invalid = {
      ...project,
      generation: {
        adapter: "kling",
        requests: [
          {
            ...generation.requests[0],
            duration: 4,
            aspect: "1:1",
            seed: -1
          }
        ]
      }
    };

    const validResult = await validateGenerationConstraints(validWithoutSeed, ["fixtures/adapters", "adapters"]);
    const invalidResult = await validateGenerationConstraints(invalid as typeof project, ["fixtures/adapters", "adapters"]);

    expect(validResult.ok).toBe(true);
    expect(invalidResult.ok).toBe(false);
    expect(invalidResult.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "adapter.constraint.duration-supported",
        "adapter.constraint.aspect-supported",
        "adapter.constraint.seed-min"
      ])
    );
  });

  it("rejects analysis adapters in generation slots", async () => {
    const { validateProject } = await import("../src/project/validateProject.js");
    const result = await validateProject("fixtures/projects/generation-analysis-adapter.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("adapter.class_mismatch");
  });

  it("accepts analysis adapters in analysis slots", async () => {
    const { validateProject } = await import("../src/project/validateProject.js");
    const result = await validateProject("fixtures/projects/analysis-metadata.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });

    expect(result.ok).toBe(true);
    expect(result.analysisAdapter?.kind).toBe("mcp-agent");
    expect(result.analysisAdapter?.class).toBe("analysis");
  });

  it("requires mcp-agent adapters to include a skill definition", async () => {
    await expect(loadAdapterDefinition("no-skill-agent", ["fixtures/adapters", "adapters"])).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "adapter.skill_md_missing"
        })
      ])
    });
  });

  it("rejects adapters that cannot provide dry-run estimates", async () => {
    const { validateProject } = await import("../src/project/validateProject.js");
    const result = await validateProject("fixtures/projects/no-dry-adapter.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("adapter.dry_run_unsupported");
  });
});
