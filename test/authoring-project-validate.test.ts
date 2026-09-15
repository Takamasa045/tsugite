import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAuthoringEngineRun, digestAuthoringRun } from "../src/productionControl/authoringEngine.js";
import { loadProject } from "../src/project/loadProject.js";
import { projectSchema } from "../src/project/schema.js";
import { validateProject } from "../src/project/validateProject.js";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeAuthoringFixture(options?: {
  productionId?: string;
  adapter?: string;
  omitState?: boolean;
  emptyState?: boolean;
  mismatchId?: boolean;
  sourceMissing?: boolean;
  workspaceSymlink?: boolean;
  customWorkspace?: string;
  customState?: string;
}): Promise<{ root: string; configPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "tsugite-authoring-validate-"));
  const productionId = options?.productionId ?? "authoring-lab";
  const workspaceName = options?.customWorkspace ?? "hypit-workspace";
  const workspace = join(root, workspaceName);
  if (options?.workspaceSymlink) {
    const target = await mkdtemp(join(tmpdir(), "tsugite-authoring-outside-"));
    await symlink(target, workspace);
  } else {
    await mkdir(workspace, { recursive: true });
  }
  await mkdir(join(root, ".tsugite", "authoring"), { recursive: true });
  const source = "main source\n";
  if (!options?.workspaceSymlink) await writeFile(join(workspace, "main.svml"), source);
  const { digest: _digest, ...runBase } = createAuthoringEngineRun({
    production_id: options?.mismatchId ? "other-id" : productionId,
    adapter_id: "authoring-adapter",
    brief_digest: sha256("brief"),
    import_allowlist_digest: sha256("allow")
  });
  const run = digestAuthoringRun({
    ...runBase,
    source_files: options?.sourceMissing
      ? [{ relative_path: "missing.svml", sha256: sha256("x"), bytes: 1 }]
      : [{ relative_path: "main.svml", sha256: sha256(source), bytes: Buffer.byteLength(source) }]
  });
  if (!options?.omitState) {
    await writeFile(
      join(root, options?.customState ?? ".tsugite/authoring/state.json"),
      options?.emptyState
        ? "{}\n"
        : `${JSON.stringify({ workspace, run }, null, 2)}\n`
    );
  }
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      meta: { aspect: "9:16", fps: 30, target_duration_seconds: 30, slug: productionId },
      clips: [],
      audio: { bgm: [], narration: [], sfx: [] }
    }, null, 2)
  );
  const yaml = [
    `slug: ${productionId}`,
    "name: 制作エンジン検証",
    `run_id: ${productionId}`,
    "production:",
    "  kind: authoring",
    `  adapter: ${options?.adapter ?? "hypit"}`,
    `  state: ${options?.customState ?? ".tsugite/authoring/state.json"}`,
    `  workspace: ${workspaceName}`,
    "manifest: manifest.json",
    "dist_dir: dist",
    "edit:",
    "  backend: remotion"
  ].join("\n");
  const configPath = join(root, "project.yaml");
  await writeFile(configPath, `${yaml}\n`);
  return { root, configPath };
}

describe("authoring production validation", () => {
  it("accepts a registered authoring production without validating empty legacy clips", async () => {
    const fixture = await writeAuthoringFixture();
    const result = await validateProject(fixture.configPath, { skip_runtime_authority: true });
    expect(result.ok).toBe(true);
    expect(result.manifest).toBeUndefined();
    expect(result.project?.production).toEqual({
      kind: "authoring",
      adapter: "hypit",
      state: ".tsugite/authoring/state.json",
      workspace: "hypit-workspace"
    });
  });

  it("keeps legacy empty-clip manifests invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-legacy-empty-clips-"));
    await writeFile(
      join(root, "manifest.json"),
      JSON.stringify({
        meta: { aspect: "9:16", fps: 30, target_duration_seconds: 30, slug: "legacy" },
        clips: [],
        audio: { bgm: [], narration: [], sfx: [] }
      })
    );
    const configPath = join(root, "project.yaml");
    await writeFile(configPath, [
      "slug: legacy",
      "name: 従来案件",
      "run_id: legacy",
      "manifest: manifest.json",
      "dist_dir: dist",
      "edit:",
      "  backend: remotion"
    ].join("\n"));
    const result = await validateProject(configPath, { skip_runtime_authority: true });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("clips") || issue.code.includes("manifest"))).toBe(true);
  });

  it("rejects missing authoring state", async () => {
    const fixture = await writeAuthoringFixture({ omitState: true });
    const result = await validateProject(fixture.configPath, { skip_runtime_authority: true });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("authoring.file_missing");
  });

  it("rejects invalid authoring state", async () => {
    const fixture = await writeAuthoringFixture({ emptyState: true });
    const result = await validateProject(fixture.configPath, { skip_runtime_authority: true });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("authoring.state_invalid");
  });

  it("rejects production identity mismatch", async () => {
    const fixture = await writeAuthoringFixture({ mismatchId: true });
    const result = await validateProject(fixture.configPath, { skip_runtime_authority: true });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "authoring.identity_mismatch")).toBe(true);
  });

  it("rejects missing bound source files", async () => {
    const fixture = await writeAuthoringFixture({ sourceMissing: true });
    const result = await validateProject(fixture.configPath, { skip_runtime_authority: true });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "authoring.source_missing")).toBe(true);
  });

  it("rejects an unregistered adapter", async () => {
    const fixture = await writeAuthoringFixture({ adapter: "not-a-real-adapter" });
    const result = await validateProject(fixture.configPath, { skip_runtime_authority: true });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("authoring.adapter_unregistered");
  });

  it("rejects a workspace symlink", async () => {
    const fixture = await writeAuthoringFixture({ workspaceSymlink: true });
    const result = await validateProject(fixture.configPath, { skip_runtime_authority: true });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("authoring.workspace_missing");
  });

  it("rejects a non-canonical state or workspace path", async () => {
    const fixture = await writeAuthoringFixture({ customWorkspace: "custom-ws" });
    const result = await validateProject(fixture.configPath, { skip_runtime_authority: true });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "authoring.layout_unsupported")).toBe(true);
  });

  it("does not treat production.kind=authoring as a legacy passthrough field", () => {
    const parsed = projectSchema.safeParse({
      slug: "lab",
      name: "制作",
      run_id: "lab",
      manifest: "manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      production: { kind: "authoring" }
    });
    expect(parsed.success).toBe(false);
  });

  it("loads authoring metadata through loadProject", async () => {
    const fixture = await writeAuthoringFixture();
    const project = await loadProject(fixture.configPath);
    expect(project.production?.kind).toBe("authoring");
  });
});
