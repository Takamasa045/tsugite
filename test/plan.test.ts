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
    const dryRun = createDryRun(validation.project!, validation.manifest!, undefined, undefined, validation.backend);

    expect(validation.ok).toBe(true);
    expect(dryRun.external_commands).toEqual([
      {
        phase: "render_preflight",
        backend: "hyperframes",
        name: "lint",
        command: ["npx", "--no-install", "hyperframes", "lint", "--json"]
      }
    ]);
  });

  it("surfaces mcp-agent analysis handoffs in plan and dry-run output", async () => {
    const validation = await validateProject("fixtures/projects/analysis-metadata.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const dryRun = createDryRun(
      validation.project!,
      validation.manifest!,
      validation.adapter,
      validation.analysisAdapter,
      validation.backend
    );

    expect(validation.ok).toBe(true);
    expect(dryRun.plan.steps.map((step) => step.name)).toContain("analysis-handoff");
    expect(dryRun.agent_handoffs).toEqual([
      {
        phase: "analysis",
        adapter: "analysis-metadata",
        kind: "mcp-agent",
        class: "analysis",
        outputs: ["captions"],
        dry_run_estimate_available: false,
        batch: false,
        execution: "agent-handoff"
      }
    ]);
  });

  it("surfaces Topview generation handoffs without executing external work", async () => {
    const validation = await validateProject("fixtures/projects/topview-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const dryRun = createDryRun(
      validation.project!,
      validation.manifest!,
      validation.adapter,
      validation.analysisAdapter,
      validation.backend
    );

    expect(validation.ok).toBe(true);
    expect(dryRun.executed).toBe(false);
    expect(dryRun.estimated_credits).toBe(2);
    expect(dryRun.agent_handoffs).toEqual([
      {
        phase: "generation",
        adapter: "topview",
        kind: "mcp-agent",
        class: "generation",
        outputs: ["topview-001"],
        dry_run_estimate_available: true,
        batch: false,
        execution: "agent-handoff"
      }
    ]);
  });

  it("surfaces optional OpenClaw generation as a pipeline-cli adapter", async () => {
    const validation = await validateProject("fixtures/projects/openclaw-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const dryRun = createDryRun(
      validation.project!,
      validation.manifest!,
      validation.adapter,
      validation.analysisAdapter,
      validation.backend
    );

    expect(validation.ok).toBe(true);
    expect(dryRun.executed).toBe(false);
    expect(dryRun.estimated_credits).toBe(2);
    expect(dryRun.agent_handoffs).toEqual([
      {
        phase: "generation",
        adapter: "openclaw",
        kind: "cli",
        class: "generation",
        outputs: ["openclaw-001"],
        dry_run_estimate_available: true,
        batch: false,
        execution: "pipeline-cli"
      }
    ]);
  });

  it("surfaces optional Hermes analysis as an agent handoff", async () => {
    const validation = await validateProject("fixtures/projects/hermes-analysis.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const dryRun = createDryRun(
      validation.project!,
      validation.manifest!,
      validation.adapter,
      validation.analysisAdapter,
      validation.backend
    );

    expect(validation.ok).toBe(true);
    expect(dryRun.agent_handoffs).toEqual([
      {
        phase: "analysis",
        adapter: "hermes",
        kind: "mcp-agent",
        class: "analysis",
        outputs: ["captions"],
        dry_run_estimate_available: false,
        batch: false,
        execution: "agent-handoff"
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
