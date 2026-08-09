import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireRunLock,
  createPlannedState,
  markGateAwaiting,
  readState,
  recordGateDecision,
  RunLockBoundaryError,
  writeState
} from "../src/orchestrator/state.js";
import { captureDirectoryIdentity } from "../src/orchestrator/finalizePersistence.js";

describe("run state", () => {
  it("writes and reads state by run id", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-state-"));
    const path = await writeState(root, {
      run_id: "run-001",
      status: "dry_run",
      updated_at: "2026-07-09T00:00:00.000Z",
      gates: {
        gate_1: { status: "pending" },
        gate_2: { status: "pending" },
        gate_3: { status: "pending" }
      }
    });

    const state = await readState(path);

    expect(state.run_id).toBe("run-001");
    expect(state.status).toBe("dry_run");
  });

  it("leaves no temporary state file when the atomic rename fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-state-"));
    const runDir = join(root, "run-write-failure");
    await mkdir(join(runDir, "state.json"), { recursive: true });

    await expect(
      writeState(root, createPlannedState("run-write-failure", "2026-07-09T00:00:00.000Z"))
    ).rejects.toThrow();

    expect(await readdir(runDir)).toEqual(["state.json"]);
  });

  it("allows only one filesystem-backed run lock holder and releases explicitly", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-state-"));
    const attempts = await Promise.allSettled([
      acquireRunLock(root, "run-locked"),
      acquireRunLock(root, "run-locked")
    ]);
    const acquired = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireRunLock>>> =>
        attempt.status === "fulfilled"
    );
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");

    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "run.locked" });

    await acquired[0].value.release();
    const reacquired = await acquireRunLock(root, "run-locked");
    await reacquired.release();
  });

  it("does not steal an existing lock based on its age", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-state-"));
    const held = await acquireRunLock(root, "run-stale-safe");

    try {
      await expect(acquireRunLock(root, "run-stale-safe")).rejects.toMatchObject({ code: "run.locked" });
    } finally {
      await held.release();
    }
  });

  it("lets a child adopt only the current lock token without releasing the parent lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-state-"));
    const parent = await acquireRunLock(root, "run-inherited");

    const child = await acquireRunLock(root, "run-inherited", parent.token);
    await child.release();
    await expect(acquireRunLock(root, "run-inherited")).rejects.toMatchObject({ code: "run.locked" });
    await expect(acquireRunLock(root, "run-inherited", "wrong-token")).rejects.toMatchObject({ code: "run.locked" });

    await parent.release();
    const reacquired = await acquireRunLock(root, "run-inherited");
    await reacquired.release();
  });

  it("excludes a second process from the same run", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-state-"));
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--eval",
        [
          'import { acquireRunLock } from "./src/orchestrator/state.ts";',
          'const lock = await acquireRunLock(process.argv[1], "run-cross-process");',
          'process.stdout.write("locked\\n");',
          "await new Promise((resolve) => process.stdin.once(\"data\", resolve));",
          "await lock.release();"
        ].join("\n"),
        root
      ],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] }
    );
    const exited = once(child, "exit");
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code !== 0) reject(new Error(`lock child exited with status ${code}`));
      });
    });

    try {
      await ready;
      await expect(acquireRunLock(root, "run-cross-process")).rejects.toMatchObject({ code: "run.locked" });
    } finally {
      child.stdin.end("release\n");
      await exited;
    }

    const reacquired = await acquireRunLock(root, "run-cross-process");
    await reacquired.release();
  });

  it("recovers a lock after its owning process is force-killed", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-state-"));
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--eval",
        [
          'import { acquireRunLock } from "./src/orchestrator/state.ts";',
          'await acquireRunLock(process.argv[1], "run-killed");',
          'process.stdout.write("locked\\n");',
          "await new Promise(() => undefined);"
        ].join("\n"),
        root
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }
    );
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`lock child exited early with status ${code}`)));
    });
    child.kill("SIGKILL");
    await once(child, "exit");

    const recovered = await acquireRunLock(root, "run-killed");
    await recovered.release();
  });

  it("rejects unsafe run ids before creating a lock path", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-state-"));

    await expect(acquireRunLock(root, "../escaped")).rejects.toThrow("must be a safe id");
  });

  it("refuses lock creation after stateDir is swapped to an external symlink", async () => {
    const project = await mkdtemp(join(tmpdir(), "tsugite-state-swap-proj-"));
    const stateDir = join(project, "dist");
    await mkdir(stateDir, { recursive: true });
    const identity = await captureDirectoryIdentity(stateDir);

    const external = await mkdtemp(join(tmpdir(), "tsugite-state-swap-ext-"));
    const backup = join(project, "dist.backup");
    await rename(stateDir, backup);
    await symlink(external, stateDir);

    await expect(
      acquireRunLock(stateDir, "demo-v2", undefined, {
        expectedStateDir: identity,
        containWithin: project
      })
    ).rejects.toBeInstanceOf(RunLockBoundaryError);

    expect(await readdir(external)).toEqual([]);
  });

  it("refuses lock creation when expected stateDir path or identity does not match", async () => {
    const project = await mkdtemp(join(tmpdir(), "tsugite-state-id-"));
    const stateDir = join(project, "dist");
    await mkdir(stateDir, { recursive: true });
    const identity = await captureDirectoryIdentity(stateDir);

    await expect(
      acquireRunLock(join(project, "other"), "demo-v2", undefined, {
        expectedStateDir: identity,
        containWithin: project
      })
    ).rejects.toMatchObject({ code: "finalize.state_dir_changed" });

    const otherDir = join(project, "other-dist");
    await mkdir(otherDir);
    await expect(
      acquireRunLock(otherDir, "demo-v2", undefined, {
        expectedStateDir: { ...identity, path: otherDir },
        containWithin: project
      })
    ).rejects.toMatchObject({ code: "finalize.state_dir_changed" });

    // Happy path with expected identity still acquires.
    const lock = await acquireRunLock(stateDir, "demo-v2", undefined, {
      expectedStateDir: identity,
      containWithin: project
    });
    await lock.release();
  });

  it("Unit 7C: refuses lock when stateDir is replaced after identity check and does not lock external", async () => {
    const project = await mkdtemp(join(tmpdir(), "tsugite-state-toctou-swap-"));
    const stateDir = join(project, "dist");
    await mkdir(stateDir, { recursive: true });
    const identity = await captureDirectoryIdentity(stateDir);
    const external = await mkdtemp(join(tmpdir(), "tsugite-state-toctou-ext-"));
    await mkdir(join(external, "demo-v2"), { recursive: true });

    await expect(
      acquireRunLock(stateDir, "demo-v2", undefined, {
        expectedStateDir: identity,
        containWithin: project,
        _testHooks: {
          afterIdentityCheckBeforeOpen: async () => {
            const backup = join(project, "dist.backup");
            await rename(stateDir, backup);
            await symlink(external, stateDir);
          }
        }
      })
    ).rejects.toBeInstanceOf(RunLockBoundaryError);

    // Pre-open revalidation refuses the swapped path before creating a lock on external.
    expect(await readdir(join(external, "demo-v2"))).toEqual([]);
  });

  it("Unit 7C: refuses lock when a symlink ancestor appears before open", async () => {
    const project = await mkdtemp(join(tmpdir(), "tsugite-state-toctou-anc-"));
    const nested = join(project, "nested");
    const stateDir = join(nested, "dist");
    await mkdir(stateDir, { recursive: true });
    const identity = await captureDirectoryIdentity(stateDir);
    const external = await mkdtemp(join(tmpdir(), "tsugite-state-toctou-anc-ext-"));

    await expect(
      acquireRunLock(stateDir, "demo-v2", undefined, {
        expectedStateDir: identity,
        containWithin: project,
        _testHooks: {
          afterIdentityCheckBeforeOpen: async () => {
            // Replace nested with a symlink so stateDir path gains a symlink ancestor.
            const backup = join(project, "nested.backup");
            await rename(nested, backup);
            await symlink(join(external, "nested"), nested);
            await mkdir(join(external, "nested", "dist", "demo-v2"), { recursive: true });
          }
        }
      })
    ).rejects.toMatchObject({
      name: "RunLockBoundaryError"
    });

    expect(await readdir(join(external, "nested", "dist", "demo-v2")).catch(() => [])).toEqual([]);
  });

  it("Unit 7C: refuses when lock leaf is replaced with a symlink after create", async () => {
    const project = await mkdtemp(join(tmpdir(), "tsugite-state-toctou-leaf-"));
    const stateDir = join(project, "dist");
    await mkdir(stateDir, { recursive: true });
    const identity = await captureDirectoryIdentity(stateDir);
    const externalLock = join(project, "external-lock-target");
    await writeFile(externalLock, "foreign\n");

    await expect(
      acquireRunLock(stateDir, "demo-v2", undefined, {
        expectedStateDir: identity,
        containWithin: project,
        _testHooks: {
          afterLockCreatedBeforeValidate: async () => {
            const lockPath = join(stateDir, "demo-v2", ".mutation.lock");
            await unlink(lockPath);
            await symlink(externalLock, lockPath);
          }
        }
      })
    ).rejects.toMatchObject({
      name: "RunLockBoundaryError"
    });

    // External target must not be truncated or removed by failed lock cleanup.
    expect(await readFile(externalLock, "utf8")).toBe("foreign\n");
    const lockPath = join(stateDir, "demo-v2", ".mutation.lock");
    // Symlink leaf may remain; release must not have followed it to delete external.
    const leaf = await lstat(lockPath).catch(() => undefined);
    if (leaf?.isSymbolicLink()) {
      expect(await readFile(externalLock, "utf8")).toBe("foreign\n");
    }
  });

  it("Unit 7C: refuses when runDir is replaced after identity capture", async () => {
    const project = await mkdtemp(join(tmpdir(), "tsugite-state-toctou-rundir-"));
    const stateDir = join(project, "dist");
    await mkdir(stateDir, { recursive: true });
    const identity = await captureDirectoryIdentity(stateDir);
    const externalRun = await mkdtemp(join(tmpdir(), "tsugite-state-toctou-run-ext-"));

    await expect(
      acquireRunLock(stateDir, "demo-v2", undefined, {
        expectedStateDir: identity,
        containWithin: project,
        _testHooks: {
          afterIdentityCheckBeforeOpen: async () => {
            const runDir = join(stateDir, "demo-v2");
            const backup = join(stateDir, "demo-v2.backup");
            await rename(runDir, backup);
            await symlink(externalRun, runDir);
          }
        }
      })
    ).rejects.toMatchObject({
      name: "RunLockBoundaryError"
    });

    expect(await readdir(externalRun)).toEqual([]);
  });

  it("Unit 7C: refuses when runDir is swapped after lock create and does not unlink the new ancestor", async () => {
    const project = await mkdtemp(join(tmpdir(), "tsugite-state-toctou-post-"));
    const stateDir = join(project, "dist");
    await mkdir(stateDir, { recursive: true });
    const identity = await captureDirectoryIdentity(stateDir);
    const externalRun = await mkdtemp(join(tmpdir(), "tsugite-state-toctou-post-ext-"));
    await writeFile(join(externalRun, "keep.txt"), "external-keep\n");

    await expect(
      acquireRunLock(stateDir, "demo-v2", undefined, {
        expectedStateDir: identity,
        containWithin: project,
        _testHooks: {
          afterLockCreatedBeforeValidate: async () => {
            const runDir = join(stateDir, "demo-v2");
            const backup = join(stateDir, "demo-v2.backup");
            await rename(runDir, backup);
            await symlink(externalRun, runDir);
          }
        }
      })
    ).rejects.toMatchObject({
      code: "finalize.run_dir_changed"
    });

    // New ancestor must keep its pre-existing files; path-based cleanup must not hit it.
    expect(await readFile(join(externalRun, "keep.txt"), "utf8")).toBe("external-keep\n");
    expect(await readdir(externalRun)).toEqual(["keep.txt"]);
    // Original lock may remain under the renamed runDir (orphan is preferred over external damage).
    await expect(lstat(join(stateDir, "demo-v2.backup", ".mutation.lock"))).resolves.toBeDefined();
  });

  it("Unit 7C: rejects pre-existing symlink lock leaf before create", async () => {
    const project = await mkdtemp(join(tmpdir(), "tsugite-state-leaf-pre-"));
    const stateDir = join(project, "dist");
    const runDir = join(stateDir, "demo-v2");
    await mkdir(runDir, { recursive: true });
    const identity = await captureDirectoryIdentity(stateDir);
    const external = join(project, "foreign.lock");
    await writeFile(external, "foreign\n");
    await symlink(external, join(runDir, ".mutation.lock"));

    await expect(
      acquireRunLock(stateDir, "demo-v2", undefined, {
        expectedStateDir: identity,
        containWithin: project
      })
    ).rejects.toBeInstanceOf(RunLockBoundaryError);

    expect(await readFile(external, "utf8")).toBe("foreign\n");
  });

  it("Unit 7C: revalidates expectedStateDir on inherited lock token path", async () => {
    const project = await mkdtemp(join(tmpdir(), "tsugite-state-inherit-"));
    const stateDir = join(project, "dist");
    await mkdir(stateDir, { recursive: true });
    const identity = await captureDirectoryIdentity(stateDir);
    const primary = await acquireRunLock(stateDir, "demo-v2", undefined, {
      expectedStateDir: identity,
      containWithin: project
    });

    const delegated = await acquireRunLock(stateDir, "demo-v2", primary.token, {
      expectedStateDir: identity,
      containWithin: project
    });
    expect(delegated.token).toBe(primary.token);
    await delegated.release();
    await primary.release();
  });

  it("tracks gate 1-3 decisions without skipping approval states", () => {
    const planned = createPlannedState("run-002", "2026-07-09T00:00:00.000Z");
    const awaitingGate1 = markGateAwaiting(planned, "gate_1", "2026-07-09T00:01:00.000Z");
    const approvedGate1 = recordGateDecision(awaitingGate1, "gate_1", "approved", "2026-07-09T00:02:00.000Z");

    expect(awaitingGate1.status).toBe("awaiting_gate_1");
    expect(awaitingGate1.gates.gate_1.status).toBe("awaiting_approval");
    expect(approvedGate1.status).toBe("running");
    expect(approvedGate1.gates.gate_1.status).toBe("approved");
    expect(() => recordGateDecision(planned, "gate_2", "approved", "2026-07-09T00:03:00.000Z")).toThrow(
      "cannot decide gate_2 before gate_1 is approved"
    );
  });

  it("binds an analysis Gate 1 approval to the reviewed input digest", () => {
    const planned = createPlannedState("analysis-run", "2026-07-09T00:00:00.000Z");
    const awaiting = markGateAwaiting(planned, "gate_1", "2026-07-09T00:01:00.000Z");
    const approved = recordGateDecision(
      awaiting,
      "gate_1",
      "approved",
      "2026-07-09T00:02:00.000Z",
      "a".repeat(64)
    );

    expect(approved.gates.gate_1).toMatchObject({
      status: "approved",
      approved_input_digest: "a".repeat(64)
    });
  });

  it("binds Gate 2 approval to the inspected run artifact digest", () => {
    const planned = createPlannedState("analysis-run", "2026-07-09T00:00:00.000Z");
    const gate1 = markGateAwaiting(planned, "gate_1", "2026-07-09T00:01:00.000Z");
    const running = recordGateDecision(gate1, "gate_1", "approved", "2026-07-09T00:02:00.000Z");
    const gate2 = markGateAwaiting(running, "gate_2", "2026-07-09T00:03:00.000Z");
    const approved = recordGateDecision(
      gate2,
      "gate_2",
      "approved",
      "2026-07-09T00:04:00.000Z",
      "b".repeat(64)
    );

    expect(approved.gates.gate_2).toMatchObject({
      status: "approved",
      approved_input_digest: "b".repeat(64)
    });
  });

  it("persists optional person_qa_approval_digest on Gate 2/3 approve and parses older state without it", async () => {
    const planned = createPlannedState("person-qa-run", "2026-07-09T00:00:00.000Z");
    const gate1 = markGateAwaiting(planned, "gate_1", "2026-07-09T00:01:00.000Z");
    const running = recordGateDecision(gate1, "gate_1", "approved", "2026-07-09T00:02:00.000Z");
    const gate2 = markGateAwaiting(running, "gate_2", "2026-07-09T00:03:00.000Z");
    const gate2Approved = recordGateDecision(
      gate2,
      "gate_2",
      "approved",
      "2026-07-09T00:04:00.000Z",
      "b".repeat(64),
      "human",
      "c".repeat(64)
    );
    expect(gate2Approved.gates.gate_2).toMatchObject({
      status: "approved",
      approved_input_digest: "b".repeat(64),
      person_qa_approval_digest: "c".repeat(64)
    });
    // Gate 1 and other gates remain without person_qa_approval_digest.
    expect(gate2Approved.gates.gate_1.person_qa_approval_digest).toBeUndefined();
    expect(gate2Approved.gates.gate_3.person_qa_approval_digest).toBeUndefined();

    const rendering = markGateAwaiting(gate2Approved, "gate_3", "2026-07-09T00:05:00.000Z");
    // Gate 3 keeps approved_input_digest as final.mp4 sha256 and stores person-QA digest separately.
    const gate3Approved = recordGateDecision(
      rendering,
      "gate_3",
      "approved",
      "2026-07-09T00:06:00.000Z",
      "d".repeat(64),
      "human",
      "e".repeat(64)
    );
    expect(gate3Approved.gates.gate_3).toMatchObject({
      status: "approved",
      approved_input_digest: "d".repeat(64),
      person_qa_approval_digest: "e".repeat(64)
    });

    const root = await mkdtemp(join(tmpdir(), "tsugite-state-person-qa-"));
    const path = await writeState(root, gate3Approved);
    const reloaded = await readState(path);
    expect(reloaded.gates.gate_3.person_qa_approval_digest).toBe("e".repeat(64));
    expect(reloaded.gates.gate_3.approved_input_digest).toBe("d".repeat(64));

    // Older state without person_qa_approval_digest still parses.
    const legacyPath = await writeState(root, {
      run_id: "legacy-run",
      status: "completed",
      updated_at: "2026-07-09T00:07:00.000Z",
      gates: {
        gate_1: { status: "approved", approved_input_digest: "a".repeat(64), decision_source: "human" },
        gate_2: { status: "approved", approved_input_digest: "b".repeat(64), decision_source: "human" },
        gate_3: { status: "approved", approved_input_digest: "d".repeat(64), decision_source: "human" }
      }
    });
    const legacy = await readState(legacyPath);
    expect(legacy.gates.gate_3.person_qa_approval_digest).toBeUndefined();
    expect(legacy.gates.gate_3.approved_input_digest).toBe("d".repeat(64));
  });

  it("rejects out-of-order gate progression", () => {
    const planned = createPlannedState("run-003", "2026-07-09T00:00:00.000Z");
    const gate1 = markGateAwaiting(planned, "gate_1", "2026-07-09T00:01:00.000Z");
    const afterGate1 = recordGateDecision(gate1, "gate_1", "approved", "2026-07-09T00:02:00.000Z");

    expect(() => markGateAwaiting(planned, "gate_3", "2026-07-09T00:03:00.000Z")).toThrow(
      "cannot await gate_3 before gate_2 is approved"
    );
    expect(() => markGateAwaiting(afterGate1, "gate_3", "2026-07-09T00:04:00.000Z")).toThrow(
      "cannot await gate_3 before gate_2 is approved"
    );
  });

  it("migrates legacy state files without gate details", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-state-"));
    const path = join(root, "state.json");
    await writeFile(
      path,
      JSON.stringify({
        run_id: "legacy-run",
        status: "dry_run",
        updated_at: "2026-07-09T00:00:00.000Z"
      })
    );

    const state = await readState(path);

    expect(state.gates.gate_1.status).toBe("pending");
    expect(state.gates.gate_2.status).toBe("pending");
    expect(state.gates.gate_3.status).toBe("pending");
  });

  it("rejects persisted state files that skip gate order", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-state-"));
    const path = join(root, "state.json");
    await writeFile(
      path,
      JSON.stringify({
        run_id: "bad-run",
        status: "awaiting_gate_2",
        updated_at: "2026-07-09T00:00:00.000Z",
        gates: {
          gate_1: { status: "pending" },
          gate_2: { status: "awaiting_approval" },
          gate_3: { status: "pending" }
        }
      })
    );

    await expect(readState(path)).rejects.toThrow("invalid run state: gate_2 requires gate_1 approval");
  });

  it("rejects unsafe state run ids before writing paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-state-"));

    await expect(
      writeState(root, {
        run_id: "../escaped",
        status: "planned",
        updated_at: "2026-07-09T00:00:00.000Z",
        gates: {
          gate_1: { status: "pending" },
          gate_2: { status: "pending" },
          gate_3: { status: "pending" }
        }
      })
    ).rejects.toThrow("must be a safe id");
  });

  it("rejects persisted planned states with approved gates", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-state-"));
    const path = join(root, "state.json");
    await writeFile(
      path,
      JSON.stringify({
        run_id: "bad-run",
        status: "planned",
        updated_at: "2026-07-09T00:00:00.000Z",
        gates: {
          gate_1: { status: "approved" },
          gate_2: { status: "pending" },
          gate_3: { status: "pending" }
        }
      })
    );

    await expect(readState(path)).rejects.toThrow("invalid run state: planned cannot contain progressed gates");
  });

  it("resets gate decisions after a downstream revise so approval can restart", () => {
    const planned = createPlannedState("run-004", "2026-07-09T00:00:00.000Z");
    const gate1 = markGateAwaiting(planned, "gate_1", "2026-07-09T00:01:00.000Z");
    const running = recordGateDecision(gate1, "gate_1", "approved", "2026-07-09T00:02:00.000Z");
    const gate2 = markGateAwaiting(running, "gate_2", "2026-07-09T00:03:00.000Z");
    const revised = recordGateDecision(gate2, "gate_2", "revise", "2026-07-09T00:04:00.000Z");
    const restarted = recordGateDecision(
      markGateAwaiting(revised, "gate_1", "2026-07-09T00:05:00.000Z"),
      "gate_1",
      "approved",
      "2026-07-09T00:06:00.000Z"
    );

    expect(revised.status).toBe("planned");
    expect(revised.gates.gate_1.status).toBe("pending");
    expect(revised.gates.gate_2.status).toBe("pending");
    expect(restarted.status).toBe("running");
    expect(restarted.gates.gate_2.status).toBe("pending");
  });

  it("returns only Gate 3 to rendering when a re-render is requested", () => {
    const planned = createPlannedState("run-005", "2026-07-09T00:00:00.000Z");
    const gate1 = markGateAwaiting(planned, "gate_1", "2026-07-09T00:01:00.000Z");
    const running = recordGateDecision(gate1, "gate_1", "approved", "2026-07-09T00:02:00.000Z");
    const gate2 = markGateAwaiting(running, "gate_2", "2026-07-09T00:03:00.000Z");
    const rendering = recordGateDecision(gate2, "gate_2", "approved", "2026-07-09T00:04:00.000Z");
    const gate3 = markGateAwaiting(rendering, "gate_3", "2026-07-09T00:05:00.000Z");

    const rerendering = recordGateDecision(gate3, "gate_3", "re_render", "2026-07-09T00:06:00.000Z");

    expect(rerendering.status).toBe("rendering");
    expect(rerendering.gates.gate_1.status).toBe("approved");
    expect(rerendering.gates.gate_2.status).toBe("approved");
    expect(rerendering.gates.gate_3.status).toBe("pending");
  });

  it("records the decision source of an approval and resets it on revise", () => {
    const planned = createPlannedState("run-007", "2026-07-09T00:00:00.000Z");
    const gate1 = markGateAwaiting(planned, "gate_1", "2026-07-09T00:01:00.000Z");
    const running = recordGateDecision(gate1, "gate_1", "approved", "2026-07-09T00:02:00.000Z");
    const gate2 = markGateAwaiting(running, "gate_2", "2026-07-09T00:03:00.000Z");
    const autoApproved = recordGateDecision(
      gate2,
      "gate_2",
      "approved",
      "2026-07-09T00:04:00.000Z",
      "a".repeat(64),
      "auto_qc"
    );
    const revised = recordGateDecision(gate2, "gate_2", "revise", "2026-07-09T00:05:00.000Z");

    expect(running.gates.gate_1.decision_source).toBe("human");
    expect(autoApproved.gates.gate_2.decision_source).toBe("auto_qc");
    expect(autoApproved.gates.gate_2.approved_input_digest).toBe("a".repeat(64));
    expect(revised.gates.gate_2.decision_source).toBeUndefined();
  });

  it("round-trips the decision source and still reads states written without it", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-state-source-"));
    const planned = createPlannedState("run-008", "2026-07-09T00:00:00.000Z");
    const gate1 = markGateAwaiting(planned, "gate_1", "2026-07-09T00:01:00.000Z");
    const running = recordGateDecision(gate1, "gate_1", "approved", "2026-07-09T00:02:00.000Z");
    const gate2 = markGateAwaiting(running, "gate_2", "2026-07-09T00:03:00.000Z");
    const rendering = recordGateDecision(
      gate2,
      "gate_2",
      "approved",
      "2026-07-09T00:04:00.000Z",
      "b".repeat(64),
      "auto_qc"
    );

    const written = await readState(await writeState(root, rendering));

    const legacyDir = join(root, "run-legacy");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      join(legacyDir, "state.json"),
      JSON.stringify({
        run_id: "run-legacy",
        status: "rendering",
        updated_at: "2026-07-09T00:00:00.000Z",
        gates: {
          gate_1: { status: "approved" },
          gate_2: { status: "approved" },
          gate_3: { status: "pending" }
        }
      })
    );
    const legacy = await readState(join(legacyDir, "state.json"));

    expect(written.gates.gate_2.decision_source).toBe("auto_qc");
    expect(legacy.gates.gate_2.decision_source).toBeUndefined();
    expect(legacy.status).toBe("rendering");
  });

  it("rejects a re-render decision outside Gate 3", () => {
    const planned = createPlannedState("run-006", "2026-07-09T00:00:00.000Z");
    const gate1 = markGateAwaiting(planned, "gate_1", "2026-07-09T00:01:00.000Z");

    expect(() => recordGateDecision(gate1, "gate_1", "re_render", "2026-07-09T00:02:00.000Z")).toThrow(
      "re_render is only valid for gate_3"
    );
  });
});
