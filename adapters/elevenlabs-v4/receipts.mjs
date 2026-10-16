import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { sealReceipt, validateNarrationReceipt, validReceiptTransition } from "../receipt-protocol.mjs";
import { narrationRequestDigest, quoteBilling } from "../billing-contract.mjs";
import { syncDurableDirectory } from "./durability.mjs";
export { loadReceiptHistory } from "../receipt-store.mjs";

export function initialGeneratedReceipt(payload, permit, route) {
  const billing = quoteBilling([permit.quote]); billing.operation.submission_count = 1;
  return sealReceipt({ schema_version: 1, kind: "tsugite.narration-receipt", source: "generated", transport_kind: route.kind === "creative" ? "creative" : "inline",
    request_id: payload.request.id, request_digest: narrationRequestDigest(payload.request), run_id: payload.run_id,
    gate_approval_digest: permit.gate_approval_digest, billing_approval_digest: permit.billing_approval_digest, quote: permit.quote,
    state: "submitting", job: null, budgets: { polls_used: 0, wait_ms_used: 0, refreshes_used: 0, downloads_used: 0 },
    billing, asset: null, result: null, sequence: 0, previous_digest: null, updated_at: new Date().toISOString(),
    ...(permit.project_context_digest ? { project_context_digest: permit.project_context_digest } : {}) });
}

export async function durableReceiptWrite(directory, requestId, receipt, options = {}) {
  validateNarrationReceipt(receipt);
  const target = join(directory, `${requestId}.receipt.json`), temporary = join(directory, `.${requestId}.${randomUUID()}.receipt.tmp`);
  const filesystem = { ...fs, ...options.filesystem };
  try {
    try { const info = await fs.lstat(target); if (!info.isFile() || info.isSymbolicLink()) throw new Error("receipt_invalid"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    const handle = await filesystem.open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(receipt)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await filesystem.rename(temporary, target);
    await syncDurableDirectory(directory, options);
  } finally { await filesystem.unlink(temporary).catch(() => undefined); }
}
export function receiptWriter(directory, request, journal, initial, options = {}) {
  let current = initial;
  return {
    get current() { return current; },
    async publish(changes) {
      const next = sealReceipt({ ...current, ...changes, sequence: current.sequence + 1, previous_digest: current.digest, updated_at: new Date().toISOString() });
      validateNarrationReceipt(next, request);
      if (!validReceiptTransition(current, next)) throw new Error("receipt_invalid");
      // Journal snapshot is durable before publishing the mutable current file.
      await journal.writeFile(`${JSON.stringify({ phase: next.state, receipt: next })}\n`);
      await journal.sync();
      await durableReceiptWrite(directory, request.id, next, options);
      current = next;
      await options.afterReceiptPersist?.(next);
      await options.onReceipt?.(next.state);
      return next;
    }
  };
}
export async function openReceiptJournal(directory, requestId) {
  return fs.open(join(directory, `${requestId}.submission.jsonl`), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
}
