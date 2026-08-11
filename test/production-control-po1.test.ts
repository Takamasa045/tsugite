import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ArtifactStore,
  EventStore,
  ProductionControlError,
  SnapshotStore,
  assertEventIntegrity,
  canonicalJson,
  makeProductionEvent,
  missionStateDigest,
  parseProductionEvent,
  reduceProductionEvent,
  replayProductionEvents,
  sha256Bytes,
  sha256Canonical,
  type MissionState,
  type ProductionEvent
} from "../src/productionControl/index.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(join("/private/tmp", `tsugite-po1-${prefix}-`));
}

function expectCode(action: () => unknown | Promise<unknown>, code: string) {
  return expect(action()).rejects.toMatchObject({ code });
}

function eventInput<T extends ProductionEvent["type"]>(input: {
  type: T;
  payload: Extract<ProductionEvent, { type: T }>["payload"];
  production_id?: string;
}) {
  return {
    type: input.type,
    payload: input.payload,
    production_id: input.production_id ?? "production-1",
    coordinator_instance_id: "coordinator-test"
  } as const;
}

async function buildAcceptedStore(root: string): Promise<{ store: EventStore; artifactDigest: string; state: MissionState }> {
  const store = new EventStore(root);
  await store.append(eventInput({ type: "mission-created", payload: { mission_digest: DIGEST_A, tree_revision: 1 } }));
  await store.append(eventInput({
    type: "task-readied",
    payload: { node_id: "node-1", task_revision: 1, input_digest: DIGEST_A, dependency_closure_digest: DIGEST_B }
  }));
  await store.append(eventInput({
    type: "attempt-leased",
    payload: {
      attempt_id: "attempt-1",
      lease_id: "lease-1",
      node_id: "node-1",
      task_revision: 1,
      attempt_key: DIGEST_A,
      input_digest: DIGEST_A,
      lease_digest: DIGEST_B,
      role: "reviewer",
      effect: "propose",
      acquired_at: "2026-08-11T00:00:00.000Z",
      expires_at: "2026-08-11T01:00:00.000Z"
    }
  }));
  await store.append(eventInput({ type: "attempt-started", payload: { attempt_id: "attempt-1", lease_digest: DIGEST_B } }));
  const artifactDigest = sha256Bytes(Buffer.from("artifact"));
  await store.append(eventInput({
    type: "artifact-created",
    payload: { artifact_id: "artifact-1", artifact_digest: artifactDigest, node_id: "node-1", attempt_id: "attempt-1" }
  }));
  await store.append(eventInput({
    type: "artifact-accepted",
    payload: {
      artifact_id: "artifact-1",
      artifact_digest: artifactDigest,
      node_id: "node-1",
      attempt_id: "attempt-1",
      expected_event_sequence: 5,
      tree_revision: 1,
      task_revision: 1,
      input_digest: DIGEST_A,
      lease_digest: DIGEST_B,
      dependency_closure_digest: DIGEST_B
    }
  }));
  return { store, artifactDigest, state: await store.replay("production-1") };
}

describe("PO-1 canonical and strict schema", () => {
  it("sorts object keys, keeps array order, and excludes volatile identity fields", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(sha256Canonical({ values: ["first", "second"] }))
      .not.toBe(sha256Canonical({ values: ["second", "first"] }));
    expect(sha256Canonical({ digest: 1, created_at: "2020-01-01T00:00:00.000Z", path: "/private/a" }))
      .toBe(sha256Canonical({ digest: 1, created_at: "2030-01-01T00:00:00.000Z", path: "/private/b" }));
  });

  it("fails closed for non-finite numbers, secret/raw fields, and absolute paths", () => {
    expect(() => sha256Canonical({ value: Number.NaN })).toThrow(ProductionControlError);
    expect(() => sha256Canonical({ access_token: "secret" })).toThrow(ProductionControlError);
    expect(() => sha256Canonical({ clientSecret: "secret" })).toThrow(ProductionControlError);
    expect(() => sha256Canonical({ value: "~/private/file" })).toThrow(ProductionControlError);
    expect(() => makeProductionEvent(eventInput({
      type: "mission-created",
      payload: { mission_digest: DIGEST_A, tree_revision: 1, prompt: "raw" } as never
    }))).toThrow();
    expect(() => makeProductionEvent(eventInput({
      type: "mission-created",
      payload: { mission_digest: DIGEST_A, tree_revision: 1, path: "/Users/private" } as never
    }))).toThrow();
    expect(() => parseProductionEvent({
      schema_version: 1,
      event_id: "event-1",
      production_id: "production-1",
      sequence: 1,
      previous_event_digest: DIGEST_A,
      payload_digest: DIGEST_A,
      created_at: "2026-08-11T00:00:00.000Z",
      coordinator_instance_id: "coordinator-test",
      event_digest: DIGEST_A,
      type: "unknown-event",
      payload: {}
    })).toThrow();
  });
});

