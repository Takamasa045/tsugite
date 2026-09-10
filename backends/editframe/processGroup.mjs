import { spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const MAX_CAPTURE = 1024 * 1024;

export function assertSupportedProcessPlatform() {
  if (process.platform !== "darwin") {
    throw new Error("Editframe process ownership is supported on macOS only");
  }
}

export function childEnv(base = process.env) {
  const env = { ...base, EF_NO_TELEMETRY: "1", BROWSER: "none" };
  delete env.EF_TOKEN;
  delete env.EF_HOST;
  delete env.EF_RENDER_HOST;
  return env;
}

export function spawnOwned(argv, options = {}) {
  assertSupportedProcessPlatform();
  const [command, ...args] = argv;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? childEnv(),
    stdio: options.stdio ?? "pipe",
    detached: true
  });
  const stdout = { chunks: [], bytes: 0, truncated: false };
  const stderr = { chunks: [], bytes: 0, truncated: false };
  const handle = {
    child,
    pid: child.pid,
    pgid: child.pid,
    argv,
    stdout,
    stderr,
    error: null
  };
  child.stdout?.on("data", (chunk) => appendCapped(stdout, chunk));
  child.stderr?.on("data", (chunk) => appendCapped(stderr, chunk));
  child.on("error", (error) => {
    handle.error = error;
  });
  return handle;
}

function appendCapped(buffer, chunk) {
  const bytes = Buffer.from(chunk);
  if (buffer.bytes >= MAX_CAPTURE) {
    buffer.truncated = true;
    return;
  }
  const room = MAX_CAPTURE - buffer.bytes;
  buffer.chunks.push(bytes.length > room ? bytes.subarray(0, room) : bytes);
  buffer.bytes += Math.min(bytes.length, room);
  if (bytes.length > room) buffer.truncated = true;
}

export function ownedOutput(handle) {
  return {
    stdout: Buffer.concat(handle.stdout?.chunks ?? []).toString("utf8"),
    stderr: Buffer.concat(handle.stderr?.chunks ?? []).toString("utf8"),
    truncated: Boolean(handle.stdout?.truncated || handle.stderr?.truncated)
  };
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function listGroupPids(pgid) {
  assertSupportedProcessPlatform();
  if (!Number.isInteger(pgid) || pgid <= 0) return [];
  const listed = await new Promise((resolve) => {
    const child = spawn("ps", ["-ax", "-o", "pid=,pgid="], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    child.on("error", () => resolve(""));
  });
  const pids = [];
  for (const line of listed.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const group = Number(match[2]);
    if (group === pgid) pids.push(pid);
  }
  return pids;
}

async function waitPidsGone(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !pidAlive(pid))) return true;
    await delay(50);
  }
  return pids.every((pid) => !pidAlive(pid));
}

function signalGroup(handle, signal) {
  const pgid = handle.pgid ?? handle.pid;
  if (Number.isInteger(pgid) && pgid > 0) {
    try {
      process.kill(-pgid, signal);
    } catch {
      // group may already be gone
    }
  }
  if (handle.pid && pidAlive(handle.pid)) {
    try {
      process.kill(handle.pid, signal);
    } catch {
      // leader may already be gone
    }
  }
}

export async function stopOwned(handle, options = {}) {
  if (!handle) return;
  const graceMs = options.graceMs ?? 1000;
  const killMs = options.killMs ?? 2000;
  const pgid = handle.pgid ?? handle.pid;
  const tracked = new Set(await listGroupPids(pgid));
  if (handle.pid) tracked.add(handle.pid);
  if (tracked.size === 0) return;
  signalGroup(handle, "SIGTERM");
  await waitPidsGone([...tracked], graceMs);
  const remaining = [...tracked].filter((pid) => pidAlive(pid));
  if (remaining.length === 0) return;
  signalGroup(handle, "SIGKILL");
  for (const pid of remaining) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  const gone = await waitPidsGone(remaining, killMs);
  if (!gone) {
    const still = remaining.filter((pid) => pidAlive(pid));
    throw new Error(`owned process group still alive: ${still.join(",")}`);
  }
}

