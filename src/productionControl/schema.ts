import { z } from "zod";
import { assertSafeJsonValue, sha256Canonical, withoutField } from "./canonical.js";
import { ProductionControlError, pcError } from "./errors.js";

export const SHA256_RE = /^[a-f0-9]{64}$/;
export const ZERO_DIGEST = "0".repeat(64);

export const safeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "safe id required");
export const digestSchema = z.string().regex(SHA256_RE, "lowercase sha256 required");
const finiteNumber = z.number().refine(Number.isFinite, "finite number required");
const nonNegativeInt = finiteNumber.int().nonnegative();
const isoDateSchema = z.string().datetime({ offset: true });

export const digestRefSchema = z.object({
  kind: safeIdSchema,
  id: safeIdSchema,
  digest: digestSchema
}).strict();
export type DigestRef = z.infer<typeof digestRefSchema>;

export const contractFragmentRefSchema = z.object({
  slot: z.enum(["assets", "identity-definition", "music", "lyrics", "rules"]),
  contract_id: safeIdSchema,
  revision: nonNegativeInt,
  kind: z.enum(["whole", "asset", "subject", "scene", "section", "beat", "lyric-cue", "rule"]),
  fragment_id: safeIdSchema,
  digest: digestSchema
}).strict();
export type ContractFragmentRef = z.infer<typeof contractFragmentRefSchema>;

export const productionControlModeSchema = z.enum(["disabled", "shadow", "active"]);
export type ProductionControlMode = z.infer<typeof productionControlModeSchema>;

export const humanDecisionRefSchema = z.object({
  decision_id: safeIdSchema,
  decision: z.string().min(1).max(120),
  actor: z.string().min(1).max(256),
  decided_at: isoDateSchema,
  subject_digest: digestSchema,
  reason: z.string().min(1).max(2_000).optional()
}).strict();
export type HumanDecisionRef = z.infer<typeof humanDecisionRefSchema>;

export const contractRequirementSchema = z.object({
  requirement: z.enum(["required", "optional", "not_applicable"]),
  reason: z.string().min(1).max(500)
}).strict();
export type ContractRequirement = z.infer<typeof contractRequirementSchema>;

const deliverableSchema = z.object({
  id: safeIdSchema,
  kind: z.enum(["video", "audio", "image", "package"]),
  required: z.boolean(),
  acceptance_summary: z.string().min(1).max(2_000)
}).strict();

const productionConstraintsSchema = z.object({
  duration_ms: nonNegativeInt.optional(),
  aspect: safeIdSchema.optional(),
  locale: safeIdSchema.optional(),
  must_include: z.array(z.string().min(1).max(500)).max(256),
  prohibited: z.array(z.string().min(1).max(500)).max(256)
}).strict();

const productionAuthoritySchema = z.object({
  gate_1: z.literal("human"),
  gate_2: z.literal("human-or-existing-safe-auto-pass"),
  gate_3: z.literal("human"),
  render: z.literal("explicit-human-command"),
  publish: z.literal("explicit-human-command")
}).strict();

const productionContractSlotsSchema = z.object({
  assets: contractRequirementSchema,
  identity: contractRequirementSchema,
  music: contractRequirementSchema,
  lyrics: contractRequirementSchema
}).strict();

const productionLimitsSchema = z.object({
  max_tree_depth: nonNegativeInt,
  max_nodes: nonNegativeInt,
  max_parallel_pure_tasks: nonNegativeInt,
  max_effectful_tasks: z.literal(1)
}).strict();

const productionCreatedFromSchema = z.object({
  brief_digest: digestSchema,
  compiler_version: safeIdSchema
}).strict();

export const productionContractSchema = z.object({
  schema_version: z.literal(1),
  production_id: safeIdSchema,
  project: z.object({
    slug: safeIdSchema,
    project_yaml_digest: digestSchema
  }).strict(),
  objective: z.string().min(1).max(2_000),
  deliverables: z.array(deliverableSchema).min(1).max(64),
  constraints: productionConstraintsSchema,
  authority: productionAuthoritySchema,
  contract_slots: productionContractSlotsSchema,
  limits: productionLimitsSchema,
  created_from: productionCreatedFromSchema,
  rule_set_digest: digestSchema,
  root_digest: digestSchema
}).strict().superRefine((value, context) => {
  if (sha256Canonical(withoutField(value, "root_digest")) !== value.root_digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["root_digest"], message: "production contract root digest mismatch" });
  }
});
export type ProductionContract = z.infer<typeof productionContractSchema>;
export type ProductionContractV1 = ProductionContract;

