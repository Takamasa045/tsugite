#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { listPackage } from "@electron/asar";

const execFile = promisify(execFileCallback);

const FORBIDDEN_RUNTIME_ROOTS = new Set(["projects", "templates", "media", "output", "tmp"]);
const SECRET_FILE_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /^(?:credentials|secrets?)\.json$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.(?:key|pem|p12|pfx|jks|keystore)$/i
];
const ALLOWED_MANIFEST_PATHS = [
  /^viewer\//,
  /^tsugite\/build\//,
  /^tsugite\/(?:adapters|backends|connections|knowledge)\//,
  /^tsugite\/bin\/node(?:\.exe)?$/,
  /^tsugite\/package(?:-lock)?\.json$/
];
const ALLOWED_ASAR_SOURCE_FILES = new Set([
  "package.json",
  "src/main.mjs",
  "src/preload.mjs",
  "src/agent-terminal.mjs",
  "src/lifecycle.mjs",
  "src/process-runner.mjs",
  "src/runtime.mjs"
]);
const NODE_PTY_TARGET = `${process.platform}-${process.arch}`;
const NODE_PTY_NATIVE_ROOTS = [
  "node_modules/node-pty/build/Release",
  `node_modules/node-pty/prebuilds/${NODE_PTY_TARGET}`
];
const NODE_PTY_REQUIRED_RUNTIME_FILES = process.platform === "win32"
  ? ["pty.node", "winpty-agent.exe", "winpty.dll"]
  : ["pty.node", "spawn-helper"];

function portable(path) {
  return path.split(sep).join("/");
}

function isSecretPath(path) {
  return path.split("/").some((part) => SECRET_FILE_PATTERNS.some((pattern) => pattern.test(part)));
}

function assertAllowedManifestPath(path) {
  if (!ALLOWED_MANIFEST_PATHS.some((pattern) => pattern.test(path))) {
    throw new Error(`Package audit found a path outside the runtime allowlist: ${path}`);
  }
  const parts = path.split("/");
  if (parts[0] === "tsugite" && FORBIDDEN_RUNTIME_ROOTS.has(parts[1])) {
    throw new Error(`Package audit found a forbidden runtime root: ${path}`);
  }
  if (isSecretPath(path)) {
    throw new Error(`Package audit found a secret-like runtime path: ${path}`);
  }
}

async function listFiles(root, { skipNodeModules = false } = {}) {
  const output = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const path = portable(relative(root, absolutePath));
      if (skipNodeModules && path === "tsugite/node_modules" && entry.isDirectory()) continue;
      if (entry.isDirectory()) await visit(absolutePath);
      else output.push(path);
    }
  }
  await visit(root);
  return output;
}

