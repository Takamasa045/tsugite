import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  startWorkflowViewerLauncher,
  type WorkflowViewerLauncher
} from "../src/viewer/launcher.js";
import { characterImageKey } from "../src/viewer/launcherCharacters.js";

const launchers: WorkflowViewerLauncher[] = [];

afterEach(async () => {
  await Promise.all(launchers.splice(0).map((launcher) => launcher.close()));
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "tsugite-launcher-chars-"));
  const projectsDir = join(root, "projects");
  const templatesDir = join(root, "templates");
  const bundleDir = join(root, "bundle");
  await mkdir(projectsDir, { recursive: true });
  await mkdir(templatesDir, { recursive: true });

  const targetDir = join(projectsDir, "target-project");
  await cp(join(process.cwd(), "examples", "local-fixture"), targetDir, { recursive: true });
  await writeFile(
    join(targetDir, "project.yaml"),
    `slug: target-project
run_id: target-project-run
manifest: manifest.json
dist_dir: dist
edit:
  backend: remotion
`
  );

  const sourceDir = join(projectsDir, "source-cast");
  await writeSpeakerProject(sourceDir, {
    slug: "source-cast",
    speakers: [
      {
        id: "hero",
        display_name: "Hero",
        side: "left",
        accent: "#111111",
        poses: { neutral: "hero-neutral", smile: "hero-smile" },
        mouth_frames: ["hero-m0", "hero-m1", "hero-m2"]
      }
    ],
    images: [
      { id: "hero-neutral", src: "media/hero-neutral.png" },
      { id: "hero-smile", src: "media/hero-smile.png" },
      { id: "hero-m0", src: "media/m0.png" },
      { id: "hero-m1", src: "media/m1.png" },
      { id: "hero-m2", src: "media/m2.png" }
    ],
    mediaFiles: [
      "media/hero-neutral.png",
      "media/hero-smile.png",
      "media/m0.png",
      "media/m1.png",
      "media/m2.png"
    ]
  });

  // Character scan reads templates/<id>/dist/<variant>/manifest.json
  const templateVariantDir = join(templatesDir, "blog-dialogue", "dist", "default");
  await writeSpeakerProject(templateVariantDir, {
    slug: "blog-dialogue-default",
    asTemplate: true,
    speakers: [
      {
        id: "host",
        display_name: "Host",
        side: "right",
        accent: "#abcdef",
        poses: { neutral: "host-n" }
      }
    ],
    images: [{ id: "host-n", src: "media/host.png" }],
    mediaFiles: ["media/host.png"]
  });

  await mkdir(join(bundleDir, "assets"), { recursive: true });
  await writeFile(
    join(bundleDir, "index.html"),
    '<!doctype html><html><head><title>Viewer</title></head><body><div id="root"></div></body></html>\n'
  );
  await writeFile(join(bundleDir, "assets", "app.css"), "body{}\n");
  await writeFile(join(bundleDir, "assets", "app.js"), "globalThis.viewerLoaded=true;\n");

  return { root, projectsDir, templatesDir, bundleDir, targetDir, sourceDir };
}

async function launch(options: Parameters<typeof startWorkflowViewerLauncher>[0]) {
  const launcher = await startWorkflowViewerLauncher({
    linkProjectShelves: false,
    ...options
  });
  launchers.push(launcher);
  return launcher;
}

