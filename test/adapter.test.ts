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

  it("rejects analysis adapters in generation slots", async () => {
    const { validateProject } = await import("../src/project/validateProject.js");
    const result = await validateProject("fixtures/projects/generation-analysis-adapter.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("adapter.class_mismatch");
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
