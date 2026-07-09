import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateProject } from "../src/project/validateProject.js";

describe("lessons graduation", () => {
  it("keeps the mcp-agent skill lesson backed by validation", async () => {
    const lessons = await readFile("LESSONS.md", "utf8");
    const result = await validateProject("fixtures/projects/no-skill-agent.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });

    expect(lessons).toContain("mcp-agent adapters must include SKILL.md / validate済");
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("adapter.skill_md_missing");
  });
});
