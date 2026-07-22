import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AGENT_IPC_CHANNELS,
  createAgentTerminalManager,
  registerAgentTerminalIpc,
  resolveAgentExecutable
} from "../src/agent-terminal.mjs";

test("preload exposes only narrow agents and workspace bridges", async () => {
  const source = await readFile(new URL("../src/preload.mjs", import.meta.url), "utf8");
  assert.match(source, /exposeInMainWorld\("tsugiteDesktop"/);
  assert.match(source, /require\("electron"\)/);
  assert.doesNotMatch(source, /^import\s/m);
  for (const method of ["list", "start", "write", "resize", "stop", "onData", "onExit"]) {
    assert.match(source, new RegExp(`\\b${method}:`));
  }
  assert.match(source, /workspace/);
  assert.match(source, /current:\s*\(\)\s*=>\s*ipcRenderer\.invoke/);
  assert.match(source, /select:\s*\(\)\s*=>\s*ipcRenderer\.invoke/);
  assert.doesNotMatch(source, /sendSync|sendTo|executeJavaScript|readFile|process\.env/);
});

function fakePty() {
  const processes = [];
  return {
    processes,
    spawn(file, args, options) {
      const dataListeners = new Set();
      const exitListeners = new Set();
      const process = {
        file,
        args,
        options,
        writes: [],
        resizes: [],
        kills: 0,
        write(data) { this.writes.push(data); },
        resize(cols, rows) { this.resizes.push([cols, rows]); },
        kill() {
          this.kills += 1;
          if (this.throwOnKill) throw new Error("kill failed");
        },
        onData(listener) {
          dataListeners.add(listener);
          return { dispose: () => dataListeners.delete(listener) };
        },
        onExit(listener) {
          exitListeners.add(listener);
          return { dispose: () => exitListeners.delete(listener) };
        },
        emitData(data) { for (const listener of dataListeners) listener(data); },
        emitExit(exitCode) { for (const listener of exitListeners) listener({ exitCode }); }
      };
      processes.push(process);
      return process;
    }
  };
}

function managerFixture(overrides = {}) {
  const pty = fakePty();
  const requestedExecutables = [];
  const manager = createAgentTerminalManager({
    workspaceRoot: "/safe/workspace",
    pty,
    platform: "linux",
    env: { PATH: "/safe/bin", TERM_PROGRAM: "Tsugite", PRIVATE_TOKEN: "child-only", API_KEY: "secret" },
    idFactory: () => "session-1",
    async resolveExecutable(name) {
      requestedExecutables.push(name);
      return name === "codex" ? "/safe/bin/codex" : undefined;
    },
    ...overrides
  });
  return { manager, pty, requestedExecutables };
}

test("lists only the fixed Codex and Claude host allowlist without exposing executable paths", async () => {
  const { manager, requestedExecutables } = managerFixture();

  assert.deepEqual(await manager.list(), {
    workspaceLabel: "workspace",
    hosts: [
      { id: "codex", label: "Codex CLI", installed: true, detail: "利用可能" },
      { id: "claude", label: "Claude Code", installed: false, detail: "CLIが見つかりません" }
    ]
  });
  assert.deepEqual(requestedExecutables, ["codex", "claude"]);
});

test("executable discovery checks only allowlisted names on absolute PATH entries and returns the canonical executable", async () => {
  const checked = [];
  const result = await resolveAgentExecutable("codex", {
    env: { PATH: "relative:/safe/bin:/other/bin" },
    platform: "linux",
    async accessFile(path) {
      checked.push(path);
      if (path !== "/safe/bin/codex") {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
    },
    async statFile() { return { isFile: () => true }; },
    async realpathFile() { return "/canonical/bin/codex"; }
  });

  assert.equal(result, "/canonical/bin/codex");
  assert.deepEqual(checked, ["/safe/bin/codex"]);
  await assert.rejects(resolveAgentExecutable("bash"), /Unsupported agent executable/);
});

test("Windows executable discovery uses Windows PATH delimiters and PATHEXT casing", async () => {
  const checked = [];
  const result = await resolveAgentExecutable("codex", {
    env: {
      Path: "relative;C:\\safe\\bin;C:\\other\\bin",
      PATHEXT: ".EXE;.CMD"
    },
    platform: "win32",
    async accessFile(path) {
      checked.push(path);
      if (path !== "C:\\safe\\bin\\codex.EXE") {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
    },
    async statFile() { return { isFile: () => true }; },
    async realpathFile(path) { return path; }
  });

  assert.equal(result, "C:\\safe\\bin\\codex.EXE");
  assert.deepEqual(checked, ["C:\\safe\\bin\\codex.EXE"]);
});

test("executable discovery includes common macOS GUI install directories when PATH is minimal", async () => {
  const checked = [];
  const result = await resolveAgentExecutable("claude", {
    env: { PATH: "/usr/bin:/bin", HOME: "/Users/tester" },
    platform: "darwin",
    async accessFile(path) {
      checked.push(path);
      if (path !== "/Users/tester/Library/pnpm/claude") {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
    },
    async statFile() { return { isFile: () => true }; },
    async realpathFile(path) { return path; }
  });

  assert.equal(result, "/Users/tester/Library/pnpm/claude");
  assert.ok(checked.includes("/opt/homebrew/bin/claude"));
  assert.ok(checked.includes("/Users/tester/.local/bin/claude"));
});

test("starts an allowlisted PTY with fixed executable, arguments, cwd, and secret-free environment", async () => {
  const { manager, pty } = managerFixture();

  assert.deepEqual(await manager.start({ hostId: "codex", cols: 120, rows: 36 }), {
    sessionId: "session-1"
  });
  assert.equal(manager.hasActive(), true);
  assert.equal(pty.processes[0].file, "/safe/bin/codex");
  assert.deepEqual(pty.processes[0].args, []);
  assert.equal(pty.processes[0].options.cwd, "/safe/workspace");
  assert.equal(pty.processes[0].options.shell, undefined);
  assert.equal(pty.processes[0].options.env.PRIVATE_TOKEN, undefined);
  assert.equal(pty.processes[0].options.env.API_KEY, undefined);
  assert.match(pty.processes[0].options.env.PATH, /^\/safe\/bin:/);
  assert.equal(pty.processes[0].options.env.TERM, "xterm-256color");
});

test("preserves Windows environment key casing while matching allowed keys case-insensitively", async () => {
  const pty = fakePty();
  const manager = createAgentTerminalManager({
    workspaceRoot: "/safe/workspace",
    pty,
    platform: "win32",
    env: {
      Path: "C:\\safe\\bin",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".EXE;.CMD",
      Api_Key: "secret"
    },
    idFactory: () => "windows-session",
    resolveExecutable: async () => "C:\\safe\\bin\\codex.exe"
  });

  await manager.start({ hostId: "codex", cols: 80, rows: 24 });

  assert.equal(pty.processes[0].options.env.Path, "C:\\safe\\bin");
  assert.equal(pty.processes[0].options.env.SystemRoot, "C:\\Windows");
  assert.equal(pty.processes[0].options.env.ComSpec, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(pty.processes[0].options.env.Api_Key, undefined);
});

test("starts Windows npm command shims through the fixed command interpreter", async () => {
  const pty = fakePty();
  const manager = createAgentTerminalManager({
    workspaceRoot: "/safe/workspace",
    pty,
    platform: "win32",
    env: {
      Path: "C:\\Users\\tester\\AppData\\Roaming\\npm",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".EXE;.CMD"
    },
    idFactory: () => "windows-shim-session",
    resolveExecutable: async () => "C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd"
  });

  await manager.start({ hostId: "codex", cols: 80, rows: 24 });

  assert.equal(pty.processes[0].file, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(pty.processes[0].args, [
    "/d",
    "/s",
    "/c",
    '"C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd"'
  ]);
  assert.equal(pty.processes[0].options.shell, undefined);
});

test("adds common macOS GUI install directories to the PTY PATH", async () => {
  const pty = fakePty();
  const manager = createAgentTerminalManager({
    workspaceRoot: "/safe/workspace",
    pty,
    platform: "darwin",
    env: { PATH: "/usr/bin:/bin", HOME: "/Users/tester" },
    idFactory: () => "mac-session",
    resolveExecutable: async () => "/Users/tester/Library/pnpm/claude"
  });

  await manager.start({ hostId: "claude", cols: 80, rows: 24 });

  assert.match(pty.processes[0].options.env.PATH, /^\/usr\/bin:\/bin:/);
  assert.match(pty.processes[0].options.env.PATH, /\/opt\/homebrew\/bin/);
  assert.match(pty.processes[0].options.env.PATH, /\/Users\/tester\/Library\/pnpm/);
});

test("rejects arbitrary hosts, commands, cwd, environment, and invalid terminal dimensions", async () => {
  const { manager, pty } = managerFixture();

  await assert.rejects(
    manager.start({ hostId: "bash", cols: 80, rows: 24 }),
    /Unsupported agent host/
  );
  await assert.rejects(
    manager.start({ hostId: "codex", cols: 80, rows: 24, command: "cat", cwd: "/", env: { TOKEN: "steal" } }),
    /Unsupported start option/
  );
  await assert.rejects(manager.start({ hostId: "codex", cols: 0, rows: 24 }), /columns/);
  await assert.rejects(manager.start({ hostId: "codex", cols: 80, rows: 1000 }), /rows/);
  assert.equal(pty.processes.length, 0);
});

test("rejects oversized terminal input before it reaches the PTY", async () => {
  const { manager, pty } = managerFixture();
  await manager.start({ hostId: "codex", cols: 80, rows: 24 });

  await assert.rejects(
    manager.write({ sessionId: "session-1", data: "x".repeat(64 * 1024 + 1) }),
    /no larger than/
  );
  assert.deepEqual(pty.processes[0].writes, []);
});

test("forwards bounded input, resize, output, and exit events for the owning session", async () => {
  const { manager, pty } = managerFixture();
  const data = [];
  const exits = [];
  manager.onData((payload) => data.push(payload));
  manager.onExit((payload) => exits.push(payload));
  await manager.start({ hostId: "codex", cols: 80, rows: 24 });

  await manager.write({ sessionId: "session-1", data: "hello\r" });
  await manager.resize({ sessionId: "session-1", cols: 100, rows: 30 });
  pty.processes[0].emitData("world\r\n");
  pty.processes[0].emitExit(7);

  assert.deepEqual(pty.processes[0].writes, ["hello\r"]);
  assert.deepEqual(pty.processes[0].resizes, [[100, 30]]);
  assert.deepEqual(data, [{ sessionId: "session-1", data: "world\r\n" }]);
  assert.deepEqual(exits, [{ sessionId: "session-1", exitCode: 7 }]);
  assert.equal(manager.hasActive(), false);
  await assert.rejects(manager.write({ sessionId: "session-1", data: "late" }), /Unknown terminal session/);
});

test("stop waits for PTY exit and prevents a second session from running in parallel", async () => {
  let nextId = 0;
  const { manager, pty } = managerFixture({ idFactory: () => `session-${++nextId}` });
  await manager.start({ hostId: "codex", cols: 80, rows: 24 });
  const stopping = manager.stop({ sessionId: "session-1" });
  assert.equal(pty.processes[0].kills, 1);
  await assert.rejects(
    manager.start({ hostId: "codex", cols: 80, rows: 24 }),
    /already active/
  );
  let stopResolved = false;
  void stopping.then(() => { stopResolved = true; });
  await Promise.resolve();
  assert.equal(stopResolved, false);
  pty.processes[0].emitExit(0);
  await stopping;

  await manager.start({ hostId: "codex", cols: 80, rows: 24 });
  const disposing = manager.dispose();
  pty.processes[1].emitExit(0);
  await disposing;
  assert.equal(pty.processes[1].kills, 1);
  assert.equal(manager.hasActive(), false);
  await assert.rejects(manager.start({ hostId: "codex", cols: 80, rows: 24 }), /disposed/);
});

test("dispose prevents an in-flight start from spawning after executable discovery", async () => {
  let resolveDiscovery;
  const discovery = new Promise((resolve) => { resolveDiscovery = resolve; });
  const { manager, pty } = managerFixture({ resolveExecutable: () => discovery });
  const pending = manager.start({ hostId: "codex", cols: 80, rows: 24 });
  await Promise.resolve();

  await manager.dispose();
  resolveDiscovery("/safe/bin/codex");

  await assert.rejects(pending, /disposed/);
  assert.equal(pty.processes.length, 0);
});

test("dispose reports a PTY kill failure, keeps the session active, and retries later", async () => {
  let nextId = 0;
  const { manager, pty } = managerFixture({ idFactory: () => `session-${++nextId}` });
  await manager.start({ hostId: "codex", cols: 80, rows: 24 });
  pty.processes[0].throwOnKill = true;

  await assert.rejects(manager.dispose(), /Could not stop all agent terminals/);
  assert.equal(pty.processes[0].kills, 1);
  assert.equal(manager.hasActive(), true);

  pty.processes[0].throwOnKill = false;
  const retry = manager.dispose();
  pty.processes[0].emitExit(0);
  await retry;
  assert.equal(pty.processes[0].kills, 2);
  assert.equal(manager.hasActive(), false);
});

test("stop terminates the Unix PTY process group and escalates when it does not exit", async () => {
  const signals = [];
  const { manager, pty } = managerFixture({
    terminationGraceMs: 0,
    killProcess(pid, signal) {
      signals.push([pid, signal]);
      if (signal === "SIGKILL") pty.processes[0].emitExit(137);
    }
  });
  const started = await manager.start({ hostId: "codex", cols: 80, rows: 24 });
  pty.processes[0].pid = 4321;

  await manager.stop({ sessionId: started.sessionId });

  assert.deepEqual(signals, [[-4321, "SIGTERM"], [-4321, "SIGKILL"]]);
});

test("stop uses taskkill for the Windows PTY process tree", async () => {
  const calls = [];
  const { manager, pty } = managerFixture({
    platform: "win32",
    terminationGraceMs: 0,
    execFileProcess(file, args, options, callback) {
      calls.push({ file, args, options });
      pty.processes[0].emitExit(0);
      callback(null);
    }
  });
  const started = await manager.start({ hostId: "codex", cols: 80, rows: 24 });
  pty.processes[0].pid = 9876;

  await manager.stop({ sessionId: started.sessionId });

  assert.deepEqual(calls, [{
    file: "taskkill",
    args: ["/PID", "9876", "/T", "/F"],
    options: { windowsHide: true, shell: false }
  }]);
});

test("stop and dispose share one in-flight termination attempt", async () => {
  const { manager, pty } = managerFixture();
  const started = await manager.start({ hostId: "codex", cols: 80, rows: 24 });

  const stopping = manager.stop({ sessionId: started.sessionId });
  const disposing = manager.dispose();
  assert.equal(pty.processes[0].kills, 1);
  pty.processes[0].emitExit(0);

  await Promise.all([stopping, disposing]);
  assert.equal(manager.hasActive(), false);
});

test("IPC handlers reject untrusted origins and expose only the declared agent operations", async () => {
  const handlers = new Map();
  const removed = [];
  const sent = [];
  const calls = [];
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler(channel) { removed.push(channel); handlers.delete(channel); }
  };
  const manager = new EventEmitter();
  Object.assign(manager, {
    list: async () => ({ workspaceLabel: "workspace", hosts: [] }),
    start: async (input) => { calls.push(["start", input]); return { sessionId: "s" }; },
    write: async (input) => { calls.push(["write", input]); },
    resize: async (input) => { calls.push(["resize", input]); },
    stop: async (input) => { calls.push(["stop", input]); },
    onData(listener) { this.on("data", listener); return () => this.off("data", listener); },
    onExit(listener) { this.on("exit", listener); return () => this.off("exit", listener); }
  });
  const registration = registerAgentTerminalIpc({
    ipcMain,
    manager,
    isTrustedEvent: (event) => event.senderFrame?.url === "http://127.0.0.1:4100/launcher",
    send: (channel, payload) => sent.push([channel, payload])
  });

  await assert.rejects(
    handlers.get(AGENT_IPC_CHANNELS.start)({ senderFrame: { url: "https://evil.test" } }, { hostId: "codex", cols: 80, rows: 24 }),
    /Untrusted Desktop IPC origin/
  );
  assert.deepEqual(await handlers.get(AGENT_IPC_CHANNELS.start)(
    { senderFrame: { url: "http://127.0.0.1:4100/launcher" } },
    { hostId: "codex", cols: 80, rows: 24 }
  ), { sessionId: "s" });
  manager.emit("data", { sessionId: "s", data: "x" });
  manager.emit("exit", { sessionId: "s", exitCode: 0 });

  assert.deepEqual(calls, [["start", { hostId: "codex", cols: 80, rows: 24 }]]);
  assert.deepEqual(sent, [
    [AGENT_IPC_CHANNELS.data, { sessionId: "s", data: "x" }],
    [AGENT_IPC_CHANNELS.exit, { sessionId: "s", exitCode: 0 }]
  ]);
  registration.dispose();
  assert.deepEqual(new Set(removed), new Set([
    AGENT_IPC_CHANNELS.list,
    AGENT_IPC_CHANNELS.start,
    AGENT_IPC_CHANNELS.write,
    AGENT_IPC_CHANNELS.resize,
    AGENT_IPC_CHANNELS.stop
  ]));
});