export function waitExit(handle, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timingOut = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      timingOut = true;
      Promise.resolve()
        .then(() => stopOwned(handle))
        .catch((error) => error)
        .then((cleanupError) => {
          const suffix = cleanupError instanceof Error ? `; cleanup: ${cleanupError.message}` : "";
          settle(reject, new Error(`owned process timed out after ${timeoutMs}ms${suffix}`));
        });
    }, timeoutMs);
    if (handle.error) {
      settle(reject, handle.error);
      return;
    }
    if (handle.child.exitCode !== null) {
      settle(resolve, handle.child.exitCode);
      return;
    }
    handle.child.once("error", (error) => {
      handle.error = error;
      if (!timingOut) settle(reject, error);
    });
    handle.child.once("exit", (code) => {
      if (timingOut) return;
      settle(resolve, code ?? 1);
    });
  });
}

export async function waitForHttp(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const expectedStatus = options.expectedStatus ?? 200;
  const expectedText = options.expectedText;
  const expectedType = options.expectedType;
  const forbiddenType = options.forbiddenType;
  const range = options.range;
  const expectedByteLength = options.expectedByteLength;
  const signal = options.signal;
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error("aborted");
    }
    const remaining = Math.max(50, deadline - Date.now());
    const controller = new AbortController();
    const kill = setTimeout(() => controller.abort(), Math.min(2000, remaining));
    try {
      const headers = {};
      if (range) headers.Range = range;
      const response = await fetch(url, { redirect: "manual", signal: controller.signal, headers });
      const type = response.headers.get("content-type") ?? "";
      if (response.status !== expectedStatus) {
        lastError = `status ${response.status}`;
      } else if (expectedType && !type.includes(expectedType)) {
        lastError = `content-type ${type}`;
      } else if (forbiddenType && type.includes(forbiddenType)) {
        lastError = `content-type ${type}`;
      } else if (range || expectedByteLength !== undefined) {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (expectedByteLength !== undefined && bytes.length !== expectedByteLength) {
          lastError = `byte length ${bytes.length}`;
        } else {
          return { status: response.status, type, bytes: bytes.length };
        }
      } else {
        const body = await response.text();
        if (expectedText && !body.includes(expectedText)) {
          lastError = "response did not include expected content";
        } else {
          return { status: response.status, type, body };
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(kill);
    }
    await delay(100);
  }
  throw new Error(`local server did not become ready: ${lastError}`);
}

export async function listenerPid(port) {
  assertSupportedProcessPlatform();
  const listed = await new Promise((resolve) => {
    const child = spawn("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      stdio: ["ignore", "pipe", "ignore"]
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    child.on("error", () => resolve(""));
  });
  const pid = Number(listed.trim().split("\n")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export async function assertOwnedListener(port, pgid) {
  const pid = await listenerPid(port);
  if (!pid) throw new Error(`no listener on 127.0.0.1:${port}`);
  const group = new Set(await listGroupPids(pgid));
  if (pgid) group.add(pgid);
  if (!group.has(pid)) {
    throw new Error(`listener ${pid} on port ${port} is not in owned group ${pgid}`);
  }
  return pid;
}

export async function spawnOwnedUntil(argv, options, readyFn) {
  const signal = options.signal;
  const handle = spawnOwned(argv, options);
  let stopping = null;
  const abort = () => {
    stopping = stopping ?? stopOwned(handle).catch((error) => error);
  };
  if (signal) {
    if (signal.aborted) {
      await stopOwned(handle);
      throw new Error("aborted before owned process started");
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  try {
    await readyFn(handle);
    if (signal?.aborted) {
      const cleanupError = await (stopping ?? stopOwned(handle).catch((error) => error));
      const error = new Error("aborted while owned process was starting");
      if (cleanupError instanceof Error) error.cause = cleanupError;
      throw error;
    }
    return handle;
  } catch (error) {
    const cleanupError = await (stopping ?? stopOwned(handle).catch((caught) => caught));
    if (cleanupError instanceof Error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      wrapped.cause = wrapped.cause ?? cleanupError;
      wrapped.message = `${wrapped.message}; cleanup: ${cleanupError.message}`;
      throw wrapped;
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export async function allocateLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}