export const contractSetEntrySchema = z.object({
  slot: z.enum(["assets", "identity-definition", "music", "lyrics"]),
  contract_id: safeIdSchema,
  contract_revision: nonNegativeInt,
  artifact_id: safeIdSchema,
  digest: digestSchema
}).strict();

export const contractSetSchema = z.object({
  schema_version: z.literal(1),
  production_id: safeIdSchema,
  revision: nonNegativeInt,
  contracts: z.array(contractSetEntrySchema).max(4),
  digest: digestSchema
}).strict().superRefine((value, context) => {
  const slots = value.contracts.map((contract) => contract.slot);
  if (new Set(slots).size !== slots.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["contracts"], message: "contract set slots must be unique" });
  }
  if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "contract set digest mismatch" });
  }
});
export type ContractSet = z.infer<typeof contractSetSchema>;
export type ContractSetV1 = ContractSet;

export const contractFragmentIndexSchema = z.object({
  schema_version: z.literal(1),
  slot: z.enum(["assets", "identity-definition", "music", "lyrics", "rules"]),
  contract_id: safeIdSchema,
  revision: nonNegativeInt,
  fragments: z.array(contractFragmentRefSchema).min(1).max(10_000),
  digest: digestSchema
}).strict().superRefine((value, context) => {
  const fragmentIds = value.fragments.map((fragment) => fragment.fragment_id);
  if (new Set(fragmentIds).size !== fragmentIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["fragments"], message: "fragment ids must be unique" });
  }
  for (const [index, fragment] of value.fragments.entries()) {
    if (fragment.slot !== value.slot) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["fragments", index, "slot"], message: "fragment slot must match its index" });
    }
    if (fragment.contract_id !== value.contract_id) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["fragments", index, "contract_id"], message: "fragment contract id must match its index" });
    }
    if (fragment.revision !== value.revision) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["fragments", index, "revision"], message: "fragment revision must match its index" });
    }
  }
  if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "contract fragment index digest mismatch" });
  }
});
export type ContractFragmentIndex = z.infer<typeof contractFragmentIndexSchema>;
export type ContractFragmentIndexV1 = ContractFragmentIndex;

export const PRODUCTION_CONTROL_ROLE_IDS = [
  "coordinator",
  "director",
  "story",
  "music",
  "identity",
  "visual",
  "generator",
  "editor",
  "critic",
  "learning"
] as const;
export const PRODUCTION_CONTROL_EFFECTS = [
  "read",
  "propose",
  "local-write",
  "external-observe",
  "external-submit",
  "paid",
  "render",
  "gate"
] as const;
export type ProductionControlEffect = (typeof PRODUCTION_CONTROL_EFFECTS)[number];
export type ProductionControlRole = (typeof PRODUCTION_CONTROL_ROLE_IDS)[number];

/** One authority matrix shared by persisted schemas and every compiler entry point. */
export const ROLE_EFFECT_ALLOWLIST: Readonly<Record<ProductionControlRole, readonly ProductionControlEffect[]>> = {
  coordinator: PRODUCTION_CONTROL_EFFECTS,
  director: ["read", "propose"],
  story: ["read", "propose"],
  music: ["read", "propose", "external-observe"],
  identity: ["read", "propose"],
  visual: ["read", "propose"],
  generator: ["read", "propose", "external-observe", "external-submit", "paid"],
  editor: ["read", "propose", "local-write"],
  critic: ["read", "propose"],
  learning: ["read", "propose"]
};

export function roleEffectAllowed(role: string, effect: string): boolean {
  return (ROLE_EFFECT_ALLOWLIST[role as ProductionControlRole] ?? []).includes(effect as ProductionControlEffect);
}

export function authorityForEffect(effect: string): { external_submit: boolean; paid_execution: boolean } {
  return {
    external_submit: effect === "external-submit" || effect === "paid",
    paid_execution: effect === "paid"
  };
}

export const PRODUCTION_CONTROL_TASK_KINDS = [
  "source-and-rights",
  "asset-provenance",
  "music-analysis",
  "lyrics-alignment",
  "identity-definition",
  "treatment-and-story",
  "story-guides-selection",
  "visual-system",
  "production-plan",
  "generation-batch",
  "branch-critique",
  "edit-and-compose",
  "output-qa",
  "closeout-learning"
] as const;

const taskAggregationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }).strict(),
  z.object({ kind: z.literal("ordered") }).strict(),
  z.object({ kind: z.literal("bounded_map") }).strict(),
  z.object({ kind: z.literal("choose_one"), selection: z.literal("human-branch-selection") }).strict()
]);

export const missionNodeSchema = z.object({
  node_type: z.literal("mission"),
  node_id: safeIdSchema,
  parent_id: safeIdSchema.optional(),
  aggregation: taskAggregationSchema,
  child_ids: z.array(safeIdSchema).max(256)
}).strict();
export type MissionNode = z.infer<typeof missionNodeSchema>;

export const taskNodeSchema = z.object({
  node_type: z.literal("task"),
  node_id: safeIdSchema,
  parent_id: safeIdSchema,
  kind: z.enum(PRODUCTION_CONTROL_TASK_KINDS),
  role: z.enum(PRODUCTION_CONTROL_ROLE_IDS),
  effect: z.enum(PRODUCTION_CONTROL_EFFECTS),
  dependencies: z.array(safeIdSchema).max(256),
  required_contract_fragments: z.array(contractFragmentRefSchema).max(256),
  required_artifacts: z.array(digestRefSchema).max(256),
  output_schema: safeIdSchema,
  risk_class: z.enum(["low", "medium", "high"]),
  invalidation_tags: z.array(safeIdSchema).max(64)
}).strict().superRefine((value, context) => {
  if (!roleEffectAllowed(value.role, value.effect)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["effect"], message: "role-effect authority matrix forbids this task" });
  }
});
export type TaskNode = z.infer<typeof taskNodeSchema>;

export const taskTreeNodeSchema = z.discriminatedUnion("node_type", [missionNodeSchema, taskNodeSchema]);
export type TaskTreeNode = z.infer<typeof taskTreeNodeSchema>;

export const taskTreeSpecSchema = z.object({
  schema_version: z.literal(1),
  production_id: safeIdSchema,
  tree_revision: nonNegativeInt,
  root_node_id: safeIdSchema,
  nodes: z.array(taskTreeNodeSchema).max(256),
  digest: digestSchema
}).strict().superRefine((value, context) => {
  if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "task tree digest mismatch" });
  }
});
export type TaskTreeSpec = z.infer<typeof taskTreeSpecSchema>;
export type TaskTreeSpecV1 = TaskTreeSpec;

export const branchSelectionSchema = z.object({
  schema_version: z.literal(1),
  production_id: safeIdSchema,
  mission_node_id: safeIdSchema,
  candidate_artifact_refs: z.array(digestRefSchema).min(1).max(256),
  selected_artifact_ref: digestRefSchema,
  decision: humanDecisionRefSchema,
  digest: digestSchema
}).strict().superRefine((value, context) => {
  const withoutDigest = withoutField(value, "digest");
  if (sha256Canonical(withoutDigest) !== value.digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "branch selection digest mismatch" });
  }
  const { decision: _decision, ...subject } = withoutDigest;
  if (sha256Canonical(subject) !== value.decision.subject_digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["decision", "subject_digest"], message: "branch selection decision subject mismatch" });
  }
  const candidateIds = value.candidate_artifact_refs.map((ref) => ref.id);
  const candidateKeys = value.candidate_artifact_refs.map((ref) => `${ref.kind}\u0000${ref.id}\u0000${ref.digest}`);
  const selectedKey = `${value.selected_artifact_ref.kind}\u0000${value.selected_artifact_ref.id}\u0000${value.selected_artifact_ref.digest}`;
  if (new Set(candidateKeys).size !== candidateKeys.length || !candidateKeys.includes(selectedKey)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["selected_artifact_ref"], message: "selected branch must be one of the candidates" });
  }
});
export type BranchSelection = z.infer<typeof branchSelectionSchema>;
export type BranchSelectionV1 = BranchSelection;

