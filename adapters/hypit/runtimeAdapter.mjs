import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertAllowed } from "./permissions.mjs";
import { assertPhase1ObserveTarget } from "./trust.mjs";

const ADAPTER_ROOT = fileURLToPath(new URL(".", import.meta.url));
const PIN = JSON.parse(readFileSync(join(ADAPTER_ROOT, "pin.json"), "utf8"));
const REPO = fileURLToPath(new URL("../..", import.meta.url));

export const HYPIT_PIN = PIN;
export const HYPIT_PACKAGE = PIN.distribution.package;
export const HYPIT_VERSION = PIN.distribution.version;

export function hypitRuntimeDir(root = ADAPTER_ROOT) {
  return join(root, "runtime");
}

export function hypitEntry(root = ADAPTER_ROOT) {
  return join(hypitRuntimeDir(root), "node_modules", "@hypit", "hypit", "bin", "hypit.mjs");
}

export function hypitMissingMessage() {
  return "Hypit runtime is missing. Run npm run hypit:install in the Tsugite repository first.";
}

const ENV_ALLOW = new Set(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM"]);

export function hypitChildEnv(source = process.env, options = {}) {
  const home = options.home ?? join(options.stateHome ?? join(REPO, ".tsugite", "tools", "hypit-host-state"), "home");
  const tmpdir = options.tmpdir ?? join(options.stateHome ?? join(REPO, ".tsugite", "tools", "hypit-host-state"), "tmp");
  const stateHome = options.stateHome ?? join(REPO, ".tsugite", "tools", "hypit-host-state");
  mkdirSync(home, { recursive: true });
  mkdirSync(tmpdir, { recursive: true });
  mkdirSync(stateHome, { recursive: true });
  const env = {
    HOME: home,
    TMPDIR: tmpdir,
    HYPIT_STATE_HOME: stateHome,
    NO_COLOR: "1"
  };
  for (const key of ENV_ALLOW) {
    if (typeof source[key] === "string" && source[key].length > 0) env[key] = source[key];
  }
  if (!env.PATH) env.PATH = "/usr/bin:/bin";
  return env;
}

export function buildObserveArgv(action, options = {}) {
  if (action === "version") return ["--version"];
  if (action === "help") {
    return options.topic ? ["help", options.topic] : ["--help"];
  }
  const argv = [action];
  if (options.source) argv.push(options.source);
  if (options.buildId) argv.push(options.buildId);
  if (options.workspace) argv.push("--workspace", options.workspace);
  if (options.runtime) argv.push("--runtime", options.runtime);
  if (options.assetRoot) argv.push("--asset-root", options.assetRoot);
  if (options.output) argv.push("--output", options.output);
  if (options.to) argv.push("--to", options.to);
  if (options.json) argv.push("--json");
  if (options.verbose) argv.push("--verbose");
  if (options.noColor) argv.push("--no-color");
  return argv;
}

export function runHypit(argv, options = {}) {
  if (options.grants !== undefined) {
    throw Object.assign(new Error("Phase 1 runHypit does not accept grants"), { code: "HYPIT_GRANT_REJECTED" });
  }
  const classification = assertAllowed(argv);
  const adapterRoot = options.adapterRoot ?? ADAPTER_ROOT;
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  assertPhase1ObserveTarget(argv, cwd, adapterRoot, options.repo ?? REPO);
  const entry = options.entry ?? hypitEntry(adapterRoot);
  if (!existsSync(entry)) {
    const error = new Error(hypitMissingMessage());
    error.code = "HYPIT_RUNTIME_MISSING";
    throw error;
  }
  const result = spawnSync(process.execPath, [entry, ...argv], {
    cwd,
    env: hypitChildEnv(options.env ?? process.env, options.childEnv ?? {}),
    encoding: "utf8",
    input: options.input,
    timeout: options.timeoutMs ?? 120_000
  });
  return {
    classification,
    argv,
    entry,
    cwd,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error
  };
}

export function parseJsonOutput(text) {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Hypit output was not JSON");
  }
}

export function adapterRootFrom(url = import.meta.url) {
  return dirname(fileURLToPath(url));
}
