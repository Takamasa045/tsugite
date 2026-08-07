import { describe, expect, it } from "vitest";
import {
  authorizeToolCall,
  callRemoteTool,
  createApprovalArtifact,
  createInMemoryApprovalStore,
  digestArguments,
  type AgentServiceDefinition,
  type RemoteMcpClientLike
} from "../src/agentServices/index.js";
import { PipelineError } from "../src/types.js";

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
      return { tools: [{ name: "submit_inquiry" }, { name: "search" }, { name: "secret_write" }] };
    },
    async callTool(params, _schema, _options) {
      if (closed) throw new Error("closed");
      if (callImpl) return callImpl(params, _schema, _options);
      return { content: [{ type: "text", text: "ok" }] };
    },
    async close() {
      closed = true;
    }
  };
}

describe("agent service human gate", () => {
  it("allows approval=none read_public_data without an artifact", () => {
    const auth = authorizeToolCall({
      service: sideEffectService(),
      toolName: "search",
      arguments: { query: "hello" }
    });
    expect(auth.approval_required).toBe(false);
    expect(auth.approval_verified).toBe(false);
    expect(auth.side_effect).toBe(false);
    expect(auth.billing_action).toBe(false);
  });

  it("fail-closes required tools without approval, with wrong tool/args, expired, or replayed artifacts", async () => {
    const service = sideEffectService();
    const args = { message: "please contact me" };
    const store = createInMemoryApprovalStore();
    const valid = createApprovalArtifact({
      serviceId: service.id,
      tool: "submit_inquiry",
      arguments: args,
      expiresAt: new Date(Date.now() + 60_000)
    });

    expect(() =>
      authorizeToolCall({
        service,
        toolName: "submit_inquiry",
        arguments: args
      })
    ).toThrow(PipelineError);

    expect(() =>
      authorizeToolCall({
        service,
        toolName: "submit_inquiry",
        arguments: args,
        approvalArtifact: { ...valid, tool: "search", approval_digest: valid.approval_digest },
        approvalStore: store
      })
    ).toThrow(PipelineError);

    const otherToolArtifact = createApprovalArtifact({
      serviceId: service.id,
      tool: "search",
      arguments: args,
      expiresAt: new Date(Date.now() + 60_000)
    });
    expect(() =>
      authorizeToolCall({
        service,
        toolName: "submit_inquiry",
        arguments: args,
        approvalArtifact: otherToolArtifact,
        approvalStore: store
      })
    ).toThrow(PipelineError);

    expect(() =>
      authorizeToolCall({
        service,
        toolName: "submit_inquiry",
        arguments: { message: "different" },
        approvalArtifact: valid,
        approvalStore: store
      })
    ).toThrow(PipelineError);

    const expired = createApprovalArtifact({
      serviceId: service.id,
      tool: "submit_inquiry",
      arguments: args,
      expiresAt: new Date(Date.now() - 1_000)
    });
    expect(() =>
      authorizeToolCall({
        service,
        toolName: "submit_inquiry",
        arguments: args,
        approvalArtifact: expired,
        approvalStore: store,
        now: new Date()
      })
    ).toThrow(PipelineError);

    const tampered = { ...valid, arguments_digest: digestArguments({ other: true }) };
    expect(() =>
      authorizeToolCall({
        service,
        toolName: "submit_inquiry",
        arguments: args,
        approvalArtifact: tampered,
        approvalStore: store
      })
    ).toThrow(PipelineError);

    // Correct approval executes exactly once through the remote client.
    let calls = 0;
    const client = mockClient(async () => {
      calls += 1;
      return { ok: true };
    });
    const first = await callRemoteTool({
      service,
      toolName: "submit_inquiry",
      arguments: args,
      approvalArtifact: valid,
      approvalStore: store,
      clientFactory: () => client,
      transportFactory: () => ({ async close() { /* no-op */ } })
    });
    expect(first.approval_verified).toBe(true);
    expect(first.side_effect).toBe(true);
    expect(calls).toBe(1);

    await expect(
      callRemoteTool({
        service,
        toolName: "submit_inquiry",
        arguments: args,
        approvalArtifact: valid,
        approvalStore: store,
        clientFactory: () => mockClient(async () => {
          calls += 1;
          return { ok: true };
        }),
        transportFactory: () => ({ async close() { /* no-op */ } })
      })
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "agent_service.approval_replay" })]
    });
    expect(calls).toBe(1);
  });

  it("blocks undeclared tools and write-like undeclared names before remote send", async () => {
    const service = sideEffectService();
    let called = false;
    const client = mockClient(async () => {
      called = true;
      return { ok: true };
    });

    await expect(
      callRemoteTool({
        service,
        toolName: "secret_write",
        arguments: {},
        clientFactory: () => client,
        transportFactory: () => ({ async close() { /* no-op */ } })
      })
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "agent_service.tool_undeclared" })]
    });
    expect(called).toBe(false);

    await expect(
      callRemoteTool({
        service,
        toolName: "send_message",
        arguments: {},
        clientFactory: () => client,
        transportFactory: () => ({ async close() { /* no-op */ } })
      })
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "agent_service.tool_undeclared" })]
    });
    expect(called).toBe(false);
  });

  it("does not accept a bare --yes style flag as approval", () => {
    const service = sideEffectService();
    expect(() =>
      authorizeToolCall({
        service,
        toolName: "submit_inquiry",
        arguments: { message: "x" },
        approvalArtifact: true
      })
    ).toThrow(PipelineError);
    expect(() =>
      authorizeToolCall({
        service,
        toolName: "submit_inquiry",
        arguments: { message: "x" },
        approvalArtifact: { yes: true }
      })
    ).toThrow(PipelineError);
  });
});
