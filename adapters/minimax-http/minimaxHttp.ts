/**
 * MiniMax HTTP generation adapter (Phase C).
 *
 * Initial scope: MiniMax-H3 last-frame-only via injectable HTTPS transport.
 * Never performs live DNS/HTTP unless a real transport is injected by a
 * human-authorized path. Unit tests always inject a fake transport.
 *
 * Separate from minimax-direct (mmx CLI). No silent fallback.
 */

import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type {
  AdapterCancelResult,
  AdapterDownloadResult,
  AdapterPollResult,
  AdapterPreflightResult,
  AdapterSubmitResult,
  GenerationJobAdapterContext,
  GenerationJobProviderAdapter
} from "../../src/generationJobs/adapter.js";
import {
  DEFAULT_MAX_DOWNLOAD_BYTES,
  pinBytesAtomically
} from "../../src/generationJobs/download.js";
import type { GenerationJobRequest } from "../../src/generationJobs/schema.js";
import { redactSecretsDeep } from "../../src/generationJobs/secrets.js";

export const MINIMAX_HTTP_ADAPTER_ID = "minimax-http";
export const MINIMAX_HTTP_CONNECTION_ID = "minimax-http";
export const MINIMAX_HTTP_IR_MODEL = "minimax-h3";
export const MINIMAX_HTTP_PROVIDER_MODEL = "MiniMax-H3";
export const MINIMAX_HTTP_MODE = "last-frame";
export const MINIMAX_HTTP_AUTH_ENV = "MINIMAX_API_KEY";

/** Fixed HTTPS endpoint allowlist (host + path prefix). No open redirects. */
export const MINIMAX_HTTP_ALLOWLIST = Object.freeze([
  {
    host: "api.minimax.io",
    pathPrefixes: ["/v1/video_generation", "/v1/files", "/v1/query"]
  },
  {
    host: "api.minimaxi.com",
    pathPrefixes: ["/v1/video_generation", "/v1/files", "/v1/query"]
  }
] as const);

export const MINIMAX_HTTP_DEFAULT_TIMEOUT_MS = 30_000;
export const MINIMAX_HTTP_DEFAULT_POLL_INTERVAL_MS = 1_000;
export const MINIMAX_HTTP_DEFAULT_MAX_POLLS = 120;
export const MINIMAX_HTTP_DEFAULT_MAX_DOWNLOAD_BYTES = DEFAULT_MAX_DOWNLOAD_BYTES;

export type MinimaxHttpTransportRequest = {
  method: "GET" | "POST" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** When true, response must not follow redirects (adapter enforces). */
  redirect: "error";
};

export type MinimaxHttpTransportResponse = {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | string;
  /** Simulated network class for tests. */
  networkError?: "timeout" | "reset" | "dns" | "redirect";
};

export type MinimaxHttpTransport = {
  request(req: MinimaxHttpTransportRequest): Promise<MinimaxHttpTransportResponse>;
};

export type MinimaxHttpAdapterOptions = {
  /**
   * Pricing authority. Default unknown → preflight-only / blocked for submit paths
   * that require known price (machine enforces separately).
   */
  pricingStatus?: "known" | "unknown" | "not-applicable";
  /** When false (default), preflight reports execution_ready=false. */
  executionReady?: boolean;
  /** Cancel support flag; Phase C default false → fail-closed. */
  cancelSupported?: boolean;
  timeoutMs?: number;
  maxDownloadBytes?: number;
  /** Injected only in tests / authorized runners. */
  defaultTransport?: MinimaxHttpTransport;
};

export type MinimaxHttpError = {
  code: string;
  message: string;
  acceptance_possible?: boolean;
  retryable?: boolean;
  unsupported?: boolean;
};

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

export function assertAllowedHttpsUrl(urlString: string): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw Object.assign(new Error(`invalid url: ${urlString}`), { code: "MMXHTTP-E001" });
  }
  if (url.protocol !== "https:") {
    throw Object.assign(new Error("only https is allowed"), { code: "MMXHTTP-E002" });
  }
  if (url.username || url.password) {
    throw Object.assign(new Error("url userinfo is forbidden"), { code: "MMXHTTP-E003" });
  }
  const entry = MINIMAX_HTTP_ALLOWLIST.find((item) => item.host === url.hostname);
  if (!entry) {
    throw Object.assign(new Error(`host not allowlisted: ${url.hostname}`), { code: "MMXHTTP-E004" });
  }
  const pathOk = entry.pathPrefixes.some(
    (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)
  );
  if (!pathOk) {
    throw Object.assign(new Error(`path not allowlisted: ${url.pathname}`), { code: "MMXHTTP-E005" });
  }
  return url;
}

