/**
 * Prepare pinned official local Runtime helpers for a trusted workspace.
 * Distinct from Phase 1 observe lock: this is the production local-only
 * init/up path. It never starts hypihub.default or a whole-profile up.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Bytes } from "./digest.mjs";
import { collectRuntimeSelection } from "./runtimeSelection.mjs";
import {
  HYPIT_PACKAGE,
  HYPIT_VERSION,
  hypitChildEnv,
  hypitEntry,
  hypitMissingMessage,
  hypitRuntimeDir,
  parseJsonOutput
} from "./runtimeAdapter.mjs";

const ADAPTER_ROOT = fileURLToPath(new URL(".", import.meta.url));

/** Outer spawn bound. Official `runtime up` may install local packages for minutes. */
export const LOCAL_RUNTIME_TIMEOUT_MS = 1_200_000;

/** Official video Distribution starter local instances (@hypit/hypit@0.1.8). */
export const LOCAL_STARTER_ENDPOINT_NAMES = Object.freeze(["media.local", "hyperframes.local"]);

const LOCAL_STARTER_USE = Object.freeze({
  "media.local": "@hypit/provider-media-local",
  "hyperframes.local": "@hypit/provider-hyperframes-local"
});

const MEDIA_LOCAL_CONFIG_KEYS = new Set(["defaultConcurrency", "processTimeoutMs", "maxProbeOutputBytes"]);
const HYPERFRAMES_LOCAL_CONFIG_KEYS = new Set([
  "workers",
  "maxWorkers",
  "quality",
  "browserGpu",
  "defaultConcurrency",
  "browserCapacity",
  "initializationTimeoutMs",
  "frameTimeoutMs",
  "processTimeoutMs",
  "maxProcessOutputBytes",
  "maxRenderedBytes"
]);
const ENDPOINT_KEYS = new Set(["use", "config", "pool"]);
const FORBIDDEN_OPTION_KEYS = Object.freeze([
  "argv",
  "command",
  "endpoints",
  "profile",
  "runtime",
  "grants",
  "entry",
  "timeoutMs",
  "stateHome"
]);
const UNSAFE_EXACT_ROOTS = new Set([
  "/",
  "/tmp",
  "/private",
  "/private/tmp",
  "/var",
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/opt",
  "/dev",
  "/root",
  "/home",
  "/Users",
  "/System",
  "/Library",
  "/Applications",
  "/Volumes"
]);
const HOST_STATE_SEGMENTS = Object.freeze([".tsugite", "hypit-host-state"]);
/** Matches orchestrator `independentWorkspace(productionRoot)`. */
export const PRODUCTION_WORKSPACE_NAME = "hypit-workspace";
const DEFAULT_PROFILE_NAME = "hypit.runtime.json";
const POOL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function withinReal(rootReal, candidateReal) {
  const relation = relative(rootReal, candidateReal);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`));
}

function assertRegularNoSymlink(path) {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) {
    throw coded(`symlink refused: ${path}`, "HYPIT_PATH_UNSAFE");
  }
  return st;
}

function lstatIfPresent(path) {
  return lstatSync(path, { throwIfNoEntry: false });
}

function assertExistingContained(rootReal, path, { directory = false, file = false } = {}) {
  const st = lstatIfPresent(path);
  if (!st) return undefined;
  if (st.isSymbolicLink()) {
    throw coded(`symlink refused: ${path}`, "HYPIT_PATH_UNSAFE");
  }
  if (directory && !st.isDirectory()) {
    throw coded(`${path} is not a directory`, "HYPIT_PATH_UNSAFE");
  }
  if (file && !st.isFile()) {
    throw coded(`${path} is not a regular file`, "HYPIT_PATH_UNSAFE");
  }
  const real = realpathSync(path);
  if (!withinReal(rootReal, real)) {
    throw coded(`path escapes workspace: ${path}`, "HYPIT_PATH_UNSAFE");
  }
  return st;
}

/**
 * Official `runtime init` writes workspace/hypit.runtime.json (wx) then
 * `.hypit/runtime`. existsSync follows links, so a `.hypit` directory symlink
 * with no pointer looks like "no profile" and init would write through it.
 * Reject those outputs before any spawn.
 */
function assertSafeInitOutputs(workspaceReal) {
  const hypitDir = join(workspaceReal, ".hypit");
  assertExistingContained(workspaceReal, hypitDir, { directory: true });
  assertExistingContained(workspaceReal, join(workspaceReal, DEFAULT_PROFILE_NAME), { file: true });
  assertExistingContained(workspaceReal, join(hypitDir, "runtime"), { file: true });
}

function assertNoForbiddenOptions(options) {
  for (const key of FORBIDDEN_OPTION_KEYS) {
    if (Object.hasOwn(options, key)) {
      throw coded(
        `prepareLocalRuntime refuses caller-supplied ${key}; argv and endpoints are fixed to official local starters`,
        "HYPIT_PERMISSION_DENIED"
      );
    }
  }
}

export function localRuntimeInitArgv(workspace) {
  return ["runtime", "init", "--workspace", workspace, "--json", "--no-color"];
}

export function localRuntimeUpArgv(workspace) {
  return [
    "runtime",
    "up",
    "--workspace",
    workspace,
    "--endpoint",
    "media.local",
    "--endpoint",
    "hyperframes.local",
    "--json",
    "--no-color"
  ];
}

function isSafeRelativeDataRoot(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (isAbsolute(value) || value.includes("\0") || value.includes("\\")) return false;
  const parts = value.split("/");
  return parts.length > 0 && parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function inspectDataRoot(workspaceReal, dataRoot) {
  if (!isSafeRelativeDataRoot(dataRoot)) {
    return {
      ok: false,
      reason: `runtime dataRoot is not a contained relative path (${dataRoot ?? "missing"})`
    };
  }
  let current = workspaceReal;
  for (const part of dataRoot.split("/")) {
    current = join(current, part);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      return { ok: false, reason: `runtime dataRoot is a symlink: ${current}` };
    }
    const real = realpathSync(current);
    if (!withinReal(workspaceReal, real)) {
      return { ok: false, reason: `runtime dataRoot escapes workspace: ${current}` };
    }
  }
  return { ok: true };
}

function inspectPositiveInteger(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return `${label} is not a positive integer`;
  }
  return undefined;
}

function inspectLocalConfig(name, config) {
  if (config === undefined) return undefined;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return `${name} config is not an object`;
  }
  const allowed = name === "media.local" ? MEDIA_LOCAL_CONFIG_KEYS : HYPERFRAMES_LOCAL_CONFIG_KEYS;
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) {
      return `${name} config ${key} is not part of the official local starter`;
    }
  }
  if (name === "hyperframes.local") {
    if (config.workers !== undefined && config.workers !== "auto") {
      const invalid = inspectPositiveInteger(config.workers, `${name} workers`);
      if (invalid) return invalid;
    }
    if (config.quality !== undefined && config.quality !== "draft" && config.quality !== "standard" && config.quality !== "high") {
      return `${name} quality is not an official local value`;
    }
    if (config.browserGpu !== undefined && config.browserGpu !== "auto" && config.browserGpu !== "software" && config.browserGpu !== "hardware") {
      return `${name} browserGpu is not an official local value`;
    }
  }
  for (const key of Object.keys(config)) {
    if (key === "workers" || key === "quality" || key === "browserGpu") continue;
    const invalid = inspectPositiveInteger(config[key], `${name} ${key}`);
    if (invalid) return invalid;
  }
  return undefined;
}

function inspectOneLocalEndpoint(name, spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return `${name} is missing from the selected profile`;
  }
  for (const key of Object.keys(spec)) {
    if (!ENDPOINT_KEYS.has(key)) {
      return `${name} field ${key} is not part of the official local starter`;
    }
  }
  if (spec.use !== LOCAL_STARTER_USE[name]) {
    return `${name} use is not the official local starter (${spec.use ?? "missing"})`;
  }
  if (spec.pool !== undefined && (typeof spec.pool !== "string" || !POOL_ID.test(spec.pool))) {
    return `${name} pool is not a local instance id`;
  }
  return inspectLocalConfig(name, spec.config);
}

/**
 * Names alone are not trust. media.local / hyperframes.local must match the
 * official local starter packages and local-only config. Does not rewrite.
 */
export function inspectTrustedLocalStarterEndpoints(profile, workspaceReal) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return { ok: false, reason: "runtime profile is not an object", code: "HYPIT_UNTRUSTED_SOURCE" };
  }
  if (profile.format !== "hypit.runtime-local@1") {
    return {
      ok: false,
      reason: `runtime format is not the official local starter (${profile.format ?? "missing"})`,
      code: "HYPIT_UNTRUSTED_SOURCE"
    };
  }
  const dataRoot = inspectDataRoot(workspaceReal, profile.dataRoot);
  if (!dataRoot.ok) {
    return { ok: false, reason: dataRoot.reason, code: "HYPIT_PATH_UNSAFE" };
  }
  const endpoints = profile.endpoints;
  if (!endpoints || typeof endpoints !== "object" || Array.isArray(endpoints)) {
    return { ok: false, reason: "runtime profile has no endpoints object", code: "HYPIT_UNTRUSTED_SOURCE" };
  }
  for (const name of LOCAL_STARTER_ENDPOINT_NAMES) {
    const problem = inspectOneLocalEndpoint(name, endpoints[name]);
    if (problem) {
      return { ok: false, reason: problem, code: "HYPIT_UNTRUSTED_SOURCE" };
    }
  }
  return { ok: true, endpoints: [...LOCAL_STARTER_ENDPOINT_NAMES] };
}

function assertPinnedRuntime(adapterRoot) {
  const pinPath = join(adapterRoot, "pin.json");
  if (!existsSync(pinPath)) {
    throw coded(hypitMissingMessage(), "HYPIT_RUNTIME_MISSING");
  }
  assertRegularNoSymlink(pinPath);
  const pinReal = realpathSync(pinPath);
  if (!withinReal(realpathSync(adapterRoot), pinReal)) {
    throw coded("pin.json escapes adapter root", "HYPIT_PATH_UNSAFE");
  }
  let pin;
  try {
    pin = JSON.parse(readFileSync(pinReal, "utf8"));
  } catch {
    throw coded("pin.json is not JSON", "HYPIT_UNTRUSTED_SOURCE");
  }
  if (pin?.distribution?.package !== HYPIT_PACKAGE || pin?.distribution?.version !== HYPIT_VERSION) {
    throw coded(
      `pinned runtime is not ${HYPIT_PACKAGE}@${HYPIT_VERSION}`,
      "HYPIT_UNTRUSTED_SOURCE"
    );
  }
  const entry = hypitEntry(adapterRoot);
  if (!existsSync(entry)) {
    throw coded(hypitMissingMessage(), "HYPIT_RUNTIME_MISSING");
  }
  const runtimeDir = hypitRuntimeDir(adapterRoot);
  assertRegularNoSymlink(runtimeDir);
  const runtimeReal = realpathSync(runtimeDir);
  const entryReal = realpathSync(entry);
  if (!withinReal(runtimeReal, entryReal)) {
    throw coded("Hypit entry escapes the pinned runtime directory", "HYPIT_PATH_UNSAFE");
  }
  const entryBytes = readFileSync(entryReal);
  const pinBytes = readFileSync(pinReal);
  return {
    package: HYPIT_PACKAGE,
    version: HYPIT_VERSION,
    entry: entryReal,
    digest: sha256Bytes(Buffer.concat([pinBytes, entryBytes]))
  };
}

function assertSafeWorkspace(workspace) {
  if (typeof workspace !== "string" || workspace.length === 0 || workspace.includes("\0")) {
    throw coded("workspace path is not a safe string", "HYPIT_PATH_UNSAFE");
  }
  const resolved = resolve(workspace);
  if (!existsSync(resolved)) {
    throw coded(`workspace does not exist: ${resolved}`, "HYPIT_PATH_UNSAFE");
  }
  const st = assertRegularNoSymlink(resolved);
  if (!st.isDirectory()) {
    throw coded("workspace is not a directory", "HYPIT_PATH_UNSAFE");
  }
  const real = realpathSync(resolved);
  if (UNSAFE_EXACT_ROOTS.has(real)) {
    throw coded(`workspace is an unsafe filesystem root: ${real}`, "HYPIT_PATH_UNSAFE");
  }
  return real;
}

function assertSafeHostStatePath(workspaceReal) {
  let current = workspaceReal;
  for (const part of HOST_STATE_SEGMENTS) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw coded(`host state path is a symlink: ${current}`, "HYPIT_PATH_UNSAFE");
    }
  }
  const home = join(current, "home");
  const tmp = join(current, "tmp");
  for (const path of [home, tmp]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw coded(`host state path is a symlink: ${path}`, "HYPIT_PATH_UNSAFE");
    }
  }
  return current;
}

function childEnvForHostRoot(hostRootReal, sourceEnv) {
  const stateHome = assertSafeHostStatePath(hostRootReal);
  return hypitChildEnv(sourceEnv, {
    stateHome,
    home: join(stateHome, "home"),
    tmpdir: join(stateHome, "tmp")
  });
}

/**
 * Production integrator must pass productionRoot. Host state is then
 * `<productionRoot>/.tsugite/hypit-host-state`, matching orchestrator
 * childEnvFor. Standalone (no productionRoot) keeps workspace-local state
 * for unit fixtures only.
 */
function resolveHostBinding(workspaceReal, productionRoot) {
  if (productionRoot === undefined) {
    return {
      mode: "standalone-workspace",
      hostRoot: workspaceReal,
      productionRoot: null
    };
  }
  const productionReal = assertSafeWorkspace(productionRoot);
  const expected = join(productionReal, PRODUCTION_WORKSPACE_NAME);
  const expectedSt = lstatIfPresent(expected);
  if (!expectedSt) {
    throw coded("productionRoot/hypit-workspace does not exist", "HYPIT_PATH_UNSAFE");
  }
  if (expectedSt.isSymbolicLink()) {
    throw coded(`symlink refused: ${expected}`, "HYPIT_PATH_UNSAFE");
  }
  if (!expectedSt.isDirectory()) {
    throw coded("productionRoot/hypit-workspace is not a directory", "HYPIT_PATH_UNSAFE");
  }
  const expectedReal = realpathSync(expected);
  if (expectedReal !== workspaceReal) {
    throw coded("workspace must be this productionRoot/hypit-workspace", "HYPIT_PATH_UNSAFE");
  }
  if (!withinReal(productionReal, workspaceReal)) {
    throw coded("workspace escapes productionRoot", "HYPIT_PATH_UNSAFE");
  }
  return {
    mode: "production",
    hostRoot: productionReal,
    productionRoot: productionReal
  };
}

function spawnPinnedRuntime(argv, options) {
  const entry = options.entry;
  const result = spawnSync(process.execPath, [entry, ...argv], {
    cwd: options.cwd,
    env: options.childEnv,
    encoding: "utf8",
    timeout: LOCAL_RUNTIME_TIMEOUT_MS
  });
  return {
    argv,
    entry,
    cwd: options.cwd,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error
  };
}

function parseMachineJson(text) {
  if (typeof text !== "string" || text.trim() === "") return undefined;
  try {
    return parseJsonOutput(text);
  } catch {
    return undefined;
  }
}

function spawnFailureReason(result) {
  if (result.error?.code === "ETIMEDOUT") {
    return `pinned runtime timed out after ${LOCAL_RUNTIME_TIMEOUT_MS}ms`;
  }
  if (result.error) return result.error.message;
  if (result.signal) return `pinned runtime exited with signal ${result.signal}`;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n")[0];
    return `pinned runtime exited ${result.status}${detail ? `: ${detail}` : ""}`;
  }
  return undefined;
}

function notReady(fields) {
  return {
    ok: false,
    ready: false,
    status: "not-ready",
    local_endpoints: [...LOCAL_STARTER_ENDPOINT_NAMES],
    init_ran: false,
    up_ran: false,
    ...fields
  };
}

function profileFacts(selection, workspaceReal) {
  if (!selection.profile_path) {
    return { trusted_local: false, inspect: { ok: false, reason: "no runtime profile is selected" } };
  }
  const parsed = JSON.parse(readFileSync(selection.profile_path, "utf8"));
  return { profile: parsed, inspect: inspectTrustedLocalStarterEndpoints(parsed, workspaceReal) };
}

/**
 * Prepare official local media.local and hyperframes.local for one workspace.
 * Caller cannot supply commands, endpoints, or stateHome. Production callers
 * pass productionRoot so host state matches orchestrator childEnvFor.
 * Readiness is only the official CLI machine view.
 */
export function prepareLocalRuntime(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw coded("prepareLocalRuntime requires an options object", "HYPIT_PATH_UNSAFE");
  }
  assertNoForbiddenOptions(options);
  const adapterRoot = options.adapterRoot ?? ADAPTER_ROOT;
  const pinned = assertPinnedRuntime(adapterRoot);
  const workspaceReal = assertSafeWorkspace(options.workspace);
  const host = resolveHostBinding(workspaceReal, options.productionRoot);
  assertSafeInitOutputs(workspaceReal);
  const spawn = options.spawnCli ?? spawnPinnedRuntime;
  const entry = pinned.entry;
  let selection = collectRuntimeSelection(workspaceReal);

  const common = {
    workspace: workspaceReal,
    production_root: host.productionRoot,
    host_state_mode: host.mode,
    pinned_runtime: pinned,
    local_endpoints: [...LOCAL_STARTER_ENDPOINT_NAMES],
    selection: {
      pointer: selection.pointer,
      profile_path: selection.profile_path,
      runtime_pointer_digest: selection.runtime_pointer_digest,
      runtime_profile_digest: selection.runtime_profile_digest,
      package_manifest_digest: selection.package_manifest_digest
    }
  };

  if (selection.pointer) {
    const facts = profileFacts(selection, workspaceReal);
    if (!facts.inspect.ok) {
      return notReady({
        ...common,
        code: facts.inspect.code,
        reason: `${facts.inspect.reason}. Existing profile was left unchanged.`,
        trusted_local: false
      });
    }
  }

  const childEnv = childEnvForHostRoot(host.hostRoot, options.env ?? process.env);
  const spawnOptions = {
    cwd: workspaceReal,
    childEnv,
    env: options.env ?? process.env,
    adapterRoot,
    entry,
    timeoutMs: LOCAL_RUNTIME_TIMEOUT_MS
  };

  let initRan = false;
  let initResult;
  if (!selection.pointer) {
    const initArgv = localRuntimeInitArgv(workspaceReal);
    initResult = spawn(initArgv, spawnOptions);
    initRan = true;
    const initFail = spawnFailureReason(initResult);
    if (initFail) {
      return notReady({
        ...common,
        code: "HYPIT_RUNTIME_NOT_READY",
        reason: `runtime init did not select a profile: ${initFail}`,
        trusted_local: false,
        init_ran: true,
        init_argv: initArgv,
        init: {
          status: initResult.status,
          signal: initResult.signal,
          stdout: initResult.stdout,
          stderr: initResult.stderr,
          json: parseMachineJson(initResult.stdout)
        },
        child_env: {
          HOME: childEnv.HOME,
          TMPDIR: childEnv.TMPDIR,
          HYPIT_STATE_HOME: childEnv.HYPIT_STATE_HOME
        }
      });
    }
    selection = collectRuntimeSelection(workspaceReal);
    common.selection = {
      pointer: selection.pointer,
      profile_path: selection.profile_path,
      runtime_pointer_digest: selection.runtime_pointer_digest,
      runtime_profile_digest: selection.runtime_profile_digest,
      package_manifest_digest: selection.package_manifest_digest
    };
    if (!selection.pointer) {
      return notReady({
        ...common,
        code: "HYPIT_RUNTIME_NOT_READY",
        reason: "runtime init exited 0 but no project runtime pointer was selected",
        trusted_local: false,
        init_ran: true,
        init_argv: initArgv,
        init: {
          status: initResult.status,
          signal: initResult.signal,
          stdout: initResult.stdout,
          stderr: initResult.stderr,
          json: parseMachineJson(initResult.stdout)
        },
        child_env: {
          HOME: childEnv.HOME,
          TMPDIR: childEnv.TMPDIR,
          HYPIT_STATE_HOME: childEnv.HYPIT_STATE_HOME
        }
      });
    }
  }

  const local = profileFacts(selection, workspaceReal);
  if (!local.inspect.ok) {
    return notReady({
      ...common,
      code: local.inspect.code,
      reason: `${local.inspect.reason}. Existing profile was left unchanged.`,
      trusted_local: false,
      init_ran: initRan,
      init_argv: initRan ? localRuntimeInitArgv(workspaceReal) : undefined,
      init: initResult
        ? {
            status: initResult.status,
            signal: initResult.signal,
            stdout: initResult.stdout,
            stderr: initResult.stderr,
            json: parseMachineJson(initResult.stdout)
          }
        : undefined,
      child_env: {
        HOME: childEnv.HOME,
        TMPDIR: childEnv.TMPDIR,
        HYPIT_STATE_HOME: childEnv.HYPIT_STATE_HOME
      }
    });
  }

  const upArgv = localRuntimeUpArgv(workspaceReal);
  const upResult = spawn(upArgv, spawnOptions);
  const upJson = parseMachineJson(upResult.stdout);
  const upFail = spawnFailureReason(upResult);
  const ready = upResult.status === 0
    && upJson?.format === "hypit.cli-runtime-up@1"
    && upJson.ready === true;

  return {
    ok: ready,
    ready,
    status: ready ? "prepared" : "not-ready",
    ...(ready
      ? {}
      : {
          code: "HYPIT_RUNTIME_NOT_READY",
          reason: upFail ?? "runtime up did not report hypit.cli-runtime-up@1 ready=true"
        }),
    workspace: workspaceReal,
    production_root: host.productionRoot,
    host_state_mode: host.mode,
    pinned_runtime: pinned,
    local_endpoints: [...LOCAL_STARTER_ENDPOINT_NAMES],
    trusted_local: true,
    init_ran: initRan,
    up_ran: true,
    init_argv: initRan ? localRuntimeInitArgv(workspaceReal) : undefined,
    up_argv: upArgv,
    selection: {
      pointer: selection.pointer,
      profile_path: selection.profile_path,
      runtime_pointer_digest: selection.runtime_pointer_digest,
      runtime_profile_digest: selection.runtime_profile_digest,
      package_manifest_digest: selection.package_manifest_digest
    },
    init: initResult
      ? {
          status: initResult.status,
          signal: initResult.signal,
          stdout: initResult.stdout,
          stderr: initResult.stderr,
          json: parseMachineJson(initResult.stdout)
        }
      : undefined,
    up: {
      status: upResult.status,
      signal: upResult.signal,
      stdout: upResult.stdout,
      stderr: upResult.stderr,
      json: upJson,
      ready: upJson?.format === "hypit.cli-runtime-up@1" && upJson.ready === true ? true : false,
      worker: typeof upJson?.worker === "string" ? upJson.worker : undefined,
      preparedPackages: typeof upJson?.preparedPackages === "number" ? upJson.preparedPackages : undefined,
      programs: upJson?.programs
    },
    child_env: {
      HOME: childEnv.HOME,
      TMPDIR: childEnv.TMPDIR,
      HYPIT_STATE_HOME: childEnv.HYPIT_STATE_HOME
    }
  };
}
