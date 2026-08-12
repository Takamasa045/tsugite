/**
 * Public Mission Tree projection for Launcher / workflow-viewer.
 * Strict DTO: no prompt body, absolute path, secret, or raw provider response.
 * Gate subjects are never mixed into TaskTree read-only visibility.
 */
import { z } from "zod";
import { sha256Canonical, withoutField } from "./canonical.js";
import { pcError } from "./errors.js";
import {
  digestSchema,
  safeIdSchema,
  type MissionState,
  type TaskTreeSpec
} from "./schema.js";
import {
  learningPublicProjectionSchema,
  type LearningPublicProjectionV1
} from "./learning/publicProjection.js";

export const PUBLIC_TASK_STATUSES = [
  "proposed",
  "blocked",
  "ready",
  "running",
  "completed",
  "failed_known",
  "outcome_unknown",
  "awaiting_human",
  "stale"
] as const;
export type PublicTaskStatus = (typeof PUBLIC_TASK_STATUSES)[number];

export const publicMissionNodeSchema = z
  .object({
    node_id: safeIdSchema,
    node_type: z.enum(["mission", "task"]),
    parent_id: safeIdSchema.optional(),
    kind: safeIdSchema.optional(),
    role: safeIdSchema.optional(),
    status: z.enum(PUBLIC_TASK_STATUSES),
    stale: z.boolean(),
    reason_code: z.string().min(1).max(120).optional(),
    task_revision: z.number().int().nonnegative().optional(),
    child_ids: z.array(safeIdSchema).max(256).optional()
  })
  .strict();
export type PublicMissionNodeV1 = z.infer<typeof publicMissionNodeSchema>;

/**
 * Public Gate surface: presence / stale only.
 * Authority digests (subject_digest / decision_digest / approved_input_digest) are
 * forbidden here — Gate authority schemas stay on the authority plane unchanged.
 * Unknown keys are strict-rejected (no wire leakage of digest fields).
 */
export const publicGateSummarySchema = z
  .object({
    gate: z.enum(["gate_1", "gate_2", "gate_3"]),
    status: z.enum(["absent", "current", "stale"])
  })
  .strict();
export type PublicGateSummaryV1 = z.infer<typeof publicGateSummarySchema>;

export const publicCurrentDecisionSchema = z
  .object({
    kind: z.enum([
      "none",
      "awaiting_human",
      "gate",
      "blocked",
      "outcome_unknown",
      "recovery",
      "learning"
    ]),
    node_id: safeIdSchema.optional(),
    gate: z.enum(["gate_1", "gate_2", "gate_3"]).optional(),
    reason_code: z.string().min(1).max(120).optional(),
    summary: z.string().min(1).max(500)
  })
  .strict();
export type PublicCurrentDecisionV1 = z.infer<typeof publicCurrentDecisionSchema>;

export const publicRecoverySummarySchema = z
  .object({
    active: z.boolean(),
    attempts: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative().nullable(),
    last_error_code: z.string().min(1).max(120).optional()
  })
  .strict();

export const missionTreePublicProjectionSchema = z
  .object({
    schema_version: z.literal(1),
    production_id: safeIdSchema,
    mode: z.enum(["legacy", "shadow", "active"]),
    mission_status: z.string().min(1).max(64),
    tree_revision: z.number().int().nonnegative(),
    source_event_sequence: z.number().int().nonnegative(),
    nodes: z.array(publicMissionNodeSchema).max(256),
    edges: z
      .array(
        z
          .object({
            id: safeIdSchema,
            source: safeIdSchema,
            target: safeIdSchema
          })
          .strict()
      )
      .max(512),
    gates: z.array(publicGateSummarySchema).max(3),
    current_decision: publicCurrentDecisionSchema,
    recovery: publicRecoverySummarySchema,
    learning: learningPublicProjectionSchema.optional(),
    /** True when this projection is read-only TaskTree visibility (never a Gate subject). */
    task_tree_read_only: z.literal(true),
    /** Legacy fixed 8-step workflow remains available alongside active tree. */
    legacy_workflow_preserved: z.boolean(),
    digest: digestSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["digest"],
        message: "mission tree public projection digest mismatch"
      });
    }
  });