export function assertLastFrameOnlyRequest(request: GenerationJobRequest): void {
  if (request.model_id !== MINIMAX_HTTP_IR_MODEL) {
    throw Object.assign(
      new Error(
        `exact model required: expected ${MINIMAX_HTTP_IR_MODEL}, got '${request.model_id}'`
      ),
      { code: "MMXHTTP-E010" }
    );
  }
  if (request.mode !== MINIMAX_HTTP_MODE) {
    throw Object.assign(
      new Error(
        `mode '${request.mode}' unsupported on minimax-http (last-frame only; no T2V downgrade or first-frame attach)`
      ),
      { code: "MMXHTTP-E011" }
    );
  }
  const params = request.params ?? {};
  if (params.first_frame !== undefined || params.image !== undefined || params.firstFramePath !== undefined) {
    throw Object.assign(
      new Error("first_frame / image attachment is forbidden for last-frame-only"),
      { code: "MMXHTTP-E012" }
    );
  }
  if (params.duplicate_last_as_first === true) {
    throw Object.assign(
      new Error("same-image duplication as first+last is forbidden"),
      { code: "MMXHTTP-E013" }
    );
  }
}

function resolveTransport(ctx: GenerationJobAdapterContext, options: MinimaxHttpAdapterOptions): MinimaxHttpTransport {
  if (ctx.transport && typeof (ctx.transport as MinimaxHttpTransport).request === "function") {
    return ctx.transport as MinimaxHttpTransport;
  }
  if (options.defaultTransport) return options.defaultTransport;
  throw Object.assign(
    new Error("minimax-http requires an injected transport (live network is not used by default)"),
    { code: "MMXHTTP-E020" }
  );
}

function authHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  // Read env at call time; never log the value.
  const key = env[MINIMAX_HTTP_AUTH_ENV];
  if (!key) {
    // Still return Authorization placeholder structure only when present.
    return { "Content-Type": "application/json" };
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`
  };
}

function bodyToString(body: Uint8Array | string): string {
  return typeof body === "string" ? body : Buffer.from(body).toString("utf8");
}

function bodyToBytes(body: Uint8Array | string): Buffer {
  return typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
}

function parseJsonBody(body: Uint8Array | string): Record<string, unknown> {
  const text = bodyToString(body);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createMinimaxHttpAdapter(
  options: MinimaxHttpAdapterOptions = {}
): GenerationJobProviderAdapter {
  const pricingStatus = options.pricingStatus ?? "unknown";
  const executionReady = options.executionReady ?? false;
  const cancelSupported = options.cancelSupported ?? false;
  const timeoutMs = options.timeoutMs ?? MINIMAX_HTTP_DEFAULT_TIMEOUT_MS;
  const maxDownloadBytes = options.maxDownloadBytes ?? MINIMAX_HTTP_DEFAULT_MAX_DOWNLOAD_BYTES;

  const adapter: GenerationJobProviderAdapter = {
    adapter_id: MINIMAX_HTTP_ADAPTER_ID,
    connection_id: MINIMAX_HTTP_CONNECTION_ID,
    capabilities: {
      submit: true,
      poll: true,
      cancel: cancelSupported,
      download: true
    },

    async preflight(request, ctx): Promise<AdapterPreflightResult> {
      try {
        assertLastFrameOnlyRequest(request);
      } catch (error) {
        const err = error as Error & { code?: string };
        return {
          ok: false,
          code: err.code ?? "MMXHTTP-E011",
          message: err.message
        };
      }

      if (request.connection_id !== MINIMAX_HTTP_CONNECTION_ID) {
        return {
          ok: false,
          code: "MMXHTTP-E014",
          message: `connection '${request.connection_id}' is not minimax-http (no silent switch)`
        };
      }

      // Pricing unknown or execution not ready → preflight-only.
      const ready = executionReady && pricingStatus !== "unknown";
      return {
        ok: true,
        execution_ready: ready,
        reason: ready
          ? undefined
          : pricingStatus === "unknown"
            ? "pricing_status is unknown; preflight-only / blocked"
            : "adapter execution_ready is false",
        details: redactSecretsDeep({
          provider_model: MINIMAX_HTTP_PROVIDER_MODEL,
          mode: MINIMAX_HTTP_MODE,
          pricing_status: pricingStatus,
          auth_env_names: [MINIMAX_HTTP_AUTH_ENV],
          allowlist_hosts: MINIMAX_HTTP_ALLOWLIST.map((item) => item.host)
        }) as Record<string, unknown>
      };
    },

    async submit(request, ctx): Promise<AdapterSubmitResult> {
      try {
        assertLastFrameOnlyRequest(request);
      } catch (error) {
        const err = error as Error & { code?: string };
        return {
          ok: false,
          code: err.code ?? "MMXHTTP-E011",
          message: err.message,
          acceptance_possible: false
        };
      }

      const transport = resolveTransport(ctx, options);
      const url = "https://api.minimax.io/v1/video_generation";
      assertAllowedHttpsUrl(url);

      // Build body without secrets; last_frame path is local ref only.
      const payload = {
        model: MINIMAX_HTTP_PROVIDER_MODEL,
        prompt: typeof request.params.prompt === "string" ? request.params.prompt : "",
        last_frame: request.asset_paths[0] ?? request.params.last_frame_path ?? null,
        duration: request.params.duration ?? null,
        // Never attach first_frame.
      };

      const headers = authHeaders();
      // Strip Authorization from any durable projection (tests check redaction).
      void headers;

      try {
        const response = await transport.request({
          method: "POST",
          url,
          headers: authHeaders(),
          body: JSON.stringify(payload),
          timeoutMs,
          redirect: "error"
        });

        if (response.networkError === "timeout") {
          // Timeout after send may mean provider accepted the job.
          return {
            ok: false,
            code: "MMXHTTP-E030",
            message: "submit timed out after possible acceptance",
            acceptance_possible: true,
            retryable: false
          };
        }
        if (response.networkError === "redirect") {
          return {
            ok: false,
            code: "MMXHTTP-E031",
            message: "redirect rejected",
            acceptance_possible: false
          };
        }
        if (response.networkError) {
          return {
            ok: false,
            code: "MMXHTTP-E032",
            message: `network error: ${response.networkError}`,
            acceptance_possible: false,
            retryable: true
          };
        }

        if (response.status >= 200 && response.status < 300) {
          const json = parseJsonBody(response.body);
          const taskId =
            (typeof json.task_id === "string" && json.task_id)
            || (typeof json.job_id === "string" && json.job_id)
            || (typeof json.id === "string" && json.id);
          if (!taskId) {
            return {
              ok: false,
              code: "MMXHTTP-E033",
              message: "submit response missing task id",
              acceptance_possible: true
            };
          }
          return { ok: true, provider_job_id: taskId, accepted: true };
        }

        if (response.status >= 500) {
          return {
            ok: false,
            code: "MMXHTTP-E034",
            message: `submit failed with status ${response.status}`,
            acceptance_possible: true,
            retryable: false
          };
        }

        return {
          ok: false,
          code: "MMXHTTP-E035",
          message: `submit rejected with status ${response.status}`,
          acceptance_possible: false
        };
      } catch (error) {
        const err = error as Error & { code?: string };
        return {
          ok: false,
          code: err.code ?? "MMXHTTP-E036",
          message: err.message,
          acceptance_possible: /timeout|ECONNRESET|socket hang up/i.test(err.message)
        };
      }
    },

    async poll(providerJobId, ctx): Promise<AdapterPollResult> {
      const transport = resolveTransport(ctx, options);
      const url = `https://api.minimax.io/v1/query/video_generation?task_id=${encodeURIComponent(providerJobId)}`;
      assertAllowedHttpsUrl(url);
      try {
        const response = await transport.request({
          method: "GET",
          url,
          headers: authHeaders(),
          timeoutMs,
          redirect: "error"
        });
        if (response.networkError) {
          return {
            ok: false,
            code: "MMXHTTP-E040",
            message: `poll network error: ${response.networkError}`,
            retryable: true
          };
        }
        if (response.status < 200 || response.status >= 300) {
          return {
            ok: false,
            code: "MMXHTTP-E041",
            message: `poll status ${response.status}`,
            retryable: response.status >= 500
          };
        }
        const json = parseJsonBody(response.body);
        const statusRaw = String(json.status ?? json.task_status ?? "running").toLowerCase();
        if (statusRaw === "success" || statusRaw === "succeeded" || statusRaw === "completed") {
          return { ok: true, status: "succeeded" };
        }
        if (statusRaw === "failed" || statusRaw === "error") {
          return {
            ok: true,
            status: "failed",
            error: typeof json.error === "string" ? json.error : "provider failed"
          };
        }
        if (statusRaw === "cancelled" || statusRaw === "canceled") {
          return { ok: true, status: "cancelled" };
        }
        if (statusRaw === "queued" || statusRaw === "pending") {
          return { ok: true, status: "queued" };
        }
        return { ok: true, status: "running" };
      } catch (error) {
        return {
          ok: false,
          code: "MMXHTTP-E042",
          message: (error as Error).message,
          retryable: true
        };
      }
    },

    async cancel(providerJobId, ctx): Promise<AdapterCancelResult> {
      if (!cancelSupported) {
        return {
          ok: false,
          code: "MMXHTTP-E050",
          message: "cancel is not supported on minimax-http (Phase C)",
          unsupported: true
        };
      }
      const transport = resolveTransport(ctx, options);
      const url = `https://api.minimax.io/v1/video_generation/${encodeURIComponent(providerJobId)}`;
      assertAllowedHttpsUrl(url);
      const response = await transport.request({
        method: "DELETE",
        url,
        headers: authHeaders(),
        timeoutMs,
        redirect: "error"
      });
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, cancelled: true };
      }
      return {
        ok: false,
        code: "MMXHTTP-E051",
        message: `cancel failed with status ${response.status}`
      };
    },

    async download(providerJobId, destinationDir, ctx): Promise<AdapterDownloadResult> {
      const transport = resolveTransport(ctx, options);
      const url = `https://api.minimax.io/v1/files/retrieve?task_id=${encodeURIComponent(providerJobId)}`;
      assertAllowedHttpsUrl(url);
      try {
        const response = await transport.request({
          method: "GET",
          url,
          headers: authHeaders(),
          timeoutMs,
          redirect: "error"
        });
        if (response.networkError === "redirect") {
          return { ok: false, code: "MMXHTTP-E060", message: "redirect rejected" };
        }
        if (response.networkError) {
          return {
            ok: false,
            code: "MMXHTTP-E061",
            message: `download network error: ${response.networkError}`,
            retryable: true
          };
        }
        if (response.status < 200 || response.status >= 300) {
          return {
            ok: false,
            code: "MMXHTTP-E062",
            message: `download status ${response.status}`
          };
        }

        const headers = normalizeHeaders(response.headers);
        const contentLengthHeader = headers["content-length"];
        const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;
        if (contentLength != null && Number.isFinite(contentLength) && contentLength > maxDownloadBytes) {
          return {
            ok: false,
            code: "MMXHTTP-E063",
            message: `Content-Length ${contentLength} exceeds max ${maxDownloadBytes}`
          };
        }

        const bytes = bodyToBytes(response.body);
        if (bytes.byteLength > maxDownloadBytes) {
          return {
            ok: false,
            code: "MMXHTTP-E064",
            message: `download size ${bytes.byteLength} exceeds max ${maxDownloadBytes}`
          };
        }
        if (contentLength != null && Number.isFinite(contentLength) && contentLength !== bytes.byteLength) {
          return {
            ok: false,
            code: "MMXHTTP-E065",
            message: `size ${bytes.byteLength} does not match Content-Length ${contentLength}`
          };
        }

        // Optional provider-declared hash.
        const expectedSha =
          headers["x-content-sha256"]
          || (typeof (ctx.job.request.params.expected_sha256) === "string"
            ? (ctx.job.request.params.expected_sha256 as string)
            : undefined);

        const pinned = await pinBytesAtomically(destinationDir, bytes, {
          maxBytes: maxDownloadBytes,
          expectedSha256: expectedSha,
          relativeName: `minimax-http-${providerJobId}.mp4`
        });

        return {
          ok: true,
          absolute_path: pinned.absolute_path,
          sha256: pinned.sha256,
          byte_length: pinned.byte_length,
          content_type: headers["content-type"]
        };
      } catch (error) {
        const err = error as Error & { code?: string };
        return {
          ok: false,
          code: err.code ?? "MMXHTTP-E066",
          message: err.message
        };
      }
    }
  };

  return adapter;
}

/** Deterministic hash helper for tests (not a secret). */
export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function downloadFileName(providerJobId: string): string {
  return basename(join("minimax-http-", `${providerJobId}.mp4`));
}
