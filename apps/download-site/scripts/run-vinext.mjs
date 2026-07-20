import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const allowedCommands = new Set(["build", "dev", "start"]);

process.exitCode = await main();

async function main() {
  const command = process.argv[2];
  if (!allowedCommands.has(command)) {
    console.error(`Unsupported vinext command: ${command ?? "(missing)"}`);
    return 2;
  }

  const projectRoot = process.cwd();
  const hasGlobCharacter = /[*?[\]{}]/.test(projectRoot);
  if (!hasGlobCharacter) return runVinext(projectRoot, command);

  const stableRoot = await mkdtemp(join(tmpdir(), `${basename(projectRoot).replaceAll(/[^a-zA-Z0-9-]/g, "-")}-`));
  const excludedRoots = new Set(["node_modules", ".git", ".next", ".vinext", ".wrangler", "outputs", "work"]);
  if (command !== "start") excludedRoots.add("dist");

  try {
    console.log(`Special-character project path detected; using a temporary build mirror at ${stableRoot}`);
    await cp(projectRoot, stableRoot, {
      recursive: true,
      filter(source) {
        const pathFromRoot = relative(projectRoot, source);
        if (!pathFromRoot) return true;
        return !excludedRoots.has(pathFromRoot.split(sep)[0]);
      },
    });

    const installExit = await run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci"], stableRoot);
    if (installExit !== 0) return installExit;

    if (command === "dev") {
      console.log("This mirrored preview does not hot-reload source edits; restart it after changing files.");
    }

    const exitCode = await runVinext(stableRoot, command);
    if (exitCode === 0 && command === "build") {
      await rm(join(projectRoot, "dist"), { recursive: true, force: true });
      await cp(join(stableRoot, "dist"), join(projectRoot, "dist"), { recursive: true });
    }
    return exitCode;
  } finally {
    await rm(stableRoot, { recursive: true, force: true });
  }
}

function runVinext(cwd, command) {
  return run(process.platform === "win32" ? "npx.cmd" : "npx", ["--no-install", "vinext", command], cwd);
}

function run(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: ".wrangler/wrangler.log",
      },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) reject(new Error(`${executable} terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}
