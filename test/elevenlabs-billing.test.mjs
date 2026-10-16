import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actualNarrationBilling, assertNarrationQuote, billingDigest, billingLabel, combineActualBilling, decimalUnits, isBillingEvidence, makeNarrationQuote, quoteBilling, unknownBilling } from "../adapters/billing-contract.mjs";
import { authorizeRunSubmission } from "../adapters/billing-store.mjs";
import { elevenCredentialBinding } from "../adapters/elevenlabs-v4/oauth.mjs";
import { generateElevenV4, quoteElevenV4 } from "../adapters/elevenlabs-v4/client.mjs";
import { creativeSpeechTool, creativeStatusTool, completed } from "./fixtures/elevenlabs-v4-mcp.mjs";
import { loadProject } from "../src/project/loadProject.js";
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const request = { id: "voice", operation: "voice", model: "eleven_v4", prompt: "接続テストです。", params: { voice_id: "fixture-voice" } };
const environment = { ELEVENLABS_MCP_ACCESS_TOKEN: "fixture-nonsecret", TSUGITE_ELEVENLABS_GRANT_EPOCH: "fixture-epoch" };
const binding = await elevenCredentialBinding({ environment });
const estimate = { credits: 17, price_cents: 0.1234, currency: "usd", generations_count: 1 };
const now = Date.parse("2026-10-16T00:00:00.000Z");
const quote = () => makeNarrationQuote(request, binding, estimate, now);
async function fixtureContext(root) {
  const context = { schema_version: 1, kind: "tsugite.billing-context", project_root: root, project_slug: "fixture" };
  await writeFile(join(root, "billing-context.json"), JSON.stringify(context));
  return billingDigest(context);
}
const resign = (q) => { const { quote_id, ...body } = q; return { ...body, quote_id: billingDigest(body) }; };
describe("narration billing evidence and quote binding", () => {
  it("does not accept runtime billing evidence from project YAML", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-billing-yaml-")); roots.push(root);
    const path = join(root, "project.yaml");
    await writeFile(path, JSON.stringify({ name: "fixture", slug: "fixture", manifest: "manifest.json", edit: { backend: "remotion" }, billing: quoteBilling([quote()]) }));
    await expect(loadProject(path)).rejects.toMatchObject({ issues: [{ code: "project.billing_runtime_only" }] });
  });
  it("distinguishes unknown, unmeasured, measured zero and a nonzero estimate", () => {
    const unknown = unknownBilling(), unmeasured = actualNarrationBilling(undefined, null, 0), zero = actualNarrationBilling({ credits: 0, price_cents: 0, cost_fiat_currency: "usd" }, "generation", 1), known = quoteBilling([quote()]);
    expect(unknown.estimate.credits).toBeNull(); expect(unmeasured.actual.credits).toBeNull();
    expect(zero.actual).toMatchObject({ status: "measured", credits: "0", money: { amount: "0" } });
    expect(known.estimate).toMatchObject({ status: "known", credits: "17", money: { amount: "0.001234", currency: "USD" } });
    expect(billingLabel(unknown)).toContain("未確認"); expect(billingLabel(unmeasured, true)).toContain("未確認");
    expect(billingLabel(zero, true)).toContain("0 credits");
    for (const value of [unknown, unmeasured, zero, known]) expect(isBillingEvidence(value)).toBe(true);
  });
  it.each(["model", "prompt", "voice"])("binds the quote to %s", (field) => {
    const changed = structuredClone(request); if (field === "voice") changed.params.voice_id = "other"; else changed[field] += " changed";
    expect(() => assertNarrationQuote(quote(), changed, binding, now)).toThrow("billing_quote_mismatch");
  });
  it.each(["profile_id", "grant_epoch", "contract_digest"])("binds the quote to connection %s", (field) => {
    const changed = { ...binding, [field]: field === "contract_digest" ? "0".repeat(64) : "changed" };
    expect(() => assertNarrationQuote(quote(), request, changed, now)).toThrow("billing_connection_changed");
  });
  it.each([-1, 0, 1])("expires exactly at the deadline: offset %d", (offset) => {
    const q = quote(); if (offset < 0) expect(assertNarrationQuote(q, request, binding, now + 300_000 + offset)).toBe(q);
    else expect(() => assertNarrationQuote(q, request, binding, now + 300_000 + offset)).toThrow("billing_quote_expired");
  });
  it.each([16, 17, 18])("enforces the approved credit limit %d", (limit) => {
    const q = quote(); q.limits.max_credits = String(limit); const signed = resign(q);
    if (limit < 17) expect(() => assertNarrationQuote(signed, request, binding, now)).toThrow("billing_limit_exceeded");
    else expect(assertNarrationQuote(signed, request, binding, now)).toEqual(signed);
  });
  it.each(["0.001233", "0.001234", "0.001235"])("enforces the exact money limit %s", (amount) => {
    const q = quote(); q.limits.max_money.amount = amount; const signed = resign(q);
    if (amount === "0.001233") expect(() => assertNarrationQuote(signed, request, binding, now)).toThrow("billing_limit_exceeded");
    else expect(assertNarrationQuote(signed, request, binding, now)).toEqual(signed);
  });
  it.each([{ ...estimate, currency: "XYZ" }, { ...estimate, credits: 1e30 }, { ...estimate, generations_count: 2 }, { ...estimate, blocking_errors: ["blocked"] }])("rejects unsupported or invalid provider pricing", (value) => {
    expect(() => makeNarrationQuote(request, binding, value, now)).toThrow();
  });
  it("uses exact decimals and rejects overflow, missing and signed amounts", () => {
    expect(decimalUnits("0.001234")).toBe(1234000000n);
    for (const value of [undefined, "NaN", "1e30", "-1", "1000000000000", "0.0000000000001"]) expect(() => decimalUnits(value)).toThrow();
  });
  it("counts one source generation once across import/resume while recording zero new submissions", () => {
    const original = actualNarrationBilling({ credits: 17 }, "same-generation", 1), imported = structuredClone(original); imported.operation.submission_count = 0;
    const result = combineActualBilling([original, imported, imported]);
    expect(result.actual.credits).toBe("17"); expect(result.operation.submission_count).toBe(1);
  });
  it("does not turn signed URLs or arbitrary context into billing fields", () => {
    const q = quote(); q.private_context = "token https://example/?sig=private /Users/private";
    expect(() => assertNarrationQuote(resign(q), request, binding, now)).toThrow();
    const evidence = quoteBilling([resign(q)]); expect(isBillingEvidence(evidence)).toBe(false);
  });
  it("calls only a schema-verified estimate with explicit transfer approval", async () => {
    const client = { listTools: vi.fn(async () => ({ tools: [creativeSpeechTool, creativeStatusTool] })),
      callTool: vi.fn(async () => ({ structuredContent: { estimate, flow_created: true } })) };
    await expect(quoteElevenV4({ request }, { client, environment })).rejects.toThrow("billing_transfer_approval_required");
    expect(client.callTool).not.toHaveBeenCalled();
    const q = await quoteElevenV4({ request, approve_transfer: true }, { client, environment, now: () => now });
    expect(q.credits).toBe("17"); expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(client.callTool.mock.calls[0][0].arguments).toMatchObject({ estimate_only: true, generations_count: 1, model_id: "eleven_v4" });
    await expect(quoteElevenV4({ request: { ...request, model: "eleven_v4_turbo" }, approve_transfer: true }, { client, environment })).rejects.toThrow("mcp_v4_speech_tool_unavailable");
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });
  it("requires the on-disk Gate binding and never accepts permission from input JSON", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-billing-guard-"))); roots.push(root);
    const q = makeNarrationQuote(request, binding, estimate), entries = [{ request_id: request.id, quote: q }];
    const context_digest = await fixtureContext(root);
    await writeFile(join(root, "billing-quotes.json"), JSON.stringify({ schema_version: 1, entries, context_digest }));
    const payload = { request, run_id: "run", run_dir: root, approved: true };
    await expect(authorizeRunSubmission(payload, binding)).rejects.toThrow();
    const digest = billingDigest({ schema_version: 1, quotes: [q], context_digest });
    await writeFile(join(root, "state.json"), JSON.stringify({ run_id: "run", gates: { gate_1: { status: "approved", decision_source: "human", approved_input_digest: "a".repeat(64), billing_approval_digest: digest } } }));
    expect((await authorizeRunSubmission(payload, binding)).quote).toEqual(q);
    await expect(authorizeRunSubmission({ ...payload, run_id: "other-run" }, binding)).rejects.toThrow("billing_gate_required");
    const client = { listTools: async () => ({ tools: [creativeSpeechTool, creativeStatusTool] }), callTool: vi.fn(async () => ({ structuredContent: completed(request) })) };
    await expect(generateElevenV4({ ...payload, request: { ...request, prompt: "changed" } }, { client, environment })).rejects.toThrow("billing_quote_mismatch");
    expect(client.callTool).not.toHaveBeenCalled();
  });
  it("rejects changed provider schema after a quote without submitting", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "tsugite-billing-schema-"))); roots.push(root);
    const speech = structuredClone(creativeSpeechTool);
    const client = { listTools: async () => ({ tools: [speech, creativeStatusTool] }), callTool: vi.fn(async () => ({ structuredContent: { estimate } })) };
    const q = await quoteElevenV4({ request, approve_transfer: true }, { client, environment });
    const context_digest = await fixtureContext(root);
    await writeFile(join(root, "billing-quotes.json"), JSON.stringify({ schema_version: 1, entries: [{ request_id: request.id, quote: q }], context_digest }));
    await writeFile(join(root, "state.json"), JSON.stringify({ run_id: "run", gates: { gate_1: { status: "approved", decision_source: "human", approved_input_digest: "a".repeat(64), billing_approval_digest: billingDigest({ schema_version: 1, quotes: [q], context_digest }) } } }));
    speech.inputSchema.properties.context.description = "changed provider contract";
    await expect(generateElevenV4({ request, run_id: "run", run_dir: root }, { client, environment })).rejects.toThrow("billing_connection_changed");
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });
});
