export type AdapterErrorEnvelope = {
  schema_version: 1;
  kind: "tsugite.adapter-error";
  code: string;
  phase: string;
  submission_state: "not_submitted" | "accepted" | "unknown" | "failed";
  recovery_action: string;
  request_id?: string;
};
export function adapterErrorEnvelope(code: string, requestId?: string): AdapterErrorEnvelope;
export function parseAdapterErrorEnvelope(text: string, requestId: string): AdapterErrorEnvelope | undefined;
export function describeAdapterError(code: string): string;
