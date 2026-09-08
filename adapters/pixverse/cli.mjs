import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// Use the repository-pinned runtime, never a potentially older global binary.
const entry = fileURLToPath(new URL("./runtime/node_modules/pixverse/dist/index.js", import.meta.url));
if (!existsSync(entry)) {
  console.error("PixVerse CLI runtime is missing. Run npm run pixverse:install in the Tsugite repository first.");
  process.exitCode = 1;
} else {
  // Preserve official CLI flags, stdin patches, JSON output and exit codes.
  const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { stdio: "inherit" });
  child.on("error", (error) => {
    console.error(`PixVerse CLI could not start: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
