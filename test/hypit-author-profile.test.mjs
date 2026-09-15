import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTHOR_DISABLE_FEATURES,
  defaultCodexExecArgv,
  resolveCodexExecutable
} from "../adapters/hypit/authorProfile.mjs";
import { invokeAuthorAgent } from "../adapters/hypit/agentBridge.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "tsugite-codex-"));
  roots.push(root);
  return root;
}

function writeUnixCodex(dir) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "codex");
  writeFileSync(bin, "#!/bin/sh\n");
  chmodSync(bin, 0o755);
  return bin;
}

function writeWinFile(dir, name, body) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

describe("resolveCodexExecutable PATH contract", () => {
  it("uses the first absolute PATH entry on mac/linux and ignores empty/relative decoys", () => {
    const root = tempRoot();
    const first = writeUnixCodex(join(root, "first"));
    const later = writeUnixCodex(join(root, "later"));
    writeUnixCodex(join(root, "relative-decoy"));
    const resolved = resolveCodexExecutable({
      PATH: `./relative-decoy::${join(root, "first")}:${later}`
    }, { platform: "darwin" });
    expect(resolved.command).toBe(first);
    expect(resolved.executable).toBe(first);
    expect(resolved.kind).toBe("direct");
    expect(resolved.argsPrefix).toEqual([]);

    const linux = resolveCodexExecutable({
      PATH: `${join(root, "first")}:${join(root, "later")}`
    }, { platform: "linux" });
    expect(linux.command).toBe(first);
    expect(linux.executable).toBe(first);
  });

  it("does not select a project-relative PATH binary", () => {
    const root = tempRoot();
    writeUnixCodex(join(root, "bin"));
    try {
      resolveCodexExecutable({ PATH: "bin:./bin:node_modules/.bin" }, { platform: "linux" });
      throw new Error("expected missing");
    } catch (error) {
      expect(error.code).toBe("AUTHOR_AGENT_MISSING");
    }
  });

  it("resolves Windows codex.exe from an absolute PATH entry", () => {
    const root = tempRoot();
    const exe = writeWinFile(join(root, "win"), "codex.exe", "MZ");
    const resolved = resolveCodexExecutable({
      PATH: `${join(root, "win")}`
    }, { platform: "win32" });
    expect(resolved.command).toBe(exe);
    expect(resolved.kind).toBe("direct");
  });

  it("rejects Windows .cmd wrappers instead of claiming shell launch", () => {
    const root = tempRoot();
    writeWinFile(join(root, "cmdonly"), "codex.cmd", "@echo off\n");
    try {
      resolveCodexExecutable({ PATH: join(root, "cmdonly") }, { platform: "win32" });
      throw new Error("expected unsupported");
    } catch (error) {
      expect(error.code).toBe("AUTHOR_AGENT_UNSUPPORTED");
      expect(error.message).toMatch(/\.cmd/);
      expect(error.message).toMatch(/shell:false/);
    }
  });

  it("prefers later absolute codex.exe over an earlier .cmd wrapper", () => {
    const root = tempRoot();
    writeWinFile(join(root, "cmd"), "codex.cmd", "@echo off\n");
    const exe = writeWinFile(join(root, "exe"), "codex.exe", "MZ");
    const resolved = resolveCodexExecutable({
      PATH: `${join(root, "cmd")};${join(root, "exe")}`
    }, { platform: "win32" });
    expect(resolved.command).toBe(exe);
  });
});

describe("author argv uses the same resolved executable", () => {
  it("keeps sandbox/network/ignore flags and uses the resolved command for sync argv", () => {
    const root = tempRoot();
    const bin = writeUnixCodex(join(root, "bin"));
    const env = { PATH: join(root, "bin") };
    const resolved = resolveCodexExecutable(env, { platform: "darwin" });
    const argv = defaultCodexExecArgv({
      workspace: "/tmp/ws",
      schemaPath: "/tmp/schema.json",
      lastMessagePath: "/tmp/last.txt",
      resolved
    });
    const again = defaultCodexExecArgv({
      workspace: "/tmp/ws",
      schemaPath: "/tmp/schema.json",
      lastMessagePath: "/tmp/last.txt",
      env,
      resolve: { platform: "darwin" }
    });
    expect(argv[0]).toBe(bin);
    expect(again[0]).toBe(bin);
    expect(argv).toEqual(again);
    expect(argv).toContain("--ignore-user-config");
    expect(argv).toContain("--ignore-rules");
    expect(argv).toContain("workspace-write");
    expect(argv).toContain("sandbox_workspace_write.network_access=false");
    for (const name of AUTHOR_DISABLE_FEATURES) expect(argv).toContain(name);
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("invokeAuthorAgent uses the same trusted absolute executable as resolveCodexExecutable", () => {
    const root = tempRoot();
    const bin = writeUnixCodex(join(root, "bin"));
    const workspace = tempRoot();
    const env = { PATH: join(root, "bin") };
    const resolved = resolveCodexExecutable(env, { platform: "linux" });
    writeFileSync(join(workspace, "main.svml"), `<import from="@hypit/markup@1"/>`);
    writeFileSync(join(workspace, "build.svrun"), `<svrun/>`);
    const result = invokeAuthorAgent({
      workspace,
      brief: "synthetic",
      env,
      resolved,
      runCommand: () => ({ status: 0, stdout: "ok", stderr: "" })
    });
    expect(result.argv[0]).toBe(bin);
    expect(result.argv[0]).toBe(resolved.command);
    expect(result.status).toBe("noop");
  });
});
