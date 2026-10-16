import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { adapterErrorEnvelope, parseAdapterErrorEnvelope, describeAdapterError } from "../adapters/error-envelope.mjs";
import { runCliGenerationAdapter } from "../src/adapters/cliGeneration.js";
import { loadAdapterDefinition } from "../src/adapters/registry.js";
import { generateElevenV4 as generateWithRealBilling } from "../adapters/elevenlabs-v4/client.mjs";
import { creativeSpeechTool, creativeStatusTool, pending, completed } from "./fixtures/elevenlabs-v4-mcp.mjs";
import { fixturePermit } from "./fixtures/elevenlabs-v4-authority.mjs";
const generateElevenV4 = (payload, options = {}) => generateWithRealBilling(payload, { authorizeSubmission: async () => fixturePermit(payload.request), ...options });
const roots = [];
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
const secret = "fixture-private-token AUTHCODE https://storage.example/content?signature=secret /Users/private/work";
const request = { id: "voice", operation: "voice", output_kind: "audio", audio_role: "narration", model: "eleven_v4", prompt: "テストです。", params: { voice_id: "fixture-voice" } };
async function runChild(stderr, ending = "process.exit(20)") {
  const root = await mkdtemp(join(tmpdir(), "tsugite-error-test-")); roots.push(root);
  const adapter = await loadAdapterDefinition("elevenlabs-v4"), trace = join(root, "attempts");
  adapter.command = { executable: process.execPath, args: ["--input-type=module", "--eval", `import{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(trace)},${JSON.stringify("attempt\n")});process.stderr.write(${JSON.stringify(stderr)});${ending};`], input: "stdin-json" };
  adapter.retry = { max_attempts: 2, retryable_exit_codes: [1, 20] };
  return { result: runCliGenerationAdapter(adapter, [request], { runId: "run", runDir: root }), trace };
}
describe("bounded adapter failure protocol", () => {
  it.each(["credential_missing", "oauth_refresh_failed", "mcp_generation_pending", "mcp_outcome_unknown", "mcp_audio_download_failed", "submission_not_durable", "submission_already_exists_or_unwritable"])("explains %s without granting a retry", async (code) => {
    const envelope = adapterErrorEnvelope(code, request.id);
    const { result, trace } = await runChild(JSON.stringify(envelope));
    expect(result.ok).toBe(false); expect(result.issues[0].adapter_error).toEqual(envelope);
    expect(result.issues[0].message).toBe(describeAdapterError(code));
    expect((await readFile(trace, "utf8")).trim().split("\n")).toHaveLength(1);
  });
  it.each([secret, "{", JSON.stringify({ ...adapterErrorEnvelope("credential_missing", "voice"), safe_context: secret }), JSON.stringify({ ...adapterErrorEnvelope("credential_missing", "voice"), code: secret }), "x".repeat(4097)])("rejects malformed/unknown/oversized or extra context without reflecting raw stderr", async (value) => {
    expect(parseAdapterErrorEnvelope(value, "voice")).toBeUndefined();
    const { result } = await runChild(value);
    expect(result.issues[0].adapter_error).toBeUndefined(); expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("does not accept an envelope for a different request or a forged state", () => {
    expect(parseAdapterErrorEnvelope(JSON.stringify(adapterErrorEnvelope("credential_missing", "other")), "voice")).toBeUndefined();
    expect(parseAdapterErrorEnvelope(JSON.stringify({ ...adapterErrorEnvelope("mcp_outcome_unknown", "voice"), submission_state: "not_submitted" }), "voice")).toBeUndefined();
  });
  it("classifies a signalled child as unknown and never repeats it", async () => {
    const { result, trace } = await runChild(secret, "process.kill(process.pid,'SIGTERM')");
    expect(result.issues[0].adapter_error.submission_state).toBe("unknown");
    expect((await readFile(trace, "utf8")).trim().split("\n")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("does not echo truncated success JSON or retry after losing the result", async () => {
    const { result, trace } = await runChild("", `process.stdout.write(${JSON.stringify(secret)});process.exit(0)`);
    expect(result.issues[0].adapter_error.submission_state).toBe("unknown");
    expect(result.issues[0].code).toBe("run.adapter_output_json");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect((await readFile(trace, "utf8")).trim().split("\n")).toHaveLength(1);
  });
  it("emits the same safe envelope from the real generation entry before authentication", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-entry-error-")); roots.push(root);
    const r = spawnSync(process.execPath, [resolve("adapters/elevenlabs-v4/generate.mjs")], {
      input: JSON.stringify({ request, run_dir: root }), encoding: "utf8", env: { PATH: process.env.PATH, NODE_ENV: "test" }
    });
    expect(r.status).toBe(30); expect(r.stdout).toBe("");
    expect(parseAdapterErrorEnvelope(r.stderr, "voice")).toEqual(adapterErrorEnvelope("credential_missing", "voice"));
  });
  it.each(["poll", "download"])("preserves accepted state when %s fails after submit", async (phase) => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-phase-error-")); roots.push(root);
    let submits = 0;
    const client = {
      listTools: async () => ({ tools: [creativeSpeechTool, creativeStatusTool] }),
      callTool: async ({ name }) => {
        if (name === "creative_generate_speech") { submits++; return { structuredContent: phase === "poll" ? pending : completed(request) }; }
        throw new Error(secret);
      }
    };
    let error;
    try { await generateElevenV4({ request, run_dir: root }, { client, sleep: async () => {},
      fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(secret)); } }), { headers: { "content-type": "audio/mpeg" } }) }); }
    catch (e) { error = e; }
    expect(error.code).toBe(phase === "poll" ? "mcp_status_failed" : "mcp_audio_download_failed");
    expect(adapterErrorEnvelope(error.code).submission_state).toBe("accepted"); expect(submits).toBe(1);
    expect(error.message).not.toContain(secret);
  });
});