export type MissionTreePublicProjectionV1 = z.infer<typeof missionTreePublicProjectionSchema>;

const FORBIDDEN_PUBLIC = /(?:api_key|access_token|refresh_token|cookie|password|private_key|provider_body|provider_response|raw_prompt|session_token|"prompt"\s*:|\/Users\/|\\\\|[A-Za-z]:\\)/i;

export type ProjectMissionTreeInput = {
  production_id: string;
  mode: "legacy" | "shadow" | "active";
  mission_state: MissionState;
  task_tree?: TaskTreeSpec;
  /**
   * When TaskTree artifact is unavailable, project an explicit blocked/degraded
   * public DTO instead of inventing a flat graph from state nodes.
   */
  degraded?: {
    reason_code: string;
    summary: string;
  };
  learning?: LearningPublicProjectionV1;
  recovery?: {
    active?: boolean;
    attempts?: number;
    limit?: number | null;
    last_error_code?: string;
  };
  legacy_workflow_preserved?: boolean;
};

function nodeStatusFromState(
  state: MissionState,
  nodeId: string
): { status: PublicTaskStatus; stale: boolean; reason_code?: string } {
  const node = state.nodes[nodeId];
  if (!node) {
    return { status: "proposed", stale: false };
  }
  return {
    status: node.status,
    stale: node.stale || node.status === "stale",
    ...(node.status === "awaiting_human"
      ? { reason_code: "task.awaiting_human" }
      : node.status === "blocked"
        ? { reason_code: "task.blocked" }
        : node.status === "outcome_unknown"
          ? { reason_code: "task.outcome_unknown" }
          : node.status === "stale" || node.stale
            ? { reason_code: "task.stale" }
            : {})
  };
}

/**
 * Public Gate summary only: presence / stale status.
 * subject_digest / decision_digest stay on the authority plane and must never
 * be mixed into Mission Tree public DTO or viewer payloads.
 */
function projectGates(state: MissionState): PublicGateSummaryV1[] {
  const byGate = new Map<string, PublicGateSummaryV1>();
  for (const binding of Object.values(state.gate_bindings)) {
    byGate.set(binding.gate, {
      gate: binding.gate,
      status: binding.stale ? "stale" : "current"
    });
  }
  return (["gate_1", "gate_2", "gate_3"] as const).map(
    (gate) => byGate.get(gate) ?? { gate, status: "absent" as const }
  );
}

/**
 * Single public-surface sanitizer for MissionTreePublicProjection.
 * Strips Gate subject/decision digests from gates (and any leaked approval fields)
 * without changing Gate approval digest algorithms elsewhere.
 */
export function sanitizeMissionTreePublicProjection(
  projection: MissionTreePublicProjectionV1
): MissionTreePublicProjectionV1 {
  const parsed = missionTreePublicProjectionSchema.parse(projection);
  const gates = parsed.gates.map((gate) => ({
    gate: gate.gate,
    status: gate.status
  }));
  const draft = {
    schema_version: 1 as const,
    production_id: parsed.production_id,
    mode: parsed.mode,
    mission_status: parsed.mission_status,
    tree_revision: parsed.tree_revision,
    source_event_sequence: parsed.source_event_sequence,
    nodes: parsed.nodes,
    edges: parsed.edges,
    gates,
    current_decision: parsed.current_decision,
    recovery: parsed.recovery,
    ...(parsed.learning ? { learning: parsed.learning } : {}),
    task_tree_read_only: true as const,
    legacy_workflow_preserved: parsed.legacy_workflow_preserved
  };
  const sanitized = missionTreePublicProjectionSchema.parse({
    ...draft,
    digest: sha256Canonical(draft)
  });
  const serialized = JSON.stringify(sanitized);
  if (
    FORBIDDEN_PUBLIC.test(serialized)
    || /"subject_digest"\s*:|"decision_digest"\s*:|"approved_input_digest"\s*:/i.test(serialized)
  ) {
    throw pcError(
      "PC_SECRET_OR_PATH",
      "mission tree public projection leaked Gate digests or forbidden content"
    );
  }
  return sanitized;
}