describe("PO-1 ArtifactStore", () => {
  it("writes a regular create-only artifact and rejects duplicate/size/digest mismatch", async () => {
    const root = await tempRoot("artifact");
    try {
      const store = new ArtifactStore(root);
      const bytes = Buffer.from("artifact");
      const saved = await store.create({ artifact_id: "artifact-1", bytes, expected_size: bytes.byteLength, expected_sha256: sha256Bytes(bytes) });
      expect(saved.relative_path).toBe("artifacts/artifact-1.json");
      expect(await store.read("artifact-1")).toEqual(bytes);
      await expectCode(() => store.create({ artifact_id: "artifact-1", bytes }), "PC_ARTIFACT_DUPLICATE");
      await expectCode(() => store.create({ artifact_id: "artifact-2", bytes, expected_size: bytes.byteLength + 1 }), "PC_ARTIFACT_MISMATCH");
      await expectCode(() => store.create({ artifact_id: "artifact-3", bytes, expected_sha256: DIGEST_A }), "PC_ARTIFACT_MISMATCH");
      await expectCode(() => store.create({ artifact_id: "../escape", bytes }), "PC_PATH_UNSAFE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked artifact directory and leaf swap before publication", async () => {
    const root = await tempRoot("artifact-path");
    const outside = await tempRoot("artifact-outside");
    try {
      await symlink(outside, join(root, "artifacts"));
      await expectCode(() => new ArtifactStore(root).create({ artifact_id: "artifact-1", bytes: "x" }), "PC_PATH_UNSAFE");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }

    const root2 = await tempRoot("artifact-leaf");
    const outside2 = await tempRoot("artifact-leaf-outside");
    try {
      const finalPath = join(root2, "artifacts", "artifact-1.json");
      const store = new ArtifactStore(root2, { hooks: {
        beforePublish: async () => {
          await symlink(join(outside2, "target"), finalPath);
        }
      } });
      await expectCode(() => store.create({ artifact_id: "artifact-1", bytes: "x" }), "PC_PATH_UNSAFE");
      expect((await readdir(join(root2, "artifacts"))).some((name) => name === "artifact-1.json")).toBe(true);
    } finally {
      await rm(root2, { recursive: true, force: true });
      await rm(outside2, { recursive: true, force: true });
    }

    const root3 = await tempRoot("artifact-after-reserve");
    const outside3 = await tempRoot("artifact-after-reserve-outside");
    try {
      const finalPath = join(root3, "artifacts", "artifact-1.json");
      const store = new ArtifactStore(root3, { hooks: {
        afterReserveBeforeRename: async () => {
          await symlink(join(outside3, "target"), finalPath);
        }
      } });
      await expectCode(() => store.create({ artifact_id: "artifact-1", bytes: "x" }), "PC_PATH_UNSAFE");
    } finally {
      await rm(root3, { recursive: true, force: true });
      await rm(outside3, { recursive: true, force: true });
    }

    const root4 = await tempRoot("artifact-toctou");
    try {
      const finalPath = join(root4, "artifacts", "artifact-1.json");
      const store = new ArtifactStore(root4, { hooks: {
        afterFinalCheckBeforePublish: async () => writeFile(finalPath, "foreign")
      } });
      await expectCode(() => store.create({ artifact_id: "artifact-1", bytes: "x" }), "PC_ARTIFACT_DUPLICATE");
      expect(await readFile(finalPath, "utf8")).toBe("foreign");
    } finally {
      await rm(root4, { recursive: true, force: true });
    }
  });

  it("retains a published artifact as an orphan when directory fsync crashes", async () => {
    const root = await tempRoot("artifact-boundary");
    try {
      const bytes = Buffer.from("orphan-evidence");
      const store = new ArtifactStore(root, { hooks: {
        afterPublishBeforeDirectorySync: () => { throw new Error("simulated artifact directory crash"); }
      } });
      await expect(store.create({ artifact_id: "artifact-1", bytes })).rejects.toThrow("simulated artifact directory crash");
      expect(await new ArtifactStore(root).read("artifact-1")).toEqual(bytes);
      expect(await new ArtifactStore(root).recover()).toEqual({ removed_temp_files: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not adopt a partial temp artifact during recovery", async () => {
    const root = await tempRoot("artifact-recovery");
    try {
      const store = new ArtifactStore(root);
      await mkdir(join(root, "artifacts"), { recursive: true });
      await writeFile(join(root, "artifacts", ".artifact-1.orphan.tmp"), "partial");
      expect(await store.recover()).toEqual({ removed_temp_files: 1 });
      expect(await store.has("artifact-1")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PO-1 event chain and pure reducer", () => {
  it("replays a mission deterministically and binds accepted artifacts to all expected values", async () => {
    const root = await tempRoot("events");
    try {
      const { store, state } = await buildAcceptedStore(root);
      const events = await store.readAll();
      expect(state.mission_status).toBe("running");
      expect(state.nodes["node-1"].accepted_artifact_id).toBe("artifact-1");
      expect(replayProductionEvents(events, "production-1")).toEqual(state);
      expect(missionStateDigest(state)).toBe(missionStateDigest(replayProductionEvents(events, "production-1")));
      expect(events.every((event) => event.event_digest.length === 64)).toBe(true);
      expect(() => reduceProductionEvent(state, events[0])).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects gap, duplicate, tampered, and cross-production events", async () => {
    const root = await tempRoot("event-adversarial");
    try {
      const store = new EventStore(root);
      const first = await store.append(eventInput({ type: "mission-created", payload: { mission_digest: DIGEST_A, tree_revision: 1 } }));
      await expectCode(() => store.append({
        ...eventInput({ type: "tree-compiled", payload: { tree_revision: 1, tree_digest: DIGEST_B } }),
        sequence: 3
      }), "PC_EVENT_CONFLICT");
      await expectCode(() => store.append({
        ...eventInput({ type: "mission-created", payload: { mission_digest: DIGEST_A, tree_revision: 1 } }),
        event_id: first.event_id
      }), "PC_EVENT_CONFLICT");
      await expectCode(() => store.append(eventInput({
        type: "mission-completed", payload: { completion_digest: DIGEST_A }
      })), "PC_INVALID_TRANSITION");
      const eventPath = join(root, "events.jsonl");
      const tampered = (await readFile(eventPath, "utf8")).replace(DIGEST_A, DIGEST_B);
      await writeFile(eventPath, tampered);
      await expectCode(() => store.readAll(), "PC_EVENT_TAMPERED");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores an unterminated event tail and reports it as uncommitted", async () => {
    const root = await tempRoot("event-crash");
    try {
      const store = new EventStore(root);
      await store.append(eventInput({ type: "mission-created", payload: { mission_digest: DIGEST_A, tree_revision: 1 } }));
      const path = join(root, "events.jsonl");
      await writeFile(path, `${await readFile(path, "utf8")}not-committed`);
      const recovered = await store.recover();
      expect(recovered.events).toHaveLength(1);
      expect(recovered.uncommitted_line_count).toBe(1);
      expect(await store.readAll()).toHaveLength(1);
      await store.append(eventInput({ type: "tree-compiled", payload: { tree_revision: 1, tree_digest: DIGEST_B } }));
      expect(await store.readAll()).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not adopt an event after log fsync when commit publication crashes", async () => {
    const root = await tempRoot("event-boundary");
    let failBeforeCommit = true;
    try {
      const store = new EventStore(root, { hooks: {
        afterEventFsyncBeforeCommit: () => {
          if (failBeforeCommit) {
            failBeforeCommit = false;
            throw new Error("simulated commit boundary crash");
          }
        }
      } });
      const mission = eventInput({ type: "mission-created", payload: { mission_digest: DIGEST_A, tree_revision: 1 } });
      await expect(store.append(mission)).rejects.toThrow("simulated commit boundary crash");
      expect(await store.readAll()).toEqual([]);
      expect((await store.recover()).uncommitted_line_count).toBe(1);
      await store.append(mission);
      expect(await store.readAll()).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects every stale acceptance path while preserving accepted-then-invalidated evidence", async () => {
    const acceptedRoot = await tempRoot("invalidate-after");
    try {
      const { store } = await buildAcceptedStore(acceptedRoot);
      await store.append(eventInput({ type: "nodes-invalidated", payload: {
        cause_artifact_ids: ["artifact-1"], stale_node_ids: ["node-1"], preserved_node_ids: [], stale_gate_binding_ids: []
      } }));
      const state = await store.replay("production-1");
      expect(state.nodes["node-1"].status).toBe("stale");
      expect(state.accepted_artifacts["artifact-1"].invalidated).toBe(true);
    } finally {
      await rm(acceptedRoot, { recursive: true, force: true });
    }

    const beforeRoot = await tempRoot("invalidate-before");
    try {
      const store = new EventStore(beforeRoot);
      await store.append(eventInput({ type: "mission-created", payload: { mission_digest: DIGEST_A, tree_revision: 1 } }));
      await store.append(eventInput({ type: "task-readied", payload: { node_id: "node-1", task_revision: 1, input_digest: DIGEST_A, dependency_closure_digest: DIGEST_B } }));
      await store.append(eventInput({ type: "attempt-leased", payload: {
        attempt_id: "attempt-1", lease_id: "lease-1", node_id: "node-1", task_revision: 1, attempt_key: DIGEST_A,
        input_digest: DIGEST_A, lease_digest: DIGEST_B, role: "reviewer", effect: "propose",
        acquired_at: "2026-08-11T00:00:00.000Z", expires_at: "2026-08-11T01:00:00.000Z"
      } }));
      await store.append(eventInput({ type: "attempt-started", payload: { attempt_id: "attempt-1", lease_digest: DIGEST_B } }));
      const artifactDigest = sha256Bytes(Buffer.from("artifact"));
      await store.append(eventInput({ type: "artifact-created", payload: { artifact_id: "artifact-1", artifact_digest: artifactDigest, node_id: "node-1", attempt_id: "attempt-1" } }));
      await store.append(eventInput({ type: "nodes-invalidated", payload: {
        cause_artifact_ids: ["artifact-1"], stale_node_ids: ["node-1"], preserved_node_ids: [], stale_gate_binding_ids: []
      } }));
      await expectCode(() => store.append(eventInput({ type: "artifact-accepted", payload: {
        artifact_id: "artifact-1", artifact_digest: artifactDigest, node_id: "node-1", attempt_id: "attempt-1", expected_event_sequence: 6,
        tree_revision: 1, task_revision: 1, input_digest: DIGEST_A, lease_digest: DIGEST_B, dependency_closure_digest: DIGEST_B
      } })), "PC_INVALID_TRANSITION");
    } finally {
      await rm(beforeRoot, { recursive: true, force: true });
    }
  });
});

describe("PO-1 snapshot CAS and recovery", () => {
  it("rejects stale CAS writers and reconstructs a missing/stale snapshot from events", async () => {
    const root = await tempRoot("snapshot");
    try {
      const { store, state } = await buildAcceptedStore(root);
      const snapshots = new SnapshotStore(root);
      const first = await snapshots.compareAndSwap(state, null);
      await expectCode(() => snapshots.compareAndSwap({ ...state, revision: state.revision + 1 }, {
        applied_event_sequence: 0,
        state_digest: sha256Canonical({ stale: true })
      }), "PC_SNAPSHOT_CONFLICT");
      await rm(join(root, "coordination-state.json"));
      const recovered = await snapshots.recoverFromEvents(store, "production-1");
      expect(recovered.snapshot_rebuilt).toBe(true);
      expect(recovered.state).toEqual(state);
      expect((await snapshots.read())?.state_digest).toBe(first.state_digest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not adopt a partial or tampered snapshot and refuses a leaf swap", async () => {
    const root = await tempRoot("snapshot-crash");
    try {
      const { store, state } = await buildAcceptedStore(root);
      const snapshots = new SnapshotStore(root);
      await snapshots.compareAndSwap(state, null);
      await writeFile(join(root, "coordination-state.json"), "partial");
      const repaired = await snapshots.recoverFromEvents(store, "production-1");
      expect(repaired.state).toEqual(state);
      const root2 = await tempRoot("snapshot-leaf");
      try {
        const outside = await tempRoot("snapshot-outside");
        const snapshotPath = join(root2, "coordination-state.json");
        const swapping = new SnapshotStore(root2, { hooks: {
          beforeRename: async () => symlink(join(outside, "target"), snapshotPath)
        } });
        await expectCode(() => swapping.compareAndSwap(state, null), "PC_PATH_UNSAFE");
        await rm(outside, { recursive: true, force: true });
      } finally {
        await rm(root2, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the prior snapshot when temp fsync fails", async () => {
    const root = await tempRoot("snapshot-boundary");
    let failAfterTempSync = true;
    try {
      const { state } = await buildAcceptedStore(root);
      const stable = new SnapshotStore(root);
      const first = await stable.compareAndSwap(state, null);
      const crashing = new SnapshotStore(root, { hooks: {
        afterTempSync: () => {
          if (failAfterTempSync) {
            failAfterTempSync = false;
            throw new Error("simulated snapshot fsync crash");
          }
        }
      } });
      await expectCode(() => crashing.compareAndSwap({ ...state, revision: state.revision + 1 }, {
        applied_event_sequence: state.applied_event_sequence,
        state_digest: first.state_digest
      }), "PC_RECOVERY_INVALID");
      expect((await stable.read())?.state_digest).toBe(first.state_digest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent CAS writers so exactly one stale writer wins", async () => {
    const root = await tempRoot("snapshot-race");
    try {
      const { state } = await buildAcceptedStore(root);
      const snapshots = new SnapshotStore(root);
      const [first, second] = await Promise.allSettled([
        snapshots.compareAndSwap(state, null),
        snapshots.compareAndSwap({ ...state, revision: state.revision + 1 }, null)
      ]);
      expect([first.status, second.status].filter((status) => status === "fulfilled")).toHaveLength(1);
      expect([first.status, second.status].filter((status) => status === "rejected")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
