import { describe, expect, it } from "vitest";
import {
  AGENT_SERVICE_ISSUE_CODES,
  callRemoteTool,
  listRemoteTools,
  redactSensitive,
  withRemoteMcpSession,
  type AgentServiceDefinition,
  type RemoteMcpClientLike
} from "../src/agentServices/index.js";
import { DEFAULT_ARGUMENTS_MAX_BYTES, DEFAULT_RESULT_MAX_BYTES } from "../src/agentServices/policy.js";

function readOnlyService(): AgentServiceDefinition {
  return {
    id: "itopan-search",
    display_name: "itopan Search",
    type: "mcp-remote",
    transport: "streamable-http",
    endpoint: "https://724d49cd-2eaf-48d8-8363-20218c1ca177.search.ai.cloudflare.com/mcp",
    auth_kind: "none",
    capabilities: ["search.public"],
    tools: [
      {
        name: "search",
        policy: { action: "read_public_data", approval: "none" }
      }
    ]
  };
}

function mockClient(overrides: Partial<RemoteMcpClientLike> = {}): RemoteMcpClientLike & {
  state: { connected: boolean; closed: boolean; calls: string[] };
} {
  const state = { connected: false, closed: false, calls: [] as string[] };
  return {
    state,
    async connect() {
      state.connected = true;
      state.calls.push("connect");
    },
    async listTools() {
      state.calls.push("listTools");
      return {
        tools: [
          { name: "search", description: "public search" },
          { name: "admin_delete", description: "should be blocked" }
        ]
      };
    },
    async callTool(params) {
      state.calls.push(`callTool:${params.name}`);
      return { content: [{ type: "text", text: `query=${params.arguments?.query ?? ""}` }] };
    },
    async close() {
      state.closed = true;
      state.calls.push("close");
    },
    ...overrides
  };
}

describe("agent service remote MCP client", () => {
  it("connects, lists tools, marks undeclared tools blocked, and always closes", async () => {
    const client = mockClient();
    const result = await listRemoteTools({
      service: readOnlyService(),
      clientFactory: () => client,
      transportFactory: () => ({
        async close() {
          client.state.calls.push("transport.close");
        }
      })
    });

    expect(result.network).toBe(true);
    expect(result.billing_action).toBe(false);
    expect(result.observed_tools).toEqual([
      {
        name: "search",
        description: "public search",
        declared: true,
        callable: true,
        policy: { action: "read_public_data", approval: "none" }
      },
      {
        name: "admin_delete",
        description: "should be blocked",
        declared: false,
        callable: false
      }
    ]);
    expect(result.blocked_undeclared).toEqual(["admin_delete"]);
    expect(client.state.calls).toEqual([
      "connect",
      "listTools",
      "close",
      "transport.close"
    ]);
    expect(client.state.closed).toBe(true);
  });

  it("calls only allowlisted tools and closes after errors", async () => {
    const client = mockClient();
    const ok = await callRemoteTool({
      service: readOnlyService(),
      toolName: "search",
      arguments: { query: "AIエージェント" },
      clientFactory: () => client,
      transportFactory: () => ({
        async close() {
          client.state.calls.push("transport.close");
        }
      })
    });
    expect(ok.tool).toBe("search");
    expect(ok.approval_required).toBe(false);
    expect(ok.billing_action).toBe(false);
    expect(ok.result).toMatchObject({
      content: [{ type: "text", text: "query=AIエージェント" }]
    });

    const failing = mockClient({
      async callTool() {
        failing.state.calls.push("callTool:search");
        throw new Error("fetch failed https://secret.example/token=abc stack at foo.ts:1:2");
      }
    });
    await expect(
      callRemoteTool({
        service: readOnlyService(),
        toolName: "search",
        arguments: { query: "x" },
        clientFactory: () => failing,
        transportFactory: () => ({
          async close() {
            failing.state.calls.push("transport.close");
          }
        })
      })
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({
        code: expect.stringMatching(/agent_service\.(network|remote_error|timeout)/),
        message: expect.not.stringMatching(/secret\.example|token=abc|foo\.ts/)
      })]
    });
    expect(failing.state.calls).toContain("close");
    expect(failing.state.calls).toContain("transport.close");
  });

  it("enforces timeout/abort and argument/result size limits", async () => {
    const service = readOnlyService();
    await expect(
      callRemoteTool({
        service,
        toolName: "search",
        arguments: { query: "x".repeat(DEFAULT_ARGUMENTS_MAX_BYTES) },
        clientFactory: () => mockClient(),
        transportFactory: () => ({ async close() { /* no-op */ } })
      })
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: AGENT_SERVICE_ISSUE_CODES.argumentsTooLarge })]
    });

    const huge = mockClient({
      async callTool() {
        return { blob: "y".repeat(DEFAULT_RESULT_MAX_BYTES + 10) };
      }
    });
    await expect(
      callRemoteTool({
        service,
        toolName: "search",
        arguments: { query: "ok" },
        clientFactory: () => huge,
        transportFactory: () => ({ async close() { /* no-op */ } }),
        resultMaxBytes: DEFAULT_RESULT_MAX_BYTES
      })
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: AGENT_SERVICE_ISSUE_CODES.resultTooLarge })]
    });

    const controller = new AbortController();
    controller.abort();
    const aborted = mockClient({
      async listTools(_params, options) {
        if (options?.signal?.aborted) {
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }
        return { tools: [] };
      }
    });
    await expect(
      withRemoteMcpSession(
        {
          service,
          signal: controller.signal,
          clientFactory: () => aborted,
          transportFactory: () => ({ async close() { /* no-op */ } })
        },
        async (client) => client.listTools(undefined, { signal: controller.signal })
      )
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: AGENT_SERVICE_ISSUE_CODES.timeout })]
    });
  });

  it("redacts secrets and stacks from error text helpers", () => {
    const redacted = redactSensitive(
      "Authorization: Bearer super-secret-token https://evil.example/path at worker (/Users/me/app.ts:10:2)"
    );
    expect(redacted).not.toContain("super-secret-token");
    expect(redacted).not.toContain("evil.example");
    expect(redacted).not.toContain("/Users/me");
    expect(redacted).toContain("[redacted]");
  });

  it("closes the client in finally even when connect fails", async () => {
    const client = mockClient({
      async connect() {
        client.state.calls.push("connect");
        throw new Error("network down");
      }
    });
    await expect(
      withRemoteMcpSession(
        {
          service: readOnlyService(),
          clientFactory: () => client,
          transportFactory: () => ({
            async close() {
              client.state.calls.push("transport.close");
            }
          })
        },
        async () => "never"
      )
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: expect.stringMatching(/agent_service\./) })]
    });
    expect(client.state.calls).toEqual(["connect", "close", "transport.close"]);
  });
});
