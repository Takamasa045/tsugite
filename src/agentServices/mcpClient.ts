// Exact export "./client" works. Subpaths like "./client/index.js" hit package
// exports "./*" and break when the repo path contains a literal "*" (Node
// substitutes the path segment). Resolve the public client export, then load
// its sibling ESM transport by URL — never via wildcard package subpaths or
// hardcoded node_modules/package-manager layout.
import { basename, dirname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client";
import {
  assertResolvedAddressesPublic,
  buildEndpointAllowlist,
  createAllowlistedFetch,
  validateRegistryEndpoint,
  type DnsResolver,
  type EndpointAllowlist,
  type SafeFetch
} from "./endpoint.js";
import {
  AGENT_SERVICE_ISSUE_CODES,
  agentServiceError,
  normalizeRemoteError
} from "./errors.js";
import {
  assertResultSize,
  authorizeToolCall,
  DEFAULT_ARGUMENTS_MAX_BYTES,
  DEFAULT_RESULT_MAX_BYTES,
  type ToolCallAuthorization
} from "./policy.js";
import type { AgentServiceDefinition } from "./registry.js";

/** Exact public package export for the MCP Client (not a "./*" subpath). */
const MCP_CLIENT_PUBLIC_EXPORT = "@modelcontextprotocol/sdk/client";

/** Basename of the Streamable HTTP client transport next to the resolved client entry. */
const MCP_STREAMABLE_HTTP_SIBLING = "streamableHttp.js";

const SAFE_MCP_CLIENT_SIBLING = /^[A-Za-z][A-Za-z0-9._-]*\.js$/;

/**
 * Convert a file: URL to a platform path. Fail-closed: never let URI/path
 * decode errors escape as unbounded URIError/TypeError.
 */
function fileUrlToLocalPath(url: URL, label: string): string {
  try {
    return fileURLToPath(url);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not a valid local file path: ${detail}`);
  }
}

function assertResolvedInsideMcpSdkClient(clientPath: string): void {
  const normalized = normalize(clientPath);
  const sdkMarker = `${sep}@modelcontextprotocol${sep}sdk${sep}`;
  if (!normalized.includes(sdkMarker)) {
    throw new Error(
      "MCP client export did not resolve inside the @modelcontextprotocol/sdk package"
    );
  }
  const clientMarker = `${sep}client${sep}`;
  if (!normalized.includes(clientMarker) || !normalized.endsWith(".js")) {
    throw new Error(`MCP client export resolved to an unexpected path: ${normalized}`);
  }
}

/**
 * Resolve a same-directory ESM sibling of the public `./client` export.
 * Fail-closed: only simple `*.js` basenames; must stay under the resolved
 * client directory inside `@modelcontextprotocol/sdk`.
 *
 * Exported for focused regression tests only — not re-exported from the public
 * `agentServices` barrel.
 */
export function resolveMcpClientSiblingModuleUrl(siblingFileName: string): string {
  if (!SAFE_MCP_CLIENT_SIBLING.test(siblingFileName)) {
    throw new Error(
      `invalid MCP client sibling module name: ${JSON.stringify(siblingFileName)}`
    );
  }

  let resolved: string;
  try {
    resolved = import.meta.resolve(MCP_CLIENT_PUBLIC_EXPORT);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to resolve MCP public client export ${MCP_CLIENT_PUBLIC_EXPORT}: ${detail}`
    );
  }

  let clientUrl: URL;
  try {
    clientUrl = new URL(resolved);
  } catch {
    throw new Error(`MCP client export resolved to an invalid URL: ${resolved}`);
  }

  if (clientUrl.protocol !== "file:") {
    throw new Error(
      `MCP client export must resolve to a file: URL (got ${clientUrl.protocol})`
    );
  }

  const clientPath = fileUrlToLocalPath(clientUrl, "MCP client export");
  assertResolvedInsideMcpSdkClient(clientPath);

  let siblingUrl: URL;
  try {
    siblingUrl = new URL(`./${siblingFileName}`, clientUrl);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to derive MCP client sibling URL: ${detail}`);
  }

  if (siblingUrl.protocol !== "file:") {
    throw new Error("MCP client sibling module must resolve to a file: URL");
  }

  const siblingPath = fileUrlToLocalPath(siblingUrl, "MCP client sibling module");
  const clientDirPath = dirname(clientPath);
  if (dirname(siblingPath) !== clientDirPath) {
    throw new Error("MCP client sibling module escapes the resolved client directory");
  }
  if (basename(siblingPath) !== siblingFileName) {
    throw new Error(
      `MCP client sibling module path mismatch: expected ${siblingFileName}, got ${basename(siblingPath)}`
    );
  }

  return siblingUrl.href;
}

type StreamableHTTPClientTransportConstructor = new (
  url: URL,
  opts?: {
    fetch?: typeof fetch;
    requestInit?: RequestInit;
    reconnectionOptions?: {
      initialReconnectionDelay?: number;
      maxReconnectionDelay?: number;
      reconnectionDelayGrowFactor?: number;
      maxRetries?: number;
    };
  }
) => RemoteMcpTransportLike;

type StreamableHttpTransportModule = {
  StreamableHTTPClientTransport?: StreamableHTTPClientTransportConstructor;
};

// Top-level await: Node 22 ESM + tsc NodeNext emit this as native TLA.
// Module evaluation completes before any export is used, so default factories
// stay synchronous after import.
const streamableHttpModule = (await import(
  resolveMcpClientSiblingModuleUrl(MCP_STREAMABLE_HTTP_SIBLING)
)) as StreamableHttpTransportModule;

if (typeof streamableHttpModule.StreamableHTTPClientTransport !== "function") {
  throw new Error(
    "MCP streamable HTTP transport module is missing StreamableHTTPClientTransport"
  );
}

const StreamableHTTPClientTransport = streamableHttpModule.StreamableHTTPClientTransport;

export const DEFAULT_MCP_TIMEOUT_MS = 30_000;
export const DEFAULT_MCP_CLEANUP_TIMEOUT_MS = 2_000;

export type ObservedRemoteTool = {
  name: string;
  description?: string;
  declared: boolean;
  callable: boolean;
  policy?: AgentServiceDefinition["tools"][number]["policy"];
};

export type BlockedByPolicyTool = {
  name: string;
  reason: string;
};

export type ListRemoteToolsResult = {
  service_id: string;
  network: true;
  network_attempted: true;
  billing_action: false;
  provider_usage_possible: true;
  remote_usage: true;
  observed_tools: ObservedRemoteTool[];
  declared_tools: AgentServiceDefinition["tools"];
  /** Remote tools that were never declared in the registry allowlist. */
  blocked_undeclared: string[];
  /** Declared tools that are non-callable under current policy (name + stable reason). */
  blocked_by_policy: BlockedByPolicyTool[];
};

export type CallRemoteToolResult = {
  service_id: string;
  tool: string;
  network: true;
  network_attempted: true;
  billing_action: false;
  provider_usage_possible: true;
  remote_usage: true;
  side_effect: false;
  human_gate: "not_required";
  result: unknown;
};

export type RemoteMcpTransportLike = {
  close(): Promise<void>;
};

export type RemoteMcpClientLike = {
  connect(transport: RemoteMcpTransportLike): Promise<void>;
  listTools(params?: unknown, options?: { timeout?: number; signal?: AbortSignal }): Promise<{
    tools: Array<{ name: string; description?: string }>;
  }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { timeout?: number; signal?: AbortSignal }
  ): Promise<unknown>;
  close(): Promise<void>;
};

export type RemoteMcpClientFactory = (info: {
  name: string;
  version: string;
}) => RemoteMcpClientLike;

export type RemoteMcpTransportFactory = (input: {
  endpoint: string;
  allowlist: EndpointAllowlist;
  signal?: AbortSignal;
  fetchImpl?: SafeFetch;
  dnsResolver?: DnsResolver;
}) => RemoteMcpTransportLike;

export type RemoteMcpSessionOptions = {
  service: AgentServiceDefinition;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  signal?: AbortSignal;
  /** Exact endpoint allowlist; defaults to the single service endpoint. */
  allowlist?: EndpointAllowlist;
  fetchImpl?: SafeFetch;
  dnsResolver?: DnsResolver;
  clientFactory?: RemoteMcpClientFactory;
  transportFactory?: RemoteMcpTransportFactory;
  argumentsMaxBytes?: number;
  resultMaxBytes?: number;
};

const defaultClientFactory: RemoteMcpClientFactory = ({ name, version }) =>
  new Client({ name, version }) as unknown as RemoteMcpClientLike;

const defaultTransportFactory: RemoteMcpTransportFactory = ({
  endpoint,
  allowlist,
  signal,
  fetchImpl,
  dnsResolver
}) => {
  const safeFetch = createAllowlistedFetch(allowlist, fetchImpl ?? fetch, {
    dnsResolver,
    // DNS is checked once before connect in withRemoteMcpSession; per-request
    // re-check remains available when callers use createAllowlistedFetch directly.
    skipDns: true
  });
  return new StreamableHTTPClientTransport(new URL(endpoint), {
    fetch: safeFetch as typeof fetch,
    requestInit: signal ? { signal } : undefined,
    // Keep reconnects bounded; session hard deadline still owns overall abort.
    reconnectionOptions: {
      initialReconnectionDelay: 50,
      maxReconnectionDelay: 250,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 0
    }
  }) as unknown as RemoteMcpTransportLike;
};

/**
 * Open a remote MCP session with a hard deadline covering connect/list/call/close.
 * Always creates an internal AbortController linked to any caller signal.
 */
export async function withRemoteMcpSession<T>(
  options: RemoteMcpSessionOptions,
  run: (client: RemoteMcpClientLike, signal: AbortSignal) => Promise<T>
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_MCP_CLEANUP_TIMEOUT_MS;
  const sessionController = new AbortController();
  const allowlist = options.allowlist
    ?? buildEndpointAllowlist([options.service.endpoint]);

  let callerAbortHandler: (() => void) | undefined;
  if (options.signal) {
    if (options.signal.aborted) {
      sessionController.abort();
    } else {
      callerAbortHandler = () => {
        sessionController.abort();
      };
      options.signal.addEventListener("abort", callerAbortHandler, { once: true });
    }
  }

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (!sessionController.signal.aborted) {
    deadlineTimer = setTimeout(() => {
      sessionController.abort();
    }, timeoutMs);
    deadlineTimer.unref?.();
  }

  const clientFactory = options.clientFactory ?? defaultClientFactory;
  const transportFactory = options.transportFactory ?? defaultTransportFactory;
  const client = clientFactory({
    name: "tsugite-agent-service",
    version: "0.8.0"
  });
  let transport: RemoteMcpTransportLike | undefined;

  try {
    if (sessionController.signal.aborted) {
      throw agentServiceError(
        AGENT_SERVICE_ISSUE_CODES.timeout,
        "remote request timed out"
      );
    }

    // Pre-connect: exact endpoint validation + DNS publicness check.
    const endpoint = validateRegistryEndpoint(options.service.endpoint);
    if (!allowlist.has(endpoint.canonical)) {
      throw agentServiceError(
        AGENT_SERVICE_ISSUE_CODES.endpointForbidden,
        "service endpoint is outside the registry exact-endpoint allowlist",
        "endpoint"
      );
    }
    await raceWithAbort(
      assertResolvedAddressesPublic(endpoint.hostname, options.dnsResolver),
      sessionController.signal
    );

    transport = transportFactory({
      endpoint: options.service.endpoint,
      allowlist,
      signal: sessionController.signal,
      fetchImpl: options.fetchImpl,
      dnsResolver: options.dnsResolver
    });

    // Hard deadline must win even when connect/run ignore AbortSignal.
    return await raceWithAbort(
      (async () => {
        await client.connect(transport!);
        if (sessionController.signal.aborted) {
          throw agentServiceError(
            AGENT_SERVICE_ISSUE_CODES.timeout,
            "remote request timed out"
          );
        }
        return run(client, sessionController.signal);
      })(),
      sessionController.signal
    );
  } catch (error) {
    throw normalizeToPipelineError(error);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (options.signal && callerAbortHandler) {
      options.signal.removeEventListener("abort", callerAbortHandler);
    }
    // Abort any remaining in-flight work, then best-effort close with a short bound.
    if (!sessionController.signal.aborted) {
      sessionController.abort();
    }
    await boundedCleanup(async () => {
      try {
        await client.close();
      } catch {
        // ignore close failures
      }
      if (transport) {
        try {
          await transport.close();
        } catch {
          // ignore close failures
        }
      }
    }, cleanupTimeoutMs);
  }
}

export async function listRemoteTools(
  options: RemoteMcpSessionOptions
): Promise<ListRemoteToolsResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  return withRemoteMcpSession(options, async (client, signal) => {
    const listed = await client.listTools(undefined, {
      timeout: timeoutMs,
      signal
    });
    const declaredNames = new Set(options.service.tools.map((tool) => tool.name));
    const observed: ObservedRemoteTool[] = (listed.tools ?? []).map((tool) => {
      const declared = declaredNames.has(tool.name);
      const policy = options.service.tools.find((item) => item.name === tool.name)?.policy;
      const callable = declared
        && policy?.action === "read_public_data"
        && policy.approval === "none";
      return {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        declared,
        callable,
        ...(policy ? { policy } : {})
      };
    });
    const blockedUndeclared = observed
      .filter((tool) => !tool.declared)
      .map((tool) => tool.name);
    const blockedByPolicy = observed
      .filter((tool) => tool.declared && !tool.callable)
      .map((tool) => ({
        name: tool.name,
        reason: blockedPolicyReason(tool.policy)
      }));
    assertResultSize(observed, options.resultMaxBytes ?? DEFAULT_RESULT_MAX_BYTES);
    return {
      service_id: options.service.id,
      network: true,
      network_attempted: true,
      billing_action: false,
      provider_usage_possible: true,
      remote_usage: true,
      observed_tools: observed,
      declared_tools: options.service.tools.map((tool) => ({
        name: tool.name,
        policy: { ...tool.policy }
      })),
      blocked_undeclared: blockedUndeclared,
      blocked_by_policy: blockedByPolicy
    };
  });
}

/** Stable reason for declared-but-non-callable tools in list results. */
export function blockedPolicyReason(
  policy?: AgentServiceDefinition["tools"][number]["policy"]
): string {
  if (!policy) return "missing_policy";
  if (policy.action === "side_effect") return "side_effect";
  if (policy.approval !== "none") return "approval_required";
  if (policy.action !== "read_public_data") return "action_not_allowed";
  return "policy_blocked";
}

export async function callRemoteTool(
  options: RemoteMcpSessionOptions & { toolName: string; arguments?: unknown }
): Promise<CallRemoteToolResult> {
  // Policy always runs before any connect/DNS/network.
  const authorization = authorizeToolCall({
    service: options.service,
    toolName: options.toolName,
    arguments: options.arguments,
    argumentsMaxBytes: options.argumentsMaxBytes ?? DEFAULT_ARGUMENTS_MAX_BYTES
  });

  const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  return withRemoteMcpSession(options, async (client, signal) => {
    let result: unknown;
    try {
      result = await client.callTool(
        {
          name: authorization.tool.name,
          arguments: authorization.arguments
        },
        undefined,
        {
          timeout: timeoutMs,
          signal
        }
      );
    } catch (error) {
      throw normalizeToPipelineError(error);
    }
    assertResultSize(result, options.resultMaxBytes ?? DEFAULT_RESULT_MAX_BYTES);
    return serializeCallResult(authorization, result);
  });
}

/**
 * Test/helper entry that runs policy authorization without opening a network
 * session.
 */
export function authorizeOnly(options: {
  service: AgentServiceDefinition;
  toolName: string;
  arguments?: unknown;
}): ToolCallAuthorization {
  return authorizeToolCall(options);
}

function serializeCallResult(
  authorization: ToolCallAuthorization,
  result: unknown
): CallRemoteToolResult {
  return {
    service_id: authorization.service.id,
    tool: authorization.tool.name,
    network: true,
    network_attempted: true,
    billing_action: false,
    provider_usage_possible: true,
    remote_usage: true,
    side_effect: false,
    human_gate: "not_required",
    result
  };
}

function normalizeToPipelineError(error: unknown): never {
  if (error && typeof error === "object" && "issues" in error) {
    throw error;
  }
  const issue = normalizeRemoteError(error);
  throw agentServiceError(issue.code, issue.message, issue.path);
}

async function boundedCleanup(work: () => Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Ensure session hard deadline aborts work that does not observe AbortSignal
 * (hung connect, ignored fetch, etc.).
 *
 * Always attaches resolve/reject handlers to `work`, even when `signal` is
 * already aborted, so a later rejection cannot become an unhandledRejection.
 * Settles at most once and always removes the abort listener.
 */
export function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = (): void => {
      settle(() => {
        reject(
          agentServiceError(AGENT_SERVICE_ISSUE_CODES.timeout, "remote request timed out")
        );
      });
    };

    // Attach before checking aborted so delayed rejects are always handled.
    work.then(
      (value) => {
        settle(() => resolve(value));
      },
      (error) => {
        settle(() => reject(error));
      }
    );

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
