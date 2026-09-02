#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "../../../..");
const SKILL_NAME = "verify-tsugite";
const SUPPORTED_FEATURE = "project-validation";
const EVIDENCE_ROOT = join(REPO_ROOT, "verification", "evidence", SKILL_NAME);
const FIXTURE_SOURCE = join(REPO_ROOT, "examples", "local-fixture");
const COMMAND_TIMEOUT_MS = 30_000;
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,80}$/;

if (process.argv[2] === "__runner") {
  try {
    await runInternalRunner(JSON.parse(process.argv[3]));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      internal_runner: true,
      error: error instanceof Error ? error.message : String(error)
    }, null, 2)}\n`);
    process.exit(1);
  }
}

const { command, options } = parseArgs(process.argv.slice(2));

try {
  const result = await dispatch(command, options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.ok !== true) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    command,
    error: error instanceof Error ? error.message : String(error)
  }, null, 2)}\n`);
  process.exitCode = 1;
}

async function dispatch(action, input) {
  if (action === "launch") return launch(input);
  if (action === "doctor") return doctor(input);
  if (action === "drive") return drive(input);
  if (action === "cleanup") return cleanup(input);
  if (action === "validate-evidence") return validateEvidence(input);
  if (action === "all") return runAll(input);
  throw new Error("usage: verify.mjs launch|doctor|drive|cleanup|validate-evidence|all [--feature project-validation] [--manifest path] [--run-id id]");
}

async function launch(input) {
  const feature = input.feature ?? SUPPORTED_FEATURE;
  if (feature !== SUPPORTED_FEATURE) throw new Error(`unsupported feature '${feature}'`);
  const runId = input.runId ?? defaultRunId();
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("run id must be 8-81 lowercase ASCII letters, digits, or hyphens");

  await assertRepositoryIdentity();
  await assertRegularFile(join(REPO_ROOT, "package-lock.json"));
  await assertDirectoryFollowingLinks(join(REPO_ROOT, "node_modules"));
  await assertRegularFile(join(REPO_ROOT, "node_modules", "tsx", "package.json"));
  await assertRegularFile("/usr/bin/sandbox-exec");

  const scratch = join(tmpdir(), `${SKILL_NAME}-${runId}`);
  const evidenceDir = join(EVIDENCE_ROOT, runId);
  await assertAbsent(scratch, "scratch directory already exists");
  await assertAbsent(evidenceDir, "evidence directory already exists");
  await mkdir(join(scratch, "projects"), { recursive: true, mode: 0o700 });
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });

  const projectRoot = join(scratch, "projects", "local-fixture");
  await assertTreeHasNoSymlinks(FIXTURE_SOURCE);
  await cp(FIXTURE_SOURCE, projectRoot, { recursive: true, errorOnExist: true, force: false });
  const sourceSnapshot = await snapshotTree(FIXTURE_SOURCE);
  const copiedSnapshot = await snapshotTree(projectRoot);
  if (digestJson(sourceSnapshot) !== digestJson(copiedSnapshot)) {
    throw new Error("copied local fixture does not match examples/local-fixture");
  }

  const sourceIdentity = await currentSourceIdentity();
  const manifestPath = join(evidenceDir, "run-manifest.json");
  const manifest = {
    schema_version: 1,
    skill: SKILL_NAME,
    app: "Tsugite",
    feature_id: SUPPORTED_FEATURE,
    entry_point: "CLI: node bin/pipeline validate",
    run_id: runId,
    command: ["node", ".agents/skills/verify-tsugite/scripts/verify.mjs", "all", "--feature", SUPPORTED_FEATURE],
    cwd: REPO_ROOT,
    host: {
      hostname: hostname(),
      platform: process.platform,
      arch: process.arch
    },
    runtime: {
      node: process.version,
      executable: process.execPath
    },
    revision: sourceIdentity.revision,
    source_identity_sha256: sourceIdentity.digest,
    helper_sha256: await sha256File(SCRIPT_PATH),
    package_lock_sha256: await sha256File(join(REPO_ROOT, "package-lock.json")),
    node_modules_realpath: await realpath(join(REPO_ROOT, "node_modules")),
    timestamps: {
      launched_at: new Date().toISOString()
    },
    scratch: {
      root: scratch,
      projects_home: join(scratch, "projects"),
      project_root: projectRoot,
      config: join(projectRoot, "project.yaml")
    },
    evidence_dir: evidenceDir,
    network_policy: {
      mechanism: "macOS sandbox-exec",
      profile: "(version 1) (allow default) (deny network*)",
      network_allowed: false
    },
    fixture_source_sha256: digestJson(sourceSnapshot),
    status: "launched",
    doctor: { status: "pending" },
    drive: { status: "pending" },
    result: "blocked",
    cleanup: { status: "pending" },
    processes: []
  };
  await writeJson(manifestPath, manifest);
  await writeJson(join(scratch, "ownership.json"), {
    run_id: runId,
    evidence_manifest: manifestPath,
    cwd: REPO_ROOT,
    scratch,
    projects_home: manifest.scratch.projects_home,
    created_at: manifest.timestamps.launched_at
  });
  await writeJson(join(evidenceDir, "fixture-source.json"), sourceSnapshot);
  await writeJson(join(evidenceDir, "fixture-copied.json"), copiedSnapshot);

  return { ok: true, command: "launch", run_id: runId, manifest: manifestPath, scratch, status: "launched" };
}

