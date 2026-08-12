/**
 * PO-7 finalize retention helpers for control-plane evidence.
 * Additive only: never changes legacy plan_digest semantics.
 * Does not perform media deletion or finalize apply.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { sha256Canonical, withoutField } from "./canonical.js";
import { pcError } from "./errors.js";
import { digestSchema, safeIdSchema } from "./schema.js";

const CONTROL_PLANE_RELATIVE_ROOTS = [
  "coordination",
  "dist", // state/run logs live under dist; media cleanup already excludes retained run
] as const;

export const controlPlaneEvidenceRefSchema = z
  .object({
    kind: z.enum([
      "production-contract",
      "task-tree",
      "events",
      "snapshot",
      "metrics",
      "learning",
      "qa",
      "review",
      "feedback",
      "completion-record",
      "manifest",
      "state",
      "run-log"
    ]),
    relative_path: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "project-relative path required"),
    digest: digestSchema.optional(),
    retained: z.literal(true)
  })
  .strict();
export type ControlPlaneEvidenceRefV1 = z.infer<typeof controlPlaneEvidenceRefSchema>;

export const productionCompletionDigestInputSchema = z
  .object({
    production_id: safeIdSchema,
    plan_digest: digestSchema,
    contract_digest: digestSchema.optional(),
    task_tree_digest: digestSchema.optional(),
    mission_state_digest: digestSchema.optional(),
    metrics_digest: digestSchema.optional(),
    learning_rule_set_digest: digestSchema.optional(),
    event_sequence: z.number().int().nonnegative().optional(),
    evidence_refs: z.array(controlPlaneEvidenceRefSchema).max(512)
  })
  .strict();
export type ProductionCompletionDigestInput = z.infer<typeof productionCompletionDigestInputSchema>;

export const productionCompletionRecordSchema = z
  .object({
    schema_version: z.literal(1),
    production_id: safeIdSchema,
    /** Legacy plan_digest preserved byte-for-byte / same algorithm. */
    plan_digest: digestSchema,
    /** Additive completion digest over control-plane evidence. */
    production_completion_digest: digestSchema,
    control_plane_evidence: z.array(controlPlaneEvidenceRefSchema).max(512),
    retained_classes: z.array(
      z.enum([
        "final-run",
        "manifest",
        "state",
        "run-log",
        "qa",
        "review",
        "feedback",
        "learning",
        "metrics",
        "completion-record",
        "contract",
        "events"
      ])
    ),
    digest: digestSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["digest"],
        message: "production completion record digest mismatch"
      });
    }
  });
export type ProductionCompletionRecordV1 = z.infer<typeof productionCompletionRecordSchema>;

/**
 * Compute additive production_completion_digest.
 * Intentionally independent from buildPlanDigest payload / algorithm.
 */
export function buildProductionCompletionDigest(
  input: ProductionCompletionDigestInput
): string {
  const parsed = productionCompletionDigestInputSchema.parse(input);
  // Use a distinct namespace so this can never collide with legacy plan_digest payload.
  const payload = {
    namespace: "tsugite.production_completion_digest.v1",
    production_id: parsed.production_id,
    plan_digest: parsed.plan_digest,
    contract_digest: parsed.contract_digest ?? null,
    task_tree_digest: parsed.task_tree_digest ?? null,
    mission_state_digest: parsed.mission_state_digest ?? null,
    metrics_digest: parsed.metrics_digest ?? null,
    learning_rule_set_digest: parsed.learning_rule_set_digest ?? null,
    event_sequence: parsed.event_sequence ?? null,
    evidence_refs: [...parsed.evidence_refs]
      .map((ref) => ({
        kind: ref.kind,
        relative_path: ref.relative_path,
        digest: ref.digest ?? null,
        retained: true as const
      }))
      .sort((left, right) => left.relative_path.localeCompare(right.relative_path))
  };
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

export function buildProductionCompletionRecord(input: {
  production_id: string;
  plan_digest: string;
  evidence_refs: ControlPlaneEvidenceRefV1[];
  contract_digest?: string;
  task_tree_digest?: string;
  mission_state_digest?: string;
  metrics_digest?: string;
  learning_rule_set_digest?: string;
  event_sequence?: number;
}): ProductionCompletionRecordV1 {
  const production_completion_digest = buildProductionCompletionDigest({
    production_id: input.production_id,
    plan_digest: input.plan_digest,
    contract_digest: input.contract_digest,
    task_tree_digest: input.task_tree_digest,
    mission_state_digest: input.mission_state_digest,
    metrics_digest: input.metrics_digest,
    learning_rule_set_digest: input.learning_rule_set_digest,
    event_sequence: input.event_sequence,
    evidence_refs: input.evidence_refs
  });

  const draft = {
    schema_version: 1 as const,
    production_id: input.production_id,
    plan_digest: input.plan_digest,
    production_completion_digest,
    control_plane_evidence: input.evidence_refs,
    retained_classes: [
      "final-run",
      "manifest",
      "state",
      "run-log",
      "qa",
      "review",
      "feedback",
      "learning",
      "metrics",
      "completion-record",
      "contract",
      "events"
    ] as const
  };

  return productionCompletionRecordSchema.parse({
    ...draft,
    digest: sha256Canonical(draft)
  });
}

/**
 * Paths that finalize media cleanup must never delete when control plane is present.
 * Returns project-relative paths under coordination/ and related evidence.
 */
export async function listRetainedControlPlanePaths(
  projectRoot: string
): Promise<string[]> {
  const root = resolve(projectRoot);
  const retained: string[] = [];

  async function walk(absDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(absDir, entry.name);
      let stats;
      try {
        stats = await lstat(abs);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) {
        // Symlinks are never retained as control-plane truth.
        continue;
      }
      if (stats.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!stats.isFile()) continue;
      const real = await realpath(abs).catch(() => abs);
      const rel = relative(root, real).split(sep).join("/");
      if (rel.startsWith("..") || rel === "") continue;
      // Keep JSON/jsonl/logs only — never media extensions.
      if (/\.(json|jsonl|log|md|txt|html)$/i.test(rel)) {
        retained.push(rel);
      }
    }
  }

  // Prefer coordination/ tree (Mission control plane).
  await walk(join(root, "coordination"));
  // feedback.jsonl at project root
  for (const leaf of ["feedback.jsonl", "LESSONS.md"]) {
    const abs = join(root, leaf);
    try {
      const stats = await lstat(abs);
      if (stats.isFile() && !stats.isSymbolicLink()) retained.push(leaf);
    } catch {
      // absent is fine
    }
  }

  return [...new Set(retained)].sort((left, right) => left.localeCompare(right));
}

