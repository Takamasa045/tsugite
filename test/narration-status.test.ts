import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readNarrationStatus, loadProjectGenerationAdapter } from "../src/adapters/narrationStatus.js";
import { inspectGenerationReceipts } from "../src/adapters/receipts.js";
import { loadAdapterDefinition } from "../src/adapters/registry.js";
import { projectSchema } from "../src/project/schema.js";
import { writeBillingQuotes, billingApprovalDigest, loadGenerationBilling, readBillingQuotes, quoteGeneration } from "../src/adapters/billing.js";
import { sealReceipt } from "../adapters/receipt-protocol.mjs";
import { initialGeneratedReceipt } from "../adapters/elevenlabs-v4/receipts.mjs";
import { fixturePermit } from "./fixtures/elevenlabs-v4-authority.mjs";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const request = { id: "narration", operation: "voice" as const, output_kind: "audio" as const, audio_role: "narration" as const, model: "eleven_v4", prompt: "Connection test.", params: { voice_id: "fixture-voice" } };
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-status-"))); roots.push(root);
  const project = projectSchema.parse({ name: "fixture", slug: "fixture", manifest: "manifest.json", dist_dir: "dist", edit: { backend: "remotion" }, generation: { adapter: "elevenlabs-v4", requests: [request] } });
  const run = join(root, "dist", "fixture"), directory = join(run, "assets/elevenlabs-v4"), config = join(root, "project.yaml");
  await mkdir(directory, { recursive: true }); const adapter = await loadAdapterDefinition("elevenlabs-v4");
  const permit = fixturePermit(request), payload = { request, run_id: "fixture", run_dir: run };
  const status = () => readNarrationStatus(config, project, adapter, run);
  const receipt = async (changes: Record<string, unknown>) => {
    const r = sealReceipt({ ...initialGeneratedReceipt(payload, permit, { kind: "creative" }), ...changes });
    await writeFile(join(directory, "narration.submission.jsonl"), JSON.stringify({ schema_version: 2, receipt: r }) + "\n");
    await writeFile(join(directory, "narration.receipt.json"), JSON.stringify(r)); return r;
  };
  const approve = async () => { await writeFile(join(run, "state.json"), JSON.stringify({ run_id: "fixture", status: "running", gates: { gate_1: { status: "approved", decision_source: "human", approved_input_digest: permit.gate_approval_digest, billing_approval_digest: billingApprovalDigest(await loadGenerationBilling(config, project, adapter)) } } })); };
  return { root, project, run, directory, config, adapter, permit, status, receipt, approve };
}
describe("shared narration read model / local only", () => {
  it("shows unknown pricing and never assumes a zero bill or implicit quote", async () => {
    const f = await fixture(); expect(await f.status()).toMatchObject({ state: "needs_quote", can_generate: false, billing_label: "生成料金: 未確認" });
    expect(await loadProjectGenerationAdapter(f.project)).toMatchObject({ name: "elevenlabs-v4" });
  });
  it("reads valid quotes and requires human approval before enabling generation", async () => {
    const f = await fixture(); await writeBillingQuotes(f.run, [{ request_id: request.id, quote: f.permit.quote }], { schema_version: 1, kind: "tsugite.billing-context", project_root: f.root, project_slug: f.project.slug });
    expect(await f.status()).toMatchObject({ state: "needs_approval", can_generate: false });
    await f.approve(); expect(await f.status()).toMatchObject({ state: "ready", can_generate: true });
    expect(billingApprovalDigest(await loadGenerationBilling(f.config, f.project, f.adapter))).toMatch(/^[a-f0-9]{64}$/);
    expect(await readBillingQuotes(f.run, [request])).toHaveLength(1);
    await expect(readBillingQuotes(f.run, [])).rejects.toThrow("billing_quote_mismatch");
  });
  it("reads accepted receipt from disk on every refresh without sending a job", async () => {
    const f = await fixture(); await f.approve();
    await f.receipt({ state: "accepted", job: { flow_id: "flow", session_ids: ["session"] } });
    expect(await f.status()).toMatchObject({ state: "retrieve", can_resume: true, can_generate: false, submission_increment: 0 });
    expect(await f.status()).toMatchObject({ next_action: { id: "resume" } });
  });
  it.each(["submitting", "failed"])("offers only inspection for %s", async state => {
    const f = await fixture(); await f.receipt({ state });
    expect(await f.status()).toMatchObject({ state: "inspect", can_generate: false, next_action: { id: "inspect_record" } });
  });
  it("offers inspection after the durable poll budget is exhausted", async () => {
    const f = await fixture(); await f.approve(); await f.receipt({ state: "accepted", job: { flow_id: "flow", session_ids: ["session"] }, budgets: { polls_used: 30, wait_ms_used: 30000, refreshes_used: 0, downloads_used: 0 } });
    expect(await f.status()).toMatchObject({ state: "inspect", can_resume: false });
  });
  it("shows saved audio and distinguishes codec QA from human listening", async () => {
    const f = await fixture(); await f.approve(); await f.receipt({ state: "pinned", job: { flow_id: "flow", session_ids: ["session"] }, result: { generation_id: "generation", model: request.model, voice_id: request.params.voice_id },
      asset: { relative_path: "narration.mp3", temporary_name: ".narration.00000000-0000-0000-0000-000000000000.tmp", sha256: "a".repeat(64), byte_size: 10, duration_seconds: 1 } });
    expect(await f.status()).toMatchObject({ state: "pinned", can_generate: false, next_action: { id: "resume" } });
  });
  it.each(["partial", "symlink"])("treats %s local records as unknown without mutation", async mode => {
    const f = await fixture(), path = join(f.directory, "narration.submission.jsonl");
    if (mode === "partial") await writeFile(path, "{"); else await symlink(f.config, path);
    expect(await f.status()).toMatchObject({ state: "inspect", can_generate: false });
    if (mode === "partial") expect(await readFile(path, "utf8")).toBe("{");
  });
  it("supports adapters without receipts and an absent output directory", async () => {
    const f = await fixture(); expect(await inspectGenerationReceipts(undefined, [request], f.run)).toMatchObject({ supported: false, requests: [] });
    expect(await readNarrationStatus(f.config, f.project, undefined, f.run)).toBeUndefined();
    await rm(join(f.run, "assets"), { recursive: true });
    expect((await inspectGenerationReceipts(f.adapter, [request], f.run)).requests[0].state).toBe("not_submitted");
  });
  it("handles an explicit quote command's successful result and invalid output without live transport", async () => {
    const f = await fixture(), cmd = { executable: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(JSON.stringify(f.permit.quote))})`], input: "stdin-json" as const };
    expect(await quoteGeneration(f.project, { ...f.adapter, quote: cmd }, f.run, f.config)).toMatchObject({ ok: true, billing: { estimate: { status: "known" } } });
    expect(await loadGenerationBilling(f.config, f.project, f.adapter)).toMatchObject({ estimate: { context_digest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(await quoteGeneration(f.project, { ...f.adapter, quote: { ...cmd, args: ["-e", "console.log('{}')"] } }, f.run, f.config)).toMatchObject({ ok: false, issues: [{ code: "billing.quote_invalid" }] });
    expect(await quoteGeneration(f.project, undefined, f.run, f.config)).toMatchObject({ ok: false });
  });
});
