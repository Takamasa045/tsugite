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
