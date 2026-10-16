import { mkdtemp, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { loadAdapterDefinition } from "../src/adapters/registry.js";
import { manifestSchema } from "../src/manifest/schema.js";
import { assembleLocalMediaRun } from "../src/orchestrator/run.js";
import { createPlannedState, markGateAwaiting, recordGateDecision } from "../src/orchestrator/state.js";

describe("ElevenLabs creative narration through the orchestrator (offline transport)", () => {
  it("requires Gate 1, executes a real child adapter, pins narration, and resumes without regeneration", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-eleven-orchestrator-")));
    const audio = join(root, "fixture.mp3");
    const trace = join(root, "tool-calls.jsonl");
    const encoded = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-codec:a", "libmp3lame", "-q:a", "4", audio], { encoding: "utf8" });
    expect(encoded.status, encoded.stderr).toBe(0);
    const productionAdapter = await loadAdapterDefinition("elevenlabs-v4");
    // Only remote MCP and fetch are simulated. Orchestration, child driver,
    // request validation, async polling, MP3 pinning, manifest/QC/state are real.
    const adapter = { ...productionAdapter, command: {
      executable: process.execPath, input: "stdin-json",
      args: [resolve("test/fixtures/elevenlabs-v4-offline-runner.mjs"), audio, trace]
    } };
    const manifestPath = resolve("examples/quickstart-local/manifest.json");
    const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    const request = {
      id: "fixture-narration", operation: "voice", output_kind: "audio", audio_role: "narration",
      model: "eleven_v4", prompt: "これは音声生成の接続テストです。", params: { voice_id: "fixture-voice" }
    };
    const project = {
      slug: "eleven-orchestrator", run_id: "eleven-orchestrator-run", manifest: "manifest.json", dist_dir: "dist",
      edit: { backend: "remotion" }, generation: { adapter: "elevenlabs-v4", requests: [request] }
    };
    const options = { manifestPath, stateDir: join(root, "dist"), state: createPlannedState(project.run_id) };
    const blocked = await assembleLocalMediaRun(project, manifest, options, adapter);
    expect(blocked).toMatchObject({ ok: false, issues: [{ code: "run.invalid_state" }] });
    await expect(stat(trace)).rejects.toThrow();
    const running = recordGateDecision(markGateAwaiting(options.state, "gate_1"), "gate_1", "approved");
    const run = await assembleLocalMediaRun(project, manifest, { ...options, state: running }, adapter);
    expect(run.ok, JSON.stringify(run.issues)).toBe(true);
    expect(run.state.status).toBe("awaiting_gate_2");
    expect(run.actualCredits).toBe(16);
    expect(run.gate2AutoPassed).toBe(false);
    const output = JSON.parse(await readFile(run.manifestPath, "utf8"));
    expect(output.audio.narration).toHaveLength(1);
    expect(output.audio.narration[0].id).toBe(request.id);
    const pinned = join(root, "dist", project.run_id, output.audio.narration[0].src);
    expect(await readFile(pinned)).toEqual(await readFile(audio));
    const calls = (await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse);
    expect(calls.map((call) => call.name)).toEqual(["creative_generate_speech", "creative_get_flow_run_status"]);
    const resumed = await assembleLocalMediaRun(project, manifest, { ...options, state: run.state }, adapter);
    expect(resumed.ok, JSON.stringify(resumed.issues)).toBe(true);
    expect(resumed.alreadyAssembled).toBe(true);
    expect((await readFile(trace, "utf8")).trim().split("\n")).toHaveLength(2);
  }, 30_000);
});
