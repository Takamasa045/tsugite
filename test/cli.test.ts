import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runPipeline(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

describe("pipeline CLI", () => {
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
});
