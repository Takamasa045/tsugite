/**
 * HyperFrames official CLI catalog loader (vendor-owned).
 * Advisory only: does not prove install/render/capability readiness.
 */
import { execFile, spawn } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CATALOG_TIMEOUT_MS = 5_000;
export const CATALOG_MAX_STDOUT_BYTES = 1024 * 1024;
export const CATALOG_MAX_ITEMS = 500;
export const CATALOG_SCHEMA_VERSION = 1;
export const CATALOG_SOURCE = "hyperframes";
export const CATALOG_ARGS = Object.freeze(["catalog", "--json"]);

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MAX_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_TAG_LENGTH = 64;
const MAX_TAG_COUNT = 32;
const MAX_WARNING_COUNT = 50;
const MAX_WARNING_LENGTH = 240;
const STOP_GRACE_MS = 500;
const STOP_HARD_MS = 500;
/** Short hard cap for a single Windows taskkill invocation. */
export const TASKKILL_TIMEOUT_MS = 1_000;
/**
 * Upper bound for the full stop sequence (soft+hard taskkill/signal + waits).
 * Keeps timeout/output-limit paths from hanging the catalog request forever.
 */
export const STOP_TOTAL_BUDGET_MS =
  TASKKILL_TIMEOUT_MS * 2 + STOP_GRACE_MS + STOP_HARD_MS + 250;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
