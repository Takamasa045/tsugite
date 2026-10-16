import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { assertNarrationQuote, billingDigest, quoteBilling, unknownBilling, type BillingEvidence, type NarrationQuote } from "../../adapters/billing-contract.mjs";
import type { Project } from "../project/schema.js";
import type { AdapterDefinition } from "./registry.js";
import { BILLING_CONTEXT_FILE, BILLING_QUOTES_FILE, readRunBillingContext, readRunQuoteEntries } from "../../adapters/billing-store.mjs";
import { spawnCommandSync } from "../platform/process.js";
import { describeAdapterError, parseAdapterErrorEnvelope } from "../../adapters/error-envelope.mjs";
import type { Result } from "../types.js";

export { BILLING_QUOTES_FILE };
export async function readBillingQuotes(runDir: string, requests: NonNullable<Project["generation"]>["requests"]): Promise<NarrationQuote[]> {
  const entries = await readRunQuoteEntries(runDir);
  if (entries.length !== requests.length) throw new Error("billing_quote_mismatch");
  return requests.map((request, index) => {
    const entry = entries[index];
    if (entry.request_id !== request.id || Object.keys(entry).some((key) => !["request_id", "quote"].includes(key))) throw new Error("billing_quote_mismatch");
    return assertNarrationQuote(entry.quote, request, undefined, null);
  });
}
export async function loadGenerationBilling(configPath: string, project: Project, adapter?: AdapterDefinition, stateDir?: string): Promise<BillingEvidence | undefined> {
  if (adapter?.billing_policy !== "quote-required") return undefined;
  const runDir = resolve(stateDir ?? resolve(dirname(resolve(configPath)), project.dist_dir), project.run_id ?? project.slug);
  try {
    const billing = quoteBilling(await readBillingQuotes(runDir, project.generation?.requests ?? []));
    const context = await readRunBillingContext(runDir, false);
    if (context) {
      if (context.context.project_root !== await realpath(dirname(resolve(configPath))) || context.context.project_slug !== project.slug) throw new Error("billing_context_invalid");
      billing.estimate.context_digest = context.digest;
    }
    return billing;
  }
  catch (error) {
    const code = error instanceof Error && /^billing_[a-z_]+$/.test(error.message) ? error.message : "quote_required";
    return unknownBilling(code);
  }
}
export async function writeBillingQuotes(runDir: string, entries: Array<{ request_id: string; quote: NarrationQuote }>, context?: unknown): Promise<void> {
  await mkdir(runDir, { recursive: true });
  const root = await realpath(runDir);
  if (root !== resolve(runDir) || (await lstat(root)).isSymbolicLink()) throw new Error("billing_storage_invalid");
  if (context !== undefined) await writeAtomicBillingFile(root, BILLING_CONTEXT_FILE, context);
  await writeAtomicBillingFile(root, BILLING_QUOTES_FILE, { schema_version: 1, entries, ...(context ? { context_digest: billingDigest(context) } : {}) });
}
async function writeAtomicBillingFile(root: string, name: string, value: unknown): Promise<void> {
  const destination = join(root, name), temporary = join(root, `.billing-${randomUUID()}.tmp`);
  try {
    try { if ((await lstat(destination)).isSymbolicLink()) throw new Error("billing_storage_invalid"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, destination);
  } finally { await unlink(temporary).catch(() => undefined); }
}
export function billingApprovalDigest(billing: BillingEvidence | undefined): string | undefined {
  return billing?.estimate.status === "known" && billing.estimate.quotes?.length
    ? billingDigest({ schema_version: 1, quotes: billing.estimate.quotes, ...(billing.estimate.context_digest ? { context_digest: billing.estimate.context_digest } : {}) }) : undefined;
}

export async function quoteGeneration(project: Project, adapter: AdapterDefinition | undefined, runDir: string, configPath: string): Promise<Result<{ billing: BillingEvidence }>> {
  if (!adapter?.quote || adapter.billing_policy !== "quote-required") return { ok: false, issues: [{ code: "billing.quote_unsupported", message: "この接続には検証済みの見積操作がありません。" }] };
  const requests = project.generation?.requests ?? [];
  if (requests.length < 1 || requests.length > 32) return { ok: false, issues: [{ code: "billing.request_count_invalid", message: "見積対象は1〜32件に限定してください。" }] };
  const entries: Array<{ request_id: string; quote: NarrationQuote }> = [];
  for (const request of requests) {
    const result = spawnCommandSync(adapter.quote.executable, adapter.quote.args, {
      cwd: process.cwd(), encoding: "utf8", input: JSON.stringify({ request, approve_transfer: true }),
      timeout: 90_000, maxBuffer: 1_000_000
    });
    if (result.error || result.signal || result.status !== 0) {
      const envelope = parseAdapterErrorEnvelope(result.stderr ?? "", request.id);
      return { ok: false, issues: [{ code: envelope ? `billing.${envelope.code}` : "billing.quote_failed",
        message: envelope ? describeAdapterError(envelope.code) : "見積を安全に確認できませんでした。新規生成は実行していません。",
        ...(envelope ? { adapter_error: envelope } : {}) }] };
    }
    try { entries.push({ request_id: request.id, quote: assertNarrationQuote(JSON.parse(result.stdout), request) }); }
    catch { return { ok: false, issues: [{ code: "billing.quote_invalid", message: "見積の金額・単位・対象条件を確認できませんでした。" }] }; }
  }
  const context = { schema_version: 1, kind: "tsugite.billing-context", project_root: await realpath(dirname(resolve(configPath))), project_slug: project.slug };
  try { await writeBillingQuotes(runDir, entries, context); }
  catch { return { ok: false, issues: [{ code: "billing.storage_invalid", message: "見積を安全に保存できませんでした。保存先を確認してください。" }] }; }
  const billing = quoteBilling(entries.map((entry) => entry.quote)); billing.estimate.context_digest = billingDigest(context);
  return { ok: true, issues: [], billing };
}
