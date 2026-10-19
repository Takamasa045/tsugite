import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { formatHuman, softenIssueMessage } from "../src/cli/formatHuman.js";

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

describe("CLI human output", () => {
  it("keeps --json as pretty-printed JSON for validate, plan, and review", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-cli-format-"));
    await cp(resolve("examples/storyboard-local"), join(root, "work"), { recursive: true });
    const previousHome = process.env.TSUGITE_PROJECTS_HOME;
    process.env.TSUGITE_PROJECTS_HOME = join(root, "projects");
    const config = join(root, "work", "project.yaml");

    try {
      for (const command of ["validate", "plan", "review"] as const) {
        const jsonResult = await capture([command, "--config", config, "--json"]);
        const humanResult = await capture([command, "--config", config]);
        expect(jsonResult.status).toBe(0);
        const payload = JSON.parse(jsonResult.stdout);
        expect(payload.ok).toBe(true);
        expect(payload.command).toBe(command);
        expect(humanResult.stdout).toContain("✓");
        expect(humanResult.stdout).not.toMatch(/^\s*\{/);
      }
    } finally {
      if (previousHome === undefined) delete process.env.TSUGITE_PROJECTS_HOME;
      else process.env.TSUGITE_PROJECTS_HOME = previousHome;
    }
  });

  it("summarizes validate / plan / review without --json", () => {
    expect(formatHuman({
      ok: true,
      command: "validate",
      issues: [],
      launcher_visible: true,
      launcher_project_root: "/tmp/sample"
    })).toContain("✓ 検証（validate）: 問題なし");

    expect(formatHuman({
      ok: true,
      command: "plan",
      plan: { run_id: "demo-run", estimated_credits: 0, total_clip_duration_seconds: 2 }
    })).toContain("予想される生成費用: 0");

    expect(formatHuman({
      ok: true,
      command: "review",
      review_path: "/tmp/review/index.html",
      gate_state: "unchanged"
    })).toContain("承認状態は変えていません。");
  });

  it("wraps common errors in plain Japanese", () => {
    expect(softenIssueMessage("ENOENT: no such file or directory", "project.load")).toBe(
      "ファイルが見つかりません。パスを確認してください。"
    );
    expect(softenIssueMessage("Invalid input", "manifest.schema")).toBe(
      "入力の形が正しくありません。設定の書き方を確認してください。"
    );
    expect(formatHuman({
      ok: false,
      command: "validate",
      issues: [{ code: "project.load", message: "ENOENT: no such file or directory" }]
    })).toContain("ファイルが見つかりません");
  });

  it("leaves unknown command payloads as JSON so --json-less tools keep working", () => {
    const payload = { ok: true, command: "guides", catalogs: [] };
    expect(formatHuman(payload)).toBe(JSON.stringify(payload, null, 2));
  });

  it("confirms bootstrap still invokes pipeline with --json", async () => {
    const source = await readFile("src/bootstrap/index.mjs", "utf8");
    expect(source).toContain('for (const pipelineCommand of ["doctor", "validate", "plan"])');
    expect(source).toMatch(/"--config",\s*configPath,\s*"--json"/);
  });
});
