import { randomUUID } from "node:crypto";
import { sha256Canonical, withoutField } from "./canonical.js";
import { pcError } from "./errors.js";
import {
  digestSchema,
  parseProductionEvent,
  productionEventSchema,
  type EventPayload,
  type ProductionEvent,
  type ProductionEventType,
  ZERO_DIGEST
} from "./schema.js";

export type NewProductionEvent<T extends ProductionEventType = ProductionEventType> = {
  type: T;
  production_id: string;
  payload: EventPayload<T>;
  event_id?: string;
  sequence?: number;
  previous_event_digest?: string;
  payload_digest?: string;
  created_at?: string;
  coordinator_instance_id?: string;
  event_digest?: string;
};

/** Build and verify a strict event record without any side effect. */
export function makeProductionEvent<T extends ProductionEventType>(
  input: NewProductionEvent<T>
): Extract<ProductionEvent, { type: T }> {
  assertEventInputKeys(input);
  const payloadDigest = sha256Canonical(input.payload);
  if (input.payload_digest !== undefined && input.payload_digest !== payloadDigest) {
    throw pcError("PC_EVENT_TAMPERED", "event payload digest mismatch");
  }
  const candidate = {
    schema_version: 1 as const,
    event_id: input.event_id ?? randomUUID(),
    production_id: input.production_id,
    sequence: input.sequence ?? 1,
    previous_event_digest: input.previous_event_digest ?? ZERO_DIGEST,
    payload_digest: payloadDigest,
    created_at: input.created_at ?? new Date().toISOString(),
    coordinator_instance_id: input.coordinator_instance_id ?? "coordinator",
    type: input.type,
    payload: input.payload,
    event_digest: "0".repeat(64)
  };
  const parsedWithoutDigest = parseProductionEvent(candidate);
  const expectedDigest = computeEventDigest(parsedWithoutDigest);
  const event = { ...parsedWithoutDigest, event_digest: expectedDigest };
  const parsed = parseProductionEvent(event);
  if (input.event_digest !== undefined && input.event_digest !== parsed.event_digest) {
    throw pcError("PC_EVENT_TAMPERED", "event digest mismatch");
  }
  return parsed as Extract<ProductionEvent, { type: T }>;
}

function assertEventInputKeys(input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw pcError("PC_SCHEMA_INVALID", "event input must be an object");
  }
  const allowed = new Set([
    "type", "production_id", "payload", "event_id", "sequence",
    "previous_event_digest", "payload_digest", "created_at",
    "coordinator_instance_id", "event_digest", "schema_version"
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw pcError("PC_SCHEMA_INVALID", "event input contains an unknown field");
  }
  if ("schema_version" in input && (input as { schema_version?: unknown }).schema_version !== 1) {
    throw pcError("PC_SCHEMA_INVALID", "unsupported event schema version");
  }
}

export function computeEventDigest(event: ProductionEvent): string {
  const withoutDigest = withoutField(event, "event_digest");
  return sha256Canonical(withoutDigest);
}

export function computePayloadDigest(event: Pick<ProductionEvent, "payload">): string {
  return sha256Canonical(event.payload);
}

export function assertEventIntegrity(event: ProductionEvent): void {
  const parsed = parseProductionEvent(event);
  const payloadDigest = computePayloadDigest(parsed);
  if (payloadDigest !== parsed.payload_digest) {
    throw pcError("PC_EVENT_TAMPERED", "event payload digest mismatch");
  }
  const digest = computeEventDigest(parsed);
  if (digest !== parsed.event_digest) {
    throw pcError("PC_EVENT_TAMPERED", "event digest mismatch");
  }
  digestSchema.parse(parsed.event_digest);
  productionEventSchema.parse(parsed);
}
