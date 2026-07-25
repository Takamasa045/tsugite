import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addCharacterToProject } from "../src/characters/addToProject.js";
import { main } from "../src/cli.js";
import { getCommandHelp } from "../src/cli/commandCatalog.js";
import { validateManifestAssets } from "../src/manifest/assets.js";
import { validateManifest } from "../src/manifest/validate.js";

const tempRoots: string[] = [];

afterEach(async () => {
  tempRoots.length = 0;
});

async function captureCli(args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const status = await main(args);
  const stdout = log.mock.calls.map((call) => String(call[0])).join("\n");
  const stderr = error.mock.calls.map((call) => String(call[0])).join("\n");
  log.mockRestore();
  error.mockRestore();
  return { status, stdout, stderr };
}

describe("addCharacterToProject", () => {
  it("copies speaker images and appends speaker immutably", async () => {
    const fixture = await createFixture({
      sourceSpeakers: [
        {
          id: "hero",
          display_name: "Hero",
          side: "left",
          accent: "#111111",
          poses: { neutral: "hero-neutral", smile: "hero-smile" },
          mouth_frames: ["hero-m0", "hero-m1", "hero-m2"],
          source: { kind: "project", character: "hero", run_id: "r1" }
        }
      ],
      sourceImages: [
        { id: "hero-neutral", src: "media/hero-neutral.png" },
        { id: "hero-smile", src: "media/hero-smile.png" },
        { id: "hero-m0", src: "media/m0.png" },
        { id: "hero-m1", src: "media/m1.png" },
        { id: "hero-m2", src: "media/m2.png" }
      ],
      sourceMedia: [
        "media/hero-neutral.png",
        "media/hero-smile.png",
        "media/m0.png",
        "media/m1.png",
        "media/m2.png"
      ]
    });

    const beforeManifest = await readFile(fixture.targetManifestPath, "utf8");
    const result = await addCharacterToProject({
      sourceManifestPath: fixture.sourceManifestPath,
      sourceRootDir: fixture.sourceRoot,
      speakerId: "hero",
      targetConfigPath: fixture.targetConfigPath
    });

    expect(result).toMatchObject({
      ok: true,
      added: true,
      alreadyPresent: false,
      speakerId: "hero",
      destinationDir: "media/characters/hero"
    });
    if (!result.ok || !result.added) throw new Error("expected added");

    const manifestText = await readFile(fixture.targetManifestPath, "utf8");
    expect(manifestText).not.toBe(beforeManifest);
    const parsed = JSON.parse(manifestText) as Record<string, unknown>;
    const validation = validateManifest(parsed);
    expect(validation.ok).toBe(true);
    expect(validation.manifest?.speakers).toContainEqual(
      expect.objectContaining({
        id: "hero",
        display_name: "Hero",
          side: "left",
        accent: "#111111",
        poses: {
          neutral: "hero-neutral",
          smile: "hero-smile"
        },
        mouth_frames: ["hero-m0", "hero-m1", "hero-m2"],
        source: { kind: "project", character: "hero", run_id: "r1" }
      })
    );

    const assetResult = await validateManifestAssets(
      validation.manifest!,
      dirname(fixture.targetManifestPath),
      { assetRoot: fixture.targetRoot }
    );
    expect(assetResult.ok).toBe(true);

    for (const imageId of ["hero-neutral", "hero-smile", "hero-m0", "hero-m1", "hero-m2"]) {
      const image = validation.manifest!.images.find((entry) => entry.id === imageId);
      expect(image?.src.includes("\\")).toBe(false);
      expect(image?.src.startsWith("media/characters/hero/")).toBe(true);
    }
  });

  it("is a no-op when the same speaker fingerprint already exists", async () => {
    const fixture = await createFixture({
      sourceSpeakers: [
        {
          id: "hero",
          display_name: "Hero",
          side: "left",
          accent: "#111111",
          poses: { neutral: "hero-neutral" }
        }
      ],
      sourceImages: [{ id: "hero-neutral", src: "media/hero-neutral.png" }],
      sourceMedia: ["media/hero-neutral.png"]
    });

    const first = await addCharacterToProject({
      sourceManifestPath: fixture.sourceManifestPath,
      sourceRootDir: fixture.sourceRoot,
      speakerId: "hero",
      targetConfigPath: fixture.targetConfigPath
    });
    expect(first.ok && first.added).toBe(true);

    const snapshot = await snapshotTarget(fixture.targetRoot);
    const second = await addCharacterToProject({
      sourceManifestPath: fixture.sourceManifestPath,
      sourceRootDir: fixture.sourceRoot,
      speakerId: "hero",
      targetConfigPath: fixture.targetConfigPath
    });

    expect(second).toMatchObject({
      ok: true,
      added: false,
      alreadyPresent: true,
      speakerId: "hero"
    });
    expect(await snapshotTarget(fixture.targetRoot)).toEqual(snapshot);
  });

  it("rejects a conflicting speaker without writing", async () => {
    const fixture = await createFixture({
      sourceSpeakers: [
        {
          id: "hero",
          display_name: "Hero",
          side: "left",
          accent: "#111111",
          poses: { neutral: "hero-neutral" }
        }
      ],
      sourceImages: [{ id: "hero-neutral", src: "media/hero-neutral.png" }],
      sourceMedia: ["media/hero-neutral.png"],
      targetSpeakers: [
        {
          id: "hero",
          display_name: "Other",
          side: "right",
          accent: "#000000",
          poses: { neutral: "existing-hero" }
        }
      ],
      targetImages: [{ id: "existing-hero", src: "media/existing-hero.png" }],
      targetMedia: ["media/existing-hero.png"]
    });

    const snapshot = await snapshotTarget(fixture.targetRoot);
    const result = await addCharacterToProject({
      sourceManifestPath: fixture.sourceManifestPath,
      sourceRootDir: fixture.sourceRoot,
      speakerId: "hero",
      targetConfigPath: fixture.targetConfigPath
    });

    expect(result).toMatchObject({
      ok: false,
      issue: { code: "character_add.speaker_conflict" }
    });
    expect(await snapshotTarget(fixture.targetRoot)).toEqual(snapshot);
  });

  it("reuses same-hash image ids and remaps conflicting content", async () => {
    const sharedBytes = Buffer.from("shared-image-bytes");
    const otherBytes = Buffer.from("different-image-bytes");
    const fixture = await createFixture({
      sourceSpeakers: [
        {
          id: "hero",
          display_name: "Hero",
          side: "left",
          accent: "#111111",
          poses: { neutral: "shared-id", smile: "conflict-id" }
        }
      ],
      sourceImages: [
        { id: "shared-id", src: "media/shared.png" },
        { id: "conflict-id", src: "media/conflict-src.png" }
      ],
      sourceMedia: [],
      targetSpeakers: [],
      targetImages: [
        { id: "shared-id", src: "media/already-shared.png" },
        { id: "conflict-id", src: "media/already-conflict.png" }
      ],
      targetMedia: []
    });

    await writeFile(join(fixture.sourceRoot, "media/shared.png"), sharedBytes);
    await writeFile(join(fixture.sourceRoot, "media/conflict-src.png"), otherBytes);
    await writeFile(join(fixture.targetRoot, "media/already-shared.png"), sharedBytes);
    await writeFile(join(fixture.targetRoot, "media/already-conflict.png"), Buffer.from("target-conflict"));

    const result = await addCharacterToProject({
      sourceManifestPath: fixture.sourceManifestPath,
      sourceRootDir: fixture.sourceRoot,
      speakerId: "hero",
      targetConfigPath: fixture.targetConfigPath
    });

    expect(result.ok && result.added).toBe(true);
    if (!result.ok || !result.added) throw new Error("expected added");
    expect(result.imageIdMap["shared-id"]).toBe("shared-id");
    expect(result.imageIdMap["conflict-id"]).toBe("conflict-id-2");

    const manifest = JSON.parse(await readFile(fixture.targetManifestPath, "utf8")) as {
      speakers: Array<{ poses: Record<string, string> }>;
      images: Array<{ id: string; src: string }>;
    };
    expect(manifest.speakers[0]?.poses).toEqual({
      neutral: "shared-id",
      smile: "conflict-id-2"
    });
    expect(manifest.images.some((image) => image.id === "conflict-id-2")).toBe(true);
    expect(manifest.images.filter((image) => image.id === "shared-id")).toHaveLength(1);
  });

  it("sanitizes non-ASCII speaker ids into char-<sha8> directories", async () => {
    const speakerId = "ヒーロー";
    const expectedDir = `char-${createHash("sha256").update(speakerId).digest("hex").slice(0, 8)}`;
    const fixture = await createFixture({
      sourceSpeakers: [
        {
          id: speakerId,
          display_name: "Hero JP",
          side: "left",
          accent: "#abcdef",
          poses: { neutral: "jp-neutral" }
        }
      ],
      sourceImages: [{ id: "jp-neutral", src: "media/jp.png" }],
      sourceMedia: ["media/jp.png"]
    });

    const result = await addCharacterToProject({
      sourceManifestPath: fixture.sourceManifestPath,
      sourceRootDir: fixture.sourceRoot,
      speakerId,
      targetConfigPath: fixture.targetConfigPath
    });

    expect(result).toMatchObject({
      ok: true,
      added: true,
      speakerId,
      destinationDir: `media/characters/${expectedDir}`
    });
    const mediaDir = join(fixture.targetRoot, "media/characters", expectedDir);
    expect((await stat(mediaDir)).isDirectory()).toBe(true);
  });

  it("rolls back copied files when the write path fails after staging", async () => {
    const fixture = await createFixture({
      sourceSpeakers: [
        {
          id: "hero",
          display_name: "Hero",
          side: "left",
          accent: "#111111",
          poses: { neutral: "hero-neutral" }
        }
      ],
      sourceImages: [{ id: "hero-neutral", src: "media/hero-neutral.png" }],
      sourceMedia: ["media/hero-neutral.png"]
    });

    const snapshot = await snapshotTarget(fixture.targetRoot);
    const result = await addCharacterToProject({
      sourceManifestPath: fixture.sourceManifestPath,
      sourceRootDir: fixture.sourceRoot,
      speakerId: "hero",
      targetConfigPath: fixture.targetConfigPath,
      _beforeWrite: async () => {
        throw new Error("simulated write failure");
      }
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.issue.code).toBe("character_add.failed");
    expect(await pathExistsSafe(join(fixture.targetRoot, "media/characters/hero"))).toBe(false);
    expect(await snapshotTarget(fixture.targetRoot)).toEqual(snapshot);
  });

  it("fails with target_changed when the manifest is modified before write", async () => {
    const fixture = await createFixture({
      sourceSpeakers: [
        {
          id: "hero",
          display_name: "Hero",
          side: "left",
          accent: "#111111",
          poses: { neutral: "hero-neutral" }
        }
      ],
      sourceImages: [{ id: "hero-neutral", src: "media/hero-neutral.png" }],
      sourceMedia: ["media/hero-neutral.png"]
    });

    const result = await addCharacterToProject({
      sourceManifestPath: fixture.sourceManifestPath,
      sourceRootDir: fixture.sourceRoot,
      speakerId: "hero",
      targetConfigPath: fixture.targetConfigPath,
      _beforeWrite: async () => {
        const current = await readFile(fixture.targetManifestPath, "utf8");
        const parsed = JSON.parse(current) as { meta: { slug: string } };
        parsed.meta.slug = "mutated-during-add";
        await writeFile(fixture.targetManifestPath, `${JSON.stringify(parsed, null, 2)}\n`);
      }
    });

    expect(result).toMatchObject({
      ok: false,
      issue: { code: "character_add.target_changed" }
    });
    expect(await pathExistsSafe(join(fixture.targetRoot, "media/characters/hero"))).toBe(false);
  });

  it("rejects speakers with missing pose images", async () => {
    const fixture = await createFixture({
      sourceSpeakers: [
        {
          id: "ghost",
          display_name: "Ghost",
          side: "left",
          accent: "#000000",
          poses: { neutral: "missing-image" }
        }
      ],
      sourceImages: [],
      sourceMedia: []
    });

    const snapshot = await snapshotTarget(fixture.targetRoot);
    const result = await addCharacterToProject({
      sourceManifestPath: fixture.sourceManifestPath,
      sourceRootDir: fixture.sourceRoot,
      speakerId: "ghost",
      targetConfigPath: fixture.targetConfigPath
    });

    expect(result).toMatchObject({
      ok: false,
      issue: { code: "character_add.missing_pose" }
    });
    expect(await snapshotTarget(fixture.targetRoot)).toEqual(snapshot);
  });

  it("rejects when pose image file is absent on disk", async () => {
    const fixture = await createFixture({
      sourceSpeakers: [
        {
          id: "ghost",
          display_name: "Ghost",
          side: "left",
          accent: "#000000",
          poses: { neutral: "ghost-n" }
        }
      ],
      sourceImages: [{ id: "ghost-n", src: "media/ghost.png" }],
      sourceMedia: []
    });

    const result = await addCharacterToProject({
      sourceManifestPath: fixture.sourceManifestPath,
      sourceRootDir: fixture.sourceRoot,
      speakerId: "ghost",
      targetConfigPath: fixture.targetConfigPath
    });

    expect(result).toMatchObject({
      ok: false,
      issue: { code: "character_add.source_image_missing" }
    });
  });

  it("keeps distinct special-character image ids from colliding on disk", async () => {
    const fixture = await createFixture({
      sourceSpeakers: [
        {
          id: "hero",
          display_name: "Hero",
          side: "left",
          accent: "#111111",
          poses: { neutral: "hero@1", smile: "hero#1" }
        }
      ],
      sourceImages: [
        { id: "hero@1", src: "media/a.png" },
        { id: "hero#1", src: "media/b.png" }
      ],
      sourceMedia: [],
      targetSpeakers: [],
      targetImages: [],
      targetMedia: []
    });
    await writeFile(join(fixture.sourceRoot, "media/a.png"), Buffer.from("bytes-a"));
    await writeFile(join(fixture.sourceRoot, "media/b.png"), Buffer.from("bytes-b"));

    const result = await addCharacterToProject({
      sourceManifestPath: fixture.sourceManifestPath,
      sourceRootDir: fixture.sourceRoot,
      speakerId: "hero",
      targetConfigPath: fixture.targetConfigPath
    });

    expect(result.ok && result.added).toBe(true);
    if (!result.ok || !result.added) throw new Error("expected added");

    const manifest = JSON.parse(await readFile(fixture.targetManifestPath, "utf8")) as {
      images: Array<{ id: string; src: string }>;
    };
    const srcs = manifest.images
      .filter((image) => image.id === "hero@1" || image.id === "hero#1")
      .map((image) => image.src)
      .sort();
    expect(srcs).toHaveLength(2);
    expect(srcs[0]).not.toBe(srcs[1]);
    expect(srcs.every((src) => !src.includes("\\") && src.startsWith("media/characters/hero/"))).toBe(true);
  });

  it("rejects an unknown speaker id in the source manifest", async () => {
    const fixture = await createFixture({
      sourceSpeakers: [
        {
          id: "hero",
          display_name: "Hero",
          side: "left",
          accent: "#111111",
          poses: { neutral: "hero-neutral" }
        }
      ],
      sourceImages: [{ id: "hero-neutral", src: "media/hero-neutral.png" }],
      sourceMedia: ["media/hero-neutral.png"]
    });
    const result = await addCharacterToProject({
      sourceManifestPath: fixture.sourceManifestPath,
      sourceRootDir: fixture.sourceRoot,
      speakerId: "no-such-speaker",
      targetConfigPath: fixture.targetConfigPath
    });
    expect(result).toMatchObject({
      ok: false,
      issue: { code: "character_add.speaker_missing" }
    });
  });

  it("rejects invalid source manifest JSON", async () => {
    const fixture = await createFixture({
      sourceSpeakers: [
        {
          id: "hero",
          display_name: "Hero",
          side: "left",
          accent: "#111111",
          poses: { neutral: "hero-neutral" }
        }
      ],
      sourceImages: [{ id: "hero-neutral", src: "media/hero-neutral.png" }],
      sourceMedia: ["media/hero-neutral.png"]
    });
    await writeFile(fixture.sourceManifestPath, "{not-json", "utf8");
    const result = await addCharacterToProject({
      sourceManifestPath: fixture.sourceManifestPath,
      sourceRootDir: fixture.sourceRoot,
      speakerId: "hero",
      targetConfigPath: fixture.targetConfigPath
    });
    expect(result).toMatchObject({
      ok: false,
      issue: { code: "character_add.source_manifest_invalid" }
    });
  });

  it("rejects source image paths that escape the source root", async () => {
    const fixture = await createFixture({
      sourceSpeakers: [
        {
          id: "hero",
          display_name: "Hero",
          side: "left",
          accent: "#111111",
          poses: { neutral: "escape" }
        }
      ],
      sourceImages: [{ id: "escape", src: "../outside.png" }],
      sourceMedia: []
    });
    const outside = join(dirname(fixture.sourceRoot), "outside.png");
    await writeFile(outside, Buffer.from("escape-bytes"));

    const result = await addCharacterToProject({
      sourceManifestPath: fixture.sourceManifestPath,
      sourceRootDir: fixture.sourceRoot,
      speakerId: "hero",
      targetConfigPath: fixture.targetConfigPath
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.issue.code).toMatch(/character_add\.(source_image_escape|source_image_missing|missing_pose)/);
  });
});

describe("character-add CLI", () => {
  it("is registered as a local-write catalog command", () => {
    expect(getCommandHelp("character-add")).toMatchObject({
      name: "character-add",
      requiresConfig: true,
      safety: "local-write",
      usage: "node bin/pipeline character-add --config <project.yaml> --from-manifest <manifest.json> --speaker <speaker-id> [--json]",
      options: [
        expect.objectContaining({ name: "--config" }),
        expect.objectContaining({ name: "--from-manifest" }),
        expect.objectContaining({ name: "--speaker" })
      ]
    });
  });

  it("copies a speaker through the pipeline command", async () => {
    const fixture = await createFixture({
      sourceSpeakers: [
        {
          id: "hero",
          display_name: "Hero",
          side: "left",
          accent: "#111111",
          poses: { neutral: "hero-neutral" },
          mouth_frames: ["hero-m0", "hero-m1", "hero-m2"]
        }
      ],
      sourceImages: [
        { id: "hero-neutral", src: "media/hero-neutral.png" },
        { id: "hero-m0", src: "media/m0.png" },
        { id: "hero-m1", src: "media/m1.png" },
        { id: "hero-m2", src: "media/m2.png" }
      ],
      sourceMedia: [
        "media/hero-neutral.png",
        "media/m0.png",
        "media/m1.png",
        "media/m2.png"
      ]
    });

    const result = await captureCli([
      "character-add",
      "--config",
      fixture.targetConfigPath,
      "--from-manifest",
      fixture.sourceManifestPath,
      "--speaker",
      "hero",
      "--json"
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "character-add",
      speaker_id: "hero",
      added: true,
      already_present: false,
      destination_dir: "media/characters/hero"
    });

    const manifest = JSON.parse(await readFile(fixture.targetManifestPath, "utf8")) as {
      speakers: Array<{ id: string }>;
    };
    expect(manifest.speakers.map((entry) => entry.id)).toContain("hero");
  });

  it("reports missing character-add arguments as structured issues", async () => {
    const fixture = await createFixture({
      sourceSpeakers: [],
      sourceImages: [],
      sourceMedia: []
    });

    const result = await captureCli([
      "character-add",
      "--config",
      fixture.targetConfigPath,
      "--json"
    ]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).issues.map((issue: { code: string }) => issue.code)).toEqual([
      "character_add.from_manifest_required",
      "character_add.speaker_required"
    ]);
  });

  it("returns exit code 1 when the speaker conflicts", async () => {
    const fixture = await createFixture({
      sourceSpeakers: [
        {
          id: "hero",
          display_name: "Hero A",
          side: "left",
          accent: "#111111",
          poses: { neutral: "hero-neutral" }
        }
      ],
      sourceImages: [{ id: "hero-neutral", src: "media/hero-neutral.png" }],
      sourceMedia: ["media/hero-neutral.png"],
      targetSpeakers: [
        {
          id: "hero",
          display_name: "Hero B",
          side: "right",
          accent: "#222222",
          poses: { neutral: "other-neutral" }
        }
      ],
      targetImages: [{ id: "other-neutral", src: "media/other-neutral.png" }],
      targetMedia: ["media/other-neutral.png"]
    });

    const result = await captureCli([
      "character-add",
      "--config",
      fixture.targetConfigPath,
      "--from-manifest",
      fixture.sourceManifestPath,
      "--speaker",
      "hero",
      "--json"
    ]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      command: "character-add",
      issues: [expect.objectContaining({ code: expect.stringMatching(/^character_add\./) })]
    });
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

type FixtureOptions = {
  sourceSpeakers: SpeakerFixture[];
  sourceImages: Array<{ id: string; src: string }>;
  sourceMedia: string[];
  targetSpeakers?: SpeakerFixture[];
  targetImages?: Array<{ id: string; src: string }>;
  targetMedia?: string[];
};

async function createFixture(options: FixtureOptions) {
  const root = await mkdtemp(join(tmpdir(), "tsugite-char-add-"));
  tempRoots.push(root);
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "target");
  await mkdir(join(sourceRoot, "media"), { recursive: true });
  await mkdir(join(targetRoot, "media"), { recursive: true });

  for (const relative of options.sourceMedia) {
    const absolute = join(sourceRoot, relative);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, Buffer.from(`source:${relative}`));
  }
  // Source clip placeholder for a valid source manifest.
  await writeFile(join(sourceRoot, "media/background.mp4"), Buffer.from("source-video"));

  for (const relative of options.targetMedia ?? []) {
    const absolute = join(targetRoot, relative);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, Buffer.from(`target:${relative}`));
  }
  await writeFile(join(targetRoot, "media/background.mp4"), Buffer.from("target-video"));

  const sourceManifestPath = join(sourceRoot, "manifest.json");
  await writeFile(
    sourceManifestPath,
    `${JSON.stringify(
      buildManifest({
        slug: "source-cast",
        name: "source-cast",
      speakers: options.sourceSpeakers,
        images: options.sourceImages
      }),
      null,
      2
    )}\n`
  );

  const targetConfigPath = join(targetRoot, "project.yaml");
  const targetManifestPath = join(targetRoot, "manifest.json");
  await writeFile(
    targetConfigPath,
    `slug: target-cast
name: ターゲットキャスト
run_id: target-cast-r1
manifest: manifest.json
dist_dir: dist
edit:
  backend: remotion
`
  );
  await writeFile(
    targetManifestPath,
    `${JSON.stringify(
      buildManifest({
        slug: "target-cast",
        speakers: options.targetSpeakers ?? [],
        images: options.targetImages ?? []
      }),
      null,
      2
    )}\n`
  );

  return {
    root,
    sourceRoot,
    targetRoot,
    sourceManifestPath,
    targetConfigPath,
    targetManifestPath
  };
}

function buildManifest(options: {
  slug: string;
  speakers: SpeakerFixture[];
  images: Array<{ id: string; src: string }>;
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

async function snapshotTarget(targetRoot: string): Promise<{
  files: string[];
  digests: Record<string, string>;
}> {
  const files: string[] = [];
  const digests: Record<string, string> = {};
  await walk(targetRoot, targetRoot, files, digests);
  files.sort();
  return { files, digests };
}

async function walk(
  root: string,
  current: string,
  files: string[],
  digests: Record<string, string>
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    const relative = absolute.slice(root.length + 1).split("\\").join("/");
    if (entry.isDirectory()) {
      await walk(root, absolute, files, digests);
      continue;
    }
    files.push(relative);
    digests[relative] = createHash("sha256").update(await readFile(absolute)).digest("hex");
  }
}

async function pathExistsSafe(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
