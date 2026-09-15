/**
 * Cost reading for Hypit plan/pricing JSON.
 * Official CLI calculates no total. Missing amounts stay unknown.
 * Never default a missing cost to zero.
 */

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function requestViews(payload) {
  if (!isRecord(payload)) return [];
  const direct = asArray(payload.requests).concat(asArray(payload.needs));
  if (direct.length > 0) return direct.filter(isRecord);
  return asArray(payload.groups).flatMap((group) => {
    if (!isRecord(group)) return [];
    const nested = asArray(group.requests);
    return nested.length > 0 ? nested.filter(isRecord) : [group];
  });
}

function pricingKind(item) {
  const pricing = isRecord(item.pricing) ? item.pricing : item;
  if (pricing.kind === "local") return "local";
  if (pricing.kind === "page" && typeof pricing.url === "string" && pricing.url.length > 0) return "page";
  if (typeof item.pricingError === "string" && item.pricingError.length > 0) return "error";
  if (item.status === "unresolved" || item.status === "unsupported" || item.status === "ambiguous") return "unresolved";
  return "unknown";
}

/**
 * @returns {{
 *   status: "unknown" | "local-only" | "priced-documents",
 *   requestCount: number,
 *   localCount: number,
 *   unknownCount: number,
 *   unresolvedCount: number,
 *   pageCount: number,
 *   errorCount: number,
 *   amount: null,
 *   currency: null,
 *   notes: string[]
 * }}
 */
export function readHypitCost(payload) {
  const notes = [];
  if (payload == null) {
    return {
      status: "unknown",
      requestCount: 0,
      localCount: 0,
      unknownCount: 0,
      unresolvedCount: 0,
      pageCount: 0,
      errorCount: 0,
      amount: null,
      currency: null,
      notes: ["no plan/pricing payload; cost stays unknown"]
    };
  }
  const requests = requestViews(payload);
  const providers = isRecord(payload) ? asArray(payload.providers).filter(isRecord) : [];
  let localCount = 0;
  let unknownCount = 0;
  let unresolvedCount = 0;
  let pageCount = 0;
  let errorCount = 0;
  for (const item of requests) {
    const kind = pricingKind(item);
    if (kind === "local") localCount += 1;
    else if (kind === "page") pageCount += 1;
    else if (kind === "error") errorCount += 1;
    else if (kind === "unresolved") unresolvedCount += 1;
    else unknownCount += 1;
  }
  if (requests.length > 0 && unknownCount === requests.length && providers.length > 0) {
    let providerLocal = 0;
    let providerBad = 0;
    for (const item of providers) {
      const kind = pricingKind(item);
      if (kind === "local") providerLocal += 1;
      else providerBad += 1;
    }
    if (providerLocal === providers.length && providerBad === 0) {
      localCount = requests.length;
      unknownCount = 0;
      notes.push("plan providers declare local pricing; amount stays null");
    }
  }
  if (requests.length === 0) {
    notes.push("payload has no request/need/group list; Hypit calculates no total");
  }
  if (unknownCount > 0 || errorCount > 0 || unresolvedCount > 0) {
    notes.push("at least one request has unknown, failed, or unresolved pricing");
  }
  if (pageCount > 0) {
    notes.push("Provider page URLs are not a numeric total");
  }
  const allLocal = requests.length > 0 && localCount === requests.length
    && unknownCount === 0 && errorCount === 0 && unresolvedCount === 0 && pageCount === 0;
  return {
    status: allLocal ? "local-only" : "unknown",
    requestCount: requests.length,
    localCount,
    unknownCount,
    unresolvedCount,
    pageCount,
    errorCount,
    amount: null,
    currency: null,
    notes
  };
}

export function assertCostNotInvented(cost) {
  if (cost.amount !== null) {
    throw new Error("Hypit cost reader must not invent a numeric amount");
  }
  if (cost.status === "unknown" && cost.amount === 0) {
    throw new Error("unknown Hypit cost must not be stored as zero");
  }
  return cost;
}
