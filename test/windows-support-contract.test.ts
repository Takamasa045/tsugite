import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Windows support contract", () => {
  it("uses a Node entrypoint and shell-neutral quoting in root npm scripts", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));

    expect(packageJson.scripts.pipeline).toBe("node bin/pipeline");
    expect(packageJson.scripts["viewer:open"]).toBe("node bin/pipeline viewer-launcher --open");
    expect(packageJson.scripts.test).not.toContain("'");
    expect(packageJson.scripts["test:coverage"]).not.toContain("'");
    expect(packageJson.engines.node).toBe(">=22.12 <23");
  });

  it("runs the native Windows smoke lane through the cross-platform CLI entrypoint", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");

    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("node bin/pipeline doctor");
    expect(workflow).toContain("npm --prefix apps/workflow-viewer ci");
    expect(workflow).toContain("npm run viewer:build");
  });

  it("links English and Japanese setup docs to the PowerShell guide", async () => {
    const [english, japanese, windowsGuide] = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("README.ja.md", "utf8"),
      readFile("docs/windows.md", "utf8")
    ]);

    expect(english).toContain("docs/windows.md");
    expect(japanese).toContain("docs/windows.md");
    expect(windowsGuide).toContain("PowerShell");
    expect(windowsGuide).toContain("node bin/pipeline doctor");
    expect(windowsGuide).toContain("npm run viewer:open");
  });
});
