import { describe, expect, it } from "vitest";
import { createDryRun, createPlan } from "../src/orchestrator/plan.js";
import { validateProject } from "../src/project/validateProject.js";
import { loadAdapterDefinition } from "../src/adapters/registry.js";

describe("plan and dry run", () => {
  it("creates deterministic plan output", async () => {
    const validation = await validateProject("fixtures/projects/local-valid.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    expect(validation.ok).toBe(true);

    const plan = createPlan(validation.project!, validation.manifest!);

    expect(plan.run_id).toBe("local-fixture-run");
    expect(plan.total_clip_duration_seconds).toBe(6);
    expect(plan.steps.map((step) => step.name)).toEqual([
      "validate",
      "gate-1",
      "assemble-manifest",
      "gate-2",
      "render",
      "gate-3"
    ]);
  });

  it("creates dry-run output without execution", async () => {
    const validation = await validateProject("fixtures/projects/local-valid.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const dryRun = createDryRun(validation.project!, validation.manifest!);

    expect(dryRun.executed).toBe(false);
    expect(dryRun.estimated_credits).toBe(0);
  });

  it("plans local media projects without generation requests", async () => {
    const validation = await validateProject("fixtures/projects/local-media-only.yaml");
    const dryRun = createDryRun(validation.project!, validation.manifest!);

    expect(dryRun.executed).toBe(false);
    expect(dryRun.estimated_credits).toBe(0);
    expect(dryRun.external_commands).toEqual([]);
  });

  it("includes backend render preflight checks in dry-run output", async () => {
    const validation = await validateProject("fixtures/projects/hyperframes-local-media.yaml");
    const dryRun = createDryRun(validation.project!, validation.manifest!, undefined, validation.backend);

    expect(validation.ok).toBe(true);
    expect(dryRun.external_commands).toEqual([
      {
        phase: "render_preflight",
        backend: "hyperframes",
        name: "lint",
        command: ["npx", "hyperframes", "lint", "--json"]
      }
    ]);
  });

  it("uses adapter credit estimate in plan output", async () => {
    const validation = await validateProject("fixtures/projects/local-valid.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const adapter = await loadAdapterDefinition("mock-cli", ["fixtures/adapters", "adapters"]);
    const project = {
      ...validation.project!,
      generation: {
        adapter: "mock-cli",
        requests: validation.project!.generation!.requests
      }
    };

    const plan = createPlan(project, validation.manifest!, adapter);

    expect(plan.estimated_credits).toBe(2.5);
  });
});
