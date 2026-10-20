import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runPipeline(args: string[]) {
  const env = { ...process.env };
  delete env.TSUGITE_LANG;
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env
  });
}

describe("CLI --lang", () => {
  it("accepts --lang before or after the command without changing Japanese default help", () => {
    const help = runPipeline(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: node bin/pipeline <command> [options]");

    const after = runPipeline(["help", "--lang", "en", "--json"]);
    expect(after.status).toBe(0);
    expect(JSON.parse(after.stdout)).toMatchObject({
      ok: true,
      command: "help"
    });

    const before = runPipeline(["--lang", "ja", "help", "--json"]);
    expect(before.status).toBe(0);
    expect(JSON.parse(before.stdout)).toMatchObject({
      ok: true,
      command: "help"
    });
  });

  it("rejects an unsupported --lang value", () => {
    const result = runPipeline(["help", "--lang", "fr", "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      command: "help",
      issues: [expect.objectContaining({
        code: "cli.lang_unsupported",
        path: "--lang"
      })]
    });
  });
});
