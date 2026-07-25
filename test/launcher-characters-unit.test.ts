import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLauncherCharacterCatalog,
  characterImageKey,
  useCharacterFromCatalog
} from "../src/viewer/launcherCharacters.js";

describe("launcherCharacters helpers", () => {
  it("accepts string and object projectDirectories and marks readOnly shelves", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-launcher-chars-"));
    const writableShelf = join(root, "writable");
    const readOnlyShelf = join(root, "readonly");
    const templatesDir = join(root, "templates");

    await writeProject(join(writableShelf, "w-proj"), "w-hero", "Writable Hero");
    await writeProject(join(readOnlyShelf, "r-proj"), "r-hero", "Readonly Hero");
    await writeTemplate(templatesDir, "demo", "default", "t-hero", "Template Hero");

    const catalog = await buildLauncherCharacterCatalog({
      projectDirectories: [
        writableShelf,
        { path: readOnlyShelf, readOnly: true }
      ],
      templatesDir
    });

    const byId = Object.fromEntries(catalog.characters.map((c) => [c.id, c]));
    expect(byId["w-hero"]?.sources[0]?.readOnly).toBe(false);
    expect(byId["w-hero"]?.sources[0]?.canUse).toBe(true);
    expect(byId["r-hero"]?.sources[0]?.readOnly).toBe(true);
    expect(byId["t-hero"]?.sources[0]?.readOnly).toBe(true);
    expect(byId["t-hero"]?.sources[0]?.kind).toBe("template");
    expect(byId["w-hero"]?.representativeImageKey).toMatch(/^[a-f0-9]{32}$/);
  });

  it("marks canUse false when a pose is missing and useCharacterFromCatalog rejects it", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-launcher-chars-missing-"));
    const shelf = join(root, "projects");
    const projectDir = join(shelf, "ghost-proj");
    await mkdir(join(projectDir, "media"), { recursive: true });
    await writeFile(join(projectDir, "media/background.mp4"), Buffer.from("video"));
    await writeFile(
      join(projectDir, "project.yaml"),
      [
        "slug: ghost",
        "run_id: ghost-r1",
        "manifest: manifest.json",
        "dist_dir: dist",
        "edit:",
        "  backend: remotion",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(projectDir, "manifest.json"),
      `${JSON.stringify(buildManifest("ghost", [
        {
          id: "ghost",
          display_name: "Ghost",
          side: "left",
          accent: "#000000",
          poses: { neutral: "missing" }
        }
      ], []), null, 2)}\n`,
      "utf8"
    );

    const catalog = await buildLauncherCharacterCatalog({ projectDirectories: [shelf] });
    const source = catalog.characters[0]?.sources[0];
    expect(source?.canUse).toBe(false);

    const rejected = await useCharacterFromCatalog({
      sourceKey: source!.sourceKey,
      speakerId: source!.speakerId,
      targetConfigPath: join(projectDir, "project.yaml"),
      catalog
    });
    expect(rejected).toMatchObject({
      ok: false,
      issue: { code: "character_add.missing_pose" }
    });
  });

  it("rejects unknown sourceKey and speaker mismatch in useCharacterFromCatalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-launcher-chars-use-"));
    const shelf = join(root, "projects");
    await writeProject(join(shelf, "ok"), "hero", "Hero");
    const catalog = await buildLauncherCharacterCatalog({ projectDirectories: [shelf] });
    const source = catalog.characters[0]!.sources[0]!;

    const missing = await useCharacterFromCatalog({
      sourceKey: "nope",
      speakerId: source.speakerId,
      targetConfigPath: join(shelf, "ok", "project.yaml"),
      catalog
    });
    expect(missing).toMatchObject({
      ok: false,
      issue: { code: "character_use.source_not_found" }
    });

    const mismatch = await useCharacterFromCatalog({
      sourceKey: source.sourceKey,
      speakerId: "other",
      targetConfigPath: join(shelf, "ok", "project.yaml"),
      catalog
    });
    expect(mismatch).toMatchObject({
      ok: false,
      issue: { code: "character_use.speaker_mismatch" }
    });
  });

  it("characterImageKey is stable and 32 hex chars", () => {
    const a = characterImageKey("/tmp/root", "media/a.png");
    const b = characterImageKey("/tmp/root", "media/a.png");
    const c = characterImageKey("/tmp/root", "media/b.png");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{32}$/);
    expect(a).not.toBe(c);
  });
});

async function writeProject(dir: string, speakerId: string, displayName: string): Promise<void> {
  await mkdir(join(dir, "media"), { recursive: true });
  await writeFile(join(dir, "media", "neutral.png"), Buffer.from(`img-${speakerId}`));
  await writeFile(join(dir, "media", "background.mp4"), Buffer.from("video"));
  await writeFile(
    join(dir, "project.yaml"),
    [
      `slug: ${speakerId}`,
      `run_id: ${speakerId}-r1`,
      "manifest: manifest.json",
      "dist_dir: dist",
      "edit:",
      "  backend: remotion",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(dir, "manifest.json"),
    `${JSON.stringify(
      buildManifest(speakerId, [
        {
          id: speakerId,
          display_name: displayName,
          side: "left",
          accent: "#6B7A5A",
          poses: { neutral: `${speakerId}-n` }
        }
      ], [{ id: `${speakerId}-n`, src: "media/neutral.png", alt: displayName }]),
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function writeTemplate(
  templatesDir: string,
  templateId: string,
  variantId: string,
  speakerId: string,
  displayName: string
): Promise<void> {
  const dir = join(templatesDir, templateId, "dist", variantId);
  await mkdir(join(dir, "media"), { recursive: true });
  await writeFile(join(dir, "media", "neutral.png"), Buffer.from(`tpl-${speakerId}`));
  await writeFile(join(dir, "media", "background.mp4"), Buffer.from("video"));
  await writeFile(
    join(dir, "manifest.json"),
    `${JSON.stringify(
      buildManifest(speakerId, [
        {
          id: speakerId,
          display_name: displayName,
          side: "right",
          accent: "#334455",
          poses: { neutral: `${speakerId}-n` }
        }
      ], [{ id: `${speakerId}-n`, src: "media/neutral.png", alt: displayName }]),
      null,
      2
    )}\n`,
    "utf8"
  );
}

function buildManifest(
  slug: string,
  speakers: Array<{
    id: string;
    display_name: string;
    side: "left" | "right";
    accent: string;
    poses: Record<string, string>;
  }>,
  images: Array<{ id: string; src: string; alt?: string }>
) {
  return {
    meta: {
      aspect: "16:9",
      fps: 30,
      target_duration_seconds: 5,
      slug
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
    images,
    speakers,
    audio: { bgm: [], narration: [], sfx: [] },
    captions: [],
    chapters: [],
    provenance: []
  };
}