// Absolute, home, relative, Windows drive, and UNC path shapes.
// Include ":" so glued forms like path:/Users/... or path:C:\... are rejected.
const UNSAFE_PATH =
  /(?:^|[\s"'`=:(,;|])(?:~(?:[\\/]|$)|(?:\.{1,2})[\\/]|\/(?!\/)|[A-Za-z]:(?:[\\/]|[^\\/\s"'`)]|$)|\\\\)/;
const FILE_URL = /file:\/\//i;
// Secret-ish keys with =/: values, space-separated opaque tokens, and common raw secret shapes.
// Space-separated values require length >= 12 so phrases like "token economy" stay allowed.
const SECRET_CANDIDATE =
  /(?:api[_-]?key|access[_-]?key|secret|password|private[_-]?key|authorization|bearer|token|credential|session(?:id|_id)?)\s*[=:]\s*\S+|(?:api[_-]?key|access[_-]?key|secret|password|private[_-]?key|authorization|bearer|token|credential|session(?:id|_id)?)\s+[A-Za-z0-9\/+=_.-]{12,}|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/i;

function failure(code, message) {
  return {
    ok: false,
    issue: { code, message }
  };
}

function hasUnsafeText(value) {
  return CONTROL_CHARS.test(value)
    || UNSAFE_PATH.test(value)
    || FILE_URL.test(value)
    || SECRET_CANDIDATE.test(value);
}

function isSafeId(value) {
  return value.length > 0
    && value.length <= MAX_ID_LENGTH
    && SAFE_ID.test(value)
    && !hasUnsafeText(value);
}

function isSafeDisplayText(value, maxLength) {
  return value.length > 0
    && value.length <= maxLength
    && !hasUnsafeText(value);
}

function isSafeTag(value) {
  return value.length > 0
    && value.length <= MAX_TAG_LENGTH
    && SAFE_ID.test(value)
    && !hasUnsafeText(value);
}

function isPositiveFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizeDurationSeconds(value) {
  if (!isPositiveFiniteNumber(value)) return undefined;
  const rounded = Math.round(value * 1000) / 1000;
  if (rounded <= 0 || rounded > 86_400) return undefined;
  return rounded;
}

function normalizeDimensions(value) {
  if (typeof value !== "object" || value === null) return undefined;
  const width = "width" in value ? value.width : undefined;
  const height = "height" in value ? value.height : undefined;
  if (!isPositiveFiniteNumber(width) || !isPositiveFiniteNumber(height)) return undefined;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return undefined;
  if (width > 16_384 || height > 16_384) return undefined;
  return { width, height };
}

function pushWarning(warnings, message) {
  if (warnings.length >= MAX_WARNING_COUNT) return;
  const trimmed = message.slice(0, MAX_WARNING_LENGTH);
  if (!trimmed || hasUnsafeText(trimmed)) return;
  warnings.push(trimmed);
}

function sanitizeCatalogEntry(entry, index, warnings) {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    pushWarning(warnings, `omitted[${index}]: entry is not an object`);
    return null;
  }

  const record = entry;
  const name = record.name;
  const type = record.type;
  const title = record.title;
  const description = record.description;
  const tags = record.tags;

  if (typeof name !== "string" || !isSafeId(name)) {
    pushWarning(warnings, `omitted[${index}]: invalid name`);
    return null;
  }
  if (type !== "block" && type !== "component") {
    pushWarning(warnings, `omitted[${index}]: invalid type`);
    return null;
  }
  if (typeof title !== "string" || !isSafeDisplayText(title, MAX_TITLE_LENGTH)) {
    pushWarning(warnings, `omitted[${index}]: invalid title`);
    return null;
  }
  if (
    typeof description !== "string"
    || !isSafeDisplayText(description, MAX_DESCRIPTION_LENGTH)
  ) {
    pushWarning(warnings, `omitted[${index}]: invalid description`);
    return null;
  }
  if (!Array.isArray(tags) || tags.length === 0 || tags.length > MAX_TAG_COUNT) {
    pushWarning(warnings, `omitted[${index}]: invalid tags`);
    return null;
  }
  if (!tags.every((tag) => typeof tag === "string" && isSafeTag(tag))) {
    pushWarning(warnings, `omitted[${index}]: unsafe tag`);
    return null;
  }

  const item = {
    id: name,
    type,
    title,
    description,
    tags: [...tags]
  };

  const dimensions = normalizeDimensions(record.dimensions);
  if (dimensions) item.dimensions = dimensions;

  const durationSeconds = normalizeDurationSeconds(record.duration);
  if (durationSeconds !== undefined) item.durationSeconds = durationSeconds;

  return item;
}

/**
 * Resolve and verify the repo-local HyperFrames CLI entrypoint.
 * Never uses PATH / npx / shell resolution for the package itself.
 */
export function resolveHyperframesCliEntrypoint(repoRoot = REPO_ROOT) {
  const require = createRequire(join(repoRoot, "package.json"));
  let packageJsonPath;
  try {
    packageJsonPath = require.resolve("hyperframes/package.json");
  } catch {
    return null;
  }

  let packageRoot;
  let entry;
  try {
    packageRoot = realpathSync(dirname(packageJsonPath));
    entry = realpathSync(join(packageRoot, "bin", "hyperframes.mjs"));
    accessSync(entry, constants.R_OK);
  } catch {
    return null;
  }

  const relativeToPackage = relative(packageRoot, entry);
  if (
    !relativeToPackage
    || relativeToPackage.startsWith(`..${sep}`)
    || relativeToPackage === ".."
  ) {
    return null;
  }

  // Prefer packages installed under this repo's node_modules tree.
  try {
    const nodeModulesRoot = realpathSync(join(repoRoot, "node_modules"));
    const relativeToNodeModules = relative(nodeModulesRoot, packageRoot);
    if (
      !relativeToNodeModules
      || relativeToNodeModules.startsWith(`..${sep}`)
      || relativeToNodeModules === ".."
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return entry;
}

function minimalSpawnEnv() {
  const env = {
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "C",
    LC_ALL: process.env.LC_ALL,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    SYSTEMROOT: process.env.SYSTEMROOT,
    windir: process.env.windir,
    NODE_OPTIONS: undefined
  };
  // Drop undefined keys so spawn does not inherit accidental blanks as overrides.
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return env;
}

/**
 * Kill a Windows process tree via taskkill /T /F.
 * Always settles within timeoutMs; failures and hangs are reported, not swallowed.
 *
 * @returns {Promise<{ ok: boolean, timedOut: boolean, code?: string | null }>}
 */
export function taskkillWindowsTree(pid, options = {}) {
  const execFileImpl = options.execFile ?? execFile;
  const timeoutMs = options.timeoutMs ?? TASKKILL_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    let proc = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        proc?.kill?.();
      } catch {
        // best-effort cancel of hung taskkill
      }
      finish({ ok: false, timedOut: true, code: "ETIMEDOUT" });
    }, timeoutMs);
    timer.unref?.();

    try {
      proc = execFileImpl(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, shell: false },
        (error) => {
          if (!error) {
            finish({ ok: true, timedOut: false });
            return;
          }
          finish({
            ok: false,
            timedOut: Boolean(error.killed),
            code: error && typeof error === "object" && "code" in error
              ? (error.code == null ? null : String(error.code))
              : null
          });
        }
      );
    } catch (error) {
      finish({
        ok: false,
        timedOut: false,
        code: error && typeof error === "object" && "code" in error
          ? String(error.code ?? "EXEC_ERROR")
          : "EXEC_ERROR"
      });
    }
  });
}

