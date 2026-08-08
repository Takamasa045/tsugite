/**
 * Opt-in dry-run / preflight helper for generation jobs.
 * Does not call run/render, update Gates, or submit billing when preflightOnly.
 */

import { sha256Canonical } from "../integrity/canonical.js";
import type { GenerationJobProviderAdapter } from "./adapter.js";
import { GenerationJobMachine } from "./machine.js";
import type { GenerationJobRecord, GenerationJobRequest } from "./schema.js";
import { GenerationJobStore } from "./store.js";
import { redactSecretsDeep } from "./secrets.js";

export type GenerationJobPreflightInput = {
  storeRoot: string;
  adapter: GenerationJobProviderAdapter;
  request: GenerationJobRequest;
  model_profile_digest: string;
  connection_capability_digest: string;
  pricing: GenerationJobRecord["pricing"];
  route_ok: boolean;
  mode_ok?: boolean;
  adapter_present: boolean;
  catalog_present_without_adapter?: boolean;
  transport?: unknown;
  now?: () => string;
  job_id?: string;
};

export type GenerationJobPreflightResult = {
  billing_action: false;
  generation_submitted: false;
  job: GenerationJobRecord;
  events: Awaited<ReturnType<GenerationJobStore["events"]>>;
  preflight_only: true;
};

/**
 * Plan a job in preflight-only mode. Never submits to a provider.
 */
export async function preflightGenerationJob(
  input: GenerationJobPreflightInput
): Promise<GenerationJobPreflightResult> {
  const store = new GenerationJobStore({
    rootDir: input.storeRoot,
    now: input.now
  });
  const machine = new GenerationJobMachine({
    store,
    adapter: input.adapter,
    transport: input.transport,
    now: input.now,
    preflightOnly: true
  });

  const job = await machine.plan({
    request: input.request,
    model_profile_digest: input.model_profile_digest,
    connection_capability_digest: input.connection_capability_digest,
    pricing: input.pricing,
    adapter_id: input.adapter.adapter_id,
    job_id: input.job_id,
    route_ok: input.route_ok,
    mode_ok: input.mode_ok,
    adapter_present: input.adapter_present,
    catalog_present_without_adapter: input.catalog_present_without_adapter
  });

  const events = await store.events(job.job_id);
  return {
    billing_action: false,
    generation_submitted: false,
    job: redactSecretsDeep(job) as GenerationJobRecord,
    events: redactSecretsDeep(events) as typeof events,
    preflight_only: true
  };
}

export function requestDigestFromParams(params: Record<string, unknown>): string {
  return sha256Canonical({ kind: "generation-job-request", params });
}
