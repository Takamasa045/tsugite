import { createHash } from "node:crypto";

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const billingDigest = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const decimal = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?$/;
export function decimalUnits(value) {
  if (typeof value !== "string" || !decimal.test(value)) throw new Error("billing_amount_invalid");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 10n ** 12n + BigInt(fraction.padEnd(12, "0"));
}
export function decimalString(value) {
  if (!Number.isFinite(value) || value < 0) throw new Error("billing_amount_invalid");
  const text = String(value); decimalUnits(text); return text;
}
const unitsString = (value) => `${value / 10n ** 12n}.${String(value % 10n ** 12n).padStart(12, "0")}`.replace(/\.?0+$/, "");
export function moneyFromCents(cents, currency) {
  // Only the currency/unit combination observed in the hosted response is supported.
  if (typeof currency !== "string" || currency.toUpperCase() !== "USD") throw new Error("billing_currency_unknown");
  const units = decimalUnits(decimalString(cents));
  if (units % 100n !== 0n) throw new Error("billing_amount_invalid");
  return { amount: unitsString(units / 100n), currency: "USD", unit: "generation" };
}
export function narrationRequestDigest(request) {
  return billingDigest({ model: request.model, text: request.prompt ?? request.text,
    voice_id: request.params?.voice_id ?? request.voiceId, generations_count: 1, output_kind: "audio", audio_role: "narration" });
}
export function validateConnectionBinding(value) {
  if (!value || value.connection !== "elevenlabs" || !["keychain", "operator-attested-environment"].includes(value.source)
    || ![value.contract_digest, value.profile_id, value.grant_epoch].every((item) => typeof item === "string")
    || !/^[a-f0-9]{64}$/.test(value.contract_digest ?? "")
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.profile_id ?? "")
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.grant_epoch ?? "")
    || Object.keys(value).some((key) => !["connection", "source", "contract_digest", "profile_id", "grant_epoch"].includes(key))) throw new Error("billing_connection_unverified");
  return value;
}
export function makeNarrationQuote(request, binding, estimate, observedAt = Date.now(), toolContractDigest = "0".repeat(64)) {
  validateConnectionBinding(binding);
  if (!Number.isSafeInteger(observedAt) || estimate?.generations_count !== 1 || estimate.blocking_errors?.length) throw new Error("billing_quote_invalid");
  const credits = decimalString(estimate.credits);
  const money = estimate.price_cents === undefined ? null : moneyFromCents(estimate.price_cents, estimate.currency);
  if (!/^[a-f0-9]{64}$/.test(toolContractDigest)) throw new Error("billing_quote_invalid");
  const body = { schema_version: 1, kind: "tsugite.narration-quote", request_digest: narrationRequestDigest(request), tool_contract_digest: toolContractDigest,
    connection_binding: binding, credits, money, quantity: 1, observed_at: new Date(observedAt).toISOString(),
    expires_at: new Date(observedAt + 300_000).toISOString(), validity_source: "client-five-minute-window",
    provider_billing_cap_enforced: false, source: "hosted-estimate-only", limits: { max_credits: credits, max_money: money ? { ...money } : null } };
  return { ...body, quote_id: billingDigest(body) };
}
export function assertNarrationQuote(quote, request, binding, now = Date.now()) {
  if (!quote || quote.schema_version !== 1 || quote.kind !== "tsugite.narration-quote" || quote.quantity !== 1
    || quote.source !== "hosted-estimate-only" || quote.validity_source !== "client-five-minute-window"
    || quote.provider_billing_cap_enforced !== false || !/^[a-f0-9]{64}$/.test(quote.request_digest ?? "")
    || !/^[a-f0-9]{64}$/.test(quote.tool_contract_digest ?? "")
    || (request !== undefined && quote.request_digest !== narrationRequestDigest(request))
    || Object.keys(quote).some((key) => !["schema_version", "kind", "request_digest", "tool_contract_digest", "connection_binding", "credits", "money", "quantity", "observed_at", "expires_at", "validity_source", "provider_billing_cap_enforced", "source", "limits", "quote_id"].includes(key))) throw new Error("billing_quote_mismatch");
  const { quote_id, ...body } = quote;
  if (quote_id !== billingDigest(body)) throw new Error("billing_quote_mismatch");
  validateConnectionBinding(quote.connection_binding);
  if (binding && billingDigest(binding) !== billingDigest(quote.connection_binding)) throw new Error("billing_connection_changed");
  const start = Date.parse(quote.observed_at), end = Date.parse(quote.expires_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end !== start + 300_000) throw new Error("billing_quote_invalid");
  if (now !== null && (now < start || now >= end)) throw new Error("billing_quote_expired");
  if (decimalUnits(quote.credits) > decimalUnits(quote.limits?.max_credits)) throw new Error("billing_limit_exceeded");
  if (Object.keys(quote.limits).some((key) => !["max_credits", "max_money"].includes(key))) throw new Error("billing_quote_invalid");
  if (quote.money !== null) {
    if (quote.money.currency !== "USD" || quote.money.unit !== "generation"
      || quote.limits?.max_money?.currency !== quote.money.currency || quote.limits.max_money.unit !== quote.money.unit
      || [quote.money, quote.limits.max_money].some((item) => Object.keys(item).some((key) => !["amount", "currency", "unit"].includes(key)))
      || decimalUnits(quote.money.amount) > decimalUnits(quote.limits.max_money.amount)) throw new Error("billing_limit_exceeded");
  } else if (quote.limits?.max_money !== null) throw new Error("billing_quote_invalid");
  return quote;
}
export function unknownBilling(reason = "quote_required") {
  return { schema_version: 1, estimate: { status: "unknown", credits: null, money: null, reason },
    actual: { status: "unmeasured", credits: null, money: null, source_generation_ref: null }, operation: { submission_count: 0 } };
}
export function quoteBilling(quotes) {
  return { ...unknownBilling(), estimate: { status: "known", credits: unitsString(quotes.reduce((sum, q) => sum + decimalUnits(q.credits), 0n)),
    money: quotes.every((q) => q.money) ? { amount: unitsString(quotes.reduce((sum, q) => sum + decimalUnits(q.money.amount), 0n)), currency: "USD", unit: "generation" } : null,
    quotes, source: "hosted-estimate-only", provider_billing_cap_enforced: false } };
}
export function actualNarrationBilling(price, generationRef, submissionCount) {
  let credits = null, money = null;
  try { credits = decimalString(price?.credits); } catch { /* Unmeasured is never zero. */ }
  try { money = moneyFromCents(price?.price_cents, price?.cost_fiat_currency); } catch { /* Currency/unit unknown. */ }
  return { ...unknownBilling(), actual: { status: credits !== null ? "measured" : "unmeasured", credits, money,
    source_generation_ref: generationRef ? billingDigest(generationRef) : null }, operation: { submission_count: submissionCount } };
}
export function billingLabel(billing, actual = false) {
  const value = actual ? billing?.actual : billing?.estimate;
  if (!value || value.status === "unknown" || value.status === "unmeasured") return actual ? "利用額: 未確認" : "生成料金: 未確認";
  if (value.status === "not_applicable") return "生成料金: 対象外";
  if (!actual && value.quotes?.some((quote) => Date.now() >= Date.parse(quote.expires_at))) return "生成料金: 見積期限切れ";
  return `${actual ? "確認済み利用額" : "確認済み見積"}: ${value.credits ?? "未確認"} credits${value.money ? ` / ${value.money.amount} ${value.money.currency}` : " / 金額未確認"}`;
}

