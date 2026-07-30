import { get } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startWorkflowViewerLauncher,
  type WorkflowViewerLauncher
} from "../src/viewer/launcher.js";
import type { ReferenceCatalogResult } from "../src/viewer/referenceCatalog.js";

async function getStatusWithHost(
  url: string,
  host: string,
  headers: Record<string, string> = {}
): Promise<number> {
  const target = new URL(url);
  return await new Promise<number>((resolveStatus, reject) => {
    const request = get({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: { host, ...headers }
    }, (response) => {
      response.resume();
      response.once("end", () => resolveStatus(response.statusCode ?? 0));
    });
    request.once("error", reject);
  });
}

const launchers: WorkflowViewerLauncher[] = [];

afterEach(async () => {
  await Promise.all(launchers.splice(0).map((launcher) => launcher.close()));
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "tsugite-viewer-ref-catalog-"));
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

async function launch(
  options: Parameters<typeof startWorkflowViewerLauncher>[0] = {}
) {
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

const successCatalog: ReferenceCatalogResult = {
  ok: true,
  schemaVersion: 1,
  source: "hyperframes",
  advisoryOnly: true,
  capabilityVerified: false,
  summary: {
    total: 1,
    returned: 1,
    omitted: 0,
    byType: { block: 1, component: 0 }
  },
  items: [{
    id: "data-chart",
    type: "block",
    title: "Data Chart",
    description: "Animated bar chart",
    tags: ["data", "chart"],
    dimensions: { width: 1920, height: 1080 },
    durationSeconds: 15
  }],
  warnings: []
};

function authHeaders(launcher: WorkflowViewerLauncher): HeadersInit {
  return {
    origin: launcher.url,
    "x-tsugite-token": launcher.token
  };
}

describe("GET /api/reference-catalogs/:id", () => {
  it("rejects missing token, foreign Origin, and Host mismatch (403)", async () => {
    const loadReferenceCatalog = vi.fn().mockResolvedValue(successCatalog);
    const { launcher } = await launch({ loadReferenceCatalog });

    const noAuth = await fetch(`${launcher.url}/api/reference-catalogs/hyperframes`);
    expect(noAuth.status).toBe(403);
    expect(await noAuth.json()).toMatchObject({
      ok: false,
      issue: { code: "viewer_launcher.forbidden" }
    });
    expect(loadReferenceCatalog).not.toHaveBeenCalled();

    const originOnly = await fetch(`${launcher.url}/api/reference-catalogs/hyperframes`, {
      headers: { origin: launcher.url }
    });
    expect(originOnly.status).toBe(403);
    expect(loadReferenceCatalog).not.toHaveBeenCalled();

    const wrongToken = await fetch(`${launcher.url}/api/reference-catalogs/hyperframes`, {
      headers: {
        origin: launcher.url,
        "x-tsugite-token": "not-the-session-token"
      }
    });
    expect(wrongToken.status).toBe(403);
    expect(loadReferenceCatalog).not.toHaveBeenCalled();

    const foreignOrigin = await fetch(`${launcher.url}/api/reference-catalogs/hyperframes`, {
      headers: {
        origin: "http://127.0.0.1:9",
        "x-tsugite-token": launcher.token
      }
    });
    expect(foreignOrigin.status).toBe(403);
    expect(loadReferenceCatalog).not.toHaveBeenCalled();

    // Host は launcherOrigin と照合済み。不一致は token があっても拒否。
    const badHostStatus = await getStatusWithHost(
      `${launcher.url}/api/reference-catalogs/hyperframes`,
      "viewer.attacker.invalid",
      { "x-tsugite-token": launcher.token }
    );
    expect(badHostStatus).toBe(403);
    expect(loadReferenceCatalog).not.toHaveBeenCalled();
  });

  it("allows same-origin browser GET without Origin when Host matches and token is valid", async () => {
    // ブラウザの同一 origin 通常 GET は Origin を送らない。
    // Host 照合 + x-tsugite-token で許可する（Origin 必須だと UI が 403 になる）。
    const loadReferenceCatalog = vi.fn().mockResolvedValue(successCatalog);
    const { launcher } = await launch({ loadReferenceCatalog });

    const tokenOnly = await fetch(`${launcher.url}/api/reference-catalogs/hyperframes`, {
      headers: { "x-tsugite-token": launcher.token }
    });
    const payload = await tokenOnly.json();

    expect(tokenOnly.status).toBe(200);
    expect(payload).toEqual(successCatalog);
    expect(loadReferenceCatalog).toHaveBeenCalledTimes(1);
    expect(loadReferenceCatalog).toHaveBeenCalledWith("hyperframes");
  });

  it("returns the advisory catalog without side effects when authorized", async () => {
    const loadReferenceCatalog = vi.fn().mockResolvedValue(successCatalog);
    const { launcher } = await launch({ loadReferenceCatalog });

    const response = await fetch(`${launcher.url}/api/reference-catalogs/hyperframes`, {
      headers: authHeaders(launcher)
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(successCatalog);
    expect(loadReferenceCatalog).toHaveBeenCalledTimes(1);
    expect(loadReferenceCatalog).toHaveBeenCalledWith("hyperframes");
    expect(JSON.stringify(payload)).not.toMatch(/stderr|spawn|PATH|HOME|\/Users\//);
  });

  it("maps stable generic issue codes and never leaks stderr/path/env", async () => {
    const loadReferenceCatalog = vi.fn().mockResolvedValue({
      ok: false,
      issue: {
        code: "reference_catalog.timeout",
        message: "Reference catalog command timed out"
      }
    });
    const { launcher } = await launch({ loadReferenceCatalog });

    const response = await fetch(`${launcher.url}/api/reference-catalogs/hyperframes`, {
      headers: authHeaders(launcher)
    });
    const payload = await response.json();
    expect(response.status).toBe(504);
    expect(payload).toEqual({
      ok: false,
      issue: {
        code: "reference_catalog.timeout",
        message: "Reference catalog command timed out"
      }
    });
    expect(JSON.stringify(payload)).not.toMatch(/stderr|PATH|HOME|npx|catalog --json/);
  });

  it("returns 429 busy without breaking GET /api/presets", async () => {
    const loadReferenceCatalog = vi.fn().mockResolvedValue({
      ok: false,
      issue: {
        code: "reference_catalog.busy",
        message: "Reference catalog is already loading"
      }
    });
    const { launcher } = await launch({ loadReferenceCatalog });

    const busy = await fetch(`${launcher.url}/api/reference-catalogs/hyperframes`, {
      headers: authHeaders(launcher)
    });
    expect(busy.status).toBe(429);
    expect(await busy.json()).toMatchObject({
      ok: false,
      issue: { code: "reference_catalog.busy" }
    });

    const presets = await fetch(`${launcher.url}/api/presets?backend=remotion`);
    expect(presets.status).toBe(200);
    const presetsPayload = await presets.json();
    expect(presetsPayload).toMatchObject({
      ok: true,
      backend: "remotion"
    });
    expect(Array.isArray(presetsPayload.presets)).toBe(true);
  });

  it("rejects non-GET methods and leaves GET /api/presets unchanged", async () => {
    const loadReferenceCatalog = vi.fn().mockResolvedValue(successCatalog);
    const { launcher } = await launch({ loadReferenceCatalog });

    const post = await fetch(`${launcher.url}/api/reference-catalogs/hyperframes`, {
      method: "POST",
      headers: authHeaders(launcher)
    });
    expect(post.status).toBe(404);
    expect(loadReferenceCatalog).not.toHaveBeenCalled();

    const presets = await fetch(`${launcher.url}/api/presets?backend=remotion`);
    expect(presets.status).toBe(200);
    const presetsPayload = await presets.json();
    expect(presetsPayload).toMatchObject({
      ok: true,
      backend: "remotion"
    });
    expect(Array.isArray(presetsPayload.presets)).toBe(true);
  });

  it("rejects catalog ids longer than 64 characters at the route entrance", async () => {
    const loadReferenceCatalog = vi.fn().mockResolvedValue(successCatalog);
    const { launcher } = await launch({ loadReferenceCatalog });

    const allowed = `c${"a".repeat(63)}`;
    const rejected = `c${"a".repeat(64)}`;
    expect(allowed).toHaveLength(64);
    expect(rejected).toHaveLength(65);

    const okId = await fetch(`${launcher.url}/api/reference-catalogs/${allowed}`, {
      headers: authHeaders(launcher)
    });
    // Handler is reached for a safe-length id (provider mock returns success).
    expect(okId.status).toBe(200);
    expect(loadReferenceCatalog).toHaveBeenCalledWith(allowed);

    loadReferenceCatalog.mockClear();
    const tooLong = await fetch(`${launcher.url}/api/reference-catalogs/${rejected}`, {
      headers: authHeaders(launcher)
    });
    expect(tooLong.status).toBe(404);
    expect(await tooLong.json()).toEqual({
      ok: false,
      issue: {
        code: "reference_catalog.not_found",
        message: "Reference catalog was not found"
      }
    });
    expect(loadReferenceCatalog).not.toHaveBeenCalled();
  });
});
