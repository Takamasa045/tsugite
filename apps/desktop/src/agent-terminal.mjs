import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, posix, win32 } from "node:path";

const HOSTS = Object.freeze([
  Object.freeze({ id: "codex", label: "Codex CLI", executable: "codex" }),
  Object.freeze({ id: "claude", label: "Claude Code", executable: "claude" })
]);
const HOST_BY_ID = new Map(HOSTS.map((host) => [host.id, host]));
const MIN_COLS = 20;
const MAX_COLS = 500;
const MIN_ROWS = 5;
const MAX_ROWS = 300;
const MAX_INPUT_BYTES = 64 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 1_500;

export const AGENT_IPC_CHANNELS = Object.freeze({
  list: "tsugite:agents:list",
  start: "tsugite:agents:start",
  write: "tsugite:agents:write",
  resize: "tsugite:agents:resize",
  stop: "tsugite:agents:stop",
  data: "tsugite:agents:data",
  exit: "tsugite:agents:exit"
});

function executableCandidates(name, platform, env) {
  if (platform !== "win32") return [name];
  const extensions = (env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean);
  return extensions.map((extension) => `${name}${extension}`);
}

function executableSearchDirectories(env, platform) {
  const pathApi = platform === "win32" ? win32 : posix;
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const directories = String(pathValue)
    .split(pathApi.delimiter)
    .filter((directory) => directory && pathApi.isAbsolute(directory));
  const home = env.HOME ?? env.USERPROFILE;
  if (platform === "darwin") {
    directories.push("/opt/homebrew/bin", "/usr/local/bin");
    if (home && pathApi.isAbsolute(home)) {
      directories.push(
        pathApi.join(home, ".local", "bin"),
        pathApi.join(home, "Library", "pnpm"),
        pathApi.join(home, ".npm-global", "bin"),
        pathApi.join(home, ".volta", "bin"),
        pathApi.join(home, ".bun", "bin")
      );
    }
  } else if (platform !== "win32") {
    directories.push("/usr/local/bin");
    if (home && pathApi.isAbsolute(home)) directories.push(pathApi.join(home, ".local", "bin"));
  } else {
    for (const candidate of [env.PNPM_HOME, env.APPDATA && pathApi.join(env.APPDATA, "npm")]) {
      if (candidate && pathApi.isAbsolute(candidate)) directories.push(candidate);
    }
  }
  return [...new Set(directories)];
}

export async function resolveAgentExecutable(name, {
  env = process.env,
  platform = process.platform,
  accessFile = access,
  statFile = stat,
  realpathFile = realpath
} = {}) {
  if (![...HOST_BY_ID.values()].some((host) => host.executable === name)) {
    throw new Error(`Unsupported agent executable: ${name}`);
  }
  const pathApi = platform === "win32" ? win32 : posix;
  const directories = executableSearchDirectories(env, platform);
  const candidates = executableCandidates(name, platform, env);
  for (const directory of directories) {
    for (const candidate of candidates) {
      const path = pathApi.join(directory, candidate);
      try {
        const mode = platform === "win32" ? constants.F_OK : constants.X_OK;
        await accessFile(path, mode);
        if (!(await statFile(path)).isFile()) continue;
        return await realpathFile(path);
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "EACCES" || error?.code === "ENOTDIR") continue;
        throw error;
      }
    }
  }
  return undefined;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertOnlyKeys(value, keys, label) {
  assertPlainObject(value, label);
  const allowed = new Set(keys);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) throw new Error(`Unsupported ${label} option: ${extra}`);
}

function assertDimension(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`Terminal ${label} must be an integer from ${minimum} to ${maximum}`);
  }
}

function assertSessionId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new TypeError("Terminal sessionId must be a non-empty string");
  }
}

function workspaceLabel(workspaceRoot) {
  return basename(workspaceRoot) || workspaceRoot;
}

function terminalEnvironment(env, platform) {
  const exact = new Set([
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "TMPDIR",
    "COLORTERM", "NO_COLOR", "FORCE_COLOR", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "COMSPEC", "SYSTEMROOT", "WINDIR", "PATHEXT"
  ]);
  const filtered = Object.fromEntries(Object.entries(env).filter(([key, value]) => {
    if (typeof value !== "string") return false;
    const normalizedKey = key.toUpperCase();
    return exact.has(normalizedKey) || normalizedKey.startsWith("LC_") || normalizedKey.startsWith("XDG_");
  }));
  const pathKey = Object.keys(filtered).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  filtered[pathKey] = executableSearchDirectories(env, platform)
    .join(platform === "win32" ? win32.delimiter : posix.delimiter);
  return filtered;
}

