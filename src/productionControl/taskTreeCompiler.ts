import {
  branchSelectionSchema,
  contractFragmentRefSchema,
  digestRefSchema,
  taskTreeSpecSchema,
  type BranchSelection,
  type MissionNode,
  type ProductionContract,
  type SeriesProductionGraph,
  type TaskNode,
  type TaskTreeNode,
  type TaskTreeSpec
} from "./schema.js";
import { sha256Canonical, withoutField } from "./canonical.js";
import { pcError } from "./errors.js";
import {
  assertKnownRole,
  assertKnownTaskKind,
  taskTreeTemplateSchema,
  type TaskTreeTemplate,
  type TaskTreeTemplateNode
} from "./taskTreeTemplates.js";

type MutableTaskNode = TaskNode;

function templateNodeId(node: TaskTreeTemplateNode): string {
  return node.node_id;
}

function validateTemplateBounds(node: TaskTreeTemplateNode, depth: number, seen: Set<string>): void {
  if (depth > 6) throw pcError("PC_TREE_INVALID", "task tree depth exceeds 6");
  if (seen.has(node.node_id)) throw pcError("PC_TREE_INVALID", "task tree node ids must be unique");
  seen.add(node.node_id);
  if (node.node_type !== "mission") {
    assertKnownRole(node.role);
    assertKnownTaskKind(node.kind);
    return;
  }
  if (node.children.length === 0) throw pcError("PC_TREE_INVALID", "mission nodes require explicit children");
  if (node.template_kind === "bounded_map") {
    if (!node.map_keys || node.map_keys.length === 0) {
      throw pcError("PC_TREE_INVALID", "bounded_map requires an explicit non-empty map_keys list");
    }
    const children = node.children.map(templateNodeId);
    if (new Set(node.map_keys).size !== node.map_keys.length
      || new Set(children).size !== children.length
      || node.map_keys.length !== children.length
      || node.map_keys.some((id) => !children.includes(id))) {
      throw pcError("PC_TREE_INVALID", "bounded_map keys must exactly enumerate its explicit children");
    }
  }
  if (node.template_kind === "choose_one" && node.children.length < 2) {
    throw pcError("PC_TREE_INVALID", "choose_one requires at least two explicit candidate branches");
  }
  for (const child of node.children) validateTemplateBounds(child, depth + 1, seen);
}

type Flattened = {
  nodes: TaskTreeNode[];
  taskIds: string[];
  firstTaskIds: string[];
  lastTaskIds: string[];
};

function flattenTemplate(node: TaskTreeTemplateNode, parentId?: string): Flattened {
  if (node.node_type === "task") {
    const taskNode: TaskNode = {
      node_type: "task",
      node_id: node.node_id,
      parent_id: parentId ?? (() => { throw pcError("PC_TREE_INVALID", "task cannot be the tree root"); })(),
      kind: node.kind as TaskNode["kind"],
      role: node.role as TaskNode["role"],
      effect: node.effect,
      dependencies: [...node.dependencies],
      required_contract_fragments: node.required_contract_fragments.map((value) => contractFragmentRefSchema.parse(value)),
      required_artifacts: node.required_artifacts.map((value) => digestRefSchema.parse(value)),
      output_schema: node.output_schema,
      risk_class: node.risk_class,
      invalidation_tags: [...node.invalidation_tags]
    };
    return { nodes: [taskNode], taskIds: [taskNode.node_id], firstTaskIds: [taskNode.node_id], lastTaskIds: [taskNode.node_id] };
  }

  const children = node.children.map((child) => flattenTemplate(child, node.node_id));
  const mission: MissionNode = {
    node_type: "mission",
    node_id: node.node_id,
    ...(parentId ? { parent_id: parentId } : {}),
    aggregation: node.template_kind === "choose_one"
      ? { kind: "choose_one" as const, selection: "human-branch-selection" as const }
      : {
          kind: node.template_kind === "parallel"
            ? "all" as const
            : node.template_kind === "bounded_map" ? "bounded_map" as const : "ordered" as const
        },
    child_ids: node.children.map((child) => child.node_id)
  };
  const allTaskIds = children.flatMap((child) => child.taskIds);
  const firstTaskIds = children.flatMap((child) => child.firstTaskIds);
  const lastTaskIds = children.flatMap((child) => child.lastTaskIds);
  return {
    nodes: [mission, ...children.flatMap((child) => child.nodes)],
    taskIds: allTaskIds,
    firstTaskIds,
    lastTaskIds
  };
}

