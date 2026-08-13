/**
 * Provider-neutral adapter contract for durable generation jobs.
 * Implementations live under adapters/; core never imports provider modules.
 */

import type { GenerationJobRecord, GenerationJobRequest } from "./schema.js";

export type GenerationJobAdapterCapabilities = {
  submit: boolean;
  poll: boolean;
  cancel: boolean;
  download: boolean;
};

export type AdapterPreflightResult =
  | {
      ok: true;
      /** When false, machine must stay blocked/preflight-only. */
      execution_ready: boolean;
      reason?: string;
      details?: Record<string, unknown>;
    }
  | {
      ok: false;
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };

export type AdapterSubmitResult =
  | {
      ok: true;
      provider_job_id: string;
      /** When true, acceptance is confirmed. */
      accepted: true;
    }
  | {
      ok: false;
      code: string;
      message: string;
      /**
       * When true, request may have been accepted by the provider but the
       * client lost the response → status must become submission_unknown.
       * Automatic resubmit is forbidden.
       */
      acceptance_possible: boolean;
      retryable?: boolean;
    };

export type AdapterPollResult =
  | { ok: true; status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; error?: string }
  | { ok: false; code: string; message: string; retryable?: boolean };

export type AdapterCancelResult =
  | { ok: true; cancelled: boolean }
  | { ok: false; code: string; message: string; unsupported?: boolean };

export type AdapterDownloadResult =
  | {
      ok: true;
      /** Absolute path written under the job-controlled destination root. */
      absolute_path: string;
      sha256: string;
      byte_length: number;
      content_type?: string;
    }
  | { ok: false; code: string; message: string; retryable?: boolean };

export type GenerationJobAdapterContext = {
  job: GenerationJobRecord;
  /**
   * Optional injectable clock / RNG for tests.
   */
  now?: () => string;
  /**
   * Opaque transport injection for tests (mock HTTP, etc.).
   * Core never interprets this.
   */
  transport?: unknown;
  /**
   * Active-mode T05 same-FD submission input. When present, adapters must read
   * assets via readExecutionSubmissionAsset and must not reopen request asset paths.
   * Legacy/disabled/shadow submits leave this undefined.
   */
  submission_input?: unknown;
};

/**
 * Provider adapter interface. Connection ids and models are opaque strings
 * from the caller's perspective; adapters enforce exact routes.
 */
export type GenerationJobProviderAdapter = {
  /** Stable adapter implementation id (matches connection capability adapter_id). */
  adapter_id: string;
  /** Connection id this adapter serves. No silent switching. */
  connection_id: string;
  capabilities: GenerationJobAdapterCapabilities;
  preflight(
    request: GenerationJobRequest,
    ctx: GenerationJobAdapterContext
  ): Promise<AdapterPreflightResult>;
  submit(
    request: GenerationJobRequest,
    ctx: GenerationJobAdapterContext
  ): Promise<AdapterSubmitResult>;
  poll(providerJobId: string, ctx: GenerationJobAdapterContext): Promise<AdapterPollResult>;
  cancel?(
    providerJobId: string,
    ctx: GenerationJobAdapterContext
  ): Promise<AdapterCancelResult>;
  download(
    providerJobId: string,
    destinationDir: string,
    ctx: GenerationJobAdapterContext
  ): Promise<AdapterDownloadResult>;
};

export type AdapterRegistry = {
  resolve(connectionId: string): GenerationJobProviderAdapter | undefined;
};