function bestEffortKillChild(child, signal) {
  try {
    child.kill?.(signal);
  } catch {
    // Already exited or signal unsupported on this handle.
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function errorCode(error) {
  return error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
}

/**
 * Process existence probe.
 * Uses kill(pid, 0): no signal is delivered.
 * Only ESRCH means gone; EPERM and other permission/unknown errors stay alive.
 *
 * @param {number} pid
 * @param {{ kill?: (pid: number, signal?: number | string) => boolean }} [options]
 */
export function isProcessAlive(pid, options = {}) {
  if (!pid) return false;
  const killFn = options.kill ?? process.kill.bind(process);
  try {
    killFn(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH is definitive "gone". EPERM etc. → treat as still alive.
    return errorCode(error) !== "ESRCH";
  }
}

/**
 * POSIX process-group existence probe.
 * Uses kill(-pgid, 0): no signal is delivered; ESRCH means the group is gone.
 * EPERM and other permission/unknown errors stay alive (unclean).
 *
 * @param {number} pgid
 * @param {{ kill?: (pid: number, signal?: number | string) => boolean }} [options]
 */
export function isProcessGroupAlive(pgid, options = {}) {
  if (!pgid || !Number.isInteger(pgid) || pgid <= 0) return false;
  const killFn = options.kill ?? process.kill.bind(process);
  try {
    killFn(-pgid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function signalProcessTree(child, signal, options = {}) {
  if (!child.pid) return { ok: true };
  // Windows has no portable POSIX process-group kill without extra deps.
  // taskkill /T stops the full tree (same approach as apps/desktop process-runner).
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const killWindowsTree = options.killWindowsTree
      ?? ((pid) => taskkillWindowsTree(pid, options));
    const result = await killWindowsTree(child.pid);
    if (!result?.ok) {
      // Best-effort: do not leave the direct parent child handle unreaped
      // when taskkill fails or times out.
      bestEffortKillChild(child, signal);
      bestEffortKillChild(child, "SIGKILL");
      return {
        ok: false,
        timedOut: Boolean(result?.timedOut),
        code: result?.code ?? null
      };
    }
    return { ok: true };
  }
  // Prefer the spawn-time group leader (detached child.pid). Fall back to
  // options.processGroupId when the handle is a test double or pid was snapped.
  const pgid = options.processGroupId ?? child.pid;
  try {
    process.kill(-pgid, signal);
    return { ok: true };
  } catch (error) {
    // ESRCH: group already gone — treat as success.
    if (error && typeof error === "object" && error.code === "ESRCH") {
      return { ok: true };
    }
    // Fall through to direct kill when process group is unavailable.
  }
  try {
    child.kill(signal);
    return { ok: true };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH") {
      return { ok: true };
    }
    return {
      ok: false,
      code: error && typeof error === "object" && "code" in error
        ? String(error.code ?? "KILL_ERROR")
        : "KILL_ERROR"
    };
  }
}

async function waitForExit(child, timeoutMs, isAliveFn = isProcessAlive) {
  if (child.exitCode !== null || child.signalCode) {
    return { exited: true, alive: false };
  }
  return await new Promise((resolveWait) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      child.off("error", onError);
      resolveWait({
        exited,
        alive: !exited && isAliveFn(child.pid)
      });
    };
    const onClose = () => finish(true);
    const onError = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("close", onClose);
    child.once("error", onError);
  });
}

/**
 * Bounded poll until a POSIX process group is gone (or timeout).
 * Always resolves in finite time.
 */
async function waitForProcessGroupGone(pgid, timeoutMs, isGroupAliveFn) {
  if (!pgid || !isGroupAliveFn(pgid)) {
    return { gone: true };
  }
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const pollMs = 25;
  while (Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    if (!isGroupAliveFn(pgid)) {
      return { gone: true };
    }
  }
  return { gone: !isGroupAliveFn(pgid) };
}

/**
 * Stop the CLI process and any process-group descendants, then confirm exit.
 * The whole sequence is hard-capped by stopBudgetMs so callers never hang.
 *
 * POSIX: parent close alone is not enough — stubborn same-group children that
 * ignore SIGTERM must be reaped via group SIGKILL + group-liveness probe.
 */
export async function stopCatalogProcess(child, options = {}) {
  if (!child || (!child.pid && child.exitCode !== null)) {
    return { stopped: true, alive: false };
  }

  const platform = options.platform ?? process.platform;
  const isAliveFn = options.isProcessAlive ?? isProcessAlive;
  const isGroupAliveFn = options.isProcessGroupAlive ?? isProcessGroupAlive;
  const signalTree = options.signalProcessTree ?? signalProcessTree;
  const graceMs = options.stopGraceMs ?? STOP_GRACE_MS;
  const hardMs = options.stopHardMs ?? STOP_HARD_MS;
  const budgetMs = options.stopBudgetMs ?? STOP_TOTAL_BUDGET_MS;
  // Capture spawn-time group leader PID up front (detached child is the leader).
  const processGroupId = options.processGroupId
    ?? (typeof child.pid === "number" && child.pid > 0 ? child.pid : null);

  // Windows: already-exited handle means the stop target is gone.
  // POSIX: parent exit can leave SIGTERM-ignoring group members; probe the group.
  if (child.exitCode !== null || child.signalCode) {
    if (platform === "win32") {
      return { stopped: true, alive: false };
    }
    if (!processGroupId || !isGroupAliveFn(processGroupId)) {
      return { stopped: true, alive: false };
    }
    // Group still present after parent close — fall through to kill + wait.
  }

  const treeOptions = { ...options, platform, processGroupId };

  const doStop = async () => {
    if (platform === "win32") {
      // taskkill /T success is mandatory for clean tree stop confirmation.
      // Direct parent kill after taskkill failure is best-effort only and must
      // not report stopped:true (descendants may remain).
      let treeOk = false;

      const softSignal = await signalTree(child, "SIGTERM", treeOptions);
      if (softSignal?.ok === true) treeOk = true;
      await waitForExit(child, graceMs, isAliveFn);

      if (treeOk && !isAliveFn(child.pid)) {
        return { stopped: true, alive: false };
      }

      // Force stage: second bounded retry even when soft tree kill failed.
      const hardSignal = await signalTree(child, "SIGKILL", treeOptions);
      if (hardSignal?.ok === true) treeOk = true;
      await waitForExit(child, hardMs, isAliveFn);

      const parentAlive = isAliveFn(child.pid);
      if (treeOk && !parentAlive) {
        return { stopped: true, alive: false };
      }
      return { stopped: false, alive: parentAlive };
    }

    // --- POSIX path ---
    // Soft TERM the whole group. Parent may exit while descendants ignore TERM.
    await signalTree(child, "SIGTERM", treeOptions);
    await waitForExit(child, graceMs, isAliveFn);

    if (!processGroupId) {
      const alive = isAliveFn(child.pid);
      return { stopped: !alive, alive };
    }

    // Parent exit alone is insufficient: probe the process group.
    if (!isGroupAliveFn(processGroupId)) {
      return { stopped: true, alive: false };
    }

    // Group still present → SIGKILL the whole group, then poll until gone.
    const hardSignal = await signalTree(child, "SIGKILL", treeOptions);
    const groupWait = await waitForProcessGroupGone(
      processGroupId,
      hardMs,
      isGroupAliveFn
    );
    const groupAlive = !groupWait.gone;
    const parentAlive = isAliveFn(child.pid);

    // Kill failure, group remainder, or parent still alive → not clean.
    if (hardSignal?.ok === false || groupAlive || parentAlive) {
      return {
        stopped: false,
        alive: groupAlive || parentAlive
      };
    }
    return { stopped: true, alive: false };
  };

  let budgetTimer;
  try {
    return await Promise.race([
      doStop(),
      new Promise((resolveBudget) => {
        budgetTimer = setTimeout(() => {
          bestEffortKillChild(child, "SIGKILL");
          if (platform !== "win32" && processGroupId) {
            try {
              process.kill(-processGroupId, "SIGKILL");
            } catch {
              // best-effort group kill on budget expiry
            }
          }
          const groupAlive = platform !== "win32" && processGroupId
            ? isGroupAliveFn(processGroupId)
            : false;
          resolveBudget({
            stopped: false,
            alive: isAliveFn(child.pid) || groupAlive
          });
        }, budgetMs);
        budgetTimer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(budgetTimer);
  }
}

export function parseCatalogStdout(stdout) {
  if (stdout.byteLength > CATALOG_MAX_STDOUT_BYTES) {
    return failure(
      "reference_catalog.output_too_large",
      "Reference catalog output exceeded the allowed size"
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout.toString("utf8"));
  } catch {
    return failure(
      "reference_catalog.invalid_json",
      "Reference catalog output was not valid JSON"
    );
  }

  if (!Array.isArray(parsed)) {
    return failure(
      "reference_catalog.schema_unsupported",
      "Reference catalog root must be a JSON array"
    );
  }

  const total = parsed.length;
  const warnings = [];
  if (total > CATALOG_MAX_ITEMS) {
    pushWarning(
      warnings,
      `catalog exceeded ${CATALOG_MAX_ITEMS} entries; extra entries were omitted`
    );
  }

  const limited = parsed.slice(0, CATALOG_MAX_ITEMS);
  const items = [];
  let omitted = Math.max(0, total - limited.length);

  for (const [index, entry] of limited.entries()) {
    const item = sanitizeCatalogEntry(entry, index, warnings);
    if (!item) {
      omitted += 1;
      continue;
    }
    items.push(item);
  }

  if (items.length === 0) {
    return failure(
      "reference_catalog.schema_unsupported",
      "Reference catalog contained no usable entries"
    );
  }

  const byType = { block: 0, component: 0 };
  for (const item of items) {
    byType[item.type] += 1;
  }

  return {
    ok: true,
    schemaVersion: CATALOG_SCHEMA_VERSION,
    source: CATALOG_SOURCE,
    advisoryOnly: true,
    capabilityVerified: false,
    summary: {
      total,
      returned: items.length,
      omitted,
      byType
    },
    items,
    warnings
  };
}

/**
 * Spawn the verified local HyperFrames CLI with process.execPath.
 */
export async function runCatalogCommand(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const execPath = options.execPath ?? process.execPath;
  const entryPath = options.entryPath ?? resolveHyperframesCliEntrypoint(repoRoot);
  const args = options.args ?? [...CATALOG_ARGS];
  const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? CATALOG_MAX_STDOUT_BYTES;
  const cwd = options.cwd ?? repoRoot;
  const env = options.env ?? minimalSpawnEnv();
  const platform = options.platform ?? process.platform;
  const isAliveFn = options.isProcessAlive ?? isProcessAlive;

  if (!entryPath) {
    return {
      exitCode: null,
      stdout: Buffer.alloc(0),
      timedOut: false,
      outputTooLarge: false,
      spawnErrorCode: "ENOENT",
      stoppedCleanly: true
    };
  }

  return await new Promise((resolveCommand) => {
    let settled = false;
    let timedOut = false;
    let outputTooLarge = false;
    let stdoutBytes = 0;
    const stdoutChunks = [];
    let child = null;
    /** @type {number | null} POSIX group leader PID captured at spawn. */
    let processGroupId = null;
    let stopPromise = null;
    let timer = null;

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (stopPromise) {
        let stop = { stopped: true, alive: false };
        try {
          stop = await stopPromise;
        } catch {
          bestEffortKillChild(child, "SIGKILL");
          if (platform !== "win32" && processGroupId) {
            try {
              process.kill(-processGroupId, "SIGKILL");
            } catch {
              // best-effort
            }
          }
          stop = {
            stopped: false,
            alive: isAliveFn(child?.pid)
              || (platform !== "win32" && processGroupId
                ? isProcessGroupAlive(processGroupId)
                : false)
          };
        }
        resolveCommand({
          ...result,
          stoppedCleanly: Boolean(stop.stopped) && !stop.alive
        });
        return;
      }
      resolveCommand({
        ...result,
        stoppedCleanly: true
      });
    };

    try {
      child = spawn(execPath, [entryPath, ...args], {
        shell: false,
        cwd,
        env,
        // New process group so timeout/output limits can stop descendants.
        detached: platform !== "win32",
        stdio: ["ignore", "pipe", "ignore"]
      });
      // Keep the group leader PID even after the parent handle closes.
      if (
        platform !== "win32"
        && typeof child.pid === "number"
        && child.pid > 0
      ) {
        processGroupId = child.pid;
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code ?? "")
        : undefined;
      void finish({
        exitCode: null,
        stdout: Buffer.alloc(0),
        timedOut: false,
        outputTooLarge: false,
        spawnErrorCode: code || "SPAWN_ERROR"
      });
      return;
    }

    const requestStop = () => {
      if (!child || stopPromise) return;
      stopPromise = stopCatalogProcess(child, {
        ...options,
        processGroupId: options.processGroupId ?? processGroupId
      });
    };

    const requestStopAndFinish = (partial) => {
      requestStop();
      void finish({
        exitCode: child?.exitCode ?? null,
        stdout: Buffer.concat(stdoutChunks),
        timedOut,
        outputTooLarge,
        ...partial
      });
    };

    timer = setTimeout(() => {
      timedOut = true;
      // Always resolve after a bounded stop — never wait forever for child close.
      requestStopAndFinish({ timedOut: true });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk) => {
      if (outputTooLarge || settled) return;
      const remaining = maxStdoutBytes - stdoutBytes;
      if (remaining <= 0) {
        outputTooLarge = true;
        requestStopAndFinish({ outputTooLarge: true });
        return;
      }
      if (chunk.length > remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        outputTooLarge = true;
        requestStopAndFinish({ outputTooLarge: true });
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });

    child.once("error", (error) => {
      void finish({
        exitCode: null,
        stdout: Buffer.concat(stdoutChunks),
        timedOut,
        outputTooLarge,
        spawnErrorCode: error.code ?? "SPAWN_ERROR"
      });
    });

    child.once("close", (code) => {
      void finish({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks),
        timedOut,
        outputTooLarge
      });
    });
  });
}

export async function loadCatalog(options = {}) {
  const runCommand = options.runCommand ?? (() => runCatalogCommand(options));
  let commandResult;
  try {
    commandResult = await runCommand();
  } catch {
    return failure(
      "reference_catalog.command_failed",
      "Reference catalog command failed"
    );
  }

  if (commandResult.spawnErrorCode) {
    if (
      commandResult.spawnErrorCode === "ENOENT"
      || commandResult.spawnErrorCode === "ENOTDIR"
    ) {
      return failure(
        "reference_catalog.unavailable",
        "Reference catalog command is unavailable"
      );
    }
    return failure(
      "reference_catalog.command_failed",
      "Reference catalog command failed to start"
    );
  }

  // Unclean stop outranks timeout/output limits: never surface partial stdout.
  if (commandResult.stoppedCleanly === false) {
    return failure(
      "reference_catalog.command_failed",
      "Reference catalog command failed"
    );
  }

  if (commandResult.timedOut) {
    return failure(
      "reference_catalog.timeout",
      "Reference catalog command timed out"
    );
  }

  if (commandResult.outputTooLarge) {
    return failure(
      "reference_catalog.output_too_large",
      "Reference catalog output exceeded the allowed size"
    );
  }

  if (commandResult.exitCode !== 0) {
    return failure(
      "reference_catalog.command_failed",
      "Reference catalog command exited with an error"
    );
  }

  return parseCatalogStdout(commandResult.stdout);
}

export default {
  loadCatalog,
  parseCatalogStdout,
  runCatalogCommand,
  resolveHyperframesCliEntrypoint,
  stopCatalogProcess,
  taskkillWindowsTree,
  isProcessAlive,
  isProcessGroupAlive,
  CATALOG_ARGS,
  CATALOG_TIMEOUT_MS,
  CATALOG_MAX_STDOUT_BYTES,
  CATALOG_MAX_ITEMS,
  CATALOG_SCHEMA_VERSION,
  CATALOG_SOURCE,
  TASKKILL_TIMEOUT_MS,
  STOP_TOTAL_BUDGET_MS
};
