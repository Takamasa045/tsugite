#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, readdir, rm, writeFile, copyFile, chmod } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const EXTERNAL_RUNTIME_ROOTS = ["adapters", "backends", "connections", "knowledge"];
const ALLOWED_UNTRACKED_RUNTIME_FILES = [
  "backends/remotion/alpineTourism.js",
  "backends/remotion/cinematicTourismCaptions.js",
  "backends/remotion/cinematicTourismMotion.mjs",
  "backends/remotion/miraichiAfterSessionDialogue.js",
  "backends/remotion/summerCamp.js",
  "backends/remotion/summerCampLandscape.js",
  "backends/remotion/summerCampPresentation.mjs",
  "backends/remotion/tsugiteUiLaunch.js",
  "backends/remotion/tsugiteUiLaunchPresentation.mjs",
  "backends/remotion/workflowExplainer.js",
  "backends/remotion/workflowExplainerPresentation.mjs"
];
const SECRET_FILE_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /^(?:credentials|secrets?)\.json$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.(?:key|pem|p12|pfx|jks|keystore)$/i
];

function isSecretPath(path) {
  return path.split(/[\\/]/).some((part) => SECRET_FILE_PATTERNS.some((pattern) => pattern.test(part)));
}

function assertSafeRuntimeRoot(desktopRoot, runtimeRoot) {
  const withinDesktop = relative(desktopRoot, runtimeRoot);
  if (!withinDesktop || withinDesktop.startsWith(`..${sep}`) || isAbsolute(withinDesktop)) {
    throw new Error(`Refusing to replace unsafe runtime directory: ${runtimeRoot}`);
  }
}

async function copyRegularFile(source, target) {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Runtime staging rejects symlink: ${source}`);
  }
  if (!sourceStat.isFile()) {
    throw new Error(`Runtime staging expected a regular file: ${source}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  await chmod(target, sourceStat.mode & 0o777);
}

async function copyGeneratedTree(sourceRoot, targetRoot, logicalPrefix, files) {
  const sourceStat = await lstat(sourceRoot).catch(() => null);
  if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`Required generated directory is missing or unsafe: ${sourceRoot}`);
  }

  const entries = await readdir(sourceRoot, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const source = join(sourceRoot, entry.name);
    const target = join(targetRoot, entry.name);
    const logicalPath = `${logicalPrefix}/${entry.name}`;
    if (isSecretPath(logicalPath)) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`Runtime staging rejects symlink: ${source}`);
    }
    if (entry.isDirectory()) {
      await copyGeneratedTree(source, target, logicalPath, files);
    } else if (entry.isFile()) {
      await copyRegularFile(source, target);
      files.push(logicalPath);
    } else {
      throw new Error(`Runtime staging rejects non-regular entry: ${source}`);
    }
  }
}

async function trackedRuntimeFiles(repoRoot) {
  const { stdout } = await execFile(
    "git",
    ["ls-files", "-z", "--", ...EXTERNAL_RUNTIME_ROOTS],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  const files = new Set(stdout.split("\0").filter(Boolean));
  for (const path of ALLOWED_UNTRACKED_RUNTIME_FILES) {
    const stats = await lstat(join(repoRoot, path)).catch(() => null);
    if (stats) files.add(path);
  }
  return [...files].sort();
}

async function installProductionDependencies(runtimeTsugiteRoot) {
  await execFile(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["ci", "--omit=dev", "--no-audit", "--no-fund"],
    { cwd: runtimeTsugiteRoot, stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } }
  );
}

export async function stageRuntime({
  repoRoot,
  desktopRoot,
  install = false,
  nodeExecutable = process.execPath,
  nodeVersion = process.versions.node,
  nodeExecutableName = process.platform === "win32" ? "node.exe" : "node"
} = {}) {
  const resolvedDesktopRoot = resolve(desktopRoot ?? fileURLToPath(new URL("..", import.meta.url)));
  const resolvedRepoRoot = resolve(repoRoot ?? join(resolvedDesktopRoot, "..", ".."));
  const runtimeRoot = join(resolvedDesktopRoot, "runtime");
  const runtimeTsugiteRoot = join(runtimeRoot, "tsugite");
  const files = [];

  assertSafeRuntimeRoot(resolvedDesktopRoot, runtimeRoot);
  await rm(runtimeRoot, { recursive: true, force: true });
  await mkdir(runtimeTsugiteRoot, { recursive: true });

  await copyGeneratedTree(
    join(resolvedRepoRoot, "build"),
    join(runtimeTsugiteRoot, "build"),
    "tsugite/build",
    files
  );
  await copyGeneratedTree(
    join(resolvedRepoRoot, "apps", "workflow-viewer", "dist"),
    join(runtimeRoot, "viewer"),
    "viewer",
    files
  );

  const nodeMajor = Number.parseInt(nodeVersion.split(".", 1)[0], 10);
  if (nodeMajor !== 22) {
    throw new Error(`Desktop runtime requires a Node 22 executable, received ${nodeVersion}`);
  }
  if (!/^(?:node|node\.exe)$/.test(nodeExecutableName)) {
    throw new Error(`Unsafe staged Node executable name: ${nodeExecutableName}`);
  }
  await copyRegularFile(nodeExecutable, join(runtimeTsugiteRoot, "bin", nodeExecutableName));
  files.push(`tsugite/bin/${nodeExecutableName}`);

  for (const file of ["package.json", "package-lock.json"]) {
    await copyRegularFile(join(resolvedRepoRoot, file), join(runtimeTsugiteRoot, file));
    files.push(`tsugite/${file}`);
  }

  for (const trackedPath of await trackedRuntimeFiles(resolvedRepoRoot)) {
    const source = join(resolvedRepoRoot, trackedPath);
    const sourceStat = await lstat(source).catch(() => null);
    if (!sourceStat) {
      throw new Error(`Tracked runtime file is missing: ${trackedPath}`);
    }
    if (sourceStat.isSymbolicLink()) {
      throw new Error(`Runtime staging rejects symlink: ${trackedPath}`);
    }
    if (!sourceStat.isFile()) {
      throw new Error(`Tracked runtime path is not a regular file: ${trackedPath}`);
    }
    if (isSecretPath(trackedPath)) continue;
    await copyRegularFile(source, join(runtimeTsugiteRoot, trackedPath));
    files.push(`tsugite/${trackedPath}`);
  }

  if (install) {
    await installProductionDependencies(runtimeTsugiteRoot);
  }

  const manifest = {
    schema_version: 1,
    generated_from: "tracked-and-explicit-runtime-allowlist",
    production_dependencies_installed: install,
    files: [...files].sort()
  };
  await writeFile(join(runtimeRoot, "stage-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  files.push("stage-manifest.json");

  return { runtimeRoot, files: [...files].sort(), manifest };
}

function parseCliArguments(argv) {
  const unknown = argv.filter((argument) => argument !== "--install");
  if (unknown.length > 0) {
    throw new Error(`Unknown prepare-runtime option: ${unknown.join(", ")}`);
  }
  return { install: argv.includes("--install") };
}

const isDirectExecution = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  const options = parseCliArguments(process.argv.slice(2));
  const result = await stageRuntime(options);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    runtime_root: result.runtimeRoot,
    staged_file_count: result.files.length,
    production_dependencies_installed: options.install
  })}\n`);
}
