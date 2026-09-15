import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { createAuthoringEngineRun, digestAuthoringRun } from "../src/productionControl/authoringEngine.js";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function capture(args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const status = await main(args);
  const stdout = log.mock.calls.map((call) => String(call[0])).join("\n");
  const stderr = error.mock.calls.map((call) => String(call[0])).join("\n");
  log.mockRestore();
  error.mockRestore();
  return { status, stdout, stderr };
}

async function writeAuthoringProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tsugite-authoring-cli-"));
  const workspace = join(root, "hypit-workspace");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(root, ".tsugite", "authoring"), { recursive: true });
  const source = "source\n";
  await writeFile(join(workspace, "main.svml"), source);
  const { digest: _digest, ...runBase } = createAuthoringEngineRun({
    production_id: "authoring-cli",
    adapter_id: "authoring-adapter",
    brief_digest: sha256("brief"),
    import_allowlist_digest: sha256("allow")
  });
  const run = digestAuthoringRun({
    ...runBase,
    source_files: [{ relative_path: "main.svml", sha256: sha256(source), bytes: Buffer.byteLength(source) }]
  });
  await writeFile(
    join(root, ".tsugite", "authoring", "state.json"),
    `${JSON.stringify({ workspace, run }, null, 2)}\n`
  );
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    meta: { aspect: "9:16", fps: 30, target_duration_seconds: 30, slug: "authoring-cli" },
    clips: [],
    audio: { bgm: [], narration: [], sfx: [] }
  }));
  const configPath = join(root, "project.yaml");
  await writeFile(configPath, [
    "slug: authoring-cli",
    "name: CLI検証",
    "run_id: authoring-cli",
    "production:",
    "  kind: authoring",
    "  adapter: hypit",
    "  state: .tsugite/authoring/state.json",
    "  workspace: hypit-workspace",
    "manifest: manifest.json",
    "dist_dir: dist",
    "edit:",
    "  backend: remotion"
  ].join("\n"));
  return configPath;
}

describe("authoring CLI", () => {
  it("validates an authoring production and refuses remotion run/render", async () => {
    const home = await mkdtemp(join(tmpdir(), "tsugite-authoring-home-"));
    const previousHome = process.env.TSUGITE_PROJECTS_HOME;
    process.env.TSUGITE_PROJECTS_HOME = home;
    try {
      const config = await writeAuthoringProject();
      const validated = await capture(["validate", "--config", config, "--json"]);
      expect(validated.status).toBe(0);
      const payload = JSON.parse(validated.stdout) as { ok: boolean; launcher_visible?: boolean };
      expect(payload.ok).toBe(true);
      expect(payload.launcher_visible).toBe(true);

      const plan = await capture(["plan", "--config", config, "--json"]);
      expect(plan.status).toBe(1);
      expect(JSON.parse(plan.stderr).issues[0]?.code).toBe("authoring.legacy_pipeline_unsupported");
      for (const command of ["run", "render"]) {
        const refused = await capture([command, "--config", config, "--json", "--actor", "coordinator"]);
        expect(refused.status).toBe(1);
        const issue = JSON.parse(refused.stderr) as { issues: Array<{ code: string }> };
        expect(issue.issues[0]?.code).toBe("authoring.legacy_pipeline_unsupported");
      }
    } finally {
      if (previousHome === undefined) delete process.env.TSUGITE_PROJECTS_HOME;
      else process.env.TSUGITE_PROJECTS_HOME = previousHome;
    }
  });
});
