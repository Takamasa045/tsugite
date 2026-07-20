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

  assert.deepEqual(await pending, { exitCode: 7, stdout: "ok\n", stderr: "warn\n" });
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