async function authorizedPost(
  launcher: WorkflowViewerLauncher,
  path: string,
  body: unknown
): Promise<Response> {
  return fetch(`${launcher.url}${path}`, {
    method: "POST",
    headers: {
      origin: launcher.url,
      "x-tsugite-token": launcher.token,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

describe("viewer launcher characters API", () => {
  it("GET /api/characters returns aggregated wire characters", async () => {
    const fixture = await createFixture();
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      templatesDir: fixture.templatesDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });

    const response = await fetch(`${launcher.url}/api/characters`);
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      ok: boolean;
      characters: Array<{
        groupKey: string;
        id: string;
        displayName: string;
        poseCount: number;
        hasMouthFrames: boolean;
        sources: Array<{
          sourceKey: string;
          kind: string;
          label: string;
          speakerId: string;
          readOnly: boolean;
          canUse: boolean;
          poses: Array<{ name: string; imageId: string; imageKey?: string; missing: boolean }>;
        }>;
        representativeImageKey?: string;
      }>;
    };

    expect(payload.ok).toBe(true);
    expect(payload.characters.length).toBeGreaterThanOrEqual(2);

    const hero = payload.characters.find((entry) => entry.id === "hero");
    expect(hero).toMatchObject({
      id: "hero",
      displayName: "Hero",
      poseCount: 2,
      hasMouthFrames: true
    });
    expect(hero?.sources).toHaveLength(1);
    expect(hero?.sources[0]).toMatchObject({
      kind: "project",
      label: "source-cast",
      speakerId: "hero",
      readOnly: false,
      canUse: true
    });
    expect(hero?.sources[0]!.poses.every((pose) => pose.imageKey && !pose.missing)).toBe(true);
    expect(hero?.representativeImageKey).toMatch(/^[a-f0-9]{32}$/);
    expect(hero?.sources[0]!.sourceKey).toContain("\0");

    const host = payload.characters.find((entry) => entry.id === "host");
    expect(host?.sources[0]).toMatchObject({
      kind: "template",
      speakerId: "host",
      readOnly: true,
      canUse: true
    });
  });

  it("serves character images with containment and rejects escapes", async () => {
    const fixture = await createFixture();
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      templatesDir: fixture.templatesDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });

    const catalog = await fetch(`${launcher.url}/api/characters`).then((response) => response.json()) as {
      characters: Array<{
        sources: Array<{ poses: Array<{ imageKey?: string }> }>;
        representativeImageKey?: string;
      }>;
    };
    const imageKey = catalog.characters
      .flatMap((character) => character.sources)
      .flatMap((source) => source.poses)
      .find((pose) => pose.imageKey)?.imageKey;
    expect(imageKey).toBeTruthy();

    const ok = await fetch(`${launcher.url}/character-image/${imageKey}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/image\/png|octet-stream/);
    const bytes = Buffer.from(await ok.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);

    const head = await fetch(`${launcher.url}/character-image/${imageKey}`, { method: "HEAD" });
    expect(head.status).toBe(200);

    expect((await fetch(`${launcher.url}/character-image/${"0".repeat(32)}`)).status).toBe(404);
    expect((await fetch(`${launcher.url}/character-image/not-a-key`)).status).toBe(404);
    expect((await fetch(`${launcher.url}/character-image/../secrets`)).status).toBe(404);
    expect((await fetch(`${launcher.url}/character-image/%2e%2e%2fetc%2fpasswd`)).status).toBe(404);
  });

  it("POST /api/characters/use adds a character and is idempotent", async () => {
    const fixture = await createFixture();
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      templatesDir: fixture.templatesDir,
      bundleDir: fixture.bundleDir,
      port: 0,
      allowProjectActions: false
    });

    const catalog = await fetch(`${launcher.url}/api/characters`).then((response) => response.json()) as {
      characters: Array<{
        id: string;
        sources: Array<{ sourceKey: string; speakerId: string; kind: string }>;
      }>;
    };
    const hero = catalog.characters.find((entry) => entry.id === "hero")?.sources[0];
    expect(hero).toBeTruthy();

    const projects = await fetch(`${launcher.url}/api/projects`).then((response) => response.json()) as {
      projects: Array<{ id: string; slug: string }>;
    };
    const target = projects.projects.find((project) => project.slug === "target-project");
    expect(target).toBeTruthy();

    const added = await authorizedPost(launcher, "/api/characters/use", {
      sourceKey: hero!.sourceKey,
      speakerId: hero!.speakerId,
      targetProjectId: target!.id
    });
    expect(added.status).toBe(200);
    await expect(added.json()).resolves.toMatchObject({
      ok: true,
      added: true,
      alreadyPresent: false,
      speakerId: "hero"
    });

    const manifest = JSON.parse(await readFile(join(fixture.targetDir, "manifest.json"), "utf8")) as {
      speakers: Array<{ id: string }>;
    };
    expect(manifest.speakers.some((speaker) => speaker.id === "hero")).toBe(true);

    const again = await authorizedPost(launcher, "/api/characters/use", {
      sourceKey: hero!.sourceKey,
      speakerId: hero!.speakerId,
      targetProjectId: target!.id
    });
    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toMatchObject({
      ok: true,
      added: false,
      alreadyPresent: true,
      speakerId: "hero"
    });
  });

  it("POST /api/characters/use returns 409 on speaker conflict", async () => {
    const fixture = await createFixture();
    // Pre-seed a conflicting hero speaker with different pose content.
    const targetManifestPath = join(fixture.targetDir, "manifest.json");
    const targetManifest = JSON.parse(await readFile(targetManifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(join(fixture.targetDir, "media", "other-hero.png"), Buffer.from("other-hero"));
    targetManifest.images = [
      ...(Array.isArray(targetManifest.images) ? targetManifest.images : []),
      { id: "other-hero", src: "media/other-hero.png" }
    ];
    targetManifest.speakers = [
      {
        id: "hero",
        display_name: "Different Hero",
        side: "right",
        accent: "#ffffff",
        poses: { neutral: "other-hero" }
      }
    ];
    await writeFile(targetManifestPath, `${JSON.stringify(targetManifest, null, 2)}\n`);

    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      templatesDir: fixture.templatesDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });

    const catalog = await fetch(`${launcher.url}/api/characters`).then((response) => response.json()) as {
      characters: Array<{
        id: string;
        sources: Array<{ sourceKey: string; speakerId: string; kind: string; label: string }>;
      }>;
    };
    const hero = catalog.characters
      .flatMap((entry) => entry.sources)
      .find((source) =>
        source.kind === "project"
        && source.label === "source-cast"
        && source.speakerId === "hero"
      );
    expect(hero).toBeTruthy();

    const projects = await fetch(`${launcher.url}/api/projects`).then((response) => response.json()) as {
      projects: Array<{ id: string; slug: string }>;
    };
    const target = projects.projects.find((project) => project.slug === "target-project");

    const conflict = await authorizedPost(launcher, "/api/characters/use", {
      sourceKey: hero!.sourceKey,
      speakerId: hero!.speakerId,
      targetProjectId: target!.id
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      ok: false,
      issue: { code: "character_add.speaker_conflict" }
    });
  });

  it("POST /api/characters/use rejects read-only targets with 403", async () => {
    const fixture = await createFixture();
    const readOnlyShelf = join(fixture.root, "readonly-projects");
    await mkdir(readOnlyShelf, { recursive: true });
    const readOnlyProject = join(readOnlyShelf, "ro-target");
    await cp(fixture.targetDir, readOnlyProject, { recursive: true });
    await writeFile(
      join(readOnlyProject, "project.yaml"),
      `slug: ro-target
run_id: ro-target-run
manifest: manifest.json
dist_dir: dist
edit:
  backend: remotion
`
    );

    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      additionalProjectsDirs: [readOnlyShelf],
      templatesDir: fixture.templatesDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });

    const catalog = await fetch(`${launcher.url}/api/characters`).then((response) => response.json()) as {
      characters: Array<{
        id: string;
        sources: Array<{ sourceKey: string; speakerId: string }>;
      }>;
    };
    const hero = catalog.characters.find((entry) => entry.id === "hero")?.sources[0];
    const projects = await fetch(`${launcher.url}/api/projects`).then((response) => response.json()) as {
      projects: Array<{ id: string; slug: string; readOnly: boolean }>;
    };
    const target = projects.projects.find((project) => project.slug === "ro-target");
    expect(target?.readOnly).toBe(true);

    const response = await authorizedPost(launcher, "/api/characters/use", {
      sourceKey: hero!.sourceKey,
      speakerId: hero!.speakerId,
      targetProjectId: target!.id
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      issue: { code: "viewer_launcher.worktree_read_only" }
    });
  });

  it("POST /api/characters/use rejects unauthorized callers with 403", async () => {
    const fixture = await createFixture();
    const launcher = await launch({
      projectsDir: fixture.projectsDir,
      templatesDir: fixture.templatesDir,
      bundleDir: fixture.bundleDir,
      port: 0
    });

    const missingToken = await fetch(`${launcher.url}/api/characters/use`, {
      method: "POST",
      headers: {
        origin: launcher.url,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sourceKey: "x",
        speakerId: "hero",
        targetProjectId: "y"
      })
    });
    expect(missingToken.status).toBe(403);

    const foreignOrigin = await fetch(`${launcher.url}/api/characters/use`, {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:9",
        "x-tsugite-token": launcher.token,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sourceKey: "x",
        speakerId: "hero",
        targetProjectId: "y"
      })
    });
    expect(foreignOrigin.status).toBe(403);
  });

  it("characterImageKey is deterministic for the same root and path", () => {
    const left = characterImageKey("/proj/a", "media/hero.png");
    const right = characterImageKey("/proj/a", "media/hero.png");
    const other = characterImageKey("/proj/b", "media/hero.png");
    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{32}$/);
    expect(left).not.toBe(other);
  });
});

async function writeSpeakerProject(
  projectDir: string,
  options: {
    slug: string;
    asTemplate?: boolean;
    speakers: Array<{
      id: string;
      display_name: string;
      side: "left" | "right";
      accent: string;
      poses: Record<string, string>;
      mouth_frames?: string[];
    }>;
    images: Array<{ id: string; src: string }>;
    mediaFiles: string[];
  }
): Promise<void> {
  await mkdir(join(projectDir, "media"), { recursive: true });
  for (const relative of options.mediaFiles) {
    const absolute = join(projectDir, relative);
    await mkdir(dirname(absolute), { recursive: true });
    // Minimal PNG header so content-type detection and non-empty body work.
    await writeFile(absolute, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...Buffer.from(`png:${relative}`)
    ]));
  }
  await writeFile(join(projectDir, "media", "background.mp4"), Buffer.from("video"));

  if (!options.asTemplate) {
    await writeFile(
      join(projectDir, "project.yaml"),
      `slug: ${options.slug}
run_id: ${options.slug}-run
manifest: manifest.json
dist_dir: dist
edit:
  backend: remotion
`
    );
  }

  await writeFile(
    join(projectDir, "manifest.json"),
    `${JSON.stringify(
      {
        meta: {
          aspect: "16:9",
          fps: 30,
          target_duration_seconds: 5,
          slug: options.slug
        },
        clips: [
          {
            id: "bg",
            src: "media/background.mp4",
            in: 0,
            out: 5,
            duration: 5,
            fps: 30,
            resolution: { width: 320, height: 180 },
            audio: false
          }
        ],
        images: options.images,
        speakers: options.speakers,
        audio: { bgm: [], narration: [], sfx: [] },
        captions: [],
        chapters: [],
        provenance: []
      },
      null,
      2
    )}\n`
  );
}