function deriveCurrentDecision(
  state: MissionState,
  nodes: PublicMissionNodeV1[],
  learning?: LearningPublicProjectionV1
): PublicCurrentDecisionV1 {
  const outcomeUnknown = nodes.find((node) => node.status === "outcome_unknown");
  if (outcomeUnknown) {
    return {
      kind: "outcome_unknown",
      node_id: outcomeUnknown.node_id,
      reason_code: outcomeUnknown.reason_code ?? "task.outcome_unknown",
      summary: "結果不明のタスクがあり、照合するまで再実行しません"
    };
  }

  const awaiting = nodes.find((node) => node.status === "awaiting_human");
  if (awaiting) {
    return {
      kind: "awaiting_human",
      node_id: awaiting.node_id,
      reason_code: awaiting.reason_code ?? "task.awaiting_human",
      summary: "人間の判断待ちです"
    };
  }

  const blocked = nodes.find((node) => node.status === "blocked");
  if (blocked) {
    return {
      kind: "blocked",
      node_id: blocked.node_id,
      reason_code: blocked.reason_code ?? "task.blocked",
      summary: "機械的な阻害要因で停止しています"
    };
  }

  const staleGate = Object.values(state.gate_bindings).find((binding) => binding.stale);
  if (staleGate) {
    return {
      kind: "gate",
      gate: staleGate.gate,
      reason_code: "gate.stale",
      summary: `${staleGate.gate} の承認が失効しています`
    };
  }

  if (learning && (learning.status === "awaiting-human" || learning.pending_proposal_count > 0)) {
    return {
      kind: "learning",
      reason_code: "learning.proposal_awaiting_human",
      summary: "学習プロポーザルが人間承認待ちです"
    };
  }

  if (state.mission_status === "completed") {
    return { kind: "none", summary: "ミッションは完了しています" };
  }

  return { kind: "none", summary: "進行中の必須判断はありません" };
}

/**
 * Project a strict public Mission Tree DTO for Launcher / viewer.
 * TaskTree is read-only visibility and must not be used as a Gate subject.
 */
