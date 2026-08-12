/**
 * Read-only loaders for authoritative coordination identity and TaskTree.
 * Fixture-safe: no provider, network, billing, Gate mutation, or finalize apply.
 */
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ArtifactStore } from "./artifactStore.js";
import { pcError, ProductionControlError } from "./errors.js";
import { parseArtifactEnvelope, safeIdSchema, type TaskTreeSpec } from "./schema.js";
import { SnapshotStore } from "./statePersistence.js";
import { validateTaskTreeSpec } from "./taskTreeCompiler.js";

/** Stable ArtifactStore leaf for the current TaskTree under a coordination root. */
export const AUTHORITATIVE_TASK_TREE_ARTIFACT_ID = "task-tree";

export type AuthoritativeTaskTreeExpectation = {
  production_id: string;
  tree_revision: number;
  /** When set, the on-disk TaskTree digest must match exactly. */
  digest?: string;
};

/**
 * Load the exact TaskTree artifact for a coordination root.
 * Fail-closed on missing, stale, or mismatched production_id / revision / digest.
 * Never invents a tree from project.yaml or state nodes alone.
 */
export async function loadAuthoritativeTaskTree(
  coordinationRoot: string,
  expected: AuthoritativeTaskTreeExpectation
): Promise<TaskTreeSpec> {
  const productionId = safeIdSchema.parse(expected.production_id);
  if (!Number.isSafeInteger(expected.tree_revision) || expected.tree_revision < 0) {
    throw pcError("PC_SCHEMA_INVALID", "authoritative task tree revision is invalid");
  }

  const store = new ArtifactStore(resolve(coordinationRoot));
  let bytes: Buffer;
  try {
    bytes = await store.read(AUTHORITATIVE_TASK_TREE_ARTIFACT_ID);
  } catch (error) {
    if (error instanceof ProductionControlError && error.code === "PC_ARTIFACT_NOT_FOUND") {
      throw pcError("PC_ARTIFACT_NOT_FOUND", "authoritative task tree artifact is missing");
    }
    // Absent artifacts/ directory is equivalent to a missing TaskTree leaf (not invention).
    if (
      error instanceof ProductionControlError
      && error.code === "PC_PATH_UNSAFE"
      && /artifact directory identity could not be read/i.test(error.message)
    ) {
      throw pcError("PC_ARTIFACT_NOT_FOUND", "authoritative task tree artifact is missing");
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw pcError("PC_SCHEMA_INVALID", "authoritative task tree artifact is not valid JSON");
  }

  let candidate: unknown = raw;
  if (isRecord(raw) && typeof raw.envelope_digest === "string") {
    const envelope = parseArtifactEnvelope(raw);
    if (envelope.kind !== "task-tree") {
      throw pcError("PC_ARTIFACT_MISMATCH", "authoritative artifact kind is not task-tree");
    }
    if (envelope.production_id !== productionId) {
      throw pcError("PC_ARTIFACT_MISMATCH", "task tree envelope production_id mismatch");
    }
    if (envelope.tree_revision !== expected.tree_revision) {
      throw pcError("PC_ARTIFACT_MISMATCH", "task tree envelope tree_revision mismatch");
    }
    candidate = envelope.payload;
  }

  let tree: TaskTreeSpec;
  try {
    tree = validateTaskTreeSpec(candidate as TaskTreeSpec);
  } catch (error) {
    if (error instanceof ProductionControlError) throw error;
    throw pcError("PC_TREE_INVALID", "authoritative task tree is invalid");
  }

  if (tree.production_id !== productionId) {
    throw pcError("PC_ARTIFACT_MISMATCH", "task tree production_id mismatch");
  }
  if (tree.tree_revision !== expected.tree_revision) {
    throw pcError("PC_ARTIFACT_MISMATCH", "task tree tree_revision mismatch");
  }
  if (expected.digest !== undefined && tree.digest !== expected.digest) {
    throw pcError("PC_ARTIFACT_MISMATCH", "task tree digest mismatch");
  }
  return tree;
}

/**
 * Prefer coordination snapshot / state production_id; fall back to project.slug only when absent.
 * Preview and apply must call the same resolver so completion digests bind to one identity.
 * Does not create coordination directories (legacy finalize stays side-effect free).
 */
export async function resolveAuthoritativeProductionId(
  projectRoot: string,
  project: { slug: string }
): Promise<string> {
  const legacySlug = safeIdSchema.parse(project.slug);
  const coordinationRoot = join(resolve(projectRoot), "coordination");
  const snapshotPath = join(coordinationRoot, "coordination-state.json");
  try {
    const leaf = await lstat(snapshotPath);
    if (leaf.isSymbolicLink() || !leaf.isFile()) return legacySlug;
  } catch {
    // Absent snapshot → legacy slug fallback (no mkdir / no SnapshotStore probe).
    return legacySlug;
  }

  try {
    const snapshot = await new SnapshotStore(coordinationRoot).read();
    if (snapshot?.state.production_id) {
      return safeIdSchema.parse(snapshot.state.production_id);
    }
  } catch {
    // Unreadable snapshot leaf: do not invent; keep legacy slug identity.
    return legacySlug;
  }
  return legacySlug;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
