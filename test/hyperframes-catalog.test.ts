import { mkdir, mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_ARGS,
  CATALOG_MAX_ITEMS,
  CATALOG_MAX_STDOUT_BYTES,
  CATALOG_SCHEMA_VERSION,
  isProcessAlive,
  isProcessGroupAlive,
  loadCatalog,
  parseCatalogStdout,
  resolveHyperframesCliEntrypoint,
  runCatalogCommand,
  stopCatalogProcess,
  taskkillWindowsTree
} from "../backends/hyperframes/catalog.mjs";
import {
  REFERENCE_CATALOG_CACHE_MAX_ENTRIES,
  REFERENCE_CATALOG_ID_MAX_LENGTH,
  createReferenceCatalogStore,
  httpStatusForReferenceCatalogFailure,
  isSafeReferenceCatalogId,
  loadReferenceCatalog,
  normalizeReferenceCatalogResult
} from "../src/viewer/referenceCatalog.js";

function stdoutOf(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function validEntry(overrides: Record<string, unknown> = {}) {
  return {
    name: "data-chart",
    type: "block",
    title: "Data Chart",
    description: "Animated bar chart",
    tags: ["data", "chart"],
    dimensions: { width: 1920, height: 1080 },
    duration: 15,
    ...overrides
  };
}

describe("hyperframes catalog vendor command contract", () => {
  it("uses fixed catalog args and a verified repo-local entrypoint shape", () => {
    expect(CATALOG_ARGS).toEqual(["catalog", "--json"]);
    const entry = resolveHyperframesCliEntrypoint();
    expect(entry).toBeTruthy();
    expect(entry).toMatch(/node_modules[/\\].*[/\\]bin[/\\]hyperframes\.mjs$/);
    expect(entry?.includes("..")).toBe(false);
  });
});

describe("parseCatalogStdout", () => {
  it("returns a sanitized advisory payload with only allowed fields", () => {
    const result = parseCatalogStdout(stdoutOf([
      validEntry(),
      validEntry({
        name: "grain-overlay",
        type: "component",
        title: "Grain Overlay",
        description: "Film grain overlay",
        tags: ["texture", "grain"],
        dimensions: undefined,
        duration: undefined,
        secret: "should-not-leak",
        path: "/etc/passwd"
      })
    ]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({
      schemaVersion: CATALOG_SCHEMA_VERSION,
      source: "hyperframes",
      advisoryOnly: true,
      capabilityVerified: false,
      summary: {
        total: 2,
        returned: 2,
        omitted: 0,
        byType: { block: 1, component: 1 }
      }
    });
    expect(result.items[0]).toEqual({
      id: "data-chart",
      type: "block",
      title: "Data Chart",
      description: "Animated bar chart",
      tags: ["data", "chart"],
      dimensions: { width: 1920, height: 1080 },
      durationSeconds: 15
    });
    expect(result.items[1]).toEqual({
      id: "grain-overlay",
      type: "component",
      title: "Grain Overlay",
      description: "Film grain overlay",
      tags: ["texture", "grain"]
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|\/etc\/passwd|stderr|PATH|HOME/);
  });

  it("omits unsafe paths including home, relative, and Windows drive-relative shapes", () => {
    const result = parseCatalogStdout(stdoutOf([
      validEntry(),
      validEntry({ name: "../escape" }),
      validEntry({ name: "abs-path", description: "reads /etc/passwd quietly" }),
      validEntry({ name: "home-path", description: "uses ~/secret quietly" }),
      validEntry({ name: "dot-path", description: "loads ./local file" }),
      validEntry({ name: "parent-path", description: "loads ../escape file" }),
      validEntry({ name: "drive-rel", description: "uses C:secret quietly" }),
      validEntry({ name: "file-url", title: "see file:///tmp/x" }),
      validEntry({ name: "secretish", description: "api_key=abcd1234" }),
      // Colon-glued absolute path + space-separated secret-ish token must not pass through.
      validEntry({
        name: "colon-path-token",
        description: "path:/Users/takamasa/secret token super-secret"
      }),
      validEntry({
        name: "win-colon-path",
        title: "path:C:\\Users\\takamasa\\secret"
      }),
      validEntry({
        name: "token-space",
        description: "token super-secret-value"
      }),
      // Legitimate general wording must still pass.
      validEntry({
        name: "token-economy",
        title: "Token Economy",
        description: "token economy visualization for charts",
        tags: ["data", "economy"]
      }),
      validEntry({ name: "bad-type", type: "preset" }),
      validEntry({ name: "control", title: "bad\u0000title" }),
      { not: "an-entry" }
    ]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => item.id)).toEqual(["data-chart", "token-economy"]);
    expect(result.summary.returned).toBe(2);
    expect(result.summary.omitted).toBe(14);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toMatch(
      /\/etc\/passwd|file:\/\/|api_key=|~\/|C:secret|\\u0000|\/Users\/takamasa|super-secret/
    );
  });

  it("fails when JSON is invalid, root is unsupported, or every entry is unusable", () => {
    expect(parseCatalogStdout(Buffer.from("{", "utf8"))).toMatchObject({
      ok: false,
      issue: { code: "reference_catalog.invalid_json" }
    });
    expect(parseCatalogStdout(stdoutOf({ items: [] }))).toMatchObject({
      ok: false,
      issue: { code: "reference_catalog.schema_unsupported" }
    });
    expect(parseCatalogStdout(stdoutOf([
      validEntry({ name: "/abs" }),
      validEntry({ type: "nope" })
    ]))).toMatchObject({
      ok: false,
      issue: { code: "reference_catalog.schema_unsupported" }
    });
  });

  it("caps the catalog at 500 entries", () => {
    const entries = Array.from({ length: CATALOG_MAX_ITEMS + 3 }, (_, index) => (
      validEntry({ name: `item-${index}`, title: `Item ${index}` })
    ));
    const result = parseCatalogStdout(stdoutOf(entries));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.total).toBe(CATALOG_MAX_ITEMS + 3);
    expect(result.summary.returned).toBe(CATALOG_MAX_ITEMS);
    expect(result.summary.omitted).toBe(3);
    expect(result.warnings.some((warning) => warning.includes("500"))).toBe(true);
  });
});

describe("loadCatalog", () => {
  it("maps command outcomes to stable generic issue codes and never returns stderr/path/env", async () => {
    const cases: Array<{
      result: {
        exitCode: number | null;
        stdout: Buffer;
        timedOut: boolean;
        outputTooLarge: boolean;
        spawnErrorCode?: string;
      };
      code: string;
    }> = [
      {
        result: {
          exitCode: null,
          stdout: Buffer.alloc(0),
          timedOut: false,
          outputTooLarge: false,
          spawnErrorCode: "ENOENT"
        },
        code: "reference_catalog.unavailable"
      },
      {
        result: {
          exitCode: null,
          stdout: Buffer.alloc(0),
          timedOut: true,
          outputTooLarge: false
        },
        code: "reference_catalog.timeout"
      },
      {
        result: {
          exitCode: 0,
          stdout: Buffer.alloc(CATALOG_MAX_STDOUT_BYTES + 1),
          timedOut: false,
          outputTooLarge: true
        },
        code: "reference_catalog.output_too_large"
      },
      {
        result: {
          exitCode: 2,
          stdout: Buffer.from("boom /secret/path HOME=1", "utf8"),
          timedOut: false,
          outputTooLarge: false
        },
        code: "reference_catalog.command_failed"
      },
      {
        result: {
          exitCode: 0,
          stdout: Buffer.from("secret /secret/path HOME=1", "utf8"),
          timedOut: false,
          outputTooLarge: false,
          stoppedCleanly: false
        },
        code: "reference_catalog.command_failed"
      }
    ];

    for (const entry of cases) {
      const payload = await loadCatalog({
        runCommand: vi.fn().mockResolvedValue(entry.result)
      });
      expect(payload).toMatchObject({
        ok: false,
        issue: { code: entry.code }
      });
      expect(JSON.stringify(payload)).not.toMatch(/\/secret\/path|HOME=|stderr|spawn args/);
    }
  });

  it("treats stoppedCleanly:false as a fixed issue and never returns stdout", async () => {
    const payload = await loadCatalog({
      runCommand: async () => ({
        exitCode: 0,
        stdout: stdoutOf([validEntry({ name: "leaky-item", description: "/secret/path HOME=1" })]),
        timedOut: false,
        outputTooLarge: false,
        stoppedCleanly: false
      })
    });
    expect(payload).toEqual({
      ok: false,
      issue: {
        code: "reference_catalog.command_failed",
        message: "Reference catalog command failed"
      }
    });
    expect(JSON.stringify(payload)).not.toMatch(/leaky-item|\/secret\/path|HOME=/);
  });

  it("prefers stoppedCleanly:false over timedOut and never returns partial stdout", async () => {
    const payload = await loadCatalog({
      runCommand: async () => ({
        exitCode: null,
        stdout: stdoutOf([validEntry({ name: "partial-item", description: "/secret/path HOME=1" })]),
        timedOut: true,
        outputTooLarge: false,
        stoppedCleanly: false
      })
    });
    expect(payload).toEqual({
      ok: false,
      issue: {
        code: "reference_catalog.command_failed",
        message: "Reference catalog command failed"
      }
    });
    expect(JSON.stringify(payload)).not.toMatch(/partial-item|\/secret\/path|HOME=/);
  });

  it("parses a successful command result into the public success shape", async () => {
    const payload = await loadCatalog({
      runCommand: async () => ({
        exitCode: 0,
        stdout: stdoutOf([validEntry()]),
        timedOut: false,
        outputTooLarge: false,
        stoppedCleanly: true
      })
    });
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;
    expect(payload.items).toHaveLength(1);
    expect(payload.advisoryOnly).toBe(true);
    expect(payload.capabilityVerified).toBe(false);
  });
});

describe("runCatalogCommand process safety", () => {
  const tempDirs: string[] = [];
  const trackedPids = new Set<number>();

  function isPidAlive(pid: number | null | undefined): boolean {
    if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function forceCleanupPid(pid: number): Promise<void> {
    if (!isPidAlive(pid)) return;
    if (process.platform === "win32") {
      try {
        const { execFile } = await import("node:child_process");
        await new Promise<void>((resolve) => {
          execFile(
            "taskkill",
            ["/PID", String(pid), "/T", "/F"],
            { windowsHide: true, shell: false },
            () => resolve()
          );
        });
      } catch {
        // best-effort
      }
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // process group may already be gone
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already exited
    }
  }

  afterEach(async () => {
    for (const pid of trackedPids) {
      await forceCleanupPid(pid);
    }
    trackedPids.clear();
    tempDirs.length = 0;
  });

  async function writeFixtureScript(source: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "tsugite-catalog-cli-"));
    tempDirs.push(dir);
    const scriptPath = join(dir, "fake-catalog.mjs");
    await writeFile(scriptPath, source, "utf8");
    await chmod(scriptPath, 0o755);
    return scriptPath;
  }

  it("spawns process.execPath with absolute entry, shell false, and fixed args", async () => {
    const scriptPath = await writeFixtureScript(`
      process.stdout.write(JSON.stringify([{
        name: "data-chart",
        type: "block",
        title: "Data Chart",
        description: "ok",
        tags: ["data"]
      }]));
    `);

    const result = await runCatalogCommand({
      entryPath: scriptPath,
      timeoutMs: 2_000
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.spawnErrorCode).toBeUndefined();
    const parsed = parseCatalogStdout(result.stdout);
    expect(parsed.ok).toBe(true);
  });

  it("stops the CLI and same-group descendants on timeout and never leaves orphans", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsugite-catalog-pids-"));
    tempDirs.push(dir);
    const pidFile = join(dir, "pids.json");
    // Grandchild stays in the same process group (no detached). Detached
    // grandchildren escape production group kill and created false positives.
    const scriptPath = await writeFixtureScript(`
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const pidPath = ${JSON.stringify(pidFile)};
      writeFileSync(pidPath, JSON.stringify({ parent: process.pid, child: null }), "utf8");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore"
      });
      writeFileSync(
        pidPath,
        JSON.stringify({ parent: process.pid, child: child.pid ?? null }),
        "utf8"
      );
      setInterval(() => {}, 1000);
    `);

    let parentPid: number | null = null;
    let childPid: number | null = null;
    try {
      const resultPromise = runCatalogCommand({
        entryPath: scriptPath,
        timeoutMs: 300
      });

      await vi.waitFor(async () => {
        try {
          const { readFile } = await import("node:fs/promises");
          const raw = await readFile(pidFile, "utf8");
          const parsed = JSON.parse(raw) as { parent?: unknown; child?: unknown };
          if (
            typeof parsed.parent === "number"
            && typeof parsed.child === "number"
            && parsed.parent > 0
            && parsed.child > 0
          ) {
            parentPid = parsed.parent;
            childPid = parsed.child;
            trackedPids.add(parentPid);
            trackedPids.add(childPid);
            return;
          }
        } catch {
          // wait for fixture to publish pids
        }
        throw new Error("pid file not ready");
      }, { timeout: 2_000 });

      const result = await resultPromise;
      expect(result.timedOut).toBe(true);
      expect(result.stoppedCleanly).toBe(true);

      await vi.waitFor(() => {
        expect(isPidAlive(parentPid)).toBe(false);
        expect(isPidAlive(childPid)).toBe(false);
      }, { timeout: 2_000 });
    } finally {
      if (parentPid) await forceCleanupPid(parentPid);
      if (childPid) await forceCleanupPid(childPid);
      if (parentPid) trackedPids.delete(parentPid);
      if (childPid) trackedPids.delete(childPid);
    }
  });

  it("reaps SIGTERM-ignoring same-group children after parent exits (POSIX)", async () => {
    if (process.platform === "win32") return;

    const dir = await mkdtemp(join(tmpdir(), "tsugite-catalog-term-ignore-"));
    tempDirs.push(dir);
    const pidFile = join(dir, "pids.json");
    // Parent exits on SIGTERM (default). Child ignores SIGTERM and stays in
    // the same process group — stop must SIGKILL the group, not trust parent close.
    const scriptPath = await writeFixtureScript(`
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const pidPath = ${JSON.stringify(pidFile)};
      const child = spawn(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
        { stdio: "ignore" }
      );
      writeFileSync(
        pidPath,
        JSON.stringify({ parent: process.pid, child: child.pid ?? null }),
        "utf8"
      );
      setInterval(() => {}, 1000);
    `);

    let parentPid: number | null = null;
    let childPid: number | null = null;
    let groupLeader: number | null = null;
    try {
      const resultPromise = runCatalogCommand({
        entryPath: scriptPath,
        timeoutMs: 300,
        stopGraceMs: 150,
        stopHardMs: 500,
        stopBudgetMs: 2_000
      });

      await vi.waitFor(async () => {
        try {
          const { readFile } = await import("node:fs/promises");
          const raw = await readFile(pidFile, "utf8");
          const parsed = JSON.parse(raw) as { parent?: unknown; child?: unknown };
          if (
            typeof parsed.parent === "number"
            && typeof parsed.child === "number"
            && parsed.parent > 0
            && parsed.child > 0
          ) {
            parentPid = parsed.parent;
            childPid = parsed.child;
            groupLeader = parsed.parent;
            trackedPids.add(parentPid);
            trackedPids.add(childPid);
            return;
          }
        } catch {
          // wait for fixture
        }
        throw new Error("pid file not ready");
      }, { timeout: 2_000 });

      const result = await resultPromise;
      expect(result.timedOut).toBe(true);
      expect(result.stoppedCleanly).toBe(true);

      await vi.waitFor(() => {
        expect(isPidAlive(parentPid)).toBe(false);
        expect(isPidAlive(childPid)).toBe(false);
        expect(isProcessGroupAlive(groupLeader)).toBe(false);
      }, { timeout: 2_000 });
    } finally {
      if (parentPid) await forceCleanupPid(parentPid);
      if (childPid) await forceCleanupPid(childPid);
      if (parentPid) trackedPids.delete(parentPid);
      if (childPid) trackedPids.delete(childPid);
    }
  });

  it("reports stoppedCleanly:false in finite time when group kill fails or group remains", async () => {
    if (process.platform === "win32") return;

    const started = Date.now();
    const fake = {
      pid: 55_001,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill() {
        return true;
      },
      off() {
        return this;
      },
      once(event: string, cb: (...args: unknown[]) => void) {
        // Soft wait: parent appears to exit after TERM.
        if (event === "close") {
          queueMicrotask(() => {
            this.exitCode = 1;
            cb(1);
          });
        }
        return this;
      }
    };

    const stop = await stopCatalogProcess(fake as never, {
      platform: "darwin",
      processGroupId: 55_001,
      stopGraceMs: 40,
      stopHardMs: 40,
      stopBudgetMs: 200,
      isProcessAlive: () => false,
      // Group never dies — unclean stop.
      isProcessGroupAlive: () => true,
      signalProcessTree: async () => ({ ok: false, code: "EPERM" })
    });
    const elapsed = Date.now() - started;

    expect(stop.stopped).toBe(false);
    expect(stop.alive).toBe(true);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("stopCatalogProcess reports stopped for already-exited children", async () => {
    const scriptPath = await writeFixtureScript(`process.exit(0);`);
    const result = await runCatalogCommand({
      entryPath: scriptPath,
      timeoutMs: 2_000
    });
    expect(result.exitCode).toBe(0);
    // Already finished process handle is not retained; exercise helper with a fake.
    const fake = {
      pid: process.pid + 100000,
      exitCode: 0,
      signalCode: null,
      kill() { return true; },
      off() { return this; },
      once() { return this; }
    };
    const stop = await stopCatalogProcess(fake as never, {
      // Non-existent pgid must probe as gone (ESRCH), not hang.
      isProcessGroupAlive: () => false
    });
    expect(stop.stopped).toBe(true);
    expect(stop.alive).toBe(false);
  });

  it("taskkillWindowsTree applies a short timeout and propagates hang as failure", async () => {
    const started = Date.now();
    const result = await taskkillWindowsTree(42_424, {
      timeoutMs: 80,
      execFile: (_file, _args, _opts, _cb) => {
        // Never invokes callback — simulates a hung taskkill.
        return {
          kill() {
            // best-effort cancel
          }
        };
      }
    });
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("taskkillWindowsTree propagates non-zero / error results", async () => {
    const result = await taskkillWindowsTree(42_425, {
      timeoutMs: 500,
      execFile: (_file, _args, _opts, cb) => {
        queueMicrotask(() => {
          const error = Object.assign(new Error("access denied"), { code: "EACCES" });
          cb(error);
        });
        return { kill() {} };
      }
    });
    expect(result).toMatchObject({ ok: false, timedOut: false, code: "EACCES" });
  });

  it("bounds Windows stop when taskkill hangs and resolves with stoppedCleanly:false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsugite-catalog-win-stop-"));
    tempDirs.push(dir);
    const pidFile = join(dir, "pid.json");
    const scriptPath = await writeFixtureScript(`
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: process.pid }), "utf8");
      setInterval(() => {}, 1000);
    `);

    let parentPid: number | null = null;
    const started = Date.now();
    try {
      const resultPromise = runCatalogCommand({
        entryPath: scriptPath,
        timeoutMs: 200,
        platform: "win32",
        stopBudgetMs: 400,
        stopGraceMs: 50,
        stopHardMs: 50,
        // Hung taskkill must not hang the HTTP/catalog request.
        killWindowsTree: async () => await new Promise(() => {}),
        isProcessAlive: () => true
      });

      await vi.waitFor(async () => {
        try {
          const { readFile } = await import("node:fs/promises");
          const raw = await readFile(pidFile, "utf8");
          const parsed = JSON.parse(raw) as { pid?: unknown };
          if (typeof parsed.pid === "number" && parsed.pid > 0) {
            parentPid = parsed.pid;
            trackedPids.add(parentPid);
            return;
          }
        } catch {
          // wait for fixture
        }
        throw new Error("pid file not ready");
      }, { timeout: 2_000 });

      const result = await resultPromise;
      const elapsed = Date.now() - started;
      expect(result.timedOut).toBe(true);
      expect(result.stoppedCleanly).toBe(false);
      // timeoutMs + stopBudgetMs + small slack; must not hang forever.
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      if (parentPid) {
        await forceCleanupPid(parentPid);
        trackedPids.delete(parentPid);
      }
    }
  });

  it("best-effort kills the direct child when Windows taskkill fails but does not claim clean tree stop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsugite-catalog-win-kill-"));
    tempDirs.push(dir);
    const pidFile = join(dir, "pid.json");
    const scriptPath = await writeFixtureScript(`
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: process.pid }), "utf8");
      setInterval(() => {}, 1000);
    `);

    let parentPid: number | null = null;
    const started = Date.now();
    try {
      const killWindowsTree = vi.fn(async () => ({ ok: false, timedOut: false, code: "EACCES" }));
      const resultPromise = runCatalogCommand({
        entryPath: scriptPath,
        timeoutMs: 200,
        platform: "win32",
        stopBudgetMs: 1_500,
        stopGraceMs: 200,
        stopHardMs: 200,
        killWindowsTree
      });

      await vi.waitFor(async () => {
        try {
          const { readFile } = await import("node:fs/promises");
          const raw = await readFile(pidFile, "utf8");
          const parsed = JSON.parse(raw) as { pid?: unknown };
          if (typeof parsed.pid === "number" && parsed.pid > 0) {
            parentPid = parsed.pid;
            trackedPids.add(parentPid);
            return;
          }
        } catch {
          // wait
        }
        throw new Error("pid file not ready");
      }, { timeout: 2_000 });

      const result = await resultPromise;
      const elapsed = Date.now() - started;
      expect(result.timedOut).toBe(true);
      expect(killWindowsTree).toHaveBeenCalled();
      // Direct child.kill after taskkill failure may reap the parent, but
      // descendants are unconfirmed without taskkill /T success.
      await vi.waitFor(() => {
        expect(isPidAlive(parentPid)).toBe(false);
      }, { timeout: 2_000 });
      expect(result.stoppedCleanly).toBe(false);
      expect(elapsed).toBeLessThan(3_000);

      const payload = await loadCatalog({
        runCommand: async () => result
      });
      expect(payload).toEqual({
        ok: false,
        issue: {
          code: "reference_catalog.command_failed",
          message: "Reference catalog command failed"
        }
      });
      expect(JSON.stringify(payload)).not.toMatch(/partial|stdout|secret/i);
    } finally {
      if (parentPid) {
        await forceCleanupPid(parentPid);
        trackedPids.delete(parentPid);
      }
    }
  });

  it("Windows stopCatalogProcess keeps tree-kill failure even when parent direct kill succeeds", async () => {
    const started = Date.now();
    const fake = {
      pid: 55_101,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill() {
        return true;
      },
      off() {
        return this;
      },
      once(event: string, cb: (...args: unknown[]) => void) {
        if (event === "close") {
          queueMicrotask(() => {
            this.exitCode = 1;
            cb(1);
          });
        }
        return this;
      }
    };

    const stop = await stopCatalogProcess(fake as never, {
      platform: "win32",
      stopGraceMs: 40,
      stopHardMs: 40,
      stopBudgetMs: 200,
      isProcessAlive: () => false,
      signalProcessTree: async () => ({ ok: false, timedOut: false, code: "EACCES" })
    });
    const elapsed = Date.now() - started;

    expect(stop.stopped).toBe(false);
    expect(stop.alive).toBe(false);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("isProcessAlive / isProcessGroupAlive treat only ESRCH as gone via kill code seam", () => {
    expect(
      isProcessAlive(12_345, {
        kill: () => {
          const error = Object.assign(new Error("no such process"), { code: "ESRCH" });
          throw error;
        }
      })
    ).toBe(false);
    expect(
      isProcessAlive(12_345, {
        kill: () => {
          const error = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
          throw error;
        }
      })
    ).toBe(true);
    expect(
      isProcessGroupAlive(12_345, {
        kill: () => {
          const error = Object.assign(new Error("no such process"), { code: "ESRCH" });
          throw error;
        }
      })
    ).toBe(false);
    expect(
      isProcessGroupAlive(12_345, {
        kill: () => {
          const error = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
          throw error;
        }
      })
    ).toBe(true);
  });
});

describe("referenceCatalog dispatcher", () => {
  it("rejects catalog ids longer than 64 characters before provider or busy work", async () => {
    const allowed = `c${"a".repeat(REFERENCE_CATALOG_ID_MAX_LENGTH - 1)}`;
    const rejected = `c${"a".repeat(REFERENCE_CATALOG_ID_MAX_LENGTH)}`;
    expect(allowed).toHaveLength(64);
    expect(rejected).toHaveLength(65);
    expect(isSafeReferenceCatalogId(allowed)).toBe(true);
    expect(isSafeReferenceCatalogId(rejected)).toBe(false);

    const store = createReferenceCatalogStore();
    const loadProvider = vi.fn(async () => {
      throw new Error("provider must not run for oversized ids");
    });

    const result = await loadReferenceCatalog(rejected, {
      store,
      loadProvider,
      cacheTtlMs: 5_000
    });
    expect(result).toEqual({
      ok: false,
      issue: {
        code: "reference_catalog.not_found",
        message: "Reference catalog was not found"
      }
    });
    expect(loadProvider).not.toHaveBeenCalled();
    expect(store.busy.has(rejected)).toBe(false);
    expect(store.cache.has(rejected)).toBe(false);
    expect(store.busy.size).toBe(0);
  });

  it("rejects concurrent loads with a stable busy code and caches short-term results", async () => {
    const store = createReferenceCatalogStore();
    let release!: (value: ReturnType<typeof normalizeReferenceCatalogResult>) => void;
    const gate = new Promise<ReturnType<typeof normalizeReferenceCatalogResult>>((resolve) => {
      release = resolve;
    });
    const loadProvider = vi.fn().mockImplementation(async () => gate);

    const firstPromise = loadReferenceCatalog("demo", {
      store,
      loadProvider,
      cacheTtlMs: 5_000
    });

    await vi.waitFor(() => expect(loadProvider).toHaveBeenCalledTimes(1));

    const busy = await loadReferenceCatalog("demo", {
      store,
      loadProvider,
      cacheTtlMs: 5_000
    });
    expect(busy).toEqual({
      ok: false,
      issue: {
        code: "reference_catalog.busy",
        message: "Reference catalog is already loading"
      }
    });
    expect(httpStatusForReferenceCatalogFailure("reference_catalog.busy")).toBe(429);

    release(normalizeReferenceCatalogResult({
      ok: true,
      schemaVersion: 1,
      source: "demo",
      advisoryOnly: true,
      capabilityVerified: false,
      summary: { total: 1, returned: 1, omitted: 0, byType: { block: 1, component: 0 } },
      items: [{
        id: "data-chart",
        type: "block",
        title: "Data Chart",
        description: "ok",
        tags: ["data"]
      }],
      warnings: []
    }));

    const first = await firstPromise;
    expect(first.ok).toBe(true);

    const cached = await loadReferenceCatalog("demo", {
      store,
      loadProvider,
      cacheTtlMs: 5_000
    });
    expect(cached.ok).toBe(true);
    expect(loadProvider).toHaveBeenCalledTimes(1);
  });

  it("maps missing providers to not_found without leaking paths", async () => {
    const result = await loadReferenceCatalog("missing-catalog-xyz", {
      store: createReferenceCatalogStore(),
      backendDirs: [await mkdtemp(join(tmpdir(), "tsugite-no-backends-"))]
    });
    expect(result).toMatchObject({
      ok: false,
      issue: { code: "reference_catalog.not_found" }
    });
    expect(JSON.stringify(result)).not.toMatch(/\/Users\/|node_modules|PATH|HOME|stderr/);
  });

  it("sanitizes provider failure messages and never reflects path/token-like text", () => {
    const normalized = normalizeReferenceCatalogResult({
      ok: false,
      issue: {
        code: "reference_catalog.command_failed",
        message:
          "spawn failed at /Users/takamasa/secret/cli token=super-secret-value PATH=/tmp HOME=/Users/takamasa"
      }
    });
    expect(normalized).toEqual({
      ok: false,
      issue: {
        code: "reference_catalog.command_failed",
        message: "Reference catalog command failed"
      }
    });
    expect(JSON.stringify(normalized)).not.toMatch(
      /\/Users\/|token=|super-secret|PATH=|HOME=|spawn failed/
    );
  });

  it("bounds catalog cache under id rotation and does not retain unknown-id failures", async () => {
    const store = createReferenceCatalogStore();
    const loadProvider = vi.fn(async (catalogId: string) => (
      catalogId.startsWith("missing-")
        ? {
          ok: false as const,
          issue: {
            code: "reference_catalog.not_found" as const,
            message: "Reference catalog was not found"
          }
        }
        : normalizeReferenceCatalogResult({
          ok: true,
          schemaVersion: 1,
          source: catalogId,
          advisoryOnly: true,
          capabilityVerified: false,
          summary: { total: 1, returned: 1, omitted: 0, byType: { block: 1, component: 0 } },
          items: [{
            id: "data-chart",
            type: "block",
            title: "Data Chart",
            description: "ok",
            tags: ["data"]
          }],
          warnings: []
        })
    ));

    for (let index = 0; index < 2_000; index += 1) {
      // Unknown ids must not accumulate.
      await loadReferenceCatalog(`missing-${index}`, {
        store,
        loadProvider,
        cacheTtlMs: 60_000
      });
      // Successful ids rotate beyond the bound.
      await loadReferenceCatalog(`ok-${index}`, {
        store,
        loadProvider,
        cacheTtlMs: 60_000
      });
    }

    expect(store.cache.size).toBeLessThanOrEqual(REFERENCE_CATALOG_CACHE_MAX_ENTRIES);
    expect(store.cache.size).toBeGreaterThan(0);
    expect([...store.cache.keys()].some((id) => id.startsWith("missing-"))).toBe(false);

    // single-flight busy rejection remains available for a live key.
    let release!: (value: ReturnType<typeof normalizeReferenceCatalogResult>) => void;
    const gate = new Promise<ReturnType<typeof normalizeReferenceCatalogResult>>((resolve) => {
      release = resolve;
    });
    const busyProvider = vi.fn().mockImplementation(async () => gate);
    const firstPromise = loadReferenceCatalog("busy-demo", {
      store,
      loadProvider: busyProvider,
      cacheTtlMs: 5_000
    });
    await vi.waitFor(() => expect(busyProvider).toHaveBeenCalledTimes(1));
    const busy = await loadReferenceCatalog("busy-demo", {
      store,
      loadProvider: busyProvider,
      cacheTtlMs: 5_000
    });
    expect(busy).toMatchObject({
      ok: false,
      issue: { code: "reference_catalog.busy" }
    });
    expect(httpStatusForReferenceCatalogFailure("reference_catalog.busy")).toBe(429);
    release(normalizeReferenceCatalogResult({
      ok: true,
      schemaVersion: 1,
      source: "busy-demo",
      advisoryOnly: true,
      capabilityVerified: false,
      summary: { total: 1, returned: 1, omitted: 0, byType: { block: 1, component: 0 } },
      items: [{
        id: "data-chart",
        type: "block",
        title: "Data Chart",
        description: "ok",
        tags: ["data"]
      }],
      warnings: []
    }));
    await firstPromise;
  });

  it("evicts expired cache entries during subsequent loads", async () => {
    const store = createReferenceCatalogStore();
    const loadProvider = vi.fn().mockResolvedValue(normalizeReferenceCatalogResult({
      ok: true,
      schemaVersion: 1,
      source: "demo",
      advisoryOnly: true,
      capabilityVerified: false,
      summary: { total: 1, returned: 1, omitted: 0, byType: { block: 1, component: 0 } },
      items: [{
        id: "data-chart",
        type: "block",
        title: "Data Chart",
        description: "ok",
        tags: ["data"]
      }],
      warnings: []
    }));

    await loadReferenceCatalog("demo-expired", {
      store,
      loadProvider,
      cacheTtlMs: 1
    });
    expect(store.cache.has("demo-expired")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await loadReferenceCatalog("demo-next", {
      store,
      loadProvider,
      cacheTtlMs: 5_000
    });
    expect(store.cache.has("demo-expired")).toBe(false);
    expect(store.cache.has("demo-next")).toBe(true);
  });
});
