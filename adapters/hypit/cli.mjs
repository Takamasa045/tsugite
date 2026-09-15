#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertAllowed } from "./permissions.mjs";
import { hypitChildEnv, hypitEntry, hypitMissingMessage } from "./runtimeAdapter.mjs";
import { assertPhase1ObserveTarget } from "./trust.mjs";

const adapterRoot = fileURLToPath(new URL(".", import.meta.url));

if (process.env.TSUGITE_HYPIT_GRANT) {
  process.stderr.write("Phase 1 ignores TSUGITE_HYPIT_GRANT. Denied Hypit commands stay denied.\n");
  process.exitCode = 2;
  process.exit();
}

try {
  assertAllowed(process.argv.slice(2));
  assertPhase1ObserveTarget(process.argv.slice(2), process.cwd(), adapterRoot);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error.code === "HYPIT_UNTRUSTED_SOURCE" ? 3 : 2;
  process.exit();
}

const entry = hypitEntry(adapterRoot);
if (!existsSync(entry)) {
  process.stderr.write(`${hypitMissingMessage()}\n`);
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: hypitChildEnv()
  });
  child.on("error", (error) => {
    process.stderr.write(`Hypit CLI could not start: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
