import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export type GateId = "gate_1" | "gate_2" | "gate_3";
export type GateDecision = "approved" | "revise" | "abort" | "re_render";
export type GateStatus = "pending" | "awaiting_approval" | "approved" | "revise" | "abort";
export type RunStatus =
  | "planned"
  | "awaiting_gate_1"
  | "dry_run"
  | "running"
  | "awaiting_gate_2"
  | "rendering"
  | "awaiting_gate_3"
  | "completed"
  | "aborted";

export type GateDecisionSource = "human" | "auto_qc";

export type GateState = {
  status: GateStatus;
  updated_at?: string;
  approved_input_digest?: string;
  decision_source?: GateDecisionSource;
};

export type RunState = {
  run_id: string;
  status: RunStatus;
  updated_at: string;
  gates: Record<GateId, GateState>;
};

export type RunLock = {
  token: string;
  release: () => Promise<void>;
};

export const RUN_LOCK_INHERIT_ENV = "TSUGITE_INHERITED_RUN_LOCK";
export const LAUNCHER_EXPECTED_APPROVAL_DIGEST_ENV = "TSUGITE_LAUNCHER_EXPECTED_APPROVAL_DIGEST";

export class RunLockedError extends Error {
  readonly code = "run.locked";

  constructor() {
    super("run is locked by another process");
    this.name = "RunLockedError";
  }
}

const safeIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a safe id");

const gateStateSchema = z.object({
  status: z.union([
    z.literal("pending"),
    z.literal("awaiting_approval"),
    z.literal("approved"),
    z.literal("revise"),
    z.literal("abort")
  ]),
  updated_at: z.string().optional(),
  approved_input_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  decision_source: z.union([z.literal("human"), z.literal("auto_qc")]).optional()
});

const runStateSchema = z.object({
  run_id: safeIdSchema,
  status: z.union([
    z.literal("planned"),
    z.literal("awaiting_gate_1"),
    z.literal("dry_run"),
    z.literal("running"),
    z.literal("awaiting_gate_2"),
    z.literal("rendering"),
    z.literal("awaiting_gate_3"),
    z.literal("completed"),
    z.literal("aborted")
  ]),
  updated_at: z.string().min(1),
  gates: z
    .object({
      gate_1: gateStateSchema,
      gate_2: gateStateSchema,
      gate_3: gateStateSchema
    })
    .default(defaultGates)
});

export function createPlannedState(runId: string, updatedAt = new Date().toISOString()): RunState {
  return {
    run_id: runId,
    status: "planned",
    updated_at: updatedAt,
    gates: defaultGates()
  };
}

export function markGateAwaiting(state: RunState, gate: GateId, updatedAt = new Date().toISOString()): RunState {
  assertCanAwaitGate(state, gate);

  return {
    ...state,
    status: gateToRunStatus(gate),
    updated_at: updatedAt,
    gates: {
      ...state.gates,
      [gate]: { status: "awaiting_approval", updated_at: updatedAt }
    }
  };
}

export function recordGateDecision(
  state: RunState,
  gate: GateId,
  decision: GateDecision,
  updatedAt = new Date().toISOString(),
  approvedInputDigest?: string,
  decisionSource: GateDecisionSource = "human"
): RunState {
  if (decision === "re_render" && gate !== "gate_3") {
    throw new Error("re_render is only valid for gate_3");
  }
  if (gate === "gate_1" && decision === "revise" && state.gates.gate_1.status === "approved") {
    return {
      ...state,
      status: "planned",
      updated_at: updatedAt,
      gates: defaultGates()
    };
  }
  assertCanDecideGate(state, gate);

  if (state.gates[gate].status !== "awaiting_approval") {
    throw new Error(`cannot decide ${gate} before it is awaiting approval`);
  }

  return {
    ...state,
    status: statusAfterDecision(gate, decision, state.status),
    updated_at: updatedAt,
    gates: gatesAfterDecision(state, gate, decision, updatedAt, approvedInputDigest, decisionSource)
  };
}