export function projectMissionTree(input: ProjectMissionTreeInput): MissionTreePublicProjectionV1 {
  const state = input.mission_state;
  if (state.production_id !== input.production_id) {
    throw pcError("PC_SCHEMA_INVALID", "mission state production_id mismatch");
  }

  const nodes: PublicMissionNodeV1[] = [];
  const edges: MissionTreePublicProjectionV1["edges"] = [];
  let currentDecision: PublicCurrentDecisionV1 | undefined;

  if (input.degraded) {
    // Explicit degraded/blocked: never invent flat nodes/edges from state alone.
    currentDecision = {
      kind: "blocked",
      reason_code: input.degraded.reason_code,
      summary: input.degraded.summary
    };
  } else if (input.task_tree) {
    if (input.task_tree.production_id !== input.production_id) {
      throw pcError("PC_SCHEMA_INVALID", "task tree production_id mismatch");
    }
    for (const treeNode of input.task_tree.nodes) {
      if (treeNode.node_type === "mission") {
        const statusInfo = nodeStatusFromState(state, treeNode.node_id);
        nodes.push({
          node_id: treeNode.node_id,
          node_type: "mission",
          ...(treeNode.parent_id ? { parent_id: treeNode.parent_id } : {}),
          status: statusInfo.status,
          stale: statusInfo.stale,
          ...(statusInfo.reason_code ? { reason_code: statusInfo.reason_code } : {}),
          child_ids: treeNode.child_ids
        });
        for (const childId of treeNode.child_ids) {
          edges.push({
            id: `edge-${treeNode.node_id}-${childId}`,
            source: treeNode.node_id,
            target: childId
          });
        }
      } else {
        const statusInfo = nodeStatusFromState(state, treeNode.node_id);
        const taskRevision = state.nodes[treeNode.node_id]?.task_revision;
        nodes.push({
          node_id: treeNode.node_id,
          node_type: "task",
          parent_id: treeNode.parent_id,
          kind: treeNode.kind,
          role: treeNode.role,
          status: statusInfo.status,
          stale: statusInfo.stale,
          ...(statusInfo.reason_code ? { reason_code: statusInfo.reason_code } : {}),
          ...(taskRevision !== undefined ? { task_revision: taskRevision } : {})
        });
        for (const dep of treeNode.dependencies) {
          edges.push({
            id: `dep-${dep}-${treeNode.node_id}`,
            source: dep,
            target: treeNode.node_id
          });
        }
      }
    }
  } else {
    // Legacy state-only projection when callers intentionally omit the tree.
    // Active ArtifactStore path must pass task_tree or degraded instead.
    for (const [nodeId, node] of Object.entries(state.nodes)) {
      nodes.push({
        node_id: nodeId,
        node_type: "task",
        status: node.status,
        stale: node.stale || node.status === "stale",
        task_revision: node.task_revision,
        ...(node.status === "awaiting_human"
          ? { reason_code: "task.awaiting_human" }
          : node.status === "outcome_unknown"
            ? { reason_code: "task.outcome_unknown" }
            : node.stale || node.status === "stale"
              ? { reason_code: "task.stale" }
              : {})
      });
    }
  }

  nodes.sort((left, right) => left.node_id.localeCompare(right.node_id));
  edges.sort((left, right) => left.id.localeCompare(right.id));

  const draft = {
    schema_version: 1 as const,
    production_id: input.production_id,
    mode: input.mode,
    mission_status: state.mission_status,
    tree_revision: state.tree_revision,
    source_event_sequence: state.applied_event_sequence,
    nodes,
    edges,
    gates: projectGates(state),
    current_decision: currentDecision ?? deriveCurrentDecision(state, nodes, input.learning),
    recovery: {
      active: input.recovery?.active ?? false,
      attempts: input.recovery?.attempts ?? 0,
      limit: input.recovery?.limit ?? null,
      ...(input.recovery?.last_error_code
        ? { last_error_code: input.recovery.last_error_code }
        : input.degraded
          ? { last_error_code: input.degraded.reason_code }
          : {})
    },
    ...(input.learning ? { learning: input.learning } : {}),
    task_tree_read_only: true as const,
    legacy_workflow_preserved: input.legacy_workflow_preserved ?? true
  };

  const projected = missionTreePublicProjectionSchema.parse({
    ...draft,
    digest: sha256Canonical(draft)
  });

  return sanitizeMissionTreePublicProjection(projected);
}

export function parseMissionTreePublicProjection(input: unknown): MissionTreePublicProjectionV1 {
  return sanitizeMissionTreePublicProjection(missionTreePublicProjectionSchema.parse(input));
}

/**
 * CamelCase launcher/viewer overlay for Mission Tree metadata.
 * Strict public surface: no Gate subject digests, prompts, paths, or secrets.
 */
export type ViewerMissionTreeOverlay = {
  productionId: string;
  mode: "legacy" | "shadow" | "active";
  missionStatus: string;
  treeRevision: number;
  sourceEventSequence: number;
  currentDecision: {
    kind: string;
    summary: string;
    reasonCode?: string;
    nodeId?: string;
    gate?: string;
  };
  recovery: {
    active: boolean;
    attempts: number;
    limit: number | null;
    lastErrorCode?: string;
  };
  learningStatus?: string;
  taskTreeReadOnly: true;
  legacyWorkflowPreserved: boolean;
  digest: string;
};

