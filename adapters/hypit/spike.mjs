#!/usr/bin/env node
/**
 * Phase 1 spike. Live CLI: version/help/paths/measure/check/plan.
 * Build, runtime up, auth login, transcribe, pricing, and packages install
 * are unconditionally refused. Observation fingerprints are not approvals.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHypitCost, assertCostNotInvented } from "./cost.mjs";
import { fileDigest, observePlanFingerprint, sha256Bytes } from "./digest.mjs";
import {
  buildChatScene,
  isolatedHypitEnv,
  prepareTrustedOfficialWorkspace,
  rewriteChatSceneDependency
} from "./prepareFixture.mjs";
import {
  HYPIT_PACKAGE,
  HYPIT_VERSION,
  buildObserveArgv,
  hypitEntry,
  parseJsonOutput,
  runHypit
} from "./runtimeAdapter.mjs";
import {
  OFFICIAL_PACKAGE_SOURCES,
  OFFICIAL_SOURCE_FILES,
  listUnexpectedJs,
  phase1HostStateDir
} from "./trust.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = join(REPO, "docs/reports/hypit-phase1-evidence");
rmSync(EVIDENCE, { recursive: true, force: true });

function save(name, text) {
  mkdirSync(EVIDENCE, { recursive: true });
  const body = typeof text === "string" ? text : JSON.stringify(text, null, 2);
  writeFileSync(join(EVIDENCE, name), body.endsWith("\n") ? body : `${body}\n`);
}

function record(name, result) {
  save(`${name}.log`, [
    `# ${name}`,
    `status: ${result.status}`,
    `signal: ${result.signal ?? ""}`,
    `argv: ${JSON.stringify(result.argv)}`,
    `cwd: ${result.cwd}`,
    `entry: ${result.entry}`,
    "",
    "## stdout",
    result.stdout,
    "",
    "## stderr",
    result.stderr
  ].join("\n"));
  return result;
}

const report = {
  format: "tsugite.hypit-phase1-spike@1",
  session: "7311a25e-1bf4-4a90-a511-497355f45788",
  package: HYPIT_PACKAGE,
  version: HYPIT_VERSION,
  authorization: false,
  commands: {},
  gaps: []
};

const env = isolatedHypitEnv(process.env, REPO);

function run(name, argv, extra = {}) {
  const result = record(name, runHypit(argv, { cwd: extra.cwd ?? REPO, env, ...extra }));
  report.commands[name] = {
    argv,
    status: result.status,
    stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
    stderrBytes: Buffer.byteLength(result.stderr, "utf8")
  };
  return result;
}

const version = run("version", buildObserveArgv("version"));
if (version.status !== 0 || version.stdout.trim() !== HYPIT_VERSION) {
  report.gaps.push(`version mismatch: expected ${HYPIT_VERSION}, got ${JSON.stringify(version.stdout.trim())}`);
}

run("help", buildObserveArgv("help"));
run("help-plan", buildObserveArgv("help", { topic: "plan" }));
run("help-build", buildObserveArgv("help", { topic: "build" }));
const measure = run("measure", ["measure", "--text", "Are we ready to launch?", "--json"]);

let workspace;
try {
  workspace = await prepareTrustedOfficialWorkspace(REPO);
  const distribution = dirname(dirname(hypitEntry()));
  rewriteChatSceneDependency(workspace, distribution);
  report.chatSceneActivation = buildChatScene(workspace);
  const unexpected = listUnexpectedJs(workspace);
  if (unexpected.length > 0) {
    report.gaps.push(`unexpected JS after compile: ${unexpected.join(", ")}`);
  }
} catch (error) {
  report.gaps.push(`trusted official fixture prepare failed: ${error.message}`);
}

if (workspace) {
  run("paths", buildObserveArgv("paths", { workspace, json: true }), { cwd: workspace });
  run("check", buildObserveArgv("check", {
    source: join(workspace, "chat.svml"),
    workspace,
    json: true
  }), { cwd: workspace });
  run("plan", buildObserveArgv("plan", {
    source: join(workspace, "chat.svrun"),
    workspace,
    json: true
  }), { cwd: workspace });
}

const check = report.commands.check;
const plan = report.commands.plan;
const planLog = workspace ? readFileSync(join(EVIDENCE, "plan.log"), "utf8") : "";
const planStdout = planLog.split("## stdout\n")[1]?.split("\n## stderr")[0] ?? "";

let planJson;
try {
  planJson = parseJsonOutput(planStdout);
  if (planJson) save("plan.json", planJson);
} catch (error) {
  report.gaps.push(`plan JSON parse failed: ${error.message}`);
  save("plan.stdout.txt", planStdout);
}

const cost = assertCostNotInvented(readHypitCost(planJson));
report.cost = cost;

const files = [];
if (workspace) {
  for (const name of [...OFFICIAL_SOURCE_FILES, ...OFFICIAL_PACKAGE_SOURCES, "packages/chat-scene/dist/activation.js", "packages/chat-scene/dist/render.js"]) {
    const path = join(workspace, name);
    if (existsSync(path)) files.push(await fileDigest(path));
  }
}

const observation = observePlanFingerprint({
  distribution: {
    package: HYPIT_PACKAGE,
    version: HYPIT_VERSION,
    entrySha256: sha256Bytes(readFileSync(hypitEntry()))
  },
  workspace: workspace ?? null,
  files,
  runtime: files.find((item) => item.path.endsWith("hypit.runtime.json")) ?? null,
  planSha256: planJson ? sha256Bytes(Buffer.from(JSON.stringify(planJson))) : sha256Bytes(Buffer.from(planStdout)),
  cost
});
report.observation = observation;
save("plan-observation.json", observation);

if (measure.status !== 0) report.gaps.push("measure exited non-zero; see measure.log");
if (!check || check.status !== 0) report.gaps.push("check exited non-zero or did not run; see check.log");
if (!plan || plan.status !== 0) report.gaps.push("plan exited non-zero or did not run; see plan.log");

report.workspace = workspace ?? null;
report.hostState = phase1HostStateDir(REPO);
report.example = `${OFFICIAL_SOURCE_FILES[0]} from pinned ${HYPIT_PACKAGE}@${HYPIT_VERSION} ${"examples/semantic-composition"}`;
report.deniedUnconditionally = ["build", "runtime up", "programs up", "auth login", "transcribe", "pricing", "packages install"];
save("summary.json", report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

const failed = report.gaps.length > 0
  || version.status !== 0
  || version.stdout.trim() !== HYPIT_VERSION
  || measure.status !== 0
  || check?.status !== 0
  || plan?.status !== 0;
if (failed) process.exitCode = 1;
