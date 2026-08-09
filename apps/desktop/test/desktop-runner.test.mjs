import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createPipelineRunner } from "../src/process-runner.mjs";

function fakeChild(pid = 4321) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    return true;
  };
  return child;
}

test("runner uses the selected Node, strips only the pipeline entry, and captures output", async () => {
  const calls = [];
  const child = fakeChild();
  const runner = createPipelineRunner({
    nodeExecutable: "/runtime/bin/node",
    cliModulePath: "/runtime/build/cli.js",
    runtimeRoot: "/runtime",
    platform: "darwin",
    baseEnv: { PATH: "/bin", KEEP: "base" },
    spawnProcess(executable, args, options) {
      calls.push({ executable, args, options });
      return child;
    }
  });

  const pending = runner.run("/ignored/node", [
    "/runtime/bin/pipeline",
    "validate",
    "--config",
    "/workspace/projects/a/project.yaml"
  ], { env: { KEEP: "override", SECRET: "not-logged" } });
  assert.equal(runner.hasActive(), true);
  child.stdout.end("ok\n");
  child.stderr.end("warn\n");
  child.emit("close", 7);

  assert.deepEqual(await pending, {
    exitCode: 7,
    stdout: "ok\n",
    stderr: "warn\n",
    truncated: false
  });
  assert.equal(runner.hasActive(), false);
  assert.deepEqual(calls, [{
    executable: "/runtime/bin/node",
    args: [
      "/runtime/build/cli.js",
      "validate",
      "--config",
      "/workspace/projects/a/project.yaml"
    ],
    options: {
      cwd: "/runtime",
      env: {
        PATH: "/runtime/bin:/bin",
        KEEP: "override",
        SECRET: "not-logged"
      },
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  }]);
});

test("generation runs through the managed pipeline process and returns parsed JSON", async () => {
  const calls = [];
  const child = fakeChild(4567);
  const runner = createPipelineRunner({
    nodeExecutable: "/runtime/bin/node",
    cliModulePath: "/runtime/build/cli.js",
    runtimeRoot: "/runtime",
    platform: "darwin",
    maxOutputBytes: 16,
    baseEnv: { PATH: "/bin" },
    spawnProcess(executable, args, options) {
      calls.push({ executable, args, options });
      return child;
    }
  });

  const pending = runner.runGeneration("/workspace/projects/a/project.yaml");
  assert.equal(runner.hasActive(), true);
  const payload = { ok: true, command: "run", detail: "x".repeat(20_000) };
  child.stdout.end(`${JSON.stringify(payload)}\n`);
  child.emit("close", 0);

  assert.deepEqual(await pending, payload);
  assert.equal(runner.hasActive(), false);
  assert.deepEqual(calls[0].args, [
    "/runtime/build/cli.js",
    "run",
    "--config", "/workspace/projects/a/project.yaml",
    "--actor", "coordinator",
    "--json"
  ]);
});

test("dispose terminates a managed generation process", async () => {
  const child = fakeChild(4568);
  const signals = [];
  const runner = createPipelineRunner({
    nodeExecutable: "/runtime/bin/node",
    cliModulePath: "/runtime/build/cli.js",
    runtimeRoot: "/runtime",
    platform: "linux",
    terminationGraceMs: 0,
    spawnProcess: () => child,
    killProcess(pid, signal) {
      signals.push([pid, signal]);
      if (signal === "SIGKILL") child.emit("close", null, signal);
    }
  });

  const generation = runner.runGeneration("/workspace/projects/a/project.yaml");
  const rejected = assert.rejects(generation, /generation failed/);
  await runner.dispose();

  await rejected;
  assert.deepEqual(signals, [[-4568, "SIGTERM"], [-4568, "SIGKILL"]]);
  assert.equal(runner.hasActive(), false);
});

test("runner caps retained stdout and stderr without stopping stream draining", async () => {
  const child = fakeChild();
  const runner = createPipelineRunner({
    nodeExecutable: "/runtime/bin/node",
    cliModulePath: "/runtime/build/cli.js",
    runtimeRoot: "/runtime",
    platform: "darwin",
    maxOutputBytes: 16 * 1024,
    spawnProcess: () => child
  });

  const pending = runner.run("ignored", ["pipeline", "plan"]);
  child.stdout.write("a".repeat(20_000));
  child.stderr.write("b".repeat(20_000));
  child.emit("close", 0);
  const result = await pending;

  assert.equal(Buffer.byteLength(result.stdout), 16 * 1024);
  assert.equal(Buffer.byteLength(result.stderr), 16 * 1024);
  assert.equal(result.truncated, true);
});

test("B1: per-call maxOutputBytes retains full ~74KiB maintenance JSON with exit 0", async () => {
  const CLI_JSON_MAX_BYTES = 256 * 1024;
  const REALISTIC_BYTES = 74_872;
  const child = fakeChild();
  const runner = createPipelineRunner({
    nodeExecutable: "/runtime/bin/node",
    cliModulePath: "/runtime/build/cli.js",
    runtimeRoot: "/runtime",
    platform: "darwin",
    // Desktop default is 16KiB — maintenance must override per call.
    maxOutputBytes: 16 * 1024,
    spawnProcess: () => child
  });

  const payload = {
    ok: true,
    command: "worktrees",
    issues: [],
    applied: false,
    git_common_dir: "/repo/.git",
    primary_path: "/repo",
    current_path: "/repo",
    main_branch: "main",
    worktrees: [{
      path: "/repo",
      is_primary: true,
      is_current: true,
      branch: "main",
      head: "a".repeat(40),
      merged_into_main: true,
      dirty_tracked: false,
      dirty_untracked: false,
      locked: false,
      missing: false,
      removable: false,
      block_reasons: ["primary"],
      ignored_protected: Array.from({ length: 200 }, (_, i) => `projects/p${i}/pad-${"x".repeat(200)}`),
      ignored_other: [],
      status_entries: []
    }],
    pad: "y".repeat(REALISTIC_BYTES)
  };
  let body = JSON.stringify(payload);
  // Pin to the realistic production size class (~74KiB).
  if (Buffer.byteLength(body) < REALISTIC_BYTES) {
    payload.pad = "y".repeat(REALISTIC_BYTES - Buffer.byteLength(body) + payload.pad.length);
    body = JSON.stringify(payload);
  }
  assert.ok(Buffer.byteLength(body) >= REALISTIC_BYTES);

  const pending = runner.run("ignored", ["pipeline", "worktrees", "--json"], {
    maxOutputBytes: CLI_JSON_MAX_BYTES
  });
  child.stdout.end(`${body}\n`);
  child.stderr.end("");
  child.emit("close", 0);
  const result = await pending;

  assert.equal(result.exitCode, 0);
  assert.ok(Buffer.byteLength(result.stdout) >= REALISTIC_BYTES);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "worktrees");
  assert.equal(parsed.worktrees[0].path, "/repo");

  await assert.rejects(
    () => runner.run("ignored", ["pipeline", "x"], { maxOutputBytes: Number.POSITIVE_INFINITY }),
    /positive safe integer/
  );
  await assert.rejects(
    () => runner.run("ignored", ["pipeline", "x"], { maxOutputBytes: 0 }),
    /positive safe integer/
  );
});

