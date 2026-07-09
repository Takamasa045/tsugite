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
