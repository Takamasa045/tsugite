/**
 * Production orchestrator: intake → author → check/plan → approve → gated build
 * → inspect/get → artifact → revision. Adapter-side; uses neutral authoringEngine records.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Bytes } from "./digest.mjs";
import {
  allowlistDigest,
  assertAuthoredWorkspace,
  assertContainedExportPath
} from "./authoredTrust.mjs";
import {
  authoredEvidence,
  invokeAuthorAgent,
  snapshotSources,
  startAuthorAgentProcess
} from "./agentBridge.mjs";
import { authorChildEnv, authorSandboxDir } from "./authorProfile.mjs";
import { intakeLocalReference } from "./referenceIntake.mjs";
import {
  collectExecutionBinding,
  distributionDigest,
  parseHypitBuildId,
  parseHypitStatusOutcome,
  runProductionHypit,
  runtimeDigest
} from "./productionRuntime.mjs";
import { readHypitCost, assertCostNotInvented } from "./cost.mjs";
import { inferSilentFlag, writeProductionReview } from "./productionReview.mjs";
export { writeProductionReview } from "./productionReview.mjs";
import { parseJsonOutput, hypitChildEnv } from "./runtimeAdapter.mjs";
import { prepareLocalRuntime } from "./runtimeSetup.mjs";
import {
  acceptAuthoringBuild,
  approveAuthoringPlan,
  assertLocalRenderAllowed,
  assertPaidBuildAllowed,
  bindAuthoringPlan,
  createAuthoringEngineRun,
  markAuthoringIntentUnknown,
  persistAuthoringSubmissionIntent,
  recordAuthoringBuildOutcome,
  reviseAuthoringRun,
  unknownAuthoringCost,
  assertAuthoringRunIdle,
  invalidateAuthoringPlan,
  digestAuthoringRun
} from "../../src/productionControl/authoringEngine.js";

const ADAPTER_ROOT = fileURLToPath(new URL(".", import.meta.url));

export function productionStatePath(productionRoot) {
  return join(productionRoot, ".tsugite", "authoring", "state.json");
}

export function productionLockPath(productionRoot) {
  return join(productionRoot, ".tsugite", "authoring", "state.lock");
}

export const AUTHORING_LOCK_SCHEMA = "tsugite.authoring.lock@1";
export const AUTHORING_LOCK_RECOVER_SCHEMA = "tsugite.authoring.lock-recover@1";

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function probePid(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return "invalid";
  try {
    kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error && error.code === "ESRCH") return "dead";
    if (error && error.code === "EPERM") return "alive";
    return "unknown";
  }
}

function parseLockOwner(raw, schema) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw ?? "").trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed).sort();
  if (keys.join(",") !== "acquired_at,pid,schema,token") return null;
  if (parsed.schema !== schema) return null;
  if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
  if (typeof parsed.token !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.token)) return null;
  if (typeof parsed.acquired_at !== "string" || !Number.isFinite(Date.parse(parsed.acquired_at))) return null;
  return parsed;
}

function parseAuthoringLockOwner(raw) {
  const text = String(raw ?? "").trim();
  if (/^[1-9][0-9]{0,15}$/.test(text)) {
    return { schema: "legacy-pid", pid: Number(text), token: null, acquired_at: null };
  }
  return parseLockOwner(text, AUTHORING_LOCK_SCHEMA);
}

function makeLockOwner(schema) {
  return {
    schema,
    pid: process.pid,
    token: randomUUID(),
    acquired_at: new Date().toISOString()
  };
}

function writeLockOwner(fd, owner) {
  writeSync(fd, `${JSON.stringify(owner)}\n`);
  fsyncSync(fd);
}

function readLockRaw(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error && (error.code === "EACCES" || error.code === "EPERM")) {
      throw codedError("PC_LOCK_UNSAFE", "authoring lock permission denied");
    }
    if (error && error.code === "ENOENT") return null;
    throw codedError("PC_LOCK_UNSAFE", "authoring lock is unreadable");
  }
}

function lstatLock(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    if (error && (error.code === "EACCES" || error.code === "EPERM")) {
      throw codedError("PC_LOCK_UNSAFE", "authoring lock permission denied");
    }
    throw codedError("PC_LOCK_UNSAFE", "authoring lock is unreadable");
  }
}

function openOwnedLock(path, owner) {
  const fd = openSync(path, "wx");
  try {
    writeLockOwner(fd, owner);
    return fd;
  } catch (error) {
    try { closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(path); } catch { /* ignore */ }
    throw error;
  }
}

function releaseOwnedPath(path, fd, token, parseOwner) {
  try { closeSync(fd); } catch { /* ignore */ }
  try {
    const owner = parseOwner(readFileSync(path, "utf8"));
    if (owner && owner.token === token) unlinkSync(path);
  } catch {
    // Never unlink a lock whose identity is uncertain.
  }
}

