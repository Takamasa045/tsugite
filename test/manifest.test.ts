import { describe, expect, it } from "vitest";
import { readJsonFile } from "../src/io.js";
import { validateManifest } from "../src/manifest/validate.js";

describe("manifest validation", () => {
  it("accepts the minimal manifest contract", async () => {
    const manifest = await readJsonFile("fixtures/manifests/minimal.valid.json");
    const result = validateManifest(manifest);

    expect(result.ok).toBe(true);
    expect(result.manifest?.clips).toHaveLength(2);
  });

  it("accepts RenderManifest-compatible extra fields without conversion", async () => {
    const manifest = await readJsonFile("fixtures/manifests/render-manifest.compat.json");
    const result = validateManifest(manifest);

    expect(result.ok).toBe(true);
    expect(result.manifest?.meta.aspect).toBe("9:16");
  });

  it("accepts reserved caption speaker labels and chapters", async () => {
    const manifest = await readJsonFile("fixtures/manifests/captions-chapters.valid.json");
    const result = validateManifest(manifest);

    expect(result.ok).toBe(true);
    expect(result.manifest?.captions[0]?.speaker).toBe("speaker-1");
    expect(result.manifest?.chapters[0]?.title).toBe("Opening");
  });

  it("accepts first-class images, speakers, and an article dialogue presentation", async () => {
    const manifest = await readJsonFile("fixtures/manifests/dialogue.valid.json");
    const result = validateManifest(manifest);

    expect(result.ok).toBe(true);
    expect(result.manifest?.images).toHaveLength(2);
    expect(result.manifest?.speakers[0]?.poses.neutral).toBe("left-neutral");
    expect(result.manifest?.presentation?.preset).toBe("article-dialogue-16x9");
    expect(result.manifest?.captions[0]?.visual?.headline).toContain("answer");
  });

  it("accepts three mouth-state images and rejects unresolved mouth frames", async () => {
    const manifest = (await readJsonFile("fixtures/manifests/dialogue.valid.json")) as Record<string, any>;
    manifest.speakers[0].mouth_frames = ["left-neutral", "left-neutral", "left-neutral"];

    expect(validateManifest(manifest).ok).toBe(true);

    manifest.speakers[0].mouth_frames[1] = "missing-mouth-frame";
    const invalid = validateManifest(manifest);
    expect(invalid.ok).toBe(false);
    expect(invalid.issues.map((issue) => issue.code)).toContain("manifest.speaker.mouth_frame");
  });

  it("rejects an unresolved caption visual image", async () => {
    const manifest = (await readJsonFile("fixtures/manifests/dialogue.valid.json")) as Record<string, any>;
    manifest.captions[0].visual.image_id = "missing-storyboard-image";

    const result = validateManifest(manifest);

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "manifest.caption.visual_image",
        path: "captions.0.visual.image_id"
      })
    );
  });

  it("rejects duplicate image ids and unresolved dialogue references", async () => {
    const manifest = (await readJsonFile("fixtures/manifests/dialogue.valid.json")) as Record<string, any>;
    manifest.images[1].id = manifest.images[0].id;
    manifest.speakers[1].poses.neutral = "missing-image";
    manifest.captions[0].speaker = "missing-speaker";

    const result = validateManifest(manifest);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "manifest.image.id.duplicate",
        "manifest.speaker.image",
        "manifest.caption.speaker"
      ])
    );
  });

  it("rejects overlapping dialogue captions and captions outside the target duration", async () => {
    const manifest = (await readJsonFile("fixtures/manifests/dialogue.valid.json")) as Record<string, any>;
    manifest.captions[1].start = 0.4;
    manifest.captions[1].end = 1.2;

    const result = validateManifest(manifest);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["manifest.caption.overlap", "manifest.caption.range"])
    );
  });

  it("enforces declared presentation aspect and timing for non-dialogue presets", async () => {
    const manifest = (await readJsonFile("fixtures/manifests/captions-chapters.valid.json")) as Record<string, any>;
    manifest.presentation = {
      preset: "image-first-9x16",
      title: "Image first"
    };
    manifest.captions = [
      { text: "First", start: 0, end: 1 },
      { text: "Second", start: 0.8, end: manifest.meta.target_duration_seconds + 1 }
    ];

    const result = validateManifest(manifest);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "manifest.presentation.aspect",
        "manifest.caption.overlap",
        "manifest.caption.range"
      ])
    );
  });

  it("requires silent article dialogue presentations to remain marked as drafts", async () => {
    const manifest = (await readJsonFile("fixtures/manifests/dialogue.valid.json")) as Record<string, any>;
    manifest.presentation.draft = false;

    const result = validateManifest(manifest);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.presentation.draft");
  });

  it("rejects non-local clip sources before execution", async () => {
    const manifest = await readJsonFile("fixtures/manifests/invalid.url-src.json");
    const result = validateManifest(manifest);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.clip.src.local");
  });

  it("rejects invalid clip timing", async () => {
    const manifest = await readJsonFile("fixtures/manifests/invalid.duration.json");
    const result = validateManifest(manifest);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.clip.timing");
  });

  it("rejects invalid caption and chapter timing", async () => {
    const manifest = await readJsonFile("fixtures/manifests/captions-chapters.valid.json");
    const result = validateManifest({
      ...(manifest as object),
      captions: [{ text: "bad", start: 2, end: 1 }],
      chapters: [{ title: "Bad", start: 3, end: 3 }]
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["manifest.caption.timing", "manifest.chapter.timing"])
    );
  });

  it("rejects schema-level manifest errors", async () => {
    const manifest = await readJsonFile("fixtures/manifests/invalid.schema.json");
    const result = validateManifest(manifest);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.schema");
  });
});