/**
 * True when a project-relative path is control-plane evidence and must not be a deletion candidate.
 */
export function isControlPlaneRetainedPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.includes("..")) return false;
  if (normalized === "feedback.jsonl" || normalized === "LESSONS.md") return true;
  if (normalized.startsWith("coordination/")) return true;
  // QA / review text records under dist are retained by existing finalize rules when in final run.
  if (/(^|\/)(mission-metrics|completion-record|state|events)(\.json|\.jsonl)?$/.test(normalized)) {
    return true;
  }
  void CONTROL_PLANE_RELATIVE_ROOTS;
  return false;
}

/**
 * Filter deletion candidates so control-plane evidence is never proposed for media cleanup.
 * Pure function — does not delete.
 */
export function excludeControlPlaneFromDeletionCandidates(
  candidates: readonly string[]
): { retained_extra: string[]; candidates: string[] } {
  const retained_extra: string[] = [];
  const next: string[] = [];
  for (const path of candidates) {
    if (isControlPlaneRetainedPath(path)) {
      retained_extra.push(path);
    } else {
      next.push(path);
    }
  }
  return {
    retained_extra: retained_extra.sort((left, right) => left.localeCompare(right)),
    candidates: next
  };
}

/**
 * True only for coordination/ control-plane evidence.
 * feedback.jsonl / LESSONS.md alone must not flip has_control_plane (legacy apply stays intact).
 */
export function isCoordinationControlPlanePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.includes("..") || normalized === "") return false;
  return normalized === "coordination" || normalized.startsWith("coordination/");
}

/** Active control plane = at least one retained coordination artifact. */
export function hasCoordinationControlPlane(
  evidence: readonly { relative_path: string }[]
): boolean {
  return evidence.some((item) => isCoordinationControlPlanePath(item.relative_path));
}

/**
 * Filter evidence used for production_completion_digest to coordination artifacts only.
 */
export function coordinationEvidenceOnly<T extends { relative_path: string }>(
  evidence: readonly T[]
): T[] {
  return evidence.filter((item) => isCoordinationControlPlanePath(item.relative_path));
}

/**
 * Apply-time check for additive production_completion_digest.
 * When expected is provided it must match; when control plane is active and expected is missing, fail closed.
 * Legacy projects without coordination control plane leave both undefined and pass
 * (feedback.jsonl / LESSONS.md alone are not a control-plane trigger).
 */
export function assertProductionCompletionDigestMatch(input: {
  has_control_plane: boolean;
  actual?: string;
  expected?: string;
}): void {
  if (!input.has_control_plane) {
    if (input.expected) {
      throw pcError(
        "PC_SCHEMA_INVALID",
        "expected production_completion_digest provided without control plane"
      );
    }
    return;
  }
  if (!input.actual) {
    throw pcError("PC_SCHEMA_INVALID", "control plane present but production_completion_digest missing");
  }
  if (!input.expected) {
    throw pcError(
      "PC_SCHEMA_INVALID",
      "finalize apply with control plane requires expected production_completion_digest"
    );
  }
  if (input.expected !== input.actual) {
    throw pcError("PC_SCHEMA_INVALID", "production_completion_digest mismatch");
  }
}

export function parseProductionCompletionRecord(input: unknown): ProductionCompletionRecordV1 {
  return productionCompletionRecordSchema.parse(input);
}
