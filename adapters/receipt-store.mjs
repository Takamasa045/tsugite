import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { billingDigest } from "./billing-contract.mjs";
import { isBillingRefinement, validateNarrationReceipt, validReceiptTransition } from "./receipt-protocol.mjs";

async function boundedFile(path, max = 1_000_000) {
  const info = await fs.lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw new Error("receipt_invalid");
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || info.dev !== actual.dev || info.ino !== actual.ino || actual.size > max) throw new Error("receipt_invalid");
    const bytes = Buffer.alloc(max + 1);
    let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    if (offset > max) throw new Error("receipt_invalid");
    return bytes.subarray(0, offset).toString("utf8");
  } finally { await handle.close(); }
}
export async function loadReceiptHistory(directory, request, options = {}) {
  let text;
  try { text = await boundedFile(join(directory, `${request.id}.submission.jsonl`)); }
  catch (error) { if (error?.code === "ENOENT") return undefined; throw new Error("receipt_unknown"); }
  let lines;
  try { lines = text.trim().split("\n").map((line) => JSON.parse(line)); } catch { throw new Error("receipt_unknown"); }
  if (lines[0]?.schema_version !== 2 || !lines[0]?.receipt) throw new Error("receipt_legacy_unknown");
  let current = validateNarrationReceipt(lines[0].receipt, request);
  const history = [current];
  if (current.sequence !== 0 || current.previous_digest !== null) throw new Error("receipt_invalid");
  for (const event of lines.slice(1)) {
    if (!event.receipt) throw new Error("receipt_unknown");
    const next = validateNarrationReceipt(event.receipt, request);
    if (!validReceiptTransition(current, next) || next.project_context_digest !== current.project_context_digest || next.sequence !== current.sequence + 1 || next.previous_digest !== current.digest
      || next.request_digest !== current.request_digest || next.gate_approval_digest !== current.gate_approval_digest
      || next.billing_approval_digest !== current.billing_approval_digest || next.run_id !== current.run_id
      || next.transport_kind !== current.transport_kind || next.source !== current.source
      || billingDigest(next.quote) !== billingDigest(current.quote)
      || (current.job !== null && billingDigest(next.job) !== billingDigest(current.job))
      || (current.result !== null && billingDigest(next.result) !== billingDigest(current.result))
      || (current.asset !== null && billingDigest(next.asset) !== billingDigest(current.asset))
      || !isBillingRefinement(current.billing, next.billing)
      || Object.keys(current.budgets).some((key) => next.budgets[key] < current.budgets[key])) throw new Error("receipt_invalid");
    current = next;
    history.push(current);
  }
  try {
    const saved = validateNarrationReceipt(JSON.parse(await boundedFile(join(directory, `${request.id}.receipt.json`), 100_000)), request);
    if (saved.sequence > current.sequence || saved.digest !== history[saved.sequence]?.digest) throw new Error("receipt_invalid");
  } catch (error) { if (error?.code !== "ENOENT") throw new Error("receipt_invalid"); }
  return current;
}
