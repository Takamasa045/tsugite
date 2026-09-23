import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, release as osRelease, tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";
import { resolveTesseractCli, TESSERACT_CLI_VERSION } from "../backends/tesseract/cli.mjs";

const spawnSync = crossSpawn.sync;
const TESSERACT_RELEASE_BASE = "https://github.com/mirage-hq/tesseract/releases/download";
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const CHECKSUM_MAX_BYTES = 16 * 1024;
const COMMAND_MAX_BUFFER = 4 * 1024 * 1024;

function envValue(env, name) {
  if (typeof env[name] === "string") return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function translatedMacArch() {
  const result = spawnSync("sysctl", ["-in", "sysctl.proc_translated"], {
    encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024, windowsHide: true, shell: false
  });
  return result.status === 0 && result.stdout?.trim() === "1";
}

/** Resolve an official release asset using the upstream installation guide rules. */
export function resolveTesseractTarget({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  windowsRelease = osRelease(),
  translated
} = {}) {
  if (platform === "darwin") {
    if (arch === "arm64") return { ok: true, asset: "darwin-arm64" };
    if (arch === "x64") {
      return { ok: true, asset: (translated ?? translatedMacArch()) ? "darwin-arm64" : "darwin-x86_64" };
    }
    return {
      ok: false,
      code: "unsupported_arch",
      message: `Tesseract CLI ${TESSERACT_CLI_VERSION} supports macOS arm64 and x86_64; detected ${arch}.`
    };
  }
  if (platform === "win32") {
    const major = Number.parseInt(String(windowsRelease).split(".")[0], 10);
    if (!Number.isFinite(major) || major < 10) {
      return {
        ok: false,
        code: "unsupported_os_version",
        message: `Tesseract CLI ${TESSERACT_CLI_VERSION} requires Windows 10 or later; detected ${windowsRelease || "unknown version"}.`
      };
    }
    const windowsArch = envValue(env, "PROCESSOR_ARCHITEW6432") || envValue(env, "PROCESSOR_ARCHITECTURE");
    if (windowsArch?.toUpperCase() !== "AMD64") {
      return {
        ok: false,
        code: "unsupported_arch",
        message: `Tesseract CLI ${TESSERACT_CLI_VERSION} supports 64-bit Windows (AMD64); detected ${windowsArch || "unknown architecture"}.`
      };
    }
    return { ok: true, asset: "windows-x86_64" };
  }
  return {
    ok: false,
    code: "unsupported_host",
    message: `Tesseract CLI ${TESSERACT_CLI_VERSION} supports macOS and 64-bit Windows only; detected ${platform}.`
  };
}

export function tesseractReleaseUrls(asset, version = TESSERACT_CLI_VERSION) {
  if (!["darwin-arm64", "darwin-x86_64", "windows-x86_64"].includes(asset)) {
    throw new TypeError(`Unsupported Tesseract release asset: ${asset}`);
  }
  if (version !== TESSERACT_CLI_VERSION) {
    throw new TypeError(`Tesseract release version must match the official skill pin ${TESSERACT_CLI_VERSION}`);
  }
  const archiveName = `tesseract-${version}-${asset}.zip`;
  const base = `${TESSERACT_RELEASE_BASE}/v${version}/${archiveName}`;
  return { archiveName, archiveUrl: base, checksumUrl: `${base}.sha256` };
}

export function parseTesseractChecksum(checksumText, archiveName) {
  const lines = String(checksumText).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error("Tesseract checksum file must contain exactly one SHA-256 entry.");
  const match = lines[0].match(/^([a-f\d]{64})(?:\s+\*?([^\s]+))?$/i);
  if (!match) throw new Error("Tesseract checksum file does not contain a valid SHA-256 entry.");
  if (match[2] && path.posix.basename(match[2]) !== archiveName) {
    throw new Error(`Tesseract checksum file names ${match[2]}, not ${archiveName}.`);
  }
  return match[1].toLowerCase();
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function sanitizedInstallerEnv(platform, source) {
  const allow = platform === "win32"
    ? ["PATH", "LOCALAPPDATA", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT", "PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432", "NUMBER_OF_PROCESSORS"]
    : ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "SHELL"];
  const env = {};
  for (const name of allow) {
    const value = envValue(source, name);
    if (typeof value === "string") env[name] = value;
  }
  if (platform === "darwin" && !env.HOME) env.HOME = homedir();
  return env;
}

async function withDownloadTimeout(timeoutMs, label, work) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs} ms.`);
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function downloadToFile(fetchImpl, url, filePath, timeoutMs) {
  await withDownloadTimeout(timeoutMs, "Tesseract archive download", async (signal) => {
    const response = await fetchImpl(url, {
      redirect: "follow",
      headers: { accept: "application/octet-stream" },
      signal
    });
    if (!response?.ok) {
      throw new Error(`Tesseract download failed (${response?.status ?? "no response"}): ${url}`);
    }
    if (response.body && typeof response.body.getReader === "function") {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(filePath, { flags: "wx" }), { signal });
    } else if (typeof response.arrayBuffer === "function") {
      const bytes = Buffer.from(await response.arrayBuffer());
      await pipeline(Readable.from(bytes), createWriteStream(filePath, { flags: "wx" }), { signal });
    } else {
      throw new Error(`Tesseract download response has no body: ${url}`);
    }
  });
}

async function readChecksumText(response, signal) {
  if (response.body && typeof response.body.getReader === "function") {
    const chunks = [];
    let totalBytes = 0;
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        const bytes = Buffer.from(chunk);
        totalBytes += bytes.length;
        if (totalBytes > CHECKSUM_MAX_BYTES) {
          callback(new Error(`Tesseract checksum file exceeds ${CHECKSUM_MAX_BYTES} bytes.`));
          return;
        }
        chunks.push(bytes);
        callback();
      }
    });
    await pipeline(Readable.fromWeb(response.body), sink, { signal });
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  }
  if (typeof response.text === "function") return response.text();
  throw new Error("Tesseract checksum response has no readable body.");
}

async function downloadChecksum(fetchImpl, url, archiveName, timeoutMs) {
  return withDownloadTimeout(timeoutMs, "Tesseract checksum download", async (signal) => {
    const response = await fetchImpl(url, {
      redirect: "follow",
      headers: { accept: "text/plain" },
      signal
    });
    if (!response?.ok) {
      throw new Error(`Tesseract checksum download failed (${response?.status ?? "no response"}): ${url}`);
    }
    return parseTesseractChecksum(await readChecksumText(response, signal), archiveName);
  });
}

function defaultRunCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: options.timeout ?? INSTALL_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? COMMAND_MAX_BUFFER,
    windowsHide: true,
    shell: false
  });
}

function resultText(value) {
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
}

function emitCommandOutput(result, logger) {
  const stdout = resultText(result?.stdout).trimEnd();
  const stderr = resultText(result?.stderr).trimEnd();
  if (stdout) logger.log?.(stdout);
  if (stderr) logger.error?.(stderr);
}

async function runChecked(runCommand, command, args, label, options, logger) {
  let result;
  try {
    result = await runCommand(command, args, { ...options, shell: false });
  } catch (error) {
    throw new Error(`${label} could not start: ${error.message}`, { cause: error });
  }
  emitCommandOutput(result, logger);
  if (result?.error || result?.status !== 0) {
    const detail = result?.error?.message || resultText(result?.stderr).trim() || `exit status ${result?.status ?? "unknown"}`;
    throw new Error(`${label} failed: ${detail}`);
  }
  return result;
}

function findInstaller(extractDir, fileName) {
  const pending = [extractDir];
  const matches = [];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name === fileName) matches.push(fullPath);
    }
  }
  if (matches.length !== 1) {
    throw new Error(`Expected one ${fileName} in the official Tesseract archive; found ${matches.length}.`);
  }
  return matches[0];
}

function archiveExtractor(platform, archivePath, extractDir, installerEnv) {
  if (platform === "darwin") {
    return { command: "ditto", args: ["-x", "-k", archivePath, extractDir], env: installerEnv };
  }
  const env = {
    ...installerEnv,
    TSUGITE_TESSERACT_ARCHIVE_PATH: archivePath,
    TSUGITE_TESSERACT_EXTRACT_PATH: extractDir
  };
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile", "-NonInteractive", "-Command",
      "Expand-Archive -LiteralPath $env:TSUGITE_TESSERACT_ARCHIVE_PATH -DestinationPath $env:TSUGITE_TESSERACT_EXTRACT_PATH -Force"
    ],
    env
  };
}

/** Download, verify, extract and invoke only the official install script. */
export async function installTesseract(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const host = resolveTesseractTarget({
    platform,
    arch: options.arch ?? process.arch,
    env,
    windowsRelease: options.windowsRelease ?? osRelease(),
    translated: options.translated
  });
  if (!host.ok) throw new Error(host.message);

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("Node.js fetch is required to install the Tesseract CLI.");
  const downloadTimeoutMs = options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  if (!Number.isSafeInteger(downloadTimeoutMs) || downloadTimeoutMs < 1) {
    throw new TypeError("Tesseract download timeout must be a positive integer in milliseconds");
  }
  const runCommand = options.runCommand ?? defaultRunCommand;
  const logger = options.logger ?? console;
  const installerEnv = sanitizedInstallerEnv(platform, env);
  const urls = tesseractReleaseUrls(host.asset);
  const tempParent = options.tempParent ?? tmpdir();
  const tempDir = mkdtempSync(path.join(tempParent, "tsugite-tesseract-install-"));
  const archivePath = path.join(tempDir, urls.archiveName);
  const extractDir = path.join(tempDir, "extracted");
  mkdirSync(extractDir, { recursive: true });

  try {
    logger.log?.(`Downloading official Tesseract CLI ${TESSERACT_CLI_VERSION} (${host.asset}).`);
    await downloadToFile(fetchImpl, urls.archiveUrl, archivePath, downloadTimeoutMs);
    const expectedHash = await downloadChecksum(fetchImpl, urls.checksumUrl, urls.archiveName, downloadTimeoutMs);
    const actualHash = await sha256File(archivePath);
    if (actualHash !== expectedHash) {
      throw new Error(`Tesseract archive SHA-256 mismatch: expected ${expectedHash}, received ${actualHash}.`);
    }

    const extraction = archiveExtractor(platform, archivePath, extractDir, installerEnv);
    await runChecked(runCommand, extraction.command, extraction.args, "Tesseract archive extraction", {
      cwd: tempDir,
      env: extraction.env,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER
    }, logger);

    const installerName = platform === "darwin" ? "install.sh" : "install.ps1";
    const installerPath = findInstaller(extractDir, installerName);
    if (platform === "darwin") {
      await runChecked(runCommand, "bash", [installerPath], "Official Tesseract installer", {
        cwd: path.dirname(installerPath),
        env: installerEnv,
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_BUFFER
      }, logger);
    } else {
      await runChecked(runCommand, "powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", installerPath
      ], "Official Tesseract installer", {
        cwd: path.dirname(installerPath),
        env: installerEnv,
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_BUFFER
      }, logger);
    }

    const verifyRunCommand = (command, args, commandOptions = {}) => runCommand(command, args, {
      ...commandOptions,
      env: installerEnv,
      shell: false
    });
    const resolveCli = options.resolveCli ?? resolveTesseractCli;
    const resolved = resolveCli({
      platform,
      arch: options.arch ?? process.arch,
      env: installerEnv,
      runCommand: verifyRunCommand
    });
    if (!resolved.ok) throw new Error(`Tesseract installer finished but verification failed: ${resolved.message}`);
    logger.log?.(`Installed and verified Tesseract CLI ${resolved.version} at ${resolved.cliPath}.`);
    return { ok: true, cliPath: resolved.cliPath, version: resolved.version, asset: host.asset };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function main(args = process.argv.slice(2), options = {}) {
  if (args.length !== 1 || args[0] !== "install") {
    throw new Error("Usage: npm run tesseract:install");
  }
  return installTesseract(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
