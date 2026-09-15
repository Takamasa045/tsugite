import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAuthoringDraft } from "../src/project/createAuthoringDraft.js";
import { loadProject } from "../src/project/loadProject.js";
import { validateProject } from "../src/project/validateProject.js";

describe("authoring draft factory", () => {
  it("creates a valid empty authoring draft without sources or approval", async () => {
    const home = await mkdtemp(join(tmpdir(), "tsugite-authoring-draft-home-"));
    const draft = await createAuthoringDraft({
      projectsHome: home,
      name: "下書き制作",
      brief: "参考動画を後から入れる"
    });
    expect(draft.slug.startsWith("draft-")).toBe(true);
    expect(draft.configPath).toBe(join(draft.projectRoot, "project.yaml"));
    const yaml = await readFile(draft.configPath, "utf8");
    expect(yaml).toContain("kind: authoring");
    expect(yaml).toContain("state: .tsugite/authoring/state.json");
    expect(yaml).toContain("workspace: hypit-workspace");
    const state = JSON.parse(await readFile(join(draft.projectRoot, ".tsugite/authoring/state.json"), "utf8")) as {
      instruction: string;
      run: { production_id: string; reference_digest: string | null; source_files: unknown[]; approval?: unknown };
    };
    expect(state.instruction).toBe("");
    expect(state.run.production_id).toBe(draft.slug);
    expect(state.run.reference_digest).toBeNull();
    expect(state.run.source_files).toEqual([]);
    expect(state.run.approval).toBeUndefined();
    const validation = await validateProject(draft.configPath, { skip_runtime_authority: true });
    expect(validation.ok).toBe(true);
    expect(validation.manifest).toBeUndefined();
  });

  it("roundtrips YAML names that would be booleans, numbers, sequences, or aliases if unquoted", async () => {
    const names = ["true", "123", "[abc]", "*alias", "!tag", "yes"];
    for (const name of names) {
      const home = await mkdtemp(join(tmpdir(), "tsugite-authoring-name-"));
      const draft = await createAuthoringDraft({ projectsHome: home, name });
      const yaml = await readFile(draft.configPath, "utf8");
      expect(yaml).toContain(`name: ${JSON.stringify(name)}`);
      const project = await loadProject(draft.configPath);
      expect(project.name).toBe(name);
    }
  });
});