export const seriesProductionGraphSchema = z.object({
  schema_version: z.literal(1),
  series_id: safeIdSchema,
  child_productions: z.array(z.object({
    production_id: safeIdSchema,
    production_contract_digest: digestSchema,
    gate_scope_id: safeIdSchema,
    budget_scope_id: safeIdSchema
  }).strict()).min(1).max(256),
  dependencies: z.array(z.object({ before: safeIdSchema, after: safeIdSchema }).strict()).max(256),
  digest: digestSchema
}).strict().superRefine((value, context) => {
  const productionIds = value.child_productions.map((child) => child.production_id);
  const gateScopeIds = value.child_productions.map((child) => child.gate_scope_id);
  const budgetScopeIds = value.child_productions.map((child) => child.budget_scope_id);
  if (new Set(productionIds).size !== productionIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["child_productions"], message: "series child production ids must be unique" });
  }
  if (new Set(gateScopeIds).size !== gateScopeIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["child_productions"], message: "series Gate scopes must be isolated" });
  }
  if (new Set(budgetScopeIds).size !== budgetScopeIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["child_productions"], message: "series budget scopes must be isolated" });
  }
  const known = new Set(productionIds);
  const edges = new Map<string, string[]>();
  for (const productionId of productionIds) edges.set(productionId, []);
  for (const [index, edge] of value.dependencies.entries()) {
    if (!known.has(edge.before) || !known.has(edge.after) || edge.before === edge.after) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["dependencies", index], message: "series dependency must reference distinct child productions" });
      continue;
    }
    edges.get(edge.before)!.push(edge.after);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (productionId: string): void => {
    if (visiting.has(productionId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["dependencies"], message: "series dependency graph must be acyclic" });
      return;
    }
    if (visited.has(productionId)) return;
    visiting.add(productionId);
    for (const next of edges.get(productionId) ?? []) visit(next);
    visiting.delete(productionId);
    visited.add(productionId);
  };
  for (const productionId of productionIds) visit(productionId);
  if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "series graph digest mismatch" });
  }
});
export type SeriesProductionGraph = z.infer<typeof seriesProductionGraphSchema>;
export type SeriesProductionGraphV1 = SeriesProductionGraph;

export const artifactEnvelopeSchema = z.object({
  schema_version: z.literal(1),
  artifact_id: safeIdSchema,
  kind: safeIdSchema,
  production_id: safeIdSchema,
  tree_revision: nonNegativeInt,
  node_id: safeIdSchema,
  task_revision: nonNegativeInt,
  attempt_id: safeIdSchema,
  producer_role: safeIdSchema,
  input_refs: z.array(digestRefSchema).max(256),
  contract_bindings: z.array(contractFragmentRefSchema).max(256),
  parent_artifact_ids: z.array(safeIdSchema).max(256),
  payload: z.unknown(),
  payload_digest: digestSchema,
  created_at: isoDateSchema,
  envelope_digest: digestSchema
}).strict().superRefine((value, context) => {
  validateSafeValue(value.payload, context, "payload");
  if (sha256Canonical(value.payload) !== value.payload_digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["payload_digest"], message: "payload digest mismatch" });
  }
  const expected = sha256Canonical(withoutField(value, "envelope_digest"));
  if (expected !== value.envelope_digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["envelope_digest"], message: "envelope digest mismatch" });
  }
});
export type ArtifactEnvelope = z.infer<typeof artifactEnvelopeSchema>;

export const roleSchema = safeIdSchema;
export const effectSchema = z.enum(PRODUCTION_CONTROL_EFFECTS);

const baseEventFields = {
  schema_version: z.literal(1),
  event_id: safeIdSchema,
  production_id: safeIdSchema,
  sequence: finiteNumber.int().positive(),
  previous_event_digest: digestSchema,
  payload_digest: digestSchema,
  created_at: isoDateSchema,
  coordinator_instance_id: safeIdSchema,
  event_digest: digestSchema
};

const event = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) => z.object({
  ...baseEventFields,
  type: z.literal(type),
  payload
}).strict();

