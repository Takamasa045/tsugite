import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("pipeline review", () => {
  it("generates a Gate 1 review without coordinator approval or state mutation", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "tsugite-review-cli-"));
    const result = await capture([
      "review",
      "--config",
      "fixtures/projects/dialogue-remotion.yaml",
      "--output",
      outputDir,
      "--json"
    ]);

    const payload = JSON.parse(result.stdout);
    expect(result.status).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      command: "review",
      gate: "gate-1",
      gate_state: "unchanged",
      opened: false
    });
    expect(await readFile(payload.review_path, "utf8")).toContain("Gate 1");
    expect(JSON.parse(await readFile(payload.review_data_path, "utf8")).storyboard).toHaveLength(2);
    await expect(stat(join(outputDir, "state.json"))).rejects.toThrow();
  });

  it("accepts --open only for review", async () => {
    const result = await capture([
      "plan",
      "--config",
      "fixtures/projects/local-valid.yaml",
      "--open",
      "--json"
    ]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).issues[0].code).toBe("cli.option_unsupported");
  });
});
