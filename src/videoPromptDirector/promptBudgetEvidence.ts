import { createHash } from "node:crypto";
import { constants as fsConstants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
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
const evidenceSnapshots = new WeakMap<object, string>();
const MAX_BUDGET_ARTIFACT_BYTES = 1 * 1024 * 1024;
const EXECUTION_AUTHORITATIVE_SOURCES = new Set(["official-api", "adapter"]);

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

type BudgetArtifactLoadInput = {
  artifactPath: string;
  repoRoot?: string;
  route: RouteIdentityV1;
  model_profile_digest: string;
  connection_profile_digest: string;
  now?: string;
};

/**
 * Shared trusted artifact reader. Performs containment / realpath / lstat
 * symlink rejection / regular-file / size-cap / same-FD fstat-read-fstat /
 * schema / canonical digest / route+model+connection exact match / expiry
 * checks and freezes the resulting evidence object. Callers decide how to
 * brand the object (planning fixture-only vs execution-authoritative).
 */
function readTrustedPinnedPromptBudgetArtifact(
  input: BudgetArtifactLoadInput
): TrustedPinnedPromptBudgetEvidence | undefined {
  const repoRoot = resolve(input.repoRoot ?? process.cwd());
  const artifactPath = resolve(input.artifactPath);
  if (!contained(repoRoot, artifactPath)) return undefined;
  try {
    const realRoot = realpathSync(repoRoot);
    const realPath = realpathSync(artifactPath);
    const lexicalStat = lstatSync(artifactPath);
    const stat = lstatSync(realPath);
    if (!contained(realRoot, realPath)
      || realPath !== artifactPath
      || lexicalStat.isSymbolicLink()
      || !stat.isFile()
      || stat.dev === 0
      || stat.ino === 0
      || stat.size > MAX_BUDGET_ARTIFACT_BYTES) return undefined;
    const bytes = readBoundedStableFile(realPath, stat);
    if (!bytes) return undefined;
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
    return deepFreeze({ ...body, digest: sha256Canonical(body) }) as TrustedPinnedPromptBudgetEvidence;
  } catch {
    return undefined;
  }
}

/**
 * Planning-only artifact loader used by fixture tests to exercise containment
 * and anti-forgery mechanics. It intentionally cannot grant execution
 * authority, and it has no provider-specific path or digest in core.
 */
export function loadPlanningOnlyPinnedPromptBudgetEvidence(input: {
  artifactPath: string;
  repoRoot?: string;
  route: RouteIdentityV1;
  model_profile_digest: string;
  connection_profile_digest: string;
  now?: string;
}): TrustedPinnedPromptBudgetEvidence | undefined {
  const evidence = readTrustedPinnedPromptBudgetArtifact(input);
  if (!evidence) return undefined;
  trustedEvidence.add(evidence);
  fixtureOnlyEvidence.add(evidence);
  evidenceSnapshots.set(evidence, sha256Canonical(evidence));
  return evidence;
}

/**
 * Execution-authoritative local pinned budget loader. Accepts only explicit
 * official-api / adapter source limits (design truth for hard execution
 * claims). Never marks fixtureOnly. No network / provider calls.
 */
export function loadExecutionAuthoritativePinnedPromptBudgetEvidence(input: {
  artifactPath: string;
  repoRoot?: string;
  route: RouteIdentityV1;
  model_profile_digest: string;
  connection_profile_digest: string;
  now?: string;
}): TrustedPinnedPromptBudgetEvidence | undefined {
  const evidence = readTrustedPinnedPromptBudgetArtifact(input);
  if (!evidence) return undefined;
  if (!hasExecutionAuthoritativeSources(evidence)) return undefined;
  trustedEvidence.add(evidence);
  evidenceSnapshots.set(evidence, sha256Canonical(evidence));
  return evidence;
}

export function isTrustedPinnedPromptBudgetEvidence(value: unknown): value is TrustedPinnedPromptBudgetEvidence {
  return Boolean(value && typeof value === "object" && trustedEvidence.has(value)
    && snapshotMatches(value));
}

export function isExecutionAuthoritativePinnedPromptBudgetEvidence(value: unknown): value is TrustedPinnedPromptBudgetEvidence {
  return isTrustedPinnedPromptBudgetEvidence(value) && !fixtureOnlyEvidence.has(value);
}

function hasExecutionAuthoritativeSources(evidence: PinnedPromptBudgetEvidence): boolean {
  const limits = [evidence.hard, evidence.soft].filter((limit): limit is BudgetLimitEvidence => limit !== null);
  if (limits.length === 0) return false;
  return limits.every((limit) => EXECUTION_AUTHORITATIVE_SOURCES.has(limit.source));
}

function contained(root: string, candidate: string): boolean {
  const descendant = relative(resolve(root), resolve(candidate));
  return descendant === ""
    || (!isAbsolute(descendant) && descendant !== ".." && !descendant.startsWith(`..${sep}`));
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function readBoundedStableFile(
  path: string,
  expected: { dev: number; ino: number; size: number; mtimeMs: number }
): Buffer | undefined {
  let fd = -1;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile()
      || before.dev === 0
      || before.ino === 0
      || before.dev !== expected.dev
      || before.ino !== expected.ino
      || before.size !== expected.size
      || before.size > MAX_BUDGET_ARTIFACT_BYTES) return undefined;
    const bytes = Buffer.alloc(before.size);
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const read = readSync(fd, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (read <= 0) return undefined;
      chunk.copy(bytes, offset, 0, read);
      offset += read;
    }
    const after = fstatSync(fd);
    if (after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs) return undefined;
    return bytes;
  } catch {
    return undefined;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function snapshotMatches(value: object): boolean {
  try {
    return evidenceSnapshots.get(value) === sha256Canonical(value);
  } catch {
    return false;
  }
}
