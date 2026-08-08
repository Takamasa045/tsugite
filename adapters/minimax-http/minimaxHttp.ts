/**
 * MiniMax HTTP generation adapter (Phase C).
 *
 * Initial scope: MiniMax-H3 last-frame-only via injectable fixture-only transport.
 * Never performs live DNS/HTTP. No real HTTP client or DNS resolver is implemented.
 * Unit tests must inject a fixture transport with the explicit marker.
 *
 * Separate from minimax-direct (mmx CLI). No silent fallback.
 *
 * Future live integration (not Phase C) must add public-IP binding and DNS-rebinding
 * defenses before any real network transport is enabled. See docs/connections.md.
 */

import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
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

/** Explicit marker required on mock/fixture transports. Live network is never default. */
export const MINIMAX_HTTP_FIXTURE_TRANSPORT_MARKER = "tsugite.minimax-http.fixture-only" as const;

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
  /**
   * Required fixture marker. Without this, submit/poll/download stay blocked.
   * Production code must never set this on a live client (none is implemented).
   */
  [MINIMAX_HTTP_FIXTURE_TRANSPORT_MARKER]?: true;
};

export type MinimaxHttpAdapterOptions = {
  /**
   * Pricing authority. Default unknown → preflight-only / blocked for submit paths
   * that require known price (machine enforces separately).
   */
  pricingStatus?: "known" | "unknown" | "not-applicable";
  /**
   * Requested execution readiness. Public factory still requires an explicit
   * fixture-only transport marker before execution_ready can become true.
   * Passing executionReady=true alone never enables live submit.
   */
  executionReady?: boolean;
  /** Cancel support flag; Phase C default false → fail-closed. */
  cancelSupported?: boolean;
  timeoutMs?: number;
  maxDownloadBytes?: number;
  /**
   * Injected only in tests. Must carry FIXTURE marker to allow mock lifecycle.
   * There is no production HTTP transport in Phase C.
   */
  defaultTransport?: MinimaxHttpTransport;
  /**
   * Explicit opt-in that this adapter instance is for fixture/mock lifecycle only.
   * Required together with a marked fixture transport for submit.
   */
  allowFixtureTransport?: boolean;
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

function assertSafeAssetPath(path: string): void {
  if (
    !path
    || path.includes("\0")
    || path.includes("\\")
    || isAbsolute(path)
    || path.startsWith("/")
    || /^[A-Za-z]:/.test(path)
    || path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw Object.assign(new Error(`unsafe last-frame asset path: ${path}`), {
      code: "MMXHTTP-E015"
    });
  }
}

/**
 * MiniMax-H3 last-frame-only: exactly one last-frame asset required.
 * Rejects first-frame, duplicate, T2V, reference, unsafe paths.
 */
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
  if (params.reference !== undefined || params.references !== undefined) {
    throw Object.assign(
      new Error("reference assets are forbidden for last-frame-only"),
      { code: "MMXHTTP-E016" }
    );
  }

  // Exactly one last-frame asset: prefer asset_paths, else params.last_frame_path.
  const fromAssets = request.asset_paths ?? [];
  const fromParam =
    typeof params.last_frame_path === "string" && params.last_frame_path.length > 0
      ? [params.last_frame_path]
      : [];

  if (fromAssets.length > 1) {
    throw Object.assign(
      new Error("exactly one last-frame asset is required (duplicate asset_paths)"),
      { code: "MMXHTTP-E017" }
    );
  }

  const assets = fromAssets.length === 1 ? fromAssets : fromParam;
  if (assets.length !== 1) {
    throw Object.assign(
      new Error("exactly one last-frame asset is required"),
      { code: "MMXHTTP-E017" }
    );
  }
  assertSafeAssetPath(assets[0]!);
}