async function doctor(input) {
  const { manifestPath, manifest } = await loadOwnedManifest(input.manifest);
  await assertStaticRunIdentity(manifest);
  if (!["pending", "blocked"].includes(manifest.doctor.status)) {
    return { ok: manifest.doctor.status === "verified", command: "doctor", manifest: manifestPath, status: manifest.doctor.status };
  }

  const before = await snapshotTree(manifest.scratch.project_root);
  const result = await runOwnedPipeline(manifestPath, manifest, "doctor", [
    "doctor",
    "--config",
    manifest.scratch.config,
    "--json"
  ]);
  await writeText(join(manifest.evidence_dir, "doctor.stdout.json"), result.stdout);
  await writeText(join(manifest.evidence_dir, "doctor.stderr.txt"), result.stderr);
  await writeJson(join(manifest.evidence_dir, "doctor.exit.json"), summarizeExit(result));

  const payload = parseJsonOutput(result.stdout, "doctor stdout");
  const checksReady = Array.isArray(payload.checks)
    && payload.checks.length >= 7
    && payload.checks.every((item) => item?.ok === true && item?.status === "ready");
  const after = await snapshotTree(manifest.scratch.project_root);
  const unchanged = digestJson(before) === digestJson(after);
  const ok = result.exit_code === 0 && payload.ok === true && payload.command === "doctor" && checksReady && unchanged;

  manifest.doctor = {
    status: ok ? "verified" : "blocked",
    checked_at: new Date().toISOString(),
    exit_code: result.exit_code,
    checks_ready: checksReady,
    project_unchanged: unchanged,
    evidence: ["doctor.stdout.json", "doctor.stderr.txt", "doctor.exit.json"]
  };
  manifest.status = ok ? "doctor-verified" : "blocked";
  manifest.result = "blocked";
  await writeJson(manifestPath, manifest);
  return { ok, command: "doctor", manifest: manifestPath, status: manifest.doctor.status, checks: payload.checks };
}

