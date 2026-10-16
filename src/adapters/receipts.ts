import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadReceiptHistory } from "../../adapters/receipt-store.mjs";
import { receiptPublicState } from "../../adapters/receipt-protocol.mjs";
import type { AdapterDefinition } from "./registry.js";
import type { GenerationRequest } from "../project/schema.js";

/** Local-only projection. The adapter remains the sole receipt writer. */
export async function inspectGenerationReceipts(adapter: AdapterDefinition | undefined, requests: GenerationRequest[], runDir: string) {
  if (!adapter?.receipts || !adapter.resume) return { supported: false, requests: [], network: false, new_submission_allowed: false };
  const states = [];
  for (const request of requests) {
    try {
      let directory = resolve(runDir);
      for (const part of adapter.receipts.directory.split("/")) {
        directory = join(directory, part);
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("receipt_invalid");
      }
      if (await realpath(directory) !== directory) throw new Error("receipt_invalid");
      const receipt = await loadReceiptHistory(directory, request);
      states.push(receipt ? receiptPublicState(receipt) : { request_id: request.id, state: "not_submitted", recovery_action: "review_before_run", new_submission_allowed: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") states.push({ request_id: request.id, state: "not_submitted", recovery_action: "review_before_run", new_submission_allowed: false });
      else states.push({ request_id: request.id, state: "unknown", recovery_action: "inspect_record", new_submission_allowed: false });
    }
  }
  return { supported: true, requests: states, network: false, new_submission_allowed: false };
}