function taskEndpoints(node: TaskTreeTemplateNode): { first: string[]; last: string[] } {
  if (node.node_type === "task") return { first: [node.node_id], last: [node.node_id] };
  const children = node.children.map(taskEndpoints);
  return {
    first: children.flatMap((child) => child.first),
    last: children.flatMap((child) => child.last)
  };
}

function addTemplateDependencies(node: TaskTreeTemplateNode, byId: Map<string, MutableTaskNode>): void {
  if (node.node_type === "task") return;
  for (const child of node.children) addTemplateDependencies(child, byId);
  if (node.template_kind !== "sequence") return;
  for (let index = 1; index < node.children.length; index += 1) {
    const previous = taskEndpoints(node.children[index - 1]!).last;
    const current = taskEndpoints(node.children[index]!).first;
    for (const currentId of current) {
      const task = byId.get(currentId);
      if (!task) continue;
      task.dependencies = [...new Set([...task.dependencies, ...previous])].sort();
    }
  }
}

function assertNodeGraph(nodes: TaskTreeNode[], rootNodeId: string): void {
  const byId = new Map(nodes.map((node) => [node.node_id, node]));
  const incomingParent = new Map<string, string>();
  for (const node of nodes) {
    if (node.node_type === "mission") {
      for (const childId of node.child_ids) {
        const child = byId.get(childId);
        if (!child) throw pcError("PC_TREE_INVALID", "mission references an unknown child");
        if (incomingParent.has(childId)) throw pcError("PC_TREE_INVALID", "a node cannot have multiple parents");
        incomingParent.set(childId, node.node_id);
        if (child.parent_id !== node.node_id) throw pcError("PC_TREE_INVALID", "child parent reference does not match mission");
      }
    } else {
      if (!byId.has(node.parent_id) || byId.get(node.parent_id)?.node_type !== "mission") {
        throw pcError("PC_TREE_INVALID", "task parent must be a mission node");
      }
      for (const dependency of node.dependencies) {
        const target = byId.get(dependency);
        if (!target || target.node_type !== "task") throw pcError("PC_TREE_INVALID", "task dependency must reference a task node");
        if (dependency === node.node_id) throw pcError("PC_TREE_INVALID", "task cannot depend on itself");
      }
    }
  }
  const root = byId.get(rootNodeId);
  if (!root || root.node_type !== "mission" || root.parent_id) throw pcError("PC_TREE_INVALID", "root node must be an unparented mission");

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) throw pcError("PC_TREE_INVALID", "task tree contains a cycle");
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    const node = byId.get(nodeId)!;
    const edges = node.node_type === "mission"
      ? node.child_ids
      : node.dependencies.map((dependency) => dependency);
    for (const next of edges) visit(next);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  visit(rootNodeId);
  if (visited.size !== nodes.length) throw pcError("PC_TREE_INVALID", "task tree contains unreachable nodes or a cycle");
}

function assertDepth(nodes: TaskTreeNode[], rootNodeId: string): void {
  const byId = new Map(nodes.map((node) => [node.node_id, node]));
  const visit = (nodeId: string, depth: number): void => {
    if (depth > 6) throw pcError("PC_TREE_INVALID", "task tree depth exceeds 6");
    const node = byId.get(nodeId);
    if (!node || node.node_type !== "mission") return;
    for (const child of node.child_ids) visit(child, depth + 1);
  };
  visit(rootNodeId, 0);
}

export function validateTaskTreeSpec(tree: TaskTreeSpec): TaskTreeSpec {
  const parsed = taskTreeSpecSchema.parse(tree);
  assertNodeGraph(parsed.nodes, parsed.root_node_id);
  assertDepth(parsed.nodes, parsed.root_node_id);
  const { digest, ...base } = parsed;
  if (sha256Canonical(base) !== digest) throw pcError("PC_TREE_INVALID", "task tree digest mismatch");
  return parsed;
}

