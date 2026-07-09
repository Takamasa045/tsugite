import { describe, expect, it } from "vitest";
import { loadProject } from "../src/project/loadProject.js";
import { validateProject } from "../src/project/validateProject.js";

describe("project validation", () => {
  it("loads a valid project.yaml", async () => {
    const project = await loadProject("fixtures/projects/local-valid.yaml");

    expect(project.slug).toBe("local-fixture");
    expect(project.edit.backend).toBe("remotion");
  });

  it("rejects an unknown backend during validation", async () => {
    const result = await validateProject("fixtures/projects/unknown-backend.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("backend.not_found");
  });

  it("reports project schema errors", async () => {
    const result = await validateProject("fixtures/projects/invalid-schema.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("project.schema");
  });

  it("rejects unsafe run ids before state paths can be written", async () => {
    const result = await validateProject("fixtures/projects/bad-run-id.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("project.schema");
  });

  it("reports missing manifest files as validation issues", async () => {
    const result = await validateProject("fixtures/projects/missing-manifest.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.read_failed");
  });

  it("reports malformed backend definitions as structured issues", async () => {
    const result = await validateProject("fixtures/projects/malformed-backend.yaml", {
      backendDirs: ["fixtures/backends", "backends"]
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("backend.schema");
    expect(result.issues.map((issue) => issue.code)).not.toContain("backend.not_found");
  });

  it("resolves manifest paths relative to the config file", async () => {
    const result = await validateProject("fixtures/projects/local-valid.yaml");

    expect(result.ok).toBe(true);
    expect(result.manifest?.clips[0]?.src).toBe("../media/clip-001.mp4");
  });

  it("reports missing local clip assets", async () => {
    const result = await validateProject("fixtures/projects/missing-asset.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.clip.src.exists");
  });
});
