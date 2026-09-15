/**
 * Production Hypit runtime. Distinct from Phase 1 spike lock.
 * check/plan run on allowlisted authored workspaces. build requires persisted intent.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectRuntimeSelection } from "./runtimeSelection.mjs";
import { claimIntentDispatch, dispatchClaimPath } from "./dispatchClaim.mjs";
export { claimIntentDispatch, dispatchClaimPath } from "./dispatchClaim.mjs";
import { fileURLToPath } from "node:url";
import { assertAllowed, classifyHypitArgv } from "./permissions.mjs";
import {
  assertAuthoredWorkspace,
  assertContainedExportPath,
  assertNoOverrideFlags,
  collectAssetFiles
} from "./authoredTrust.mjs";
import { sha256Bytes } from "./digest.mjs";
import { hypitChildEnv, hypitEntry, hypitMissingMessage, parseJsonOutput } from "./runtimeAdapter.mjs";
import {
  assertExecutionBinding,
  assertPostIntentDispatch,
  authoringEngineRunSchema
} from "../../src/productionControl/authoringEngine.js";

const ADAPTER_ROOT = fileURLToPath(new URL(".", import.meta.url));
const PRODUCTION_OBSERVE = new Set(["check", "plan", "status", "inspect", "builds", "history", "logs", "doctor", "paths"]);

export function runtimeDigest(adapterRoot = ADAPTER_ROOT) {
  const pin = readFileSync(join(adapterRoot, "pin.json"));
  const entry = readFileSync(hypitEntry(adapterRoot));
  return sha256Bytes(Buffer.concat([pin, entry]));
}

export function distributionDigest(adapterRoot = ADAPTER_ROOT) {
  return sha256Bytes(readFileSync(join(adapterRoot, "pin.json")));
}

export function collectExecutionBinding(workspace, planDigest, argv, adapterRoot = ADAPTER_ROOT) {
  const trusted = assertAuthoredWorkspace(workspace, { adapterRoot });
  const selected = collectRuntimeSelection(workspace);
  return {
    plan_digest: planDigest,
    argv_digest: sha256Bytes(Buffer.from(JSON.stringify(argv))),
    import_allowlist_digest: trusted.allowlistDigest,
    runtime_digest: runtimeDigest(adapterRoot),
    distribution_digest: distributionDigest(adapterRoot),
    runtime_pointer_digest: selected.runtime_pointer_digest,
    runtime_profile_digest: selected.runtime_profile_digest,
    package_manifest_digest: selected.package_manifest_digest,
    source_files: trusted.sourceFiles,
    asset_files: collectAssetFiles(workspace)
  };
}

export function loadPersistedProductionState(productionRoot) {
  const path = join(productionRoot, ".tsugite", "authoring", "state.json");
  if (!existsSync(path)) {
    throw Object.assign(new Error("missing persisted authoring state"), { code: "HYPIT_BUILD_GATED" });
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export function spawnHypitCli(argv, options = {}) {
  const entry = options.entry ?? hypitEntry(options.adapterRoot);
  if (!existsSync(entry)) {
    throw Object.assign(new Error(hypitMissingMessage()), { code: "HYPIT_RUNTIME_MISSING" });
  }
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const env = options.childEnv?.HOME
    ? options.childEnv
    : hypitChildEnv(options.env ?? process.env, options.childEnv ?? {});
  const result = spawnSync(process.execPath, [entry, ...argv], {
    cwd,
    env,
    encoding: "utf8",
    input: options.input,
    timeout: options.timeoutMs ?? 120_000
  });
  return {
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

export function parseHypitBuildId(stdout) {
  try {
    const json = parseJsonOutput(stdout);
    const id = json?.build?.id ?? json?.id;
    if (typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) return id;
  } catch {
    return undefined;
  }
  return undefined;
}

export function parseHypitStatusOutcome(stdout) {
  try {
    const json = parseJsonOutput(stdout);
    const build = json?.build;
    if (!build || typeof build !== "object") return { kind: "unknown" };
    const resultState = build.result?.state;
    const workOutcome = build.work?.outcome;
    if (resultState === "complete" || workOutcome === "complete") return { kind: "complete", buildId: build.id };
    if (resultState === "failed" || workOutcome === "failed") return { kind: "failed", buildId: build.id };
    if (resultState === "cancelled" || workOutcome === "cancelled") return { kind: "failed", buildId: build.id };
    return { kind: "pending", buildId: build.id };
  } catch {
    return { kind: "unknown" };
  }
}

function assertPersistedBuildAuthority(argv, options) {
  if (typeof options.submissionIntentDigest === "string" || options.submissionIntent || options.executionBinding) {
    throw Object.assign(
      new Error("production build refuses caller-supplied intent objects; authority is the persisted production state"),
      { code: "HYPIT_BUILD_GATED" }
    );
  }
  if (!options.productionRoot) {
    throw Object.assign(new Error("production build requires productionRoot for persisted intent lookup"), {
      code: "HYPIT_BUILD_GATED"
    });
  }
  if (options.confirmPaid !== true && options.confirmLocalRender !== true) {
    throw Object.assign(
      new Error("production build is gated: confirm_paid or confirm_local_render is required"),
      { code: "HYPIT_BUILD_GATED" }
    );
  }
  const state = loadPersistedProductionState(options.productionRoot);
  const run = authoringEngineRunSchema.parse(state.run);
  assertPostIntentDispatch(run, {
    confirmPaid: options.confirmPaid === true,
    confirmLocalRender: options.confirmLocalRender === true
  });
  if (!options.workspace) {
    throw Object.assign(new Error("production build requires authored workspace"), { code: "HYPIT_BUILD_GATED" });
  }
  const live = collectExecutionBinding(options.workspace, run.plan_digest, argv, options.adapterRoot ?? ADAPTER_ROOT);
  assertExecutionBinding(run, live);
  return { run, intent: run.submission_intent, live };
}

export function runProductionHypit(argv, options = {}) {
  const parsed = classifyHypitArgv(argv);
  const spawn = options.spawnCli ?? spawnHypitCli;
  if (parsed.command === "build") {
    const authorized = assertPersistedBuildAuthority(argv, options);
    assertNoOverrideFlags(argv);
    assertAuthoredWorkspace(options.workspace, options);
    claimIntentDispatch(options.productionRoot, authorized.intent.digest);
    return spawn(argv, options);
  } else if (parsed.command === "get") {
    assertNoOverrideFlags(argv);
    const toIndex = argv.indexOf("--to");
    if (toIndex === -1 || !argv[toIndex + 1]) {
      throw Object.assign(new Error("get requires --to"), { code: "HYPIT_PATH_UNSAFE" });
    }
    if (!options.workspace) {
      throw Object.assign(new Error("get requires authored workspace"), { code: "HYPIT_PATH_UNSAFE" });
    }
    assertAuthoredWorkspace(options.workspace, options);
    assertContainedExportPath(options.workspace, argv[toIndex + 1]);
  } else if (PRODUCTION_OBSERVE.has(parsed.command)) {
    if (parsed.command === "status" && parsed.flags.includes("--watch")) {
      throw Object.assign(new Error("status --watch is refused"), { code: "HYPIT_PERMISSION_DENIED" });
    }
    assertNoOverrideFlags(argv);
    if ((parsed.command === "check" || parsed.command === "plan") && options.workspace) {
      assertAuthoredWorkspace(options.workspace, options);
    }
  } else {
    assertAllowed(argv);
  }
  return spawnHypitCli(argv, options);
}
