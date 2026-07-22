import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CODEX_SKILL = ".agents/skills/tsugite/SKILL.md";

describe("Tsugite agent skill configuration", () => {
  it("provides a Codex-discoverable repository skill as the canonical workflow", async () => {
    const skill = (await readFile(resolve(ROOT, CODEX_SKILL), "utf8")).replaceAll("\r\n", "\n");

    expect(skill).toMatch(/^---\nname: tsugite\ndescription: .+\n---\n/);
    expect(skill).toContain("## Required Flow");
    expect(skill).toContain("story-guides");
    expect(skill).toContain("run --dry-run");
    expect(skill).toContain("finalize");
    expect(skill).toContain("LESSONS.md");
    expect(skill).toContain("Ask for the Gate 1 decision exactly once");
  });

  it("provides Codex UI metadata with an explicit skill invocation", async () => {
    const metadata = await readFile(
      resolve(ROOT, ".agents/skills/tsugite/agents/openai.yaml"),
      "utf8"
    );

    expect(metadata).toContain('display_name: "Tsugite"');
    expect(metadata).toContain("short_description:");
    expect(metadata).toContain("$tsugite");
  });

  it("provides a Claude Code project skill that loads the Codex canonical workflow", async () => {
    const skill = (await readFile(resolve(ROOT, ".claude/skills/tsugite/SKILL.md"), "utf8")).replaceAll("\r\n", "\n");

    expect(skill).toMatch(/^---\nname: tsugite\ndescription: .+\n---\n/);
    expect(skill).toContain("../../../.agents/skills/tsugite/SKILL.md");
    expect(skill).toContain("完全に読み込");
    expect(skill).not.toContain("## Required Flow");
  });

  it("keeps the root SKILL.md as a legacy pointer instead of a second workflow copy", async () => {
    const legacy = await readFile(resolve(ROOT, "SKILL.md"), "utf8");

    expect(legacy).toContain(CODEX_SKILL);
    expect(legacy).not.toContain("## Required Flow");
  });
});
