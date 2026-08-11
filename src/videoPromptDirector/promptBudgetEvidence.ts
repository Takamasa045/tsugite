import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { sha256Canonical } from "../integrity/canonical.js";
import { digestSchema, safeIdSchema } from "../productionControl/schema.js";
import type { RouteIdentityV1 } from "../productionControl/programBinding.js";

export type BudgetLimitEvidence = {
  limit: number;
  unit: "unicode-code-points" | "utf8-bytes" | "tokens";
  source: "official-api" | "adapter" | "advisory-catalog";
  verified_at: string;
  source_digest?: string;
};

export type PinnedPromptBudgetEvidence = {
  schema_version: 1;
  hard: BudgetLimitEvidence | null;
  soft: BudgetLimitEvidence | null;
  unknown: false;
  source_digest: string;
  source_id: string;
  retrieved_at: string;
  expires_at: string;
  model_profile_digest: string;
  connection_profile_digest: string;
  route_digest: string;
  digest: string;
};

declare const trustedPinnedBudgetEvidenceBrand: unique symbol;
export type TrustedPinnedPromptBudgetEvidence = PinnedPromptBudgetEvidence & {
  readonly [trustedPinnedBudgetEvidenceBrand]: true;
};

const trustedEvidence = new WeakSet<object>();
const fixtureOnlyEvidence = new WeakSet<object>();

const artifactSchema = z.object({
  schema_version: z.literal(1),
  source_id: safeIdSchema,
  hard: z.object({
    limit: z.number().int().positive(),
    unit: z.enum(["unicode-code-points", "utf8-bytes", "tokens"]),
    source: z.enum(["official-api", "adapter", "advisory-catalog"]),
    verified_at: z.string().min(1),
    source_digest: digestSchema.optional()
  }).strict().nullable(),
  soft: z.object({
    limit: z.number().int().positive(),
    unit: z.enum(["unicode-code-points", "utf8-bytes", "tokens"]),
    source: z.enum(["official-api", "adapter", "advisory-catalog"]),
    verified_at: z.string().min(1),
    source_digest: digestSchema.optional()
  }).strict().nullable(),
  unknown: z.literal(false),
  model_profile_digest: digestSchema,
  connection_profile_digest: digestSchema,
  route_digest: digestSchema,
  retrieved_at: z.string().min(1),
  expires_at: z.string().min(1)
}).strict();

/**
 * Fixture-only artifact loader used to exercise containment and anti-forgery
 * mechanics. It is deliberately not an execution authority for any route.
 */
export function loadFixturePinnedPromptBudgetEvidence(input: {
  repoRoot?: string;
  route: RouteIdentityV1;
  model_profile_digest: string;
  connection_profile_digest: string;
  now?: string;
}): TrustedPinnedPromptBudgetEvidence | undefined {
  const repoRoot = resolve(input.repoRoot ?? process.cwd());
  const fixtureRoot = resolve(repoRoot, "test", "fixtures", "prompt-budget");
  const artifactPath = resolve(fixtureRoot, "fixture.json");
  if (!contained(repoRoot, artifactPath) || !contained(fixtureRoot, artifactPath)) return undefined;
  try {
    const realRoot = realpathSync(fixtureRoot);
    const realPath = realpathSync(artifactPath);
    if (!contained(realRoot, realPath) || !statSync(realPath).isFile()) return undefined;
    const bytes = readFileSync(realPath);
    if (sha256Bytes(bytes) !== FIXTURE_ARTIFACT_DIGEST) return undefined;
    const parsed = artifactSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!parsed.success) return undefined;
    const artifact = parsed.data;
    const now = input.now ?? new Date().toISOString();
    if (artifact.model_profile_digest !== input.model_profile_digest
      || artifact.connection_profile_digest !== input.connection_profile_digest
      || artifact.route_digest !== input.route.route_digest
      || artifact.expires_at <= now) return undefined;
    const body = {
      schema_version: 1 as const,
      hard: artifact.hard,
      soft: artifact.soft,
      unknown: false as const,
      source_digest: sha256Bytes(bytes),
      source_id: artifact.source_id,
      retrieved_at: artifact.retrieved_at,
      expires_at: artifact.expires_at,
      model_profile_digest: artifact.model_profile_digest,
      connection_profile_digest: artifact.connection_profile_digest,
      route_digest: artifact.route_digest
    };
    const evidence = deepFreeze({ ...body, digest: sha256Canonical(body) }) as TrustedPinnedPromptBudgetEvidence;
    trustedEvidence.add(evidence);
    fixtureOnlyEvidence.add(evidence);
    return evidence;
  } catch {
    return undefined;
  }
}

export function isTrustedPinnedPromptBudgetEvidence(value: unknown): value is TrustedPinnedPromptBudgetEvidence {
  return Boolean(value && typeof value === "object" && trustedEvidence.has(value));
}

export function isExecutionAuthoritativePinnedPromptBudgetEvidence(value: unknown): value is TrustedPinnedPromptBudgetEvidence {
  return isTrustedPinnedPromptBudgetEvidence(value) && !fixtureOnlyEvidence.has(value);
}

function contained(root: string, candidate: string): boolean {
  const descendant = relative(resolve(root), resolve(candidate));
  return descendant === ""
    || (!isAbsolute(descendant) && descendant !== ".." && !descendant.startsWith(`..${sep}`));
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

const FIXTURE_ARTIFACT_DIGEST = "ad0b54dbed65d21d410ce52334553c29c255dc979fac991cb46a712b22839a9d";
