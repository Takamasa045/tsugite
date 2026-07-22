import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runPipeline(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

describe("pipeline CLI", () => {
  it("shows concise human help without requiring a project config", () => {
    const result = runPipeline(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node bin/pipeline <command> [options]");
    expect(result.stdout).toContain("validate");
    expect(result.stdout).toContain("run");
    expect(result.stdout).toContain("Human approval");
  });

  it("returns machine-readable command catalog help", () => {
    const result = runPipeline(["help", "--json"]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      ok: true,
      command: "help",
      usage: "node bin/pipeline <command> [options]"
    });
    expect(parsed.commands).toContainEqual(expect.objectContaining({
      name: "validate",
      requires_config: true,
      safety: "read-only"
    }));
    expect(parsed.commands).toContainEqual(expect.objectContaining({
      name: "run",
      requires_config: true,
      safety: "approval-gated"
    }));
  });

  it.each([
    ["help subcommand", ["help", "validate", "--json"]],
    ["command help option", ["validate", "--help", "--json"]],
    ["command options before help", ["validate", "--config", "project.yaml", "--help", "--json"]]
  ])("shows command-specific help through %s", (_label, args) => {
    const result = runPipeline(args);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "help",
      topic: "validate",
      command_help: {
        name: "validate",
        usage: "node bin/pipeline validate --config <project.yaml> [--json]",
        requires_config: true,
        options: expect.arrayContaining([
          expect.objectContaining({ name: "--config", value: "<project.yaml>" })
        ])
      }
    });
  });

  it("reports an unknown command before config validation and suggests the closest command", () => {
    const result = runPipeline(["validte", "--bogus", "--json"]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      command: "validte",
      issues: [{ code: "cli.command_unknown" }],
      suggested_commands: ["validate"],
      next_actions: [
        "node bin/pipeline help validate",
        "node bin/pipeline --help"
      ]
    });
  });

  it.each([
    [
      ["help", "validate", "extra", "--json"],
      { code: "cli.help_argument_extra", path: "extra" }
    ],
    [
      ["help", "--config", "fixtures/projects/local-valid.yaml", "--json"],
      { code: "cli.help_option_unsupported", path: "--config" }
    ]
  ])("rejects unsupported help arguments instead of silently ignoring them", (args, issue) => {
    const result = runPipeline(args);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      command: "help",
      issues: [issue]
    });
  });

  it("streams the complete expanded story catalog before exiting", () => {
    const result = runPipeline(["story-guides", "--json"]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.catalog.frameworks.length).toBeGreaterThanOrEqual(30);
    expect(parsed.catalog.principles.length).toBeGreaterThanOrEqual(30);
  });

  it("recommends story frameworks without claiming execution support", () => {
    const result = runPipeline([
      "story-guides",
      "--request",
      "30秒の縦型SNS広告。講座の価値と実績を見せて申込みにつなげたい",
      "--duration",
      "30",
      "--json"
    ]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.scope).toBe("creative-guidance-only");
    expect(parsed.execution_capability).toBe("not-evaluated");
    expect(parsed.recommendation).toMatchObject({
      primary: { id: "hook-value-proof-cta" },
      duration_seconds: 30
    });
  });

  it("rejects invalid story guide duration", () => {
    const result = runPipeline([
      "story-guides",
      "--request",
      "商品紹介",
      "--duration",
      "zero",
      "--json"
    ]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).issues[0].code).toBe("story_guide.duration");
  });

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

  it("exposes the HyperFrames audio handoff in dry-run without generating audio", () => {
    const result = runPipeline([
      "run",
      "--config",
      "fixtures/projects/hyperframes-audio.yaml",
      "--dry-run",
      "--json"
    ]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.dry_run.executed).toBe(false);
    expect(parsed.dry_run.agent_handoffs).toContainEqual(
      expect.objectContaining({
        phase: "audio",
        adapter: "hyperframes-media",
        outputs: ["bgm:main-bgm", "sfx:opening-whoosh"],
        execution: "pipeline-cli"
      })
    );
    expect(parsed.dry_run.plan.audio).toMatchObject({
      automatic_fallback: false,
      external_permission_required: true,
      transfer: {
        input_scope: "request-metadata",
        credential_env: [],
        optional_credential_env: ["HEYGEN_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]
      }
    });
    expect(parsed.dry_run.plan.audio.transfer.optional_credential_env).not.toContain("ELEVENLABS_API_KEY");
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