test("dispose terminates active Unix process groups and prevents new commands", async () => {
  const child = fakeChild(9876);
  const signals = [];
  const runner = createPipelineRunner({
    nodeExecutable: "/runtime/bin/node",
    cliModulePath: "/runtime/build/cli.js",
    runtimeRoot: "/runtime",
    platform: "linux",
    terminationGraceMs: 0,
    spawnProcess: () => child,
    killProcess(pid, signal) {
      signals.push([pid, signal]);
      if (signal === "SIGKILL") child.emit("close", null, signal);
    }
  });

  const pending = runner.run("ignored", ["pipeline", "render"]);
  await runner.dispose();
  assert.deepEqual(signals, [[-9876, "SIGTERM"], [-9876, "SIGKILL"]]);
  assert.equal((await pending).exitCode, 1);
  assert.equal(runner.hasActive(), false);
  await assert.rejects(runner.run("ignored", ["pipeline", "validate"]), /disposed/);
});

test("dispose uses taskkill with argument boundaries on Windows", async () => {
  const child = fakeChild(2468);
  const calls = [];
  const runner = createPipelineRunner({
    nodeExecutable: "C:\\runtime\\bin\\node.exe",
    cliModulePath: "C:\\runtime\\build\\cli.js",
    runtimeRoot: "C:\\runtime",
    platform: "win32",
    terminationGraceMs: 0,
    spawnProcess: () => child,
    execFileProcess(file, args, options, callback) {
      calls.push({ file, args, options });
      child.emit("close", null, "SIGTERM");
      callback(null, "", "");
    }
  });

  const pending = runner.run("ignored", ["pipeline", "validate"]);
  await runner.dispose();
  await pending;
  assert.deepEqual(calls, [{
    file: "taskkill",
    args: ["/PID", "2468", "/T", "/F"],
    options: { windowsHide: true, shell: false }
  }]);
});

test("dispose rejects when Windows cannot terminate an active child", async () => {
  const child = fakeChild(1357);
  const runner = createPipelineRunner({
    nodeExecutable: "C:\\runtime\\bin\\node.exe",
    cliModulePath: "C:\\runtime\\build\\cli.js",
    runtimeRoot: "C:\\runtime",
    platform: "win32",
    terminationGraceMs: 0,
    spawnProcess: () => child,
    execFileProcess(_file, _args, _options, callback) {
      callback(new Error("taskkill access denied"));
    }
  });

  const pending = runner.run("ignored", ["pipeline", "render"]);
  await assert.rejects(runner.dispose(), /taskkill access denied/);
  assert.equal(runner.hasActive(), true);
  child.emit("close", 1);
  await pending;
});

test("dispose rejects when a Unix child remains active after SIGKILL", async () => {
  const child = fakeChild(8642);
  const runner = createPipelineRunner({
    nodeExecutable: "/runtime/bin/node",
    cliModulePath: "/runtime/build/cli.js",
    runtimeRoot: "/runtime",
    platform: "linux",
    terminationGraceMs: 0,
    spawnProcess: () => child,
    killProcess() {}
  });

  const pending = runner.run("ignored", ["pipeline", "render"]);
  await assert.rejects(runner.dispose(), /did not stop/);
  assert.equal(runner.hasActive(), true);
  child.emit("close", 1);
  await pending;
});
