import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Windows support contract", () => {
  it("uses a Node entrypoint and shell-neutral quoting in root npm scripts", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));

    expect(packageJson.scripts.pipeline).toBe("node bin/pipeline");
    expect(packageJson.scripts["viewer:open"]).toBe("node bin/pipeline viewer-launcher --open");
    expect(packageJson.scripts.test).not.toContain("'");
    expect(packageJson.scripts["test:coverage"]).not.toContain("'");
    expect(packageJson.scripts["test:coverage"]).toMatch(/(?:^|\s)--maxWorkers=4(?:\s|$)/);
    expect(packageJson.engines.node).toBe(">=22.12 <23");
  });

  it("runs the native Windows smoke lane through the cross-platform CLI entrypoint", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");

    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("install --id Gyan.FFmpeg");
    expect(workflow).toContain("choco install ffmpeg --version 8.1.2");
    expect(workflow).toContain("ffprobe -version");
    expect(workflow).toContain("node bin/pipeline doctor");
    expect(workflow).toContain("npm --prefix apps/workflow-viewer ci");
    expect(workflow).toContain("npm run viewer:build");
  });

  it("links English and Japanese setup docs to the PowerShell guide", async () => {
    const [english, japanese, chinese, korean, windowsGuide] = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("README.ja.md", "utf8"),
      readFile("README.zh.md", "utf8"),
      readFile("README.ko.md", "utf8"),
      readFile("docs/windows.md", "utf8")
    ]);

    expect(english).toContain("docs/windows.md");
    expect(japanese).toContain("docs/windows.md");
    expect(english).toContain("80% statements, functions, and lines, plus 75% branches");
    expect(japanese).toContain("statements / functions / linesが80%以上、branchesが75%以上");
    expect(chinese).toContain("statements、functions和lines至少达到80%，branches至少达到75%");
    expect(korean).toContain("statements, functions, lines는 80% 이상, branches는 75% 이상");
    for (const readme of [english, japanese, chinese, korean]) {
      expect(readme).toContain("npm run security:audit");
    }
    expect(windowsGuide).toContain("PowerShell");
    expect(windowsGuide).toContain("node bin/pipeline doctor");
    expect(windowsGuide).toContain("npm run viewer:open");
  });

  it("keeps the distributed local-analysis example on the cross-platform CLI entrypoint", async () => {
    const [example, japanese] = await Promise.all([
      readFile("examples/local-analysis/README.md", "utf8"),
      readFile("README.ja.md", "utf8")
    ]);

    for (const command of ["doctor", "validate", "plan", "analyze"]) {
      expect(example).toContain(`node bin/pipeline ${command}`);
      expect(japanese).toContain(`node bin/pipeline ${command}`);
    }
    expect(example).not.toMatch(/^bin\/pipeline /m);
  });
});
