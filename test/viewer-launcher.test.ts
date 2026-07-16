import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    await mkdir(invalidDir);
    await writeFile(join(invalidDir, "project.yaml"), "slug: [invalid\n");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(nestedDir, "project.yaml"), "slug: nested\n");
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
      valid: true
    });
    expect(valid.id).not.toBe("valid-project");
    expect(valid.id).not.toBe("local-fixture");
    const invalid = payload.projects.find((project: { name: string }) => project.name === "invalid-project");
    expect(invalid).toMatchObject({ valid: false, status: "error", hasViewer: false });
    expect(invalid.issue).toEqual(expect.any(String));

    await expect(statusWithHost(launcher.url, "viewer.attacker.invalid")).resolves.toBe(403);
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
