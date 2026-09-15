/**
 * Exclusive durable one-shot dispatch claim. No auto-clear of uncertain claims.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

export function dispatchClaimPath(productionRoot, intentDigest) {
  return join(productionRoot, ".tsugite", "authoring", "dispatch", `${intentDigest}.claim`);
}

export function claimIntentDispatch(productionRoot, intentDigest) {
  if (typeof intentDigest !== "string" || !/^[a-f0-9]{64}$/.test(intentDigest)) {
    throw Object.assign(new Error("dispatch claim requires the persisted intent digest"), { code: "HYPIT_BUILD_GATED" });
  }
  const path = dispatchClaimPath(productionRoot, intentDigest);
  mkdirSync(dirname(path), { recursive: true });
  let fd;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw Object.assign(new Error("dispatch already claimed for this intent"), { code: "HYPIT_DISPATCH_CLAIMED" });
    }
    throw error;
  }
  try {
    writeSync(fd, `${JSON.stringify({
      intent_digest: intentDigest,
      pid: process.pid,
      claimed_at: new Date().toISOString()
    })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return path;
}
