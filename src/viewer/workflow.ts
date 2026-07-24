import type { ExecutionPlan, PlanStep } from "../orchestrator/plan.js";
import type { GateId, GateStatus, RunState } from "../orchestrator/state.js";
import type { Project } from "../project/schema.js";
import type { Issue } from "../types.js";
import {
  createViewerNodeDetails,
  type ViewerWorkflowNodeDetails
} from "./workflowDetails.js";

export type ViewerWorkflowStatus =
  | "pending"
  | "queued"
  | "thinking"
  | "running"
  | "waiting_approval"
  | "testing"
  | "completed"
  | "error"
  | "skipped";

export type ViewerWorkflowNodeType = "task" | "agent" | "approval" | "output" | "group";
export type ViewerWorkflowLogLevel = "info" | "success" | "warning" | "error";

export type ViewerWorkflowLog = {
  time: number;
  level: ViewerWorkflowLogLevel;
  message: string;
};

export type ViewerMediaPreview = {
  id: string;
  role: "material" | "final";
  kind: "image" | "video" | "audio";
  label: string;
  description: string;
  src: string;
};

export type ViewerWorkflowNode = {
  id: string;
  name: string;
  technicalName?: string;
  type: ViewerWorkflowNodeType;
  agent?: string;
  description?: string;
  status: ViewerWorkflowStatus;
  progress: number;
  startedAt: number;
  completedAt?: number;
  position: {
    layer: number;
    order: number;
  };
  inputs: string[];
  outputs: string[];
  details?: ViewerWorkflowNodeDetails;
  logs: ViewerWorkflowLog[];
};

export type ViewerWorkflowEdge = {
  id: string;
  source: string;
  target: string;
};

export type ViewerWorkflowEvent = {
  time: number;
  nodeId: string;
  status: ViewerWorkflowStatus;
  progress?: number;
  message?: string;
};

export type ViewerWorkflowData = {
  id: string;
  name: string;
  description?: string;
  status: ViewerWorkflowStatus;
  startedAt?: string;
  duration: number;
  nodes: ViewerWorkflowNode[];
  edges: ViewerWorkflowEdge[];
  events: ViewerWorkflowEvent[];
};

export type ViewerArtifactSnapshot = {
  reviewPresent?: boolean;
  reviewHref?: string;
  gate2Qc?: ViewerGate2QcEvidence;
  gate3Qc?: ViewerGate3QcEvidence;
  runLog?: ViewerRunLogEvidence;
  previews?: ViewerMediaPreview[];
};

export type ViewerGate2QcEvidence = {
  ok: boolean;
  issues?: Issue[];
  targetDurationSeconds?: number;
  totalClipDurationSeconds?: number;
  durationDeltaSeconds?: number;
  assetCount?: number;
  assetKinds?: { clip: number; image: number; audio: number };
};

export type ViewerGate3QcEvidence = {
  ok: boolean;
  issues?: Issue[];
  outputPath?: string;
  expected?: {
    durationSeconds: number;
    width: number;
    height: number;
    fps: number;
    audioRequired: boolean;
  };
  actual?: {
    durationSeconds?: number;
    width?: number;
    height?: number;
    fps?: number;
    hasAudio?: boolean;
  };
  content?: {
    longestBlackSeconds?: number;
    longestSilenceSeconds?: number;
  };
};

export type ViewerRunLogEvidence = {
  runId: string;
  mode: string;
  assetCount: number;
  actualCredits: number;
  inputDigest: string;
  generatedAt?: string;
  requests: Array<{
    id: string;
    attempts: number;
    credits: number;
    clips: number;
  }>;
};

const STEP_SECONDS = 10;
const COMPLETE_OFFSET_SECONDS = 8;

const STEP_LABELS: Record<string, string> = {
  validate: "制作準備を確認",
  "analysis-handoff": "調査結果を制作へ渡す",
  "creative-review": "完成イメージを確認",
  "gate-1": "制作方針を確認・承認",
  "assemble-manifest": "映像・音声素材を作る",
  "gate-2": "生成素材を確認・承認",
  render: "完成動画を作る",
  "gate-3": "完成動画を確認・承認",
  completed: "制作完了"
};

const TECHNICAL_STEP_LABELS: Record<string, string> = {
  validate: "プロジェクト検証",
  "analysis-handoff": "分析エージェントへ引き渡し",
  "creative-review": "クリエイティブレビュー",
  "gate-1": "Gate 1 制作方針承認",
  "assemble-manifest": "制作マニフェスト統合",
  "gate-2": "Gate 2 素材・構成承認",
  render: "最終レンダリング",
  "gate-3": "Gate 3 最終品承認",
  completed: "ワークフロー完了"
};

