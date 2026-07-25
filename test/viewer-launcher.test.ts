import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Manifest } from "../src/manifest/schema.js";
import { createPlan } from "../src/orchestrator/plan.js";
import { inspectGate1Review, writeCreativeReview } from "../src/orchestrator/review.js";
import {
  acquireRunLock,
  createPlannedState,
  markGateAwaiting,
  recordGateDecision,
  RUN_LOCK_INHERIT_ENV,
  writeState
} from "../src/orchestrator/state.js";
import type { Project } from "../src/project/schema.js";
import { validateProject } from "../src/project/validateProject.js";
import {
  launcherPipelineArgs,
  startWorkflowViewerLauncher,
  type LauncherAction,
  type LauncherJob,
  type WorkflowViewerLauncher
} from "../src/viewer/launcher.js";
import {
  WORKFLOW_VIEWER_DOCUMENT_BYTE_LIMIT,
  writeWorkflowViewer
} from "../src/viewer/artifact.js";

const launchers: WorkflowViewerLauncher[] = [];

afterEach(async () => {
  await Promise.all(launchers.splice(0).map((launcher) => launcher.close()));
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "tsugite-viewer-launcher-"));
  const projectsDir = join(root, "projects");
  const templatesDir = join(root, "templates");
  const projectDir = join(projectsDir, "valid-project");
  const bundleDir = join(root, "bundle");
  await mkdir(projectsDir, { recursive: true });
  await mkdir(templatesDir, { recursive: true });
  await cp(join(process.cwd(), "examples", "local-fixture"), projectDir, { recursive: true });
  await mkdir(join(bundleDir, "assets"), { recursive: true });
  await writeFile(
    join(bundleDir, "index.html"),
    '<!doctype html><html><head><title>Viewer</title><link rel="stylesheet" href="./assets/app.css"></head><body><div id="root"></div><script type="module" src="./assets/app.js"></script></body></html>\n'
  );
  await writeFile(join(bundleDir, "assets", "app.css"), "body { color: black; }\n");
  await writeFile(join(bundleDir, "assets", "app.js"), "globalThis.viewerLoaded = true;\n");
  await writeFile(join(bundleDir, "assets", "terminal.mjs"), "export const terminalLoaded = true;\n");
  return { root, projectsDir, templatesDir, projectDir, bundleDir };
}

async function writeApprovedGate1State(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  updatedAt = "2026-07-19T02:00:00.000Z"
): Promise<void> {
  const configPath = join(fixture.projectDir, "project.yaml");
  const validation = await validateProject(configPath);
  if (!validation.project || !validation.manifest) throw new Error("fixture project is invalid");
  await writeCreativeReview({
    configPath,
    project: validation.project,
    manifest: validation.manifest,
    plan: createPlan(validation.project, validation.manifest)
  });
  const review = await inspectGate1Review({
    configPath,
    project: validation.project,
    manifest: validation.manifest
  });
  if (!review.ok || !review.approvalDigest) throw new Error("fixture review is invalid");
  await writeState(join(fixture.projectDir, "dist"), {
    run_id: "local-fixture-run",
    status: "running",
    updated_at: updatedAt,
    gates: {
      gate_1: { status: "approved", updated_at: updatedAt, approved_input_digest: review.approvalDigest },
      gate_2: { status: "pending" },
      gate_3: { status: "pending" }
    }
  });
}

async function launch(options: Parameters<typeof startWorkflowViewerLauncher>[0]) {
  const launcher = await startWorkflowViewerLauncher(options);
  launchers.push(launcher);
  return launcher;
}

async function statusWithHost(url: string, host: string): Promise<number> {
  const target = new URL(url);
  return await new Promise<number>((resolveStatus, reject) => {
    const request = get({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: { host }
    }, (response) => {
      response.resume();
      response.once("end", () => resolveStatus(response.statusCode ?? 0));
    });
    request.once("error", reject);
  });
}

function expectedViewerUrl(launcher: WorkflowViewerLauncher, projectId: string): string {
  const viewerUrl = new URL(`/viewer/${projectId}/`, launcher.artifactUrl);
  viewerUrl.searchParams.set("launcher", launcher.url);
  return viewerUrl.toString();
}

function expectedGate1ReviewUrl(launcher: WorkflowViewerLauncher, projectId: string): string {
  return new URL(`/viewer/${projectId}/review/index.html`, launcher.artifactUrl).toString();
}

function expectedGate2ReviewUrl(launcher: WorkflowViewerLauncher, projectId: string): string {
  const viewerUrl = new URL(expectedViewerUrl(launcher, projectId));
  viewerUrl.searchParams.set("node", "gate-2");
  return viewerUrl.toString();
}