const missionCreatedPayload = z.object({
  mission_digest: digestSchema,
  tree_revision: nonNegativeInt
}).strict();
const contractRevisionPayload = z.object({
  contract_digest: digestSchema,
  contract_set_digest: digestSchema
}).strict();
const treeCompiledPayload = z.object({
  tree_revision: nonNegativeInt,
  tree_digest: digestSchema
}).strict();
const taskReadiedPayload = z.object({
  node_id: safeIdSchema,
  task_revision: nonNegativeInt,
  input_digest: digestSchema,
  dependency_closure_digest: digestSchema
}).strict();
const attemptLeasedPayload = z.object({
  attempt_id: safeIdSchema,
  lease_id: safeIdSchema,
  node_id: safeIdSchema,
  task_revision: nonNegativeInt,
  attempt_key: digestSchema,
  input_digest: digestSchema,
  lease_digest: digestSchema,
  role: roleSchema,
  effect: effectSchema,
  acquired_at: isoDateSchema,
  expires_at: isoDateSchema
}).strict();
const attemptRefPayload = z.object({
  attempt_id: safeIdSchema,
  lease_digest: digestSchema
}).strict();
const artifactRefPayload = z.object({
  artifact_id: safeIdSchema,
  artifact_digest: digestSchema,
  node_id: safeIdSchema,
  attempt_id: safeIdSchema
}).strict();
const artifactAcceptedPayload = z.object({
  artifact_id: safeIdSchema,
  artifact_digest: digestSchema,
  node_id: safeIdSchema,
  attempt_id: safeIdSchema,
  expected_event_sequence: nonNegativeInt,
  tree_revision: nonNegativeInt,
  task_revision: nonNegativeInt,
  input_digest: digestSchema,
  lease_digest: digestSchema,
  dependency_closure_digest: digestSchema
}).strict();
const failedPayload = z.object({
  attempt_id: safeIdSchema,
  node_id: safeIdSchema,
  error_code: safeIdSchema
}).strict();
const awaitingHumanPayload = z.object({
  node_id: safeIdSchema,
  reason_code: safeIdSchema
}).strict();
const invalidatedPayload = z.object({
  cause_artifact_ids: z.array(safeIdSchema).min(1).max(256),
  stale_node_ids: z.array(safeIdSchema).min(1).max(256),
  preserved_node_ids: z.array(safeIdSchema).max(256),
  stale_gate_binding_ids: z.array(safeIdSchema).max(256)
}).strict().superRefine((value, context) => {
  for (const [name, values] of Object.entries(value)) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: "ids must be unique" });
    }
  }
});
const completedPayload = z.object({
  completion_digest: digestSchema
}).strict();
const gateBindingRecordedPayload = z.object({
  binding_id: safeIdSchema,
  gate: z.enum(["gate_1", "gate_2", "gate_3"]),
  subject_digest: digestSchema,
  decision_digest: digestSchema,
  /** Legacy approved_input_digest preserved as observation only. */
  legacy_approved_input_digest: digestSchema.optional(),
  stale: z.boolean().default(false)
}).strict();
const generationJobBoundPayload = z.object({
  binding_id: safeIdSchema,
  generation_job_id: safeIdSchema,
  node_id: safeIdSchema,
  attempt_id: safeIdSchema,
  immutable_identity_digest: digestSchema,
  gate_bundle_digest: digestSchema,
  approval_observed_revision: nonNegativeInt
}).strict();
const revisionIntentSelectedPayload = z.object({
  revision_intent_id: safeIdSchema,
  revision_intent_digest: digestSchema,
  target_node_id: safeIdSchema,
  change_class: safeIdSchema
}).strict();

export const productionEventSchema = z.discriminatedUnion("type", [
  event("mission-created", missionCreatedPayload),
  event("contract-revision-selected", contractRevisionPayload),
  event("tree-compiled", treeCompiledPayload),
  event("task-readied", taskReadiedPayload),
  event("attempt-leased", attemptLeasedPayload),
  event("attempt-started", attemptRefPayload),
  event("artifact-created", artifactRefPayload),
  event("artifact-accepted", artifactAcceptedPayload),
  event("attempt-failed-known", failedPayload),
  event("attempt-outcome-unknown", failedPayload),
  event("task-awaiting-human", awaitingHumanPayload),
  event("revision-intent-selected", revisionIntentSelectedPayload),
  event("nodes-invalidated", invalidatedPayload),
  event("gate-binding-recorded", gateBindingRecordedPayload),
  event("generation-job-bound", generationJobBoundPayload),
  event("mission-completed", completedPayload)
]);
export type ProductionEvent = z.infer<typeof productionEventSchema>;
export type ProductionEventType = ProductionEvent["type"];
export type EventPayload<T extends ProductionEventType> = Extract<ProductionEvent, { type: T }>["payload"];

