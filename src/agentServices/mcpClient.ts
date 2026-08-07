import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  buildHostAllowlist,
  createAllowlistedFetch,
  type HostAllowlist,
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
import type { ApprovalConsumptionStore } from "./approval.js";

export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

export type ObservedRemoteTool = {
  name: string;
  description?: string;
  declared: boolean;
  callable: boolean;
  policy?: AgentServiceDefinition["tools"][number]["policy"];
};

export type ListRemoteToolsResult = {
  service_id: string;
  network: true;
  billing_action: false;
  observed_tools: ObservedRemoteTool[];
  declared_tools: AgentServiceDefinition["tools"];
  blocked_undeclared: string[];
};

export type CallRemoteToolResult = {
  service_id: string;
  tool: string;
  network: true;
  billing_action: false;
  side_effect: boolean;
  approval_required: boolean;
  approval_verified: boolean;
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
  allowlist: HostAllowlist;
  signal?: AbortSignal;
  fetchImpl?: SafeFetch;
}) => RemoteMcpTransportLike;

export type RemoteMcpSessionOptions = {
  service: AgentServiceDefinition;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Host allowlist; defaults to the single service endpoint host. */
  allowlist?: HostAllowlist;
  fetchImpl?: SafeFetch;
  clientFactory?: RemoteMcpClientFactory;
  transportFactory?: RemoteMcpTransportFactory;
  argumentsMaxBytes?: number;
  resultMaxBytes?: number;
  approvalStore?: ApprovalConsumptionStore;
  now?: Date;
  approvalArtifact?: unknown;
};

const defaultClientFactory: RemoteMcpClientFactory = ({ name, version }) =>
  new Client({ name, version }) as unknown as RemoteMcpClientLike;

const defaultTransportFactory: RemoteMcpTransportFactory = ({
  endpoint,
  allowlist,
  signal,
  fetchImpl
}) => {
  const safeFetch = createAllowlistedFetch(allowlist, fetchImpl ?? fetch);
  return new StreamableHTTPClientTransport(new URL(endpoint), {
    fetch: safeFetch as typeof fetch,
    requestInit: signal ? { signal } : undefined
  }) as unknown as RemoteMcpTransportLike;
};

export async function withRemoteMcpSession<T>(
  options: RemoteMcpSessionOptions,
  run: (client: RemoteMcpClientLike) => Promise<T>
): Promise<T> {
  const allowlist = options.allowlist
    ?? buildHostAllowlist([options.service.endpoint]);
  const clientFactory = options.clientFactory ?? defaultClientFactory;
  const transportFactory = options.transportFactory ?? defaultTransportFactory;
  const client = clientFactory({
    name: "tsugite-agent-service",
    version: "0.8.0"
  });
  const transport = transportFactory({
    endpoint: options.service.endpoint,
    allowlist,
    signal: options.signal,
    fetchImpl: options.fetchImpl
  });

  try {
    await client.connect(transport);
    return await run(client);
  } catch (error) {
    throw normalizeToPipelineError(error);
  } finally {
    try {
      await client.close();
    } catch {
      // ignore close failures
    }
    try {
      await transport.close();
    } catch {
      // ignore close failures
    }
  }
}

export async function listRemoteTools(
  options: RemoteMcpSessionOptions
): Promise<ListRemoteToolsResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  return withRemoteMcpSession(options, async (client) => {
    const listed = await client.listTools(undefined, {
      timeout: timeoutMs,
      signal: options.signal
    });
    const declaredNames = new Set(options.service.tools.map((tool) => tool.name));
    const observed: ObservedRemoteTool[] = (listed.tools ?? []).map((tool) => {
      const declared = declaredNames.has(tool.name);
      const policy = options.service.tools.find((item) => item.name === tool.name)?.policy;
      return {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        declared,
        callable: declared,
        ...(policy ? { policy } : {})
      };
    });
    const blocked = observed.filter((tool) => !tool.declared).map((tool) => tool.name);
    assertResultSize(observed, options.resultMaxBytes ?? DEFAULT_RESULT_MAX_BYTES);
    return {
      service_id: options.service.id,
      network: true,
      billing_action: false,
      observed_tools: observed,
      declared_tools: options.service.tools.map((tool) => ({
        name: tool.name,
        policy: { ...tool.policy }
      })),
      blocked_undeclared: blocked
    };
  });
}

export async function callRemoteTool(
  options: RemoteMcpSessionOptions & { toolName: string; arguments?: unknown }
): Promise<CallRemoteToolResult> {
  const authorization = authorizeToolCall({
    service: options.service,
    toolName: options.toolName,
    arguments: options.arguments,
    approvalArtifact: options.approvalArtifact,
    approvalStore: options.approvalStore,
    now: options.now,
    argumentsMaxBytes: options.argumentsMaxBytes ?? DEFAULT_ARGUMENTS_MAX_BYTES
  });

  const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  return withRemoteMcpSession(options, async (client) => {
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
          signal: options.signal
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
 * session. Used by unit tests that inject a mock transport only for success paths.
 */
export function authorizeOnly(options: {
  service: AgentServiceDefinition;
  toolName: string;
  arguments?: unknown;
  approvalArtifact?: unknown;
  approvalStore?: ApprovalConsumptionStore;
  now?: Date;
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
    billing_action: false,
    side_effect: authorization.side_effect,
    approval_required: authorization.approval_required,
    approval_verified: authorization.approval_verified,
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
