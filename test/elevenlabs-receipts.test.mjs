import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateElevenV4, resumeElevenV4, importElevenV4Result } from "../adapters/elevenlabs-v4/client.mjs";
import { loadReceiptHistory } from "../adapters/receipt-store.mjs";
import { receiptPublicState } from "../adapters/receipt-protocol.mjs";
import { claimProjectSubmission, updateProjectSubmission } from "../adapters/elevenlabs-v4/submission-index.mjs";
import { fixturePermit } from "./fixtures/elevenlabs-v4-authority.mjs";
import { creativeSpeechTool, creativeStatusTool, pending, completed } from "./fixtures/elevenlabs-v4-mcp.mjs";
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const request = { id: "narration", operation: "voice", model: "eleven_v4", prompt: "Connection test.", params: { voice_id: "fixture-voice" } };
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "tsugite-receipts-"))); roots.push(root);
  const payload = { request, run_id: "run", run_dir: root }, directory = join(root, "assets", "elevenlabs-v4");
  const client = { listTools: vi.fn(async () => ({ tools: [creativeSpeechTool, creativeStatusTool] })),
    callTool: vi.fn(async ({ name }) => ({ structuredContent: name === "creative_generate_speech" ? pending : completed(request) })) };
  const options = { client, authorizeSubmission: async () => fixturePermit(request), authorizeRecovery: async () => {},
    inspectAudio: async () => ({ duration_seconds: 1 }), sleep: async () => {},
    fetchImpl: vi.fn(async () => new Response(Buffer.from("ID3fixture"), { headers: { "content-type": "audio/mpeg" } })) };
  const submits = () => client.callTool.mock.calls.filter(([c]) => c.name === "creative_generate_speech").length;
  return { root, payload, directory, client, options, submits, receipt: () => loadReceiptHistory(directory, request) };
}
describe("durable narration receipts / same-job recovery", () => {
  it("R01 preserves accepted IDs before polling and resumes after quote expiry without new submit", async () => {
    const f = await fixture();
    await expect(generateElevenV4(f.payload, { ...f.options, onReceipt: async state => { if (state === "accepted") throw new Error("process stopped"); } })).rejects.toThrow();
    const accepted = await f.receipt(); expect(accepted.state).toBe("accepted"); expect(accepted.job).toEqual({ flow_id: pending.flow_id, session_ids: pending.session_ids });
    const out = await resumeElevenV4(f.payload, { ...f.options, now: () => Date.now() + 600_000 });
    expect(out.billing.operation.submission_count).toBe(0); expect(f.submits()).toBe(1);
    expect(f.client.callTool.mock.calls.slice(1).every(([c]) => c.name === "creative_get_flow_run_status" && c.arguments.flow_id === pending.flow_id)).toBe(true);
  });
  it("R02 unknown acceptance never re-enters generation, even from normal run", async () => {
    const f = await fixture(); f.client.callTool.mockRejectedValue(new Error("lost response"));
    await expect(generateElevenV4(f.payload, f.options)).rejects.toThrow("mcp_outcome_unknown");
    expect(receiptPublicState(await f.receipt())).toMatchObject({ submission_state: "unknown", new_submission_allowed: false });
    for (const run of [resumeElevenV4, generateElevenV4]) await expect(run(f.payload, f.options)).rejects.toThrow("receipt_unknown");
    expect(f.submits()).toBe(1); expect(f.client.callTool).toHaveBeenCalledTimes(1);
  });
  it("R03 refreshes an expired URL only through status for the identical job", async () => {
    const f = await fixture(); f.options.fetchImpl.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(generateElevenV4(f.payload, f.options)).rejects.toThrow();
    const out = await resumeElevenV4(f.payload, f.options);
    expect(out.billing.actual.credits).toBe("16"); expect(out.billing.operation.submission_count).toBe(0);
    expect(f.submits()).toBe(1); expect((await f.receipt()).budgets).toMatchObject({ refreshes_used: 1, downloads_used: 2 });
  });
  it("R04 adopts linked audio only with the durable candidate's hash and codec proof", async () => {
    const f = await fixture();
    await expect(generateElevenV4(f.payload, { ...f.options, onPinStage: async stage => { if (stage === "linked") throw new Error("process stopped"); } })).rejects.toThrow();
    expect((await f.receipt()).state).toBe("succeeded");
    const calls = f.client.callTool.mock.calls.length, downloads = f.options.fetchImpl.mock.calls.length;
    const out = await resumeElevenV4(f.payload, { ...f.options, client: undefined, environment: {} });
    expect(out.billing.operation.submission_count).toBe(0); expect((await f.receipt()).state).toBe("pinned");
    expect(f.client.callTool).toHaveBeenCalledTimes(calls); expect(f.options.fetchImpl).toHaveBeenCalledTimes(downloads);
  });
  it.each(["partial", "changed", "symlink"])("R06 preserves %s receipt evidence and fails closed", async kind => {
    const f = await fixture(); await generateElevenV4(f.payload, f.options);
    const path = join(f.directory, "narration.receipt.json"), original = await fs.readFile(path), calls = f.client.callTool.mock.calls.length;
    if (kind === "partial") await fs.writeFile(path, "{");
    else if (kind === "changed") { const r = JSON.parse(original); r.result.voice_id = "other"; await fs.writeFile(path, JSON.stringify(r)); }
    else { await fs.unlink(path); await fs.symlink(join(f.directory, "narration.mp3"), path); }
    await expect(resumeElevenV4(f.payload, f.options)).rejects.toThrow("receipt_invalid");
    expect(f.client.callTool).toHaveBeenCalledTimes(calls); expect(f.submits()).toBe(1);
  });
  it("R06 rejects altered output and never overwrites it", async () => {
    const f = await fixture(); await generateElevenV4(f.payload, f.options);
    const path = join(f.directory, "narration.mp3"); await fs.writeFile(path, "ID3tampered");
    await expect(resumeElevenV4(f.payload, f.options)).rejects.toThrow("receipt_asset_mismatch");
    expect(await fs.readFile(path, "utf8")).toBe("ID3tampered"); expect(f.submits()).toBe(1);
  });
  it("R08 blocks a different run ID in the same project until both new quote and new Gate", async () => {
    const f = await fixture(), context = { project_root: f.root, project_slug: "fixture" };
    const permit = { ...fixturePermit(request), project_context: context, project_context_digest: "a".repeat(64) };
    const index = await claimProjectSubmission(f.payload, permit);
    const other = join(f.root, "other"); await fs.mkdir(other);
    const payload = { ...f.payload, run_id: "other", run_dir: other };
    await expect(claimProjectSubmission(payload, permit)).rejects.toThrow("project_submission_unresolved");
    await updateProjectSubmission(index, { state: "pinned", gate_approval_digest: permit.gate_approval_digest, billing: { actual: { source_generation_ref: null } }, digest: "c".repeat(64) });
    await expect(claimProjectSubmission(payload, permit)).rejects.toThrow("project_authorization_used");
    await expect(claimProjectSubmission(payload, { ...permit, gate_approval_digest: "b".repeat(64) })).rejects.toThrow("project_authorization_used");
    await claimProjectSubmission(payload, { ...permit, gate_approval_digest: "b".repeat(64), quote: { ...permit.quote, quote_id: "d".repeat(64) } });
    expect((await fs.readdir(index.directory)).some(n => n.endsWith("history.json"))).toBe(true);
  });
  it("R09 persists download attempts across repeated process-equivalent invocations", async () => {
    const f = await fixture(); f.options.fetchImpl.mockImplementation(async () => new Response(null, { status: 403 }));
    await expect(generateElevenV4(f.payload, f.options)).rejects.toThrow();
    for (let i = 0; i < 2; i++) await expect(resumeElevenV4(f.payload, f.options)).rejects.toThrow();
    const calls = f.client.callTool.mock.calls.length;
    await expect(resumeElevenV4(f.payload, f.options)).rejects.toThrow("receipt_download_budget_exhausted");
    expect(f.options.fetchImpl).toHaveBeenCalledTimes(3); expect(f.client.callTool).toHaveBeenCalledTimes(calls); expect(f.submits()).toBe(1);
  });
  it("R10 retains old markers as unknown without synthesizing missing identities", async () => {
    const f = await fixture(); await fs.mkdir(f.directory, { recursive: true });
    const path = join(f.directory, "narration.submission.jsonl"), old = '{"phase":"submitting"}\n'; await fs.writeFile(path, old);
    await expect(resumeElevenV4(f.payload, f.options)).rejects.toThrow("receipt_legacy_unknown");
    expect(await fs.readFile(path, "utf8")).toBe(old); expect(f.submits()).toBe(0);
  });
  it("R11 refuses adoption after the original approval changes", async () => {
    const f = await fixture(); await generateElevenV4(f.payload, f.options);
    await fs.writeFile(join(f.root, "state.json"), JSON.stringify({ run_id: "run", gates: { gate_1: { status: "approved", approved_input_digest: "b".repeat(64), billing_approval_digest: "d".repeat(64) } } }));
    await expect(resumeElevenV4(f.payload, { ...f.options, authorizeRecovery: undefined })).rejects.toThrow("receipt_approval_mismatch");
    expect(f.submits()).toBe(1);
  });
  it("R11 audits a same-request accepted result to the original receipt without adopting a new approval", async () => {
    const f = await fixture();
    await expect(generateElevenV4(f.payload, { ...f.options, onReceipt: async state => { if (state === "accepted") throw new Error("stop"); } })).rejects.toThrow();
    const statePath = join(f.root, "state.json"), changedState = JSON.stringify({ run_id: "run", gates: { gate_1: { status: "approved", approved_input_digest: "b".repeat(64) } } });
    await fs.writeFile(statePath, changedState);
    const output = await resumeElevenV4({ ...f.payload, audit_original: true }, { ...f.options, authorizeRecovery: undefined });
    expect(output.metadata).toMatchObject({ audit_original_approval: true, origin_approval_digest: "a".repeat(64) });
    expect((await f.receipt()).gate_approval_digest).toBe("a".repeat(64)); expect(await fs.readFile(statePath, "utf8")).toBe(changedState);
    expect(output.billing.operation.submission_count).toBe(0); expect(f.submits()).toBe(1);
    await expect(resumeElevenV4(f.payload, { ...f.options, authorizeRecovery: undefined })).rejects.toThrow("receipt_approval_mismatch");
  });
  it("imports and reuses historical generation with zero submissions and no MCP calls", async () => {
    const f = await fixture(), payload = { ...f.payload, result: { structuredContent: completed(request) } };
    const imported = await importElevenV4Result(payload, f.options), reused = await importElevenV4Result(payload, f.options);
    expect(imported.billing.operation.submission_count).toBe(0); expect(reused.billing.operation.submission_count).toBe(0);
    expect(imported.billing.actual.source_generation_ref).toBe(reused.billing.actual.source_generation_ref);
    expect(f.client.callTool).not.toHaveBeenCalled(); expect(f.options.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("explicit resume of an unsubmitted request cannot start a job", async () => {
    const f = await fixture(); await expect(resumeElevenV4(f.payload, f.options)).rejects.toThrow("resume_no_submission");
    expect(f.client.listTools).not.toHaveBeenCalled(); expect(f.submits()).toBe(0);
  });
});
