/**
 * Optional sikumi Event Outbox adapter (tsugite → `.sikumi/events/`).
 *
 * - Default OFF (`project.sikumi.enabled !== true`) → pure no-op
 * - Never talks to Supabase / Local Agent Server HTTP
 * - Write failures never throw to the pipeline (fail-soft)
 * - Self-contained protocol writer (no hard dependency on sikumi packages)
 *
 * Spec: sikumi `docs/architecture/event-protocol.md`
 */
import { constants } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Project } from "../project/schema.js";
import type { GateDecision, GateId, RunState } from "../orchestrator/stateTypes.js";

const OUTBOX_EVENT_MAX_BYTES = 64 * 1024;
const OUTBOX_EVENTS_RELATIVE_DIR = ".sikumi/events";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type SikumiOutboxEventType =
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "task.started"
  | "task.progress"
  | "task.completed"
  | "task.failed"
  | "agent.working"
  | "agent.waiting"
  | "agent.failed"
  | "artifact.created"
  | "qa.started"
  | "qa.passed"
  | "qa.failed"
  | "gate.waiting"
  | "gate.approved"
  | "gate.rejected";

export type SikumiProjectConfig = {
  readonly enabled?: boolean;
};

export type SikumiEmitInput = {
  readonly eventType: SikumiOutboxEventType;
  readonly runId: string;
  readonly taskId?: string;
  readonly message?: string;
  readonly metadata?: Record<string, unknown>;
};

export type OptionalSikumiOutbox = {
  readonly enabled: boolean;
  emit(input: SikumiEmitInput): Promise<boolean>;
};

export const isSikumiEnabled = (project: Project): boolean => {
  const raw = (project as { sikumi?: unknown }).sikumi;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  return (raw as { enabled?: unknown }).enabled === true;
};

export const projectRootFromStateDir = (
  stateDir: string,
  distDirRelative: string,
): string => {
  const abs = resolve(stateDir);
  const rel = distDirRelative.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const normalized = abs.replace(/\\/g, "/");
  if (rel.length > 0 && normalized.endsWith(`/${rel}`)) {
    return abs.slice(0, abs.length - rel.length - 1);
  }
  if (rel.length > 0 && normalized.endsWith(rel)) {
    return abs.slice(0, abs.length - rel.length);
  }
  return dirname(abs);
};

export const createOutboxEventId = (nowMs: number = Date.now()): string => {
  let time = Math.max(0, Math.floor(nowMs));
  let timePart = "";
  for (let i = 0; i < 10; i += 1) {
    timePart = CROCKFORD[time % 32]! + timePart;
    time = Math.floor(time / 32);
  }
  let rand = "";
  for (let i = 0; i < 16; i += 1) {
    rand += CROCKFORD[Math.floor(Math.random() * 32)]!;
  }
  return `${timePart}${rand}`;
};

export const sanitizeOutboxMessage = (
  raw: string | undefined,
): string | undefined => {
  if (raw === undefined) return undefined;
  let text = raw.replace(/[/\\][^\s]{2,}/g, "[path]").trim();
  text = text.replace(
    /(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{16,}|AKIA[0-9A-Z]{16})/g,
    "[REDACTED]",
  );
  if (text.length === 0) return undefined;
  return text.slice(0, 500);
};

type WriteOutboxEventInput = {
  readonly projectRoot: string;
  readonly eventType: SikumiOutboxEventType;
  readonly runId: string;
  readonly agentId?: string;
  readonly projectLabel?: string;
  readonly taskId?: string;
  readonly message?: string;
  readonly metadata?: Record<string, unknown>;
  readonly eventId?: string;
  readonly timestamp?: string;
};

