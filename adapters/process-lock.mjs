import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

export class ProcessLockError extends Error {
  constructor(code = "operation_busy") { super(code); this.code = code; }
}
const sameFile = (a, b) => a?.ino === b?.ino && a?.dev === b?.dev;
async function readLock(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 || info.size === 0
    || (process.getuid && info.uid !== process.getuid())) throw new ProcessLockError();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!sameFile(info, await handle.stat())) throw new ProcessLockError();
    const text = await handle.readFile("utf8");
    if (text.length > 1024) throw new ProcessLockError();
    const value = JSON.parse(text);
    if (value.version !== 1 || !Number.isInteger(value.pid) || value.pid <= 0 || value.pid > 2147483647
      || !/^[a-f0-9-]{36}$/.test(value.nonce) || Object.keys(value).some((k) => !["version", "pid", "nonce"].includes(k))) throw new ProcessLockError();
    return { ...value, info };
  } finally { await handle.close(); }
}
function definitelyDead(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error?.code === "ESRCH"; }
}
async function reclaimDeadLock(path, previous, options) {
  if (!definitelyDead(previous.pid)) return;
  // Exactly one cleaner per old nonce. A second stale reader cannot unlink a
  // replacement lock after the first cleaner has let a new owner through.
  const claimPath = `${path}.reclaim-${previous.nonce}`;
  let claim;
  try { claim = await open(claimPath, "wx", 0o600); }
  catch (error) { if (error?.code === "EEXIST") return; throw error; }
  const claimInfo = await claim.stat();
  try {
    await claim.writeFile(JSON.stringify({ version: 1, pid: process.pid, nonce: randomUUID() }));
    await options.onReclaim?.();
    const current = await readLock(path);
    if (sameFile(current.info, previous.info) && current.nonce === previous.nonce && definitelyDead(current.pid)) await unlink(path);
  } finally {
    await claim.close();
    const current = await lstat(claimPath).catch(() => undefined);
    if (sameFile(current, claimInfo)) await unlink(claimPath);
  }
}

// Local process coordination only; secret bytes never enter a lock. Paid
// at-most-once safety additionally relies on the permanent durable journal.
export async function withProcessLock(directory, name, action, options = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(name)) throw new ProcessLockError("lock_name_invalid");
  const root = await realpath(directory), rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (process.getuid && rootInfo.uid !== process.getuid())) throw new ProcessLockError("lock_directory_invalid");
  const path = join(root, name), nonce = randomUUID();
  const waitMs = Math.min(60_000, Math.max(0, options.waitMs ?? 5_000));
  const deadline = performance.now() + waitMs;
  let handle, info;
  for (;;) {
    try {
      handle = await open(path, "wx", 0o600); info = await handle.stat();
      await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, nonce }));
      break;
    } catch (error) {
      if (handle) { await handle.close().catch(() => undefined); throw new ProcessLockError("lock_write_failed"); }
      if (error?.code !== "EEXIST") throw new ProcessLockError("lock_unavailable");
      try { await reclaimDeadLock(path, await readLock(path), options); } catch { /* Unknown ownership is busy, never deleted. */ }
      if (performance.now() >= deadline) throw new ProcessLockError();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  let result, failure;
  try { result = await action(); } catch (error) { failure = error; }
  try {
    const current = await readLock(path);
    if (!sameFile(current.info, info) || current.nonce !== nonce || current.pid !== process.pid) throw new ProcessLockError("lock_identity_changed");
    await unlink(path);
  } catch { if (!failure) failure = new ProcessLockError("lock_identity_changed"); }
  finally { await handle.close().catch(() => undefined); }
  if (failure) throw failure;
  return result;
}
