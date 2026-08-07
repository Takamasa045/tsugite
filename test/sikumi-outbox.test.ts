import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOptionalSikumiOutbox,
  createOutboxEventId,
  isSikumiEnabled,
  mapRunStateToSikumiEvents,
  notifySikumiStateChange,
  projectRootFromStateDir,
  sanitizeOutboxMessage,
  writeOutboxEvent
} from "../src/integrations/sikumiOutbox.js";
import type { Project } from "../src/project/schema.js";
import type { RunState } from "../src/orchestrator/stateTypes.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

const baseProject = (sikumi?: { enabled: boolean }): Project =>
  ({
    slug: "demo-case",
    name: "デモ案件",
    dist_dir: "dist",
    manifest: "manifest.json",
    edit: { backend: "remotion" },
    ...(sikumi ? { sikumi } : {})
  }) as Project;

const gates = (status: "pending" | "awaiting_approval" | "approved"): RunState["gates"] => ({
  gate_1: { status },
  gate_2: { status: "pending" },
  gate_3: { status: "pending" }
});

describe("sikumiOutbox optional adapter", () => {
  it("isSikumiEnabled defaults false", () => {
    expect(isSikumiEnabled(baseProject())).toBe(false);
    expect(isSikumiEnabled(baseProject({ enabled: false }))).toBe(false);
    expect(isSikumiEnabled(baseProject({ enabled: true }))).toBe(true);
  });

  it("createOptionalSikumiOutbox is pure no-op when disabled", async () => {
    let wrote = 0;
    const sink = createOptionalSikumiOutbox({
      enabled: false,
      projectRoot: "/tmp/x",
      write: async () => {
        wrote += 1;
        return { path: "/tmp/x" };
      }
    });
    expect(sink.enabled).toBe(false);
    expect(
      await sink.emit({ eventType: "run.started", runId: "r1", message: "start" })
    ).toBe(false);
    expect(wrote).toBe(0);
  });

  it("writeOutboxEvent writes atomic protocol JSON without absolute paths in message", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-sikumi-")));
    dirs.push(root);
    const { path } = await writeOutboxEvent({
      projectRoot: root,
      eventType: "task.started",
      runId: "run-1",
      projectLabel: "demo-case",
      agentId: "tsugite",
      message: sanitizeOutboxMessage("start /Users/me/secret.mp4") ?? "start",
      taskId: "generate"
    });
    const body = JSON.parse(await readFile(path, "utf8")) as {
      schema_version: string;
      event_type: string;
      message: string;
      agent_id: string;
    };
    expect(body.schema_version).toBe("1");
    expect(body.event_type).toBe("task.started");
    expect(body.agent_id).toBe("tsugite");
    expect(body.message).not.toContain("/Users/");
    expect(createOutboxEventId(1_700_000_000_000)).toHaveLength(26);
  });

  it("maps gate awaiting and completion transitions", () => {
    const planned: RunState = {
      run_id: "run-a",
      status: "planned",
      updated_at: "2026-08-07T00:00:00.000Z",
      gates: gates("pending")
    };
    const awaiting: RunState = {
      ...planned,
      status: "awaiting_gate_1",
      gates: {
        gate_1: { status: "awaiting_approval" },
        gate_2: { status: "pending" },
        gate_3: { status: "pending" }
      }
    };
    const mapped = mapRunStateToSikumiEvents(planned, awaiting);
    expect(mapped.some((e) => e.eventType === "gate.waiting")).toBe(true);
    expect(mapped.some((e) => e.metadata?.gate_id === "gate_1")).toBe(true);

    const completed: RunState = {
      run_id: "run-a",
      status: "completed",
      updated_at: "2026-08-07T01:00:00.000Z",
      gates: {
        gate_1: { status: "approved" },
        gate_2: { status: "approved" },
        gate_3: { status: "approved" }
      }
    };
    const done = mapRunStateToSikumiEvents(
      {
        ...completed,
        status: "awaiting_gate_3",
        gates: {
          gate_1: { status: "approved" },
          gate_2: { status: "approved" },
          gate_3: { status: "awaiting_approval" }
        }
      },
      completed
    );
    expect(done.some((e) => e.eventType === "run.completed")).toBe(true);
    expect(done.some((e) => e.eventType === "gate.approved")).toBe(true);
  });

  it("notifySikumiStateChange no-ops when disabled and never throws", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-sikumi-off-")));
    dirs.push(root);
    await notifySikumiStateChange({
      project: baseProject({ enabled: false }),
      projectRoot: root,
      previous: null,
      next: {
        run_id: "r1",
        status: "planned",
        updated_at: "2026-08-07T00:00:00.000Z",
        gates: gates("pending")
      }
    });
    await expect(readdir(join(root, ".sikumi", "events"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("notifySikumiStateChange writes events when enabled", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-sikumi-on-")));
    dirs.push(root);
    await notifySikumiStateChange({
      project: baseProject({ enabled: true }),
      projectRoot: root,
      previous: {
        run_id: "r1",
        status: "planned",
        updated_at: "2026-08-07T00:00:00.000Z",
        gates: gates("pending")
      },
      next: {
        run_id: "r1",
        status: "awaiting_gate_1",
        updated_at: "2026-08-07T00:00:01.000Z",
        gates: {
          gate_1: { status: "awaiting_approval" },
          gate_2: { status: "pending" },
          gate_3: { status: "pending" }
        }
      }
    });
    const names = await readdir(join(root, ".sikumi", "events"));
    expect(names.some((n) => n.endsWith(".json"))).toBe(true);
  });

  it("projectRootFromStateDir strips dist_dir suffix", () => {
    expect(projectRootFromStateDir("/proj/case/dist", "dist")).toBe("/proj/case");
  });
});
