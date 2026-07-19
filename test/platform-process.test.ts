import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commandCandidates,
  commandExists,
  spawnCommandSync
} from "../src/platform/process.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("cross-platform process commands", () => {
  it("expands Windows PATH entries with PATHEXT in declared order", () => {
    expect(commandCandidates(
      "npm",
      { Path: String.raw`C:\Tools;D:\Node`, PATHEXT: ".COM;.EXE;.CMD" },
      "win32"
    )).toEqual([
      String.raw`C:\Tools\npm`,
      String.raw`C:\Tools\npm.COM`,
      String.raw`C:\Tools\npm.EXE`,
      String.raw`C:\Tools\npm.CMD`,
      String.raw`D:\Node\npm`,
      String.raw`D:\Node\npm.COM`,
      String.raw`D:\Node\npm.EXE`,
      String.raw`D:\Node\npm.CMD`
    ]);
  });

  it("does not append PATHEXT when the Windows command already has an extension", () => {
    expect(commandCandidates(
      "npm.cmd",
      { PATH: String.raw`C:\Node`, PATHEXT: ".EXE;.CMD" },
      "win32"
    )).toEqual([String.raw`C:\Node\npm.cmd`]);
  });

  it("normalizes empty and duplicate Windows PATHEXT entries", () => {
    expect(commandCandidates(
      "provider-wrapper",
      { PATH: String.raw`C:\Tools`, PATHEXT: ".EXE;.CMD;; .CMD;" },
      "win32"
    )).toEqual([
      String.raw`C:\Tools\provider-wrapper`,
      String.raw`C:\Tools\provider-wrapper.EXE`,
      String.raw`C:\Tools\provider-wrapper.CMD`
    ]);
  });

  it("finds a regular executable from the supplied PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-command-"));
    temporaryDirectories.push(root);
    const bin = join(root, "bin");
    await mkdir(bin);
    const executable = join(bin, "tool");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    await expect(commandExists("tool", { PATH: bin }, process.platform)).resolves.toBe(true);
    await expect(commandExists("missing", { PATH: bin }, process.platform)).resolves.toBe(false);
  });

  if (process.platform === "win32") {
    it("executes a Windows command shim with argument boundaries intact", async () => {
      const root = await mkdtemp(join(tmpdir(), "tsugite command shim "));
      temporaryDirectories.push(root);
      const command = join(root, "echo-argument.cmd");
      await writeFile(command, "@echo off\r\necho %~1\r\n");

      const result = spawnCommandSync(command, ["value with spaces"], { encoding: "utf8" });

      expect(result.error).toBeFalsy();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("value with spaces");
    });
  }
});
