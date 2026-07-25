import { mkdir, mkdtemp, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanCharacterSources } from "../src/characters/scan.js";

const tempRoots: string[] = [];

afterEach(async () => {
  // Fixtures live under OS temp; leave cleanup to the OS between runs.
  tempRoots.length = 0;
});

describe("scanCharacterSources", () => {
  it("extracts speakers from project shelves with resolved pose paths", async () => {
    const fixture = await createProjectFixture({
      slug: "cast-a",
      speakers: [
        {
          id: "hero",
          display_name: "Hero",
          side: "left",
          accent: "#111111",
          poses: { neutral: "hero-neutral", smile: "hero-smile" },
          mouth_frames: ["hero-mouth-0", "hero-mouth-1", "hero-mouth-2"]
        }
      ],
      images: [
        { id: "hero-neutral", src: "media/hero-neutral.png" },
        { id: "hero-smile", src: "media/hero-smile.png" },
        { id: "hero-mouth-0", src: "media/m0.png" },
        { id: "hero-mouth-1", src: "media/m1.png" },
        { id: "hero-mouth-2", src: "media/m2.png" }
      ],
      mediaFiles: [
        "media/hero-neutral.png",
        "media/hero-smile.png",
        "media/m0.png",
        "media/m1.png",
        "media/m2.png"
      ]
    });

    const result = await scanCharacterSources({
      projectDirectories: [fixture.shelf]
    });

    expect(result.warnings).toEqual([]);
    expect(result.sources).toHaveLength(1);
    const source = result.sources[0]!;
    expect(source).toMatchObject({
      kind: "project",
      label: "cast-a",
      id: "hero",
      displayName: "Hero",
      side: "left",
      accent: "#111111"
    });
    expect(source.sourceKey).toContain("project");
    expect(source.sourceKey).toContain("hero");
    expect(source.poses).toEqual([
      expect.objectContaining({
        name: "neutral",
      imageId: "hero-neutral",
        imagePath: "media/hero-neutral.png",
        missing: false
      }),
      expect.objectContaining({
        name: "smile",
      imageId: "hero-smile",
        imagePath: "media/hero-smile.png",
        missing: false
      })
    ]);
    expect(source.mouthFrames).toHaveLength(3);
    expect(source.mouthFrames?.every((frame) => frame.missing === false)).toBe(true);
    expect(source.manifestPath.includes("\\")).toBe(false);
    expect(source.rootDir.includes("\\")).toBe(false);
  });

  it("labels template variants as templateId/variantId", async () => {
    const fixture = await createTemplateFixture({
      templateId: "blog-dialogue-60s",
      variantId: "default",
      speakers: [
        {
          id: "host",
          display_name: "Host",
          side: "left",
          accent: "#abcdef",
          poses: { neutral: "host-n" }
        }
      ],
      images: [{ id: "host-n", src: "media/host.png" }],
      mediaFiles: ["media/host.png"]
    });

    const result = await scanCharacterSources({
      projectDirectories: [],
      templatesDir: fixture.templatesDir
    });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      kind: "template",
      label: "blog-dialogue-60s/default",
      id: "host",
      displayName: "Host"
    });
    expect(result.sources[0]!.sourceKey.startsWith("template\0")).toBe(true);
  });

  it("skips invalid manifests with characters.scan_skipped", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-char-scan-invalid-"));
    tempRoots.push(root);
    const shelf = join(root, "projects");
    const projectDir = join(shelf, "broken");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "project.yaml"),
      `slug: broken
name: broken
manifest: manifest.json
dist_dir: dist
edit:
  backend: remotion
`
    );
    await writeFile(join(projectDir, "manifest.json"), "{}\n");

    const result = await scanCharacterSources({ projectDirectories: [shelf] });

    expect(result.sources).toEqual([]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "characters.scan_skipped" })
    );
  });

  it("marks missing pose images without dropping the speaker", async () => {
    const fixture = await createProjectFixture({
      slug: "missing-pose",
      speakers: [
        {
          id: "ghost",
          display_name: "Ghost",
          side: "right",
          accent: "#000000",
          poses: { neutral: "ghost-n", wave: "ghost-wave" }
        }
      ],
      images: [
        { id: "ghost-n", src: "media/ghost.png" },
        { id: "ghost-wave", src: "media/wave.png" }
      ],
      mediaFiles: ["media/ghost.png"]
      // wave.png intentionally absent
    });

    const result = await scanCharacterSources({ projectDirectories: [fixture.shelf] });

    expect(result.sources).toHaveLength(1);
    const poses = result.sources[0]!.poses;
    expect(poses.find((pose) => pose.name === "neutral")).toMatchObject({
      missing: false,
      imagePath: "media/ghost.png"
    });
    expect(poses.find((pose) => pose.name === "wave")).toMatchObject({
      missing: true,
      imageId: "ghost-wave"
    });
    expect(poses.find((pose) => pose.name === "wave")?.imagePath).toBeUndefined();
  });

  it("warns on containment violations and marks the pose missing", async () => {
    const fixture = await createProjectFixture({
      slug: "escape",
      speakers: [
        {
          id: "spy",
          display_name: "Spy",
          side: "left",
          accent: "#ff0000",
          poses: { neutral: "spy-n" }
        }
      ],
      images: [{ id: "spy-n", src: "../outside/spy.png" }],
      mediaFiles: []
    });
    const outside = join(dirname(fixture.projectDir), "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "spy.png"), Buffer.from("escape"));

    const result = await scanCharacterSources({ projectDirectories: [fixture.shelf] });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.poses[0]).toMatchObject({
      name: "neutral",
      missing: true
    });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "characters.pose_escape" })
    );
  });

  it("deduplicates the same manifest realpath (first wins)", async () => {
    const fixture = await createProjectFixture({
      slug: "canonical",
      speakers: [
        {
          id: "hero",
          display_name: "Hero",
          side: "left",
          accent: "#111111",
          poses: { neutral: "hero-n" }
        }
      ],
      images: [{ id: "hero-n", src: "media/hero.png" }],
      mediaFiles: ["media/hero.png"]
    });

    const aliasShelf = join(fixture.root, "alias-shelf");
    await mkdir(aliasShelf, { recursive: true });
    await symlink(fixture.projectDir, join(aliasShelf, "canonical-alias"));

    const result = await scanCharacterSources({
      projectDirectories: [fixture.shelf, aliasShelf]
    });

    expect(result.sources.filter((source) => source.id === "hero")).toHaveLength(1);
  });

  it("carries speaker provenance through for shitate-style sources", async () => {
    const fixture = await createProjectFixture({
      slug: "with-prov",
      name: "with-prov",
      speakers: [
        {
          id: "hero",
          display_name: "Hero",
          side: "left",
          accent: "#6B7A5A",
          poses: { neutral: "hero-anchor" },
          source: {
            kind: "shitate",
            character: "hero",
            run_id: "run-1",
            base_version: "v1"
          }
        }
      ],
      images: [{ id: "hero-anchor", src: "media/anchor.png" }],
      mediaFiles: ["media/anchor.png"]
    });

    const result = await scanCharacterSources({ projectDirectories: [fixture.shelf] });

    expect(result.sources[0]?.provenance).toMatchObject({
      kind: "shitate",
      character: "hero",
      run_id: "run-1"
    });
  });

  it("marks unknown image ids as missing without a pose_escape warning", async () => {
    const fixture = await createProjectFixture({
      slug: "unknown-id",
      speakers: [
        {
          id: "solo",
          display_name: "Solo",
          side: "left",
          accent: "#123456",
          poses: { neutral: "does-not-exist" }
        }
      ],
      images: [],
      mediaFiles: []
    });

    const result = await scanCharacterSources({ projectDirectories: [fixture.shelf] });

    expect(result.sources[0]!.poses[0]).toMatchObject({
      imageId: "does-not-exist",
      missing: true
    });
    expect(result.warnings.filter((warning) => warning.code === "characters.pose_escape")).toEqual(
      []
    );
  });

  it("uses assetRoot as rootDir so soft-containment image paths never contain ..", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-char-scan-soft-"));
    tempRoots.push(root);
    const shelf = join(root, "projects");
    const projectDir = join(shelf, "soft-child");
    const sharedMedia = join(shelf, "shared-media");
    await mkdir(join(projectDir), { recursive: true });
    await mkdir(sharedMedia, { recursive: true });
    await writeFile(join(sharedMedia, "hero.png"), Buffer.from("soft-hero"));
    // Manifest lives next to the project under the shelf parent (asset root).
    const manifestPath = join(shelf, "soft-manifest.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        buildManifest({
          slug: "soft-child",
          speakers: [
            {
              id: "hero",
              display_name: "Soft Hero",
          side: "left",
              accent: "#123456",
              poses: { neutral: "hero-n" }
            }
          ],
          images: [{ id: "hero-n", src: "shared-media/hero.png" }],
          mediaFiles: []
        }),
        null,
        2
      )}\n`
    );
    await writeFile(
      join(projectDir, "project.yaml"),
      `slug: soft-child
