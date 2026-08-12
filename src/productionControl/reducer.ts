import { sha256Canonical } from "./canonical.js";
import { pcError, type ProductionControlError } from "./errors.js";
import { assertEventIntegrity } from "./events.js";
import {
  digestSchema,
  missionStateSchema,
  parseMissionState,
  parseProductionEvent,
  safeIdSchema,
  type MissionState,
  type ProductionEvent,
  ZERO_DIGEST
} from "./schema.js";

export function createInitialMissionState(productionId: string): MissionState {
  safeIdSchema.parse(productionId);
  return {
    schema_version: 1,
    production_id: productionId,
    mission_status: "new",
    revision: 0,
    applied_event_sequence: 0,
    applied_event_digest: ZERO_DIGEST,
    tree_revision: 0,
    nodes: {},
    attempts: {},
    created_artifacts: {},
    accepted_artifacts: {},
    invalidated_node_ids: [],
    gate_bindings: {},
    generation_bindings: {}
  };
}

/** Pure state transition: the input state and event are never mutated. */
export function reduceProductionEvent(state: MissionState, rawEvent: ProductionEvent): MissionState {
  const current = parseMissionState(state);
  const event = parseProductionEvent(rawEvent);
  assertEventIntegrity(event);

  if (event.production_id !== current.production_id) {
    throw transition("event production does not match mission");
  }
  if (event.sequence !== current.applied_event_sequence + 1) {
    throw pcError("PC_EVENT_CHAIN", "event sequence is not contiguous", {
      expected: current.applied_event_sequence + 1,
      received: event.sequence
    });
  }
  if (event.previous_event_digest !== current.applied_event_digest) {
    throw pcError("PC_EVENT_CHAIN", "event previous digest does not match state");
  }

  const next: MissionState = {
    ...current,
    revision: event.sequence,
    applied_event_sequence: event.sequence,
    applied_event_digest: event.event_digest,
    nodes: { ...current.nodes },
    attempts: { ...current.attempts },
    created_artifacts: { ...current.created_artifacts },
    accepted_artifacts: { ...current.accepted_artifacts },
    invalidated_node_ids: [...current.invalidated_node_ids],
    gate_bindings: { ...current.gate_bindings },
    generation_bindings: { ...current.generation_bindings }
  };

  switch (event.type) {
    case "mission-created":
      if (current.mission_status !== "new" || current.applied_event_sequence !== 0) {
        throw transition("mission can only be created once");
      }
      next.mission_status = "ready";
      next.tree_revision = event.payload.tree_revision;
      break;

    case "contract-revision-selected":
      requireMission(current);
      break;

    case "tree-compiled":
      requireMission(current);
      if (event.payload.tree_revision < current.tree_revision) {
        throw transition("tree revision cannot move backwards");
      }
      next.tree_revision = event.payload.tree_revision;
      break;

    case "task-readied": {
      requireMission(current);
      const payload = event.payload;
      const previous = current.nodes[payload.node_id];
      if (previous && previous.status !== "stale" && previous.status !== "blocked" && previous.status !== "proposed") {
        throw transition("task is not eligible to become ready");
      }
      next.nodes[payload.node_id] = {
        node_id: payload.node_id,
        status: "ready",
        task_revision: payload.task_revision,
        input_digest: payload.input_digest,
        dependency_closure_digest: payload.dependency_closure_digest,
        stale: false
      };
      next.mission_status = "ready";
      break;
    }

    case "attempt-leased": {
      requireMission(current);
      const payload = event.payload;
      const node = current.nodes[payload.node_id];
      if (!node || node.status !== "ready" || node.stale) throw transition("attempt lease requires a ready task");
      if (current.attempts[payload.attempt_id]) throw transition("attempt id is already present");
      if (Object.values(current.attempts).some((attempt) =>
        attempt.node_id === payload.node_id && (attempt.status === "leased" || attempt.status === "started")
      )) {
        throw transition("task already has an active attempt");
      }
      if (payload.task_revision !== node.task_revision || payload.input_digest !== node.input_digest) {
        throw transition("lease input does not match task");
      }
      next.attempts[payload.attempt_id] = {
        attempt_id: payload.attempt_id,
        node_id: payload.node_id,
        task_revision: payload.task_revision,
        input_digest: payload.input_digest,
        attempt_key: payload.attempt_key,
        lease_digest: payload.lease_digest,
        role: payload.role,
        effect: payload.effect,
        status: "leased"
      };
      next.nodes[payload.node_id] = { ...node, status: "running" };
      next.mission_status = "running";
      break;
    }

    case "attempt-started": {
      const attempt = requireAttempt(current, event.payload.attempt_id);
      if (attempt.status !== "leased" || attempt.lease_digest !== event.payload.lease_digest) {
        throw transition("attempt start lease mismatch");
      }
      next.attempts[attempt.attempt_id] = { ...attempt, status: "started" };
      break;
    }

    case "artifact-created": {
      requireMission(current);
      const attempt = requireAttempt(current, event.payload.attempt_id);
      if (attempt.node_id !== event.payload.node_id || (attempt.status !== "started" && attempt.status !== "leased")) {
        throw transition("artifact is not bound to an active attempt");
      }
      if (current.accepted_artifacts[event.payload.artifact_id]) {
        throw transition("artifact id is already present");
      }
      if (current.created_artifacts[event.payload.artifact_id]) {
        throw transition("artifact id is already present");
      }
      // The artifact-created event is intentionally only a lineage observation;
      // acceptance is a separate event with stronger expected-value checks.
      next.created_artifacts[event.payload.artifact_id] = { ...event.payload };
      break;
    }

    case "artifact-accepted": {
      const payload = event.payload;
      if (payload.expected_event_sequence !== current.applied_event_sequence) {
        throw pcError("PC_EVENT_CONFLICT", "artifact acceptance expected sequence is stale", {
          expected: current.applied_event_sequence,
          received: payload.expected_event_sequence
        });
      }
      const node = current.nodes[payload.node_id];
      const attempt = requireAttempt(current, payload.attempt_id);
      if (!node || node.status !== "running" || node.stale) throw transition("stale or non-running task cannot accept an artifact");
      if (attempt.status !== "started" || attempt.node_id !== payload.node_id) throw transition("artifact acceptance attempt mismatch");
      if (payload.task_revision !== node.task_revision || payload.task_revision !== attempt.task_revision) {
        throw transition("artifact acceptance task revision mismatch");
      }
      if (payload.tree_revision !== current.tree_revision) {
        throw transition("artifact acceptance tree revision mismatch");
      }
      if (payload.input_digest !== node.input_digest || payload.input_digest !== attempt.input_digest) {
        throw transition("artifact acceptance input mismatch");
      }
      if (payload.lease_digest !== attempt.lease_digest) throw transition("artifact acceptance lease mismatch");
      if (payload.dependency_closure_digest !== node.dependency_closure_digest) {
        throw transition("artifact acceptance dependency closure mismatch");
      }
      const createdArtifact = current.created_artifacts[payload.artifact_id];
      if (!createdArtifact || createdArtifact.artifact_digest !== payload.artifact_digest || createdArtifact.node_id !== payload.node_id || createdArtifact.attempt_id !== payload.attempt_id) {
        throw transition("artifact acceptance is not bound to a created artifact");
      }
      if (current.accepted_artifacts[payload.artifact_id]) throw transition("artifact has already been accepted");
      next.accepted_artifacts[payload.artifact_id] = {
        artifact_id: payload.artifact_id,
        artifact_digest: payload.artifact_digest,
        node_id: payload.node_id,
        attempt_id: payload.attempt_id,
        invalidated: false
      };
      next.nodes[payload.node_id] = { ...node, status: "completed", accepted_artifact_id: payload.artifact_id };
      next.attempts[payload.attempt_id] = { ...attempt, status: "completed" };
      break;
    }

    case "attempt-failed-known":
      applyAttemptTerminal(next, current, event.payload.attempt_id, event.payload.node_id, "failed_known");
      next.mission_status = "blocked";
      break;

    case "attempt-outcome-unknown":
      applyAttemptTerminal(next, current, event.payload.attempt_id, event.payload.node_id, "outcome_unknown");
      next.mission_status = "blocked";
      break;

    case "task-awaiting-human": {
      const node = current.nodes[event.payload.node_id];
      if (!node || node.stale) throw transition("unknown or stale task cannot await human");
      next.nodes[event.payload.node_id] = { ...node, status: "awaiting_human" };
      next.mission_status = "awaiting_human";
      break;
    }

    case "nodes-invalidated": {
      requireMission(current);
      const stale = new Set(event.payload.stale_node_ids);
      const preserved = new Set(event.payload.preserved_node_ids);
      if ([...stale].some((id) => preserved.has(id))) throw transition("stale and preserved node sets overlap");
      for (const id of stale) {
        const node = current.nodes[id];
        if (!node) throw transition("invalidation references an unknown node");
        if (node.stale) throw transition("node is already stale");
        next.nodes[id] = { ...node, status: "stale", stale: true };
        if (!next.invalidated_node_ids.includes(id)) next.invalidated_node_ids.push(id);
        const artifactId = node.accepted_artifact_id;
        if (artifactId && next.accepted_artifacts[artifactId]) {
          next.accepted_artifacts[artifactId] = { ...next.accepted_artifacts[artifactId], invalidated: true };
        }
      }
      for (const id of preserved) {
        if (!current.nodes[id]) throw transition("invalidation preserves an unknown node");
        if (current.nodes[id].stale) throw transition("invalidation cannot preserve a stale node");
      }
      for (const bindingId of event.payload.stale_gate_binding_ids) {
        const binding = next.gate_bindings[bindingId];
        if (binding) next.gate_bindings[bindingId] = { ...binding, stale: true };
      }
      next.mission_status = "ready";
      break;
    }

    case "gate-binding-recorded": {
      requireMission(current);
      const payload = event.payload;
      if (current.gate_bindings[payload.binding_id] && !current.gate_bindings[payload.binding_id]!.stale) {
        throw transition("gate binding id is already current");
      }
      next.gate_bindings[payload.binding_id] = {
        binding_id: payload.binding_id,
        gate: payload.gate,
        subject_digest: payload.subject_digest,
        decision_digest: payload.decision_digest,
        ...(payload.legacy_approved_input_digest
          ? { legacy_approved_input_digest: payload.legacy_approved_input_digest }
          : {}),
        stale: payload.stale
      };
      break;
    }

    case "generation-job-bound": {
      requireMission(current);
      const payload = event.payload;
      const existing = current.generation_bindings[payload.binding_id];
      if (existing) {
        if (existing.immutable_identity_digest !== payload.immutable_identity_digest) {
          throw transition("generation binding immutable identity drifted");
        }
        if (payload.approval_observed_revision < existing.approval_observed_revision) {
          throw transition("generation binding revision cannot roll back");
        }
      }
      next.generation_bindings[payload.binding_id] = { ...payload };
      break;
    }

    case "mission-completed":
      requireMission(current);
      if (Object.keys(current.nodes).length === 0 || Object.values(current.nodes).some((node) => node.status !== "completed")) {
        throw transition("mission requires every task to have a verified artifact");
      }
      if (Object.values(current.attempts).some((attempt) => attempt.status === "leased" || attempt.status === "started")) {
        throw transition("mission cannot complete with an active attempt");
      }
      next.mission_status = "completed";
      break;
  }

  return missionStateSchema.parse(next);
}

