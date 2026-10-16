// Unit tests replace the approval store boundary. Public CLI E2E never uses this.
import { billingDigest, makeNarrationQuote } from "../../adapters/billing-contract.mjs";
export function fixturePermit(request) {
  const quote = makeNarrationQuote(request, { connection: "elevenlabs", source: "operator-attested-environment",
    profile_id: "fixture", grant_epoch: "fixture-grant", contract_digest: "c".repeat(64) },
  { credits: 16, price_cents: 0.3168, currency: "usd", generations_count: 1 });
  return { quote, billing_approval_digest: billingDigest({ schema_version: 1, quotes: [quote] }), gate_approval_digest: "a".repeat(64) };
}
