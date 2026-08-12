/**
 * RevisionIntentV1 — single active revision intent from a critique artifact.
 * Critic may list many issues; only one active intent drives recovery scope.
 */
import { z } from "zod";
import { assertSafeJsonValue, sha256Canonical, withoutField } from "./canonical.js";
import { pcError } from "./errors.js";
import { digestSchema, safeIdSchema } from "./schema.js";
import type { GateDriftKind } from "./gateSubjects.js";

const nonNegativeInt = z.number().int().nonnegative();

export const REVISION_CHANGE_CLASSES = [
  "local-technical",
  "parameter-tune",
  "mutable-prompt-block",
  "visual-plan",
  "story",
  "identity",
  "music-timing",
  "lyrics-text",
  "lyrics-timing",
  "asset",
  "model-connection"
] as const;
export type RevisionChangeClass = (typeof REVISION_CHANGE_CLASSES)[number];

/** Change classes that may stay inside an explicit RegenerationPolicySpec. */
export const POLICY_ELIGIBLE_CHANGE_CLASSES: ReadonlySet<RevisionChangeClass> = new Set([
  "local-technical",
  "parameter-tune",
  "mutable-prompt-block"
]);

/** Change classes that always cascade Gate 1 when applied outside policy-exempt auth. */
export const GATE1_CASCADE_CHANGE_CLASSES: ReadonlySet<RevisionChangeClass> = new Set([
  "visual-plan",
  "story",
  "identity",
  "music-timing",
  "lyrics-text",
  "lyrics-timing",
  "asset",
  "model-connection"
]);

export const revisionIntentSchema = z
  .object({
    schema_version: z.literal(1),
    revision_intent_id: safeIdSchema,
    source_critique_artifact_id: safeIdSchema,
    target_node_id: safeIdSchema,
    change_class: z.enum(REVISION_CHANGE_CLASSES),
    changed_paths: z.array(z.string().min(1).max(500)).min(1).max(64),
    expected_stale_nodes: z.array(safeIdSchema).max(256),
    rationale: z.string().min(1).max(2_000),
    proposed_by: z.literal("critic"),
    digest: digestSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.changed_paths).size !== value.changed_paths.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["changed_paths"],
        message: "changed_paths must be unique"
      });
    }
    if (new Set(value.expected_stale_nodes).size !== value.expected_stale_nodes.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expected_stale_nodes"],
        message: "expected_stale_nodes must be unique"
      });
    }
    if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["digest"],
        message: "revision intent digest mismatch"
      });
    }
  });
export type RevisionIntent = z.infer<typeof revisionIntentSchema>;
export type RevisionIntentV1 = RevisionIntent;

export type RevisionIntentInput = Omit<RevisionIntent, "schema_version" | "digest" | "proposed_by"> & {
  proposed_by?: "critic";
};

export function createRevisionIntent(input: RevisionIntentInput): RevisionIntent {
  const candidate = {
    schema_version: 1 as const,
    revision_intent_id: input.revision_intent_id,
    source_critique_artifact_id: input.source_critique_artifact_id,
    target_node_id: input.target_node_id,
    change_class: input.change_class,
    changed_paths: [...input.changed_paths],
    expected_stale_nodes: [...input.expected_stale_nodes],
    rationale: input.rationale,
    proposed_by: "critic" as const
  };
  assertSafeJsonValue(candidate, "revision intent");
  return revisionIntentSchema.parse({
    ...candidate,
    digest: sha256Canonical(candidate)
  });
}

export function parseRevisionIntent(input: unknown): RevisionIntent {
  return revisionIntentSchema.parse(input);
}

/**
 * Only one active revision intent at a time. Selecting a new intent replaces
 * the previous selection; callers must not apply multiple intents concurrently.
 */
export function selectActiveRevisionIntent(input: {
  candidates: readonly RevisionIntent[];
  selected_revision_intent_id: string;
}): RevisionIntent {
  if (input.candidates.length === 0) {
    throw pcError("PC_REVISION_INTENT_INVALID", "no revision intent candidates");
  }
  const selected = input.candidates.find(
    (candidate) => candidate.revision_intent_id === input.selected_revision_intent_id
  );
  if (!selected) {
    throw pcError("PC_REVISION_INTENT_INVALID", "selected revision intent is not among candidates");
  }
  // Re-parse to reject tampered digests.
  return parseRevisionIntent(selected);
}

/**
 * Map a revision intent to Gate drift kinds for cascade evaluation.
 * Policy-exempt derived compilation must pass `policy_exempt_authorized: true`
 * with a live AttemptAuthorization — never inferred from change_class alone.
 */
export function gateDriftKindsForRevisionIntent(input: {
  intent: RevisionIntent;
  /** True only when a valid RegenerationAttemptAuthorization covers this intent. */
  policy_exempt_authorized?: boolean;
}): GateDriftKind[] {
  const intent = parseRevisionIntent(input.intent);
  if (input.policy_exempt_authorized === true && POLICY_ELIGIBLE_CHANGE_CLASSES.has(intent.change_class)) {
    return ["policy-exempt-derived-compilation"];
  }
  if (intent.change_class === "identity") {
    return ["identity-definition", "prompt", "compilation"];
  }
  if (intent.change_class === "model-connection") {
    return ["route", "price", "compilation"];
  }
  if (GATE1_CASCADE_CHANGE_CLASSES.has(intent.change_class)) {
    return ["prompt", "compilation"];
  }
  // local-technical / parameter-tune / mutable-prompt-block without policy auth → Gate1 cascade
  return ["prompt", "compilation"];
}

export function isPolicyEligibleRevisionIntent(intent: RevisionIntent): boolean {
  return POLICY_ELIGIBLE_CHANGE_CLASSES.has(parseRevisionIntent(intent).change_class);
}
