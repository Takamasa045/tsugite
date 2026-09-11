import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE = "https://github.com/editframe/examples.git";
export const REVISION = "8f0e63b28b85efe268e7ae26969a09e3cc575dcd";
const ROOT = fileURLToPath(new URL("..", import.meta.url));

export function examplesEnv(source = process.env) {
  return Object.fromEntries([
    ...Object.entries(source).filter(([key]) => !key.startsWith("GIT_") &&
      !["EF_TOKEN", "EF_HOST", "EF_RENDER_HOST", "ORIGINAL_CWD", "EF_RENDER_PROJECT", "EF_NO_TELEMETRY"].includes(key)),
    ["EF_NO_TELEMETRY", "1"]
  ]);
}

function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd, env: examplesEnv(), encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed (${result.status ?? result.signal}). ${result.stderr ?? ""}`);
  return result.stdout?.trim() ?? "";
}

// Never follow a local installation directory into another workspace.
export function examplesDirectory(root = ROOT) {
  let directory = root;
  for (const segment of [".tsugite", "tools", "editframe-examples"]) {
    directory = join(directory, segment);
    try {
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Expected a real directory: ${directory}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return directory;
}

export function checkCheckout(directory, { clean = false } = {}) {
  if (!existsSync(join(directory, ".git")) || !lstatSync(join(directory, ".git")).isDirectory()) {
    throw new Error("Examples checkout is missing or incomplete. Existing files were preserved.");
  }
  if (run("git", ["remote", "get-url", "origin"], directory, true) !== SOURCE ||
      run("git", ["rev-parse", "HEAD"], directory, true) !== REVISION) {
    throw new Error("Examples source/revision differs from the pin. Existing checkout was preserved.");
  }
  if (clean && run("git", ["status", "--porcelain"], directory, true)) {
    throw new Error("Examples checkout has local changes. Install stopped to preserve them.");
  }
}

export function main(args) {
  if (args.length !== 1 || !["install", "start"].includes(args[0])) {
    throw new Error("Usage: npm run editframe:examples:install | npm run editframe:examples");
  }
  const directory = examplesDirectory();
  if (args[0] === "install") {
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
      run("git", ["init", "--quiet"], directory);
      run("git", ["remote", "add", "origin", SOURCE], directory);
      run("git", ["fetch", "--depth", "1", "origin", REVISION], directory);
      run("git", ["-c", "advice.detachedHead=false", "checkout", "--detach", "FETCH_HEAD"], directory);
    }
    checkCheckout(directory, { clean: true });
    // Preview needs no native FFmpeg installer or dependency lifecycle scripts.
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], directory);
    console.log(`Installed official examples at ${REVISION}. Run npm run editframe:examples`);
    return;
  }
  checkCheckout(directory);
  const vite = join(directory, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(vite)) throw new Error("Examples dependencies are missing. Run npm run editframe:examples:install");
  // Invoke the installed binary directly: no npx download or inherited directory override.
  run(process.execPath, [vite, "dev", "--host", "127.0.0.1", "--port", "5184", "--strictPort"], directory);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
