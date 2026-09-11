import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { checkCheckout, examplesDirectory, examplesEnv, main, SOURCE } from "../scripts/editframe-examples.mjs";

const roots = [];
function temp() { const root = mkdtempSync(join(tmpdir(), "tsugite-examples-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("official examples installation boundaries", () => {
  it("strips inherited service, git and render overrides without mutating the caller", () => {
    const original = { PATH: "/bin", EF_TOKEN: "test-token", EF_HOST: "test-host", EF_RENDER_HOST: "test-render", ORIGINAL_CWD: "/other", EF_RENDER_PROJECT: "other", GIT_DIR: "/other/.git", EF_NO_TELEMETRY: "0" };
    expect(examplesEnv(original)).toEqual({ PATH: "/bin", EF_NO_TELEMETRY: "1" });
    expect(original.EF_TOKEN).toBe("test-token");
  });
  it("rejects a symlinked parent without writing to its target", () => {
    const root = temp();
    const external = temp();
    symlinkSync(external, join(root, ".tsugite"), "dir");
    expect(() => examplesDirectory(root)).toThrow("real directory");
  });
  it("rejects incomplete installs and preserves existing files", () => {
    const root = temp();
    const directory = examplesDirectory(root);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "mine.txt"), "keep me");
    expect(() => checkCheckout(directory, { clean: true })).toThrow("incomplete");
    expect(readFileSync(join(directory, "mine.txt"), "utf8")).toBe("keep me");
  });
  it("rejects a real repository at an unpinned revision without changing it", () => {
    const directory = temp();
    const git = (args) => {
      const result = spawnSync("git", args, { cwd: directory, encoding: "utf8", env: examplesEnv() });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git(["init", "--quiet"]);
    git(["remote", "add", "origin", SOURCE]);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"]);
    const before = git(["rev-parse", "HEAD"]);
    expect(() => checkCheckout(directory, { clean: true })).toThrow("differs from the pin");
    expect(git(["rev-parse", "HEAD"])).toBe(before);
  });
  it("rejects unknown commands and extra flags before modifying disk", () => {
    expect(() => main(["render"])).toThrow("Usage:");
    expect(() => main(["start", "--host", "0.0.0.0"])).toThrow("Usage:");
  });
});
