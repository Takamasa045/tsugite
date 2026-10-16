export const RECEIPT_LIMITS: Readonly<{ polls: number; wait_ms: number; refreshes: number; downloads: number }>;
export type NarrationReceipt = { request_id: string; request_digest: string; state: "submitting" | "accepted" | "succeeded" | "pinned" | "failed"; [key: string]: any };
export function validateNarrationReceipt(value: unknown, request?: unknown): NarrationReceipt;
export function receiptPublicState(value: unknown): { request_id: string; state: string; submission_state: string; recovery_action: string; gate_approval_digest: string | null; billing: import("./billing-contract.mjs").BillingEvidence; checked_at: string; budgets: Record<string, number>; source_generation_ref: string | null; new_submission_allowed: false };
