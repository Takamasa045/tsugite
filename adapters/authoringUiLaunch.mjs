import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAuthoringUiLaunchSpec } from "./authoringUiRegistry.mjs";

const UNSAFE_ENV = new Set([
  "BASH_ENV",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "ENV",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PERL5OPT",
  "PYTHONPATH",
  "RUBYOPT",
  "SHELLOPTS"
]);

const LISTEN_MAX_BYTES = 8 * 1024;
const START_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 800;

export async function ensureAuthoringUi(input) {
  const spec = input.spec ?? getAuthoringUiLaunchSpec(input.adapterId);
  if (!spec) {
    throw Object.assign(new Error("authoring adapter is not registered"), {
      code: "authoring.adapter_unregistered"
    });
  }
  const productionRoot = await realpath(input.productionRoot);
  const adapterId = spec.id;
  const live = await readLiveAuthoringUi(productionRoot, spec, adapterId);
  if (live) return live;
  return await spawnAuthoringUi({ spec, productionRoot, adapterId });
}

export async function readLiveAuthoringUiUrl(productionRoot, adapterId) {
  const spec = getAuthoringUiLaunchSpec(adapterId);
  if (!spec) return undefined;
  try {
    const live = await readLiveAuthoringUi(await realpath(productionRoot), spec, spec.id);
    return live?.url;
  } catch {
    return undefined;
  }
}

async function readLiveAuthoringUi(productionRoot, spec, adapterId) {
  const listenPath = join(productionRoot, spec.listenRelativePath);
  const listen = await readListenFile(listenPath);
  if (!listen || listen.stopped === true) return undefined;
  if (!(await probeReady(listen.host, listen.port, spec.readyPath, productionRoot, adapterId))) {
    return undefined;
  }
  return {
    url: `http://${listen.host}:${listen.port}/`,
    host: listen.host,
    port: listen.port,
    reused: true
  };
}

async function spawnAuthoringUi({ spec, productionRoot, adapterId }) {
  const modulePath = await realpath(spec.modulePath);
  const moduleStats = await lstat(modulePath);
  if (!moduleStats.isFile() || moduleStats.isSymbolicLink()) {
    throw Object.assign(new Error("authoring UI entry is not a regular file"), {
      code: "authoring.ui_entry_unsafe"
    });
  }
  const args = [];
  if (spec.nodeImport) args.push("--import", spec.nodeImport);
  args.push(modulePath, ...spec.argvPrefix, spec.productionArg, productionRoot, spec.portArg, "0");
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: sanitizedEnv(process.env),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    windowsHide: true
  });
  child.unref();
  const started = Date.now();
  let exitCode;
  child.once("exit", (code) => {
    exitCode = code ?? 1;
  });
  while (Date.now() - started < START_TIMEOUT_MS) {
    if (exitCode !== undefined) {
      throw Object.assign(new Error("authoring UI process exited before it started listening"), {
        code: "authoring.ui_start_failed"
      });
    }
    const live = await readLiveAuthoringUi(productionRoot, spec, adapterId);
    if (live) return { ...live, reused: false, pid: child.pid };
    await delay(100);
  }
  throw Object.assign(new Error("authoring UI did not become ready"), {
    code: "authoring.ui_start_timeout"
  });
}

async function readListenFile(listenPath) {
  try {
    const stats = await lstat(listenPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > LISTEN_MAX_BYTES) return undefined;
    const parsed = JSON.parse(await readFile(listenPath, "utf8"));
    const host = parsed?.host;
    const port = parsed?.port;
    if ((host !== "127.0.0.1" && host !== "localhost")
      || typeof port !== "number"
      || !Number.isInteger(port)
      || port <= 0
      || port >= 65536) {
      return undefined;
    }
    return { host, port, stopped: parsed.stopped === true };
  } catch {
    return undefined;
  }
}

async function probeReady(host, port, readyPath, productionRoot, adapterId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`http://${host}:${port}${readyPath ?? "/state"}`, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal
    });
    if (response.status < 200 || response.status >= 400) return false;
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) return false;
    const body = await response.json();
    return matchesReadyIdentity(body, productionRoot, adapterId);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function matchesReadyIdentity(body, productionRoot, adapterId) {
  if (!body || body.ok !== true) return false;
  const identity = body.identity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return false;
  if (identity.adapter !== adapterId) return false;
  return identity.productionRoot === productionRoot;
}

function sanitizedEnv(env) {
  const out = { ...env };
  for (const key of UNSAFE_ENV) delete out[key];
  return out;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function isContainedPath(root, candidate) {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}
