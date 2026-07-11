import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runPipeline(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

describe("pipeline CLI", () => {
  it("lists read-only prompt guide catalogs without a project config", () => {
    const result = runPipeline(["guides", "--json"]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.scope).toBe("prompt-guidance-only");
    expect(parsed.catalogs.map((catalog: { catalog_id: string }) => catalog.catalog_id)).toEqual(
      expect.arrayContaining(["pixverse", "kling", "seedance"])
    );
  });

  it("resolves model and input-mode guidance without claiming execution support", () => {
    const result = runPipeline([
      "guides",
      "--catalog",
      "seedance",
      "--model",
      "seedance-2.0",
      "--input-mode",
      "image-to-video",
      "--json"
    ]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.scope).toBe("prompt-guidance-only");
    expect(parsed.execution_capability).toBe("not-evaluated");
    expect(parsed.guidance).toMatchObject({
      status: "matched",
      catalog_id: "seedance",
      model_profile: "seedance-2.0",
      input_mode: "image-to-video"
    });
  });

  it.each([
    [["guides", "--model", "seedance-2.0", "--input-mode", "image-to-video", "--json"], "prompt_guide.catalog_required"],
    [["guides", "--catalog", "seedance", "--model", "seedance-2.0", "--json"], "prompt_guide.filter_incomplete"],
    [["guides", "--catalog", "seedance", "--model", "seedance-2.0", "--input-mode", "invalid", "--json"], "prompt_guide.input_mode"]
  ])("rejects incomplete or invalid guide filters", (args, code) => {
    const result = runPipeline(args);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).issues[0].code).toBe(code);
  });

  it("returns machine-readable validate output", () => {
    const result = runPipeline(["validate", "--config", "fixtures/projects/local-valid.yaml", "--json"]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("validate");
  });

  it("returns dry-run output without external execution", () => {
    const result = runPipeline(["run", "--config", "fixtures/projects/local-valid.yaml", "--dry-run", "--json"]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.dry_run.executed).toBe(false);
  });

  it("surfaces backend preflight commands in dry-run output", () => {
    const result = runPipeline([
      "run",
      "--config",
      "fixtures/projects/hyperframes-local-media.yaml",
      "--dry-run",
      "--json"
    ]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.dry_run.external_commands[0]).toEqual({
      phase: "render_preflight",
      backend: "hyperframes",
      name: "lint",
      command: ["npx", "--no-install", "hyperframes", "lint", "--json"]
    });
  });
});