/** Converts the persisted Tsugite plan/state artifacts into a deterministic Viewer snapshot. */
export function createViewerWorkflow(
  project: Project,
  plan: ExecutionPlan,
  state?: RunState,
  artifacts: ViewerArtifactSnapshot = {}
): ViewerWorkflowData {
  const steps = [...plan.steps, { name: "completed", status: "pending" as const }];
  const statuses = steps.map((step, index) =>
    resolveNodeStatus(step, index, steps, state, artifacts)
  );
  const nodes = steps.map((step, index) =>
    createNode(project, plan, step, index, statuses[index]!, state, artifacts)
  );
  const duration = nodes.length * STEP_SECONDS;

  return {
    id: plan.run_id,
    name: `${project.slug} 制作フロー`,
    description: `${project.slug}の制作準備から完成確認までを、順番にたどれる記録です。`,
    status: resolveWorkflowStatus(nodes),
    duration,
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      id: `edge-${nodes[index]!.id}-${node.id}`,
      source: nodes[index]!.id,
      target: node.id
    })),
    events: createTimelineEvents(nodes)
  };
}

function resolveNodeStatus(
  step: PlanStep,
  index: number,
  steps: PlanStep[],
  state: RunState | undefined,
  artifacts: ViewerArtifactSnapshot
): ViewerWorkflowStatus {
  if (step.name === "validate") return "completed";
  if (step.name === "completed") {
    if (state?.status === "completed") return "completed";
    if (state?.status === "aborted") return "error";
    return "pending";
  }

  const failedQc = qcForStep(step.name, artifacts);
  if (failedQc?.ok === false) return "error";

  const gateId = gateIdForStep(step.name);
  if (gateId && state) return viewerGateStatus(state.gates[gateId].status);

  if (!state) {
    return step.name === "creative-review" && artifacts.reviewPresent ? "completed" : "pending";
  }

  if (state.status === "completed") return "completed";
  if (state.status === "aborted") return statusForAbortedRun(index, steps, state);

  const awaitingGate = awaitingGateForRunStatus(state.status);
  if (awaitingGate) {
    const gateIndex = steps.findIndex((candidate) => gateIdForStep(candidate.name) === awaitingGate);
    return index < gateIndex ? "completed" : "pending";
  }

  if (state.status === "running") {
    return statusWithinActiveRange(step.name, index, steps, "gate-1", "gate-2");
  }

  if (state.status === "rendering") {
    const renderIndex = steps.findIndex((candidate) => candidate.name === "render");
    if (index < renderIndex) return "completed";
    if (index === renderIndex) return "running";
    return "pending";
  }

  if (step.name === "creative-review" && artifacts.reviewPresent) return "completed";
  return "pending";
}

function statusWithinActiveRange(
  stepName: string,
  index: number,
  steps: PlanStep[],
  previousGateName: string,
  nextGateName: string
): ViewerWorkflowStatus {
  const previousGateIndex = steps.findIndex((step) => step.name === previousGateName);
  const nextGateIndex = steps.findIndex((step) => step.name === nextGateName);
  if (index <= previousGateIndex) return "completed";
  if (index > previousGateIndex && (nextGateIndex < 0 || index < nextGateIndex)) {
    return stepName === "assemble-manifest" || stepName.includes("handoff") ? "running" : "pending";
  }
  return "pending";
}

function statusForAbortedRun(index: number, steps: PlanStep[], state: RunState): ViewerWorkflowStatus {
  const abortedGate = (Object.entries(state.gates) as Array<[GateId, { status: GateStatus }]>).find(
    ([, gate]) => gate.status === "abort" || gate.status === "revise"
  );
  if (!abortedGate) return "pending";

  const abortedIndex = steps.findIndex((step) => gateIdForStep(step.name) === abortedGate[0]);
  if (index < abortedIndex) return "completed";
  if (index === abortedIndex) return "error";
  return "pending";
}