export function replayProductionEvents(
  events: readonly ProductionEvent[],
  productionId?: string
): MissionState {
  const id = productionId ?? events[0]?.production_id;
  if (!id) throw pcError("PC_RECOVERY_INVALID", "production id is required to replay an empty log");
  return events.reduce((state, event) => reduceProductionEvent(state, event), createInitialMissionState(id));
}

export function missionStateDigest(state: MissionState): string {
  return sha256Canonical(parseMissionState(state));
}

function requireMission(state: MissionState): void {
  if (state.mission_status === "new") throw transition("mission has not been created");
}

function requireAttempt(state: MissionState, attemptId: string): MissionState["attempts"][string] {
  const attempt = state.attempts[attemptId];
  if (!attempt) throw transition("unknown attempt");
  return attempt;
}

function applyAttemptTerminal(
  next: MissionState,
  current: MissionState,
  attemptId: string,
  nodeId: string,
  status: "failed_known" | "outcome_unknown"
): void {
  const attempt = requireAttempt(current, attemptId);
  const node = current.nodes[nodeId];
  if (attempt.node_id !== nodeId || !node || (attempt.status !== "leased" && attempt.status !== "started")) {
    throw transition("attempt terminal event mismatch");
  }
  next.attempts[attemptId] = { ...attempt, status };
  next.nodes[nodeId] = { ...node, status };
}

function transition(message: string): ProductionControlError {
  return pcError("PC_INVALID_TRANSITION", message);
}