async function drive(input) {
  const feature = input.feature ?? SUPPORTED_FEATURE;
  if (feature !== SUPPORTED_FEATURE) throw new Error(`unsupported feature '${feature}'`);
  const { manifestPath, manifest } = await loadOwnedManifest(input.manifest);
  await assertStaticRunIdentity(manifest);
  if (manifest.doctor.status !== "verified") throw new Error("Doctor must be verified before Drive");

  const before = await snapshotTree(manifest.scratch.project_root);
  await writeJson(join(manifest.evidence_dir, "fixture-before.json"), before);
  const result = await runOwnedPipeline(manifestPath, manifest, "drive-project-validation", [
    "validate",
    "--config",
    manifest.scratch.config,
    "--json"
  ]);
  await writeText(join(manifest.evidence_dir, "validate.stdout.json"), result.stdout);
  await writeText(join(manifest.evidence_dir, "validate.stderr.txt"), result.stderr);
  await writeJson(join(manifest.evidence_dir, "validate.exit.json"), summarizeExit(result));
  const after = await snapshotTree(manifest.scratch.project_root);
  await writeJson(join(manifest.evidence_dir, "fixture-after.json"), after);

  const payload = parseJsonOutput(result.stdout, "validate stdout");
  const projectsHomeMatches = await sameExistingPath(payload.launcher_projects_home, manifest.scratch.projects_home);
  const fixtureUnchanged = digestJson(before) === digestJson(after);
  const noPipelineState = !after.files.some((item) =>
    item.path === "state.json"
    || item.path === "run-log.md"
    || item.path === "dist"
    || item.path.startsWith(`dist${sep}`)
  );
  const ok = result.exit_code === 0
    && payload.ok === true
    && payload.command === "validate"
    && Array.isArray(payload.issues)
    && payload.issues.length === 0
    && payload.launcher_already_home === true
    && payload.launcher_linked === false
    && projectsHomeMatches
    && fixtureUnchanged
    && noPipelineState;

  manifest.drive = {
    status: ok ? "verified" : "blocked",
    feature_id: feature,
    completed_at: new Date().toISOString(),
    exit_code: result.exit_code,
    launcher_already_home: payload.launcher_already_home,
    launcher_linked: payload.launcher_linked,
    projects_home_matches: projectsHomeMatches,
    fixture_unchanged: fixtureUnchanged,
    pipeline_state_written: !noPipelineState,
    network_allowed: false,
    evidence: [
      "fixture-before.json",
      "validate.stdout.json",
      "validate.stderr.txt",
      "validate.exit.json",
      "fixture-after.json"
    ]
  };
  manifest.status = ok ? "driven" : "blocked";
  manifest.result = ok ? "verified" : "blocked";
  await writeJson(manifestPath, manifest);
  return { ok, command: "drive", feature_id: feature, manifest: manifestPath, status: manifest.drive.status, observed: manifest.drive };
}

async function cleanup(input) {
  const { manifestPath, manifest } = await loadOwnedManifest(input.manifest, { allowMissingScratch: true });
  if (manifest.cleanup.status === "complete") {
    return { ok: true, command: "cleanup", manifest: manifestPath, status: "complete", idempotent: true };
  }

  const termination = await terminateOwnedProcesses(manifest);
  if (!termination.ok) {
    manifest.cleanup = { status: "blocked", checked_at: new Date().toISOString(), issue: termination.issue };
    manifest.result = "blocked";
    await writeJson(manifestPath, manifest);
    return { ok: false, command: "cleanup", manifest: manifestPath, status: "blocked", issue: termination.issue };
  }

  let scratchRemoved = false;
  if (await exists(manifest.scratch.root)) {
    await assertOwnedScratch(manifest);
    await rm(manifest.scratch.root, { recursive: true, force: false });
    scratchRemoved = true;
  }
  const cleanupEvidence = {
    run_id: manifest.run_id,
    scratch: manifest.scratch.root,
    scratch_removed: scratchRemoved || !await exists(manifest.scratch.root),
    evidence_preserved: await exists(manifestPath),
    terminated_processes: termination.terminated,
    completed_at: new Date().toISOString()
  };
  await writeJson(join(manifest.evidence_dir, "cleanup.json"), cleanupEvidence);
  manifest.cleanup = {
    status: cleanupEvidence.scratch_removed && cleanupEvidence.evidence_preserved ? "complete" : "blocked",
    completed_at: cleanupEvidence.completed_at,
    scratch_removed: cleanupEvidence.scratch_removed,
    evidence_preserved: cleanupEvidence.evidence_preserved,
    evidence: ["cleanup.json"]
  };
  manifest.status = manifest.cleanup.status === "complete" ? "cleaned" : "blocked";
  if (manifest.cleanup.status !== "complete") manifest.result = "blocked";
  await writeJson(manifestPath, manifest);
  return { ok: manifest.cleanup.status === "complete", command: "cleanup", manifest: manifestPath, status: manifest.cleanup.status, cleanup: manifest.cleanup };
}

