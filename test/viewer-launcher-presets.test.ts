import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBackendCapabilities } from "../src/backends/capabilities.js";
import {
  startWorkflowViewerLauncher,
  type WorkflowViewerLauncher
} from "../src/viewer/launcher.js";

const launchers: WorkflowViewerLauncher[] = [];

afterEach(async () => {
  await Promise.all(launchers.splice(0).map((launcher) => launcher.close()));
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "tsugite-viewer-presets-"));
  const projectsDir = join(root, "projects");
  const templatesDir = join(root, "templates");
  const bundleDir = join(root, "bundle");
  await mkdir(projectsDir, { recursive: true });
  await mkdir(templatesDir, { recursive: true });
  await mkdir(join(bundleDir, "assets"), { recursive: true });
  await writeFile(
    join(bundleDir, "index.html"),
    '<!doctype html><html><head><title>Viewer</title></head><body><div id="root"></div></body></html>\n'
  );
  await writeFile(join(bundleDir, "assets", "app.css"), "body{}\n");
  await writeFile(join(bundleDir, "assets", "app.js"), "globalThis.viewerLoaded=true;\n");
  return { root, projectsDir, templatesDir, bundleDir };
}

async function launch(options: Parameters<typeof startWorkflowViewerLauncher>[0] = {}) {
  const fixture = await createFixture();
  const launcher = await startWorkflowViewerLauncher({
    linkProjectShelves: false,
    projectsDir: fixture.projectsDir,
    templatesDir: fixture.templatesDir,
    bundleDir: fixture.bundleDir,
    port: 0,
    ...options
  });
  launchers.push(launcher);
  return { fixture, launcher };
}

describe("GET /api/presets", () => {
  it("lists presentation preset ids for a registered backend without side effects", async () => {
    const remotion = await loadBackendCapabilities("remotion");
    const hyperframes = await loadBackendCapabilities("hyperframes");
    expect(remotion).toBeDefined();
    expect(hyperframes).toBeDefined();

    const { launcher } = await launch();

    const remotionResponse = await fetch(`${launcher.url}/api/presets?backend=remotion`);
    const remotionPayload = await remotionResponse.json();
    expect(remotionResponse.status).toBe(200);
    expect(remotionPayload).toEqual({
      ok: true,
      backend: "remotion",
      presets: remotion!.capabilities.presets
    });
    expect(remotionPayload.presets).toEqual(
      expect.arrayContaining(["article-dialogue-16x9", "street-dialogue-16x9"])
    );
    // ローカル path や registry handler を漏らさない
    expect(JSON.stringify(remotionPayload)).not.toMatch(/backends\/|handler|capabilities\.yaml/);

    const hyperframesResponse = await fetch(`${launcher.url}/api/presets?backend=hyperframes`);
    const hyperframesPayload = await hyperframesResponse.json();
    expect(hyperframesResponse.status).toBe(200);
    expect(hyperframesPayload).toEqual({
      ok: true,
      backend: "hyperframes",
      presets: hyperframes!.capabilities.presets
    });
  });

  it("requires a safe backend id and rejects missing / unsafe / unknown backends", async () => {
    const { launcher } = await launch();

    const missing = await fetch(`${launcher.url}/api/presets`);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      ok: false,
      issue: { code: "presets.backend_missing" }
    });

    const empty = await fetch(`${launcher.url}/api/presets?backend=`);
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({
      ok: false,
      issue: { code: "presets.backend_missing" }
    });

    const unsafe = await fetch(`${launcher.url}/api/presets?backend=${encodeURIComponent("../outside")}`);
    const unsafePayload = await unsafe.json();
    expect(unsafe.status).toBe(400);
    expect(unsafePayload).toMatchObject({
      ok: false,
      issue: { code: "presets.backend_invalid" }
    });
    expect(JSON.stringify(unsafePayload)).not.toMatch(/capabilities\.yaml|handler/);

    const pathTraversal = await fetch(
      `${launcher.url}/api/presets?backend=${encodeURIComponent("remotion/../../etc")}`
    );
    expect(pathTraversal.status).toBe(400);
    expect(await pathTraversal.json()).toMatchObject({
      ok: false,
      issue: { code: "presets.backend_invalid" }
    });

    const unknown = await fetch(`${launcher.url}/api/presets?backend=unknown-backend`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({
      ok: false,
      backend: "unknown-backend",
      issue: { code: "backend.not_found" }
    });

    const safeUnknown = await fetch(`${launcher.url}/api/presets?backend=Unknown_backend.v2`);
    expect(safeUnknown.status).toBe(404);
    expect(await safeUnknown.json()).toMatchObject({
      ok: false,
      backend: "Unknown_backend.v2",
      issue: { code: "backend.not_found" }
    });
  });

  it("returns structured schema errors for malformed backend capabilities", async () => {
    const { launcher } = await launch({
      validationOptions: { backendDirs: ["fixtures/backends"] }
    });

    const response = await fetch(`${launcher.url}/api/presets?backend=malformed`);
    const payload = await response.json();
    expect(response.status).toBe(422);
    expect(payload).toMatchObject({
      ok: false,
      backend: "malformed",
      issue: { code: "backend.schema" }
    });
    expect(JSON.stringify(payload)).not.toMatch(/fixtures\/backends|handler/);
  });

  it("is read-only: rejects non-GET methods", async () => {
    const { launcher } = await launch();

    const post = await fetch(`${launcher.url}/api/presets?backend=remotion`, { method: "POST" });
    expect(post.status).toBe(404);

    const put = await fetch(`${launcher.url}/api/presets?backend=remotion`, { method: "PUT" });
    expect(put.status).toBe(404);
  });
});