function acquireRecoverMutex(recoverPath, probe) {
  const owner = makeLockOwner(AUTHORING_LOCK_RECOVER_SCHEMA);
  try {
    const fd = openOwnedLock(recoverPath, owner);
    return { fd, token: owner.token };
  } catch (error) {
    if (!error || error.code !== "EEXIST") {
      if (error && (error.code === "EACCES" || error.code === "EPERM")) {
        throw codedError("PC_LOCK_UNSAFE", "authoring recover mutex permission denied");
      }
      throw error;
    }
  }
  // Fail-closed: never rename/unlink an existing recover mutex. Two recoverers
  // reading a dead mutex would otherwise steal a live successor.
  const raw = readLockRaw(recoverPath);
  if (raw == null) {
    throw codedError("PC_LOCK_CONFLICT", `authoring recover mutex exists but could not be read: ${recoverPath}`);
  }
  const existing = parseLockOwner(raw, AUTHORING_LOCK_RECOVER_SCHEMA);
  if (!existing) {
    throw codedError(
      "PC_LOCK_UNSAFE",
      `authoring recover mutex is foreign and was left unchanged: ${recoverPath}. Remove it only after confirming no recovery process is running.`
    );
  }
  const liveness = probe(existing.pid);
  if (liveness === "alive") {
    throw codedError("PC_LOCK_CONFLICT", `authoring recover mutex is held by pid ${existing.pid}: ${recoverPath}`);
  }
  if (liveness === "dead") {
    throw codedError(
      "PC_LOCK_UNSAFE",
      `authoring recover mutex is leftover from interrupted recovery (pid ${existing.pid} is dead) and was left unchanged: ${recoverPath}. Remove this file only after confirming no recovery process is running, then retry. Stale state.lock without a leftover recover mutex can still be recovered.`
    );
  }
  throw codedError(
    "PC_LOCK_UNSAFE",
    `authoring recover mutex liveness is unknown and was left unchanged: ${recoverPath}`
  );
}

function reclaimDeadAuthoringLock(lockPath, probe, hooks) {
  const st = lstatLock(lockPath);
  if (!st) return;
  if (st.isSymbolicLink() || !st.isFile()) {
    throw codedError("PC_LOCK_UNSAFE", "authoring lock identity is foreign");
  }
  const raw = readLockRaw(lockPath);
  if (raw == null) return;
  const owner = parseAuthoringLockOwner(raw);
  if (!owner) throw codedError("PC_LOCK_UNSAFE", "authoring lock identity is foreign");
  const liveness = probe(owner.pid);
  if (liveness === "alive") throw codedError("PC_LOCK_CONFLICT", "authoring lock is held");
  if (liveness !== "dead") throw codedError("PC_LOCK_UNSAFE", "authoring lock owner liveness is unknown");
  hooks?.beforeReclaimUnlink?.({ owner, identity: { dev: st.dev, ino: st.ino } });
  const st2 = lstatLock(lockPath);
  if (!st2) return;
  if (st2.dev !== st.dev || st2.ino !== st.ino) {
    throw codedError("PC_LOCK_CONFLICT", "authoring lock identity changed");
  }
  const again = parseAuthoringLockOwner(readLockRaw(lockPath) ?? "");
  if (!again || again.pid !== owner.pid || again.token !== owner.token || again.schema !== owner.schema) {
    throw codedError("PC_LOCK_CONFLICT", "authoring lock identity changed");
  }
  unlinkSync(lockPath);
}

export function recoverStaleAuthoringLock(lockPath, options = {}) {
  const probe = options.probePid ?? ((pid) => probePid(pid));
  const recoverPath = `${lockPath}.recover`;
  const mutex = acquireRecoverMutex(recoverPath, probe);
  try {
    reclaimDeadAuthoringLock(lockPath, probe, options.hooks);
  } finally {
    releaseOwnedPath(recoverPath, mutex.fd, mutex.token, (raw) => parseLockOwner(raw, AUTHORING_LOCK_RECOVER_SCHEMA));
  }
}

export function withProductionLock(productionRoot, fn, options = {}) {
  const dir = join(productionRoot, ".tsugite", "authoring");
  mkdirSync(dir, { recursive: true });
  const lockPath = productionLockPath(productionRoot);
  const probe = options.probePid ?? ((pid) => probePid(pid));
  const owner = makeLockOwner(AUTHORING_LOCK_SCHEMA);
  const acquire = () => openOwnedLock(lockPath, owner);
  let fd;
  try {
    fd = acquire();
  } catch (error) {
    if (error && error.code === "EEXIST") {
      recoverStaleAuthoringLock(lockPath, { probePid: probe, hooks: options.hooks });
      try {
        fd = acquire();
      } catch (retryError) {
        if (retryError && retryError.code === "EEXIST") {
          throw codedError("PC_LOCK_CONFLICT", "authoring lock is held");
        }
        if (retryError && (retryError.code === "EACCES" || retryError.code === "EPERM")) {
          throw codedError("PC_LOCK_UNSAFE", "authoring lock permission denied");
        }
        throw retryError;
      }
    } else if (error && (error.code === "EACCES" || error.code === "EPERM")) {
      throw codedError("PC_LOCK_UNSAFE", "authoring lock permission denied");
    } else {
      throw error;
    }
  }
  const release = () => releaseOwnedPath(lockPath, fd, owner.token, parseAuthoringLockOwner);
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return Promise.resolve(result).finally(release);
    }
    release();
    return result;
  } catch (error) {
    release();
    throw error;
  }
}