export async function writeState(distDir: string, state: RunState): Promise<string> {
  const parsedState = parseRunState(state);
  const runDir = join(distDir, parsedState.run_id);
  await mkdir(runDir, { recursive: true });
  const path = join(runDir, "state.json");
  const temporaryPath = join(runDir, `.state.json.${process.pid}.${randomUUID()}.tmp`);
  let handle;

  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(parsedState, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    if (process.platform !== "win32") {
      const directoryHandle = await open(runDir, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
    return path;
  } finally {
    try {
      await handle?.close();
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

export async function acquireRunLock(
  distDir: string,
  runId: string,
  inheritedToken?: string
): Promise<RunLock> {
  const safeRunId = safeIdSchema.parse(runId);
  const runDir = join(distDir, safeRunId);
  const lockPath = join(runDir, ".mutation.lock");
  if (inheritedToken) {
    let handle;
    try {
      handle = await open(lockPath, constants.O_RDWR | constants.O_NOFOLLOW);
      const owner = JSON.parse(await handle.readFile("utf8"));
      if (!isRunLockRecord(owner) || !isLockOwner(owner, inheritedToken)) {
        throw new RunLockedError();
      }
      await handle.truncate(0);
      await handle.write(`${JSON.stringify({ ...owner, delegated_pid: process.pid })}\n`, 0, "utf8");
      await handle.sync();
    } catch {
      throw new RunLockedError();
    } finally {
      await handle?.close();
    }
    return { token: inheritedToken, release: async () => undefined };
  }
  const token = randomUUID();
  await mkdir(runDir, { recursive: true });

  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (!isAlreadyExists(error) || !await recoverStaleRunLock(lockPath)) {
      if (isAlreadyExists(error)) throw new RunLockedError();
      throw error;
    }
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (retryError) {
      if (isAlreadyExists(retryError)) throw new RunLockedError();
      throw retryError;
    }
  }

  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString(), token })}\n`);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
    throw error;
  }
  await handle.close();

  let released = false;
  return {
    token,
    async release() {
      if (released) return;

      let owner: unknown;
      try {
        owner = JSON.parse(await readFile(lockPath, "utf8"));
      } catch {
        return;
      }
      if (!isLockOwner(owner, token)) return;

      try {
        await unlink(lockPath);
      } catch {
        return;
      }
      released = true;
      await rmdir(runDir).catch(() => undefined);
    }
  };
}

export async function readState(path: string): Promise<RunState> {
  return parseRunState(JSON.parse(await readFile(path, "utf8")));
}

function parseRunState(input: unknown): RunState {
  const state = runStateSchema.parse(input);
  const invariantError = gateInvariantError(state);
  if (invariantError) {
    throw new Error(`invalid run state: ${invariantError}`);
  }
  return state;
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isLockOwner(input: unknown, token: string): boolean {
  return typeof input === "object" && input !== null && "token" in input && input.token === token;
}

async function recoverStaleRunLock(lockPath: string): Promise<boolean> {
  let handle;
  let observedStats: Stats;
  let owner: unknown;
  try {
    handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    observedStats = await handle.stat();
    owner = JSON.parse(await handle.readFile("utf8"));
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
  if (
    !isRunLockRecord(owner)
    || isProcessAlive(owner.pid)
    || (owner.delegated_pid !== undefined && isProcessAlive(owner.delegated_pid))
  ) return false;

  const recoveryPath = `${lockPath}.recovery.${process.pid}.${randomUUID()}`;
  try {
    await rename(lockPath, recoveryPath);
  } catch (error) {
    return isMissing(error);
  }
  try {
    const recoveredStats = await lstat(recoveryPath);
    if (!sameLockFile(observedStats, recoveredStats)) {
      await rename(recoveryPath, lockPath).catch(() => undefined);
      return false;
    }
    await unlink(recoveryPath);
    return true;
  } catch {
    await rename(recoveryPath, lockPath).catch(() => undefined);
    return false;
  }
}

function isRunLockRecord(input: unknown): input is {
  pid: number;
  delegated_pid?: number;
  token: string;
  acquired_at: string;
} {
  return typeof input === "object"
    && input !== null
    && "pid" in input
    && typeof input.pid === "number"
    && Number.isSafeInteger(input.pid)
    && input.pid > 0
    && (!("delegated_pid" in input)
      || (typeof input.delegated_pid === "number"
        && Number.isSafeInteger(input.delegated_pid)
        && input.delegated_pid > 0))
    && "token" in input
    && typeof input.token === "string"
    && input.token.length > 0
    && "acquired_at" in input
    && typeof input.acquired_at === "string";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function sameLockFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function defaultGates(): Record<GateId, GateState> {
  return {
    gate_1: { status: "pending" },
    gate_2: { status: "pending" },
    gate_3: { status: "pending" }
  };
}

function assertCanAwaitGate(state: RunState, gate: GateId): void {
  if (gate === "gate_1") {
    if (state.status !== "planned" && state.status !== "dry_run") {
      throw new Error("cannot await gate_1 unless the run is planned");
    }
    return;
  }

  if (gate === "gate_2" && state.gates.gate_1.status !== "approved") {
    throw new Error("cannot await gate_2 before gate_1 is approved");
  }

  if (gate === "gate_3" && state.gates.gate_2.status !== "approved") {
    throw new Error("cannot await gate_3 before gate_2 is approved");
  }
}

function assertCanDecideGate(state: RunState, gate: GateId): void {
  const invariantError = gateInvariantError(state);
  if (invariantError) {
    throw new Error(`invalid run state: ${invariantError}`);
  }

  if (gate === "gate_2" && state.gates.gate_1.status !== "approved") {
    throw new Error("cannot decide gate_2 before gate_1 is approved");
  }

  if (gate === "gate_3" && state.gates.gate_2.status !== "approved") {
    throw new Error("cannot decide gate_3 before gate_2 is approved");
  }
}

function gateInvariantError(state: RunState): string | undefined {
  if (state.status === "planned") {
    if (hasApprovedGate(state) || hasAwaitingGate(state)) {
      return "planned cannot contain progressed gates";
    }
  }

  if (state.status === "dry_run") {
    if (
      state.gates.gate_1.status !== "pending" ||
      state.gates.gate_2.status !== "pending" ||
      state.gates.gate_3.status !== "pending"
    ) {
      return "dry_run cannot contain gate decisions";
    }
  }

  if (isProgressedGate(state.gates.gate_2.status) && state.gates.gate_1.status !== "approved") {
    return "gate_2 requires gate_1 approval";
  }

  if (isProgressedGate(state.gates.gate_3.status) && state.gates.gate_2.status !== "approved") {
    return "gate_3 requires gate_2 approval";
  }

  if (state.status === "awaiting_gate_1" && state.gates.gate_1.status !== "awaiting_approval") {
    return "awaiting_gate_1 requires gate_1 awaiting approval";
  }

  if (state.status === "running" && state.gates.gate_1.status !== "approved") {
    return "running requires gate_1 approval";
  }

  if (state.status === "running" && (state.gates.gate_2.status !== "pending" || state.gates.gate_3.status !== "pending")) {
    return "running cannot contain downstream gate decisions";
  }

  if (state.status === "awaiting_gate_2" && state.gates.gate_2.status !== "awaiting_approval") {
    return "awaiting_gate_2 requires gate_2 awaiting approval";
  }

  if (state.status === "rendering" && state.gates.gate_2.status !== "approved") {
    return "rendering requires gate_2 approval";
  }

  if (state.status === "rendering" && state.gates.gate_3.status !== "pending") {
    return "rendering cannot contain gate_3 decisions";
  }

  if (state.status === "awaiting_gate_3" && state.gates.gate_3.status !== "awaiting_approval") {
    return "awaiting_gate_3 requires gate_3 awaiting approval";
  }

  if (state.status === "completed" && state.gates.gate_3.status !== "approved") {
    return "completed requires gate_3 approval";
  }

  return undefined;
}

function hasApprovedGate(state: RunState): boolean {
  return (
    state.gates.gate_1.status === "approved" ||
    state.gates.gate_2.status === "approved" ||
    state.gates.gate_3.status === "approved"
  );
}

function hasAwaitingGate(state: RunState): boolean {
  return (
    state.gates.gate_1.status === "awaiting_approval" ||
    state.gates.gate_2.status === "awaiting_approval" ||
    state.gates.gate_3.status === "awaiting_approval"
  );
}

function isProgressedGate(status: GateStatus): boolean {
  return status === "awaiting_approval" || status === "approved";
}

function gateToRunStatus(gate: GateId): RunStatus {
  if (gate === "gate_1") return "awaiting_gate_1";
  if (gate === "gate_2") return "awaiting_gate_2";
  return "awaiting_gate_3";
}

function statusAfterDecision(gate: GateId, decision: GateDecision, current: RunStatus): RunStatus {
  if (decision === "abort") return "aborted";
  if (decision === "revise") return "planned";
  if (decision === "re_render") return "rendering";
  if (gate === "gate_1") return "running";
  if (gate === "gate_2") return "rendering";
  if (gate === "gate_3") return "completed";
  return current;
}

function gatesAfterDecision(
  state: RunState,
  gate: GateId,
  decision: GateDecision,
  updatedAt: string,
  approvedInputDigest: string | undefined,
  decisionSource: GateDecisionSource
): Record<GateId, GateState> {
  if (decision === "revise") {
    return defaultGates();
  }

  if (decision === "re_render") {
    return {
      ...state.gates,
      gate_3: { status: "pending", updated_at: updatedAt }
    };
  }

  return {
    ...state.gates,
    [gate]: {
      status: decision,
      updated_at: updatedAt,
      ...(decision === "approved" && approvedInputDigest
        ? { approved_input_digest: approvedInputDigest }
        : {}),
      ...(decision === "approved" ? { decision_source: decisionSource } : {})
    }
  };
}
