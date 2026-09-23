import crossSpawn from "cross-spawn";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Synced from skills/tesseract-{motion,video}/references/cli-version.txt.
export const TESSERACT_CLI_VERSION = "0.1.0";
export const TESSERACT_CLI_DEFAULT_TIMEOUT_MS = 120_000;
export const TESSERACT_CLI_DEFAULT_MAX_BUFFER = 1024 * 1024;
const TESSERACT_CLI_MAX_BUFFER = 4 * 1024 * 1024;
const VERSION_CHECK_TIMEOUT_MS = 10_000;

const spawnSync = crossSpawn.sync;

function environmentValue(env, name) {
  if (typeof env[name] === "string") return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function sanitizedCliEnv(platform, source) {
  const allow = platform === "win32"
    ? [
        "PATH", "HOME", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP",
        "COMSPEC", "PATHEXT", "PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432", "NUMBER_OF_PROCESSORS",
        "LANG", "LC_ALL", "LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME"
      ]
    : [
        "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_COLLATE", "LC_CTYPE", "LC_MESSAGES",
        "LC_MONETARY", "LC_NUMERIC", "LC_TIME", "SHELL"
      ];
  const env = {};
  for (const name of allow) {
    const value = environmentValue(source, name);
    if (typeof value === "string") env[name] = value;
  }
  if (platform === "darwin") {
    if (!env.HOME) env.HOME = homedir();
  }
  return env;
}

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function isRunnableFile(filePath, platform, exists = existsSync) {
  try {
    if (!exists(filePath) || !statSync(filePath).isFile()) return false;
    if (platform !== "win32") accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function supportedHost({ platform, arch, env }) {
  if (platform === "darwin") {
    if (arch === "arm64" || arch === "x64") return null;
    return {
      code: "unsupported_arch",
      message: `Tesseract CLI 0.1.0 supports macOS arm64 and x86_64; this Node architecture is ${arch}.`
    };
  }
  if (platform === "win32") {
    const windowsArch = environmentValue(env, "PROCESSOR_ARCHITEW6432") ||
      environmentValue(env, "PROCESSOR_ARCHITECTURE");
    if (windowsArch?.toUpperCase() !== "AMD64") {
      return {
        code: "unsupported_arch",
        message: `Tesseract CLI 0.1.0 supports 64-bit Windows (AMD64); detected ${windowsArch || "unknown architecture"}.`
      };
    }
    return null;
  }
  return {
    code: "unsupported_host",
    message: `Tesseract CLI 0.1.0 supports macOS and 64-bit Windows only; detected ${platform}.`
  };
}

function cliCandidates({ platform, env, home, pathValue, exists }) {
  const api = pathApi(platform);
  const names = platform === "win32" ? ["tsrct.cmd", "tsrct.exe", "tsrct"] : ["tsrct"];
  const canonical = platform === "darwin"
    ? api.join(environmentValue(env, "HOME") || home || homedir(), "Library", "Application Support", "Tesseract", "bin", "tsrct")
    : environmentValue(env, "LOCALAPPDATA")
      ? api.join(environmentValue(env, "LOCALAPPDATA"), "Tesseract", "bin", "tsrct.cmd")
      : null;
  const pathEntries = (pathValue ?? environmentValue(env, "PATH") ?? "")
    .split(platform === "win32" ? ";" : ":")
    .filter(Boolean);
  const candidates = [canonical, ...pathEntries.flatMap((entry) => names.map((name) => api.join(entry, name)))];
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!candidate) return false;
    const absolute = api.resolve(candidate);
    if (seen.has(absolute)) return false;
    seen.add(absolute);
    return isRunnableFile(absolute, platform, exists);
  }).map((candidate) => api.resolve(candidate));
}

/**
 * Run the local Tesseract CLI without a shell. `cross-spawn` wraps Windows
 * `.cmd` files safely; callers must pass each CLI argument as a separate string.
 */
