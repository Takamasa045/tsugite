import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withProcessLock } from "../adapters/process-lock.mjs";
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const rootDir = async () => { const root = await mkdtemp(join(tmpdir(), "tsugite-lock-")); roots.push(root); return root; };
const child = (root) => new Promise((resolveResult, reject) => {
  const process = spawn(globalThis.process.execPath, [resolve("test/fixtures/process-lock-child.mjs"), root], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; process.stderr.on("data", (b) => stderr += b);
  process.on("error", reject); process.on("exit", (status) => resolveResult({ status, stderr }));
});
async function deadPid() {
  return new Promise((done) => { const p = spawn(process.execPath, ["-e", ""], { stdio: "ignore" }); p.on("exit", () => done(p.pid)); });
}
describe("process lock with conservative stale-owner recovery", () => {
  it.each([false, true])("serializes two OS processes (stale lock: %s)", async (stale) => {
    const root = await rootDir();
    if (stale) await writeFile(join(root, "shared.lock"), JSON.stringify({ version: 1, pid: await deadPid(), nonce: randomUUID() }));
    for (const result of await Promise.all([child(root), child(root)])) expect(result.status, result.stderr).toBe(0);
    expect(await readFile(join(root, "count"), "utf8")).toBe("2");
    const trace = (await readFile(join(root, "trace"), "utf8")).trim().split("\n");
    expect(trace.map((line) => line.split(" ")[0])).toEqual(["enter", "exit", "enter", "exit"]);
    expect(trace[0].split(" ")[1]).toBe(trace[1].split(" ")[1]);
  });
  it("does not steal a live owner's lock or use elapsed time as ownership proof", async () => {
    const root = await rootDir(), bytes = JSON.stringify({ version: 1, pid: process.pid, nonce: randomUUID() });
    await writeFile(join(root, "shared.lock"), bytes);
    const action = vi.fn();
    await expect(withProcessLock(root, "shared.lock", action, { waitMs: 0 })).rejects.toThrow("operation_busy");
    expect(action).not.toHaveBeenCalled(); expect(await readFile(join(root, "shared.lock"), "utf8")).toBe(bytes);
  });
  it.each(["", "{", "x".repeat(1025)])("preserves an unreadable or partial owner record", async (bytes) => {
    const root = await rootDir(); await writeFile(join(root, "shared.lock"), bytes);
    await expect(withProcessLock(root, "shared.lock", () => {}, { waitMs: 0 })).rejects.toThrow("operation_busy");
    expect(await readFile(join(root, "shared.lock"), "utf8")).toBe(bytes);
  });
  it("does not follow a symlink or remove the referenced file", async () => {
    const root = await rootDir(), target = join(root, "retained"); await writeFile(target, "keep"); await symlink(target, join(root, "shared.lock"));
    await expect(withProcessLock(root, "shared.lock", () => {}, { waitMs: 0 })).rejects.toThrow("operation_busy");
    expect(await readFile(target, "utf8")).toBe("keep");
  });
  it("releases its own lock after callback failure without reflecting the callback error", async () => {
    const root = await rootDir();
    await expect(withProcessLock(root, "shared.lock", () => { throw new Error("fixture failure"); })).rejects.toThrow("fixture failure");
    expect(await withProcessLock(root, "shared.lock", () => 42)).toBe(42);
  });
});
