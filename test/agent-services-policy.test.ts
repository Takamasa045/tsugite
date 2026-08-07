import { describe, expect, it, vi } from "vitest";
import {
  AGENT_SERVICE_ISSUE_CODES,
  authorizeToolCall,
  callRemoteTool,
  looksWriteLikeToolName,
  type AgentServiceDefinition,
  type RemoteMcpClientLike
} from "../src/agentServices/index.js";
import { PipelineError } from "../src/types.js";

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

function sideEffectService(): AgentServiceDefinition {
  return {
    id: "future-write",
    display_name: "Future Write",
    type: "mcp-remote",
    transport: "streamable-http",
    endpoint: "https://example.com/mcp",
    auth_kind: "none",
    capabilities: ["inquiry.submit"],
    tools: [
      {
        name: "submit_inquiry",
        policy: { action: "side_effect", approval: "required" }
      },
      {
        name: "search",
        policy: { action: "read_public_data", approval: "none" }
      }
    ]
  };
}

function mockClient(callImpl?: RemoteMcpClientLike["callTool"]): RemoteMcpClientLike {
  let closed = false;
  return {
    async connect() {
      /* no-op */
    },
    async listTools() {
      return { tools: [{ name: "submit_inquiry" }, { name: "search" }] };
    },
    async callTool(params, schema, options) {
      if (closed) throw new Error("closed");
      if (callImpl) return callImpl(params, schema, options);
      return { content: [{ type: "text", text: "ok" }] };
    },
    async close() {
      closed = true;
    }
  };
}

describe("agent service policy (read-only MVP)", () => {
  it("allows approval=none read_public_data without any artifact", () => {
    const auth = authorizeToolCall({
      service: readOnlyService(),
      toolName: "search",
      arguments: { query: "hello" }
    });
    expect(auth.side_effect).toBe(false);
    expect(auth.billing_action).toBe(false);
    expect(auth.provider_usage_possible).toBe(true);
    expect(auth.human_gate).toBe("not_required");
  });

  it("always blocks side_effect tools before remote connect, even with fake artifacts", async () => {
    const service = sideEffectService();
    let connected = false;
    const client = mockClient(async () => {
      connected = true;
      return { ok: true };
    });
    const transportFactory = vi.fn(() => ({
      async close() {
        /* no-op */
      }
    }));

    expect(() =>
      authorizeToolCall({
        service,
        toolName: "submit_inquiry",
        arguments: { message: "please contact me" }
      })
    ).toThrow(PipelineError);

    await expect(
      callRemoteTool({
        service,
        toolName: "submit_inquiry",
        arguments: { message: "please contact me" },
        clientFactory: () => client,
        transportFactory
      })
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: AGENT_SERVICE_ISSUE_CODES.sideEffectBlocked })]
    });
    expect(connected).toBe(false);
    expect(transportFactory).not.toHaveBeenCalled();

    // No CLI-side artifact unlock path exists; even an unknown "artifact" field is ignored.
    await expect(
      callRemoteTool({
        service,
        toolName: "submit_inquiry",
        arguments: { message: "please contact me", approval_digest: "x".repeat(64) },
        clientFactory: () => client,
        transportFactory
      })
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: AGENT_SERVICE_ISSUE_CODES.sideEffectBlocked })]
    });
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it("blocks undeclared tools and write-like names before remote send", async () => {
    const service = sideEffectService();
    let called = false;
    const client = mockClient(async () => {
      called = true;
      return { ok: true };
    });
    const transportFactory = vi.fn(() => ({ async close() { /* no-op */ } }));

    await expect(
      callRemoteTool({
        service,
        toolName: "secret_write",
        arguments: {},
        clientFactory: () => client,
        transportFactory
      })
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: AGENT_SERVICE_ISSUE_CODES.toolUndeclared })]
    });
    expect(called).toBe(false);
    expect(transportFactory).not.toHaveBeenCalled();

    await expect(
      callRemoteTool({
        service,
        toolName: "send_message",
        arguments: {},
        clientFactory: () => client,
        transportFactory
      })
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: AGENT_SERVICE_ISSUE_CODES.toolUndeclared })]
    });
    expect(called).toBe(false);
  });

  it("classifies expanded write-like vocabulary", () => {
    expect(looksWriteLikeToolName("search")).toBe(false);
    expect(looksWriteLikeToolName("get_experience")).toBe(false);
    expect(looksWriteLikeToolName("plan_experience")).toBe(false);
    for (const name of [
      "send_message",
      "submit_inquiry",
      "purchase_item",
      "edit_profile",
      "drop_table",
      "grant_access",
      "revoke_token",
      "transfer_funds",
      "approve_request",
      "commit_change",
      "merge_branch"
    ]) {
      expect(looksWriteLikeToolName(name)).toBe(true);
    }
  });
});
