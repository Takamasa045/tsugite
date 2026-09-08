import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "tsugite-canvas-"));
  try {
    await copyFile("adapters/pixverse/cli.mjs", join(root, "cli.mjs"));
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe("repository PixVerse CLI entry", () => {
  it("fails with an actionable install hint without falling back to a global CLI", async () => {
    await fixture(async (root) => {
      const result = spawnSync(process.execPath, [join(root, "cli.mjs"), "canvas", "--help"], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("npm run pixverse:install");
      expect(result.stdout).toBe("");
    });
  });

  it("preserves argv, stdin patch, cwd, stdout, stderr and official failure codes", async () => {
    await fixture(async (root) => {
      const dir = join(root, "runtime/node_modules/pixverse/dist");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "index.js"), `const fs = require('node:fs'); process.stdout.write(JSON.stringify({args:process.argv.slice(2),input:fs.readFileSync(0,'utf8'),cwd:process.cwd()})); process.stderr.write('validation failed'); process.exitCode=6;`);
      const args = ["canvas", "patch", "dry-run", "--patch", "-", "--project-id", "123", "--json"];
      const input = '{"title":"日本語 $HOME `literal`"}';
      const result = spawnSync(process.execPath, [join(root, "cli.mjs"), ...args], { cwd: root, input, encoding: "utf8" });
      expect(result.status).toBe(6);
      expect(result.stderr).toBe("validation failed");
      expect(JSON.parse(result.stdout)).toMatchObject({ args, input });
      expect(JSON.parse(result.stdout).cwd).toContain("tsugite-canvas-");
    });
  });
});