async function assertRequiredFile(path, description) {
  const stats = await lstat(path).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Package audit is missing ${description}: ${path}`);
  }
  return stats;
}

export async function auditRuntimeBoundary(runtimeRoot) {
  const resolvedRuntimeRoot = resolve(runtimeRoot);
  const manifestPath = join(resolvedRuntimeRoot, "stage-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.files)) {
    throw new Error(`Package audit found an invalid stage manifest: ${manifestPath}`);
  }

  for (const path of manifest.files) assertAllowedManifestPath(path);
  const expectedFiles = new Set([...manifest.files, "stage-manifest.json"]);
  const actualFiles = new Set(await listFiles(resolvedRuntimeRoot, { skipNodeModules: true }));
  for (const path of expectedFiles) {
    if (!actualFiles.has(path)) throw new Error(`Package audit is missing a staged file: ${path}`);
  }
  for (const path of actualFiles) {
    if (!expectedFiles.has(path)) throw new Error(`Package audit found an unlisted runtime file: ${path}`);
  }

  await assertRequiredFile(join(resolvedRuntimeRoot, "tsugite", "build", "cli.js"), "Tsugite CLI");
  await assertRequiredFile(join(resolvedRuntimeRoot, "viewer", "index.html"), "Viewer entry");
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const nodeStats = await assertRequiredFile(
    join(resolvedRuntimeRoot, "tsugite", "bin", nodeName),
    "bundled Node executable"
  );
  if (process.platform !== "win32" && (nodeStats.mode & 0o111) === 0) {
    throw new Error("Package audit found a non-executable bundled Node binary");
  }

  const nodeModules = await lstat(join(resolvedRuntimeRoot, "tsugite", "node_modules")).catch(() => null);
  if (manifest.production_dependencies_installed) {
    if (!nodeModules?.isDirectory()) {
      throw new Error("Package audit expected production node_modules but none were staged");
    }
    const runtimeTsugiteRoot = join(resolvedRuntimeRoot, "tsugite");
    const { stdout } = await execFile(
      join(runtimeTsugiteRoot, "bin", nodeName),
      [join(runtimeTsugiteRoot, "build", "cli.js"), "connections", "--json"],
      { cwd: runtimeTsugiteRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, windowsHide: true }
    );
    const smoke = JSON.parse(stdout);
    if (smoke?.ok !== true || smoke?.command !== "connections" || smoke?.secret_values_exposed !== false) {
      throw new Error("Package audit could not execute the bundled Tsugite CLI safely");
    }
    const remotionModules = [
      join(runtimeTsugiteRoot, "backends", "remotion", "presetRegistry.mjs"),
      join(runtimeTsugiteRoot, "backends", "remotion", "root.js")
    ].map((path) => pathToFileURL(path).href);
    await execFile(
      join(runtimeTsugiteRoot, "bin", nodeName),
      ["--input-type=module", "--eval", `for (const moduleUrl of ${JSON.stringify(remotionModules)}) await import(moduleUrl);`],
      { cwd: runtimeTsugiteRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, windowsHide: true }
    );
  } else if (nodeModules) {
    throw new Error("Package audit found node_modules not declared by the stage manifest");
  }

  return { ok: true, runtimeRoot: resolvedRuntimeRoot, stagedFileCount: manifest.files.length };
}

function assertAsarBoundary(asarPath) {
  const entries = listPackage(asarPath).map((path) => path.replace(/^[/\\]+/, "").replaceAll("\\", "/"));
  const forbidden = entries.filter((path) => {
    if (path === "src" || path === "node_modules") return false;
    if (path.startsWith("node_modules/")) return false;
    return !ALLOWED_ASAR_SOURCE_FILES.has(path);
  });
  if (forbidden.length > 0) {
    throw new Error(`Package audit found forbidden app.asar entries: ${forbidden.slice(0, 10).join(", ")}`);
  }
  const required = [...ALLOWED_ASAR_SOURCE_FILES, "node_modules/node-pty/package.json"];
  const missing = required.filter((path) => !entries.includes(path));
  if (missing.length > 0) {
    throw new Error(`Package audit is missing required app.asar entries: ${missing.join(", ")}`);
  }
  return entries.length;
}

async function assertUnpackedNativeBoundary(resourcesRoot) {
  const unpackedRoot = join(resourcesRoot, "app.asar.unpacked");
  const unpackedStats = await lstat(unpackedRoot).catch(() => null);
  if (!unpackedStats?.isDirectory() || unpackedStats.isSymbolicLink()) {
    throw new Error(`Package audit is missing the targeted node-pty runtime: ${unpackedRoot}`);
  }

  const files = await listFiles(unpackedRoot);
  const forbidden = files.filter((path) => (
    isSecretPath(path)
    || !NODE_PTY_NATIVE_ROOTS.some((root) => path.startsWith(`${root}/`))
  ));
  if (forbidden.length > 0) {
    throw new Error(
      `Package audit found forbidden app.asar.unpacked entries: ${forbidden.slice(0, 10).join(", ")}`
    );
  }
  for (const path of files) {
    const stats = await lstat(join(unpackedRoot, path));
    if (stats.isSymbolicLink()) {
      throw new Error(`Package audit found a symlink in app.asar.unpacked: ${path}`);
    }
  }
  const required = NODE_PTY_NATIVE_ROOTS.flatMap((root) => (
    NODE_PTY_REQUIRED_RUNTIME_FILES.map((file) => `${root}/${file}`)
  ));
  const missing = required.filter((path) => !files.includes(path));
  if (missing.length > 0) {
    throw new Error(
      `Package audit is missing the targeted node-pty runtime (${NODE_PTY_TARGET}): ${missing.join(", ")}`
    );
  }
  if (process.platform !== "win32") {
    for (const root of NODE_PTY_NATIVE_ROOTS) {
      const helper = `${root}/spawn-helper`;
      const stats = await lstat(join(unpackedRoot, helper));
      if ((stats.mode & 0o111) === 0) {
        throw new Error(`Package audit found a non-executable node-pty spawn helper: ${helper}`);
      }
    }
  }
  return files.length;
}

export async function auditPackagedResources(resourcesRoot) {
  const resolvedResourcesRoot = resolve(resourcesRoot);
  const asarPath = join(resolvedResourcesRoot, "app.asar");
  await assertRequiredFile(asarPath, "app.asar");
  const runtimeResult = await auditRuntimeBoundary(join(resolvedResourcesRoot, "runtime"));
  const asarEntryCount = assertAsarBoundary(asarPath);
  const unpackedNativeFileCount = await assertUnpackedNativeBoundary(resolvedResourcesRoot);
  return { ...runtimeResult, resourcesRoot: resolvedResourcesRoot, asarEntryCount, unpackedNativeFileCount };
}

async function findPackagedResources(outRoot) {
  const roots = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      if (entry.name === "Resources" || entry.name === "resources") {
        const appAsar = await lstat(join(path, "app.asar")).catch(() => null);
        if (appAsar?.isFile()) roots.push(path);
      } else {
        await visit(path);
      }
    }
  }
  await visit(resolve(outRoot));
  return [...new Set(roots)].sort();
}

function parseArguments(argv) {
  if (argv.length === 0) return {};
  if (argv.length === 2 && argv[0] === "--resources") return { resourcesRoot: argv[1] };
  throw new Error("Usage: audit-package.mjs [--resources <packaged Resources directory>]");
}

const isDirectExecution = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  const { resourcesRoot } = parseArguments(process.argv.slice(2));
  const roots = resourcesRoot
    ? [resourcesRoot]
    : await findPackagedResources(join(dirname(fileURLToPath(import.meta.url)), "..", "out"));
  if (roots.length === 0) throw new Error("Package audit found no packaged app under apps/desktop/out");
  const results = [];
  for (const root of roots) results.push(await auditPackagedResources(root));
  process.stdout.write(`${JSON.stringify({ ok: true, packages: results }, null, 2)}\n`);
}
