import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

async function capture(args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const status = await main(args);
    return {
      status,
      stdout: log.mock.calls.map((call) => String(call[0])).join("\n"),
      stderr: error.mock.calls.map((call) => String(call[0])).join("\n")
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

describe("shipped template library", () => {
  it("copies the documented local starter and keeps validation, planning, and dry-run local", async () => {
    const templatePath = join(process.cwd(), "templates", "local-video-two-cut", "template.yaml");
    const readmePath = join(process.cwd(), "templates", "local-video-two-cut", "README.md");
    const [metadataText, readme] = await Promise.all([readFile(templatePath, "utf8"), readFile(readmePath, "utf8")]);
    const metadata = parse(metadataText) as {
      id?: string;
      distribution?: string;
      starter?: { source?: string };
    };
    const root = await mkdtemp(join(tmpdir(), "tsugite-template-library-"));
    const projectDir = join(root, "my-two-cut");

    try {
      expect(metadata).toMatchObject({
        id: "local-video-two-cut",
        distribution: "bundled",
        starter: { source: "examples/local-fixture" }
      });
      expect(readme).toContain("cp -R examples/local-fixture projects/my-two-cut");
      await cp(join(process.cwd(), metadata.starter!.source!), projectDir, { recursive: true });
      const config = join(projectDir, "project.yaml");

      const validate = await capture(["validate", "--config", config, "--json"]);
      const plan = await capture(["plan", "--config", config, "--json"]);
      const dryRun = await capture(["run", "--config", config, "--dry-run", "--json"]);

      expect(validate.status).toBe(0);
      expect(JSON.parse(validate.stdout)).toMatchObject({ ok: true, command: "validate", issues: [] });
      expect(plan.status).toBe(0);
      expect(JSON.parse(plan.stdout)).toMatchObject({ ok: true, command: "plan", plan: { estimated_credits: 0 } });
      expect(dryRun.status).toBe(0);
      expect(JSON.parse(dryRun.stdout)).toMatchObject({
        ok: true,
        command: "run",
        dry_run: { executed: false, estimated_credits: 0, external_commands: [] }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