export function loadProductionState(productionRoot) {
  const path = productionStatePath(productionRoot);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function saveProductionState(productionRoot, state) {
  const path = productionStatePath(productionRoot);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  writeAuthoringHtml(productionRoot, state);
  return path;
}

export function independentWorkspace(productionRoot) {
  return join(productionRoot, "hypit-workspace");
}

function productionIdFromRoot(productionRoot) {
  const base = basename(productionRoot);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(base) ? base : "production";
}

function childEnvFor(productionRoot, env) {
  const stateHome = join(productionRoot, ".tsugite", "hypit-host-state");
  return hypitChildEnv(env ?? process.env, { stateHome, home: join(stateHome, "home"), tmpdir: join(stateHome, "tmp") });
}

function authorEnvFor(workspace, env) {
  const sandbox = authorSandboxDir(workspace);
  return authorChildEnv(env ?? process.env, { home: join(sandbox, "home"), tmpdir: join(sandbox, "tmp") });
}

export function collectLiveBinding(state, argv, adapterRoot = ADAPTER_ROOT) {
  return collectExecutionBinding(state.workspace, state.run.plan_digest, argv, adapterRoot);
}

function isPidAlive(pid) {
  const result = probePid(pid);
  return result === "alive" || result === "unknown";
}

const GENERIC_INTAKE_BRIEF = "ローカルの参照映像から制作する。";

function hasOwn(object, key) {
  return object != null && Object.prototype.hasOwnProperty.call(object, key);
}

function assertNoActiveAuthoringMutation(state, action) {
  if (!state) return;
  if (state.job?.status === "running" || state.ui?.progress === "author-running") {
    throw Object.assign(new Error(`${action} is blocked while an author job is running`), {
      code: "PC_LOCK_CONFLICT"
    });
  }
  assertAuthoringRunIdle(state.run, action);
}

function sourcesReadyForPlan(state) {
  return Boolean(state?.author?.status === "authored" && state.needs_reauthor !== true);
}

export async function intakeReference(productionRoot, sourceMp4, options = {}) {
  return withProductionLock(productionRoot, async () => {
    const existing = loadProductionState(productionRoot);
    assertNoActiveAuthoringMutation(existing, "intake");
    const requestedId = hasOwn(options, "production_id")
      ? String(options.production_id ?? "")
      : undefined;
    if (requestedId !== undefined && requestedId.length === 0) {
      throw codedError("PC_IDENTITY_MISMATCH", "intake refuses an empty production_id");
    }
    if (requestedId !== undefined && existing?.run?.production_id && requestedId !== existing.run.production_id) {
      throw codedError(
        "PC_IDENTITY_MISMATCH",
        `intake refuses production_id mismatch: existing ${existing.run.production_id}`
      );
    }
    const brief = hasOwn(options, "brief")
      ? String(options.brief ?? "")
      : (typeof existing?.brief === "string" && existing.brief.length > 0
        ? existing.brief
        : GENERIC_INTAKE_BRIEF);
    const instruction = hasOwn(options, "instruction")
      ? String(options.instruction ?? "")
      : String(existing?.instruction ?? "");
    const briefDigest = sha256Bytes(Buffer.from(brief));
    let nextRunRest;
    if (existing?.run?.digest) {
      const { digest: _digest, ...rest } = invalidateAuthoringPlan(existing.run);
      nextRunRest = rest;
    }
    const workspace = independentWorkspace(productionRoot);
    mkdirSync(workspace, { recursive: true });
    const intake = intakeLocalReference(sourceMp4, workspace);
    const referenceDigest = sha256Bytes(readFileSync(intake.workspace_path));
    const run = nextRunRest
      ? digestAuthoringRun({
        ...nextRunRest,
        brief_digest: briefDigest,
        reference_digest: referenceDigest
      })
      : createAuthoringEngineRun({
        production_id: requestedId ?? existing?.run?.production_id ?? productionIdFromRoot(productionRoot),
        adapter_id: options.adapter_id ?? existing?.run?.adapter_id ?? "authoring-adapter",
        brief_digest: briefDigest,
        reference_digest: referenceDigest,
        import_allowlist_digest: allowlistDigest(ADAPTER_ROOT)
      });
    const state = {
      ...(existing ?? {}),
      productionRoot,
      workspace,
      brief,
      instruction,
      intake,
      run,
      needs_reauthor: Boolean(existing?.author),
      ui: { progress: "intake-complete", fake: false }
    };
    saveProductionState(productionRoot, state);
    return state;
  });
}

export function setInstruction(productionRoot, instruction) {
  return withProductionLock(productionRoot, () => {
    const state = loadProductionState(productionRoot);
    if (!state) throw new Error("intake first");
    assertNoActiveAuthoringMutation(state, "set instruction");
    const next = String(instruction ?? "");
    if (next === String(state.instruction ?? "")) return state;
    state.instruction = next;
    state.needs_reauthor = true;
    if (state.author) state.author = { ...state.author, status: "stale" };
    if (state.run?.digest) state.run = invalidateAuthoringPlan(state.run);
    delete state.plan;
    delete state.review;
    state.ui = { progress: "instruction-set", fake: false };
    saveProductionState(productionRoot, state);
    return state;
  });
}

const liveAuthorChildren = new Map();

function applyAuthorResult(state, result) {
  state.author = {
    status: result.status,
    promptPath: result.promptPath,
    skillDest: result.skillDest,
    argv: result.argv,
    argv_digest: result.argv_digest,
    exitStatus: result.exitStatus,
    written: result.written,
    before: result.before,
    after: result.after,
    parentCommand: result.parentCommand,
    reason: result.reason,
    evidence: result.evidence
  };
  if (result.status === "authored") state.needs_reauthor = false;
  state.job = { ...(state.job ?? {}), status: result.status === "authored" ? "finished" : result.status, finished_at: new Date().toISOString() };
  state.ui = { progress: result.status, fake: false };
  return state;
}

export function reconcileAuthorJob(productionRoot, loaded) {
  const state = loaded ?? JSON.parse(readFileSync(productionStatePath(productionRoot), "utf8"));
  const job = state.job;
  if (!job || job.status !== "running") return state;
  if (isPidAlive(job.pid) || liveAuthorChildren.has(productionRoot)) return state;
  const after = snapshotSources(state.workspace);
  const evidence = authoredEvidence(job.before ?? {}, after);
  let status = "incomplete";
  if (evidence.complete && evidence.changed) status = "authored";
  else if (evidence.complete) status = "noop";
  applyAuthorResult(state, {
    status,
    promptPath: job.promptPath,
    skillDest: job.skillDest,
    argv: job.argv,
    argv_digest: job.argv_digest,
    exitStatus: job.exitStatus ?? null,
    written: evidence.written.map((name) => join(state.workspace, name)),
    before: job.before,
    after,
    parentCommand: job.parentCommand,
    reason: "author process exited; status from source hashes"
  });
  saveProductionState(productionRoot, state);
  return state;
}

export function registerAuthorResult(productionRoot, result) {
  return withProductionLock(productionRoot, () => {
    const state = JSON.parse(readFileSync(productionStatePath(productionRoot), "utf8"));
    const after = snapshotSources(state.workspace);
    const evidence = authoredEvidence(result.before ?? {}, result.after ?? after);
    applyAuthorResult(state, {
      status: result.status ?? (evidence.complete && evidence.changed ? "authored" : "incomplete"),
      promptPath: result.promptPath,
      skillDest: result.skillDest,
      argv: result.argv,
      argv_digest: result.argv_digest,
      exitStatus: result.exitStatus,
      written: result.written ?? evidence.written.map((name) => join(state.workspace, name)),
      before: result.before,
      after: result.after ?? after,
      parentCommand: result.parentCommand,
      evidence: "registered from actual author-result.json; stdout omitted"
    });
    saveProductionState(productionRoot, state);
    return state;
  });
}

export function authorSources(productionRoot, options = {}) {
  if (options.runCommand || options.wait === true) {
    return withProductionLock(productionRoot, () => {
      const state = JSON.parse(readFileSync(productionStatePath(productionRoot), "utf8"));
      if (!state) throw new Error("intake first");
      assertNoActiveAuthoringMutation(state, "author");
      const result = invokeAuthorAgent({
        workspace: state.workspace,
        productionRoot,
        brief: state.brief,
        instruction: state.instruction,
        reference: state.intake?.workspace_path,
        runCommand: options.runCommand,
        env: options.env,
        childEnv: options.childEnv ?? authorEnvFor(state.workspace, options.env),
        timeoutMs: options.timeoutMs
      });
      applyAuthorResult(state, result);
      saveProductionState(productionRoot, state);
      return state;
    });
  }
  return withProductionLock(productionRoot, () => {
    const state = JSON.parse(readFileSync(productionStatePath(productionRoot), "utf8"));
    if (!state) throw new Error("intake first");
    assertNoActiveAuthoringMutation(state, "author");
    if (state.job?.status === "running" && isPidAlive(state.job.pid)) {
      throw Object.assign(new Error("author job already running"), { code: "PC_LOCK_CONFLICT" });
    }
    const started = startAuthorAgentProcess({
      workspace: state.workspace,
      productionRoot,
      brief: state.brief,
      instruction: state.instruction,
      reference: state.intake?.workspace_path,
      env: options.env,
      childEnv: options.childEnv ?? authorEnvFor(state.workspace, options.env)
    });
    state.job = {
      kind: "author",
      status: "running",
      pid: started.pid,
      started_at: new Date().toISOString(),
      promptPath: started.promptPath,
      skillDest: started.skillDest,
      argv: started.argv,
      argv_digest: started.argv_digest,
      logPath: started.logPath,
      before: started.before
    };
    state.ui = { progress: "author-running", fake: false };
    saveProductionState(productionRoot, state);
    liveAuthorChildren.set(productionRoot, started.child);
    started.child.on("exit", (code) => {
      liveAuthorChildren.delete(productionRoot);
      withProductionLock(productionRoot, () => {
        const current = JSON.parse(readFileSync(productionStatePath(productionRoot), "utf8"));
        current.job = { ...(current.job ?? {}), exitStatus: code };
        saveProductionState(productionRoot, current);
        reconcileAuthorJob(productionRoot, current);
      });
    });
    return state;
  });
}

const PROGRESS_LABEL = {
  "intake-complete": "参照を取り込みました",
  "instruction-set": "指示を保存しました",
  authored: "ソースができました",
  "author-running": "ソースを書いています",
  noop: "ソースは変わっていません",
  incomplete: "ソースがまだ揃っていません",
  blocked: "ソース作成は止まっています",
  "plan-ready": "計画を確認できます",
  "plan-failed": "計画に失敗しました",
  approved: "実行前の承認が入りました",
  "build-blocked": "実行は止まっています",
  "build-pending": "実行を受け付けました（まだ完成ではありません）",
  "build-complete": "実行は終わりました。受け取り確認が必要です",
  "build-accepted": "完成として受け取りました",
  "build-failed": "実行は失敗しました",
  "build-unknown": "実行結果が不明です。自動ではやり直しません",
  "will-not-auto-repeat": "前回の実行が残っているので自動ではやり直しません",
  exported: "書き出しました",
  "export-failed": "書き出しに失敗しました",
  preview: "プレビューを開きます",
  "feedback-recorded": "フィードバックを残しました",
  "revision-open": "やり直しを開きました",
  "runtime-preparing": "制作環境を準備しています",
  "runtime-not-ready": "制作環境の準備ができませんでした"
};

function costLabel(cost) {
  if (cost.status === "local-only") return "この計画はローカル実行だけです。金額はありません。";
  if (cost.status === "known" && cost.amount !== null) {
    return `見積もり ${cost.amount} ${cost.currency ?? ""}`.trim();
  }
  return "費用はまだ分かっていません。足りない分を0円にはしません。";
}

function deriveTitle(state) {
  const brief = String(state.brief ?? "").trim();
  if (!brief) return "制作";
  const first = brief.split(/[。.\n]/)[0]?.trim() ?? "";
  return first.slice(0, 40) || "制作";
}

function creativeFromPlan(state) {
  const needs = Array.isArray(state.plan?.json?.needs) ? state.plan.json.needs : [];
  const visual = needs.find((item) => item?.summary?.fields?.width);
  const fields = visual?.summary?.fields ?? {};
  const end = Number(fields.endFrameExclusive);
  const rate = String(fields.frameRate ?? "");
  const fps = rate.includes("/") ? Number(rate.split("/")[0]) : Number(rate);
  const duration_s = Number.isFinite(end) && Number.isFinite(fps) && fps > 0 ? end / fps : null;
  const width = fields.width ?? null;
  const height = fields.height ?? null;
  return {
    duration_s,
    width,
    height,
    aspect: width && height ? `${width}×${height}` : null,
    summary: String(state.brief ?? "").slice(0, 280)
  };
}

export function productView(state) {
  if (!state) return null;
  const cost = state.run?.cost ?? {};
  const approval = state.run?.approval;
  const planReady = state.ui?.progress === "plan-ready"
    && Boolean(state.run?.plan_digest)
    && state.runtime?.ready !== false;
  const local = cost.status === "local-only";
  const known = cost.status === "known" && cost.amount !== null;
  const progress = state.ui?.progress ?? "unknown";
  const outcome = state.run?.build?.outcome;
  const hasExport = state.export?.status === 0;
  const complete = outcome === "complete" || outcome === "accepted";
  return {
    title: deriveTitle(state),
    progress,
    progress_label: PROGRESS_LABEL[progress] ?? "いまの進みを確認してください",
    brief: state.brief,
    instruction: state.instruction ?? "",
    reference: state.intake
      ? {
        duration_s: state.intake.duration_s,
        width: state.intake.width,
        height: state.intake.height,
        analysis: state.intake.analysis
      }
      : null,
    author: { status: state.author?.status ?? state.job?.status ?? "none" },
    runtime: state.runtime
      ? {
        status: state.runtime.status ?? null,
        ready: state.runtime.ready === true,
        reason: state.runtime.reason ?? null
      }
      : null,
    plan: {
      ready: planReady,
      cost_status: cost.status ?? "unknown",
      cost_label: costLabel(cost),
      amount: cost.amount ?? null,
      notes: cost.notes ?? [],
      connections: state.plan?.connections ?? [],
      silent_typography: planReady
        ? inferSilentFlag({
          planJson: state.plan?.json ?? state.plan,
          brief: state.brief
        })
        : null
    },
    creative: creativeFromPlan(state),
    review: state.review
      ? { plan_digest: state.review.plan_digest, htmlPath: state.review.htmlPath, dataPath: state.review.dataPath }
      : null,
    approval: approval ? { decision: approval.decision } : null,
    build: state.run?.build ?? null,
    accepted: state.run?.accepted_build_ids ?? [],
    actions: {
      author: {
        enabled: Boolean(state.intake) && state.job?.status !== "running",
        reason: state.job?.status === "running" ? "制作エージェント実行中" : null
      },
      plan: {
        enabled: sourcesReadyForPlan(state),
        reason: sourcesReadyForPlan(state) ? null : "いまの指示に対するソース作成が必要です"
      },
      approve_local: { enabled: local && planReady && !approval, reason: local ? null : "ローカルだけの計画がまだ確認できていません" },
      approve_paid: { enabled: known && planReady && !approval, reason: known ? null : "金額が未確定のため有料承認はできません" },
      build_local: { enabled: approval?.decision === "approve-local-render" && local && !state.needs_reauthor, reason: approval?.decision === "approve-local-render" ? null : "ローカル実行の承認が必要です" },
      build_paid: { enabled: approval?.decision === "approve-plan" && known, reason: "有料実行は確定した金額と承認が必要です" },
      preview: { enabled: complete || hasExport, reason: complete || hasExport ? null : "完成した成果がまだありません" },
      export: { enabled: complete, reason: complete ? null : "書き出せる完成成果がまだありません" },
      accept: { enabled: outcome === "complete", reason: outcome === "complete" ? null : "受け取りは実行完了のあとです" },
      revise: { enabled: Boolean(state.run) }
    }
  };
}

function engineCostFrom(cost) {
  if (cost.status === "local-only") {
    return {
      status: "local-only",
      amount: null,
      currency: null,
      request_count: cost.requestCount,
      notes: cost.notes
    };
  }
  if (cost.status === "known" && cost.amount !== null && cost.currency) {
    return {
      status: "known",
      amount: cost.amount,
      currency: cost.currency,
      request_count: cost.requestCount,
      notes: cost.notes
    };
  }
  return unknownAuthoringCost(cost.requestCount, cost.notes);
}

function planConnections(planJson) {
  if (!planJson || typeof planJson !== "object") return [];
  const providers = Array.isArray(planJson.providers) ? planJson.providers : [];
  return providers.map((item) => ({
    request: item.request ?? null,
    capability: item.capability ?? null,
    status: item.status ?? "unknown",
    endpoint: item.endpoint ?? null,
    pricing: item.pricing ?? { kind: "unknown" }
  }));
}

function runtimeFacts(prepared, extra = {}) {
  return {
    status: extra.status ?? prepared?.status ?? "not-ready",
    ready: extra.ready === true,
    ok: extra.ok === true,
    code: extra.code ?? prepared?.code,
    reason: extra.reason ?? prepared?.reason,
    host_state_mode: prepared?.host_state_mode,
    production_root: prepared?.production_root ?? null,
    init_ran: prepared?.init_ran === true,
    up_ran: prepared?.up_ran === true,
    local_endpoints: prepared?.local_endpoints,
    child_env: prepared?.child_env
      ? { HYPIT_STATE_HOME: prepared.child_env.HYPIT_STATE_HOME }
      : undefined
  };
}

function persistRuntimeFailure(productionRoot, state, input) {
  state.runtime = runtimeFacts(input.prepared, {
    status: "not-ready",
    ready: false,
    ok: false,
    code: input.code,
    reason: input.reason
  });
  if (state.run?.digest) {
    try {
      state.run = invalidateAuthoringPlan(state.run);
    } catch {
      /* pending/unknown already blocked before prepare */
    }
  }
  delete state.plan;
  delete state.review;
  state.ui = { progress: "runtime-not-ready", fake: false, reason: input.reason };
  saveProductionState(productionRoot, state);
  return state;
}

function persistPlanFailure(productionRoot, state, input = {}) {
  if (state.run?.digest) {
    try {
      state.run = invalidateAuthoringPlan(state.run);
    } catch {
      /* pending/unknown already blocked before plan */
    }
  }
  delete state.review;
  state.ui = { progress: "plan-failed", fake: false, reason: input.reason };
  saveProductionState(productionRoot, state);
  return state;
}

function clearAuthoringPlanArtifacts(state) {
  if (state.run?.digest) {
    state.run = invalidateAuthoringPlan(state.run);
  }
  delete state.plan;
  delete state.review;
  delete state.check;
}

export async function planProduction(productionRoot, options = {}) {
  return withProductionLock(productionRoot, async () => {
    const state = loadProductionState(productionRoot);
    if (!state) throw new Error("intake first");
    assertNoActiveAuthoringMutation(state, "plan");
    if (!sourcesReadyForPlan(state)) {
      throw Object.assign(new Error("plan requires authored sources for the current instruction"), {
        code: "PC_AUTHORITY_DENIED"
      });
    }
    assertAuthoredWorkspace(state.workspace);
    clearAuthoringPlanArtifacts(state);
    state.runtime = { status: "preparing", ready: false, ok: false };
    state.ui = { progress: "runtime-preparing", fake: false };
    saveProductionState(productionRoot, state);
    const prepareRuntime = options.prepareRuntime ?? prepareLocalRuntime;
    let prepared;
    try {
      prepared = prepareRuntime({
        workspace: state.workspace,
        productionRoot,
        env: options.env
      });
    } catch (error) {
      return persistRuntimeFailure(productionRoot, state, {
        code: error.code,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
    if (!prepared || prepared.ok !== true || prepared.ready !== true) {
      return persistRuntimeFailure(productionRoot, state, {
        code: prepared?.code ?? "HYPIT_RUNTIME_NOT_READY",
        reason: prepared?.reason ?? "制作環境の準備ができませんでした",
        prepared
      });
    }
    state.runtime = runtimeFacts(prepared, { status: "prepared", ready: true, ok: true });
    saveProductionState(productionRoot, state);
    try {
      const runCli = options.runCli ?? runProductionHypit;
      const collectBinding = options.collectExecutionBinding ?? collectExecutionBinding;
      const env = { cwd: state.workspace, workspace: state.workspace, childEnv: childEnvFor(productionRoot, options.env) };
      const check = runCli(["check", "main.svml", "--workspace", state.workspace, "--json"], env);
      const plan = runCli(["plan", "build.svrun", "--workspace", state.workspace, "--json"], env);
      let planJson;
      try { planJson = parseJsonOutput(plan.stdout); } catch { planJson = undefined; }
      state.check = { status: check.status, stdout: check.stdout, stderr: check.stderr };
      state.plan = {
        status: plan.status,
        stdout: plan.stdout,
        stderr: plan.stderr,
        json: planJson,
        connections: planConnections(planJson)
      };
      if (check.status !== 0 || plan.status !== 0) {
        return persistPlanFailure(productionRoot, state, {
          reason: check.status !== 0
            ? (check.stderr || "check failed")
            : (plan.stderr || "plan failed")
        });
      }
      const cost = assertCostNotInvented(readHypitCost(planJson));
      const adapterRoot = options.adapterRoot ?? ADAPTER_ROOT;
      const live = collectBinding(state.workspace, "0".repeat(64), ["plan"], adapterRoot);
      state.run = bindAuthoringPlan(state.run, {
        source_files: live.source_files,
        asset_files: live.asset_files,
        plan_output_digest: sha256Bytes(Buffer.from(plan.stdout)),
        import_allowlist_digest: live.import_allowlist_digest,
        runtime_digest: live.runtime_digest,
        distribution_digest: live.distribution_digest ?? distributionDigest(adapterRoot),
        runtime_pointer_digest: live.runtime_pointer_digest,
        runtime_profile_digest: live.runtime_profile_digest,
        package_manifest_digest: live.package_manifest_digest,
        cost: engineCostFrom(cost)
      });
      state.ui = { progress: "plan-ready", fake: false };
      if (options.skipReview !== true) {
        state.review = writeProductionReview(productionRoot, state);
      }
      saveProductionState(productionRoot, state);
      return state;
    } catch (error) {
      return persistPlanFailure(productionRoot, state, {
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  });
}

function toHumanDecision(decision, planDigest) {
  const parsed = {
    decision_id: decision.decision_id,
    decision: decision.decision,
    actor: decision.actor,
    decided_at: decision.decided_at,
    subject_digest: decision.subject_digest ?? planDigest
  };
  if (typeof decision.reason === "string" && decision.reason.length > 0) parsed.reason = decision.reason;
  return parsed;
}

export function approveProduction(productionRoot, decision) {
  return withProductionLock(productionRoot, () => {
    const state = loadProductionState(productionRoot);
    if (!state?.run.plan_digest) throw new Error("plan first");
    state.run = approveAuthoringPlan(state.run, toHumanDecision(decision, state.run.plan_digest));
    state.ui = { progress: "approved", fake: false, decision: state.run.approval.decision };
    saveProductionState(productionRoot, state);
    return state;
  });
}

function assertBuildGate(run, options) {
  if (run.submission_intent) {
    throw Object.assign(
      new Error("pending, unknown, or consumed intent cannot spawn again"),
      { code: "PC_SUBMISSION_UNKNOWN" }
    );
  }
  if (options.confirmPaid === true) {
    if (!run.approval || run.approval.decision !== "approve-plan") {
      throw Object.assign(new Error("paid build requires approve-plan"), { code: "PC_AUTHORITY_DENIED" });
    }
    if (run.cost.status !== "known" || run.cost.amount === null) {
      throw Object.assign(new Error("paid build blocked: cost is not known"), { code: "PC_AUTHORITY_DENIED" });
    }
    return "paid";
  }
  if (options.confirmLocalRender === true) {
    if (!run.approval || run.approval.decision !== "approve-local-render") {
      throw Object.assign(new Error("local render requires approve-local-render"), { code: "PC_AUTHORITY_DENIED" });
    }
    if (run.cost.status !== "local-only") {
      throw Object.assign(new Error("local render requires verified local-only plan"), { code: "PC_AUTHORITY_DENIED" });
    }
    return "local";
  }
  throw Object.assign(
    new Error("build requires confirm_paid or confirm_local_render"),
    { code: "PC_AUTHORITY_DENIED" }
  );
}

export function requestBuild(productionRoot, options = {}) {
  return withProductionLock(productionRoot, () => {
    const state = loadProductionState(productionRoot);
    if (!state) throw new Error("intake first");
    const runCli = options.runCli ?? runProductionHypit;
    try {
      assertBuildGate(state.run, options);
    } catch (error) {
      if (error.code === "PC_SUBMISSION_UNKNOWN") {
        state.ui = { progress: "will-not-auto-repeat", fake: false, reason: error.message };
        saveProductionState(productionRoot, state);
        return state;
      }
      state.run = recordAuthoringBuildOutcome(state.run, {
        outcome: "blocked",
        blocked_reason: error.message
      });
      state.ui = { progress: "build-blocked", fake: false, reason: error.message };
      saveProductionState(productionRoot, state);
      return state;
    }

    const argv = ["build", "build.svrun", "--workspace", state.workspace, "--json"];
    const adapterRoot = options.adapterRoot ?? ADAPTER_ROOT;
    const live = collectLiveBinding(state, argv, adapterRoot);
    state.run = persistAuthoringSubmissionIntent(state.run, {
      argv_digest: live.argv_digest,
      created_at: new Date().toISOString(),
      execution_binding: live
    });
    saveProductionState(productionRoot, state);

    try {
      const liveAtSpawn = collectLiveBinding(state, argv, adapterRoot);
      if (options.confirmPaid === true) assertPaidBuildAllowed(state.run, true, liveAtSpawn);
      else assertLocalRenderAllowed(state.run, true, liveAtSpawn);
      const result = runCli(argv, {
        cwd: state.workspace,
        workspace: state.workspace,
        productionRoot,
        confirmPaid: options.confirmPaid === true,
        confirmLocalRender: options.confirmLocalRender === true,
        childEnv: childEnvFor(productionRoot, options.env)
      });
      state.build = { status: result.status, stdout: result.stdout, stderr: result.stderr };
      const buildId = parseHypitBuildId(result.stdout);
      if (!buildId) {
        state.run = markAuthoringIntentUnknown(state.run);
        state.ui = { progress: "build-unknown", fake: false, reason: "unparseable submission; not complete; will not auto-repeat" };
      } else {
        state.run = recordAuthoringBuildOutcome(state.run, { build_id: buildId, outcome: "pending" });
        state.ui = { progress: "build-pending", fake: false, note: "submitted is not complete" };
      }
    } catch (error) {
      state.run = markAuthoringIntentUnknown(state.run);
      state.ui = { progress: "build-unknown", fake: false, reason: error.message };
    }
    saveProductionState(productionRoot, state);
    return state;
  });
}

export function inspectProduction(productionRoot, options = {}) {
  return withProductionLock(productionRoot, () => {
    const state = loadProductionState(productionRoot);
    if (!state) throw new Error("intake first");
    const currentBuildId = state.run?.build?.build_id;
    const requested = hasOwn(options, "buildId") ? options.buildId : undefined;
    const specified = requested != null && String(requested).length > 0;
    if (specified) {
      if (!currentBuildId) {
        throw codedError("PC_BUILD_IDENTITY", "inspect refuses a build_id when the current run has no build");
      }
      if (String(requested) !== currentBuildId) {
        throw codedError(
          "PC_BUILD_IDENTITY",
          `inspect refuses non-current build_id ${requested}; current is ${currentBuildId}`
        );
      }
    }
    const buildId = currentBuildId;
    if (!buildId) throw new Error("no real build_id to inspect");
    const runCli = options.runCli ?? runProductionHypit;
    const status = runCli(["status", buildId, "--workspace", state.workspace, "--json"], {
      cwd: state.workspace,
      workspace: state.workspace,
      childEnv: childEnvFor(productionRoot, options.env)
    });
    const inspect = runCli(["inspect", buildId, "--workspace", state.workspace, "--json"], {
      cwd: state.workspace,
      workspace: state.workspace,
      childEnv: childEnvFor(productionRoot, options.env)
    });
    state.status = { status: status.status, stdout: status.stdout, stderr: status.stderr };
    state.inspect = { status: inspect.status, stdout: inspect.stdout, stderr: inspect.stderr };
    const parsed = parseHypitStatusOutcome(status.stdout);
    if (parsed.kind === "complete" && parsed.buildId === buildId && state.run.build?.outcome === "pending") {
      state.run = recordAuthoringBuildOutcome(state.run, { build_id: buildId, outcome: "complete" });
      state.ui = { progress: "build-complete", fake: false, note: "complete is not accepted" };
    } else if (parsed.kind === "failed" && parsed.buildId === buildId) {
      state.run = recordAuthoringBuildOutcome(state.run, { build_id: buildId, outcome: "failed" });
      state.ui = { progress: "build-failed", fake: false };
    } else {
      state.ui = { progress: state.run.build?.outcome === "complete" ? "build-complete" : "build-pending", fake: false };
    }
    saveProductionState(productionRoot, state);
    return state;
  });
}

export function acceptProduction(productionRoot, options = {}) {
  return withProductionLock(productionRoot, () => {
    const state = loadProductionState(productionRoot);
    if (!state) throw new Error("intake first");
    const buildId = options.buildId ?? state.run.build?.build_id;
    if (!buildId) throw new Error("human acceptance requires a real build_id");
    state.run = acceptAuthoringBuild(state.run, buildId);
    state.ui = { progress: "build-accepted", fake: false };
    saveProductionState(productionRoot, state);
    return state;
  });
}

export function exportProduction(productionRoot, options = {}) {
  return withProductionLock(productionRoot, () => {
    const state = loadProductionState(productionRoot);
    if (!state) throw new Error("intake first");
    const buildId = options.buildId ?? state.run.build?.build_id;
    const output = options.output ?? "final.video";
    if (!buildId) throw new Error("export requires a real build_id");
    const dest = options.to ?? join(state.workspace, "export", `${output.replace(/[^\w.-]+/g, "_")}`);
    mkdirSync(dirname(dest), { recursive: true });
    assertContainedExportPath(state.workspace, dest);
    const runCli = options.runCli ?? runProductionHypit;
    const result = runCli([
      "get", buildId, "--output", output, "--to", dest, "--workspace", state.workspace, "--json"
    ], {
      cwd: state.workspace,
      workspace: state.workspace,
      childEnv: childEnvFor(productionRoot, options.env)
    });
    state.export = { status: result.status, stdout: result.stdout, stderr: result.stderr, to: dest, output };
    state.ui = { progress: result.status === 0 ? "exported" : "export-failed", fake: false };
    saveProductionState(productionRoot, state);
    return state;
  });
}

export function previewProduction(productionRoot) {
  const state = loadProductionState(productionRoot);
  if (!state) throw new Error("intake first");
  state.preview = {
    inspect: state.inspect ?? null,
    export: state.export ?? null,
    cost: state.run.cost,
    connections: state.plan?.connections ?? []
  };
  state.ui = { progress: "preview", fake: false };
  return state;
}

export function feedbackProduction(productionRoot, feedback) {
  return withProductionLock(productionRoot, () => {
    const state = loadProductionState(productionRoot);
    if (!state) throw new Error("intake first");
    const entry = {
      at: new Date().toISOString(),
      actor: feedback.actor ?? "human",
      text: String(feedback.text ?? "").slice(0, 4000)
    };
    state.feedback = [...(state.feedback ?? []), entry];
    state.ui = { progress: "feedback-recorded", fake: false };
    saveProductionState(productionRoot, state);
    return state;
  });
}

export function reviseProduction(productionRoot, options = {}) {
  return withProductionLock(productionRoot, () => {
    const state = loadProductionState(productionRoot);
    if (!state) throw new Error("intake first");
    assertNoActiveAuthoringMutation(state, "revise");
    if (hasOwn(options, "instruction")) state.instruction = String(options.instruction ?? "");
    state.run = reviseAuthoringRun(state.run, { reuse_accepted: true });
    state.needs_reauthor = true;
    if (state.author) state.author = { ...state.author, status: "stale" };
    delete state.plan;
    delete state.review;
    state.ui = { progress: "revision-open", fake: false };
    saveProductionState(productionRoot, state);
    return state;
  });
}

function writeAuthoringHtml(productionRoot, state) {
  const dest = join(productionRoot, ".tsugite", "authoring", "index.html");
  const view = productView(state) ?? {};
  const listen = join(productionRoot, ".tsugite", "authoring", "ui-listen.json");
  let interactive = "";
  if (existsSync(listen)) {
    try {
      const spec = JSON.parse(readFileSync(listen, "utf8"));
      if (spec.host && spec.port && spec.stopped !== true) {
        interactive = `<p><a href="http://${spec.host}:${spec.port}/">制作UIを開く</a></p>`;
      }
    } catch { /* ignore */ }
  }
  writeFileSync(dest, `<!doctype html>
<html lang="ja"><meta charset="utf-8"><title>制作</title>
<body>
<h1>${escapeHtml(view.title ?? "制作")}</h1>
<p>状態: <strong>${escapeHtml(view.progress ?? "unknown")}</strong></p>
<p>費用: ${escapeHtml(view.plan?.cost_status ?? "unknown")}（金額は未確定のまま0にしない）</p>
<p>承認: ${view.approval ? escapeHtml(view.approval.decision) : "まだ"}</p>
<p>参照: ${state.intake ? `${state.intake.width}×${state.intake.height} ${state.intake.duration_s}秒` : "なし"}</p>
${interactive}
<p>制作UI: <code>npm run hypit:production -- ui --production &lt;project&gt;</code></p>
<p>この承認は制作エンジンの人間ゲートです。Tsugite Gate 1 の代替ではありません。</p>
</body></html>
`);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}
