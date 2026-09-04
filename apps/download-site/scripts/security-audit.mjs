import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function runAudit(args) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = spawnSync(npm, ["audit", ...args], { stdio: "inherit", shell: false });
    if (result.status === 0) return;
    if (attempt === 5) process.exit(result.status === null ? 1 : result.status);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 12_000);
  }
}

runAudit(["--omit=dev", "--audit-level=moderate"]);
runAudit(["--audit-level=moderate"]);
