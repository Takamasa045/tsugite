import { createHash } from "node:crypto";
import { pcError } from "./errors.js";

type JsonObject = { [key: string]: JsonValue };
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

const OMIT_FROM_DIGEST = new Set([
  "acquired_at",
  "created_at",
  "expires_at",
  "host",
  "host_path",
  "hostname",
  "local_path",
  "absolute_path",
  "path",
  "updated_at"
]);

const FORBIDDEN_KEY = /(?:^|_)(?:api_key|access_token|refresh_token|authorization|cookie|credential|password|private_key|prompt|provider_body|provider_request|provider_response|raw_prompt|raw_provider|secret|session_token|token)(?:$|_)/;

/** Deterministic JSON; object key order is ignored and array order is retained. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, false));
}

/** Canonical JSON for persisted identities, excluding time, host/path and secret fields. */
export function canonicalDigestJson(value: unknown): string {
  return JSON.stringify(normalize(value, true));
}

/** SHA-256 over the production-control canonical identity representation. */
export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalDigestJson(value), "utf8").digest("hex");
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function withoutField<T>(value: T, field: string): T {
  if (!isObject(value)) return value;
  const copy = { ...value } as Record<string, unknown>;
  delete copy[field];
  return copy as T;
}

/** Reject non-JSON values and privacy-sensitive fields before a value reaches disk. */
export function assertSafeJsonValue(value: unknown, location = "payload"): void {
  normalize(value, false, location);
}

function normalize(value: unknown, forDigest: boolean, location = "value"): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && isAbsoluteLocalPath(value)) {
      throw pcError("PC_SECRET_OR_PATH", "absolute local paths are not allowed");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw pcError("PC_CANONICAL_INVALID", "non-finite numbers are not canonical JSON");
    }
    return value;
  }
  if (typeof value === "undefined") {
    // JSON.stringify omits undefined object members, but silently accepting it
    // would make two distinct inputs share an identity. Fail closed instead.
    throw pcError("PC_CANONICAL_INVALID", `undefined is not allowed at ${location}`);
  }
  if (typeof value !== "object") {
    throw pcError("PC_CANONICAL_INVALID", `unsupported value at ${location}`);
  }
  if (Array.isArray(value)) {
    return value.map((child, index) => normalize(child, forDigest, `${location}[${index}]`));
  }
  if (!isPlainObject(value)) {
    throw pcError("PC_CANONICAL_INVALID", `non-plain object at ${location}`);
  }
  const result = Object.create(null) as JsonObject;
  for (const key of Object.keys(value).sort()) {
    const normalizedKey = normalizeFieldKey(key);
    if (FORBIDDEN_KEY.test(normalizedKey)) {
      throw pcError("PC_SECRET_OR_PATH", "secret or raw provider/prompt fields are not allowed");
    }
    if (forDigest && OMIT_FROM_DIGEST.has(normalizedKey)) continue;
    result[key] = normalize((value as Record<string, unknown>)[key], forDigest, `${location}.${key}`);
  }
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeFieldKey(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
}

function isAbsoluteLocalPath(value: string): boolean {
  return value.startsWith("/")
    || value.startsWith("\\\\")
    || value.startsWith("~/")
    || value.startsWith("~\\")
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^file:\/\//i.test(value);
}