function isFixtureTransport(transport: unknown): transport is MinimaxHttpTransport {
  return Boolean(
    transport
    && typeof transport === "object"
    && typeof (transport as MinimaxHttpTransport).request === "function"
    && (transport as MinimaxHttpTransport)[MINIMAX_HTTP_FIXTURE_TRANSPORT_MARKER] === true
  );
}

function resolveFixtureTransport(
  ctx: GenerationJobAdapterContext,
  options: MinimaxHttpAdapterOptions
): MinimaxHttpTransport | null {
  if (isFixtureTransport(ctx.transport)) return ctx.transport;
  if (isFixtureTransport(options.defaultTransport)) return options.defaultTransport;
  return null;
}

function authHeadersPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  // Existence check only — never return or log the value.
  const key = env[MINIMAX_HTTP_AUTH_ENV];
  return typeof key === "string" && key.length > 0;
}

/** Headers for fixture transport only. Values never written to durable artifacts. */
function authHeadersForFixture(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const key = env[MINIMAX_HTTP_AUTH_ENV];
  if (!key) {
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

/**
 * Public production factory. Phase C is mock/preflight-only:
 * - executionReady=true alone does not enable live submit
 * - real HTTP client / DNS resolver is not implemented
 * - mock lifecycle requires explicit fixture transport marker + allowFixtureTransport
 */
export function createMinimaxHttpAdapter(
  options: MinimaxHttpAdapterOptions = {}
): GenerationJobProviderAdapter {
  const pricingStatus = options.pricingStatus ?? "unknown";
  const cancelSupported = options.cancelSupported ?? false;
  const timeoutMs = options.timeoutMs ?? MINIMAX_HTTP_DEFAULT_TIMEOUT_MS;
  const maxDownloadBytes = options.maxDownloadBytes ?? MINIMAX_HTTP_DEFAULT_MAX_DOWNLOAD_BYTES;
  const allowFixture = options.allowFixtureTransport === true;
  // Never treat as execution-ready without fixture opt-in + known pricing.
  const requestedReady = options.executionReady === true;

  const adapter: GenerationJobProviderAdapter = {
    adapter_id: MINIMAX_HTTP_ADAPTER_ID,
    connection_id: MINIMAX_HTTP_CONNECTION_ID,
    capabilities: {
      // Profile / catalog may advertise surface; Phase C still blocks live submit.
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

      const fixtureTransport = resolveFixtureTransport(ctx, options);
      const fixtureOk = allowFixture && fixtureTransport !== null;
      const authOk = authHeadersPresent() || fixtureOk; // fixture tests may omit real key
      const pricingOk = pricingStatus !== "unknown";

      // execution_ready only when: requested, fixture mode, transport marked, pricing known.
      // Public factory with executionReady=true alone stays blocked.
      const ready = requestedReady && fixtureOk && pricingOk && authOk;

      let reason: string | undefined;
      if (!ready) {
        if (!pricingOk) reason = "pricing_status is unknown; preflight-only / blocked";
        else if (!fixtureOk) {
          reason =
            "Phase C minimax-http is preflight-only; fixture-only transport marker required (no live HTTP)";
        } else if (!authOk) reason = "auth env not confirmed";
        else if (!requestedReady) reason = "adapter execution_ready is false";
        else reason = "adapter not execution-ready";
      }

      return {
        ok: true,
        execution_ready: ready,
        reason,
        details: redactSecretsDeep({
          provider_model: MINIMAX_HTTP_PROVIDER_MODEL,
          mode: MINIMAX_HTTP_MODE,
          pricing_status: pricingStatus,
          auth_env_names: [MINIMAX_HTTP_AUTH_ENV],
          allowlist_hosts: MINIMAX_HTTP_ALLOWLIST.map((item) => item.host),
          phase: "C-preflight-only",
          live_http: false
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

      if (pricingStatus === "unknown") {
        return {
          ok: false,
          code: "MMXHTTP-E021",
          message: "pricing unknown; submit blocked",
          acceptance_possible: false
        };
      }

      if (!allowFixture) {
        return {
          ok: false,
          code: "MMXHTTP-E020",
          message:
            "minimax-http Phase C refuses submit without allowFixtureTransport (no live HTTP client)",
          acceptance_possible: false
        };
      }

      const transport = resolveFixtureTransport(ctx, options);
      if (!transport) {
        return {
          ok: false,
          code: "MMXHTTP-E020",
          message:
            "minimax-http requires an explicit fixture-only transport marker (live network is not implemented)",
          acceptance_possible: false
        };
      }

      const url = "https://api.minimax.io/v1/video_generation";
      assertAllowedHttpsUrl(url);

      const lastFrame =
        request.asset_paths[0]
        ?? (typeof request.params.last_frame_path === "string"
          ? request.params.last_frame_path
          : null);

      const payload = {
        model: MINIMAX_HTTP_PROVIDER_MODEL,
        prompt: typeof request.params.prompt === "string" ? request.params.prompt : "",
        last_frame: lastFrame,
        duration: request.params.duration ?? null
      };

      try {
        const response = await transport.request({
          method: "POST",
          url,
          headers: authHeadersForFixture(),
          body: JSON.stringify(payload),
          timeoutMs,
          redirect: "error"
        });

        if (response.networkError === "timeout") {
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
      const transport = resolveFixtureTransport(ctx, options);
      if (!transport || !allowFixture) {
        return {
          ok: false,
          code: "MMXHTTP-E020",
          message: "poll requires fixture-only transport (no live HTTP)",
          retryable: false
        };
      }
      const url = `https://api.minimax.io/v1/query/video_generation?task_id=${encodeURIComponent(providerJobId)}`;
      assertAllowedHttpsUrl(url);
      try {
        const response = await transport.request({
          method: "GET",
          url,
          headers: authHeadersForFixture(),
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
      const transport = resolveFixtureTransport(ctx, options);
      if (!transport || !allowFixture) {
        return {
          ok: false,
          code: "MMXHTTP-E020",
          message: "cancel requires fixture-only transport"
        };
      }
      const url = `https://api.minimax.io/v1/video_generation/${encodeURIComponent(providerJobId)}`;
      assertAllowedHttpsUrl(url);
      const response = await transport.request({
        method: "DELETE",
        url,
        headers: authHeadersForFixture(),
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
      const transport = resolveFixtureTransport(ctx, options);
      if (!transport || !allowFixture) {
        return {
          ok: false,
          code: "MMXHTTP-E020",
          message: "download requires fixture-only transport (no live HTTP)"
        };
      }
      const url = `https://api.minimax.io/v1/files/retrieve?task_id=${encodeURIComponent(providerJobId)}`;
      assertAllowedHttpsUrl(url);
      try {
        const response = await transport.request({
          method: "GET",
          url,
          headers: authHeadersForFixture(),
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

        const expectedSha =
          headers["x-content-sha256"]
          || (typeof ctx.job.request.params.expected_sha256 === "string"
            ? (ctx.job.request.params.expected_sha256 as string)
            : undefined);

        const safeName = downloadFileName(providerJobId);
        const pinned = await pinBytesAtomically(destinationDir, bytes, {
          maxBytes: maxDownloadBytes,
          expectedSha256: expectedSha,
          relativeName: safeName
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

/** Safe download file name under artifacts dir (no path separators). */
export function downloadFileName(providerJobId: string): string {
  const safe = providerJobId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  return `minimax-http-${safe || "artifact"}.mp4`;
}

/** Mark a transport as fixture-only for Phase C tests. */
export function asFixtureTransport(transport: {
  request(req: MinimaxHttpTransportRequest): Promise<MinimaxHttpTransportResponse>;
}): MinimaxHttpTransport {
  return {
    ...transport,
    [MINIMAX_HTTP_FIXTURE_TRANSPORT_MARKER]: true
  };
}
