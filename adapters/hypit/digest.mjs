import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Text(value) {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)])
  );
}

export async function fileDigest(path) {
  const bytes = await readFile(path);
  return { path, sha256: sha256Bytes(bytes), bytes: bytes.length };
}

export function fileDigestSync(path) {
  const bytes = readFileSync(path);
  return { path, sha256: sha256Bytes(bytes), bytes: bytes.length };
}

/**
 * Observation fingerprint only.
 * This is not a plan-bound approval, cost grant, or build authorization.
 * Named sources plus known package files are incomplete versus Hypit's
 * imported closure (activation JS, assets, model versions).
 */
export function observePlanFingerprint(input) {
  const observation = {
    format: "tsugite.hypit-plan-observation@1",
    role: "observation-only",
    authorization: false,
    distribution: {
      package: input.distribution.package,
      version: input.distribution.version,
      entrySha256: input.distribution.entrySha256
    },
    workspace: input.workspace,
    files: [...input.files].sort((left, right) => left.path.localeCompare(right.path)),
    runtime: input.runtime ?? null,
    plan: {
      sha256: input.planSha256,
      costStatus: input.cost.status,
      requestCount: input.cost.requestCount
    },
    omittedClosure: input.omittedClosure ?? [
      "full import graph",
      "generated activation beyond hashed files",
      "Runtime Profile bindings after init",
      "model/provider versions"
    ]
  };
  return {
    observation,
    observationDigest: sha256Text(canonicalJson(observation))
  };
}
