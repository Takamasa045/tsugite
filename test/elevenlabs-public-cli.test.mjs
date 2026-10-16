import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, realpath, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { billingDigest } from "../adapters/billing-contract.mjs";
import { afterEach, describe, expect, it } from "vitest";

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function execute(command, args, env) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => stdout += b); child.stderr.on("data", (b) => stderr += b);
    child.on("error", reject); child.on("close", (status, signal) => done({ status, signal, stdout, stderr }));
  });
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-public-cli-"))); roots.push(root);
  await writeFile(join(root, "owned-fixture"), "public-cli fixture\n");
  const projectRoot = join(root, "projects", "voice-test"); await mkdir(projectRoot, { recursive: true });
  await copyFile(resolve("fixtures/media/render-001.mp4"), join(projectRoot, "clip.mp4"));
  const encoded = await execute("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-codec:a", "libmp3lame", "-q:a", "4", join(root, "voice.mp3")], process.env);
  expect(encoded.status, encoded.stderr).toBe(0);
  const manifest = JSON.parse(await readFile("fixtures/manifests/render-local.valid.json", "utf8"));
  manifest.clips[0].src = "clip.mp4"; manifest.captions = [];
  await writeFile(join(projectRoot, "manifest.json"), JSON.stringify(manifest));
  const project = { name: "CLI voice fixture", slug: "voice-test", run_id: "voice-run", manifest: "manifest.json", dist_dir: "dist", edit: { backend: "remotion" },
    generation: { connection: "elevenlabs", requests: [{ id: "narration", operation: "voice", output_kind: "audio", audio_role: "narration", model: "eleven_v4", prompt: "これは接続テストです。", params: { voice_id: "fixture-voice" } }] } };
  const config = join(projectRoot, "project.yaml"); await writeFile(config, JSON.stringify(project));
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, NODE_ENV: "test", NODE_OPTIONS: `--import=${resolve("test/fixtures/elevenlabs-public-cli-boundary.mjs")}`,
    TSUGITE_CLI_FIXTURE_ROOT: root, TSUGITE_PROJECTS_HOME: join(root, "projects"), ELEVENLABS_MCP_ACCESS_TOKEN: "fixture-nonsecret", TSUGITE_ELEVENLABS_GRANT_EPOCH: "fixture-grant" };
  const cli = (command, ...args) => {
    const argv = ["bin/pipeline", command, "--config", config, "--json", ...args];
    // macOS denies external networking for the whole tree, including Chromium.
    // Loopback is required by Remotion's local asset server.
    return process.platform === "darwin"
      ? execute("/usr/bin/sandbox-exec", ["-p", '(version 1) (allow default) (deny network*) (allow network-inbound (local ip "localhost:*")) (allow network-outbound (remote ip "localhost:*"))', process.execPath, ...argv], env)
      : execute(process.execPath, argv, env);
  };
  const good = async (command, ...args) => { const r = await cli(command, ...args); expect(r.status, r.stderr || r.stdout).toBe(0); return JSON.parse(r.stdout); };
  const gate = (id, decision) => good("gate", "--gate", id, "--decision", decision, "--actor", "coordinator");
  const calls = async () => { try { return (await readFile(join(root, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse); } catch (e) { if (e.code === "ENOENT") return []; throw e; } };
  const quote = () => good("quote", "--approve-transfer", "--actor", "coordinator");
  return { root, projectRoot, project, config, cli, good, gate, quote, calls, environment: env, run: join(projectRoot, "dist", "voice-run"), save: () => writeFile(config, JSON.stringify(project)) };
}
const hash = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

describe("public CLI narration Gate chain (offline transport, no Keychain)", () => {
  it("G01–G07: reviews, approves, submits once, resumes and renders through the public CLI", async () => {
    const f = await fixture();
    await f.good("validate");
    expect((await f.good("plan")).plan.billing.estimate).toMatchObject({ status: "unknown", credits: null, money: null });
    await f.good("models"); await f.good("quote");
    expect((await f.cli("gate", "--gate", "gate-1", "--decision", "approve", "--actor", "coordinator")).status).toBe(1);
    await f.good("review");
    const review = await readFile(join(f.run, "review/review-data.json"), "utf8"); expect(review).toContain("voice-test");
    expect(await readFile(join(f.run, "review/index.html"), "utf8")).toContain("生成料金: 未確認");
    const stateHash = () => hash(join(f.run, "state.json")).catch((e) => { if (e.code === "ENOENT") return null; throw e; });
    const before = await stateHash(); await f.good("run", "--dry-run"); expect(await stateHash()).toBe(before);
    expect(await f.calls()).toHaveLength(0);
    expect((await f.cli("run", "--actor", "coordinator")).status).toBe(1);
    expect((await f.cli("gate", "--gate", "gate-1", "--decision", "approve", "--actor", "coordinator")).status).toBe(1);
    await f.quote(); await f.good("review");
    await f.gate("gate-1", "approve");
    expect((await f.cli("run")).status).toBe(1);
    const run = await f.good("run", "--actor", "coordinator"); expect(run.state.status).toBe("awaiting_gate_2");
    expect(run.billing.actual).toMatchObject({ status: "measured", credits: "16" });
    const manifest = JSON.parse(await readFile(join(f.run, "manifest.json"), "utf8"));
    expect(manifest.audio.narration).toHaveLength(1); expect(manifest.clips).toHaveLength(1);
    expect(await hash(join(f.run, manifest.clips[0].src))).toBe(await hash(join(f.projectRoot, "clip.mp4")));
    const assembled = await hash(join(f.run, "manifest.json")); const calls = await f.calls();
    expect(calls.filter((v) => v.name === "creative_generate_speech" && v.arguments.estimate_only === false)).toHaveLength(1);
    expect((await f.good("run", "--actor", "coordinator")).already_assembled).toBe(true);
    expect(await hash(join(f.run, "manifest.json"))).toBe(assembled); expect(await f.calls()).toEqual(calls);
    expect((await f.cli("render", "--actor", "coordinator")).status).toBe(1);
    await f.gate("gate-2", "approve_all");
    const rendered = await f.good("render", "--actor", "coordinator"); expect(rendered.state.status).toBe("awaiting_gate_3");
    const videoHash = await hash(join(f.run, "final.mp4"));
    const completed = await f.gate("gate-3", "approve"); expect(completed.state.status).toBe("completed");
    expect(await hash(join(f.run, "final.mp4"))).toBe(videoHash); expect(await f.calls()).toEqual(calls);
    expect(calls.filter((v) => v.denied)).toHaveLength(0);
  }, 120_000);

  it("G02/G04/G08: rejects damaged review and changed request inputs without submission", async () => {
    const f = await fixture(); await f.quote(); await f.good("review");
    const path = join(f.run, "review/review-data.json"), original = await readFile(path);
    await writeFile(path, "{}"); expect((await f.cli("gate", "--gate", "gate-1", "--decision", "approve", "--actor", "coordinator")).status).toBe(1);
    const foreign = JSON.parse(original); foreign.slug = "another-project";
    await writeFile(path, JSON.stringify(foreign)); expect((await f.cli("gate", "--gate", "gate-1", "--decision", "approve", "--actor", "coordinator")).status).toBe(1);
    await writeFile(path, original); await f.gate("gate-1", "approve");
    for (const field of ["prompt", "model", "voice"]) {
      const request = f.project.generation.requests[0], previous = structuredClone(request);
      if (field === "voice") request.params.voice_id = "changed-voice"; else request[field] += "-changed";
      await f.save(); expect((await f.cli("run", "--actor", "coordinator")).status).toBe(1);
      f.project.generation.requests[0] = previous; await f.save();
    }
    expect((await f.calls()).filter((v) => v.name === "creative_generate_speech" && v.arguments.estimate_only === false)).toHaveLength(0);
  }, 60_000);

  it("G06/G08: serializes double execution and rejects changed QC and pinned media", async () => {
    const f = await fixture(); await f.quote(); await f.good("review"); await f.gate("gate-1", "approve");
    const results = await Promise.all([f.cli("run", "--actor", "coordinator"), f.cli("run", "--actor", "coordinator")]);
    expect(results.filter((r) => r.status === 0)).toHaveLength(1);
    expect(results.find((r) => r.status !== 0).stderr).toContain("locked");
    expect((await f.calls()).filter((v) => v.name === "creative_generate_speech" && v.arguments.estimate_only === false)).toHaveLength(1);
    const manifest = JSON.parse(await readFile(join(f.run, "manifest.json"), "utf8"));
    const pinned = join(f.run, manifest.audio.narration[0].src), bytes = await readFile(pinned);
    await writeFile(pinned, "damaged MP3");
    expect((await f.cli("gate", "--gate", "gate-2", "--decision", "approve_all", "--actor", "coordinator")).status).toBe(1);
    await writeFile(pinned, bytes); await f.gate("gate-2", "approve_all");
    await writeFile(pinned, "changed after approval");
    expect((await f.cli("render", "--actor", "coordinator")).status).toBe(1);
    expect((await f.calls()).filter((v) => v.name === "creative_generate_speech" && v.arguments.estimate_only === false)).toHaveLength(1);
  }, 60_000);

  it("G04: changed grant/profile or price cannot consume the old Gate approval", async () => {
    const f = await fixture(); await f.quote(); await f.good("review"); await f.gate("gate-1", "approve");
    for (const name of ["TSUGITE_ELEVENLABS_GRANT_EPOCH", "TSUGITE_ELEVENLABS_PROFILE_ID"]) {
      const previous = f.environment[name]; f.environment[name] = "changed";
      const run = await f.cli("run", "--actor", "coordinator"); expect(run.status).toBe(1); expect(run.stderr).toContain("billing_connection_changed");
      if (previous === undefined) delete f.environment[name]; else f.environment[name] = previous;
    }
    const path = join(f.run, "billing-quotes.json"), cache = JSON.parse(await readFile(path, "utf8"));
    const q = cache.entries[0].quote; q.limits.max_credits = "20";
    const { quote_id, ...body } = q; q.quote_id = billingDigest(body); await writeFile(path, JSON.stringify(cache));
    expect((await f.cli("run", "--actor", "coordinator")).status).toBe(1);
    expect((await f.calls()).filter((v) => v.name === "creative_generate_speech" && v.arguments.estimate_only === false)).toHaveLength(0);
  }, 60_000);
  it("G09/R01/R05: previews locally and resumes the same accepted job through the public CLI", async () => {
    const f = await fixture(); await f.quote(); await f.good("review"); await f.gate("gate-1", "approve");
    const runningState = await readFile(join(f.run, "state.json"));
    f.environment.TSUGITE_FIXTURE_STATUS_FAILURE = "once";
    const stopped = await f.cli("run", "--actor", "coordinator"); expect(stopped.status).toBe(1);
    const before = await f.calls();
    expect(before.filter(v => v.name === "creative_generate_speech" && !v.arguments.estimate_only)).toHaveLength(1);
    const preview = await f.good("resume"); expect(preview.preview.requests[0].state).toBe("accepted");
    expect(await f.calls()).toEqual(before);
    expect((await f.cli("resume", "--apply")).status).toBe(1);
    const changed = JSON.parse(runningState); changed.gates.gate_1.approved_input_digest = 'b'.repeat(64);
    await writeFile(join(f.run, "state.json"), JSON.stringify(changed));
    const changedHash = await hash(join(f.run, "state.json"));
    const audited = await f.good("resume", "--apply", "--audit-original", "--actor", "coordinator");
    expect(audited).toMatchObject({ audit_only: true, adopted_into_current_revision: false, generated: false });
    expect(await hash(join(f.run, "state.json"))).toBe(changedHash);
    expect((await f.cli("resume", "--apply", "--actor", "coordinator")).status).toBe(1);
    await writeFile(join(f.run, "state.json"), runningState);
    const resumed = await f.good("resume", "--apply", "--actor", "coordinator");
    expect(resumed.state.status).toBe("awaiting_gate_2");
    expect(resumed.billing.operation.submission_count).toBe(0);
    expect(resumed.billing.actual.credits).toBe("16");
    const manifest = JSON.parse(await readFile(join(f.run, "manifest.json"))), mediaHash = await hash(join(f.run, manifest.audio.narration[0].src));
    const calls = await f.calls();
    expect(calls.filter(v => v.name === "creative_generate_speech" && !v.arguments.estimate_only)).toHaveLength(1);
    expect(calls.filter(v => v.name === "creative_get_flow_run_status").every(v => v.arguments.flow_id === "fixture-flow" && v.arguments.session_ids[0] === "fixture-session")).toBe(true);
    // Model a crash after media/receipt pin but before manifest/QC/state publication.
    await writeFile(join(f.run, "state.json"), runningState);
    await unlink(join(f.run, "manifest.json")); await unlink(join(f.run, "gate2-qc.json"));
    const rebuilt = await f.good("resume", "--apply", "--actor", "coordinator");
    expect(rebuilt.billing.operation.submission_count).toBe(0);
    expect(await hash(join(f.run, manifest.audio.narration[0].src))).toBe(mediaHash);
    expect(await f.calls()).toEqual(calls);
    await f.gate("gate-2", "approve_all");
  }, 60_000);

  it.each(["unsubmitted", "accepted", "unknown"])("R07: reuses the first request when the second is %s", async condition => {
    const f = await fixture(), second = { ...structuredClone(f.project.generation.requests[0]), id: "narration-2", prompt: "Second connection test." };
    f.project.generation.requests.push(second); await f.save();
    await f.quote(); await f.good("review"); await f.gate("gate-1", "approve");
    f.environment.TSUGITE_FIXTURE_SECOND_FAILURE = condition;
    expect((await f.cli("run", "--actor", "coordinator")).status).toBe(1);
    const firstPath = join(f.run, "assets/elevenlabs-v4/narration.mp3"), firstHash = await hash(firstPath);
    const before = await f.calls(), submissionCount = before.filter(v => v.name === "creative_generate_speech" && !v.arguments.estimate_only).length;
    if (condition === "unsubmitted") {
      const recovered = await f.good("resume", "--apply", "--actor", "coordinator");
      expect(recovered).toMatchObject({ partial_recovery: true, remaining_requests: ["narration-2"], generated: false });
      expect(recovered.billing.operation.submission_count).toBe(0);
    }
    const retried = await f.cli("run", "--actor", "coordinator");
    expect(retried.status).toBe(condition === "unknown" ? 1 : 0);
    expect(await hash(firstPath)).toBe(firstHash);
    const after = await f.calls(), submissions = after.filter(v => v.name === "creative_generate_speech" && !v.arguments.estimate_only);
    expect(submissions).toHaveLength(condition === "unsubmitted" ? submissionCount + 1 : submissionCount);
    expect(submissions.filter(v => v.arguments.prompt === f.project.generation.requests[0].prompt)).toHaveLength(1);
    if (condition !== "unknown") expect(JSON.parse(retried.stdout).state.status).toBe("awaiting_gate_2");
  }, 60_000);

});