function createNode(
  project: Project,
  plan: ExecutionPlan,
  step: PlanStep,
  index: number,
  status: ViewerWorkflowStatus,
  state: RunState | undefined,
  artifacts: ViewerArtifactSnapshot
): ViewerWorkflowNode {
  const startedAt = index * STEP_SECONDS;
  const outputs = [step.name === "completed" ? `${project.slug}.output` : `${step.name}.result`];
  const previousOutput = index === 0
    ? project.manifest
    : `${plan.steps[index - 1]?.name ?? "gate-3"}.result`;
  const agent = agentForStep(step.name, project, plan);
  const details = createViewerNodeDetails({ project, plan, stepName: step.name, status, state, artifacts });
  const previews = previewsForStep(step.name, artifacts.previews ?? []);
  const technicalName = TECHNICAL_STEP_LABELS[step.name];

  return {
    id: step.name,
    name: STEP_LABELS[step.name] ?? step.name,
    ...(technicalName ? { technicalName } : {}),
    type: nodeTypeForStep(step),
    ...(agent ? { agent } : {}),
    description: descriptionForStep(step.name, plan),
    status,
    progress: progressForStatus(status),
    startedAt,
    ...(status === "completed"
      ? { completedAt: step.name === "validate" ? 0 : startedAt + COMPLETE_OFFSET_SECONDS }
      : {}),
    position: { layer: index, order: 0 },
    inputs: [previousOutput],
    outputs,
    details: previews.length > 0 ? { ...details, previews } : details,
    logs: logsForStep(step.name, startedAt, state, artifacts)
  };
}

function previewsForStep(
  stepName: string,
  previews: ViewerMediaPreview[]
): ViewerMediaPreview[] {
  if (stepName === "assemble-manifest" || stepName === "gate-2") {
    return previews.filter((preview) => preview.role === "material");
  }
  if (stepName === "render" || stepName === "gate-3" || stepName === "completed") {
    return previews.filter((preview) => preview.role === "final");
  }
  return [];
}

function nodeTypeForStep(step: PlanStep): ViewerWorkflowNodeType {
  if (step.name === "completed") return "output";
  if (step.status === "gate" || gateIdForStep(step.name)) return "approval";
  if (step.name.includes("handoff") || step.name.includes("assemble") || step.name === "render") {
    return "agent";
  }
  return "task";
}

function agentForStep(stepName: string, project: Project, plan: ExecutionPlan): string | undefined {
  if (stepName === "render") return plan.backend;
  if (stepName === "assemble-manifest") return project.generation?.adapter ?? "tsugite";
  if (stepName.includes("analysis-handoff")) {
    return plan.agent_handoffs.find((handoff) => handoff.phase === "analysis")?.adapter;
  }
  if (stepName.includes("handoff")) {
    return plan.agent_handoffs.find((handoff) => handoff.phase === "generation")?.adapter;
  }
  return undefined;
}

function descriptionForStep(stepName: string, plan: ExecutionPlan): string {
  if (stepName === "validate") return "project.yaml とマニフェストの整合性を検証";
  if (stepName === "creative-review") return "制作方針を HTML レビュー証跡として確認";
  if (stepName.startsWith("gate-")) return "人間の承認による副作用境界";
  if (stepName === "render") return `${plan.backend} で最終成果物を書き出し`;
  if (stepName === "completed") return "すべての Gate と QC を通過した完了状態";
  return `${stepName} 工程を実行`;
}

function logsForStep(
  stepName: string,
  time: number,
  state: RunState | undefined,
  artifacts: ViewerArtifactSnapshot
): ViewerWorkflowLog[] {
  const reviewLogs: ViewerWorkflowLog[] = stepName === "creative-review" && artifacts.reviewPresent
    ? [{ time, level: "success", message: "クリエイティブレビュー証跡を確認" }]
    : [];
  const gateLogs = viewerLogsFromGateState(stepName, time, state);
  const runLogs = stepName === "assemble-manifest"
    ? viewerLogsFromRunLog(time, artifacts.runLog)
    : [];
  const qc = qcForStep(stepName, artifacts);
  if (qc?.ok === true) {
    return [
      ...reviewLogs,
      ...gateLogs,
      ...runLogs,
      { time, level: "success", message: `${gateLabel(stepName)} QCを通過` }
    ];
  }
  if (qc?.ok !== false) return [...reviewLogs, ...gateLogs, ...runLogs];
  const qcLogs = (qc.issues ?? []).map((issue) => ({
    time,
    level: "error" as const,
    message: `${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ""}`
  }));
  return [...reviewLogs, ...gateLogs, ...runLogs, ...qcLogs];
}

function viewerLogsFromGateState(
  stepName: string,
  time: number,
  state: RunState | undefined
): ViewerWorkflowLog[] {
  const gateId = gateIdForStep(stepName);
  if (!gateId || !state) return [];
  const gate = state.gates[gateId];
  if (!gate.updated_at || gate.status === "pending") return [];
  const label = gateLabel(stepName);
  if (gate.status === "approved") {
    if (gate.decision_source === "auto_qc") {
      return [{
        time,
        level: "success",
        message: `${label} 自動通過（QC通過・新規生成なし・クレジット0） · ${gate.updated_at}`
      }];
    }
    return [{ time, level: "success", message: `${label}を承認 · ${gate.updated_at}` }];
  }
  if (gate.status === "awaiting_approval") {
    return [{ time, level: "info", message: `${label}の承認待ち · ${gate.updated_at}` }];
  }
  return [{
    time,
    level: "error",
    message: `${label}で${gate.status === "revise" ? "修正" : "中止"}判断 · ${gate.updated_at}`
  }];
}

