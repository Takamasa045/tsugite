import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlannedState, writeState } from "../src/orchestrator/state.js";
import {
  startWorkflowViewerLauncher,
  type WorkflowViewerLauncher
} from "../src/viewer/launcher.js";

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
  return { root, projectsDir, templatesDir, projectDir, bundleDir };
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

describe("workflow viewer launcher", () => {
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
          promotion: { kind: "qa", target: "src/orchestrator/gate3Qc.ts" },
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
      `img-src 'self' data: blob: ${launcher.artifactUrl}`
    );
    expect(rootHtml).toContain('<meta name="tsugite-launcher" content="true">');
    expect(rootHtml).toContain(
      `<meta name="tsugite-launcher-token" content="${launcher.token}">`
    );
    await expect(fetch(`${launcher.url}/assets/app.js`).then((response) => response.text()))
      .resolves.toContain("viewerLoaded");

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
      thumbnailUrl: `${launcher.artifactUrl}/thumbnail/${valid.id}`,
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
    const thumbnailResponse = await fetch(valid.thumbnailUrl);
    expect(thumbnailResponse.headers.get("access-control-allow-origin")).toBeNull();
    await expect(thumbnailResponse.text())
      .resolves.toBe("thumbnail-image");
    expect((await fetch(valid.thumbnailUrl, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(`${launcher.url}/thumbnail/${valid.id}`)).status).toBe(404);
    expect((await fetch(launcher.artifactUrl)).status).toBe(404);
    expect((await fetch(`${launcher.artifactUrl}/api/feedback`)).status).toBe(404);
    expect((await fetch(`${launcher.artifactUrl}/assets/app.js`)).status).toBe(404);

    await expect(statusWithHost(launcher.url, "viewer.attacker.invalid")).resolves.toBe(403);
    await expect(statusWithHost(launcher.artifactUrl, "viewer.attacker.invalid")).resolves.toBe(403);
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

  it("requires the launcher token and same origin before refreshing a snapshot", async () => {
    const fixture = await createFixture();
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      bundleDir: fixture.bundleDir,
      port: 0
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

    const refreshed = await fetch(`${launcher.url}/api/projects/${project.id}/refresh`, {
      method: "POST",
      headers: {
        origin: launcher.url,
        "x-tsugite-token": launcher.token
      }
    });
    const payload = await refreshed.json();
    expect(refreshed.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      viewerUrl: `${launcher.artifactUrl}/viewer/${project.id}/`,
      project: {
        id: project.id,
        hasViewer: true,
        valid: true,
        viewerUrl: `${launcher.artifactUrl}/viewer/${project.id}/`
      }
    });
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
    expect(reviewResponse.status).toBe(200);
    expect(reviewResponse.headers.get("content-security-policy")).toBe(
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    );

    const statePath = join(fixture.projectDir, "dist", "local-fixture-run", "state.json");
    await expect(readFile(statePath, "utf8")).rejects.toThrow();
  });

  it("reports complete validation issues before refresh while keeping an existing snapshot readable", async () => {
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
      refreshable: false,
      hasViewer: true,
      viewerUrl: `${launcher.artifactUrl}/viewer/${project.id}/`,
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
    expect(refreshResponse.status).toBe(422);
    expect(beforeRefresh).not.toHaveBeenCalled();
    await expect(refreshResponse.json()).resolves.toMatchObject({
      ok: false,
      issue: {
        code: "viewer_launcher.project_invalid",
        message: "manifest requires presentation preset 'unsupported-showreel-16x9', but backend does not support it"
      }
    });
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
      viewerUrl: `${launcher.artifactUrl}/viewer/${project.id}/`,
      issues: [{ code: "viewer_launcher.state_invalid", message: expect.any(String) }]
    });
    expect((await fetch(project.viewerUrl)).status).toBe(200);
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
    const beforeServeArtifact = vi.fn(async () => {
      await rename(runDir, join(fixture.projectDir, "dist", "local-fixture-run-original"));
      await symlink(outsideRunDir, runDir);
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
    expect(pinnedViewer.status).toBe(200);
    await expect(pinnedViewer.text()).resolves.toContain("safe viewer");
    expect(beforeServeArtifact).toHaveBeenCalledOnce();

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
    expect(privateRootStats.mode & 0o777).toBe(0o700);

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
});
