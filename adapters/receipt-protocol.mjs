import { billingDigest, isBillingEvidence, narrationRequestDigest, assertNarrationQuote } from "./billing-contract.mjs";

export const RECEIPT_LIMITS = Object.freeze({ polls: 30, wait_ms: 120_000, refreshes: 3, downloads: 3 });
const id = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
export function sealReceipt(body) {
  const { digest: _digest, ...record } = body;
  return { ...record, digest: billingDigest(record) };
}
export function validateNarrationReceipt(value, request) {
  if (!exactKeys(value, ["schema_version", "kind", "source", "transport_kind", "request_id", "request_digest", "run_id", "gate_approval_digest", "billing_approval_digest", "quote", "state", "job", "budgets", "billing", "asset", "result", "sequence", "previous_digest", "updated_at", "digest", "project_context_digest"])
    || value.schema_version !== 1 || value.kind !== "tsugite.narration-receipt" || !["generated", "imported"].includes(value.source)
    || !["creative", "inline"].includes(value.transport_kind)
    || !id(value.request_id) || !digest(value.request_digest) || !id(value.run_id)
    || !["submitting", "accepted", "succeeded", "pinned", "failed"].includes(value.state)
    || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !Number.isFinite(Date.parse(value.updated_at))
    || (value.previous_digest !== null && !digest(value.previous_digest)) || !digest(value.digest)
    || !isBillingEvidence(value.billing) || value.billing.operation.submission_count !== (value.source === "generated" ? 1 : 0)
    || (value.project_context_digest !== undefined && !digest(value.project_context_digest))) throw new Error("receipt_invalid");
  const { digest: claimed, ...body } = value;
  if (claimed !== billingDigest(body)) throw new Error("receipt_invalid");
  if (request && (value.request_id !== request.id || value.request_digest !== narrationRequestDigest(request))) throw new Error("receipt_request_mismatch");
  if (value.source === "generated") {
    if (!digest(value.gate_approval_digest) || !digest(value.billing_approval_digest)) throw new Error("receipt_invalid");
    assertNarrationQuote(value.quote, request, undefined, null);
    if (value.quote.request_digest !== value.request_digest) throw new Error("receipt_invalid");
  } else if (value.quote !== null || value.gate_approval_digest !== null || value.billing_approval_digest !== null) throw new Error("receipt_invalid");
  const budgets = value.budgets;
  if (!exactKeys(budgets, ["polls_used", "wait_ms_used", "refreshes_used", "downloads_used"])
    || ![budgets.polls_used, budgets.wait_ms_used, budgets.refreshes_used, budgets.downloads_used].every((v) => Number.isInteger(v) && v >= 0)
    || budgets.polls_used > RECEIPT_LIMITS.polls || budgets.wait_ms_used > RECEIPT_LIMITS.wait_ms
    || budgets.refreshes_used > RECEIPT_LIMITS.refreshes || budgets.downloads_used > RECEIPT_LIMITS.downloads) throw new Error("receipt_invalid");
  if (value.job !== null && (!exactKeys(value.job, ["flow_id", "session_ids"]) || !id(value.job.flow_id)
    || !Array.isArray(value.job.session_ids) || value.job.session_ids.length !== 1 || !id(value.job.session_ids[0]))) throw new Error("receipt_invalid");
  if (value.transport_kind === "creative" && ["accepted", "succeeded", "pinned"].includes(value.state) && value.job === null) throw new Error("receipt_invalid");
  if (value.result !== null && (!exactKeys(value.result, ["generation_id", "model", "voice_id"])
    || !id(value.result.generation_id) || !["eleven_v4", "eleven_v4_turbo"].includes(value.result.model) || !id(value.result.voice_id))) throw new Error("receipt_invalid");
  if (value.transport_kind === "creative" && ["succeeded", "pinned"].includes(value.state) && value.result === null) throw new Error("receipt_invalid");
  if (value.asset !== null && (!exactKeys(value.asset, ["relative_path", "temporary_name", "sha256", "byte_size", "duration_seconds"])
    || value.asset.relative_path !== `${value.request_id}.mp3` || !digest(value.asset.sha256)
    || typeof value.asset.temporary_name !== "string" || !value.asset.temporary_name.startsWith(`.${value.request_id}.`)
    || !/^[a-f0-9-]{36}\.tmp$/.test(value.asset.temporary_name.slice(value.request_id.length + 2))
    || !Number.isSafeInteger(value.asset.byte_size) || value.asset.byte_size < 3 || value.asset.byte_size > 32 * 1024 * 1024
    || !Number.isFinite(value.asset.duration_seconds) || value.asset.duration_seconds <= 0 || value.asset.duration_seconds > 3600)) throw new Error("receipt_invalid");
  if ((value.sequence === 0) !== (value.previous_digest === null)) throw new Error("receipt_invalid");
  if (value.transport_kind === "creative" && value.result && request
    && (value.result.model !== request.model || value.result.voice_id !== (request.params?.voice_id ?? request.voiceId))) throw new Error("receipt_request_mismatch");
  if (value.state === "pinned" && value.asset === null) throw new Error("receipt_invalid");
  return value;
}
export function isBillingRefinement(previous, next) {
  return billingDigest(previous.estimate) === billingDigest(next.estimate)
    && previous.operation.submission_count === next.operation.submission_count
    && (previous.actual.credits === null || previous.actual.credits === next.actual.credits)
    && (previous.actual.money === null || billingDigest(previous.actual.money) === billingDigest(next.actual.money))
    && (previous.actual.source_generation_ref === null || previous.actual.source_generation_ref === next.actual.source_generation_ref);
}
export function receiptPublicState(receipt) {
  validateNarrationReceipt(receipt);
  const states = {
    submitting: ["unknown", "inspect_record"], accepted: ["accepted", "poll_same_job"],
    succeeded: ["accepted", "download_same_job"], pinned: ["pinned", "use_pinned_result"], failed: ["failed", "inspect_record"]
  };
  const [submission_state, recovery_action] = states[receipt.state];
  return { request_id: receipt.request_id, state: receipt.state, submission_state, recovery_action,
    checked_at: receipt.updated_at, budgets: receipt.budgets, source_generation_ref: receipt.billing.actual.source_generation_ref,
    new_submission_allowed: false };
}

export function validReceiptTransition(previous, next) {
  const transitions = { submitting: ["submitting", "accepted", "succeeded"], accepted: ["accepted", "succeeded", "failed"],
    succeeded: ["succeeded", "pinned"], pinned: ["pinned"], failed: ["failed"] };
  return transitions[previous.state]?.includes(next.state) === true;
}
