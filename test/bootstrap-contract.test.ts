import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateProject } from "../src/project/validateProject.js";

describe("bootstrap repository contract", () => {
  it("exposes the dependency-free npm entrypoints", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));

    expect(packageJson.scripts).toMatchObject({
      "setup:check": "node scripts/bootstrap.mjs --check",
      setup: "node scripts/bootstrap.mjs",
      "setup:open": "node scripts/bootstrap.mjs --open"
    });
  });

  it("keeps the copy-ready prompt identical to the documented prompt", async () => {
    const document = await readFile("docs/onboarding/codex-setup-prompt.ja.md", "utf8");
    const prompt = await readFile("prompts/setup-tsugite-ja.txt", "utf8");
    const documentedPrompt = /```text\n([\s\S]*?)\n```/.exec(document)?.[1];

    expect(documentedPrompt).toBe(prompt.trim());
  });

  it("documents every approval boundary enforced by bootstrap", async () => {
    const contract = await readFile("docs/onboarding/setup-contract.ja.md", "utf8");

    for (const requiredText of [
      "システムソフトの導入・更新",
      "外部サービスへのログイン",
      "APIキー、トークン、Cookie",
      "非dry-runの`run`、`render`",
      "Gate 1〜3",
      "commit、push",
      "既存ファイルや既存案件の上書き・削除",
      "`doctor`、`validate`、`plan`",
      "`origin`が`Takamasa045/tsugite`"
    ]) {
      expect(contract).toContain(requiredText);
    }
  });

  it("ships a valid, zero-credit local quickstart project", async () => {
    const validation = await validateProject("examples/quickstart-local/project.yaml");
    const project = await readFile("examples/quickstart-local/project.yaml", "utf8");
    const manifest = JSON.parse(await readFile("examples/quickstart-local/manifest.json", "utf8"));

    expect(validation.ok).toBe(true);
    expect(project).toContain("name: はじめての継手");
    expect(project).toContain("slug: my-first-tsugite");
    expect(manifest.meta.slug).toBe("my-first-tsugite");
    expect(project).not.toContain("generation:");
    expect(manifest.provenance.every((item: { credits?: number }) => item.credits === 0)).toBe(true);
  });
});
