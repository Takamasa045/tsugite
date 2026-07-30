/**
 * Generic reference-catalog dispatcher for the launcher.
 * Vendor-specific CLI contracts live under backends/<id>/catalog.mjs.
 */
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export const REFERENCE_CATALOG_SCHEMA_VERSION = 1 as const;
export const REFERENCE_CATALOG_CACHE_TTL_MS = 15_000;
/** Hard cap on per-store catalog cache entries (after expired pruning). */
export const REFERENCE_CATALOG_CACHE_MAX_ENTRIES = 64;
/** Hard cap on catalog id length before any provider / filesystem lookup. */
export const REFERENCE_CATALOG_ID_MAX_LENGTH = 64;
export const SAFE_REFERENCE_CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEFAULT_BACKEND_DIRS = [join(REPO_ROOT, "backends")];

export type ReferenceCatalogIssueCode =
  | "reference_catalog.not_found"
  | "reference_catalog.unavailable"
  | "reference_catalog.timeout"
  | "reference_catalog.output_too_large"
  | "reference_catalog.invalid_json"
  | "reference_catalog.schema_unsupported"
  | "reference_catalog.command_failed"
  | "reference_catalog.busy";

const SAFE_ISSUE_MESSAGES: Record<ReferenceCatalogIssueCode, string> = {
  "reference_catalog.not_found": "Reference catalog was not found",
  "reference_catalog.unavailable": "Reference catalog command is unavailable",
  "reference_catalog.timeout": "Reference catalog command timed out",
  "reference_catalog.output_too_large": "Reference catalog output exceeded the allowed size",
  "reference_catalog.invalid_json": "Reference catalog output was not valid JSON",
  "reference_catalog.schema_unsupported": "Reference catalog response was unsupported",
  "reference_catalog.command_failed": "Reference catalog command failed",
  "reference_catalog.busy": "Reference catalog is already loading"
};

export type ReferenceCatalogItemType = "block" | "component";

export type ReferenceCatalogItem = {
  id: string;
  type: ReferenceCatalogItemType;
  title: string;
  description: string;
  tags: string[];
  dimensions?: { width: number; height: number };
  durationSeconds?: number;
};

export type ReferenceCatalogSuccess = {
  ok: true;
  schemaVersion: typeof REFERENCE_CATALOG_SCHEMA_VERSION;
  source: string;
  advisoryOnly: true;
  capabilityVerified: false;
  summary: {
    total: number;
    returned: number;
    omitted: number;
    byType: {
      block: number;
      component: number;
    };
  };
  items: ReferenceCatalogItem[];
  warnings: string[];
};

export type ReferenceCatalogFailure = {
  ok: false;
  issue: {
    code: ReferenceCatalogIssueCode;
    message: string;
  };
};

export type ReferenceCatalogResult = ReferenceCatalogSuccess | ReferenceCatalogFailure;

export type LoadReferenceCatalogOptions = {
  backendDirs?: string[];
  cacheTtlMs?: number;
  /** Test seam: replace provider load for a catalog id. */
  loadProvider?: (catalogId: string) => Promise<ReferenceCatalogResult>;
  /** Shared cache/busy state for tests. */
  store?: ReferenceCatalogStore;
};

export type ReferenceCatalogStore = {
  cache: Map<string, { expiresAt: number; result: ReferenceCatalogResult }>;
  busy: Set<string>;
};

type CatalogProviderModule = {
  loadCatalog?: (options?: Record<string, unknown>) => Promise<unknown>;
  default?: {
    loadCatalog?: (options?: Record<string, unknown>) => Promise<unknown>;
  };
};

const defaultStore: ReferenceCatalogStore = {
  cache: new Map(),
  busy: new Set()
};

function failure(code: ReferenceCatalogIssueCode): ReferenceCatalogFailure {
  return {
    ok: false,
    issue: { code, message: SAFE_ISSUE_MESSAGES[code] }
  };
}

function pruneExpiredCacheEntries(
  store: ReferenceCatalogStore,
  now: number
): void {
  for (const [catalogId, entry] of store.cache) {
    if (entry.expiresAt <= now) {
      store.cache.delete(catalogId);
    }
  }
}

function shouldCacheReferenceCatalogResult(result: ReferenceCatalogResult): boolean {
  // Unknown / missing catalog ids must not accumulate under id rotation.
  if (!result.ok && result.issue.code === "reference_catalog.not_found") {
    return false;
  }
  return true;
}

