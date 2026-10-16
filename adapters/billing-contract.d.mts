export type Money = { amount: string; currency: "USD"; unit: "generation" };
export type ConnectionBinding = { connection: "elevenlabs"; source: "keychain" | "operator-attested-environment"; contract_digest: string; profile_id: string; grant_epoch: string };
export type NarrationQuote = {
  schema_version: 1; kind: "tsugite.narration-quote"; request_digest: string; tool_contract_digest: string; connection_binding: ConnectionBinding;
  credits: string; money: Money | null; quantity: 1; observed_at: string; expires_at: string;
  validity_source: "client-five-minute-window"; provider_billing_cap_enforced: false; source: "hosted-estimate-only";
  limits: { max_credits: string; max_money: Money | null }; quote_id: string;
};
export type BillingEvidence = {
  schema_version: 1;
  estimate: { status: "known" | "unknown" | "not_applicable"; credits: string | null; money: Money | null; reason?: string;
    quotes?: NarrationQuote[]; source?: string; provider_billing_cap_enforced?: false; context_digest?: string };
  actual: { status: "measured" | "unmeasured"; credits: string | null; money: Money | null; source_generation_ref: string | null };
  operation: { submission_count: number };
};
export function billingDigest(value: unknown): string;
export function decimalUnits(value: string): bigint;
export function decimalString(value: number): string;
export function moneyFromCents(cents: number, currency: string): Money;
export function narrationRequestDigest(request: unknown): string;
export function validateConnectionBinding(value: unknown): ConnectionBinding;
export function makeNarrationQuote(request: unknown, binding: ConnectionBinding, estimate: unknown, observedAt?: number, toolContractDigest?: string): NarrationQuote;
export function assertNarrationQuote(quote: unknown, request: unknown, binding?: ConnectionBinding, now?: number | null): NarrationQuote;
export function unknownBilling(reason?: string): BillingEvidence;
export function quoteBilling(quotes: NarrationQuote[]): BillingEvidence;
export function actualNarrationBilling(price: unknown, generationRef: unknown, submissionCount: number): BillingEvidence;
export function billingLabel(billing: BillingEvidence | undefined, actual?: boolean): string;
export function isBillingEvidence(value: unknown): value is BillingEvidence;
export function combineActualBilling(values: BillingEvidence[]): BillingEvidence | undefined;
