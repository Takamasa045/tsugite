import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, openSync, closeSync, writeSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTHORING_LOCK_RECOVER_SCHEMA,
  AUTHORING_LOCK_SCHEMA,
  probePid,
  productionLockPath,
  productionStatePath,
  withProductionLock
} from "../adapters/hypit/orchestrator.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "tsugite-lock-"));
  roots.push(root);
  mkdirSync(join(root, ".tsugite", "authoring"), { recursive: true });
  return root;
}

function writeAuthoringLock(lockPath, pid, extras = {}) {
  writeFileSync(lockPath, `${JSON.stringify({
    schema: AUTHORING_LOCK_SCHEMA,
    pid,
    token: extras.token ?? randomUUID(),
    acquired_at: extras.acquired_at ?? new Date(Date.now() - 60_000).toISOString()
  })}\n`);
}

describe("authoring lock recovery", () => {
  it("treats EPERM as alive and ESRCH as dead", () => {
    const eperm = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const esrch = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    const eio = Object.assign(new Error("EIO"), { code: "EIO" });
    expect(probePid(1, () => { throw eperm; })).toBe("alive");
    expect(probePid(1, () => { throw esrch; })).toBe("dead");
    expect(probePid(1, () => { throw eio; })).toBe("unknown");
    expect(probePid(process.pid)).toBe("alive");
    expect(probePid(0)).toBe("invalid");
  });

  it("recovers a dead-pid owner lock without rewriting pending intent", () => {
    const root = tempRoot();
    const lockPath = productionLockPath(root);
    const statePath = productionStatePath(root);
    const pending = {
      run: {
        production_id: "draft-named",
        build: { build_id: "bld_current", outcome: "pending" },
        submission_intent: { status: "pending", digest: "a".repeat(64) }
      }
    };
    writeFileSync(statePath, `${JSON.stringify(pending, null, 2)}\n`);
    writeAuthoringLock(lockPath, 424242);
    const result = withProductionLock(root, () => "ok", {
      probePid: (pid) => (pid === 424242 ? "dead" : probePid(pid))
    });
    expect(result).toBe("ok");
    expect(existsSync(lockPath)).toBe(false);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual(pending);
  });

  it("refuses live, unknown, foreign identity, and successor-race reclaim", () => {
    const root = tempRoot();
    const lockPath = productionLockPath(root);

    writeAuthoringLock(lockPath, process.pid);
    expect(() => withProductionLock(root, () => "no")).toThrow(/held/);
    try {
      withProductionLock(root, () => "no");
      throw new Error("expected live lock to refuse");
    } catch (error) {
      expect(error).toMatchObject({ code: "PC_LOCK_CONFLICT" });
    }
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);

    writeFileSync(lockPath, "not-a-lock\n");
    try {
      withProductionLock(root, () => "no");
      throw new Error("expected foreign lock to refuse");
    } catch (error) {
      expect(error).toMatchObject({ code: "PC_LOCK_UNSAFE" });
    }
    expect(readFileSync(lockPath, "utf8")).toBe("not-a-lock\n");

    writeAuthoringLock(lockPath, 424242);
    try {
      withProductionLock(root, () => "no", { probePid: () => "unknown" });
      throw new Error("expected unknown liveness to refuse");
    } catch (error) {
      expect(error).toMatchObject({ code: "PC_LOCK_UNSAFE" });
    }
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(424242);

    writeAuthoringLock(lockPath, 7);
    try {
      withProductionLock(root, () => "no", { probePid: () => "alive" });
      throw new Error("expected EPERM/live lock to refuse");
    } catch (error) {
      expect(error).toMatchObject({ code: "PC_LOCK_CONFLICT" });
    }
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(7);

    const successorToken = randomUUID();
    writeAuthoringLock(lockPath, 424242);
    try {
      withProductionLock(root, () => "no", {
        probePid: (pid) => (pid === 424242 ? "dead" : "alive"),
        hooks: {
          beforeReclaimUnlink() {
            unlinkSync(lockPath);
            const fd = openSync(lockPath, "wx");
            writeSync(fd, `${JSON.stringify({
              schema: AUTHORING_LOCK_SCHEMA,
              pid: process.pid,
              token: successorToken,
              acquired_at: new Date().toISOString()
            })}\n`);
            closeSync(fd);
          }
        }
      });
      throw new Error("expected successor race to refuse");
    } catch (error) {
      expect(error).toMatchObject({ code: "PC_LOCK_CONFLICT" });
    }
    const successor = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(successor.token).toBe(successorToken);
    expect(successor.pid).toBe(process.pid);
  });

  it("leaves an existing recover mutex intact and still recovers a bare stale lock", () => {
    const root = tempRoot();
    const lockPath = productionLockPath(root);
    const recoverPath = `${lockPath}.recover`;
    const token = randomUUID();
    const recoverBody = `${JSON.stringify({
      schema: AUTHORING_LOCK_RECOVER_SCHEMA,
      pid: 424242,
      token,
      acquired_at: new Date(Date.now() - 60_000).toISOString()
    })}\n`;
    writeAuthoringLock(lockPath, 424242);
    writeFileSync(recoverPath, recoverBody);
    try {
      withProductionLock(root, () => "no", {
        probePid: (pid) => (pid === 424242 ? "dead" : probePid(pid))
      });
      throw new Error("expected leftover recover mutex to refuse");
    } catch (error) {
      expect(error).toMatchObject({ code: "PC_LOCK_UNSAFE" });
      expect(error.message).toMatch(/interrupted recovery|left unchanged/);
    }
    expect(readFileSync(recoverPath, "utf8")).toBe(recoverBody);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(424242);

    unlinkSync(recoverPath);
    const result = withProductionLock(root, () => "ok", {
      probePid: (pid) => (pid === 424242 ? "dead" : probePid(pid))
    });
    expect(result).toBe("ok");
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(recoverPath)).toBe(false);
  });
});
