/**
 * Secret redaction for job artifacts, audit, errors, and fixtures.
 * Never persist credential values — only env *names* are allowed in schema.
 */

import {
  GJ_SCHEMA_INVALID,
  GJ_SECRET_LEAK,
  GenerationJobError
} from "./errors.js";

// Provider-neutral patterns only (no vendor env names — those stay in adapters).
const SECRET_KEY_PATTERN =
  /^(?:.*(?:api[_-]?key|access[_-]?token|secret|password|authorization|bearer|cookie|session).*)$/i;

const SECRET_VALUE_PATTERN =
  /(?:Bearer\s+[A-Za-z0-9\-._~+/]+=*|sk-[A-Za-z0-9]{16,}|[A-Za-z0-9_\-]{32,}\.[A-Za-z0-9_\-]{16,})/g;

const REDACTED = "[REDACTED]";

export function looksLikeSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function redactSecretsInString(value: string): string {
  return value.replace(SECRET_VALUE_PATTERN, REDACTED);
}

/**
 * Deep-clone and redact secret-looking keys and values.
 * Arrays/objects are walked; non-plain values stringified carefully.
 */
export function redactSecretsDeep(value: unknown): unknown {
  if (typeof value === "string") return redactSecretsInString(value);
  if (Array.isArray(value)) return value.map(redactSecretsDeep);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (looksLikeSecretKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactSecretsDeep(child);
  }
  return out;
}

export function assertNoSecretKeysInParams(
  params: Record<string, unknown>,
  context = "request.params"
): void {
  for (const key of Object.keys(params)) {
    if (looksLikeSecretKey(key)) {
      throw new GenerationJobError(
        GJ_SCHEMA_INVALID,
        `${context} forbids secret-shaped key '${key}'`
      );
    }
  }
}

/**
 * Fail-closed scan for secret material that must never land in durable artifacts.
 * Call after redaction to ensure redaction was effective.
 */
export function assertNoSecretMaterial(
  value: unknown,
  context: string
): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return;
  // Detect common secret shapes that must never land in durable artifacts.
  if (/(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9]{16,}/.test(text)) {
    throw new GenerationJobError(
      GJ_SECRET_LEAK,
      `secret-like material detected in ${context}`
    );
  }
  if (/Bearer\s+[A-Za-z0-9\-._~+/]{20,}=*/i.test(text)) {
    throw new GenerationJobError(
      GJ_SECRET_LEAK,
      `secret-like material detected in ${context}`
    );
  }
  // Raw secret under a secret-shaped key that escaped redaction.
  if (/"[^"]*(?:api[_-]?key|access[_-]?token|password|authorization|cookie)[^"]*"\s*:\s*"(?!\[REDACTED\])[^"]{8,}"/i.test(text)) {
    throw new GenerationJobError(
      GJ_SECRET_LEAK,
      `secret-shaped key with non-redacted value detected in ${context}`
    );
  }
}

/** Redact then assert clean — used for adapter errors, audit detail, job records. */
export function redactAndAssertClean(value: unknown, context: string): unknown {
  const redacted = redactSecretsDeep(value);
  assertNoSecretMaterial(redacted, context);
  return redacted;
}