describe("workflow viewer launcher", () => {
  it("maps every allowlisted action to a fixed pipeline argv array", () => {
    const config = "/safe/project.yaml";
    const actions: LauncherAction[] = [
      "validate",
      "plan",
      "review",
      "dry-run",
      "run",
      "render",
      "gate-1-approve",
      "gate-1-revise",
      "gate-1-abort",
      "gate-2-approve-all",
      "gate-2-revise",
      "gate-2-abort",
      "gate-3-approve",
      "gate-3-re-render",
      "gate-3-abort"
    ];
    expect(Object.fromEntries(actions.map((action) => [action, launcherPipelineArgs(config, action)]))).toEqual({
      validate: ["validate", "--config", config, "--json"],
      plan: ["plan", "--config", config, "--json"],
      review: ["review", "--config", config, "--json"],
      "dry-run": ["run", "--config", config, "--dry-run", "--json"],
      run: ["run", "--config", config, "--actor", "coordinator", "--json"],
      render: ["render", "--config", config, "--actor", "coordinator", "--json"],
      "gate-1-approve": ["gate", "--config", config, "--actor", "coordinator", "--gate", "gate-1", "--decision", "approve", "--json"],
      "gate-1-revise": ["gate", "--config", config, "--actor", "coordinator", "--gate", "gate-1", "--decision", "revise", "--json"],
      "gate-1-abort": ["gate", "--config", config, "--actor", "coordinator", "--gate", "gate-1", "--decision", "abort", "--json"],
      "gate-2-approve-all": ["gate", "--config", config, "--actor", "coordinator", "--gate", "gate-2", "--decision", "approve_all", "--json"],
      "gate-2-revise": ["gate", "--config", config, "--actor", "coordinator", "--gate", "gate-2", "--decision", "revise", "--json"],
      "gate-2-abort": ["gate", "--config", config, "--actor", "coordinator", "--gate", "gate-2", "--decision", "abort", "--json"],
      "gate-3-approve": ["gate", "--config", config, "--actor", "coordinator", "--gate", "gate-3", "--decision", "approve", "--json"],
      "gate-3-re-render": ["gate", "--config", config, "--actor", "coordinator", "--gate", "gate-3", "--decision", "re-render", "--json"],
      "gate-3-abort": ["gate", "--config", config, "--actor", "coordinator", "--gate", "gate-3", "--decision", "abort", "--json"]
    });
  });

  it("serves an empty read-only feedback aggregate when projects have no feedback", async () => {
    const fixture = await createFixture();
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });

    const response = await fetch(`${launcher.url}/api/feedback`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      feedback: {
        metrics: { observed: 0, recurring: 0, promoted: 0, verified: 0, issues: 0 },
        preferences: [],
        issues: []
      }
    });
    expect((await fetch(`${launcher.url}/api/feedback`, { method: "POST" })).status).toBe(404);
  });

  it("aggregates recurring project feedback and reports invalid lines without hiding valid records", async () => {
    const fixture = await createFixture();
    const secondProjectDir = join(fixture.projectsDir, "second-project");
    await cp(fixture.projectDir, secondProjectDir, { recursive: true });
    const secondConfigPath = join(secondProjectDir, "project.yaml");
    const secondConfig = await readFile(secondConfigPath, "utf8");
    await writeFile(
      secondConfigPath,
      secondConfig
        .replace("slug: local-fixture", "slug: second-project")
        .replace("run_id: local-fixture-run", "run_id: second-project-run")
    );
    await writeFile(join(fixture.projectDir, "feedback.jsonl"), [
      JSON.stringify({
        schema_version: 1,
        id: "11111111-1111-4111-8111-111111111111",
        created_at: "2026-07-16T10:00:00.000Z",
        key: "opening-audio",
        category: "sound",
        signal: "prefer",
        stage: "promoted",
        summary: "Start the soundtrack at frame zero",
        run_id: "local-fixture-run",
        evidence: ["dist/local-fixture-run/gate3-qc.json"],
        promotion: { kind: "qa", target: "src/orchestrator/gate3Qc.ts" }
      }),
      "{not-valid-json",
      ""
    ].join("\n"));
    await writeFile(join(secondProjectDir, "feedback.jsonl"), `${JSON.stringify({
      schema_version: 1,
      id: "22222222-2222-4222-8222-222222222222",
      created_at: "2026-07-17T10:00:00.000Z",
      key: "opening-audio",
      category: "sound",
      signal: "prefer",
      stage: "verified",
      summary: "Opening audio was confirmed in the final output",
      run_id: "second-project-run",
      evidence: ["dist/second-project-run/gate3-qc.json"]
    })}\n`);

    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });
    const response = await fetch(`${launcher.url}/api/feedback`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      feedback: {
        metrics: { observed: 1, recurring: 1, promoted: 1, verified: 1, issues: 1 },
        preferences: [{
          key: "opening-audio",
          category: "sound",
          signal: "prefer",
          stage: "verified",
          projectCount: 2,
          projectNames: ["second-project", "valid-project"],
          runIds: ["local-fixture-run", "second-project-run"],
          promotion: {
            kind: "qa",
            target: "src/orchestrator/gate3Qc.ts",
            promotedAt: "2026-07-16T10:00:00.000Z"
          },
          lastSeenAt: "2026-07-17T10:00:00.000Z"
        }],
        issues: [expect.objectContaining({
          code: "feedback.invalid_json",
          projectName: "valid-project",
          path: "feedback.jsonl"
        })]
      }
    });
    expect(JSON.stringify(payload)).not.toContain(fixture.root);
  });

  it("records an authorized human decision for a pending promotion proposal", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.projectDir, "feedback.jsonl"), `${JSON.stringify({
      schema_version: 1,
      id: "proposal-record",
      created_at: "2026-07-17T10:00:00.000Z",
      key: "opening-audio",
      category: "sound",
      signal: "prefer",
      stage: "recurring",
      summary: "Start the soundtrack at frame zero",
      evidence: ["dist/local-fixture-run/gate3-qc.json"],
      promotion_proposal: {
        id: "opening-audio-v1",
        kind: "qa",
        target: "src/orchestrator/gate3Qc.ts",
        change_summary: "Add an opening-audio Gate 3 check",
        verification: "Confirm the check on a later project",
        decision: "pending"
      }
    })}\n`);
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });
    const projects = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const projectId = projects.projects[0].id as string;
    const endpoint = `${launcher.url}/api/feedback/${projectId}/promotion-decision`;
    const requestBody = JSON.stringify({
      key: "opening-audio",
      proposalId: "opening-audio-v1",
      decision: "approved"
    });

    expect((await fetch(endpoint, { method: "POST" })).status).toBe(403);
    expect((await fetch(endpoint, {
      method: "POST",
      headers: {
        origin: "https://example.com",
        "content-type": "application/json",
        "x-tsugite-token": launcher.token
      },
      body: requestBody
    })).status).toBe(403);
    expect((await fetch(endpoint, {
      method: "POST",
      headers: {
        origin: launcher.artifactUrl,
        "content-type": "application/json",
        "x-tsugite-token": launcher.token
      },
      body: requestBody
    })).status).toBe(403);
    expect((await fetch(endpoint, {
      method: "POST",
      headers: {
        origin: launcher.url,
        "content-type": "application/json",
        "x-tsugite-token": launcher.token
      },
      body: JSON.stringify({ padding: "x".repeat(9_000) })
    })).status).toBe(400);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        origin: launcher.url,
        "content-type": "application/json",
        "x-tsugite-token": launcher.token
      },
      body: requestBody
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, decision: "approved" });
    const records = (await readFile(join(fixture.projectDir, "feedback.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({
      key: "opening-audio",
      stage: "recurring",
      promotion_proposal: {
        id: "opening-audio-v1",
        decision: "approved",
        decided_by: "human",
        decided_at: expect.any(String)
      }
    });
  });

  it("caps launcher feedback records and reports the read-only display limit", async () => {
    const fixture = await createFixture();
    const records = Array.from({ length: 1_001 }, (_, index) => JSON.stringify({
      schema_version: 1,
      id: `record-${index + 1}`,
      created_at: "2026-07-17T10:00:00.000Z",
      key: "opening-audio",
      category: "sound",
      signal: "prefer",
      stage: "observed",
      summary: "Start the soundtrack at frame zero"
    }));
    await writeFile(join(fixture.projectDir, "feedback.jsonl"), `${records.join("\n")}\n`);

    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });
    const payload = await fetch(`${launcher.url}/api/feedback`).then((response) => response.json());

    expect(payload.feedback.preferences[0]).toMatchObject({ key: "opening-audio", recordCount: 997 });
    expect(payload.feedback.issues).toContainEqual(expect.objectContaining({
      code: "feedback.aggregate_record_limit",
      projectName: "ランチャー"
    }));
  });

  it("keeps the latest pending promotion proposal visible among many newer records", async () => {
    const fixture = await createFixture();
    const pending = JSON.stringify({
      schema_version: 1,
      id: "pending-proposal",
      created_at: "2026-07-17T08:00:00.000Z",
      key: "opening-audio",
      category: "sound",
      signal: "prefer",
      stage: "recurring",
      summary: "Start the soundtrack at frame zero",
      evidence: ["dist/local-fixture-run/gate3-qc.json"],
      promotion_proposal: {
        id: "opening-audio-v1",
        kind: "qa",
        target: "src/orchestrator/gate3Qc.ts",
        change_summary: "Add an opening-audio Gate 3 check",
        verification: "Confirm the check on a later project",
        decision: "pending"
      }
    });
    const newerRecords = Array.from({ length: 1_000 }, (_, index) => JSON.stringify({
      schema_version: 1,
      id: `newer-record-${index + 1}`,
      created_at: "2026-07-17T10:00:00.000Z",
      key: "opening-audio",
      category: "sound",
      signal: "prefer",
      stage: "observed",
      summary: "Newer observation"
    }));
    await writeFile(
      join(fixture.projectDir, "feedback.jsonl"),
      `${[pending, ...newerRecords].join("\n")}\n`
    );

    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });
    const payload = await fetch(`${launcher.url}/api/feedback`).then((response) => response.json());

    expect(payload.feedback.preferences[0]).toMatchObject({
      key: "opening-audio",
      stage: "recurring",
      recordCount: 997,
      promotionProposal: {
        id: "opening-audio-v1",
        decision: "pending"
      }
    });
    expect(payload.feedback.issues).toContainEqual(expect.objectContaining({
      code: "feedback.aggregate_record_limit"
    }));
  });

  it("prioritizes recent feedback fairly and caps invalid diagnostics", async () => {
    const fixture = await createFixture();
    const secondProjectDir = join(fixture.projectsDir, "second-project");
    await cp(fixture.projectDir, secondProjectDir, { recursive: true });
    const verified = JSON.stringify({
      schema_version: 1,
      id: "latest-verification",
      created_at: "2026-07-17T10:00:00.000Z",
      key: "opening-audio",
      category: "sound",
      signal: "prefer",
      stage: "verified",
      summary: "Latest verification",
      evidence: ["dist/run/gate3-qc.json"]
    });
    const observed = Array.from({ length: 999 }, (_, index) => JSON.stringify({
      schema_version: 1,
      id: `old-${index + 1}`,
      created_at: "2026-07-17T09:00:00.000Z",
      key: "opening-audio",
      category: "sound",
      signal: "prefer",
      stage: "observed",
      summary: "Old observation"
    }));
    const promoted = JSON.stringify({
      schema_version: 1,
      id: "promotion-anchor",
      created_at: "2026-07-17T08:00:00.000Z",
      key: "opening-audio",
      category: "sound",
      signal: "prefer",
      stage: "promoted",
      summary: "Promotion anchor",
      promotion: { kind: "qa", target: "docs/requirements.md" }
    });
    await writeFile(join(fixture.projectDir, "feedback.jsonl"), `${[verified, ...observed, promoted].join("\n")}\n`);
    await writeFile(join(secondProjectDir, "feedback.jsonl"), "\n".repeat(10_001));

    const launcher = await launch({ projectsDir: fixture.projectsDir, bundleDir: fixture.bundleDir, port: 0 });
    const payload = await fetch(`${launcher.url}/api/feedback`).then((response) => response.json());

    expect(payload.feedback.preferences[0]).toMatchObject({
      key: "opening-audio",
      stage: "verified",
      promotion: { target: "docs/requirements.md" }
    });
    expect(payload.feedback.issues.length).toBeLessThanOrEqual(1_000);
    expect(payload.feedback.issues).toContainEqual(expect.objectContaining({
      code: "feedback.aggregate_issue_limit"
    }));
  });

  it("reports when more than 128 project feedback sources are available", async () => {
    const fixture = await createFixture();
    await Promise.all(Array.from({ length: 128 }, async (_, index) => {
      const projectDir = join(fixture.projectsDir, `project-${index + 1}`);
      await mkdir(projectDir);
      await writeFile(join(projectDir, "project.yaml"), [
        `slug: project-${index + 1}`,
        "manifest: manifest.json",
        "edit:",
        "  backend: remotion",
        ""
      ].join("\n"));
    }));

    const launcher = await launch({ projectsDir: fixture.projectsDir, bundleDir: fixture.bundleDir, port: 0 });
    const payload = await fetch(`${launcher.url}/api/feedback`).then((response) => response.json());
    expect(payload.feedback.issues).toContainEqual(expect.objectContaining({
      code: "feedback.aggregate_project_limit"
    }));
  });

  it("caps preferences and derived lifecycle diagnostics together", async () => {
    const fixture = await createFixture();
    const records = Array.from({ length: 1_001 }, (_, index) => JSON.stringify({
      schema_version: 1,
      id: `verified-${index + 1}`,
      created_at: "2026-07-17T10:00:00.000Z",
      key: `preference-${index + 1}`,
      category: "sound",
      signal: "prefer",
      stage: "verified",
      summary: `Unpromoted verification ${index + 1}`,
      evidence: ["dist/run/gate3-qc.json"]
    }));
    await writeFile(join(fixture.projectDir, "feedback.jsonl"), `${records.join("\n")}\n`);

    const launcher = await launch({ projectsDir: fixture.projectsDir, bundleDir: fixture.bundleDir, port: 0 });
    const payload = await fetch(`${launcher.url}/api/feedback`).then((response) => response.json());

    expect(payload.feedback.preferences.length + payload.feedback.issues.length).toBeLessThanOrEqual(1_000);
    expect(payload.feedback.metrics.issues).toBe(payload.feedback.issues.length);
    expect(payload.feedback.issues).toContainEqual(expect.objectContaining({
      code: "feedback.aggregate_output_limit"
    }));
  });

  it("lists direct template metadata and reports unsafe or invalid catalog entries", async () => {
    const fixture = await createFixture();
    const validDir = join(fixture.templatesDir, "article-dialogue");
    const invalidDir = join(fixture.templatesDir, "broken-template");
    const missingDir = join(fixture.templatesDir, "missing-metadata");
    const nestedDir = join(fixture.templatesDir, "group", "nested-template");
    await Promise.all([
      mkdir(validDir),
      mkdir(invalidDir),
      mkdir(missingDir),
      mkdir(nestedDir, { recursive: true })
    ]);
    await writeFile(join(validDir, "template.yaml"), `
schema_version: 1
kind: tsugite-template
id: article-dialogue
name: 記事掛け合い
summary: 記事を二人の会話で伝える動画
category: 記事を動画化
use_cases:
  - ブログ記事
  - 解説動画
output:
  duration:
    mode: fixed
    min_seconds: 60
    max_seconds: 60
    label: 60秒
  aspect_ratios:
    - "16:9"
  speaker_count: 2
required_inputs:
  - type: text
    label: 記事本文
    required: true
  - type: image
    label: キャラクター画像
    required: true
preview:
  frames:
    - { kind: person, label: 初心者の疑問 }
    - { kind: person, label: 専門家の解説 }
    - { kind: text, label: 要点まとめ }
  flow:
    - 疑問を提示
    - 結論と理由
    - 要点を確認
not_for:
  - 無言の商品イメージ映像
variants:
  - id: cast
    label: キャラクター構成
    default_option: beginner-expert
    options:
      - id: beginner-expert
        label: 初心者＋専門家
        description: 初心者が問い、専門家が結論と理由を説明する
      - id: peer-dialogue
        label: 同僚同士
        description: 同じ目線の二人が事例を交えて整理する
  - id: background
    label: 背景
    options:
      - id: paper-cutout
        label: 紙の切り絵
        description: 紙素材と柔らかな陰影で見せる
      - id: ui-window
        label: 画面デモ
        description: 背景に製品画面や操作例を表示する
tags:
  - 掛け合い
  - 60秒
audio:
  narration: optional
  bgm: optional
  silent_draft: true
  notes: 音声は任意。未指定時は無音ドラフト
status: stable
distribution: local-only
`);
    await writeFile(join(invalidDir, "template.yaml"), "name: [broken\n");
    await writeFile(join(nestedDir, "template.yaml"), "name: nested\n");
    await symlink(join(validDir, "template.yaml"), join(missingDir, "template.yaml"));
    await symlink(validDir, join(fixture.templatesDir, "linked-template"));

    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      templatesDir: fixture.templatesDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });

    const response = await fetch(`${launcher.url}/api/templates`);
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true });
    expect(payload.templates.map((template: { id: string }) => template.id)).toEqual([
      "article-dialogue",
      "broken-template",
      "missing-metadata"
    ]);
    expect(payload.templates[0]).toEqual({
      id: "article-dialogue",
      name: "記事掛け合い",
      summary: "記事を二人の会話で伝える動画",
      category: "記事を動画化",
      useCases: ["ブログ記事", "解説動画"],
      duration: "60秒",
      aspectRatio: "16:9",
      speakers: 2,
      requiredInputs: ["記事本文", "キャラクター画像"],
      requiredInputDetails: [
        { type: "text", label: "記事本文", required: true },
        { type: "image", label: "キャラクター画像", required: true }
      ],
      preview: {
        frames: [
          { kind: "person", label: "初心者の疑問" },
          { kind: "person", label: "専門家の解説" },
          { kind: "text", label: "要点まとめ" }
        ],
        flow: ["疑問を提示", "結論と理由", "要点を確認"]
      },
      notFor: ["無言の商品イメージ映像"],
      variants: [
        {
          id: "cast",
          label: "キャラクター構成",
          defaultOptionId: "beginner-expert",
          options: [
            { id: "beginner-expert", label: "初心者＋専門家", description: "初心者が問い、専門家が結論と理由を説明する" },
            { id: "peer-dialogue", label: "同僚同士", description: "同じ目線の二人が事例を交えて整理する" }
          ]
        },
        {
          id: "background",
          label: "背景",
          options: [
            { id: "paper-cutout", label: "紙の切り絵", description: "紙素材と柔らかな陰影で見せる" },
            { id: "ui-window", label: "画面デモ", description: "背景に製品画面や操作例を表示する" }
          ]
        }
      ],
      tags: ["掛け合い", "60秒"],
      audio: "音声は任意。未指定時は無音ドラフト",
      status: "stable",
      distribution: "local-only",
      valid: true
    });
    expect(payload.templates[1]).toMatchObject({
      id: "broken-template",
      name: "broken-template",
      valid: false,
      issue: { code: "template_metadata.invalid", message: expect.any(String) }
    });
    expect(payload.templates[2]).toMatchObject({
      id: "missing-metadata",
      name: "missing-metadata",
      valid: false,
      issue: {
        code: "template_metadata.symlink",
        message: expect.stringMatching(/シンボリックリンク/)
      }
    });
  });

  it("rejects a template variant whose recommended option is not declared", async () => {
    const fixture = await createFixture();
    const invalidDir = join(fixture.templatesDir, "invalid-variant");
    await mkdir(invalidDir);
    await writeFile(join(invalidDir, "template.yaml"), `
schema_version: 1
kind: tsugite-template
id: invalid-variant
name: 無効なバリエーション
summary: 推奨値が選択肢を参照しないテンプレート
category: 解説
use_cases: [解説動画]
output:
  duration: { mode: fixed, min_seconds: 30, max_seconds: 30, label: 30秒 }
  aspect_ratios: ["16:9"]
required_inputs:
  - { type: text, label: 台本, required: true }
variants:
  - id: cast
    label: キャラクター構成
    default_option: missing
    options:
      - { id: solo, label: 一人, description: 一人で説明する }
      - { id: duo, label: 二人, description: 二人で掛け合う }
audio:
  narration: optional
  bgm: optional
  silent_draft: true
  notes: 音声は任意です。
status: experimental
distribution: local-only
`);

    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      templatesDir: fixture.templatesDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });
    const payload = await fetch(`${launcher.url}/api/templates`).then((response) => response.json());

    expect(payload.templates[0]).toMatchObject({
      id: "invalid-variant",
      valid: false,
      issue: { code: "template_metadata.invalid" }
    });
  });

  it("passes required_inputs.required through requiredInputDetails (including optional inputs)", async () => {
    // Phase 2/3 契約: checklist の必須/任意振り分けのため、API は required フラグを透過し optional も落とさない。
    const fixture = await createFixture();
    const templateDir = join(fixture.templatesDir, "required-flag-template");
    await mkdir(templateDir);
    await writeFile(join(templateDir, "template.yaml"), `
schema_version: 1
kind: tsugite-template
id: required-flag-template
name: 必須フラグ透過
summary: required の真偽が API に残ることを確認する
category: 解説
use_cases:
  - 契約確認
output:
  duration:
    mode: fixed
    min_seconds: 30
    max_seconds: 30
    label: 30秒
  aspect_ratios:
    - "16:9"
required_inputs:
  - type: text
    label: 台本
    required: true
  - type: image
    label: 任意の参考画像
    required: false
  - type: audio
    label: 任意のBGM
    required: false
audio:
  narration: optional
  bgm: optional
  silent_draft: true
  notes: 音声は任意です。
status: experimental
distribution: local-only
`);

    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      templatesDir: fixture.templatesDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });
    const response = await fetch(`${launcher.url}/api/templates`);
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true });

    const template = payload.templates.find(
      (entry: { id: string }) => entry.id === "required-flag-template"
    );
    expect(template).toBeDefined();
    expect(template.valid).toBe(true);
    expect(template.requiredInputDetails).toEqual([
      { type: "text", label: "台本", required: true },
      { type: "image", label: "任意の参考画像", required: false },
      { type: "audio", label: "任意のBGM", required: false }
    ]);
    // 必須ラベル一覧は required: true のみ
    expect(template.requiredInputs).toEqual(["台本"]);
  });


  it("rejects a storyboard preview that does not contain exactly three frames", async () => {
    const fixture = await createFixture();
    const invalidDir = join(fixture.templatesDir, "invalid-preview");
    await mkdir(invalidDir);
    await writeFile(join(invalidDir, "template.yaml"), `
schema_version: 1
kind: tsugite-template
id: invalid-preview
name: 無効な構成イメージ
summary: 3コマに満たない構成イメージを持つテンプレート
category: 解説
use_cases: [解説動画]
output:
  duration: { mode: fixed, min_seconds: 30, max_seconds: 30, label: 30秒 }
  aspect_ratios: ["16:9"]
required_inputs:
  - { type: text, label: 台本, required: true }
preview:
  frames:
    - { kind: text, label: 導入 }
    - { kind: person, label: 解説 }
  flow: [導入, 解説, まとめ]
audio:
  narration: optional
  bgm: optional
  silent_draft: true
  notes: 音声は任意です。
status: experimental
distribution: local-only
`);

    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      templatesDir: fixture.templatesDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });
    const payload = await fetch(`${launcher.url}/api/templates`).then((response) => response.json());

    expect(payload.templates[0]).toMatchObject({
      id: "invalid-preview",
      valid: false,
      issue: { code: "template_metadata.invalid" }
    });
  });

  it("rejects oversized template metadata without exposing file contents", async () => {
    const fixture = await createFixture();
    const oversizedDir = join(fixture.templatesDir, "oversized");
    await mkdir(oversizedDir);
    await writeFile(join(oversizedDir, "template.yaml"), `summary: ${"x".repeat(70_000)}\n`);
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      templatesDir: fixture.templatesDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });

    const payload = await fetch(`${launcher.url}/api/templates`).then((response) => response.json());
    expect(payload.templates[0]).toMatchObject({
      id: "oversized",
      valid: false,
      issue: {
        code: "template_metadata.too_large",
        message: "template.yamlが大きすぎます。64 KiB以下にしてください。"
      }
    });
    expect(JSON.stringify(payload)).not.toContain("x".repeat(100));
  });

  it("serves the built Viewer shell with launcher metadata and lists direct real projects", async () => {
    const fixture = await createFixture();
    const invalidDir = join(fixture.projectsDir, "invalid-project");
    const nestedDir = join(fixture.projectsDir, "group", "nested-project");
    const thumbnailDir = join(fixture.projectDir, "dist", "local-fixture-run", "qa");
    await mkdir(invalidDir);
    await writeFile(join(invalidDir, "project.yaml"), "slug: [invalid\n");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(nestedDir, "project.yaml"), "slug: nested\n");
    await mkdir(thumbnailDir, { recursive: true });
    await writeFile(join(thumbnailDir, "contact-sheet.png"), "thumbnail-image");
    await symlink(fixture.projectDir, join(fixture.projectsDir, "linked-project"));

    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });

    expect(launcher.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(launcher.artifactUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(launcher.artifactUrl).not.toBe(launcher.url);
    const rootResponse = await fetch(launcher.url);
    const rootHtml = await rootResponse.text();
    expect(rootResponse.status).toBe(200);
    expect(rootResponse.headers.get("content-security-policy")).toContain(
      "img-src 'self' data: blob:"
    );
    expect(rootResponse.headers.get("content-security-policy")).not.toContain(launcher.artifactUrl);
    expect(rootHtml).toContain('<meta name="tsugite-launcher" content="true">');
    expect(rootHtml).toContain(
      `<meta name="tsugite-launcher-token" content="${launcher.token}">`
    );
    await expect(fetch(`${launcher.url}/assets/app.js`).then((response) => response.text()))
      .resolves.toContain("viewerLoaded");
    const moduleResponse = await fetch(`${launcher.url}/assets/terminal.mjs`);
    expect(moduleResponse.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    await expect(moduleResponse.text()).resolves.toContain("terminalLoaded");

    const payload = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    expect(payload).toMatchObject({ ok: true });
    expect(payload.projects).toHaveLength(2);
    expect(payload.projects.map((project: { name: string }) => project.name)).toEqual([
      "invalid-project",
      "valid-project"
    ]);
    const valid = payload.projects.find((project: { name: string }) => project.name === "valid-project");
    expect(valid).toMatchObject({
      name: "valid-project",
      slug: "local-fixture",
      runId: "local-fixture-run",
      status: "planned",
      updatedAt: null,
      hasViewer: false,
      thumbnailUrl: `${launcher.url}/thumbnail/${valid.id}`,
      valid: true,
      refreshable: true,
      issues: []
    });
    expect(valid.id).not.toBe("valid-project");
    expect(valid.id).not.toBe("local-fixture");
    const invalid = payload.projects.find((project: { name: string }) => project.name === "invalid-project");
    expect(invalid).toMatchObject({
      valid: false,
      refreshable: false,
      status: "error",
      hasViewer: false,
      issues: [{ code: "viewer_launcher.project_invalid", message: expect.any(String) }]
    });
    expect(invalid.issue).toEqual(expect.any(String));
    const invalidRefresh = await fetch(
      `${launcher.url}/api/projects/${invalid.id}/refresh`,
      {
        method: "POST",
        headers: { origin: launcher.url, "x-tsugite-token": launcher.token }
      }
    );
    expect(invalidRefresh.status).toBe(422);
    const thumbnailResponse = await fetch(valid.thumbnailUrl);
    expect(thumbnailResponse.headers.get("access-control-allow-origin")).toBeNull();
    await expect(thumbnailResponse.text())
      .resolves.toBe("thumbnail-image");
    expect((await fetch(valid.thumbnailUrl, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(`${launcher.artifactUrl}/thumbnail/${valid.id}`)).status).toBe(404);
    expect((await fetch(launcher.artifactUrl)).status).toBe(404);
    expect((await fetch(`${launcher.artifactUrl}/api/feedback`)).status).toBe(404);
    expect((await fetch(`${launcher.artifactUrl}/assets/app.js`)).status).toBe(404);

    await expect(statusWithHost(launcher.url, "viewer.attacker.invalid")).resolves.toBe(403);
    await expect(statusWithHost(launcher.artifactUrl, "viewer.attacker.invalid")).resolves.toBe(403);
  });

  it("lists projects from additional worktrees as read-only without enabling project actions", async () => {
    const fixture = await createFixture();
    const worktreeProjectsDir = join(fixture.root, "worktree-projects");
    const worktreeProjectDir = join(worktreeProjectsDir, "in-progress-project");
    await cp(fixture.projectDir, worktreeProjectDir, { recursive: true });
    await writeFile(
      join(worktreeProjectDir, "project.yaml"),
      (await readFile(join(worktreeProjectDir, "project.yaml"), "utf8"))
        .replace("slug: local-fixture", "slug: in-progress-project")
        .replace("run_id: local-fixture-run", "run_id: in-progress-project-run")
    );

    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      additionalProjectsDirs: [worktreeProjectsDir],
      bundleDir: fixture.bundleDir,
      port: 0
    });

    const payload = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    expect(payload.projects).toHaveLength(2);
    const worktreeProject = payload.projects.find((project: { name: string }) => project.name === "in-progress-project");
    expect(worktreeProject).toMatchObject({
      name: "in-progress-project",
      status: "planned",
      readOnly: true,
      availableActions: []
    });
    const action = await fetch(`${launcher.url}/api/projects/${worktreeProject.id}/action`, {
      method: "POST",
      headers: {
        origin: launcher.url,
        "content-type": "application/json",
        "x-tsugite-token": launcher.token
      },
      body: JSON.stringify({
        action: "validate",
        expectedRunId: worktreeProject.runId,
        revision: worktreeProject.revision
      })
    });
    await expect(action.json()).resolves.toMatchObject({
      ok: false,
      issue: { code: "viewer_launcher.worktree_read_only" }
    });
    expect(action.status).toBe(403);

    const refreshed = await fetch(`${launcher.url}/api/projects/${worktreeProject.id}/refresh`, {
      method: "POST",
      headers: { origin: launcher.url, "x-tsugite-token": launcher.token }
    });
    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({
      ok: true,
      project: { readOnly: true, availableActions: [] }
    });
  });

  it("uses configured runtime validation paths when listing and refreshing a project", async () => {
    const fixture = await createFixture();
    const backendName = "packaged-remotion";
    const backendRoot = join(fixture.root, "runtime", "backends");
    const configPath = join(fixture.projectDir, "project.yaml");
    await mkdir(join(backendRoot, backendName), { recursive: true });
    await writeFile(
      join(backendRoot, backendName, "capabilities.yaml"),
      [
        `name: ${backendName}`,
        "capabilities:",
        "  captions: true",
        "  transitions: true",
        "  audio_mix: true",
        "  vertical: true",
        "  fps: [24, 30, 60]",
        "  presets: [article-dialogue-16x9]"
      ].join("\n") + "\n"
    );
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace("backend: remotion", `backend: ${backendName}`)
    );

    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0,
      validationOptions: { backendDirs: [backendRoot] }
    });
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const project = listing.projects[0];
    expect(project).toMatchObject({ valid: true, refreshable: true, issues: [] });

    const refreshed = await fetch(`${launcher.url}/api/projects/${project.id}/refresh`, {
      method: "POST",
      headers: { origin: launcher.url, "x-tsugite-token": launcher.token }
    });
    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({
      ok: true,
      project: { valid: true, refreshable: true, issues: [] }
    });
  });

  it("selects the most recently updated direct project config", async () => {
    const fixture = await createFixture();
    const latestConfig = join(fixture.projectDir, "project-audio-r3.yaml");
    const latestRunId = "local-fixture-audio-r3";
    const canonical = await readFile(join(fixture.projectDir, "project.yaml"), "utf8");
    await writeFile(
      latestConfig,
      canonical.replace("run_id: local-fixture-run", `run_id: ${latestRunId}`)
    );
    await writeState(
      join(fixture.projectDir, "dist"),
      createPlannedState(latestRunId, "2026-07-17T00:00:00.000Z")
    );

    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });

    const payload = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    expect(payload.projects).toHaveLength(1);
    expect(payload.projects[0]).toMatchObject({
      name: "valid-project",
      runId: latestRunId,
      updatedAt: "2026-07-17T00:00:00.000Z",
      valid: true
    });
  });

  it("serves a sanitized generation canvas for a known project id", async () => {
    const fixture = await createFixture();
    const configPath = join(fixture.projectDir, "project.yaml");
    await writeFile(configPath, `${await readFile(configPath, "utf8")}generation:
  connection: pixverse
  adapter: pixverse
  requests:
    - id: arrival-shot
      prompt: 雪山の稜線へゆっくり近づく
      model: seedance-1.5-pro
      duration: 5
      aspect: "16:9"
      input_mode: image-to-video
      first_frame: assets/alps.png
      params:
        private_note: never-return-this
`);
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const project = listing.projects[0];

    const response = await fetch(`${launcher.url}/api/projects/${project.id}/generation-canvas`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      canvas: {
        project: {
          id: project.id,
          slug: "local-fixture",
          runId: "local-fixture-run"
        },
        generation: {
          connection: "pixverse",
          adapter: "pixverse",
          requests: [{
            id: "arrival-shot",
            prompt: "雪山の稜線へゆっくり近づく",
            model: "seedance-1.5-pro",
            duration: 5,
            aspect: "16:9",
            inputMode: "image-to-video",
            hasFirstFrame: true,
            referenceImageCount: 0
          }]
        },
        connections: expect.arrayContaining([expect.objectContaining({
          id: "pixverse",
          authKind: "subscription",
          capabilities: expect.arrayContaining(["image.generate", "video.text-to-video", "audio.music"]),
          automatedCapabilities: expect.arrayContaining([
            "image.generate", "video.text-to-video", "video.image-to-video", "audio.music"
          ]),
          modelPolicy: "runtime"
        })])
      }
    });
    expect(JSON.stringify(payload)).not.toContain(fixture.root);
    expect(JSON.stringify(payload)).not.toContain("private_note");
    expect(JSON.stringify(payload)).not.toContain("never-return-this");
    expect((await fetch(`${launcher.url}/api/projects/not-a-project/generation-canvas`)).status).toBe(404);
  });

  it("requires same-origin authorization and writes a compatible TopView MCP selection to project.yaml", async () => {
    const fixture = await createFixture();
    const configPath = join(fixture.projectDir, "project.yaml");
    await writeFile(configPath, `${await readFile(configPath, "utf8")}generation:
  connection: pixverse
  adapter: pixverse
  requests:
    - id: generated-shot
      operation: video
      prompt: 朝霧の山荘へ近づく
      input_mode: text-to-video
`);
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const project = listing.projects[0];
    const endpoint = `${launcher.url}/api/projects/${project.id}/generation-connection`;

    expect((await fetch(endpoint, { method: "POST" })).status).toBe(403);
    expect((await fetch(endpoint, {
      method: "POST",
      headers: {
        origin: "https://example.com",
        "content-type": "application/json",
        "x-tsugite-token": launcher.token
      },
      body: JSON.stringify({ connection: "topview" })
    })).status).toBe(403);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        origin: launcher.url,
        "content-type": "application/json",
        "x-tsugite-token": launcher.token
      },
      body: JSON.stringify({ connection: "topview" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      connection: "topview",
      adapter: "topview",
      requiresReview: true
    });
    const updated = await readFile(configPath, "utf8");
    expect(updated).toContain("connection: topview");
    expect(updated).toContain("adapter: topview");
  });

  it("starts generation only for a Gate 1 approved project and delegates to the coordinator runner", async () => {
    const fixture = await createFixture();
    const configPath = join(fixture.projectDir, "project.yaml");
    await writeFile(configPath, `${await readFile(configPath, "utf8")}generation:
  connection: topview
  adapter: topview
  requests:
    - id: generated-shot
      operation: image
      output_kind: image
      prompt: 朝霧の山荘
`);
    const running = recordGateDecision(
      markGateAwaiting(createPlannedState("local-fixture-run"), "gate_1"),
      "gate_1",
      "approved"
    );
    await writeState(join(fixture.projectDir, "dist"), running);
    let finishGeneration!: (result: unknown) => void;
    const generationResult = new Promise<unknown>((resolve) => {
      finishGeneration = resolve;
    });
    const runGeneration = vi.fn(() => generationResult);
    let canStartWork = true;
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0,
      runGeneration,
      canStartWork: () => canStartWork
    });
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const project = listing.projects[0];
    const endpoint = `${launcher.url}/api/projects/${project.id}/generate`;

    expect((await fetch(endpoint, { method: "POST", headers: { origin: launcher.url } })).status).toBe(403);
    canStartWork = false;
    const blocked = await fetch(endpoint, {
      method: "POST",
      headers: { origin: launcher.url, "x-tsugite-token": launcher.token }
    });
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      issue: { code: "viewer_launcher.work_blocked" }
    });
    expect(runGeneration).not.toHaveBeenCalled();
    canStartWork = true;
    expect(launcher.hasActive()).toBe(false);
    const responsePromise = fetch(endpoint, {
      method: "POST",
      headers: { origin: launcher.url, "x-tsugite-token": launcher.token }
    });

    await vi.waitFor(() => expect(runGeneration).toHaveBeenCalledOnce());
    expect(launcher.hasActive()).toBe(true);
    expect(launcher.hasBlockingWork()).toBe(false);
    finishGeneration({ ok: true, command: "run", state: { status: "awaiting_gate_2" } });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: { ok: true, command: "run", state: { status: "awaiting_gate_2" } }
    });
    expect(runGeneration).toHaveBeenCalledOnce();
    expect(runGeneration).toHaveBeenCalledWith(configPath);
    expect(launcher.hasActive()).toBe(false);
  });

  it("rejects every mutation route while new work is suspended", async () => {
    const fixture = await createFixture();
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });
    const resumeWork = launcher.suspendWork();
    const resumeNestedWork = launcher.suspendWork();
    const paths = [
      "/api/projects/missing/generation-connection",
      "/api/projects/missing/generate",
      "/api/projects/missing/action",
      "/api/feedback/missing/promotion-decision",
      "/api/projects/missing/refresh"
    ];

    for (const path of paths) {
      const response = await fetch(`${launcher.url}${path}`, {
        method: "POST",
        headers: {
          origin: launcher.url,
          "x-tsugite-token": launcher.token
        }
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        issue: { code: "viewer_launcher.work_blocked" }
      });
    }

    resumeNestedWork();
    expect((await fetch(`${launcher.url}/api/projects/missing/generate`, {
      method: "POST",
      headers: {
        origin: launcher.url,
        "x-tsugite-token": launcher.token
      }
    })).status).toBe(409);
    resumeWork();
    expect((await fetch(`${launcher.url}/api/projects/missing/generate`, {
      method: "POST",
      headers: {
        origin: launcher.url,
        "x-tsugite-token": launcher.token
      }
    })).status).toBe(404);
  });

  it("requires the launcher token and same origin before refreshing a snapshot", async () => {
    const fixture = await createFixture();
    let finishRefresh!: () => void;
    const refreshPaused = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const beforeRefresh = vi.fn(() => refreshPaused);
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0,
      beforeRefresh
    });
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const project = listing.projects[0];

    const missingToken = await fetch(`${launcher.url}/api/projects/${project.id}/refresh`, {
      method: "POST",
      headers: { origin: launcher.url }
    });
    expect(missingToken.status).toBe(403);
    const foreignOrigin = await fetch(`${launcher.url}/api/projects/${project.id}/refresh`, {
      method: "POST",
      headers: {
        origin: "https://example.com",
        "x-tsugite-token": launcher.token
      }
    });
    expect(foreignOrigin.status).toBe(403);

    const refreshedPromise = fetch(`${launcher.url}/api/projects/${project.id}/refresh`, {
      method: "POST",
      headers: {
        origin: launcher.url,
        "x-tsugite-token": launcher.token
      }
    });
    await vi.waitFor(() => expect(beforeRefresh).toHaveBeenCalledOnce());
    expect(launcher.hasActive()).toBe(true);
    expect(launcher.hasBlockingWork()).toBe(true);
    finishRefresh();
    const refreshed = await refreshedPromise;
    const payload = await refreshed.json();
    expect(refreshed.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      viewerUrl: expectedViewerUrl(launcher, project.id),
      project: {
        id: project.id,
        hasViewer: true,
        valid: true,
        viewerUrl: expectedViewerUrl(launcher, project.id)
      }
    });
    expect(launcher.hasActive()).toBe(false);
    const viewerResponse = await fetch(payload.viewerUrl);
    expect(viewerResponse.status).toBe(200);
    await expect(viewerResponse.text()).resolves.toContain('id="tsugite-workflow-data"');
    const rangeResponse = await fetch(payload.viewerUrl, { headers: { range: "bytes=0-8" } });
    expect(rangeResponse.status).toBe(206);
    expect(rangeResponse.headers.get("content-range")).toMatch(/^bytes 0-8\/\d+$/);
    await expect(rangeResponse.text()).resolves.toBe("<!doctype");
    expect((await fetch(payload.viewerUrl, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(payload.viewerUrl, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${launcher.url}/viewer/${project.id}/`)).status).toBe(404);

    const [snapshotName] = await readdir(launcher.privateRoot!);
    const reviewDir = join(launcher.privateRoot!, snapshotName!, "review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, "index.html"), "<!doctype html><script>globalThis.compromised = true</script>\n");
    const reviewResponse = await fetch(new URL("review/index.html", payload.viewerUrl));
    expect(reviewResponse.status).toBe(404);

    const statePath = join(fixture.projectDir, "dist", "local-fixture-run", "state.json");
    await expect(readFile(statePath, "utf8")).rejects.toThrow();
  });

  it("returns Gate review URLs only when the Viewer snapshot contains their evidence", async () => {
    const fixture = await createFixture();
    await writeApprovedGate1State(fixture);
    const runDir = join(fixture.projectDir, "dist", "local-fixture-run");
    await writeFile(join(runDir, "gate2-qc.json"), `${JSON.stringify({
      ok: true,
      target_duration_seconds: 12,
      total_clip_duration_seconds: 12,
      duration_delta_seconds: 0,
      asset_count: 1,
      issues: []
    })}\n`);
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });

    const initialListing = await fetch(`${launcher.url}/api/projects`)
      .then((response) => response.json());
    const initialProject = initialListing.projects[0];
    expect(initialProject).not.toHaveProperty("gate1ReviewUrl");
    expect(initialProject).not.toHaveProperty("gate2ReviewUrl");

    const refreshResponse = await fetch(
      `${launcher.url}/api/projects/${initialProject.id}/refresh`,
      {
        method: "POST",
        headers: { origin: launcher.url, "x-tsugite-token": launcher.token }
      }
    );
    expect(refreshResponse.status).toBe(200);
    const refreshed = await refreshResponse.json();
    expect(refreshed.project).toMatchObject({
      gate1ReviewUrl: expectedGate1ReviewUrl(launcher, initialProject.id),
      gate2ReviewUrl: expectedGate2ReviewUrl(launcher, initialProject.id)
    });
    expect(new URL(refreshed.project.gate2ReviewUrl).searchParams.get("node")).toBe("gate-2");
    const gate1Response = await fetch(refreshed.project.gate1ReviewUrl);
    expect(gate1Response.status).toBe(200);
    expect(gate1Response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    );
    const encodedReviewUrl = new URL(`/viewer/${initialProject.id}/review%2Findex.html`, launcher.artifactUrl);
    const encodedReviewResponse = await fetch(encodedReviewUrl);
    expect(encodedReviewResponse.status).toBe(200);
    expect(encodedReviewResponse.headers.get("content-security-policy")).toBe(
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    );
    expect((await fetch(refreshed.project.gate2ReviewUrl)).status).toBe(200);

    const refreshedListing = await fetch(`${launcher.url}/api/projects`)
      .then((response) => response.json());
    expect(refreshedListing.projects[0]).toMatchObject({
      gate1ReviewUrl: refreshed.project.gate1ReviewUrl,
      gate2ReviewUrl: refreshed.project.gate2ReviewUrl
    });

    const reviewPath = join(runDir, "review", "index.html");
    const currentReview = await readFile(reviewPath, "utf8");
    await writeFile(reviewPath, `${currentReview}\n<!-- changed after snapshot -->\n`);
    const staleReviewListing = await fetch(`${launcher.url}/api/projects`)
      .then((response) => response.json());
    expect(staleReviewListing.projects[0]).not.toHaveProperty("gate1ReviewUrl");
    expect(staleReviewListing.projects[0]).toHaveProperty("gate2ReviewUrl");
    await writeFile(reviewPath, currentReview);

    await writeFile(join(runDir, "gate2-qc.json"), `${JSON.stringify({
      ok: true,
      target_duration_seconds: 13,
      total_clip_duration_seconds: 12,
      duration_delta_seconds: -1,
      asset_count: 1,
      issues: []
    })}\n`);
    const staleListing = await fetch(`${launcher.url}/api/projects`)
      .then((response) => response.json());
    expect(staleListing.projects[0]).toMatchObject({
      gate1ReviewUrl: refreshed.project.gate1ReviewUrl
    });
    expect(staleListing.projects[0]).not.toHaveProperty("gate2ReviewUrl");

    await writeFile(join(runDir, "gate2-qc.json"), `${JSON.stringify({
      ok: false,
      issues: [{ code: "gate2.changed", message: "QC evidence changed" }]
    })}\n`);
    const failedQcRefresh = await fetch(
      `${launcher.url}/api/projects/${initialProject.id}/refresh`,
      {
        method: "POST",
        headers: { origin: launcher.url, "x-tsugite-token": launcher.token }
      }
    );
    expect(failedQcRefresh.status).toBe(200);
    const failedQcProject = (await failedQcRefresh.json()).project;
    expect(failedQcProject).toHaveProperty(
      "gate2ReviewUrl",
      expectedGate2ReviewUrl(launcher, initialProject.id)
    );
  });

  it("returns current Gate review URLs in the initial project listing", async () => {
    const fixture = await createFixture();
    await writeApprovedGate1State(fixture);
    const configPath = join(fixture.projectDir, "project.yaml");
    const runDir = join(fixture.projectDir, "dist", "local-fixture-run");
    const gate2SourcePath = join(runDir, "assets", "clips", "gate2-source.mp4");
    const gate2Source = Buffer.from("asset-A");
    await mkdir(join(runDir, "assets", "clips"), { recursive: true });
    await writeFile(gate2SourcePath, gate2Source);
    await writeFile(join(runDir, "gate2-qc.json"), `${JSON.stringify({
      ok: false,
      assets: [{
        id: "gate2-source",
        kind: "clip",
        src: "assets/clips/gate2-source.mp4",
        path: gate2SourcePath,
        sha256: createHash("sha256").update(gate2Source).digest("hex")
      }],
      issues: [{ code: "gate2.asset", message: "素材を確認してください" }]
    })}\n`);
    await mkdir(join(runDir, "review", "assets"), { recursive: true });
    await writeFile(join(runDir, "review", "assets", "review-proof.png"), "review-proof");
    const validation = await validateProject(configPath);
    if (!validation.project || !validation.manifest) throw new Error("fixture project is invalid");
    await writeWorkflowViewer({
      configPath,
      project: validation.project,
      plan: createPlan(validation.project, validation.manifest),
      bundleDir: fixture.bundleDir
    });

    const onSnapshotFingerprint = vi.fn();
    const onReviewFingerprint = vi.fn();
    const persistentLauncher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0,
      onSnapshotFingerprint,
      onReviewFingerprint
    });
    const persistentListing = await fetch(`${persistentLauncher.url}/api/projects`)
      .then((response) => response.json());
    const persistentProject = persistentListing.projects[0];
    expect(persistentProject).toMatchObject({
      gate1ReviewUrl: expectedGate1ReviewUrl(persistentLauncher, persistentProject.id),
      gate2ReviewUrl: expectedGate2ReviewUrl(persistentLauncher, persistentProject.id)
    });

    const viewerBase = new URL(`/viewer/${persistentProject.id}/`, persistentLauncher.artifactUrl);
    const previewDir = join(runDir, "viewer", "previews");
    const [previewName] = await readdir(previewDir);
    const previewUrl = new URL(`previews/${previewName}`, viewerBase);
    const appAssetUrl = new URL("assets/app.js", viewerBase);
    const workflowUrl = new URL("workflow.json", viewerBase);
    const reviewAssetUrl = new URL("review/assets/review-proof.png", viewerBase);
    const sidecarPath = join(runDir, "viewer", "viewer-evidence.json");
    const sidecar = await readFile(sidecarPath);

    await rm(sidecarPath);
    expect((await fetch(persistentProject.gate2ReviewUrl)).status).toBe(404);
    expect((await fetch(previewUrl)).status).toBe(404);
    expect((await fetch(workflowUrl)).status).toBe(404);
    await writeFile(sidecarPath, sidecar);
    await writeFile(sidecarPath, "{invalid-json\n");
    expect((await fetch(persistentProject.gate2ReviewUrl)).status).toBe(404);
    expect((await fetch(previewUrl)).status).toBe(404);
    expect((await fetch(workflowUrl)).status).toBe(404);
    await writeFile(sidecarPath, sidecar);

    const cacheSourceReviewPath = join(runDir, "review", "index.html");
    const cacheSnapshotReviewPath = join(runDir, "viewer", "review", "index.html");
    await writeFile(cacheSourceReviewPath, await readFile(cacheSourceReviewPath));
    await writeFile(cacheSnapshotReviewPath, await readFile(cacheSnapshotReviewPath));
    expect((await fetch(persistentProject.gate1ReviewUrl)).status).toBe(200);
    expect((await fetch(reviewAssetUrl)).status).toBe(200);
    expect((await fetch(reviewAssetUrl)).status).toBe(200);
    expect(onReviewFingerprint).toHaveBeenCalledTimes(2);
    expect(new Set(onReviewFingerprint.mock.calls.map(([root]) => String(root))).size).toBe(2);

    const reviewAssetsDir = join(runDir, "review", "assets");
    const emptyReviewDirectories = join(reviewAssetsDir, "empty-directories");
    for (let start = 0; start < 513; start += 32) {
      await Promise.all(Array.from({ length: Math.min(32, 513 - start) }, (_, offset) =>
        mkdir(join(emptyReviewDirectories, String(start + offset)), { recursive: true })
      ));
    }
    expect((await fetch(persistentProject.gate1ReviewUrl)).status).toBe(404);
    await rm(emptyReviewDirectories, { recursive: true });

    let deepReviewDirectory = join(reviewAssetsDir, "deep-directories");
    for (let depth = 0; depth < 33; depth += 1) {
      deepReviewDirectory = join(deepReviewDirectory, "d");
    }
    await mkdir(deepReviewDirectory, { recursive: true });
    expect((await fetch(persistentProject.gate1ReviewUrl)).status).toBe(404);
    await rm(join(reviewAssetsDir, "deep-directories"), { recursive: true });

    const cachePreviewPath = join(previewDir, previewName!);
    await writeFile(cachePreviewPath, await readFile(cachePreviewPath));
    const firstPreviewRange = await fetch(previewUrl, { headers: { range: "bytes=0-1" } });
    const secondPreviewRange = await fetch(previewUrl, { headers: { range: "bytes=2-3" } });
    expect(firstPreviewRange.status).toBe(206);
    expect(secondPreviewRange.status).toBe(206);
    expect(onSnapshotFingerprint.mock.calls.filter(
      ([path]) => String(path).replaceAll("\\", "/").endsWith(`/previews/${previewName}`)
    )).toHaveLength(1);

    await writeFile(gate2SourcePath, Buffer.from("asset-B"));
    const changedSourceListing = await fetch(`${persistentLauncher.url}/api/projects`)
      .then((response) => response.json());
    expect(changedSourceListing.projects[0]).not.toHaveProperty("gate2ReviewUrl");
    expect((await fetch(persistentProject.gate2ReviewUrl)).status).toBe(404);
    expect((await fetch(previewUrl)).status).toBe(404);
    expect((await fetch(appAssetUrl)).status).toBe(404);
    await writeFile(gate2SourcePath, gate2Source);

    const sourceReviewPath = join(runDir, "review", "index.html");
    const sourceReview = await readFile(sourceReviewPath, "utf8");
    await writeFile(sourceReviewPath, `${sourceReview}\n<!-- changed source -->\n`);
    expect((await fetch(persistentProject.gate1ReviewUrl)).status).toBe(404);
    await writeFile(sourceReviewPath, sourceReview);

    const previewContents = await readFile(cachePreviewPath);
    await writeFile(cachePreviewPath, Buffer.concat([previewContents, Buffer.from("stale")]));
    expect((await fetch(previewUrl)).status).toBe(404);
    const changedPreviewListing = await fetch(`${persistentLauncher.url}/api/projects`)
      .then((response) => response.json());
    expect(changedPreviewListing.projects[0]).not.toHaveProperty("gate2ReviewUrl");
    await writeFile(cachePreviewPath, previewContents);

    const appAssetPath = join(runDir, "viewer", "assets", "app.js");
    const appAsset = await readFile(appAssetPath);
    await writeFile(appAssetPath, Buffer.concat([appAsset, Buffer.from("stale")]));
    expect((await fetch(appAssetUrl)).status).toBe(404);
    await writeFile(appAssetPath, appAsset);

    const untrackedPath = join(runDir, "viewer", "assets", "untracked.js");
    await writeFile(untrackedPath, "not in snapshot manifest");
    expect((await fetch(new URL("assets/untracked.js", viewerBase))).status).toBe(404);
    expect((await fetch(new URL("viewer-evidence.json", viewerBase))).status).toBe(404);

    const snapshotReviewPath = join(runDir, "viewer", "review", "index.html");
    const snapshotReview = await readFile(snapshotReviewPath, "utf8");
    await writeFile(snapshotReviewPath, `${snapshotReview}\n<!-- stale snapshot -->\n`);
    const changedSnapshotReview = await fetch(`${persistentLauncher.url}/api/projects`)
      .then((response) => response.json());
    expect(changedSnapshotReview.projects[0]).not.toHaveProperty("gate1ReviewUrl");
    expect(changedSnapshotReview.projects[0]).toHaveProperty("gate2ReviewUrl");
    await writeFile(snapshotReviewPath, snapshotReview);

    const snapshotReviewAssetsDir = join(runDir, "viewer", "review", "assets");
    const [snapshotReviewAssetName] = await readdir(snapshotReviewAssetsDir);
    const snapshotReviewAssetPath = join(snapshotReviewAssetsDir, snapshotReviewAssetName!);
    const snapshotReviewAsset = await readFile(snapshotReviewAssetPath);
    await writeFile(snapshotReviewAssetPath, Buffer.concat([snapshotReviewAsset, Buffer.from("stale")]));
    const changedSnapshotAsset = await fetch(`${persistentLauncher.url}/api/projects`)
      .then((response) => response.json());
    expect(changedSnapshotAsset.projects[0]).not.toHaveProperty("gate1ReviewUrl");
    expect(changedSnapshotAsset.projects[0]).toHaveProperty("gate2ReviewUrl");
    await writeFile(snapshotReviewAssetPath, snapshotReviewAsset);

    const snapshotWorkflowPath = join(runDir, "viewer", "workflow.json");
    const snapshotWorkflow = await readFile(snapshotWorkflowPath, "utf8");
    await writeFile(snapshotWorkflowPath, `${snapshotWorkflow}\n`);
    const changedSnapshotWorkflow = await fetch(`${persistentLauncher.url}/api/projects`)
      .then((response) => response.json());
    expect(changedSnapshotWorkflow.projects[0]).toHaveProperty("gate1ReviewUrl");
    expect(changedSnapshotWorkflow.projects[0]).not.toHaveProperty("gate2ReviewUrl");
    await writeFile(snapshotWorkflowPath, snapshotWorkflow);

    const snapshotIndexPath = join(runDir, "viewer", "index.html");
    const snapshotIndex = await readFile(snapshotIndexPath, "utf8");
    await writeFile(snapshotIndexPath, `${snapshotIndex}\n<!-- stale viewer -->\n`);
    const changedSnapshotIndex = await fetch(`${persistentLauncher.url}/api/projects`)
      .then((response) => response.json());
    expect(changedSnapshotIndex.projects[0]).toHaveProperty("gate1ReviewUrl");
    expect(changedSnapshotIndex.projects[0]).not.toHaveProperty("gate2ReviewUrl");
    await writeFile(snapshotIndexPath, snapshotIndex);

    await writeFile(snapshotIndexPath, Buffer.alloc(WORKFLOW_VIEWER_DOCUMENT_BYTE_LIMIT + 1));
    expect((await fetch(persistentProject.viewerUrl)).status).toBe(404);
    await writeFile(snapshotIndexPath, snapshotIndex);

    await writeFile(snapshotWorkflowPath, Buffer.alloc(WORKFLOW_VIEWER_DOCUMENT_BYTE_LIMIT + 1));
    expect((await fetch(new URL("workflow.json", viewerBase))).status).toBe(404);
    await writeFile(snapshotWorkflowPath, snapshotWorkflow);
    expect((await fetch(persistentProject.gate2ReviewUrl)).status).toBe(200);

    await writeFile(sidecarPath, '{"schema_version":2}\n');
    const invalidSidecar = await fetch(`${persistentLauncher.url}/api/projects`)
      .then((response) => response.json());
    expect(invalidSidecar.projects[0]).not.toHaveProperty("gate1ReviewUrl");
    expect(invalidSidecar.projects[0]).not.toHaveProperty("gate2ReviewUrl");
    expect((await fetch(persistentProject.viewerUrl)).status).toBe(404);

    await writeFile(sidecarPath, "x".repeat(513 * 1024));
    const oversizedSidecar = await fetch(`${persistentLauncher.url}/api/projects`)
      .then((response) => response.json());
    expect(oversizedSidecar.projects[0]).not.toHaveProperty("gate1ReviewUrl");
    expect(oversizedSidecar.projects[0]).not.toHaveProperty("gate2ReviewUrl");
    expect((await fetch(persistentProject.viewerUrl)).status).toBe(404);

    const outsideSidecar = join(fixture.root, "outside-viewer-evidence.json");
    await writeFile(outsideSidecar, JSON.stringify({
      schema_version: 1,
      review_digest: "a".repeat(64),
      gate2_qc_digest: "b".repeat(64),
      viewer_index_digest: "c".repeat(64),
      workflow_digest: "d".repeat(64),
      files: [
        { path: "index.html", size: 0, sha256: "c".repeat(64) },
        { path: "workflow.json", size: 0, sha256: "d".repeat(64) }
      ]
    }));
    await rm(sidecarPath);
    await symlink(outsideSidecar, sidecarPath);
    const linkedSidecar = await fetch(`${persistentLauncher.url}/api/projects`)
      .then((response) => response.json());
    expect(linkedSidecar.projects[0]).not.toHaveProperty("gate1ReviewUrl");
    expect(linkedSidecar.projects[0]).not.toHaveProperty("gate2ReviewUrl");
    expect((await fetch(persistentProject.viewerUrl)).status).toBe(404);
  });

  it("keeps the current Gate 1 review link available when its previous approval is stale", async () => {
    const fixture = await createFixture();
    await writeApprovedGate1State(fixture);
    const configPath = join(fixture.projectDir, "project.yaml");
    await writeFile(join(fixture.projectDir, "media", "review-preview.png"), "updated-review-source");
    const validation = await validateProject(configPath);
    if (!validation.project || !validation.manifest) throw new Error("fixture project is invalid");
    await writeCreativeReview({
      configPath,
      project: validation.project,
      manifest: validation.manifest,
      plan: createPlan(validation.project, validation.manifest)
    });
    await writeState(join(fixture.projectDir, "dist"), {
      run_id: "local-fixture-run",
      status: "running",
      updated_at: "2026-07-19T02:01:00.000Z",
      gates: {
        gate_1: {
          status: "approved",
          updated_at: "2026-07-19T02:01:00.000Z",
          approved_input_digest: "0".repeat(64)
        },
        gate_2: { status: "pending" },
        gate_3: { status: "pending" }
      }
    });
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const project = listing.projects[0];
    expect(project.workflowNodes.find((node: { id: string }) => node.id === "gate-1"))
      .toMatchObject({ status: "error" });

    const refreshResponse = await fetch(`${launcher.url}/api/projects/${project.id}/refresh`, {
      method: "POST",
      headers: { origin: launcher.url, "x-tsugite-token": launcher.token }
    });
    expect(refreshResponse.status).toBe(200);
    const refreshedProject = (await refreshResponse.json()).project;
    expect(refreshedProject).toHaveProperty(
      "gate1ReviewUrl",
      expectedGate1ReviewUrl(launcher, project.id)
    );
    expect(refreshedProject.workflowNodes.find((node: { id: string }) => node.id === "gate-1"))
      .toMatchObject({ status: "error" });
  });

  it("preserves capability issues while allowing the Viewer snapshot to refresh", async () => {
    const fixture = await createFixture();
    const manifestPath = join(fixture.projectDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.presentation = {
      preset: "unsupported-showreel-16x9",
      title: "Unsupported showreel",
      draft: true
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const viewerDir = join(
      fixture.projectDir,
      "dist",
      "local-fixture-run",
      "viewer"
    );
    await mkdir(viewerDir, { recursive: true });
    await writeFile(join(viewerDir, "index.html"), "<!doctype html><p>previous snapshot</p>\n");

    const beforeRefresh = vi.fn();
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0,
      beforeRefresh
    });
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const project = listing.projects[0];

    expect(project).toMatchObject({
      valid: true,
      refreshable: true,
      availableActions: ["validate"],
      workflowNodes: expect.arrayContaining([
        expect.objectContaining({ id: "validate", status: "error" })
      ]),
      hasViewer: true,
      viewerUrl: expectedViewerUrl(launcher, project.id),
      issues: [{
        code: "backend.capability.preset",
        message: "manifest requires presentation preset 'unsupported-showreel-16x9', but backend does not support it"
      }],
      issue: "manifest requires presentation preset 'unsupported-showreel-16x9', but backend does not support it"
    });
    const viewerResponse = await fetch(project.viewerUrl);
    expect(viewerResponse.status).toBe(200);
    await expect(viewerResponse.text()).resolves.toContain("previous snapshot");

    const refreshResponse = await fetch(
      `${launcher.url}/api/projects/${project.id}/refresh`,
      {
        method: "POST",
        headers: { origin: launcher.url, "x-tsugite-token": launcher.token }
      }
    );
    expect(refreshResponse.status).toBe(200);
    expect(beforeRefresh).toHaveBeenCalledOnce();
    await expect(refreshResponse.json()).resolves.toMatchObject({
      ok: true,
      viewerUrl: expectedViewerUrl(launcher, project.id),
      project: {
        refreshable: true,
        issues: [{
          code: "backend.capability.preset",
          message: "manifest requires presentation preset 'unsupported-showreel-16x9', but backend does not support it"
        }]
      }
    });
  });

  it("blocks Viewer refresh for missing files, adapters, and backends", async () => {
    const cases = [
      {
        issueCode: "manifest.clip.src.exists",
        mutate: async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
          await rename(
            join(fixture.projectDir, "media", "clip-001.mp4"),
            join(fixture.projectDir, "media", "clip-001.missing")
          );
        }
      },
      {
        issueCode: "adapter.not_found",
        mutate: async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
          const configPath = join(fixture.projectDir, "project.yaml");
          const config = await readFile(configPath, "utf8");
          await writeFile(configPath, `${config}generation:\n  adapter: missing-adapter\n  requests:\n    - id: missing-adapter-request\n      prompt: fixture prompt\n      model: fixture\n      duration: 1\n      aspect: "16:9"\n      params: {}\n`);
        }
      },
      {
        issueCode: "backend.not_found",
        mutate: async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
          const configPath = join(fixture.projectDir, "project.yaml");
          const config = await readFile(configPath, "utf8");
          await writeFile(configPath, config.replace("backend: remotion", "backend: missing-backend"));
        }
      }
    ];

    for (const testCase of cases) {
      const fixture = await createFixture();
      await testCase.mutate(fixture);
      const beforeRefresh = vi.fn();
      const launcher = await launch({
        projectsDir: fixture.projectsDir,
        bundleDir: fixture.bundleDir,
        port: 0,
        beforeRefresh
      });
      const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
      const project = listing.projects[0];

      expect(project).toMatchObject({
        refreshable: false,
        issues: expect.arrayContaining([{ code: testCase.issueCode, message: expect.any(String) }])
      });
      const response = await fetch(`${launcher.url}/api/projects/${project.id}/refresh`, {
        method: "POST",
        headers: { origin: launcher.url, "x-tsugite-token": launcher.token }
      });
      expect(response.status).toBe(422);
      expect(beforeRefresh).not.toHaveBeenCalled();
    }
  });

  it("marks unsafe project asset paths invalid without discarding a contained snapshot", async () => {
    const fixture = await createFixture();
    const manifestPath = join(fixture.projectDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.clips[0].src = "../outside.mp4";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const viewerDir = join(fixture.projectDir, "dist", "local-fixture-run", "viewer");
    await mkdir(viewerDir, { recursive: true });
    await writeFile(join(viewerDir, "index.html"), "<!doctype html><p>safe snapshot</p>\n");

    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const project = listing.projects[0];

    expect(project).toMatchObject({
      valid: false,
      refreshable: false,
      hasViewer: true,
      issues: [{ code: "manifest.clip.src.safe" }]
    });
    expect(project.issues[0]).not.toHaveProperty("path");
    expect((await fetch(project.viewerUrl)).status).toBe(200);

    const refreshResponse = await fetch(
      `${launcher.url}/api/projects/${project.id}/refresh`,
      {
        method: "POST",
        headers: { origin: launcher.url, "x-tsugite-token": launcher.token }
      }
    );
    expect(refreshResponse.status).toBe(422);
  });

  it("keeps a safe snapshot readable but not refreshable when its state metadata is invalid", async () => {
    const fixture = await createFixture();
    const runDir = join(fixture.projectDir, "dist", "local-fixture-run");
    const viewerDir = join(runDir, "viewer");
    await mkdir(viewerDir, { recursive: true });
    await writeFile(join(viewerDir, "index.html"), "<!doctype html><p>safe snapshot</p>\n");
    await writeFile(join(runDir, "state.json"), "{not-json\n");

    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const project = listing.projects[0];

    expect(project).toMatchObject({
      valid: true,
      refreshable: false,
      status: "error",
      hasViewer: true,
      viewerUrl: expectedViewerUrl(launcher, project.id),
      issues: [{ code: "viewer_launcher.state_invalid", message: expect.any(String) }]
    });
    expect((await fetch(project.viewerUrl)).status).toBe(200);
    const refreshResponse = await fetch(
      `${launcher.url}/api/projects/${project.id}/refresh`,
      {
        method: "POST",
        headers: { origin: launcher.url, "x-tsugite-token": launcher.token }
      }
    );
    expect(refreshResponse.status).toBe(422);
  });

  it("serves only files below the generated Viewer and rejects traversal and unknown ids", async () => {
    const fixture = await createFixture();
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const project = listing.projects[0];
    await fetch(`${launcher.url}/api/projects/${project.id}/refresh`, {
      method: "POST",
      headers: { origin: launcher.url, "x-tsugite-token": launcher.token }
    });

    expect((await fetch(`${launcher.artifactUrl}/viewer/unknown/`)).status).toBe(404);
    expect((await fetch(`${launcher.artifactUrl}/viewer/${project.id}/..%2fstate.json`)).status).toBe(404);
    expect((await fetch(`${launcher.artifactUrl}/viewer/${project.id}/..%2f..%2fproject.yaml`)).status).toBe(404);
  });

  it("closes an opened Viewer artifact when request validation throws", async () => {
    const fixture = await createFixture();
    const viewerDir = join(fixture.projectDir, "dist", "local-fixture-run", "viewer");
    const indexPath = join(viewerDir, "index.html");
    await mkdir(viewerDir, { recursive: true });
    await writeFile(indexPath, "<!doctype html><p>safe viewer</p>\n");
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0,
      beforeServeArtifact: () => {
        throw new Error("injected validation failure");
      }
    });
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());

    expect((await fetch(listing.projects[0].viewerUrl)).status).toBe(500);
    await expect(rm(indexPath)).resolves.toBeUndefined();
  });

  it("serves the pinned viewer handle and rejects later artifacts after a run symlink swap", async () => {
    const fixture = await createFixture();
    const runDir = join(fixture.projectDir, "dist", "local-fixture-run");
    const viewerDir = join(runDir, "viewer");
    const thumbnailDir = join(runDir, "qa");
    await mkdir(viewerDir, { recursive: true });
    await mkdir(thumbnailDir, { recursive: true });
    await writeFile(join(viewerDir, "index.html"), "<!doctype html><p>safe viewer</p>\n");
    await writeFile(join(thumbnailDir, "contact-sheet.png"), "safe-thumbnail");
    const outsideRunDir = join(fixture.root, "outside-run");
    await mkdir(join(outsideRunDir, "viewer"), { recursive: true });
    await mkdir(join(outsideRunDir, "qa"), { recursive: true });
    await writeFile(join(outsideRunDir, "viewer", "index.html"), "external viewer\n");
    await writeFile(join(outsideRunDir, "qa", "contact-sheet.png"), "external-thumbnail");
    let swapBlockedByWindows = false;
    const beforeServeArtifact = vi.fn(async () => {
      try {
        await rename(runDir, join(fixture.projectDir, "dist", "local-fixture-run-original"));
        await symlink(outsideRunDir, runDir);
      } catch (error) {
        const code = error instanceof Error && "code" in error
          ? String((error as NodeJS.ErrnoException).code)
          : "";
        if (process.platform === "win32" && ["EACCES", "EBUSY", "EPERM"].includes(code)) {
          swapBlockedByWindows = true;
          return;
        }
        throw error;
      }
    });
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0,
      beforeServeArtifact
    });
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const project = listing.projects[0];

    const pinnedViewer = await fetch(project.viewerUrl);
    expect(beforeServeArtifact).toHaveBeenCalledOnce();

    if (swapBlockedByWindows) {
      expect(pinnedViewer.status).toBe(200);
      await expect(pinnedViewer.text()).resolves.toContain("safe viewer");
      const stillPinnedViewer = await fetch(project.viewerUrl);
      expect(stillPinnedViewer.status).toBe(200);
      await expect(stillPinnedViewer.text()).resolves.toContain("safe viewer");
      const stillPinnedThumbnail = await fetch(project.thumbnailUrl);
      expect(stillPinnedThumbnail.status).toBe(200);
      await expect(stillPinnedThumbnail.text()).resolves.toBe("safe-thumbnail");
      return;
    }

    expect(pinnedViewer.status).toBe(404);
    expect((await fetch(project.viewerUrl)).status).toBe(404);
    expect((await fetch(project.thumbnailUrl)).status).toBe(404);
  });

  it("rejects approval and refresh writes after the project identity is replaced", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.projectDir, "feedback.jsonl"), `${JSON.stringify({
      schema_version: 1,
      id: "proposal-record",
      created_at: "2026-07-17T10:00:00.000Z",
      key: "opening-audio",
      category: "sound",
      signal: "prefer",
      stage: "recurring",
      summary: "Start the soundtrack at frame zero",
      evidence: ["dist/local-fixture-run/gate3-qc.json"],
      promotion_proposal: {
        id: "opening-audio-v1",
        kind: "qa",
        target: "src/orchestrator/gate3Qc.ts",
        change_summary: "Add an opening-audio Gate 3 check",
        verification: "Confirm the check on a later project",
        decision: "pending"
      }
    })}\n`);
    const writeViewer = vi.fn();
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0,
      writeViewer
    });
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const project = listing.projects[0];
    const outsideProject = join(fixture.root, "outside-project");
    await cp(fixture.projectDir, outsideProject, { recursive: true });
    await rename(fixture.projectDir, join(fixture.projectsDir, "valid-project-original"));
    await symlink(outsideProject, fixture.projectDir);
    const headers = {
      origin: launcher.url,
      "content-type": "application/json",
      "x-tsugite-token": launcher.token
    };

    const decisionResponse = await fetch(
      `${launcher.url}/api/feedback/${project.id}/promotion-decision`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          key: "opening-audio",
          proposalId: "opening-audio-v1",
          decision: "approved"
        })
      }
    );
    expect(decisionResponse.status).toBe(422);
    await expect(decisionResponse.json()).resolves.toMatchObject({
      ok: false,
      issue: { code: "viewer_launcher.project_changed" }
    });
    const refreshResponse = await fetch(`${launcher.url}/api/projects/${project.id}/refresh`, {
      method: "POST",
      headers
    });
    expect(refreshResponse.status).toBe(422);
    await expect(refreshResponse.json()).resolves.toMatchObject({
      ok: false,
      issue: { code: "viewer_launcher.project_changed" }
    });
    expect(writeViewer).not.toHaveBeenCalled();
    const outsideRecords = (await readFile(join(outsideProject, "feedback.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(outsideRecords).toHaveLength(1);
    expect(outsideRecords[0].promotion_proposal).toMatchObject({ decision: "pending" });
  });

  it("rejects approval when feedback.jsonl is replaced after the launcher loads it", async () => {
    const fixture = await createFixture();
    const feedbackPath = join(fixture.projectDir, "feedback.jsonl");
    const pendingRecord = `${JSON.stringify({
      schema_version: 1,
      id: "proposal-record",
      created_at: "2026-07-17T10:00:00.000Z",
      key: "opening-audio",
      category: "sound",
      signal: "prefer",
      stage: "recurring",
      summary: "Start the soundtrack at frame zero",
      evidence: ["dist/local-fixture-run/gate3-qc.json"],
      promotion_proposal: {
        id: "opening-audio-v1",
        kind: "qa",
        target: "src/orchestrator/gate3Qc.ts",
        change_summary: "Add an opening-audio Gate 3 check",
        verification: "Confirm the check on a later project",
        decision: "pending"
      }
    })}\n`;
    await writeFile(feedbackPath, pendingRecord);
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const project = listing.projects[0];
    await rename(feedbackPath, join(fixture.projectDir, "feedback-original.jsonl"));
    await writeFile(feedbackPath, pendingRecord);

    const response = await fetch(
      `${launcher.url}/api/feedback/${project.id}/promotion-decision`,
      {
        method: "POST",
        headers: {
          origin: launcher.url,
          "content-type": "application/json",
          "x-tsugite-token": launcher.token
        },
        body: JSON.stringify({
          key: "opening-audio",
          proposalId: "opening-audio-v1",
          decision: "approved"
        })
      }
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      issue: { code: "feedback.file_changed" }
    });
    expect(await readFile(feedbackPath, "utf8")).toBe(pendingRecord);
  });

  it("rejects a refreshed snapshot when project identity changes inside the writer", async () => {
    const fixture = await createFixture();
    const configPath = join(fixture.projectDir, "project.yaml");
    const configContents = await readFile(configPath, "utf8");
    const writeViewer = vi.fn(async (options: { outputDir?: string }) => {
      expect(options.outputDir).toBeUndefined();
      await rename(configPath, join(fixture.projectDir, "project-original.yaml"));
      await writeFile(configPath, configContents);
      const outputDir = join(fixture.projectDir, "dist", "local-fixture-run", "viewer");
      return {
        viewerPath: join(outputDir, "index.html"),
        workflowPath: join(outputDir, "workflow.json"),
        outputDir,
        stateFound: false
      };
    });
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0,
      writeViewer
    });
    expect(launcher.privateRoot).toBeUndefined();
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const project = listing.projects[0];

    const response = await fetch(`${launcher.url}/api/projects/${project.id}/refresh`, {
      method: "POST",
      headers: { origin: launcher.url, "x-tsugite-token": launcher.token }
    });

    expect(writeViewer).toHaveBeenCalledOnce();
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      issue: { code: "viewer_launcher.project_changed" }
    });
  });

  it("closes both launcher and artifact origins", async () => {
    const fixture = await createFixture();
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });

    await Promise.all([launcher.close(), launcher.close(), launcher.closed]);

    await expect(fetch(launcher.url)).rejects.toThrow();
    await expect(fetch(launcher.artifactUrl)).rejects.toThrow();
  });

  it("isolates default refresh output from a persistent viewer symlink and cleans it on close", async () => {
    const fixture = await createFixture();
    const runDir = join(fixture.projectDir, "dist", "local-fixture-run");
    const externalViewer = join(fixture.root, "external-viewer");
    await mkdir(runDir, { recursive: true });
    await mkdir(externalViewer);
    await writeFile(join(externalViewer, "sentinel.txt"), "unchanged\n");
    await symlink(externalViewer, join(runDir, "viewer"));
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });
    const privateRoot = launcher.privateRoot!;
    const privateRootStats = await lstat(privateRoot);
    expect(privateRootStats.isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect(privateRootStats.mode & 0o777).toBe(0o700);
    }

    const initialListing = await fetch(`${launcher.url}/api/projects`)
      .then((response) => response.json());
    const project = initialListing.projects[0];
    expect(project).toMatchObject({ valid: true, refreshable: true, hasViewer: false });

    const refreshResponse = await fetch(`${launcher.url}/api/projects/${project.id}/refresh`, {
      method: "POST",
      headers: { origin: launcher.url, "x-tsugite-token": launcher.token }
    });
    expect(refreshResponse.status).toBe(200);
    const refreshed = await refreshResponse.json();
    expect((await lstat(join(runDir, "viewer"))).isSymbolicLink()).toBe(true);
    expect(await readdir(externalViewer)).toEqual(["sentinel.txt"]);
    expect((await fetch(refreshed.viewerUrl)).status).toBe(200);

    const reloadedListing = await fetch(`${launcher.url}/api/projects`)
      .then((response) => response.json());
    expect(reloadedListing.projects[0]).toMatchObject({
      id: project.id,
      hasViewer: true,
      viewerUrl: refreshed.viewerUrl
    });
    expect((await fetch(reloadedListing.projects[0].viewerUrl)).status).toBe(200);
    const privateEntries = await readdir(privateRoot, { recursive: true });
    expect(privateEntries.some((entry) => entry.endsWith("index.html"))).toBe(true);

    await launcher.close();
    await launcher.closed;
    await expect(lstat(privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(externalViewer)).toEqual(["sentinel.txt"]);
  });

  it("does not let an overlapping project reload replace a newly refreshed Viewer snapshot", async () => {
    const fixture = await createFixture();
    let pauseNextReload = false;
    let markReloadStarted!: () => void;
    let releaseReload!: () => void;
    const reloadStarted = new Promise<void>((resolve) => {
      markReloadStarted = resolve;
    });
    const reloadReleased = new Promise<void>((resolve) => {
      releaseReload = resolve;
    });
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0,
      beforeProjectReloadCommit: async () => {
        if (!pauseNextReload) return;
        markReloadStarted();
        await reloadReleased;
      }
    });
    const initialListing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const project = initialListing.projects[0];
    expect(project).toMatchObject({ hasViewer: false, refreshable: true });

    pauseNextReload = true;
    const overlappingReload = fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    await reloadStarted;

    const refreshResponse = await fetch(`${launcher.url}/api/projects/${project.id}/refresh`, {
      method: "POST",
      headers: { origin: launcher.url, "x-tsugite-token": launcher.token }
    });
    expect(refreshResponse.status).toBe(200);
    const refreshed = await refreshResponse.json();
    releaseReload();

    const reloaded = await overlappingReload;
    expect(reloaded.projects[0]).toMatchObject({
      id: project.id,
      hasViewer: true,
      viewerUrl: refreshed.viewerUrl
    });
    expect((await fetch(reloaded.projects[0].viewerUrl)).status).toBe(200);
  });

  it("refuses a project whose dist path is redirected through a symlink", async () => {
    const fixture = await createFixture();
    const outside = join(fixture.root, "outside");
    await mkdir(outside);
    await symlink(outside, join(fixture.projectDir, "dist"));
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const project = listing.projects[0];

    expect(project).toMatchObject({ valid: false, status: "error", hasViewer: false });
    expect(project.issue).toMatch(/outside the project|symbolic link/i);
    const response = await fetch(`${launcher.url}/api/projects/${project.id}/refresh`, {
      method: "POST",
      headers: { origin: launcher.url, "x-tsugite-token": launcher.token }
    });
    expect(response.status).toBe(422);
    await expect(readFile(join(outside, "local-fixture-run", "viewer", "index.html"), "utf8"))
      .rejects.toThrow();
  });

  it("rejects a second refresh while the same project is already refreshing", async () => {
    const fixture = await createFixture();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0,
      beforeRefresh: () => paused
    });
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const project = listing.projects[0];
    const headers = { origin: launcher.url, "x-tsugite-token": launcher.token };
    const first = fetch(`${launcher.url}/api/projects/${project.id}/refresh`, {
      method: "POST",
      headers
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await fetch(`${launcher.url}/api/projects/${project.id}/refresh`, {
      method: "POST",
      headers
    });
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({
      ok: false,
      issue: { code: "viewer_launcher.refresh_in_progress" }
    });
    release();
    expect((await first).status).toBe(200);
  });

  it("exposes fixed workflow nodes and refreshes one selected project after an external CLI state change", async () => {
    const fixture = await createFixture();
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const project = listing.projects[0];

    expect(project.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(project.availableActions).toEqual(["validate", "plan", "review", "dry-run"]);
    expect(project.workflowNodes.map((node: { id: string }) => node.id)).toEqual([
      "validate", "plan", "review", "gate-1", "run", "gate-2", "render", "gate-3"
    ]);
    expect(project.workflowNodes.find((node: { id: string }) => node.id === "run"))
      .toMatchObject({ status: "pending", action: "run" });

    await writeApprovedGate1State(fixture);
    const statusUrl = `${launcher.url}/api/projects/${project.id}/status`;
    expect((await fetch(statusUrl)).status).toBe(403);
    const statusResponse = await fetch(statusUrl, {
      headers: { "x-tsugite-token": launcher.token }
    });
    const statusPayload = await statusResponse.json();

    expect(statusResponse.status).toBe(200);
    expect(statusPayload).toMatchObject({ ok: true, job: null });
    expect(statusPayload.project.revision).not.toBe(project.revision);
    expect(statusPayload.project.availableActions).toContain("run");
    expect(statusPayload.project.workflowNodes.find((node: { id: string }) => node.id === "gate-1"))
      .toMatchObject({ status: "completed" });
    expect(statusPayload.project.workflowNodes.find((node: { id: string }) => node.id === "run"))
      .toMatchObject({ status: "pending" });
  });

  it("changes the approval revision when reviewed media or final video bytes change", async () => {
    const fixture = await createFixture();
    const configPath = join(fixture.projectDir, "project.yaml");
    const manifestPath = join(fixture.projectDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
    manifest.images = [{ id: "review-preview", src: "media/review-preview.png", alt: "review preview" }];
    manifest.speakers = [{
      id: "review-speaker",
      display_name: "Review speaker",
      side: "left",
      accent: "#334455",
      poses: { neutral: "review-preview" }
    }];
    await writeFile(join(fixture.projectDir, "media", "review-preview.png"), "reviewed-image-v1");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const validation = await validateProject(configPath);
    if (!validation.project || !validation.manifest) throw new Error("fixture project is invalid");
    const project: Project = validation.project;
    const normalizedManifest = validation.manifest;
    await writeCreativeReview({
      configPath,
      project,
      manifest: normalizedManifest,
      plan: createPlan(project, normalizedManifest)
    });
    const runDir = join(fixture.projectDir, "dist", "local-fixture-run");
    await writeFile(join(runDir, "render-report.json"), "{}\n");
    await writeFile(join(runDir, "gate3-qc.json"), "{}\n");
    await writeFile(join(runDir, "final.mp4"), "final-video-v1");
    const reviewed = await inspectGate1Review({
      configPath,
      project,
      manifest: normalizedManifest
    });
    if (!reviewed.ok || !reviewed.approvalDigest) throw new Error("fixture review is invalid");
    await writeState(join(fixture.projectDir, "dist"), {
      run_id: "local-fixture-run",
      status: "running",
      updated_at: "2026-07-19T02:00:00.000Z",
      gates: {
        gate_1: { status: "approved", approved_input_digest: reviewed.approvalDigest },
        gate_2: { status: "pending" },
        gate_3: { status: "pending" }
      }
    });

    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const first = listing.projects[0];
    expect(first.availableActions).toContain("run");

    await writeFile(join(fixture.projectDir, "media", "review-preview.png"), "reviewed-image-source-v2");
    const afterSourceChange = await fetch(`${launcher.url}/api/projects/${first.id}/status`, {
      headers: { "x-tsugite-token": launcher.token }
    })
      .then((response) => response.json());
    expect(afterSourceChange.project.revision).not.toBe(first.revision);
    expect(afterSourceChange.project.availableActions).not.toContain("run");
    expect(afterSourceChange.project.availableActions).toContain("gate-1-revise");

    const reviewAssetsDir = join(runDir, "review", "assets");
    const [reviewAsset] = await readdir(reviewAssetsDir);
    await writeFile(join(reviewAssetsDir, reviewAsset!), "reviewed-image-v2");
    const afterReviewChange = await fetch(`${launcher.url}/api/projects/${first.id}/status`, {
      headers: { "x-tsugite-token": launcher.token }
    })
      .then((response) => response.json());
    expect(afterReviewChange.project.revision).not.toBe(afterSourceChange.project.revision);
    expect(afterReviewChange.project.availableActions).not.toContain("run");
    expect(afterReviewChange.project.availableActions).toContain("gate-1-revise");
    expect(afterReviewChange.project.workflowNodes.find((node: { id: string }) => node.id === "gate-1"))
      .toMatchObject({ status: "error" });

    await writeFile(join(runDir, "final.mp4"), "final-video-v2");
    const afterFinalChange = await fetch(`${launcher.url}/api/projects/${first.id}/status`, {
      headers: { "x-tsugite-token": launcher.token }
    })
      .then((response) => response.json());
    expect(afterFinalChange.project.revision).not.toBe(afterReviewChange.project.revision);
  });

  it("keeps completed upstream nodes visible after Gate 2 or Gate 3 aborts", async () => {
    const fixture = await createFixture();
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const project = listing.projects[0];
    const stateDir = join(fixture.projectDir, "dist");

    await writeState(stateDir, {
      run_id: project.runId,
      status: "aborted",
      updated_at: "2026-07-19T03:00:00.000Z",
      gates: {
        gate_1: { status: "approved" },
        gate_2: { status: "abort" },
        gate_3: { status: "pending" }
      }
    });
    const gate2 = await fetch(`${launcher.url}/api/projects/${project.id}/status`, {
      headers: { "x-tsugite-token": launcher.token }
    })
      .then((response) => response.json());
    expect(gate2.project.workflowNodes.find((node: { id: string }) => node.id === "run"))
      .toMatchObject({ status: "completed" });
    expect(gate2.project.workflowNodes.find((node: { id: string }) => node.id === "gate-2"))
      .toMatchObject({ status: "error" });

    await writeState(stateDir, {
      run_id: project.runId,
      status: "aborted",
      updated_at: "2026-07-19T03:01:00.000Z",
      gates: {
        gate_1: { status: "approved" },
        gate_2: { status: "approved" },
        gate_3: { status: "abort" }
      }
    });
    const gate3 = await fetch(`${launcher.url}/api/projects/${project.id}/status`, {
      headers: { "x-tsugite-token": launcher.token }
    })
      .then((response) => response.json());
    expect(gate3.project.workflowNodes.find((node: { id: string }) => node.id === "run"))
      .toMatchObject({ status: "completed" });
    expect(gate3.project.workflowNodes.find((node: { id: string }) => node.id === "render"))
      .toMatchObject({ status: "completed" });
    expect(gate3.project.workflowNodes.find((node: { id: string }) => node.id === "gate-3"))
      .toMatchObject({ status: "error" });
  });

  it("keeps project viewing available while project action APIs are disabled", async () => {
    const fixture = await createFixture();
    const executePipeline = vi.fn();
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0,
      allowProjectActions: false,
      executePipeline
    });
    const listingResponse = await fetch(`${launcher.url}/api/projects`);
    expect(listingResponse.status).toBe(200);
    const listing = await listingResponse.json();
    const project = listing.projects[0];
    expect(project).toMatchObject({ valid: true, refreshable: true });

    const statusResponse = await fetch(`${launcher.url}/api/projects/${project.id}/status`, {
      headers: { "x-tsugite-token": launcher.token }
    });
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      ok: true,
      project: { id: project.id }
    });

    const endpoint = `${launcher.url}/api/projects/${project.id}/action`;
    expect((await fetch(endpoint, {
      headers: { "x-tsugite-token": launcher.token }
    })).status).toBe(404);
    expect((await fetch(endpoint, {
      method: "POST",
      headers: {
        origin: launcher.url,
        "content-type": "application/json",
        "x-tsugite-token": launcher.token
      },
      body: JSON.stringify({
        action: "validate",
        expectedRunId: project.runId,
        revision: project.revision
      })
    })).status).toBe(404);
    expect(executePipeline).not.toHaveBeenCalled();
  });

  it("runs only fresh available allowlisted actions and passes coordinator arguments without a shell", async () => {
    const fixture = await createFixture();
    await writeApprovedGate1State(fixture);
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0,
      executePipeline: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        const inheritedToken = options.env?.[RUN_LOCK_INHERIT_ENV];
        expect(inheritedToken).toMatch(/^[0-9a-f-]{36}$/i);
        await expect(acquireRunLock(join(fixture.projectDir, "dist"), "local-fixture-run"))
          .rejects.toMatchObject({ code: "run.locked" });
        const inherited = await acquireRunLock(
          join(fixture.projectDir, "dist"),
          "local-fixture-run",
          inheritedToken
        );
        await inherited.release();
        await paused;
        return {
          exitCode: 0,
          stdout: [
            join(fixture.projectDir, "project.yaml"),
            "token=super-secret",
            "AWS_SECRET_ACCESS_KEY=aws-secret-value",
            "DATABASE_URL=postgres://db-user:db-password@example.invalid/database",
            "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "JWT=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signaturevalue",
            "authorization=Basic dXNlcjpwYXNzd29yZA==",
            "private_key=-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----",
            "-----BEGIN ENCRYPTED PRIVATE KEY-----\nencrypted-private-key-material\n-----END ENCRYPTED PRIVATE KEY-----",
            "Cookie: sessionid=session-secret; csrf_token=csrf-secret",
            join(homedir(), ".config", "provider", "credentials"),
            "x".repeat(20_000)
          ].join("\n"),
          stderr: ""
        };
      }
    });
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const project = listing.projects[0];
    const endpoint = `${launcher.url}/api/projects/${project.id}/action`;
    const headers = {
      origin: launcher.url,
      "content-type": "application/json",
      "x-tsugite-token": launcher.token
    };
    const fresh = {
      action: "run",
      expectedRunId: project.runId,
      revision: project.revision,
      confirmed: true
    };

    expect((await fetch(endpoint, { method: "POST", body: JSON.stringify(fresh) })).status).toBe(403);
    expect((await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...fresh, confirmed: undefined })
    })).status).toBe(400);
    const staleResponse = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...fresh, revision: "0".repeat(64) })
    });
    expect(staleResponse.status).toBe(409);
    await expect(staleResponse.json()).resolves.toMatchObject({
      issue: { code: "viewer_launcher.project_stale" }
    });

    const concurrent = await Promise.all([0, 1].map(() => fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(fresh)
    })));
    expect(concurrent.map((response) => response.status).sort()).toEqual([202, 409]);
    const started = concurrent.find((response) => response.status === 202);
    const duplicate = concurrent.find((response) => response.status === 409);
    if (!started || !duplicate) throw new Error("expected one started and one conflicting action");
    expect(started.status).toBe(202);
    await expect(started.json()).resolves.toMatchObject({
      ok: true,
      job: { action: "run", status: "running", id: expect.any(String) }
    });
    // Windows runners can take longer to start the guarded action after the HTTP response.
    for (let attempt = 0; attempt < 100 && calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe(process.execPath);
    expect(calls[0]!.args[0]).toMatch(/bin[\\/]pipeline$/);
    expect(calls[0]!.args.slice(1)).toEqual([
      "run",
      "--config", join(fixture.projectDir, "project.yaml"),
      "--actor", "coordinator",
      "--json"
    ]);
    expect(JSON.stringify(calls[0])).not.toContain(launcher.token);

    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({
      issue: { code: "viewer_launcher.job_in_progress" }
    });

    release();
    let completed: { job?: LauncherJob } | undefined;
    expect((await fetch(endpoint)).status).toBe(403);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      completed = await fetch(endpoint, {
        headers: { "x-tsugite-token": launcher.token }
      }).then((response) => response.json());
      if (completed.job?.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(completed?.job).toMatchObject({ status: "succeeded", exitCode: 0 });
    const stdout = completed?.job?.stdout ?? "";
    expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(16 * 1024);
    expect(stdout).not.toContain(fixture.projectDir);
    expect(stdout).not.toContain("super-secret");
    expect(stdout).not.toContain("aws-secret-value");
    expect(stdout).not.toContain("db-password");
    expect(stdout).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(stdout).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(stdout).not.toContain("dXNlcjpwYXNzd29yZA");
    expect(stdout).not.toContain("private-key-material");
    expect(stdout).not.toContain("encrypted-private-key-material");
    expect(stdout).not.toContain("session-secret");
    expect(stdout).not.toContain("csrf-secret");
    expect(stdout).not.toContain(homedir());
    expect(stdout).toContain("[output truncated]");
  });

  it("rejects unavailable Gate actions even when the request is authenticated and confirmed", async () => {
    const fixture = await createFixture();
    const executePipeline = vi.fn();
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0,
      executePipeline
    });
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const project = listing.projects[0];
    const response = await fetch(`${launcher.url}/api/projects/${project.id}/action`, {
      method: "POST",
      headers: {
        origin: launcher.url,
        "content-type": "application/json",
        "x-tsugite-token": launcher.token
      },
      body: JSON.stringify({
        action: "gate-2-approve-all",
        expectedRunId: project.runId,
        revision: project.revision,
        confirmed: true
      })
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      issue: { code: "viewer_launcher.action_unavailable" }
    });
    expect(executePipeline).not.toHaveBeenCalled();
  });

  it("rejects an old revision after the project config is overwritten in the same inode", async () => {
    const fixture = await createFixture();
    const executePipeline = vi.fn();
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0,
      executePipeline
    });
    const listing = await fetch(`${launcher.url}/api/projects`).then((response) => response.json());
    const project = listing.projects[0];
    const configPath = join(fixture.projectDir, "project.yaml");
    const before = await lstat(configPath);
    await writeFile(configPath, `${await readFile(configPath, "utf8")}# changed after display\n`);
    const after = await lstat(configPath);
    expect(after.ino).toBe(before.ino);

    const response = await fetch(`${launcher.url}/api/projects/${project.id}/action`, {
      method: "POST",
      headers: {
        origin: launcher.url,
        "content-type": "application/json",
        "x-tsugite-token": launcher.token
      },
      body: JSON.stringify({
        action: "validate",
        expectedRunId: project.runId,
        revision: project.revision
      })
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      issue: { code: "viewer_launcher.project_stale" }
    });
    expect(executePipeline).not.toHaveBeenCalled();
  });
});
