import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const ATTEMPTS = 2;
const AUDIT_TIMEOUT_MS = 45_000;
const RETRY_WAIT_MS = 5_000;

function runAudit(args) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const result = spawnSync(npm, ["audit", ...args], {
      stdio: "inherit",
      shell: false,
      timeout: AUDIT_TIMEOUT_MS,
      killSignal: "SIGKILL"
    });
    if (result.status === 0) return;
    if (attempt === ATTEMPTS) {
      process.exit(result.status === null ? 1 : result.status);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_WAIT_MS);
  }
}

runAudit(["--omit=dev", "--audit-level=moderate"]);
runAudit(["--audit-level=moderate"]);