export const writeOutboxEvent = async (
  input: WriteOutboxEventInput,
): Promise<{ readonly path: string }> => {
  const projectRoot = resolve(input.projectRoot);
  if (!isAbsolute(projectRoot)) {
    throw new Error("projectRoot must be absolute");
  }
  const event_id = input.eventId ?? createOutboxEventId();
  const event = {
    schema_version: "1",
    event_id,
    event_type: input.eventType,
    timestamp: input.timestamp ?? new Date().toISOString(),
    project_id: (input.projectLabel ?? "project").slice(0, 120),
    agent_id: (input.agentId ?? "tsugite").slice(0, 64),
    run_id: input.runId.slice(0, 128),
    ...(input.taskId === undefined ? {} : { task_id: input.taskId.slice(0, 128) }),
    ...(input.message === undefined
      ? {}
      : { message: input.message.slice(0, 500) }),
    metadata: {
      // Keep metadata free of unknown provider_id (sikumi Outbox schema is strict).
      ...(input.metadata ?? {}),
    },
  };
  const dir = join(projectRoot, OUTBOX_EVENTS_RELATIVE_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const finalPath = join(dir, `${event_id}.json`);
  const tmpPath = join(dir, `${event_id}.json.tmp`);
  if (!finalPath.startsWith(projectRoot + sep) && finalPath !== projectRoot) {
    throw new Error("Outbox path escapes project root");
  }
  const body = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(body, "utf8") > OUTBOX_EVENT_MAX_BYTES) {
    throw new Error("Outbox event exceeds size limit");
  }
  const handle = await open(
    tmpPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, finalPath);
  return { path: finalPath };
};

export const createOptionalSikumiOutbox = (options: {
  readonly enabled: boolean;
  readonly projectRoot: string;
  readonly projectLabel?: string;
  readonly agentId?: string;
  readonly write?: typeof writeOutboxEvent;
}): OptionalSikumiOutbox => {
  const enabled = options.enabled === true;
  const write = options.write ?? writeOutboxEvent;
  const projectLabel = options.projectLabel ?? "project";
  const agentId = options.agentId ?? "tsugite";
  const projectRoot = options.projectRoot;

  return {
    enabled,
    async emit(input) {
      if (!enabled) return false;
      try {
        await write({
          projectRoot,
          eventType: input.eventType,
          runId: input.runId,
          agentId,
          projectLabel,
          ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
          ...(input.message === undefined
            ? {}
            : {
                message:
                  sanitizeOutboxMessage(input.message) ??
                  input.message.slice(0, 500),
              }),
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        });
        return true;
      } catch {
        return false;
      }
    },
  };
};

export const createSikumiOutboxForProject = (
  project: Project,
  projectRoot: string,
): OptionalSikumiOutbox =>
  createOptionalSikumiOutbox({
    enabled: isSikumiEnabled(project),
    projectRoot,
    projectLabel: project.slug,
    agentId: "tsugite",
  });

/**
 * Map a run state change to zero or more Outbox events.
 * Pure: no I/O.
 */
