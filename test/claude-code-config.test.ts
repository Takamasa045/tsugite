import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

describe("Claude Code project configuration", () => {
  it("allows only routine read and verification commands", async () => {
    const settings = JSON.parse(await readFile(resolve(ROOT, ".claude/settings.json"), "utf8"));

    expect(settings.$schema).toBe("https://json.schemastore.org/claude-code-settings.json");
    expect(settings.permissions.defaultMode).toBe("default");
    expect(settings.permissions.allow).toEqual(expect.arrayContaining([
      "Bash(npm run check)",
      "Bash(bin/pipeline validate *)",
      "Bash(bin/pipeline plan *)",
      "Bash(bin/pipeline review *)",
      "Bash(bin/pipeline run * --dry-run *)",
      "Bash(git status *)",
      "Bash(git diff *)"
    ]));
  });

  it("requires approval for gated execution and publishing and denies destructive access", async () => {
    const settings = JSON.parse(await readFile(resolve(ROOT, ".claude/settings.json"), "utf8"));

    expect(settings.permissions.ask).toEqual(expect.arrayContaining([
      "Bash(bin/pipeline gate *)",
      "Bash(bin/pipeline render *)",
      "Bash(bin/pipeline run * --actor *)",
      "Bash(git commit *)",
      "Bash(git push *)"
    ]));
    expect(settings.permissions.deny).toEqual(expect.arrayContaining([
      "Read(./.env)",
      "Read(./.env.*)",
      "Bash(rm -rf *)",
      "Bash(git reset --hard *)"
    ]));
  });

  it.each([
    ["bin/pipeline run --config projects/demo/project.yaml --actor coordinator --json", "ask"],
    ["bin/pipeline render --config projects/demo/project.yaml --actor coordinator --json", "ask"],
    ["bin/pipeline gate --config projects/demo/project.yaml --gate gate-1 --decision approve", "ask"],
    ["git push origin main", "ask"],
    ["git reset --hard HEAD~1", "deny"],
    ["git clean -df", "deny"],
    ["rm -r -f dist", "deny"]
  ])("guards sensitive Bash command: %s", async (command, expectedDecision) => {
    const output = runGuard(command);

    expect(output.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: expectedDecision
    });
  });

  it("does not escalate a pipeline dry-run", () => {
    expect(runGuard("bin/pipeline run --config projects/demo/project.yaml --dry-run --json")).toEqual({});
  });

  it("provides reusable planning, verification, and optional Shitate commands", async () => {
    const files = await Promise.all([
      readFile(resolve(ROOT, ".claude/commands/tsugite-plan.md"), "utf8"),
      readFile(resolve(ROOT, ".claude/commands/tsugite-verify.md"), "utf8"),
      readFile(resolve(ROOT, ".claude/commands/shitate-import.md"), "utf8")
    ]);

    expect(files[0]).toContain("story-guides");
    expect(files[0]).toContain("run --dry-run");
    expect(files[1]).toContain("npm run check");
    expect(files[2]).toContain("任意");
    expect(files[2]).toContain("明示承認");
  });

  it("keeps Claude entry guidance synchronized with the canonical workflow", async () => {
    const [claude, skill, gitignore] = await Promise.all([
      readFile(resolve(ROOT, "CLAUDE.md"), "utf8"),
      readFile(resolve(ROOT, "SKILL.md"), "utf8"),
      readFile(resolve(ROOT, ".gitignore"), "utf8")
    ]);

    expect(claude).toContain("/tsugite-plan");
    expect(claude).toContain("Shitate");
    expect(skill).toContain("shitate-import");
    expect(skill).toContain("optional");
    expect(gitignore).toContain(".claude/settings.local.json");
  });
});

function runGuard(command: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, [resolve(ROOT, ".claude/hooks/guard-sensitive-actions.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command }
    })
  });
  expect(result.status).toBe(0);
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}