export function compileTaskTree(input: {
  production: ProductionContract;
  template: TaskTreeTemplate;
  tree_revision?: number;
}): TaskTreeSpec {
  const template = taskTreeTemplateSchema.parse(input.template);
  validateTemplateBounds(template.root, 0, new Set());
  const flattened = flattenTemplate(template.root);
  const taskNodes = new Map(
    flattened.nodes
      .filter((node): node is MutableTaskNode => node.node_type === "task")
      .map((node) => [node.node_id, node])
  );
  addTemplateDependencies(template.root, taskNodes);
  if (flattened.nodes.length > input.production.limits.max_nodes || flattened.nodes.length > 256) {
    throw pcError("PC_TREE_INVALID", "task tree node count exceeds the bounded limit");
  }
  const treeRevision = input.tree_revision ?? 0;
  if (!Number.isSafeInteger(treeRevision) || treeRevision < 0) throw pcError("PC_TREE_INVALID", "tree revision must be non-negative");
  assertNodeGraph(flattened.nodes, template.root.node_id);
  assertDepth(flattened.nodes, template.root.node_id);
  const base = {
    schema_version: 1 as const,
    production_id: input.production.production_id,
    tree_revision: treeRevision,
    root_node_id: template.root.node_id,
    nodes: flattened.nodes
  };
  return validateTaskTreeSpec({ ...base, digest: sha256Canonical(base) });
}

export const compileTaskTreeV1 = compileTaskTree;

export function assertBranchSelectionRequired(tree: TaskTreeSpec, selection?: BranchSelection): void {
  const choices = tree.nodes.filter((node): node is MissionNode =>
    node.node_type === "mission" && node.aggregation.kind === "choose_one"
  );
  if (choices.length === 0) return;
  if (!selection) throw pcError("PC_TREE_INVALID", "choose_one requires a human branch selection");
  const parsed = branchSelectionSchema.parse(selection);
  if (parsed.production_id !== tree.production_id) throw pcError("PC_TREE_INVALID", "branch selection production does not match tree");
  const choice = choices.find((node) => node.node_id === parsed.mission_node_id);
  if (!choice) throw pcError("PC_TREE_INVALID", "branch selection mission is not a choose_one node");
  const candidates = new Set(parsed.candidate_artifact_refs.map((ref) => ref.id));
  if (!candidates.has(parsed.selected_artifact_ref.id)) {
    throw pcError("PC_TREE_INVALID", "selected branch is not among the candidate artifacts");
  }
}

export function createBranchSelection(input: {
  production_id: string;
  mission_node_id: string;
  candidate_artifact_refs: BranchSelection["candidate_artifact_refs"];
  selected_artifact_ref: BranchSelection["selected_artifact_ref"];
  decision: Omit<BranchSelection["decision"], "subject_digest">;
}): BranchSelection {
  const subject = {
    schema_version: 1 as const,
    production_id: input.production_id,
    mission_node_id: input.mission_node_id,
    candidate_artifact_refs: input.candidate_artifact_refs,
    selected_artifact_ref: input.selected_artifact_ref
  };
  const decision = { ...input.decision, subject_digest: sha256Canonical(subject) };
  const base = { ...subject, decision };
  return branchSelectionSchema.parse({ ...base, digest: sha256Canonical(base) });
}

export function createSeriesProductionGraph(input: {
  series_id: string;
  child_productions: SeriesProductionGraph["child_productions"];
  dependencies?: SeriesProductionGraph["dependencies"];
}): SeriesProductionGraph {
  const productionIds = new Set<string>();
  const gateScopes = new Set<string>();
  const budgetScopes = new Set<string>();
  for (const child of input.child_productions) {
    if (productionIds.has(child.production_id)) throw pcError("PC_TREE_INVALID", "series child production ids must be unique");
    if (gateScopes.has(child.gate_scope_id) || budgetScopes.has(child.budget_scope_id)) {
      throw pcError("PC_TREE_INVALID", "series child Gate and budget scopes must be isolated");
    }
    productionIds.add(child.production_id);
    gateScopes.add(child.gate_scope_id);
    budgetScopes.add(child.budget_scope_id);
  }
  const dependencies = input.dependencies ?? [];
  for (const edge of dependencies) {
    if (!productionIds.has(edge.before) || !productionIds.has(edge.after) || edge.before === edge.after) {
      throw pcError("PC_TREE_INVALID", "series dependency references an invalid child");
    }
  }
  const base = { schema_version: 1 as const, series_id: input.series_id, child_productions: input.child_productions, dependencies };
  return {
    ...base,
    digest: sha256Canonical(base)
  } as SeriesProductionGraph;
}

export function seriesGraphDigest(graph: SeriesProductionGraph): string {
  const parsed = graph;
  const { digest, ...base } = parsed;
  if (sha256Canonical(base) !== digest) throw pcError("PC_TREE_INVALID", "series graph digest mismatch");
  return digest;
}
