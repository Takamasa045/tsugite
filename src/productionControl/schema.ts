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
  slot: z.enum(["assets", "identity", "music", "lyrics"]),
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
  effect: z.enum([
    "read",
    "propose",
    "local-write",
    "external-observe",
    "external-submit",
    "paid",
    "render",
    "gate"
  ]),
  dependencies: z.array(safeIdSchema).max(256),
  required_contract_fragments: z.array(contractFragmentRefSchema).max(256),
  required_artifacts: z.array(digestRefSchema).max(256),
  output_schema: safeIdSchema,
  risk_class: z.enum(["low", "medium", "high"]),
  invalidation_tags: z.array(safeIdSchema).max(64)
}).strict();
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
  if (new Set(candidateIds).size !== candidateIds.length || !candidateIds.includes(value.selected_artifact_ref.id)) {
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
}).strict();
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
export const effectSchema = z.enum([
  "read",
  "propose",
  "local-write",
  "external-observe",
  "external-submit",
  "paid",
  "render",
  "gate"
]);

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
  event("nodes-invalidated", invalidatedPayload),
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
  invalidated_node_ids: z.array(safeIdSchema).max(256)
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