function gateLabel(stepName: string): string {
  if (stepName === "gate-1") return "Gate 1";
  if (stepName === "gate-2") return "Gate 2";
  return "Gate 3";
}

function viewerLogsFromRunLog(
  time: number,
  runLog: ViewerRunLogEvidence | undefined
): ViewerWorkflowLog[] {
  if (!runLog) return [];
  const numberFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
  const summary: ViewerWorkflowLog = {
    time,
    level: "success",
    message: `実行ログ: ${runLog.mode} / ${runLog.assetCount}素材 / ${numberFormatter.format(runLog.actualCredits)} credits`
  };
  const requestLogs = runLog.requests.map((request) => ({
    time,
    level: "info" as const,
    message: `${request.id}: ${request.attempts}回試行 / ${numberFormatter.format(request.credits)} credits / ${request.clips} clips`
  }));
  return [summary, ...requestLogs];
}

function qcForStep(
  stepName: string,
  artifacts: ViewerArtifactSnapshot
): ViewerArtifactSnapshot["gate2Qc"] | ViewerArtifactSnapshot["gate3Qc"] | undefined {
  if (stepName === "gate-2") return artifacts.gate2Qc;
  if (stepName === "gate-3") return artifacts.gate3Qc;
  return undefined;
}

function gateIdForStep(stepName: string): GateId | undefined {
  if (stepName === "gate-1") return "gate_1";
  if (stepName === "gate-2") return "gate_2";
  if (stepName === "gate-3") return "gate_3";
  return undefined;
}

function viewerGateStatus(status: GateStatus): ViewerWorkflowStatus {
  if (status === "approved") return "completed";
  if (status === "awaiting_approval") return "waiting_approval";
  if (status === "abort" || status === "revise") return "error";
  return "pending";
}

function awaitingGateForRunStatus(status: RunState["status"]): GateId | undefined {
  if (status === "awaiting_gate_1") return "gate_1";
  if (status === "awaiting_gate_2") return "gate_2";
  if (status === "awaiting_gate_3") return "gate_3";
  return undefined;
}

function progressForStatus(status: ViewerWorkflowStatus): number {
  if (status === "completed") return 100;
  if (status === "running" || status === "waiting_approval" || status === "testing") return 50;
  return 0;
}

function resolveWorkflowStatus(nodes: ViewerWorkflowNode[]): ViewerWorkflowStatus {
  if (nodes.some((node) => node.status === "error")) return "error";
  if (nodes.every((node) => node.status === "completed")) return "completed";
  if (nodes.some((node) => node.status === "waiting_approval")) return "waiting_approval";
  if (nodes.some((node) => node.status === "running" || node.status === "testing")) return "running";
  return "pending";
}

function createTimelineEvents(nodes: ViewerWorkflowNode[]): ViewerWorkflowEvent[] {
  const resetEvents: ViewerWorkflowEvent[] = nodes.map((node) => ({
    time: 0,
    nodeId: node.id,
    status: "pending",
    progress: 0
  }));
  const snapshotEvents = nodes.flatMap((node) => eventsForNode(node));

  return [...resetEvents, ...snapshotEvents]
    .map((event, index) => ({ event, index }))
    .sort((left, right) => left.event.time - right.event.time || left.index - right.index)
    .map(({ event }) => event);
}

function eventsForNode(node: ViewerWorkflowNode): ViewerWorkflowEvent[] {
  if (node.status === "pending") return [];
  if (node.id === "validate") {
    return [{ time: 0, nodeId: node.id, status: "completed", progress: 100 }];
  }
  if (node.status === "completed") {
    const activeStatus = node.type === "approval" ? "waiting_approval" : "running";
    return [
      { time: node.startedAt, nodeId: node.id, status: activeStatus, progress: 50 },
      {
        time: node.completedAt ?? node.startedAt + COMPLETE_OFFSET_SECONDS,
        nodeId: node.id,
        status: "completed",
        progress: 100
      }
    ];
  }

  return [{
    time: node.startedAt,
    nodeId: node.id,
    status: node.status,
    progress: node.progress,
    ...(node.logs[0] ? { message: node.logs[0].message } : {})
  }];
}