function setCachedReferenceCatalogResult(
  store: ReferenceCatalogStore,
  catalogId: string,
  result: ReferenceCatalogResult,
  expiresAt: number,
  maxEntries: number
): void {
  pruneExpiredCacheEntries(store, Date.now());
  if (!shouldCacheReferenceCatalogResult(result)) {
    store.cache.delete(catalogId);
    return;
  }
  // Re-insert so the entry becomes newest under Map insertion order.
  if (store.cache.has(catalogId)) {
    store.cache.delete(catalogId);
  }
  store.cache.set(catalogId, { expiresAt, result });
  while (store.cache.size > maxEntries) {
    const oldest = store.cache.keys().next().value;
    if (oldest === undefined) break;
    store.cache.delete(oldest);
  }
}

export function createReferenceCatalogStore(): ReferenceCatalogStore {
  return {
    cache: new Map(),
    busy: new Set()
  };
}

export function isSafeReferenceCatalogId(value: string): boolean {
  return value.length > 0
    && value.length <= REFERENCE_CATALOG_ID_MAX_LENGTH
    && SAFE_REFERENCE_CATALOG_ID.test(value);
}

export async function resolveReferenceCatalogModulePath(
  catalogId: string,
  backendDirs: string[] = DEFAULT_BACKEND_DIRS
): Promise<string | null> {
  if (!isSafeReferenceCatalogId(catalogId)) return null;
  for (const dir of backendDirs) {
    const candidate = join(dir, catalogId, "catalog.mjs");
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // try next backend dir
    }
  }
  return null;
}

function isReferenceCatalogIssueCode(value: unknown): value is ReferenceCatalogIssueCode {
  return value === "reference_catalog.not_found"
    || value === "reference_catalog.unavailable"
    || value === "reference_catalog.timeout"
    || value === "reference_catalog.output_too_large"
    || value === "reference_catalog.invalid_json"
    || value === "reference_catalog.schema_unsupported"
    || value === "reference_catalog.command_failed"
    || value === "reference_catalog.busy";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && Number.isFinite(value)
    && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && Number.isFinite(value)
    && value > 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isReferenceCatalogItem(value: unknown): value is ReferenceCatalogItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || item.id.length === 0) return false;
  if (item.type !== "block" && item.type !== "component") return false;
  if (typeof item.title !== "string" || item.title.length === 0) return false;
  if (typeof item.description !== "string") return false;
  if (!Array.isArray(item.tags) || !item.tags.every((tag) => typeof tag === "string")) {
    return false;
  }
  if (item.dimensions !== undefined) {
    if (typeof item.dimensions !== "object" || item.dimensions === null) return false;
    const dimensions = item.dimensions as Record<string, unknown>;
    if (!isPositiveInteger(dimensions.width) || !isPositiveInteger(dimensions.height)) {
      return false;
    }
  }
  if (item.durationSeconds !== undefined && !isPositiveFiniteNumber(item.durationSeconds)) {
    return false;
  }
  return true;
}

/**
 * Normalize provider payloads into the public generic catalog contract.
 * Rejects unexpected shapes without leaking provider stderr/path/env.
 */