export function runTesseractCli(cliPath, args = [], options = {}) {
  if (typeof cliPath !== "string" || cliPath.length === 0) {
    throw new TypeError("cliPath must be a non-empty string");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("Tesseract CLI arguments must be an array of strings");
  }
  const timeout = options.timeout ?? TESSERACT_CLI_DEFAULT_TIMEOUT_MS;
  const requestedMaxBuffer = options.maxBuffer ?? TESSERACT_CLI_DEFAULT_MAX_BUFFER;
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new TypeError("Tesseract CLI timeout must be a positive integer in milliseconds");
  }
  if (!Number.isSafeInteger(requestedMaxBuffer) || requestedMaxBuffer < 1) {
    throw new TypeError("Tesseract CLI maxBuffer must be a positive integer in bytes");
  }

  const spawnOptions = {
    encoding: options.encoding ?? "utf8",
    timeout,
    maxBuffer: Math.min(requestedMaxBuffer, TESSERACT_CLI_MAX_BUFFER),
    windowsHide: true,
    shell: false,
    env: sanitizedCliEnv(options.platform ?? process.platform, options.env ?? process.env)
  };
  if (options.cwd !== undefined) spawnOptions.cwd = options.cwd;
  return spawnSync(cliPath, args, spawnOptions);
}

function detectedVersion(output) {
  const tokens = String(output).trim().split(/\s+/).filter(Boolean);
  const versionLikeTokens = tokens.filter((token) => /(?:^|[^\w.])v?\d+\.\d+\.\d+/.test(token));
  if (versionLikeTokens.length !== 1) return null;
  const exactVersion = versionLikeTokens[0].match(/^v?(\d+\.\d+\.\d+)$/);
  return exactVersion?.[1] ?? null;
}

/** Find a supported local CLI and verify its exact official skill pin. */
export function resolveTesseractCli(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const unsupported = supportedHost({ platform, arch, env });
  if (unsupported) return { ok: false, ...unsupported };

  const candidates = cliCandidates({
    platform,
    env,
    home: options.home,
    pathValue: options.pathValue,
    exists: options.exists
  });
  const cliPath = candidates[0];
  if (!cliPath) {
    return {
      ok: false,
      code: "missing_cli",
      message: `Tesseract CLI ${TESSERACT_CLI_VERSION} is not installed or not on PATH. Run npm run tesseract:install from the Tsugite repository root after reviewing the official CLI terms.`
    };
  }

  const run = options.runCommand ?? runTesseractCli;
  let result;
  try {
    result = run(cliPath, ["--version"], {
      timeout: VERSION_CHECK_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
      encoding: "utf8"
    });
  } catch (error) {
    return {
      ok: false,
      code: "version_check_failed",
      message: `Could not check the installed Tesseract CLI version: ${error.message}`
    };
  }
  if (result?.error || result?.status !== 0) {
    const detail = result?.error?.message || result?.stderr?.trim() || `exit status ${result?.status ?? "unknown"}`;
    return {
      ok: false,
      code: "version_check_failed",
      message: `Could not check the installed Tesseract CLI version: ${detail}`
    };
  }
  const reportedVersion = detectedVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim());
  if (reportedVersion !== TESSERACT_CLI_VERSION) {
    return {
      ok: false,
      code: "version_mismatch",
      message: `Tesseract CLI version mismatch: found ${reportedVersion ?? "an unrecognized version"}; required ${TESSERACT_CLI_VERSION}.`
    };
  }
  return { ok: true, cliPath, version: TESSERACT_CLI_VERSION };
}

/** Doctor's direct `node backends/tesseract/cli.mjs --version` setup probe. */
export function main(args = process.argv.slice(2), options = {}) {
  if (args.length !== 1 || args[0] !== "--version") {
    console.error("Usage: node backends/tesseract/cli.mjs --version");
    return 2;
  }
  const resolved = resolveTesseractCli(options);
  if (!resolved.ok) {
    console.error(resolved.message);
    return 1;
  }
  console.log(resolved.version);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