async function validateEvidence(input) {
  const { manifestPath, manifest } = await loadOwnedManifest(input.manifest, { allowMissingScratch: true });
  const required = [
    "run-manifest.json",
    "fixture-source.json",
    "fixture-copied.json",
    "doctor.stdout.json",
    "doctor.stderr.txt",
    "doctor.exit.json",
    "fixture-before.json",
    "validate.stdout.json",
    "validate.stderr.txt",
    "validate.exit.json",
    "fixture-after.json",
    "cleanup.json"
  ];
  const missing = [];
  for (const name of required) {
    try {
      await assertRegularFile(join(manifest.evidence_dir, name));
    } catch {
      missing.push(name);
    }
  }
  const before = missing.includes("fixture-before.json") ? undefined : JSON.parse(await readFile(join(manifest.evidence_dir, "fixture-before.json"), "utf8"));
  const after = missing.includes("fixture-after.json") ? undefined : JSON.parse(await readFile(join(manifest.evidence_dir, "fixture-after.json"), "utf8"));
  const fixtureSource = missing.includes("fixture-source.json") ? undefined : JSON.parse(await readFile(join(manifest.evidence_dir, "fixture-source.json"), "utf8"));
  const fixtureCopied = missing.includes("fixture-copied.json") ? undefined : JSON.parse(await readFile(join(manifest.evidence_dir, "fixture-copied.json"), "utf8"));
  const doctorPayload = missing.includes("doctor.stdout.json") ? undefined : JSON.parse(await readFile(join(manifest.evidence_dir, "doctor.stdout.json"), "utf8"));
  const doctorExit = missing.includes("doctor.exit.json") ? undefined : JSON.parse(await readFile(join(manifest.evidence_dir, "doctor.exit.json"), "utf8"));
  const validatePayload = missing.includes("validate.stdout.json") ? undefined : JSON.parse(await readFile(join(manifest.evidence_dir, "validate.stdout.json"), "utf8"));
  const validateExit = missing.includes("validate.exit.json") ? undefined : JSON.parse(await readFile(join(manifest.evidence_dir, "validate.exit.json"), "utf8"));
  const cleanupRecord = missing.includes("cleanup.json") ? undefined : JSON.parse(await readFile(join(manifest.evidence_dir, "cleanup.json"), "utf8"));
  const processOwnershipValid = manifest.processes.length === 2 && manifest.processes.every((item) =>
    isPositivePid(item.pid)
    && item.process_group === item.pid
    && item.cwd === REPO_ROOT
    && item.status === "exited"
    && item.exit_code === 0
    && item.argv[0] === "/usr/bin/sandbox-exec"
    && item.argv[2] === "(version 1) (allow default) (deny network*)"
    && ["doctor", "validate"].includes(item.argv[5])
  );
  const checks = {
    manifest_result_verified: manifest.result === "verified",
    doctor_verified: manifest.doctor.status === "verified",
    doctor_output_ok: doctorPayload?.ok === true
      && doctorPayload?.command === "doctor"
      && Array.isArray(doctorPayload?.checks)
      && doctorPayload.checks.length >= 7
      && doctorPayload.checks.every((item) => item?.ok === true && item?.status === "ready"),
    doctor_exit_ok: doctorExit?.exit_code === 0 && doctorExit?.signal === null && doctorExit?.timed_out === false,
    drive_verified: manifest.drive.status === "verified",
    cleanup_complete: manifest.cleanup.status === "complete",
    cleanup_record_ok: cleanupRecord?.run_id === manifest.run_id
      && cleanupRecord?.scratch === manifest.scratch.root
      && cleanupRecord?.scratch_removed === true
      && cleanupRecord?.evidence_preserved === true,
    scratch_absent: !await exists(manifest.scratch.root),
    evidence_complete: missing.length === 0,
    launch_copy_equal: fixtureSource !== undefined
      && fixtureCopied !== undefined
      && digestJson(fixtureSource) === digestJson(fixtureCopied)
      && digestJson(fixtureSource) === manifest.fixture_source_sha256,
    fixture_readback_equal: before !== undefined && after !== undefined && digestJson(before) === digestJson(after),
    validation_ok: validatePayload?.ok === true && validatePayload?.command === "validate",
    validation_exit_ok: validateExit?.exit_code === 0 && validateExit?.signal === null && validateExit?.timed_out === false,
    process_ownership_valid: processOwnershipValid,
    no_external_network: manifest.network_policy?.network_allowed === false
      && manifest.drive?.network_allowed === false
      && manifest.processes.every((item) => item.argv[0] === "/usr/bin/sandbox-exec" && item.argv[2] === manifest.network_policy.profile),
    no_gate_or_render: manifest.processes.every((item) => !item.argv.some((arg) => ["gate", "render", "run"].includes(arg)))
  };
  const ok = Object.values(checks).every(Boolean);
  const report = { ok, command: "validate-evidence", manifest: manifestPath, run_id: manifest.run_id, checks, missing };
  await writeJson(join(manifest.evidence_dir, "evidence-validation.json"), report);
  return report;
}

