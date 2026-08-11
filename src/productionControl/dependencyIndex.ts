import {
  contractFragmentRefSchema,
  digestSchema,
  digestRefSchema,
  safeIdSchema,
  type ContractFragmentRef,
  type DigestRef,
  type TaskNode,
  type TaskTreeSpec
} from "./schema.js";
import { sha256Canonical, withoutField } from "./canonical.js";
import { pcError } from "./errors.js";
import { validateTaskTreeSpec } from "./taskTreeCompiler.js";
import { z } from "zod";

export type DependencyIndex = {
  schema_version: 1;
  tree_digest: string;
  by_fragment: Record<string, string[]>;
  by_contract: Record<string, string[]>;
  by_artifact: Record<string, string[]>;
  downstream: Record<string, string[]>;
  digest: string;
};

export const dependencyIndexSchema = z.object({
  schema_version: z.literal(1),
  tree_digest: digestSchema,
  by_fragment: z.record(z.string(), z.array(safeIdSchema)),
  by_contract: z.record(z.string(), z.array(safeIdSchema)),
  by_artifact: z.record(z.string(), z.array(safeIdSchema)),
  downstream: z.record(z.string(), z.array(safeIdSchema)),
  digest: digestSchema
}).strict().superRefine((value, context) => {
  if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "dependency index digest mismatch" });
  }
});

export function contractFragmentKey(ref: ContractFragmentRef): string {
  return [ref.slot, ref.contract_id, String(ref.revision), ref.kind, ref.fragment_id].join("\u0000");
}

export function contractIdentityKey(ref: Pick<ContractFragmentRef, "slot" | "contract_id">): string {
  return `${ref.slot}\u0000${ref.contract_id}`;
}

export function digestRefKey(ref: DigestRef): string {
  return [ref.kind, ref.id, ref.digest].join("\u0000");
}

function add(map: Map<string, Set<string>>, key: string, nodeId: string): void {
  const current = map.get(key) ?? new Set<string>();
  current.add(nodeId);
  map.set(key, current);
}

function sortedRecord(map: Map<string, Set<string>>): Record<string, string[]> {
  return Object.fromEntries([...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nodes]) => [key, [...nodes].sort()]));
}

export function buildDependencyIndex(tree: TaskTreeSpec): DependencyIndex {
  const parsed = validateTaskTreeSpec(tree);
  const byFragment = new Map<string, Set<string>>();
  const byContract = new Map<string, Set<string>>();
  const byArtifact = new Map<string, Set<string>>();
  const downstream = new Map<string, Set<string>>();
  for (const node of parsed.nodes) {
    if (node.node_type !== "task") continue;
    for (const rawRef of node.required_contract_fragments) {
      const ref = contractFragmentRefSchema.parse(rawRef);
      add(byFragment, contractFragmentKey(ref), node.node_id);
      add(byContract, contractIdentityKey(ref), node.node_id);
    }
    for (const rawRef of node.required_artifacts) {
      const ref = digestRefSchema.parse(rawRef);
      add(byArtifact, digestRefKey(ref), node.node_id);
    }
    for (const dependency of node.dependencies) add(downstream, dependency, node.node_id);
  }
  const base = {
    schema_version: 1 as const,
    tree_digest: parsed.digest,
    by_fragment: sortedRecord(byFragment),
    by_contract: sortedRecord(byContract),
    by_artifact: sortedRecord(byArtifact),
    downstream: sortedRecord(downstream)
  };
  return dependencyIndexSchema.parse({ ...base, digest: sha256Canonical(base) });
}

export function dependencyIndexDigest(index: DependencyIndex): string {
  const parsed = dependencyIndexSchema.parse(index);
  const { digest, ...base } = parsed;
  if (sha256Canonical(base) !== digest) throw pcError("PC_INVALIDATION_INVALID", "dependency index digest mismatch");
  return digest;
}

export function directConsumersForFragment(index: DependencyIndex, ref: ContractFragmentRef): string[] {
  if (ref.kind === "whole") {
    return [...(index.by_contract[contractIdentityKey(ref)] ?? [])].sort();
  }
  return [...(index.by_fragment[contractFragmentKey(ref)] ?? [])].sort();
}

export function directConsumersForArtifact(index: DependencyIndex, ref: DigestRef): string[] {
  return [...(index.by_artifact[digestRefKey(ref)] ?? [])].sort();
}

export function downstreamClosure(index: DependencyIndex, roots: Iterable<string>): string[] {
  const result = new Set<string>(roots);
  const queue = [...result];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of index.downstream[current] ?? []) {
      if (result.has(next)) continue;
      result.add(next);
      queue.push(next);
    }
  }
  return [...result].sort();
}

export function taskById(tree: TaskTreeSpec, nodeId: string): TaskNode | undefined {
  const node = tree.nodes.find((candidate) => candidate.node_id === nodeId);
  return node?.node_type === "task" ? node : undefined;
}