const nodeStateSchema = z.object({
  node_id: safeIdSchema,
  status: z.enum(["proposed", "blocked", "ready", "running", "completed", "failed_known", "outcome_unknown", "awaiting_human", "stale"]),
  task_revision: nonNegativeInt,
  input_digest: digestSchema,
  dependency_closure_digest: digestSchema,
  accepted_artifact_id: safeIdSchema.optional(),
  stale: z.boolean()
}).strict();
const attemptStateSchema = z.object({
  attempt_id: safeIdSchema,
  node_id: safeIdSchema,
  task_revision: nonNegativeInt,
  input_digest: digestSchema,
  attempt_key: digestSchema,
  lease_digest: digestSchema,
  role: roleSchema,
  effect: effectSchema,
  status: z.enum(["leased", "started", "completed", "failed_known", "outcome_unknown"])
}).strict();
const acceptedArtifactSchema = z.object({
  artifact_id: safeIdSchema,
  artifact_digest: digestSchema,
  node_id: safeIdSchema,
  attempt_id: safeIdSchema,
  invalidated: z.boolean()
}).strict();
const createdArtifactSchema = z.object({
  artifact_id: safeIdSchema,
  artifact_digest: digestSchema,
  node_id: safeIdSchema,
  attempt_id: safeIdSchema
}).strict();
const gateBindingStateSchema = z.object({
  binding_id: safeIdSchema,
  gate: z.enum(["gate_1", "gate_2", "gate_3"]),
  subject_digest: digestSchema,
  decision_digest: digestSchema,
  legacy_approved_input_digest: digestSchema.optional(),
  stale: z.boolean()
}).strict();
const generationBindingStateSchema = z.object({
  binding_id: safeIdSchema,
  generation_job_id: safeIdSchema,
  node_id: safeIdSchema,
  attempt_id: safeIdSchema,
  immutable_identity_digest: digestSchema,
  gate_bundle_digest: digestSchema,
  approval_observed_revision: nonNegativeInt
}).strict();

export const missionStateSchema = z.object({
  schema_version: z.literal(1),
  production_id: safeIdSchema,
  mission_status: z.enum(["new", "ready", "running", "completed", "blocked", "awaiting_human"]),
  revision: nonNegativeInt,
  applied_event_sequence: nonNegativeInt,
  applied_event_digest: digestSchema,
  tree_revision: nonNegativeInt,
  nodes: z.record(safeIdSchema, nodeStateSchema),
  attempts: z.record(safeIdSchema, attemptStateSchema),
  created_artifacts: z.record(safeIdSchema, createdArtifactSchema),
  accepted_artifacts: z.record(safeIdSchema, acceptedArtifactSchema),
  invalidated_node_ids: z.array(safeIdSchema).max(256),
  /** Additive PO-5 projections; absent on pre-PO-5 snapshots is normalized to {}. */
  gate_bindings: z.record(safeIdSchema, gateBindingStateSchema).default({}),
  generation_bindings: z.record(safeIdSchema, generationBindingStateSchema).default({})
}).strict();
export type MissionState = z.infer<typeof missionStateSchema>;

export const snapshotSchema = z.object({
  schema_version: z.literal(1),
  state: missionStateSchema,
  state_digest: digestSchema
}).strict();
export type Snapshot = z.infer<typeof snapshotSchema>;

export function parseArtifactEnvelope(input: unknown): ArtifactEnvelope {
  return parseWithSafety(artifactEnvelopeSchema, input, "artifact envelope");
}

export function parseProductionEvent(input: unknown): ProductionEvent {
  return parseWithSafety(productionEventSchema, input, "production event");
}

export function parseMissionState(input: unknown): MissionState {
  return parseWithSafety(missionStateSchema, input, "mission state");
}

export function parseSnapshot(input: unknown): Snapshot {
  return parseWithSafety(snapshotSchema, input, "snapshot");
}

export function validateSafeValue(value: unknown, context?: z.RefinementCtx, path = "payload"): void {
  try {
    assertSafeJsonValue(value, path);
  } catch (error) {
    if (context && error instanceof ProductionControlError) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: error.message, path: [path] });
      return;
    }
    throw error;
  }
}

function parseWithSafety<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  try {
    const parsed = schema.parse(input);
    assertSafeJsonValue(parsed, label);
    return parsed;
  } catch (error) {
    if (error instanceof ProductionControlError) throw error;
    throw pcError("PC_SCHEMA_INVALID", `invalid ${label}`);
  }
}
