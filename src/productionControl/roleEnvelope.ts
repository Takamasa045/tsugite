import { z } from "zod";
import { assertSafeJsonValue, sha256Canonical, withoutField } from "./canonical.js";
import { pcError } from "./errors.js";
import { effectSchema, digestSchema, safeIdSchema } from "./schema.js";
import { assertKnownRole, roleIdSchema, type RoleId } from "./taskTreeTemplates.js";

const authoritySchema = z.object({
  state_write: z.literal("coordinator-only"),
  gate_write: z.literal("coordinator-only"),
  external_submit: z.boolean(),
  paid_execution: z.boolean()
}).strict();

export const roleEnvelopeSchema = z.object({
  schema_version: z.literal(1),
  envelope_id: safeIdSchema,
  production_id: safeIdSchema,
  node_id: safeIdSchema,
  attempt_id: safeIdSchema,
  role: roleIdSchema,
  effect: effectSchema,
  input_schema: safeIdSchema,
  output_schema: safeIdSchema,
  input: z.unknown(),
  input_digest: digestSchema,
  output: z.unknown(),
  output_digest: digestSchema,
  authority: authoritySchema,
  created_at: z.string().datetime({ offset: true }),
  envelope_digest: digestSchema
}).strict().superRefine((envelope, context) => {
  try {
    assertSafeJsonValue(envelope.input, "role envelope input");
    assertSafeJsonValue(envelope.output, "role envelope output");
  } catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["input"], message: error instanceof Error ? error.message : "unsafe role envelope payload" });
  }
  if (sha256Canonical(envelope.input) !== envelope.input_digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["input_digest"], message: "input digest mismatch" });
  }
  if (sha256Canonical(envelope.output) !== envelope.output_digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["output_digest"], message: "output digest mismatch" });
  }
  if (envelope.authority.state_write !== "coordinator-only" || envelope.authority.gate_write !== "coordinator-only") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["authority"], message: "roles cannot write coordinator state or gates" });
  }
  const expected = sha256Canonical(withoutField(envelope, "envelope_digest"));
  if (expected !== envelope.envelope_digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["envelope_digest"], message: "role envelope digest mismatch" });
  }
});
export type RoleEnvelope = z.infer<typeof roleEnvelopeSchema>;
export type RoleEnvelopeV1 = RoleEnvelope;

const ROLE_EFFECTS: Record<RoleId, readonly z.infer<typeof effectSchema>[]> = {
  coordinator: ["read", "propose", "local-write", "external-observe", "external-submit", "paid", "render", "gate"],
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

export function assertRoleEffect(role: string, effect: z.infer<typeof effectSchema>): void {
  assertKnownRole(role);
  if (!ROLE_EFFECTS[role].includes(effect)) {
    throw pcError("PC_ROLE_FORBIDDEN", `role '${role}' cannot declare effect '${effect}'`);
  }
}

export function createRoleEnvelope(input: {
  envelope_id: string;
  production_id: string;
  node_id: string;
  attempt_id: string;
  role: string;
  effect: z.infer<typeof effectSchema>;
  input_schema: string;
  output_schema: string;
  input: unknown;
  output: unknown;
  created_at?: string;
}): RoleEnvelope {
  assertRoleEffect(input.role, input.effect);
  safeIdSchema.parse(input.input_schema);
  safeIdSchema.parse(input.output_schema);
  assertSafeJsonValue(input.input, "role envelope input");
  assertSafeJsonValue(input.output, "role envelope output");
  const base = {
    schema_version: 1 as const,
    envelope_id: input.envelope_id,
    production_id: input.production_id,
    node_id: input.node_id,
    attempt_id: input.attempt_id,
    role: input.role,
    effect: input.effect,
    input_schema: input.input_schema,
    output_schema: input.output_schema,
    input: input.input,
    input_digest: sha256Canonical(input.input),
    output: input.output,
    output_digest: sha256Canonical(input.output),
    authority: {
      state_write: "coordinator-only" as const,
      gate_write: "coordinator-only" as const,
      external_submit: input.effect === "external-submit" || input.effect === "paid",
      paid_execution: input.effect === "paid"
    },
    created_at: input.created_at ?? new Date(0).toISOString()
  };
  return roleEnvelopeSchema.parse({ ...base, envelope_digest: sha256Canonical(base) });
}

export function roleEnvelopeDigest(envelope: RoleEnvelope): string {
  const parsed = roleEnvelopeSchema.parse(envelope);
  const { envelope_digest: digest, ...base } = parsed;
  if (sha256Canonical(base) !== digest) throw pcError("PC_ROLE_FORBIDDEN", "role envelope digest mismatch");
  return digest;
}