export function normalizeReferenceCatalogResult(value: unknown): ReferenceCatalogResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failure("reference_catalog.schema_unsupported");
  }

  const payload = value as Record<string, unknown>;
  if (payload.ok === false) {
    const issue = payload.issue;
    if (typeof issue !== "object" || issue === null) {
      return failure("reference_catalog.command_failed");
    }
    const code = (issue as { code?: unknown }).code;
    // Never reflect provider messages (may contain paths, env, or token-like text).
    return failure(
      isReferenceCatalogIssueCode(code) ? code : "reference_catalog.command_failed"
    );
  }

  if (payload.ok !== true) {
    return failure("reference_catalog.schema_unsupported");
  }
  if (payload.schemaVersion !== REFERENCE_CATALOG_SCHEMA_VERSION) {
    return failure("reference_catalog.schema_unsupported");
  }
  if (typeof payload.source !== "string" || payload.source.length === 0) {
    return failure("reference_catalog.schema_unsupported");
  }
  if (payload.advisoryOnly !== true || payload.capabilityVerified !== false) {
    return failure("reference_catalog.schema_unsupported");
  }
  if (!Array.isArray(payload.items) || !payload.items.every((entry) => isReferenceCatalogItem(entry))) {
    return failure("reference_catalog.schema_unsupported");
  }
  if (!Array.isArray(payload.warnings) || !payload.warnings.every((entry) => typeof entry === "string")) {
    return failure("reference_catalog.schema_unsupported");
  }
  if (typeof payload.summary !== "object" || payload.summary === null) {
    return failure("reference_catalog.schema_unsupported");
  }

  const summary = payload.summary as Record<string, unknown>;
  const byType = summary.byType;
  if (typeof byType !== "object" || byType === null) {
    return failure("reference_catalog.schema_unsupported");
  }
  const byTypeRecord = byType as Record<string, unknown>;
  if (
    !isNonNegativeInteger(summary.total)
    || !isNonNegativeInteger(summary.returned)
    || !isNonNegativeInteger(summary.omitted)
    || !isNonNegativeInteger(byTypeRecord.block)
    || !isNonNegativeInteger(byTypeRecord.component)
  ) {
    return failure("reference_catalog.schema_unsupported");
  }

  return {
    ok: true,
    schemaVersion: REFERENCE_CATALOG_SCHEMA_VERSION,
    source: payload.source,
    advisoryOnly: true,
    capabilityVerified: false,
    summary: {
      total: summary.total,
      returned: summary.returned,
      omitted: summary.omitted,
      byType: {
        block: byTypeRecord.block,
        component: byTypeRecord.component
      }
    },
    items: payload.items as ReferenceCatalogItem[],
    warnings: payload.warnings as string[]
  };
}

async function loadProviderModule(
  catalogId: string,
  backendDirs: string[]
): Promise<ReferenceCatalogResult> {
  const modulePath = await resolveReferenceCatalogModulePath(catalogId, backendDirs);
  if (!modulePath) {
    return failure("reference_catalog.not_found");
  }

  let mod: CatalogProviderModule;
  try {
    mod = await import(pathToFileURL(modulePath).href) as CatalogProviderModule;
  } catch {
    return failure("reference_catalog.unavailable");
  }

  const loadCatalog = typeof mod.loadCatalog === "function"
    ? mod.loadCatalog
    : typeof mod.default?.loadCatalog === "function"
      ? mod.default.loadCatalog
      : null;

  if (!loadCatalog) {
    return failure("reference_catalog.unavailable");
  }

  try {
    return normalizeReferenceCatalogResult(await loadCatalog());
  } catch {
    return failure("reference_catalog.command_failed");
  }
}

/**
 * Load a vendor reference catalog with short-lived cache and single-flight busy rejection.
 */
export async function loadReferenceCatalog(
  catalogId: string,
  options: LoadReferenceCatalogOptions = {}
): Promise<ReferenceCatalogResult> {
  if (!isSafeReferenceCatalogId(catalogId)) {
    return failure("reference_catalog.not_found");
  }

  const store = options.store ?? defaultStore;
  const cacheTtlMs = options.cacheTtlMs ?? REFERENCE_CATALOG_CACHE_TTL_MS;
  const maxEntries = REFERENCE_CATALOG_CACHE_MAX_ENTRIES;
  const now = Date.now();
  pruneExpiredCacheEntries(store, now);
  const cached = store.cache.get(catalogId);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }
  if (cached) {
    store.cache.delete(catalogId);
  }

  if (store.busy.has(catalogId)) {
    return failure("reference_catalog.busy");
  }

  store.busy.add(catalogId);
  try {
    const loadProvider = options.loadProvider
      ?? ((id: string) => loadProviderModule(id, options.backendDirs ?? DEFAULT_BACKEND_DIRS));
    const result = normalizeReferenceCatalogResult(await loadProvider(catalogId));
    setCachedReferenceCatalogResult(
      store,
      catalogId,
      result,
      Date.now() + cacheTtlMs,
      maxEntries
    );
    return result;
  } finally {
    store.busy.delete(catalogId);
  }
}

export function httpStatusForReferenceCatalogFailure(
  code: ReferenceCatalogIssueCode
): number {
  switch (code) {
    case "reference_catalog.not_found":
      return 404;
    case "reference_catalog.busy":
      return 429;
    case "reference_catalog.unavailable":
      return 503;
    case "reference_catalog.timeout":
      return 504;
    case "reference_catalog.output_too_large":
      return 413;
    case "reference_catalog.invalid_json":
    case "reference_catalog.schema_unsupported":
    case "reference_catalog.command_failed":
    default:
      return 502;
  }
}
