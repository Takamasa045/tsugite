import { describe, expect, it } from "vitest";

import { projectSchema } from "../src/project/schema.js";

function projectWithPaths(manifest: string, distDir: string) {
  return {
    slug: "windows-path-check",
    manifest,
    dist_dir: distDir,
    edit: { backend: "remotion" }
  };
}

describe("project path security", () => {
  it.each(["C:/escape", "C:escape", "c:/escape", "Z:escape"])(
    "rejects Windows drive path %s for manifest and dist_dir on every host OS",
    (unsafePath) => {
      expect(projectSchema.safeParse(projectWithPaths(unsafePath, "dist")).success).toBe(false);
      expect(projectSchema.safeParse(projectWithPaths("manifest.json", unsafePath)).success).toBe(false);
    }
  );

  it("keeps the single allowed manifest parent reference", () => {
    expect(projectSchema.safeParse(projectWithPaths("../manifest.json", "dist")).success).toBe(true);
  });
});
