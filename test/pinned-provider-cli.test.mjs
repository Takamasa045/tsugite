import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { pinnedCli } from "../adapters/pinnedCli.mjs";
import { klingCommand } from "../adapters/kling/runtimePath.mjs";

it("rejects absent or stale pinned provider runtimes without using global CLI fallbacks", async () => {
  const root = await mkdtemp(join(tmpdir(), "tsugite-pinned-cli-"));
  const directory = join(root, "node_modules", "@fixture/cli");
  try {
    expect(() => pinnedCli(root, "@fixture/cli", "1.2.3", "cli.mjs", "fixture:install")).toThrow(/fixture:install/);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "cli.mjs"), "");
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@fixture/cli", version: "1.2.2" }));
    expect(() => pinnedCli(root, "@fixture/cli", "1.2.3", "cli.mjs", "fixture:install")).toThrow(/mismatched/);
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@fixture/cli", version: "1.2.3" }));
    expect(pinnedCli(root, "@fixture/cli", "1.2.3", "cli.mjs", "fixture:install"))
      .toEqual({ executable: process.execPath, prefix: [join(directory, "cli.mjs")] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("preserves an explicitly selected Kling CLI without changing its connection", () => {
  expect(klingCommand({ KLING_CLI: "/selected/cli with spaces" }))
    .toEqual({ executable: "/selected/cli with spaces", prefix: [] });
});

it("keeps MiniMax preflight-only even when a caller tries to submit generation or login", () => {
  for (const args of [["video", "generate", "--prompt", "fixture"], ["login"], ["video", "generate", "--dry-run"]]) {
    const result = spawnSync(process.execPath, [resolve("adapters/minimax/cli.mjs"), ...args], { encoding: "utf8" });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("preflight-only");
    expect(result.stdout).toBe("");
  }
});
