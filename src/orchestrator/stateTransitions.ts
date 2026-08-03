/**
 * Pure gate/run state transitions and invariants.
 */
import type {
  GateDecision,
  GateDecisionSource,
  GateId,
  GateState,
  GateStatus,
  RunState,
  RunStatus
} from "./stateTypes.js";

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

export function defaultGates(): Record<GateId, GateState> {
  return {
    gate_1: { status: "pending" },
    gate_2: { status: "pending" },
    gate_3: { status: "pending" }
  };
}

export function gateInvariantError(state: RunState): string | undefined {
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
