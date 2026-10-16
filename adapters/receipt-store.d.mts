import type { NarrationReceipt } from "./receipt-protocol.mjs";
export function loadReceiptHistory(directory: string, request: unknown): Promise<NarrationReceipt | undefined>;
