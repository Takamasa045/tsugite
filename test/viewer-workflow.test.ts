import { describe, expect, it } from "vitest";
import type { ExecutionPlan } from "../src/orchestrator/plan.js";
import type { RunState } from "../src/orchestrator/state.js";
import type { Project } from "../src/project/schema.js";
import {
  createViewerWorkflow,
  type ViewerWorkflowData,
  type ViewerWorkflowStatus
} from "../src/viewer/workflow.js";

const project: Project = {
  slug: "viewer-fixture",
  run_id: "viewer-fixture-run",
  manifest: "manifest.yaml",
  dist_dir: "dist",
  edit: { backend: "remotion" },
  generation: {
    adapter: "mock-agent",
    requests: []
  }
};

const plan: ExecutionPlan = {
  run_id: "viewer-fixture-run",
  slug: "viewer-fixture",
  backend: "remotion",
  target_duration_seconds: 30,
  total_clip_duration_seconds: 30,
  estimated_credits: 0,
  clips: [],
  agent_handoffs: [],
  steps: [
    { name: "validate", status: "pending" },
    { name: "creative-review", status: "pending" },
    { name: "gate-1", status: "gate" },
    { name: "assemble-manifest", status: "pending" },
    { name: "gate-2", status: "gate" },
    { name: "render", status: "pending" },
    { name: "gate-3", status: "gate" }
  ]
};

function state(
  status: RunState["status"],
  gate1: RunState["gates"]["gate_1"]["status"] = "pending",
  gate2: RunState["gates"]["gate_2"]["status"] = "pending",
  gate3: RunState["gates"]["gate_3"]["status"] = "pending"
): RunState {
  return {
    run_id: plan.run_id,
    status,
    updated_at: "2026-07-13T10:00:00.000Z",
    gates: {
      gate_1: { status: gate1 },
      gate_2: { status: gate2 },
      gate_3: { status: gate3 }
    }
  };
}

function statusesAt(workflow: ViewerWorkflowData, time: number): Record<string, ViewerWorkflowStatus> {
  const statuses = Object.fromEntries(
    workflow.nodes.map((node) => [node.id, node.status])
  ) as Record<string, ViewerWorkflowStatus>;

  for (const event of workflow.events) {
    if (event.time <= time) statuses[event.nodeId] = event.status;
  }
  return statuses;
}

