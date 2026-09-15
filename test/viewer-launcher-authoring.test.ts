import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthoringEngineRun, digestAuthoringRun } from "../src/productionControl/authoringEngine.js";
import {
  startWorkflowViewerLauncher,
  type WorkflowViewerLauncher
} from "../src/viewer/launcher.js";

const launchers: WorkflowViewerLauncher[] = [];

afterEach(async () => {
  await Promise.all(launchers.splice(0).map((launcher) => launcher.close()));
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeAuthoringLauncherFixture() {
  const root = await mkdtemp(join(tmpdir(), "tsugite-authoring-launcher-"));
  const projectsDir = join(root, "projects");
  const templatesDir = join(root, "templates");
  const projectDir = join(projectsDir, "authoring-lab");
  const bundleDir = join(root, "bundle");
  const workspace = join(projectDir, "hypit-workspace");
  await mkdir(projectsDir, { recursive: true });
  await mkdir(templatesDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(join(projectDir, ".tsugite", "authoring"), { recursive: true });
  await mkdir(join(projectDir, "dist", "authoring-lab", "review"), { recursive: true });
  await mkdir(join(bundleDir, "assets"), { recursive: true });
  await writeFile(
    join(bundleDir, "index.html"),
    "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>\n"
  );
  await writeFile(join(bundleDir, "assets", "app.js"), "globalThis.authoringLauncher = true;\n");
  const source = "authored\n";
  await writeFile(join(workspace, "main.svml"), source);
  const { digest: _digest, ...runBase } = createAuthoringEngineRun({
    production_id: "authoring-lab",
    adapter_id: "authoring-adapter",
    brief_digest: sha256("brief"),
    import_allowlist_digest: sha256("allow")
  });
  const run = digestAuthoringRun({
    ...runBase,
    source_files: [{ relative_path: "main.svml", sha256: sha256(source), bytes: Buffer.byteLength(source) }]
  });
  await writeFile(
    join(projectDir, ".tsugite", "authoring", "state.json"),
    `${JSON.stringify({ workspace, run, ui: { progress: "plan-ready", fake: false } }, null, 2)}\n`
  );
  await writeFile(join(projectDir, "manifest.json"), JSON.stringify({
    meta: { aspect: "9:16", fps: 30, target_duration_seconds: 30, slug: "authoring-lab" },
    clips: [],
    audio: { bgm: [], narration: [], sfx: [] }
  }));
  await writeFile(join(projectDir, "project.yaml"), [
    "slug: authoring-lab",
    "name: 制作エンジン案件",
    "run_id: authoring-lab",
    "production:",
    "  kind: authoring",
    "  adapter: hypit",
    "  state: .tsugite/authoring/state.json",
    "  workspace: hypit-workspace",
    "manifest: manifest.json",
    "dist_dir: dist",
    "edit:",
    "  backend: remotion"
  ].join("\n"));
  await writeFile(
    join(projectDir, "dist", "authoring-lab", "review", "review-data.json"),
    `${JSON.stringify({
      format: "tsugite.production-review@1",
      identity: { slug: "authoring-lab", run_id: "authoring-lab", name: "制作エンジン案件" },
      plan_digest: "a".repeat(64)
    }, null, 2)}\n`
  );
  await writeFile(
    join(projectDir, "dist", "authoring-lab", "review", "index.html"),
    "<!doctype html><html><body>production review</body></html>\n"
  );
  return { root, projectsDir, templatesDir, projectDir, bundleDir };
}

describe("viewer launcher authoring production", () => {
  it("lists a valid authoring project, preserves production review, and starts a stale UI", async () => {
    const fixture = await writeAuthoringLauncherFixture();
    await writeFile(
      join(fixture.projectDir, ".tsugite", "authoring", "ui-listen.json"),
      `${JSON.stringify({ host: "127.0.0.1", port: 1, stopped: true })}\n`
    );
    let started = 0;
    const launcher = await startWorkflowViewerLauncher({
      projectsDir: fixture.projectsDir,
      templatesDir: fixture.templatesDir,
      bundleDir: fixture.bundleDir,
      linkProjectShelves: false,
      port: 0,
      ensureAuthoringUi: async ({ adapterId, productionRoot }) => {
        started += 1;
        expect(adapterId).toBe("hypit");
        expect(productionRoot).toBe(fixture.projectDir);
        return { url: "http://127.0.0.1:8799/", host: "127.0.0.1", port: 8799, reused: false };
      }
    });
    launchers.push(launcher);
    const listed = await fetch(`${launcher.url}/api/projects`);
    const payload = await listed.json() as {
      projects: Array<{
        id: string;
        slug: string;
        valid: boolean;
        authoringUi?: boolean;
        authoringProgress?: string;
        authoringUrl?: string;
        productionReviewUrl?: string;
        availableActions: string[];
      }>;
    };
    const project = payload.projects.find((candidate) => candidate.slug === "authoring-lab");
    expect(project?.valid).toBe(true);
    expect(project?.authoringUi).toBe(true);
    expect(project?.authoringProgress).toBe("plan-ready");
    expect(project?.authoringUrl).toBeUndefined();
    expect(project?.productionReviewUrl).toContain("/production-review/");
    expect(project?.availableActions).toEqual(["validate"]);

    const review = await fetch(project!.productionReviewUrl!);
    expect(review.ok).toBe(true);
    expect(await review.text()).toContain("production review");

    const forbidden = await fetch(`${launcher.url}/api/projects/${project!.id}/authoring-ui`, {
      method: "POST",
      headers: {
        origin: "https://example.com",
        "content-type": "application/json",
        "x-tsugite-token": launcher.token
      },
      body: "{}"
    });
    expect(forbidden.status).toBe(403);

    const id = project!.id;
    const opened = await fetch(`${launcher.url}/api/projects/${id}/authoring-ui`, {
      method: "POST",
      headers: {
        origin: launcher.url,
        "content-type": "application/json",
        "x-tsugite-token": launcher.token
      },
      body: "{}"
    });
    expect(opened.status).toBe(200);
    const openedPayload = await opened.json() as { ok: boolean; authoringUrl: string; reused: boolean };
    expect(openedPayload.authoringUrl).toBe("http://127.0.0.1:8799/");
    expect(openedPayload.reused).toBe(false);
    expect(started).toBe(1);
  });

  it("creates an isolated durable authoring draft and launches its UI", async () => {
    const fixture = await writeAuthoringLauncherFixture();
    const launched: string[] = [];
    const launcher = await startWorkflowViewerLauncher({
      projectsDir: fixture.projectsDir,
      templatesDir: fixture.templatesDir,
      bundleDir: fixture.bundleDir,
      linkProjectShelves: false,
      port: 0,
      ensureAuthoringUi: async ({ adapterId, productionRoot }) => {
        launched.push(productionRoot);
        expect(adapterId).toBe("hypit");
        return { url: "http://127.0.0.1:8801/", host: "127.0.0.1", port: 8801, reused: false };
      }
    });
    launchers.push(launcher);
    const forbidden = await fetch(`${launcher.url}/api/authoring-productions`, {
      method: "POST",
      headers: {
        origin: "https://example.com",
        "content-type": "application/json",
        "x-tsugite-token": launcher.token
      },
      body: JSON.stringify({ name: "侵入" })
    });
    expect(forbidden.status).toBe(403);

    const invalid = await fetch(`${launcher.url}/api/authoring-productions`, {
      method: "POST",
      headers: {
        origin: launcher.url,
        "content-type": "application/json",
        "x-tsugite-token": launcher.token
      },
      body: JSON.stringify({ name: "新規", path: "/tmp/evil" })
    });
    expect(invalid.status).toBe(400);

    const created = await fetch(`${launcher.url}/api/authoring-productions`, {
      method: "POST",
      headers: {
        origin: launcher.url,
        "content-type": "application/json",
        "x-tsugite-token": launcher.token
      },
      body: JSON.stringify({ name: "新規下書き" })
    });
    expect(created.status).toBe(200);
    const payload = await created.json() as {
      ok: boolean;
      authoringUrl: string;
      project: { slug: string; name: string; valid?: boolean };
    };
    expect(payload.authoringUrl).toBe("http://127.0.0.1:8801/");
    expect(payload.project.slug.startsWith("draft-")).toBe(true);
    expect(payload.project.name).toBe("新規下書き");
    expect(launched[0]).toBe(join(await realpath(fixture.projectsDir), payload.project.slug));
    const state = JSON.parse(
      await readFile(join(launched[0]!, ".tsugite/authoring/state.json"), "utf8")
    ) as { instruction: string; run: { reference_digest: string | null; source_files: unknown[]; production_id: string } };
    expect(state.instruction).toBe("");
    expect(state.run.reference_digest).toBeNull();
    expect(state.run.source_files).toEqual([]);
    expect(state.run.production_id).toBe(payload.project.slug);
    const listed = await fetch(`${launcher.url}/api/projects`);
    const listedPayload = await listed.json() as { projects: Array<{ slug: string; authoringUi?: boolean }> };
    expect(listedPayload.projects.some((project) => project.slug === payload.project.slug && project.authoringUi)).toBe(true);
  });
});
