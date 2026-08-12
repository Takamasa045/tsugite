/**
 * Deterministic resume from EventStore truth. Snapshot is cache only.
 * Gap / duplicate / tamper / ahead reject. No model/connection/budget reselection.
 */
import { parseArtifactEnvelope, type ArtifactEnvelope } from "./schema.js";
import { EventStore } from "./eventStore.js";
import { pcError } from "./errors.js";
import {
  createInitialMissionState,
  missionStateDigest,
  reduceProductionEvent,
  replayProductionEvents
} from "./reducer.js";
import { SnapshotStore } from "./statePersistence.js";
import type { MissionState, ProductionEvent } from "./schema.js";
import { assertEventIntegrity } from "./events.js";
import type { ProductionControlMode } from "./schema.js";

export type ResumeResult = {
  state: MissionState;
  events: ProductionEvent[];
  snapshot_used: boolean;
  snapshot_rebuilt: boolean;
  applied_from_sequence: number;
};

export type ResumeOptions = {
  mode: ProductionControlMode;
  production_id: string;
  root: string;
  /** Optional artifact envelopes to re-verify against accepted digests. */
  artifact_envelopes?: readonly ArtifactEnvelope[];
  event_store?: EventStore;
  snapshot_store?: SnapshotStore;
};

/**
 * Active-only resume path. Legacy / disabled / shadow are unchanged and
 * must not call this control-plane resume.
 */
export async function resumeProductionControl(options: ResumeOptions): Promise<ResumeResult> {
  if (options.mode !== "active") {
    throw pcError("PC_MODE_INACTIVE", "resume reconciler applies only to active mode");
  }

  const eventStore = options.event_store ?? new EventStore(options.root);
  const snapshotStore = options.snapshot_store ?? new SnapshotStore(options.root);
  const events = await eventStore.readAll();
  assertEventChainIntegrity(events, options.production_id);

  const snapshot = await snapshotStore.read();
  let state: MissionState;
  let snapshotUsed = false;
  let snapshotRebuilt = false;
  let appliedFrom = 0;

  if (snapshot) {
    if (snapshot.state.production_id !== options.production_id) {
      throw pcError("PC_RESUME_INVALID", "snapshot production id mismatch");
    }
    if (snapshot.state_digest !== missionStateDigest(snapshot.state)) {
      throw pcError("PC_RESUME_INVALID", "snapshot state digest mismatch");
    }
    // Snapshot is cache only: verify it matches the prefix of the event chain.
    const prefix = events.filter((event) => event.sequence <= snapshot.state.applied_event_sequence);
    const rebuiltPrefix = replayProductionEvents(prefix, options.production_id);
    if (missionStateDigest(rebuiltPrefix) !== missionStateDigest(snapshot.state)) {
      // Corrupt or stale snapshot cache → rebuild entirely from events.
      state = replayProductionEvents(events, options.production_id);
      snapshotRebuilt = true;
      appliedFrom = 0;
    } else {
      state = snapshot.state;
      snapshotUsed = true;
      appliedFrom = snapshot.state.applied_event_sequence;
      for (const event of events) {
        if (event.sequence <= appliedFrom) continue;
        state = reduceProductionEvent(state, event);
      }
    }
  } else {
    state = events.length === 0
      ? createInitialMissionState(options.production_id)
      : replayProductionEvents(events, options.production_id);
    appliedFrom = 0;
  }

  if (options.artifact_envelopes) {
    reverifyArtifactEnvelopes(state, options.artifact_envelopes);
  }

  // Resume never reselects model / connection / budget — those live in immutable digests.
  return {
    state,
    events,
    snapshot_used: snapshotUsed,
    snapshot_rebuilt: snapshotRebuilt,
    applied_from_sequence: appliedFrom
  };
}

export function assertEventChainIntegrity(events: readonly ProductionEvent[], productionId: string): void {
  let previousDigest: string | undefined;
  const seenIds = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    assertEventIntegrity(event);
    if (event.production_id !== productionId) {
      throw pcError("PC_RESUME_INVALID", "event production id mismatch");
    }
    if (event.sequence !== index + 1) {
      if (event.sequence > index + 1) {
        throw pcError("PC_EVENT_CHAIN", "event sequence gap or ahead of chain", {
          expected: index + 1,
          received: event.sequence
        });
      }
      throw pcError("PC_EVENT_CHAIN", "event sequence duplicate or out of order", {
        expected: index + 1,
        received: event.sequence
      });
    }
    if (seenIds.has(event.event_id)) {
      throw pcError("PC_EVENT_CONFLICT", "duplicate event id in resume chain");
    }
    seenIds.add(event.event_id);
    if (index === 0) {
      if (event.previous_event_digest !== "0".repeat(64)) {
        throw pcError("PC_EVENT_CHAIN", "first event previous digest must be zero");
      }
    } else if (event.previous_event_digest !== previousDigest) {
      throw pcError("PC_EVENT_TAMPERED", "event previous digest does not match chain");
    }
    previousDigest = event.event_digest;
  }
}

export function reverifyArtifactEnvelopes(
  state: MissionState,
  envelopes: readonly ArtifactEnvelope[]
): void {
  for (const raw of envelopes) {
    const envelope = parseArtifactEnvelope(raw);
    if (envelope.production_id !== state.production_id) {
      throw pcError("PC_RESUME_INVALID", "artifact envelope production mismatch");
    }
    const accepted = state.accepted_artifacts[envelope.artifact_id];
    if (accepted) {
      if (accepted.artifact_digest !== envelope.envelope_digest) {
        throw pcError("PC_ARTIFACT_MISMATCH", "accepted artifact envelope digest mismatch");
      }
      if (accepted.invalidated) {
        throw pcError("PC_RESUME_INVALID", "cannot resume using an invalidated accepted artifact");
      }
    }
    const created = state.created_artifacts[envelope.artifact_id];
    if (created && created.artifact_digest !== envelope.envelope_digest) {
      throw pcError("PC_ARTIFACT_MISMATCH", "created artifact envelope digest mismatch");
    }
    // Orphan envelopes (not in state) are evidence only — never auto-accepted.
  }
}

/** Detect orphan artifacts that exist on disk but were never accepted. */
export function findOrphanArtifactIds(
  state: MissionState,
  envelopeIds: readonly string[]
): string[] {
  return envelopeIds.filter((id) => !state.accepted_artifacts[id] && !state.created_artifacts[id]).sort();
}
