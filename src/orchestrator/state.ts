import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export type GateId = "gate_1" | "gate_2" | "gate_3";
export type GateDecision = "approved" | "revise" | "abort";
export type GateStatus = "pending" | "awaiting_approval" | GateDecision;
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

export type GateState = {
  status: GateStatus;
  updated_at?: string;
};

export type RunState = {
  run_id: string;
  status: RunStatus;
  updated_at: string;
  gates: Record<GateId, GateState>;
};

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
  updated_at: z.string().optional()
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
  updatedAt = new Date().toISOString()
): RunState {
  assertCanDecideGate(state, gate);

  if (state.gates[gate].status !== "awaiting_approval") {
    throw new Error(`cannot decide ${gate} before it is awaiting approval`);
  }

  return {
    ...state,
    status: statusAfterDecision(gate, decision, state.status),
    updated_at: updatedAt,
    gates: gatesAfterDecision(state, gate, decision, updatedAt)
  };
}

export async function writeState(distDir: string, state: RunState): Promise<string> {
  const parsedState = parseRunState(state);
  const runDir = join(distDir, parsedState.run_id);
  await mkdir(runDir, { recursive: true });
  const path = join(runDir, "state.json");
  await writeFile(path, `${JSON.stringify(parsedState, null, 2)}\n`);
  return path;
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
  if (gate === "gate_1") return "running";
  if (gate === "gate_2") return "rendering";
  if (gate === "gate_3") return "completed";
  return current;
}

function gatesAfterDecision(
  state: RunState,
  gate: GateId,
  decision: GateDecision,
  updatedAt: string
): Record<GateId, GateState> {
  if (decision === "revise") {
    return defaultGates();
  }

  return {
    ...state.gates,
    [gate]: { status: decision, updated_at: updatedAt }
  };
}