async function runAll(input) {
  const launched = await launch(input);
  const manifest = launched.manifest;
  let failure;
  try {
    const doctorResult = await doctor({ manifest });
    if (!doctorResult.ok) throw new Error("Doctor was blocked");
    const driveResult = await drive({ manifest, feature: input.feature ?? SUPPORTED_FEATURE });
    if (!driveResult.ok) throw new Error("Drive was blocked");
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const cleanupResult = await cleanup({ manifest });
  if (!cleanupResult.ok && !failure) failure = "Cleanup was blocked";
  const validationResult = await validateEvidence({ manifest });
  return {
    ok: !failure && validationResult.ok,
    command: "all",
    feature_id: input.feature ?? SUPPORTED_FEATURE,
    manifest,
    result: validationResult.ok && !failure ? "verified" : "blocked",
    ...(failure ? { failure } : {}),
    evidence_validation: validationResult.checks
  };
}

async function runOwnedPipeline(manifestPath, manifest, phase, pipelineArgs) {
  const gate = join(manifest.scratch.root, `${phase}-${Date.now()}.gate`);
  const actualArgv = [
    "/usr/bin/sandbox-exec",
    "-p",
    manifest.network_policy.profile,
    process.execPath,
    "bin/pipeline",
    ...pipelineArgs
  ];
  const runnerOptions = {
    runId: manifest.run_id,
    gate,
    command: actualArgv[0],
    args: actualArgv.slice(1),
    cwd: REPO_ROOT,
    env: { TSUGITE_PROJECTS_HOME: manifest.scratch.projects_home }
  };
  const child = spawn(process.execPath, [SCRIPT_PATH, "__runner", JSON.stringify(runnerOptions)], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const observedIdentity = await waitForRunnerIdentity(child.pid);
  const record = {
    phase,
    pid: child.pid,
    process_group: observedIdentity?.pgid ?? child.pid,
    cwd: REPO_ROOT,
    argv: actualArgv,
    started_at: new Date().toISOString(),
    status: observedIdentity ? "running" : "ownership-blocked",
    identity_verified_at: observedIdentity ? new Date().toISOString() : null
  };
  manifest.processes.push(record);
  await writeJson(manifestPath, manifest);
  if (!observedIdentity) {
    const exit = await waitForExit(child, 6_000);
    record.status = "ownership-blocked";
    record.ended_at = new Date().toISOString();
    record.exit_code = exit.code;
    record.signal = exit.signal;
    await writeJson(manifestPath, manifest);
    child.unref();
    throw new Error(`could not verify runner PID/process group before ${phase}`);
  }
  await writeText(gate, `${manifest.run_id}\n`);

  const exit = await waitForExit(child, COMMAND_TIMEOUT_MS);
  if (exit.timed_out) {
    const terminated = await terminateOneProcessRecord(record);
    record.timeout_termination = terminated;
  }
  record.status = exit.timed_out ? "timed-out" : "exited";
  record.ended_at = new Date().toISOString();
  record.exit_code = exit.code;
  record.signal = exit.signal;
  await writeJson(manifestPath, manifest);
  await rm(gate, { force: true });
  child.unref();
  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    exit_code: exit.code,
    signal: exit.signal,
    timed_out: exit.timed_out,
    argv: actualArgv
  };
}

async function waitForRunnerIdentity(pid) {
  if (!isPositivePid(pid)) return undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = processRows().find((item) => item.pid === pid);
    if (row
      && row.pgid === pid
      && row.command.includes("verify-tsugite/scripts/verify.mjs")
      && row.command.includes("__runner")) {
      return row;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  return undefined;
}

async function runInternalRunner(options) {
  assertInternalRunnerOptions(options);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await exists(options.gate)) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  if (!await exists(options.gate)) throw new Error("runner ownership gate was not opened");
  const gateRunId = (await readFile(options.gate, "utf8")).trim();
  if (gateRunId !== options.runId) throw new Error("runner ownership gate does not match the run id");
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: minimalChildEnvironment(options.env),
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  const exit = await new Promise((resolvePromise) => child.once("exit", (code, signal) => resolvePromise({ code, signal })));
  process.exit(exit.code ?? 1);
}

function minimalChildEnvironment(extra) {
  const allowed = ["PATH", "TMPDIR", "LANG", "LC_ALL", "TERM"];
  const environment = {};
  for (const name of allowed) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return { ...environment, ...extra, NO_COLOR: "1" };
}

function assertInternalRunnerOptions(options) {
  if (!options || typeof options !== "object") throw new Error("invalid internal runner options");
  if (!RUN_ID_PATTERN.test(options.runId)) throw new Error("invalid internal runner run id");
  const scratch = join(tmpdir(), `${SKILL_NAME}-${options.runId}`);
  const projectsHome = join(scratch, "projects");
  const config = join(projectsHome, "local-fixture", "project.yaml");
  const allowedCommands = ["doctor", "validate"];
  const pipelineArgs = options.args?.slice(4);
  const exactPrefix = ["-p", "(version 1) (allow default) (deny network*)", process.execPath, "bin/pipeline"];
  if (options.command !== "/usr/bin/sandbox-exec"
    || options.cwd !== REPO_ROOT
    || !Array.isArray(options.args)
    || !exactPrefix.every((item, index) => options.args[index] === item)
    || !Array.isArray(pipelineArgs)
    || pipelineArgs.length !== 4
    || !allowedCommands.includes(pipelineArgs[0])
    || pipelineArgs[1] !== "--config"
    || pipelineArgs[2] !== config
    || pipelineArgs[3] !== "--json"
    || options.gate !== join(scratch, `${pipelineArgs[0] === "doctor" ? "doctor" : "drive-project-validation"}-${options.gate.split("-").at(-1)}`)
    || Object.keys(options.env ?? {}).length !== 1
    || options.env.TSUGITE_PROJECTS_HOME !== projectsHome) {
    throw new Error("internal runner options are outside the verify-tsugite allowlist");
  }
}

async function terminateOwnedProcesses(manifest) {
  const running = manifest.processes.filter((item) => ["running", "timed-out", "ownership-blocked"].includes(item.status));
  const terminated = [];
  for (const record of running) {
    if (!isPositivePid(record.pid) || record.process_group !== record.pid) {
      return { ok: false, terminated, issue: `invalid recorded PID/process group for ${record.phase}` };
    }
    if (!isProcessAlive(record.pid)) continue;
    const result = await terminateOneProcessRecord(record);
    if (!result.ok) return { ok: false, terminated, issue: result.issue };
    terminated.push(...result.pids);
  }
  return { ok: true, terminated };
}

async function terminateOneProcessRecord(record) {
  const rows = processRows().filter((row) => row.pgid === record.process_group);
  const owner = rows.find((row) => row.pid === record.pid);
  if (!owner || !owner.command.includes("verify-tsugite/scripts/verify.mjs") || !owner.command.includes("__runner")) {
    return { ok: false, pids: [], issue: `refusing to signal unverified PID ${record.pid}` };
  }
  const pids = rows.map((row) => row.pid).filter(isPositivePid).sort((a, b) => b - a);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") return { ok: false, pids: [], issue: `failed to signal PID ${pid}: ${error.message}` };
    }
  }
  return { ok: true, pids };
}

