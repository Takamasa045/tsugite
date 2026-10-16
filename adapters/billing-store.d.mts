import type { ConnectionBinding, NarrationQuote } from "./billing-contract.mjs";
export const BILLING_QUOTES_FILE: "billing-quotes.json";
export function readBoundedRunJson(runDir: string, name: string): Promise<any>;
export function readRunQuoteEntries(runDir: string): Promise<Array<{ request_id: string; quote: NarrationQuote }>>;
export function authorizeRunSubmission(payload: { request: unknown; run_id: string; run_dir: string }, binding: ConnectionBinding, now?: number): Promise<{ quote: NarrationQuote; billing_approval_digest: string; gate_approval_digest: string }>;