/** Convert production-control projection (snake_case wire) to viewer camelCase DTO. */
export function toViewerMissionTreeOverlay(
  projection: MissionTreePublicProjectionV1
): ViewerMissionTreeOverlay {
  // parseMissionTreePublicProjection applies the single public sanitizer.
  const parsed = parseMissionTreePublicProjection(projection);
  const overlay: ViewerMissionTreeOverlay = {
    productionId: parsed.production_id,
    mode: parsed.mode,
    missionStatus: parsed.mission_status,
    treeRevision: parsed.tree_revision,
    sourceEventSequence: parsed.source_event_sequence,
    currentDecision: {
      kind: parsed.current_decision.kind,
      summary: parsed.current_decision.summary,
      ...(parsed.current_decision.reason_code
        ? { reasonCode: parsed.current_decision.reason_code }
        : {}),
      ...(parsed.current_decision.node_id ? { nodeId: parsed.current_decision.node_id } : {}),
      ...(parsed.current_decision.gate ? { gate: parsed.current_decision.gate } : {})
    },
    recovery: {
      active: parsed.recovery.active,
      attempts: parsed.recovery.attempts,
      limit: parsed.recovery.limit,
      ...(parsed.recovery.last_error_code
        ? { lastErrorCode: parsed.recovery.last_error_code }
        : {})
    },
    ...(parsed.learning ? { learningStatus: parsed.learning.status } : {}),
    taskTreeReadOnly: true,
    legacyWorkflowPreserved: parsed.legacy_workflow_preserved,
    digest: parsed.digest
  };
  const serialized = JSON.stringify(overlay);
  if (/"subject_digest"\s*:|"decision_digest"\s*:|"approved_input_digest"\s*:/i.test(serialized)) {
    throw pcError("PC_SECRET_OR_PATH", "viewer missionTree overlay leaked Gate digests");
  }
  return overlay;
}

/**
 * Map public mission tree into a viewer-compatible workflow DTO shape.
 * Active-only consumer of this shape; legacy fixed 8-step path stays in createViewerWorkflow.
 * Uses camelCase `missionTree` (never `mission_tree`) for launcher/viewer payload exactness.
 */
export function missionTreeToViewerWorkflow(
  projection: MissionTreePublicProjectionV1,
  options: { name?: string; durationSeconds?: number; id?: string } = {}
): {
  id: string;
  name: string;
  description: string;
  status: string;
  duration: number;
  nodes: Array<Record<string, unknown>>;
  edges: Array<{ id: string; source: string; target: string }>;
  events: Array<Record<string, unknown>>;
  missionTree: ViewerMissionTreeOverlay;
} {
  const parsed = parseMissionTreePublicProjection(projection);
  if (parsed.mode !== "active") {
    throw pcError(
      "PC_SCHEMA_INVALID",
      "missionTreeToViewerWorkflow is active-mode only; legacy fixed workflow must stay unchanged"
    );
  }
  const duration = options.durationSeconds ?? Math.max(parsed.nodes.length * 10, 10);
  const statusMap: Record<PublicTaskStatus, string> = {
    proposed: "pending",
    blocked: "error",
    ready: "queued",
    running: "running",
    completed: "completed",
    failed_known: "error",
    outcome_unknown: "error",
    awaiting_human: "waiting_approval",
    stale: "pending"
  };

  const nodes = parsed.nodes.map((node, index) => ({
    id: node.node_id,
    name: node.kind ?? node.node_id,
    technicalName: node.node_id,
    type: node.node_type === "mission" ? "group" : node.status === "awaiting_human" ? "approval" : "task",
    agent: node.role,
    description: node.reason_code ?? node.status,
    status: statusMap[node.status],
    progress: node.status === "completed" ? 100 : node.status === "running" ? 50 : 0,
    startedAt: index * 10,
    position: { layer: node.parent_id ? 1 : 0, order: index },
    inputs: parsed.edges.filter((edge) => edge.target === node.node_id).map((edge) => edge.source),
    outputs: parsed.edges.filter((edge) => edge.source === node.node_id).map((edge) => edge.target),
    logs: [],
    details: {
      purpose: "Mission Tree（読み取り専用）",
      activity: node.status,
      outcome: node.reason_code ?? node.status,
      inputs: [],
      outputs: []
      // Explicitly omit approval — TaskTree is never a Gate subject.
    }
  }));

  return {
    id: options.id ?? `mission-tree-${parsed.production_id}`,
    name: options.name ?? `Mission ${parsed.production_id}`,
    description: `current decision: ${parsed.current_decision.summary}`,
    status:
      parsed.current_decision.kind === "awaiting_human"
        ? "waiting_approval"
        : parsed.current_decision.kind === "outcome_unknown" || parsed.current_decision.kind === "blocked"
          ? "error"
          : "running",
    duration,
    nodes,
    edges: parsed.edges,
    events: nodes.map((node) => ({
      time: node.startedAt,
      nodeId: node.id,
      status: node.status,
      progress: node.progress
    })),
    missionTree: toViewerMissionTreeOverlay(parsed)
  };
}