function processRows() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout.split("\n").map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] } : undefined;
  }).filter(Boolean);
}

function isProcessAlive(pid) {
  if (!isPositivePid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function isPositivePid(value) {
  return Number.isSafeInteger(value) && value > 1;
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise({ code: null, signal: "TIMEOUT", timed_out: true }), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, timed_out: false });
    });
  });
}

async function loadOwnedManifest(inputPath, options = {}) {
  if (!inputPath) throw new Error("--manifest is required");
  const manifestPath = resolve(inputPath);
  const evidenceRootReal = await realpath(EVIDENCE_ROOT);
  const manifestParentReal = await realpath(dirname(manifestPath));
  if (!isWithin(evidenceRootReal, manifestParentReal) || dirname(manifestPath) === evidenceRootReal || manifestPath !== join(manifestParentReal, "run-manifest.json")) {
    throw new Error("manifest must be a run-manifest.json directly below the verify-tsugite evidence root");
  }
  await assertRegularFile(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.skill !== SKILL_NAME || manifest.feature_id !== SUPPORTED_FEATURE || manifest.evidence_dir !== manifestParentReal) {
    throw new Error("manifest identity does not match verify-tsugite project-validation");
  }
  if (!options.allowMissingScratch || await exists(manifest.scratch.root)) await assertOwnedScratch(manifest);
  return { manifestPath, manifest };
}

