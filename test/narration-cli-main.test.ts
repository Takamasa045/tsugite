import { copyFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function capture(args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {}), error = vi.spyOn(console, "error").mockImplementation(() => {});
  try { const status = await main([...args, "--json"]); return { status, data: JSON.parse(String((status === 0 ? log : error).mock.calls.at(-1)?.[0])) }; }
  finally { log.mockRestore(); error.mockRestore(); }
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-narration-main-"))); roots.push(root);
  const projectRoot = join(root, "projects", "fixture"); await mkdir(projectRoot, { recursive: true });
  vi.stubEnv("TSUGITE_PROJECTS_HOME", join(root, "projects")); vi.stubEnv("ELEVENLABS_MCP_ACCESS_TOKEN", "fixture-not-used");
  await copyFile(resolve("fixtures/media/render-001.mp4"), join(projectRoot, "clip.mp4"));
  const manifest = JSON.parse(await readFile("fixtures/manifests/render-local.valid.json", "utf8")); manifest.clips[0].src = "clip.mp4"; manifest.captions = [];
  await writeFile(join(projectRoot, "manifest.json"), JSON.stringify(manifest));
  const project = { name: "fixture", slug: "fixture", manifest: "manifest.json", dist_dir: "dist", edit: { backend: "remotion" }, generation: { connection: "elevenlabs", requests: [{ id: "voice", operation: "voice", model: "eleven_v4", prompt: "Connection test.", params: { voice_id: "fixture-voice" } }] } };
  const config = join(projectRoot, "project.yaml"); await writeFile(config, JSON.stringify(project)); return { root, projectRoot, config };
}
describe("narration public main read-only entries", () => {
  it("plans unknown pricing and previews transfer locally without a quote or generation call", async () => {
    const f = await fixture(), plan = await capture(["plan", "--config", f.config]);
    expect(plan.status).toBe(0); expect(plan.data.narration_status).toMatchObject({ state: "needs_quote", can_generate: false });
    const quote = await capture(["quote", "--config", f.config]); expect(quote.data).toMatchObject({ remote_called: false, generated: false });
    expect(quote.data.transfer[0]).toMatchObject({ model: "eleven_v4", voice_id: "fixture-voice", generations_count: 1 });
  });
  it("previews missing receipts locally and blocks apply before Coordinator and Gate 1", async () => {
    const f = await fixture(), preview = await capture(["resume", "--config", f.config]);
    expect(preview.status).toBe(0); expect(preview.data.preview).toMatchObject({ network: false, new_submission_allowed: false, requests: [{ state: "not_submitted" }] });
    expect((await capture(["resume", "--config", f.config, "--apply"])).status).toBe(1);
    const blocked = await capture(["resume", "--config", f.config, "--apply", "--actor", "coordinator"]);
    expect(blocked.data.issues[0].code).toBe("run.requires_gate_1_approval");
    expect((await capture(["quote", "--config", f.config, "--approve-transfer"])).status).toBe(1);
  });
  it("never switches unsupported legacy adapters or active mode to narration resume", async () => {
    const f = await fixture(), project = JSON.parse(await readFile(f.config, "utf8")); delete project.generation;
    await writeFile(f.config, JSON.stringify(project));
    const result = await capture(["resume", "--config", f.config, "--apply", "--actor", "coordinator"]);
    expect(result.data.issues[0].code).toBe("resume.unsupported");
  });
});