export const mapRunStateToSikumiEvents = (
  previous: RunState | null | undefined,
  next: RunState,
): readonly SikumiEmitInput[] => {
  const runId = next.run_id;
  const events: SikumiEmitInput[] = [];
  const prevStatus = previous?.status;
  const prevGates = previous?.gates;

  if (previous === null || previous === undefined || prevStatus === undefined) {
    events.push({
      eventType: "run.started",
      runId,
      message: "run started",
    });
  }

  // Gate resolutions first so LIVE session leaves waiting_for_approval before
  // task/activity events that require state === "running".
  for (const gate of ["gate_1", "gate_2", "gate_3"] as const satisfies GateId[]) {
    const before = prevGates?.[gate]?.status;
    const after = next.gates[gate]?.status;
    if (before === after) continue;
    if (after === "approved" && before !== "approved") {
      events.push({
        eventType: "gate.approved",
        runId,
        taskId: gate,
        message: `${gate} approved`,
        metadata: { gate_id: gate },
      });
      if (gate === "gate_2" || gate === "gate_3") {
        events.push({
          eventType: "qa.passed",
          runId,
          taskId: gate,
          message: `${gate} qc passed`,
        });
      }
    }
    if ((after === "revise" || after === "abort") && before !== after) {
      events.push({
        eventType: "gate.rejected",
        runId,
        taskId: gate,
        message: `${gate} ${after}`,
        metadata: { gate_id: gate },
      });
      if (gate === "gate_2" || gate === "gate_3") {
        events.push({
          eventType: "qa.failed",
          runId,
          taskId: gate,
          message: `${gate} qc failed`,
        });
      }
    }
  }

  if (prevStatus !== next.status) {
    switch (next.status) {
      case "planned":
        if (previous !== null && previous !== undefined) {
          events.push({
            eventType: "task.started",
            runId,
            taskId: "plan",
            message: "run planned",
          });
        }
        break;
      case "awaiting_gate_1":
        events.push({
          eventType: "gate.waiting",
          runId,
          taskId: "gate_1",
          message: "awaiting gate 1",
          metadata: { gate_id: "gate_1" },
        });
        break;
      case "running":
        events.push({
          eventType: "task.started",
          runId,
          taskId: "generate",
          message: "generation running",
        });
        events.push({
          eventType: "agent.working",
          runId,
          message: "agent working",
        });
        break;
      case "awaiting_gate_2":
        events.push({
          eventType: "qa.started",
          runId,
          taskId: "gate_2",
          message: "gate 2 qc",
        });
        events.push({
          eventType: "gate.waiting",
          runId,
          taskId: "gate_2",
          message: "awaiting gate 2",
          metadata: { gate_id: "gate_2" },
        });
        break;
      case "rendering":
        events.push({
          eventType: "task.progress",
          runId,
          taskId: "render",
          message: "rendering",
        });
        events.push({
          eventType: "agent.working",
          runId,
          message: "render working",
        });
        break;
      case "awaiting_gate_3":
        events.push({
          eventType: "qa.started",
          runId,
          taskId: "gate_3",
          message: "gate 3 qc",
        });
        events.push({
          eventType: "gate.waiting",
          runId,
          taskId: "gate_3",
          message: "awaiting gate 3",
          metadata: { gate_id: "gate_3" },
        });
        break;
      case "completed":
        events.push({
          eventType: "run.completed",
          runId,
          message: "run completed",
        });
        break;
      case "aborted":
        events.push({
          eventType: "run.failed",
          runId,
          message: "run aborted",
        });
        break;
      case "dry_run":
        events.push({
          eventType: "task.progress",
          runId,
          taskId: "dry_run",
          message: "dry run",
        });
        break;
      default:
        break;
    }
  }

  // Awaiting gate without status change (rare) — emit waiting only.
  for (const gate of ["gate_1", "gate_2", "gate_3"] as const satisfies GateId[]) {
    const before = prevGates?.[gate]?.status;
    const after = next.gates[gate]?.status;
    if (before === after) continue;
    if (after !== "awaiting_approval") continue;
    if (
      next.status === "awaiting_gate_1" ||
      next.status === "awaiting_gate_2" ||
      next.status === "awaiting_gate_3"
    ) {
      continue; // already emitted with status transition
    }
    events.push({
      eventType: "gate.waiting",
      runId,
      taskId: gate,
      message: `awaiting ${gate}`,
      metadata: { gate_id: gate },
    });
  }

  return events;
};

/** Fail-soft notify after a successful state write. */
export const notifySikumiStateChange = async (options: {
  readonly project: Project;
  readonly projectRoot: string;
  readonly previous?: RunState | null;
  readonly next: RunState;
}): Promise<void> => {
  const sink = createSikumiOutboxForProject(options.project, options.projectRoot);
  if (!sink.enabled) return;
  const events = mapRunStateToSikumiEvents(options.previous, options.next);
  for (const event of events) {
    await sink.emit(event);
  }
};

export const notifySikumiArtifact = async (options: {
  readonly project: Project;
  readonly projectRoot: string;
  readonly runId: string;
  readonly label: string;
  readonly kind?: string;
  readonly artifactId?: string;
}): Promise<void> => {
  const sink = createSikumiOutboxForProject(options.project, options.projectRoot);
  if (!sink.enabled) return;
  await sink.emit({
    eventType: "artifact.created",
    runId: options.runId,
    taskId: "artifact",
    message: sanitizeOutboxMessage(options.label) ?? "artifact",
    metadata: {
      artifact_id: (options.artifactId ?? options.label).slice(0, 128),
      kind: (options.kind ?? "file").slice(0, 64),
      label: options.label.slice(0, 200),
    },
  });
};

/** Test helper: map a gate decision pair. */
export const mapGateDecisionToEvents = (
  runId: string,
  gate: GateId,
  decision: GateDecision,
): readonly SikumiEmitInput[] => {
  if (decision === "approved") {
    return [
      {
        eventType: "gate.approved",
        runId,
        taskId: gate,
        message: `${gate} approved`,
        metadata: { gate_id: gate },
      },
    ];
  }
  if (decision === "revise" || decision === "abort") {
    return [
      {
        eventType: "gate.rejected",
        runId,
        taskId: gate,
        message: `${gate} ${decision}`,
        metadata: { gate_id: gate },
      },
    ];
  }
  return [];
};
