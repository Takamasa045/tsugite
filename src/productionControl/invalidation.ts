import { z } from "zod";
import { assertSafeJsonValue, sha256Canonical } from "./canonical.js";
import {
  contractFragmentRefSchema,
  digestRefSchema,
  safeIdSchema,
  type ContractFragmentRef,
  type DigestRef,
  type TaskTreeSpec
} from "./schema.js";
import { pcError } from "./errors.js";
import {
  directConsumersForArtifact,
  directConsumersForFragment,
  buildDependencyIndex,
  dependencyIndexDigest,
  downstreamClosure,
  type DependencyIndex
} from "./dependencyIndex.js";
import { validateTaskTreeSpec } from "./taskTreeCompiler.js";

export const invalidationChangeKindSchema = z.enum([
  "contract-fragment",
  "selected-output",
  "evidence",
  "human-decision",
  "identity-verification",
  "risk",
  "residual-risk"
]);
export type InvalidationChangeKind = z.infer<typeof invalidationChangeKindSchema>;

export type InvalidationCause = {
  kind: InvalidationChangeKind;
  ref: ContractFragmentRef | DigestRef;
};

export const gateBindingProjectionSchema = z.object({
  binding_id: safeIdSchema,
  gate: z.enum(["gate-1", "gate-2", "gate-3"]),
  node_ids: z.array(safeIdSchema).max(256)
}).strict();
export type GateBindingProjection = z.infer<typeof gateBindingProjectionSchema>;

export const invalidationReportSchema = z.object({
  schema_version: z.literal(1),
  cause_refs: z.array(z.union([contractFragmentRefSchema, digestRefSchema])).min(1).max(256),
  stale_node_ids: z.array(safeIdSchema).max(256),
  preserved_node_ids: z.array(safeIdSchema).max(256),
  stale_gate_bindings: z.array(safeIdSchema).max(256),
  estimated_rework: z.object({
    tasks: z.number().int().nonnegative(),
    credits_at_risk: z.union([z.number().finite().nonnegative(), z.literal("unknown")])
  }).strict(),
  digest: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export type InvalidationReport = z.infer<typeof invalidationReportSchema>;
export type InvalidationReportV1 = InvalidationReport;

function refIsFragment(ref: ContractFragmentRef | DigestRef): ref is ContractFragmentRef {
  return "slot" in ref;
}

function tagsForChange(kind: InvalidationChangeKind): string[] {
  switch (kind) {
    case "identity-verification":
    case "selected-output":
    case "evidence":
      return ["identity-verification", "selected-output", "evidence", "gate-2", "gate-3"];
    case "human-decision":
      return ["human-decision", "gate-1", "gate-2", "gate-3"];
    case "risk":
    case "residual-risk":
      return ["identity-verification", "risk", "residual-risk", "gate-2", "gate-3"];
    case "contract-fragment":
      return [];
  }
}

export function computeInvalidation(input: {
  tree: TaskTreeSpec;
  index: DependencyIndex;
  changes: InvalidationCause[];
  gate_bindings?: GateBindingProjection[];
  credits_at_risk?: number | "unknown";
}): InvalidationReport {
  const tree = validateTaskTreeSpec(input.tree);
  if (input.index.tree_digest !== tree.digest) throw pcError("PC_INVALIDATION_INVALID", "dependency index tree digest mismatch");
  dependencyIndexDigest(input.index);
  if (buildDependencyIndex(tree).digest !== input.index.digest) {
    throw pcError("PC_INVALIDATION_INVALID", "dependency index does not match the validated task tree");
  }
  if (input.changes.length === 0) throw pcError("PC_INVALIDATION_INVALID", "invalidation requires at least one cause");
  const roots = new Set<string>();
  const tagChanges = new Set<string>();
  const causeRefs: Array<ContractFragmentRef | DigestRef> = [];
  for (const change of input.changes) {
    const parsedRef = refIsFragment(change.ref)
      ? contractFragmentRefSchema.parse(change.ref)
      : digestRefSchema.parse(change.ref);
    causeRefs.push(parsedRef);
    if (refIsFragment(parsedRef)) {
      for (const nodeId of directConsumersForFragment(input.index, parsedRef)) roots.add(nodeId);
    } else {
      for (const nodeId of directConsumersForArtifact(input.index, parsedRef)) roots.add(nodeId);
    }
    for (const tag of tagsForChange(change.kind)) tagChanges.add(tag);
  }
  for (const node of tree.nodes) {
    if (node.node_type !== "task") continue;
    if (node.invalidation_tags.some((tag) => tagChanges.has(tag))) roots.add(node.node_id);
  }
  const stale = new Set(downstreamClosure(input.index, roots));
  const allNodeIds = tree.nodes.map((node) => node.node_id).sort();
  const preserved = allNodeIds.filter((nodeId) => !stale.has(nodeId));
  const gateBindings = (input.gate_bindings ?? []).map((binding) => gateBindingProjectionSchema.parse(binding));
  const staleGates = gateBindings
    .filter((binding) => binding.node_ids.some((nodeId) => stale.has(nodeId))
      || (binding.gate !== "gate-1" && tagChanges.has("gate-2"))
      || (binding.gate !== "gate-1" && tagChanges.has("gate-3"))
      || (binding.gate === "gate-1" && tagChanges.has("gate-1")))
    .map((binding) => binding.binding_id)
    .sort();
  const base = {
    schema_version: 1 as const,
    cause_refs: causeRefs,
    stale_node_ids: [...stale].sort(),
    preserved_node_ids: preserved,
    stale_gate_bindings: staleGates,
    estimated_rework: {
      tasks: [...stale].filter((nodeId) => tree.nodes.find((node) => node.node_id === nodeId)?.node_type === "task").length,
      credits_at_risk: input.credits_at_risk ?? "unknown" as const
    }
  };
  assertSafeJsonValue(base, "invalidation report");
  return invalidationReportSchema.parse({ ...base, digest: sha256Canonical(base) });
}

export const invalidateByFragment = computeInvalidation;

export function contractChanged(
  index: DependencyIndex,
  changed: ContractFragmentRef
): string[] {
  return directConsumersForFragment(index, changed);
}