async function assertStaticRunIdentity(manifest) {
  await assertOwnedScratch(manifest);
  const current = await currentSourceIdentity();
  if (current.revision !== manifest.revision || current.digest !== manifest.source_identity_sha256) {
    throw new Error("repository source identity changed after Launch");
  }
  if (await sha256File(SCRIPT_PATH) !== manifest.helper_sha256) throw new Error("verification helper changed after Launch");
  if (await sha256File(join(REPO_ROOT, "package-lock.json")) !== manifest.package_lock_sha256) throw new Error("package-lock.json changed after Launch");
  if (await realpath(join(REPO_ROOT, "node_modules")) !== manifest.node_modules_realpath) throw new Error("node_modules identity changed after Launch");
  const copied = await snapshotTree(manifest.scratch.project_root);
  if (digestJson(copied) !== manifest.fixture_source_sha256) throw new Error("run-owned fixture changed before the requested action");
}

async function assertOwnedScratch(manifest) {
  const scratch = resolve(manifest.scratch.root);
  const expectedName = `${SKILL_NAME}-${manifest.run_id}`;
  if (dirname(scratch) !== resolve(tmpdir()) || !scratch.endsWith(`${sep}${expectedName}`)) throw new Error("scratch path is outside the exact run-owned temp boundary");
  await assertDirectory(scratch);
  const ownershipPath = join(scratch, "ownership.json");
  await assertRegularFile(ownershipPath);
  const ownership = JSON.parse(await readFile(ownershipPath, "utf8"));
  if (ownership.run_id !== manifest.run_id || ownership.evidence_manifest !== join(manifest.evidence_dir, "run-manifest.json") || ownership.scratch !== scratch) {
    throw new Error("scratch ownership record does not match the evidence manifest");
  }
}

