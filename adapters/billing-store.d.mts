import type { ConnectionBinding, NarrationQuote } from "./billing-contract.mjs";
export const BILLING_QUOTES_FILE: "billing-quotes.json";
export const BILLING_CONTEXT_FILE: "billing-context.json";
export function readBoundedRunJson(runDir: string, name: string): Promise<any>;
export function readRunQuoteEntries(runDir: string): Promise<Array<{ request_id: string; quote: NarrationQuote }>>;
export function readRunBillingContext(runDir: string, required?: boolean): Promise<{ context: { schema_version: 1; kind: "tsugite.billing-context"; project_root: string; project_slug: string }; digest: string } | undefined>;
export function authorizeRunSubmission(payload: { request: unknown; run_id: string; run_dir: string }, binding: ConnectionBinding, now?: number): Promise<{ quote: NarrationQuote; billing_approval_digest: string; gate_approval_digest: string; project_context: unknown; project_context_digest: string }>;
