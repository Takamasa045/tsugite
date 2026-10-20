import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import crossSpawn from "cross-spawn";

/** Resolve an opt-in repository runtime, never an unrelated global package. */
export function pinnedCli(runtime, name, version, entry, installScript) {
  const directory = join(runtime, "node_modules", name);
  let installed;
  try { installed = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")); }
  catch { /* Report a bounded setup hint instead of filesystem internals. */ }
  const file = join(directory, entry);
  if (installed?.name !== name || installed.version !== version || !existsSync(file)) {
    throw new Error(`${name}@${version} is missing or mismatched. Run npm run ${installScript} from the Tsugite repository.`);
  }
  return { executable: process.execPath, prefix: [file] };
}

export function forwardCli(command, args) {
  const child = crossSpawn(command.executable, [...command.prefix, ...args], { stdio: "inherit", shell: false });
  child.on("error", () => { console.error("The selected CLI could not start."); process.exitCode = 1; });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
