import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    const rootResponse = await fetch(launcher.url);
    const rootHtml = await rootResponse.text();
    expect(rootResponse.status).toBe(200);
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
      thumbnailUrl: `/thumbnail/${valid.id}`,
      valid: true
    });
    expect(valid.id).not.toBe("valid-project");
    expect(valid.id).not.toBe("local-fixture");
    const invalid = payload.projects.find((project: { name: string }) => project.name === "invalid-project");
    expect(invalid).toMatchObject({ valid: false, status: "error", hasViewer: false });
    expect(invalid.issue).toEqual(expect.any(String));
    await expect(fetch(`${launcher.url}${valid.thumbnailUrl}`).then((response) => response.text()))
      .resolves.toBe("thumbnail-image");

    await expect(statusWithHost(launcher.url, "viewer.attacker.invalid")).resolves.toBe(403);
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
      viewerUrl: `/viewer/${project.id}/`,
      project: { id: project.id, hasViewer: true, valid: true }
    });
    const viewerResponse = await fetch(`${launcher.url}${payload.viewerUrl}`);
    expect(viewerResponse.status).toBe(200);
    await expect(viewerResponse.text()).resolves.toContain('id="tsugite-workflow-data"');

    const statePath = join(fixture.projectDir, "dist", "local-fixture-run", "state.json");
    await expect(readFile(statePath, "utf8")).rejects.toThrow();
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

    expect((await fetch(`${launcher.url}/viewer/unknown/`)).status).toBe(404);
    expect((await fetch(`${launcher.url}/viewer/${project.id}/..%2fstate.json`)).status).toBe(404);
    expect((await fetch(`${launcher.url}/viewer/${project.id}/..%2f..%2fproject.yaml`)).status).toBe(404);
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
