/**
 * Provider-neutral durable async generation job foundation.
 */

export * from "./schema.js";
export * from "./errors.js";
export * from "./transitions.js";
export * from "./approval.js";
export * from "./secrets.js";
export * from "./download.js";
export * from "./audit.js";
export * from "./store.js";
export * from "./adapter.js";
export * from "./machine.js";
export * from "./preflight.js";

// Explicit re-exports used heavily by tests / callers.
export {
  computeRequestDigest,
  assertRequestDigestMatches,
  assertAmountWithinCap
} from "./approval.js";
export { verifyAdapterArtifact } from "./download.js";
export { exclusiveLock, DEFAULT_LOCK_STALE_MS } from "./audit.js";