export function isBillingEvidence(value) {
  try {
    if (!value || value.schema_version !== 1 || JSON.stringify(value).length > 100_000
      || Object.keys(value).some((key) => !["schema_version", "estimate", "actual", "operation"].includes(key))
      || !["known", "unknown", "not_applicable"].includes(value.estimate?.status)
      || !["measured", "unmeasured"].includes(value.actual?.status)
      || !Number.isInteger(value.operation?.submission_count) || value.operation.submission_count < 0 || value.operation.submission_count > 32
      || Object.keys(value.operation).some((key) => key !== "submission_count")
      || Object.keys(value.actual).some((key) => !["status", "credits", "money", "source_generation_ref"].includes(key))
      || (value.actual.source_generation_ref !== null && !/^[a-f0-9]{64}$/.test(value.actual.source_generation_ref))) return false;
    for (const record of [value.estimate, value.actual]) {
      if (record.credits !== null) decimalUnits(record.credits);
      if (record.money !== null) {
        if (record.money.currency !== "USD" || record.money.unit !== "generation" || Object.keys(record.money).some((key) => !["amount", "currency", "unit"].includes(key))) return false;
        decimalUnits(record.money.amount);
      }
    }
    if (value.actual.status === "unmeasured" && value.actual.credits !== null) return false;
    if (value.actual.status === "measured" && value.actual.credits === null) return false;
    if (value.estimate.status === "known" && value.estimate.credits === null) return false;
    if (value.estimate.status === "unknown" && (value.estimate.credits !== null || value.estimate.money !== null)) return false;
    if (Object.keys(value.estimate).some((key) => !["status", "credits", "money", "reason", "quotes", "source", "provider_billing_cap_enforced"].includes(key))
      || (value.estimate.reason !== undefined && !/^[a-z_]{1,80}$/.test(value.estimate.reason))
      || (value.estimate.source !== undefined && value.estimate.source !== "hosted-estimate-only")
      || (value.estimate.provider_billing_cap_enforced !== undefined && value.estimate.provider_billing_cap_enforced !== false)) return false;
    // Successful adapter output only carries a previously validated local quote.
    if (value.estimate.quotes) {
      if (!Array.isArray(value.estimate.quotes) || value.estimate.quotes.length > 32) return false;
      for (const quote of value.estimate.quotes) assertNarrationQuote(quote, undefined, undefined, null);
    }
    return true;
  } catch { return false; }
}
export function combineActualBilling(values) {
  if (!values.length) return undefined;
  const unique = new Map();
  for (const [index, value] of values.entries()) {
    if (!isBillingEvidence(value)) throw new Error("billing_evidence_invalid");
    unique.set(value.actual.source_generation_ref ?? `unmeasured-${index}`, value.actual);
  }
  const actual = [...unique.values()], measured = actual.every((item) => item.status === "measured");
  const result = unknownBilling();
  result.actual = { status: measured ? "measured" : "unmeasured",
    credits: measured ? unitsString(actual.reduce((sum, item) => sum + decimalUnits(item.credits), 0n)) : null,
    money: actual.every((item) => item.money) ? { amount: unitsString(actual.reduce((sum, item) => sum + decimalUnits(item.money.amount), 0n)), currency: "USD", unit: "generation" } : null,
    source_generation_ref: actual.length === 1 ? actual[0].source_generation_ref : billingDigest([...unique.keys()].sort()) };
  result.operation.submission_count = values.reduce((sum, value) => sum + value.operation.submission_count, 0);
  return result;
}