name: soft-child
run_id: soft-child-r1
manifest: ../soft-manifest.json
dist_dir: dist
edit:
  backend: remotion
`
    );

    const result = await scanCharacterSources({ projectDirectories: [shelf] });
    expect(result.sources).toHaveLength(1);
    const source = result.sources[0]!;
    expect(source.poses[0]).toMatchObject({
      name: "neutral",
      imageId: "hero-n",
      imagePath: "shared-media/hero.png",
      missing: false
    });
    expect(source.poses[0]!.imagePath?.includes("..")).toBe(false);
    // rootDir is the asset root (shelf), not the project directory.
    expect(source.rootDir).toBe(resolve(shelf).split("\\").join("/"));
    expect(source.rootDir.includes("soft-child")).toBe(false);
  });
});

type SpeakerFixture = {
  id: string;
  display_name: string;
  side: "left" | "right";
  accent: string;
  poses: Record<string, string>;
  mouth_frames?: string[];
  source?: Record<string, unknown>;
};

type ProjectFixtureOptions = {
  slug: string;
  name?: string;
  speakers: SpeakerFixture[];
  images: Array<{ id: string; src: string; alt?: string }>;
  mediaFiles: string[];
  manifestMtime?: Date;
};

async function createProjectFixture(options: ProjectFixtureOptions) {
  const root = await mkdtemp(join(tmpdir(), "tsugite-char-scan-"));
  tempRoots.push(root);
  const shelf = join(root, "projects");
  const projectDir = join(shelf, options.slug);
  await mkdir(join(projectDir, "media"), { recursive: true });

  for (const relative of options.mediaFiles) {
    const absolute = join(projectDir, relative);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, Buffer.from(`bytes:${relative}`));
  }

  await writeFile(
    join(projectDir, "project.yaml"),
    `slug: ${options.slug}
