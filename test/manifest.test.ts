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

  it("rejects schema-level manifest errors", async () => {
    const manifest = await readJsonFile("fixtures/manifests/invalid.schema.json");
    const result = validateManifest(manifest);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.schema");
  });
});
