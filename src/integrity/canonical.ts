import { createHash } from "node:crypto";

/** Deterministic canonical JSON with sorted object keys. Arrays keep declaration order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/**
 * Pretty JSON with sorted object keys, array order preserved, undefined omitted,
 * and a trailing newline. Used for durable run artifacts.
 */
export function stablePrettyJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