async function assertRepositoryIdentity() {
  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (root.status !== 0 || resolve(root.stdout.trim()) !== REPO_ROOT) throw new Error("helper is not running from the Tsugite repository identity");
  const packageJson = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
  if (packageJson.name !== "tsugite") throw new Error("package.json product identity is not tsugite");
}

async function currentSourceIdentity() {
  const revisionResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  const statusResult = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: REPO_ROOT });
  const diffResult = spawnSync("git", ["diff", "--binary", "--no-ext-diff", "--", "."], { cwd: REPO_ROOT });
  if (revisionResult.status !== 0 || statusResult.status !== 0 || diffResult.status !== 0) throw new Error("could not establish Git source identity");
  const hash = createHash("sha256");
  hash.update(revisionResult.stdout.trim());
  hash.update(statusResult.stdout);
  hash.update(diffResult.stdout);
  const entries = statusResult.stdout.toString("utf8").split("\0").filter(Boolean);
  for (const entry of entries) {
    if (!entry.startsWith("?? ")) continue;
    const path = entry.slice(3);
    const absolute = resolve(REPO_ROOT, path);
    if (!isWithin(REPO_ROOT, absolute) || !await exists(absolute)) continue;
    const identity = await lstat(absolute);
    if (identity.isFile()) {
      hash.update(path);
      hash.update(await readFile(absolute));
    }
  }
  return { revision: revisionResult.stdout.trim(), digest: hash.digest("hex") };
}

async function snapshotTree(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute);
      const identity = await lstat(absolute);
      if (identity.isSymbolicLink()) throw new Error(`symlink is not allowed in verification fixture: ${path}`);
      if (identity.isDirectory()) {
        files.push({ path, type: "directory", mode: identity.mode & 0o777 });
        await visit(absolute);
      } else if (identity.isFile()) {
        files.push({ path, type: "file", size: identity.size, mode: identity.mode & 0o777, sha256: await sha256File(absolute) });
      } else {
        throw new Error(`unsupported fixture entry: ${path}`);
      }
    }
  }
  await visit(root);
  return { root: "local-fixture", files };
}

async function assertTreeHasNoSymlinks(root) {
  await snapshotTree(root);
}

async function sameExistingPath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  try {
    return await realpath(left) === await realpath(right);
  } catch {
    return false;
  }
}

async function assertRegularFile(path) {
  const identity = await lstat(path);
  if (!identity.isFile() || identity.isSymbolicLink()) throw new Error(`expected a regular file: ${path}`);
}

async function assertDirectory(path) {
  const identity = await lstat(path);
  if (!identity.isDirectory()) throw new Error(`expected a directory: ${path}`);
}

async function assertDirectoryFollowingLinks(path) {
  const identity = await stat(path);
  if (!identity.isDirectory()) throw new Error(`expected a directory: ${path}`);
}

async function assertAbsent(path, message) {
  if (await exists(path)) throw new Error(`${message}: ${path}`);
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function isWithin(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function writeText(path, value) {
  await writeFile(path, value, { mode: 0o600 });
}

function parseJsonOutput(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function summarizeExit(result) {
  return {
    argv: result.argv,
    exit_code: result.exit_code,
    signal: result.signal,
    timed_out: result.timed_out,
    completed_at: new Date().toISOString()
  };
}

function defaultRunId() {
  const timestamp = new Date().toISOString().replaceAll(/[-:.]/g, "").replace("Z", "z").toLowerCase();
  return `${timestamp}-${randomBytes(3).toString("hex")}`;
}

function parseArgs(argv) {
  const command = argv[0] ?? "";
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!["--feature", "--manifest", "--run-id"].includes(token)) throw new Error(`unknown option '${token}'`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
    index += 1;
    if (token === "--feature") options.feature = value;
    if (token === "--manifest") options.manifest = value;
    if (token === "--run-id") options.runId = value;
  }
  return { command, options };
}