name: ${options.name ?? options.slug}
run_id: ${options.slug}-r1
manifest: manifest.json
dist_dir: dist
edit:
  backend: remotion
`
  );

  const manifestPath = join(projectDir, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(buildManifest(options), null, 2)}\n`);
  if (options.manifestMtime) {
    await utimes(manifestPath, options.manifestMtime, options.manifestMtime);
  }

  return { root, shelf, projectDir, manifestPath };
}

async function createTemplateFixture(options: {
  templateId: string;
  variantId: string;
  speakers: SpeakerFixture[];
  images: Array<{ id: string; src: string }>;
  mediaFiles: string[];
}) {
  const root = await mkdtemp(join(tmpdir(), "tsugite-char-tmpl-"));
  tempRoots.push(root);
  const templatesDir = join(root, "templates");
  const variantRoot = join(templatesDir, options.templateId, "dist", options.variantId);
  await mkdir(join(variantRoot, "media"), { recursive: true });

  for (const relative of options.mediaFiles) {
    const absolute = join(variantRoot, relative);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, Buffer.from(`bytes:${relative}`));
  }

  await writeFile(
    join(variantRoot, "manifest.json"),
    `${JSON.stringify(
      buildManifest({
        slug: options.templateId,
        speakers: options.speakers,
        images: options.images,
        mediaFiles: options.mediaFiles
      }),
      null,
      2
    )}\n`
  );

  return { root, templatesDir, variantRoot };
}

function buildManifest(options: {
  slug: string;
  speakers: SpeakerFixture[];
  images: Array<{ id: string; src: string; alt?: string }>;
  mediaFiles: string[];
}) {
  return {
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
        resolution: { width: 1920, height: 1080 },
        audio: false
      }
    ],
    images: options.images,
    speakers: options.speakers,
    audio: { bgm: [], narration: [], sfx: [] },
    captions: [],
    chapters: [],
    provenance: []
  };
}
