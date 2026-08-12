/**
 * Read-only loaders for authoritative coordination identity and TaskTree.
 * Fixture-safe: no provider, network, billing, Gate mutation, or finalize apply.
 */
import { lstat, readdir } from "node:fs/promises";
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
 * True when at least one non-symlink regular coordination control-plane file exists.
 * Symlinks are never treated as control-plane truth (matches finalize retention).
 * Does not create directories.
 */
export async function hasCoordinationControlPlaneArtifacts(
  projectRoot: string
): Promise<boolean> {
  const coordinationRoot = join(resolve(projectRoot), "coordination");
  return walkHasRegularControlPlaneFile(coordinationRoot);
}

/**
 * Prefer coordination snapshot / state production_id.
 * Slug fallback is legacy-only when the control plane is completely absent.
 * When any coordination control-plane artifact exists, snapshot/state that is a
 * symlink, broken, unreadable, or identity-mismatched fails closed (no slug).
 * Preview and apply must call this same resolver so completion digests bind to one identity.
 * Does not create coordination directories (legacy finalize stays side-effect free).
 */
export async function resolveAuthoritativeProductionId(
  projectRoot: string,
  project: { slug: string }
): Promise<string> {
  const legacySlug = safeIdSchema.parse(project.slug);
  const root = resolve(projectRoot);
  const coordinationRoot = join(root, "coordination");
  const snapshotPath = join(coordinationRoot, "coordination-state.json");
  const hasControlPlane = await hasCoordinationControlPlaneArtifacts(root);

  let leafKind: "missing" | "symlink" | "file" | "other" = "missing";
  try {
    const leaf = await lstat(snapshotPath);
    if (leaf.isSymbolicLink()) leafKind = "symlink";
    else if (leaf.isFile()) leafKind = "file";
    else leafKind = "other";
  } catch {
    leafKind = "missing";
  }

  if (!hasControlPlane) {
    // Completely absent control plane → legacy slug only (no SnapshotStore probe / mkdir).
    return legacySlug;
  }

  // Control plane present: never invent identity via project.slug.
  if (leafKind === "symlink") {
    throw pcError(
      "PC_PATH_UNSAFE",
      "coordination snapshot is a symlink while control-plane artifacts exist; refusing slug fallback"
    );
  }
  if (leafKind === "other") {
    throw pcError(
      "PC_PATH_UNSAFE",
      "coordination snapshot leaf is not a regular file while control-plane artifacts exist"
    );
  }
  if (leafKind === "missing") {
    throw pcError(
      "PC_ARTIFACT_NOT_FOUND",
      "control-plane artifacts exist but coordination snapshot is missing; refusing slug fallback"
    );
  }

  try {
    const snapshot = await new SnapshotStore(coordinationRoot).read();
    if (!snapshot) {
      throw pcError(
        "PC_ARTIFACT_NOT_FOUND",
        "control-plane artifacts exist but coordination snapshot is unreadable; refusing slug fallback"
      );
    }
    if (!snapshot.state.production_id) {
      throw pcError(
        "PC_ARTIFACT_MISMATCH",
        "coordination snapshot production_id is missing; refusing slug fallback"
      );
    }
    return safeIdSchema.parse(snapshot.state.production_id);
  } catch (error) {
    if (error instanceof ProductionControlError) throw error;
    throw pcError(
      "PC_RECOVERY_INVALID",
      "coordination snapshot/state is invalid or identity-mismatched; refusing slug fallback"
    );
  }
}

async function walkHasRegularControlPlaneFile(absDir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const abs = join(absDir, entry.name);
    let stats;
    try {
      stats = await lstat(abs);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      if (await walkHasRegularControlPlaneFile(abs)) return true;
      continue;
    }
    if (!stats.isFile()) continue;
    // Align with finalize retention: JSON/jsonl/logs/text under coordination/.
    if (/\.(json|jsonl|log|md|txt|html)$/i.test(entry.name)) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