function environmentValue(env, name) {
  const entry = Object.entries(env).find(([key, value]) => (
    key.toUpperCase() === name && typeof value === "string"
  ));
  return entry?.[1];
}

function agentLaunchCommand(executable, platform, env) {
  if (platform !== "win32" || ![".cmd", ".bat"].includes(win32.extname(executable).toLowerCase())) {
    return { file: executable, args: [] };
  }
  const systemRoot = environmentValue(env, "SYSTEMROOT");
  const commandInterpreter = environmentValue(env, "COMSPEC")
    ?? (systemRoot ? win32.join(systemRoot, "System32", "cmd.exe") : undefined);
  if (!commandInterpreter || !win32.isAbsolute(commandInterpreter)) {
    throw new Error("Windows command interpreter is not available for the agent CLI shim");
  }
  return {
    file: commandInterpreter,
    args: ["/d", "/s", "/c", `"${executable}"`]
  };
}

export function createAgentTerminalManager({
  workspaceRoot,
  pty,
  env = process.env,
  platform = process.platform,
  idFactory = randomUUID,
  resolveExecutable = (name) => resolveAgentExecutable(name, { env, platform }),
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  execFileProcess = execFile,
  killProcess = process.kill.bind(process)
}) {
  if (!isAbsolute(workspaceRoot)) throw new Error("Agent terminal workspace must be absolute");
  if (!pty || typeof pty.spawn !== "function") throw new TypeError("A PTY implementation is required");

  const sessions = new Map();
  const dataListeners = new Set();
  const exitListeners = new Set();
  let disposed = false;
  let starting = false;
  let disposePromise;

  const list = async () => {
    const resolved = await Promise.all(HOSTS.map(async (host) => ({
      host,
      executable: await resolveExecutable(host.executable)
    })));
    return {
      workspaceLabel: workspaceLabel(workspaceRoot),
      hosts: resolved.map(({ host, executable }) => ({
        id: host.id,
        label: host.label,
        installed: Boolean(executable),
        detail: executable ? "利用可能" : "CLIが見つかりません"
      }))
    };
  };

  const start = async (input) => {
    if (disposed) throw new Error("Agent terminal manager is disposed");
    assertOnlyKeys(input, ["hostId", "cols", "rows"], "start");
    const host = HOST_BY_ID.get(input.hostId);
    if (!host) throw new Error(`Unsupported agent host: ${String(input.hostId)}`);
    assertDimension(input.cols, "columns", MIN_COLS, MAX_COLS);
    assertDimension(input.rows, "rows", MIN_ROWS, MAX_ROWS);
    if (starting || sessions.size > 0) throw new Error("An agent terminal session is already active");
    starting = true;
    try {
      const executable = await resolveExecutable(host.executable);
      if (!executable) throw new Error(`${host.label} CLI is not installed`);
      if (disposed) throw new Error("Agent terminal manager is disposed");
      if (sessions.size > 0) throw new Error("An agent terminal session is already active");

      const sessionId = idFactory();
      assertSessionId(sessionId);
      if (sessions.has(sessionId)) throw new Error("Agent terminal session ID collision");
      const launch = agentLaunchCommand(executable, platform, env);
      const terminal = pty.spawn(launch.file, launch.args, {
        cwd: workspaceRoot,
        cols: input.cols,
        rows: input.rows,
        name: "xterm-256color",
        env: { ...terminalEnvironment(env, platform), TERM: "xterm-256color" }
      });
      let resolveExit;
      const exitPromise = new Promise((resolve) => { resolveExit = resolve; });
      const record = { terminal, disposables: [], exitPromise, resolveExit, terminationPromise: null };
      sessions.set(sessionId, record);
      record.disposables.push(terminal.onData((data) => {
        if (!sessions.has(sessionId) || typeof data !== "string") return;
        for (const listener of dataListeners) listener({ sessionId, data });
      }));
      record.disposables.push(terminal.onExit(({ exitCode }) => {
        if (!sessions.delete(sessionId)) return;
        for (const disposable of record.disposables) disposable?.dispose?.();
        const normalizedCode = Number.isInteger(exitCode) ? exitCode : 1;
        record.resolveExit(normalizedCode);
        for (const listener of exitListeners) listener({ sessionId, exitCode: normalizedCode });
      }));
      return { sessionId };
    } finally {
      starting = false;
    }
  };

  const getSession = (sessionId) => {
    assertSessionId(sessionId);
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown terminal session: ${sessionId}`);
    return session;
  };

  const exitedWithin = async (record) => new Promise((resolveExitState) => {
    const timer = setTimeout(() => resolveExitState(false), terminationGraceMs);
    void record.exitPromise.then(() => {
      clearTimeout(timer);
      resolveExitState(true);
    });
  });

  const terminate = (sessionId, record) => {
    if (!sessions.has(sessionId)) return Promise.resolve();
    if (record.terminationPromise) return record.terminationPromise;
    const operation = (async () => {
      const pid = record.terminal.pid;
      if (!Number.isInteger(pid) || pid <= 0) {
        record.terminal.kill();
        if (!await exitedWithin(record)) throw new Error(`Agent terminal ${sessionId} did not stop`);
        return;
      }
      if (platform === "win32") {
        await new Promise((resolveKill, rejectKill) => {
          execFileProcess(
            "taskkill",
            ["/PID", String(pid), "/T", "/F"],
            { windowsHide: true, shell: false },
            (error) => error ? rejectKill(error) : resolveKill()
          );
        });
        if (!await exitedWithin(record)) throw new Error(`Windows agent process tree ${pid} did not stop`);
        return;
      }
      try {
        killProcess(-pid, "SIGTERM");
      } catch {
        record.terminal.kill("SIGTERM");
      }
      if (await exitedWithin(record)) return;
      try {
        killProcess(-pid, "SIGKILL");
      } catch {
        record.terminal.kill("SIGKILL");
      }
      if (!await exitedWithin(record)) throw new Error(`Agent process group ${pid} did not stop`);
    })();
    record.terminationPromise = operation;
    void operation.finally(() => {
      if (record.terminationPromise === operation) record.terminationPromise = null;
    }).catch(() => undefined);
    return operation;
  };

  const write = async (input) => {
    assertOnlyKeys(input, ["sessionId", "data"], "write");
    if (typeof input.data !== "string" || Buffer.byteLength(input.data) > MAX_INPUT_BYTES) {
      throw new Error(`Terminal input must be a string no larger than ${MAX_INPUT_BYTES} bytes`);
    }
    getSession(input.sessionId).terminal.write(input.data);
  };

  const resize = async (input) => {
    assertOnlyKeys(input, ["sessionId", "cols", "rows"], "resize");
    assertDimension(input.cols, "columns", MIN_COLS, MAX_COLS);
    assertDimension(input.rows, "rows", MIN_ROWS, MAX_ROWS);
    getSession(input.sessionId).terminal.resize(input.cols, input.rows);
  };

  const stop = async (input) => {
    assertOnlyKeys(input, ["sessionId"], "stop");
    const session = getSession(input.sessionId);
    await terminate(input.sessionId, session);
  };

  const subscribe = (listeners, listener) => {
    if (typeof listener !== "function") throw new TypeError("Terminal event listener must be a function");
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const dispose = async () => {
    disposed = true;
    if (disposePromise) return disposePromise;
    disposePromise = (async () => {
      const results = await Promise.allSettled(
        [...sessions.entries()].map(([sessionId, record]) => terminate(sessionId, record))
      );
      const errors = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length > 0) throw new AggregateError(errors, "Could not stop all agent terminals");
      dataListeners.clear();
      exitListeners.clear();
    })();
    try {
      await disposePromise;
    } finally {
      disposePromise = undefined;
    }
  };

  return {
    list,
    start,
    write,
    resize,
    stop,
    onData: (listener) => subscribe(dataListeners, listener),
    onExit: (listener) => subscribe(exitListeners, listener),
    hasActive: () => starting || sessions.size > 0,
    dispose
  };
}

export function registerAgentTerminalIpc({ ipcMain, manager, isTrustedEvent, send }) {
  const methods = [
    [AGENT_IPC_CHANNELS.list, () => manager.list()],
    [AGENT_IPC_CHANNELS.start, (input) => manager.start(input)],
    [AGENT_IPC_CHANNELS.write, (input) => manager.write(input)],
    [AGENT_IPC_CHANNELS.resize, (input) => manager.resize(input)],
    [AGENT_IPC_CHANNELS.stop, (input) => manager.stop(input)]
  ];
  for (const [channel, invoke] of methods) {
    ipcMain.handle(channel, async (event, input) => {
      if (!isTrustedEvent(event)) throw new Error("Untrusted Desktop IPC origin");
      return invoke(input);
    });
  }
  const unsubscribeData = manager.onData((payload) => send(AGENT_IPC_CHANNELS.data, payload));
  const unsubscribeExit = manager.onExit((payload) => send(AGENT_IPC_CHANNELS.exit, payload));
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeData();
      unsubscribeExit();
      for (const [channel] of methods) ipcMain.removeHandler(channel);
    }
  };
}
