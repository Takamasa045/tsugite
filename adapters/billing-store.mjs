import { lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { assertNarrationQuote, billingDigest } from "./billing-contract.mjs";
export const BILLING_QUOTES_FILE = "billing-quotes.json";
export const BILLING_CONTEXT_FILE = "billing-context.json";
const safeId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
export async function readBoundedRunJson(runDir, name) {
  if (!/^[a-z0-9-]+\.json$/.test(name)) throw new Error("billing_storage_invalid");
  const root = await realpath(runDir), path = join(root, name);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) throw new Error("billing_storage_invalid");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.ino !== info.ino || actual.dev !== info.dev || actual.size > 1_000_000) throw new Error("billing_storage_invalid");
    const text = await handle.readFile("utf8");
    if (Buffer.byteLength(text) > 1_000_000) throw new Error("billing_storage_invalid");
    return JSON.parse(text);
  } finally { await handle.close(); }
}
export async function readRunQuoteEntries(runDir) {
  const data = await readBoundedRunJson(runDir, BILLING_QUOTES_FILE);
  if (data.schema_version !== 1 || !Array.isArray(data.entries) || data.entries.length < 1 || data.entries.length > 32
    || Object.keys(data).some((key) => !["schema_version", "entries", "context_digest"].includes(key))
    || new Set(data.entries.map((e) => e.request_id)).size !== data.entries.length
    || data.entries.some((e) => !safeId(e.request_id) || Object.keys(e).some((key) => !["request_id", "quote"].includes(key)))) throw new Error("billing_quote_invalid");
  return data.entries;
}
export async function readRunBillingContext(runDir, required = true) {
  const quotes = await readBoundedRunJson(runDir, BILLING_QUOTES_FILE);
  if (quotes.context_digest === undefined && !required) return undefined;
  const context = await readBoundedRunJson(runDir, BILLING_CONTEXT_FILE);
  if (context.schema_version !== 1 || context.kind !== "tsugite.billing-context" || !safeId(context.project_slug)
    || typeof context.project_root !== "string" || context.project_root !== await realpath(context.project_root)
    || Object.keys(context).some((key) => !["schema_version", "kind", "project_root", "project_slug"].includes(key))
    || billingDigest(context) !== quotes.context_digest) throw new Error("billing_context_invalid");
  return { context, digest: quotes.context_digest };
}
export async function authorizeRunSubmission(payload, connectionBinding, now = Date.now()) {
  if (!safeId(payload?.run_id)) throw new Error("billing_gate_required");
  const entries = await readRunQuoteEntries(payload.run_dir), entry = entries.find((e) => e.request_id === payload.request.id);
  const context = await readRunBillingContext(payload.run_dir);
  const quote = assertNarrationQuote(entry?.quote, payload.request, connectionBinding, now);
  const state = await readBoundedRunJson(payload.run_dir, "state.json"), gate = state.gates?.gate_1;
  const binding = billingDigest({ schema_version: 1, quotes: entries.map((e) => e.quote), context_digest: context.digest });
  if (state.run_id !== payload.run_id || gate?.status !== "approved" || gate.decision_source !== "human"
    || !/^[a-f0-9]{64}$/.test(gate.approved_input_digest ?? "") || gate.billing_approval_digest !== binding) throw new Error("billing_gate_required");
  return { quote, billing_approval_digest: binding, gate_approval_digest: gate.approved_input_digest,
    project_context: context.context, project_context_digest: context.digest };
}
