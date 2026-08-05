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
    const html = await readFile(payload.review_path, "utf8");
    expect(html).toContain("Gate 1");
    expect(html).toContain("React / Remotion");
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

  it("preserves validate/plan prompt_guide_hash in review-data.json lineage", async () => {
    const config = "examples/h3-prompt-director/project.yaml";
    const outputDir = await mkdtemp(join(tmpdir(), "tsugite-h3-review-hash-"));

    const validate = await capture(["validate", "--config", config, "--json"]);
    expect(validate.status).toBe(0);
    const validatePayload = JSON.parse(validate.stdout);
    const expectedHash = validatePayload.h3_compilations?.[0]?.lineage?.prompt_guide_hash;
    expect(expectedHash).toMatch(/^[a-f0-9]{64}$/);

    const plan = await capture(["plan", "--config", config, "--json"]);
    expect(plan.status).toBe(0);
    const planPayload = JSON.parse(plan.stdout);
    expect(planPayload.plan.h3_compilations[0].lineage.prompt_guide_hash).toBe(expectedHash);

    const review = await capture([
      "review",
      "--config",
      config,
      "--output",
      outputDir,
      "--json"
    ]);
    expect(review.status).toBe(0);
    const reviewPayload = JSON.parse(review.stdout);
    const reviewData = JSON.parse(await readFile(reviewPayload.review_data_path, "utf8"));
    expect(reviewData.h3_compilations).toHaveLength(1);
    expect(reviewData.h3_compilations[0].lineage.prompt_guide_identity).toBe("pixverse/minimax-h3");
    expect(reviewData.h3_compilations[0].lineage.prompt_guide_hash).toBe(expectedHash);
  });
});
