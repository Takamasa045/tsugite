import { describe, expect, it } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import {
  AGENT_SERVICE_ISSUE_CODES,
  callRemoteTool,
  listRemoteTools,
  withRemoteMcpSession,
  type AgentServiceDefinition
} from "../src/agentServices/index.js";

const ENDPOINT = "https://724d49cd-2eaf-48d8-8363-20218c1ca177.search.ai.cloudflare.com/mcp";

function readOnlyService(): AgentServiceDefinition {
  return {
    id: "itopan-search",
    display_name: "itopan Search",
    type: "mcp-remote",
    transport: "streamable-http",
    endpoint: ENDPOINT,
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

type MockMode =
  | "ok"
  | "hang-initialize"
  | "infinite-sse"
  | "redirect";

/**
 * Minimal Streamable HTTP MCP mock for official SDK Client transport.
 * Speaks JSON-RPC over POST and optional GET SSE.
 */
function createMockMcpFetch(mode: MockMode): typeof fetch {
  return async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(ENDPOINT)) {
      return new Response("forbidden", { status: 403 });
    }

    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

    if (method === "GET") {
      if (mode === "infinite-sse") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Never enqueues end; session abort must cancel.
            controller.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
          },
          cancel() {
            /* aborted */
          }
        });
        return new Response(stream, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "mcp-session-id": "sess-infinite"
          }
        });
      }
      // Servers may omit standalone SSE.
      return new Response(null, { status: 405 });
    }

    if (method === "DELETE") {
      return new Response(null, { status: 405 });
    }

    if (method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    if (mode === "redirect") {
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/mcp" }
      });
    }

    if (mode === "hang-initialize") {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
          return;
        }
        // Still hang if no signal; session raceWithAbort covers that path.
        signal?.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true }
        );
      });
    }

    const rawBody = init?.body
      ? String(init.body)
      : input instanceof Request
        ? await input.clone().text()
        : "{}";
    const message = JSON.parse(rawBody) as {
      jsonrpc?: string;
      id?: string | number;
      method?: string;
      params?: Record<string, unknown>;
    };

    if (message.method === "initialize") {
      return jsonRpc(message.id, {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "mock-agent-service", version: "1.0.0" }
      }, { "mcp-session-id": "sess-ok" });
    }

    if (message.method === "notifications/initialized") {
      return new Response(null, { status: 202, headers: { "mcp-session-id": "sess-ok" } });
    }

    if (message.method === "tools/list") {
      return jsonRpc(message.id, {
        tools: [
          {
            name: "search",
            description: "public search",
            inputSchema: { type: "object", properties: { query: { type: "string" } } }
          },
          {
            name: "hidden_admin",
            description: "should stay non-callable",
            inputSchema: { type: "object" }
          }
        ]
      });
    }

    if (message.method === "tools/call") {
      const name = String(message.params?.name ?? "");
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      return jsonRpc(message.id, {
        content: [{ type: "text", text: `echo:${name}:${String(args.query ?? "")}` }]
      });
    }

    return jsonRpc(message.id, {}, undefined, {
      code: -32601,
      message: `Method not found: ${message.method}`
    });
  };
}

function jsonRpc(
  id: string | number | undefined,
  result: unknown,
  headers?: Record<string, string>,
  error?: { code: number; message: string }
): Response {
  const body = error
    ? { jsonrpc: "2.0", id: id ?? null, error }
    : { jsonrpc: "2.0", id: id ?? null, result };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "mcp-session-id": "sess-ok",
      ...headers
    }
  });
}

const publicDns = async () => ["1.1.1.1"] as const;

describe("agent service official SDK + mock fetch integration", () => {
  it("initializes, lists, and calls through real Client+StreamableHTTPClientTransport", async () => {
    const fetchImpl = createMockMcpFetch("ok");
    const listed = await listRemoteTools({
      service: readOnlyService(),
      fetchImpl,
      dnsResolver: publicDns,
      timeoutMs: 2_000
    });
    expect(listed.network_attempted).toBe(true);
    expect(listed.observed_tools.some((tool) => tool.name === "search" && tool.callable)).toBe(true);
    expect(listed.observed_tools.some((tool) => tool.name === "hidden_admin" && !tool.callable)).toBe(true);

    const called = await callRemoteTool({
      service: readOnlyService(),
      toolName: "search",
      arguments: { query: "hello" },
      fetchImpl,
      dnsResolver: publicDns,
      timeoutMs: 2_000
    });
    expect(called.result).toMatchObject({
      content: [{ type: "text", text: "echo:search:hello" }]
    });
    expect(called.provider_usage_possible).toBe(true);
    expect(called.billing_action).toBe(false);
  });

  it("times out hung initialize within a short threshold", async () => {
    const started = Date.now();
    await expect(
      withRemoteMcpSession(
        {
          service: readOnlyService(),
          fetchImpl: createMockMcpFetch("hang-initialize"),
          dnsResolver: publicDns,
          timeoutMs: 80,
          cleanupTimeoutMs: 40
        },
        async () => "never"
      )
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({
        code: expect.stringMatching(/agent_service\.(timeout|network|remote_error)/)
      })]
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("aborts infinite SSE-style streams via session deadline", async () => {
    // After initialize the transport may open GET SSE. Hold the session open
    // until the hard deadline aborts the shared signal (SSE cancel included).
    const started = Date.now();
    await expect(
      withRemoteMcpSession(
        {
          service: readOnlyService(),
          fetchImpl: createMockMcpFetch("infinite-sse"),
          dnsResolver: publicDns,
          timeoutMs: 100,
          cleanupTimeoutMs: 50
        },
        async (_client, signal) =>
          new Promise((_resolve, reject) => {
            if (signal.aborted) {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true }
            );
          })
      )
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({
        code: expect.stringMatching(/agent_service\.(timeout|network|remote_error)/)
      })]
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("fails closed on HTTP 302 without following redirects", async () => {
    await expect(
      withRemoteMcpSession(
        {
          service: readOnlyService(),
          fetchImpl: createMockMcpFetch("redirect"),
          dnsResolver: publicDns,
          timeoutMs: 1_000
        },
        async () => "never"
      )
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: AGENT_SERVICE_ISSUE_CODES.endpointRedirect })]
    });
  });
});