describe("createViewerWorkflow", () => {
  it("creates a deterministic planned snapshot with a serial graph", () => {
    const first = createViewerWorkflow(project, plan);
    const second = createViewerWorkflow(project, plan);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      id: "viewer-fixture-run",
      status: "pending"
    });
    expect(first.nodes.map((node) => node.id)).toEqual([
      "validate",
      "creative-review",
      "gate-1",
      "assemble-manifest",
      "gate-2",
      "render",
      "gate-3",
      "completed"
    ]);
    expect(first.nodes.map((node) => node.type)).toEqual([
      "task",
      "task",
      "approval",
      "agent",
      "approval",
      "agent",
      "approval",
      "output"
    ]);
    expect(first.nodes.map((node) => node.status)).toEqual([
      "completed",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending"
    ]);
    expect(first.edges).toEqual(
      first.nodes.slice(1).map((node, index) => ({
        id: `edge-${first.nodes[index]!.id}-${node.id}`,
        source: first.nodes[index]!.id,
        target: node.id
      }))
    );
    expect(first.nodes.every((node, index) => (
      node.progress >= 0 &&
      Array.isArray(node.logs) &&
      Array.isArray(node.inputs) &&
      Array.isArray(node.outputs) &&
      node.position.layer === index &&
      node.position.order === 0
    ))).toBe(true);
    expect(first.nodes[0]?.inputs).toEqual(["manifest.yaml"]);
    expect(first.nodes[1]?.inputs).toEqual(first.nodes[0]?.outputs);
    expect(first.nodes.map((node) => node.name)).toEqual([
      "制作準備を確認",
      "完成イメージを確認",
      "制作方針を確認・承認",
      "映像・音声素材を作る",
      "生成素材を確認・承認",
      "完成動画を作る",
      "完成動画を確認・承認",
      "制作完了"
    ]);
    expect(first.nodes.find((node) => node.id === "gate-2")?.technicalName)
      .toBe("Gate 2 素材・構成承認");
  });

  it("uses review evidence and run state to show the active gate", () => {
    const workflow = createViewerWorkflow(
      project,
      plan,
      state("awaiting_gate_2", "approved", "awaiting_approval"),
      { reviewPresent: true, gate2Qc: { ok: true } }
    );

    expect(workflow.status).toBe("waiting_approval");
    expect(workflow.nodes.map((node) => [node.id, node.status])).toEqual([
      ["validate", "completed"],
      ["creative-review", "completed"],
      ["gate-1", "completed"],
      ["assemble-manifest", "completed"],
      ["gate-2", "waiting_approval"],
      ["render", "pending"],
      ["gate-3", "pending"],
      ["completed", "pending"]
    ]);
  });

  it("adds the copied preview HTML link to review-related workflow items", () => {
    const workflow = createViewerWorkflow(
      project,
      plan,
      state("awaiting_gate_2", "approved", "awaiting_approval"),
      { reviewPresent: true, reviewHref: "./review/index.html", gate2Qc: { ok: true } }
    );

    const reviewOutput = workflow.nodes.find((node) => node.id === "creative-review")
      ?.details?.outputs.find((item) => item.reference === "review/index.html");
    const gate1Input = workflow.nodes.find((node) => node.id === "gate-1")
      ?.details?.inputs.find((item) => item.reference === "review/index.html");

    expect(reviewOutput).toMatchObject({ href: "./review/index.html" });
    expect(gate1Input).toMatchObject({ href: "./review/index.html" });
  });

  it("marks the current execution step as running", () => {
    const assembling = createViewerWorkflow(
      project,
      plan,
      state("running", "approved"),
      { reviewPresent: true }
    );
    const rendering = createViewerWorkflow(
      project,
      plan,
      state("rendering", "approved", "approved"),
      { reviewPresent: true, gate2Qc: { ok: true } }
    );

    expect(assembling.nodes.find((node) => node.id === "assemble-manifest")?.status).toBe("running");
    expect(rendering.nodes.find((node) => node.id === "render")?.status).toBe("running");
    expect(assembling.status).toBe("running");
    expect(rendering.status).toBe("running");
  });

  it("prioritizes failed QC and converts issues into error logs", () => {
    const workflow = createViewerWorkflow(
      project,
      plan,
      state("awaiting_gate_3", "approved", "approved", "awaiting_approval"),
      {
        reviewPresent: true,
        gate2Qc: { ok: true },
        gate3Qc: {
          ok: false,
          issues: [
            { code: "gate3.output.black_frame", message: "黒フレームを検出", path: "output.mp4" },
            { code: "gate3.output.long_silence", message: "長い無音を検出" }
          ]
        }
      }
    );
    const gate3 = workflow.nodes.find((node) => node.id === "gate-3");

    expect(workflow.status).toBe("error");
    expect(gate3).toMatchObject({ status: "error", progress: 0 });
    expect(gate3?.logs).toEqual([
      { time: gate3.startedAt, level: "error", message: "gate3.output.black_frame: 黒フレームを検出 (output.mp4)" },
      { time: gate3.startedAt, level: "error", message: "gate3.output.long_silence: 長い無音を検出" }
    ]);
  });

  it("attaches persisted run log facts to the manifest assembly node", () => {
    const workflow = createViewerWorkflow(
      project,
      plan,
      state("completed", "approved", "approved", "approved"),
      {
        reviewPresent: true,
        gate2Qc: { ok: true },
        gate3Qc: { ok: true },
        runLog: {
          runId: "viewer-fixture-run",
          mode: "generation",
          assetCount: 27,
          actualCredits: 1500,
          inputDigest: "a".repeat(64),
          generatedAt: "2026-07-12T05:27:55.418Z",
          requests: [
            { id: "mountain-omen", attempts: 1, credits: 125, clips: 1 },
            { id: "monk-pride", attempts: 2, credits: 250, clips: 1 }
          ]
        }
      }
    );
    const assembly = workflow.nodes.find((node) => node.id === "assemble-manifest");

    expect(assembly?.logs).toEqual([
      {
        time: assembly.startedAt,
        level: "success",
        message: "実行ログ: generation / 27素材 / 1,500 credits"
      },
      {
        time: assembly.startedAt,
        level: "info",
        message: "mountain-omen: 1回試行 / 125 credits / 1 clips"
      },
      {
        time: assembly.startedAt,
        level: "info",
        message: "monk-pride: 2回試行 / 250 credits / 1 clips"
      }
    ]);
  });

  it("exposes review, Gate decisions, and successful QC as inspectable work records", () => {
    const completedState: RunState = {
      ...state("completed", "approved", "approved", "approved"),
      gates: {
        gate_1: { status: "approved", updated_at: "2026-07-13T09:01:00.000Z" },
        gate_2: { status: "approved", updated_at: "2026-07-13T09:02:00.000Z" },
        gate_3: { status: "approved", updated_at: "2026-07-13T09:03:00.000Z" }
      }
    };
    const workflow = createViewerWorkflow(project, plan, completedState, {
      reviewPresent: true,
      gate2Qc: { ok: true },
      gate3Qc: { ok: true }
    });

    expect(workflow.nodes.find((node) => node.id === "creative-review")?.logs).toEqual([{
      time: 10,
      level: "success",
      message: "クリエイティブレビュー証跡を確認"
    }]);
    expect(workflow.nodes.find((node) => node.id === "gate-1")?.logs).toEqual([{
      time: 20,
      level: "success",
      message: "Gate 1を承認 · 2026-07-13T09:01:00.000Z"
    }]);
    expect(workflow.nodes.find((node) => node.id === "gate-2")?.logs).toEqual([
      { time: 40, level: "success", message: "Gate 2を承認 · 2026-07-13T09:02:00.000Z" },
      { time: 40, level: "success", message: "Gate 2 QCを通過" }
    ]);
    expect(workflow.nodes.find((node) => node.id === "gate-3")?.logs).toEqual([
      { time: 60, level: "success", message: "Gate 3を承認 · 2026-07-13T09:03:00.000Z" },
      { time: 60, level: "success", message: "Gate 3 QCを通過" }
    ]);
  });

  it("explains concrete inputs, outcomes, and approval decisions in human-readable Japanese", () => {
    const detailedProject: Project = {
      ...project,
      generation: {
        adapter: "kling",
        requests: [
          {
            id: "opening",
            prompt: "opening shot",
            model: "kling-3.0-pro",
            duration: 5,
            aspect: "16:9",
            input_mode: "image-to-video",
            params: {}
          },
          {
            id: "ending",
            prompt: "ending shot",
            model: "kling-3.0-pro",
            duration: 5,
            aspect: "16:9",
            input_mode: "image-to-video",
            params: {}
          }
        ]
      }
    };
    const detailedPlan: ExecutionPlan = {
      ...plan,
      target_duration_seconds: 60,
      total_clip_duration_seconds: 60.333,
      estimated_credits: 375,
      clips: [
        { id: "opening", duration: 5, src: "opening.mp4" },
        { id: "ending", duration: 5, src: "ending.mp4" }
      ]
    };
    const completedState: RunState = {
      ...state("completed", "approved", "approved", "approved"),
      gates: {
        gate_1: { status: "approved", updated_at: "2026-07-13T09:01:00.000Z" },
        gate_2: { status: "approved", updated_at: "2026-07-13T09:02:00.000Z" },
        gate_3: { status: "approved", updated_at: "2026-07-13T09:03:00.000Z" }
      }
    };
    const workflow = createViewerWorkflow(detailedProject, detailedPlan, completedState, {
      reviewPresent: true,
      gate2Qc: {
        ok: true,
        targetDurationSeconds: 60,
        totalClipDurationSeconds: 60.333,
        durationDeltaSeconds: 0.333,
        assetCount: 27,
        assetKinds: { clip: 8, image: 10, audio: 9 }
      },
      gate3Qc: {
        ok: true,
        outputPath: "dist/viewer-fixture-run/final.mp4",
        expected: { durationSeconds: 60, width: 1280, height: 720, fps: 30, audioRequired: true },
        actual: { durationSeconds: 60.395, width: 1280, height: 720, fps: 30, hasAudio: true },
        content: { longestBlackSeconds: 0, longestSilenceSeconds: 0.387 }
      },
      runLog: {
        runId: "viewer-fixture-run",
        mode: "generation",
        assetCount: 27,
        actualCredits: 375,
        inputDigest: "a".repeat(64),
        requests: [
          { id: "opening", attempts: 1, credits: 125, clips: 1 },
          { id: "ending", attempts: 1, credits: 250, clips: 1 }
        ]
      },
      previews: [
        {
          id: "generated-video-01",
          role: "material",
          kind: "video",
          label: "生成した映像 1",
          description: "完成動画に使った映像素材です。",
          src: "./previews/generated-video-01.mp4"
        },
        {
          id: "generated-image-01",
          role: "material",
          kind: "image",
          label: "生成した画像 1",
          description: "映像制作に使った画像素材です。",
          src: "./previews/generated-image-01.jpg"
        },
        {
          id: "final-video",
          role: "final",
          kind: "video",
          label: "完成動画",
          description: "確認・承認を終えた完成版です。",
          src: "./previews/final-video.mp4"
        }
      ]
    });

    expect(workflow.nodes.find((node) => node.id === "validate")?.details?.inputs[0]).toMatchObject({
      label: "制作設計書",
      description: expect.stringContaining("映像の尺")
    });
    expect(workflow.nodes.find((node) => node.id === "gate-1")?.details?.approval).toMatchObject({
      subject: "Klingで2本の映像素材を生成する制作方針と、外部サービス実行によるクレジット消費",
      decision: "制作方針を承認し、Klingによる素材生成を開始できる状態にしました。"
    });
    expect(workflow.nodes.find((node) => node.id === "assemble-manifest")?.details?.outputs[0]?.facts)
      .toEqual(expect.arrayContaining(["素材数: 27点", "生成リクエスト: 2件", "実績クレジット: 375"]));
    expect(workflow.nodes.find((node) => node.id === "gate-2")?.details?.approval).toMatchObject({
      subject: "生成済み27点の素材と60.333秒の構成を、Remotionの最終編集へ渡すこと",
      checkpoints: expect.arrayContaining([
        "内訳: 映像8本・画像10枚・音声9本",
        "構成尺60.333秒は、目標60秒との差が0.333秒で許容範囲内"
      ])
    });
    expect(workflow.nodes.find((node) => node.id === "render")?.details?.outputs[0]?.facts)
      .toEqual(expect.arrayContaining(["再生時間: 60.395秒", "画面: 1280×720 / 30fps", "音声: あり"]));
    expect(workflow.nodes.find((node) => node.id === "gate-3")?.details?.approval).toMatchObject({
      subject: "final.mp4を納品可能な最終成果物として採用すること",
      checkpoints: expect.arrayContaining([
        "黒画面の最長: 0秒",
        "無音の最長: 0.387秒"
      ]),
      decision: "最終動画を承認し、納品可能な完成品として採用しました。"
    });
    expect(workflow.nodes.find((node) => node.id === "assemble-manifest")?.details?.previews)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "generated-video-01" }),
        expect.objectContaining({ id: "generated-image-01" })
      ]));
    expect(workflow.nodes.find((node) => node.id === "gate-2")?.details?.previews)
      .toHaveLength(2);
    expect(workflow.nodes.find((node) => node.id === "render")?.details?.previews)
      .toEqual([expect.objectContaining({ id: "final-video" })]);
    expect(workflow.nodes.find((node) => node.id === "completed")?.details?.previews)
      .toEqual([expect.objectContaining({ id: "final-video" })]);
  });

  it("reconstructs the snapshot from ordered relative events after rewinding", () => {
    const workflow = createViewerWorkflow(
      project,
      plan,
      state("completed", "approved", "approved", "approved"),
      {
        reviewPresent: true,
        gate2Qc: { ok: true },
        gate3Qc: { ok: true }
      }
    );
    const eventTimes = workflow.events.map((event) => event.time);
    const finalStatuses = Object.fromEntries(
      workflow.nodes.map((node) => [node.id, node.status])
    );

    expect(workflow.status).toBe("completed");
    expect(workflow.nodes.every((node) => node.status === "completed" && node.progress === 100)).toBe(true);
    expect(eventTimes).toEqual([...eventTimes].sort((left, right) => left - right));
    expect(eventTimes.every((time) => time >= 0 && time <= workflow.duration)).toBe(true);
    expect(statusesAt(workflow, 0)).toEqual({
      validate: "completed",
      "creative-review": "pending",
      "gate-1": "pending",
      "assemble-manifest": "pending",
      "gate-2": "pending",
      render: "pending",
      "gate-3": "pending",
      completed: "pending"
    });
    expect(statusesAt(workflow, workflow.duration)).toEqual(finalStatuses);
  });

  it("treats an aborted gate as an error and keeps later work pending", () => {
    const workflow = createViewerWorkflow(
      project,
      plan,
      state("aborted", "approved", "abort"),
      { reviewPresent: true, gate2Qc: { ok: true } }
    );

    expect(workflow.status).toBe("error");
    expect(workflow.nodes.find((node) => node.id === "gate-2")?.status).toBe("error");
    expect(workflow.nodes.find((node) => node.id === "render")?.status).toBe("pending");
    expect(workflow.nodes.find((node) => node.id === "completed")?.status).toBe("error");
  });
});
