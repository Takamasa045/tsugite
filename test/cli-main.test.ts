import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

async function capture(args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

  const status = await main(args);
  const stdout = log.mock.calls.map((call) => String(call[0])).join("\n");
  const stderr = error.mock.calls.map((call) => String(call[0])).join("\n");

  log.mockRestore();
  error.mockRestore();

  return { status, stdout, stderr };
}

describe("pipeline main", () => {
  it("reports doctor checks", async () => {
    const result = await capture(["doctor", "--json"]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).command).toBe("doctor");
  });

  it("requires a command and config where appropriate", async () => {
    const noCommand = await capture([]);
    const noConfig = await capture(["validate", "--json"]);

    expect(noCommand.status).toBe(1);
    expect(noConfig.status).toBe(1);
    expect(JSON.parse(noConfig.stderr).issues[0].code).toBe("cli.config_missing");
  });

  it("returns plan output", async () => {
    const result = await capture(["plan", "--config", "fixtures/projects/local-valid.yaml", "--json"]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).plan.steps[1].name).toBe("gate-1");
  });

  it("blocks non-dry-run execution in Phase 0", async () => {
    const result = await capture(["run", "--config", "fixtures/projects/local-valid.yaml", "--json"]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).issues[0].code).toBe("run.requires_explicit_gate");
  });

  it("reports render and unknown command as explicit errors", async () => {
    const render = await capture(["render", "--config", "fixtures/projects/local-valid.yaml", "--json"]);
    const unknown = await capture(["missing", "--config", "fixtures/projects/local-valid.yaml", "--json"]);

    expect(render.status).toBe(1);
    expect(unknown.status).toBe(1);
    expect(JSON.parse(render.stderr).issues[0].code).toBe("render.not_implemented");
    expect(JSON.parse(unknown.stderr).issues[0].code).toBe("cli.command_unknown");
  });
});
