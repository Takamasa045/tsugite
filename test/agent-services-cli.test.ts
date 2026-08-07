import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import {
  createApprovalArtifact,
  type RemoteMcpClientLike
} from "../src/agentServices/index.js";
import * as mcpClient from "../src/agentServices/mcpClient.js";

async function capture(args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const status = await main(args);
  const stdout = log.mock.calls.map((call) => String(call[0])).join("\n");
  const stderr = error.mock.calls.map((call) => String(call[0])).join("\n");
  log.mockRestore();
  error.mockRestore();
  return { status, stdout, stderr };
}

function mockClient(result: unknown = { ok: true }): RemoteMcpClientLike {
  return {
    async connect() { /* no-op */ },
    async listTools() {
      return {
        tools: [
          { name: "search", description: "public" },
          { name: "hidden_admin", description: "blocked" }
        ]
      };
    },
    async callTool(params) {
      return { echo: params };
    },
    async close() { /* no-op */ }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent service CLI", () => {
  it("lists registry services without network", async () => {
    const listSpy = vi.spyOn(mcpClient, "listRemoteTools");
    const callSpy = vi.spyOn(mcpClient, "callRemoteTool");
    const { status, stdout } = await capture(["services", "--json"]);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload).toMatchObject({
      ok: true,
      command: "services",
      network: false,
      billing_action: false,
      secret_values_exposed: false
    });
    expect(payload.services).toHaveLength(4);
    expect(payload.services.map((service: { id: string }) => service.id)).toContain("itopan-search");
    expect(listSpy).not.toHaveBeenCalled();
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("lists remote tools for a service with network=true", async () => {
    vi.spyOn(mcpClient, "listRemoteTools").mockResolvedValue({
      service_id: "itopan-search",
      network: true,
      billing_action: false,
      observed_tools: [
        {
          name: "search",
          declared: true,
          callable: true,
          policy: { action: "read_public_data", approval: "none" }
        },
        { name: "hidden_admin", declared: false, callable: false }
      ],
      declared_tools: [{ name: "search", policy: { action: "read_public_data", approval: "none" } }],
      blocked_undeclared: ["hidden_admin"]
    });

    const { status, stdout } = await capture([
      "service-tools",
      "--service",
      "itopan-search",
      "--json"
    ]);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload).toMatchObject({
      ok: true,
      command: "service-tools",
      network: true,
      billing_action: false,
      service: "itopan-search",
      blocked_undeclared: ["hidden_admin"]
    });
  });

  it("calls an allowlisted read-only tool and rejects unknown options / missing required flags", async () => {
    vi.spyOn(mcpClient, "callRemoteTool").mockImplementation(async (options) => ({
      service_id: options.service.id,
      tool: options.toolName,
      network: true,
      billing_action: false,
      side_effect: false,
      approval_required: false,
      approval_verified: false,
      result: { content: [{ type: "text", text: "ok" }] }
    }));

    const missing = await capture(["service-call", "--json"]);
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stderr).issues.some((issue: { code: string }) =>
      issue.code.includes("service") || issue.code.includes("cli.")
    )).toBe(true);

    const unknown = await capture([
      "service-call",
      "--service",
      "itopan-search",
      "--tool",
      "search",
      "--url",
      "--json"
    ]);
    expect(unknown.status).toBe(1);
    expect(JSON.parse(unknown.stderr).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "cli.option_unknown", path: "--url" })
      ])
    );

    const ok = await capture([
      "service-call",
      "--service",
      "itopan-search",
      "--tool",
      "search",
      "--arguments",
      JSON.stringify({ query: "AIエージェント" }),
      "--json"
    ]);
    expect(ok.status).toBe(0);
    const payload = JSON.parse(ok.stdout);
    expect(payload).toMatchObject({
      ok: true,
      command: "service-call",
      network: true,
      billing_action: false,
      side_effect: false,
      approval_required: false,
      approval_decision: "not_required",
      service: "itopan-search",
      tool: "search"
    });
  });

  it("help lists the new agent service commands", async () => {
    const { status, stdout } = await capture(["help", "--json"]);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout);
    const names = payload.commands.map((command: { name: string }) => command.name);
    expect(names).toEqual(expect.arrayContaining(["services", "service-tools", "service-call"]));

    const callHelp = await capture(["help", "service-call", "--json"]);
    expect(callHelp.status).toBe(0);
    const help = JSON.parse(callHelp.stdout);
    expect(help.command_help.options.map((option: { name: string }) => option.name)).toEqual(
      expect.arrayContaining(["--service", "--tool", "--arguments", "--approval-artifact", "--json"])
    );
  });

  it("rejects service-call when required approval artifact is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-agent-cli-"));
    const registryPath = join(root, "registry.yaml");
    await writeFile(registryPath, `
schema_version: 1
services:
  - id: future-write
    display_name: Future Write
    type: mcp-remote
    transport: streamable-http
    endpoint: https://example.com/mcp
    auth_kind: none
    capabilities: [inquiry.submit]
    tools:
      - name: submit_inquiry
        policy: { action: side_effect, approval: required }
`, "utf8");

    const previous = process.env.TSUGITE_AGENT_SERVICES_REGISTRY;
    process.env.TSUGITE_AGENT_SERVICES_REGISTRY = registryPath;
    try {
      const callSpy = vi.spyOn(mcpClient, "callRemoteTool");
      const missing = await capture([
        "service-call",
        "--service",
        "future-write",
        "--tool",
        "submit_inquiry",
        "--arguments",
        JSON.stringify({ message: "hi" }),
        "--json"
      ]);
      expect(missing.status).toBe(1);
      expect(JSON.parse(missing.stderr)).toMatchObject({
        ok: false,
        command: "service-call",
        issues: [expect.objectContaining({ code: "agent_service.approval_required" })]
      });
      // Policy rejects before remote invocation when callRemoteTool is used;
      // either the CLI preflight or the client path may surface the issue.
      if (callSpy.mock.calls.length > 0) {
        // If delegated, the client itself must still fail closed.
        await expect(callSpy.mock.results[0]?.value).rejects.toBeTruthy();
      }

      const artifact = createApprovalArtifact({
        serviceId: "future-write",
        tool: "submit_inquiry",
        arguments: { message: "hi" },
        expiresAt: new Date(Date.now() + 60_000)
      });
      const artifactPath = join(root, "approval.json");
      await writeFile(artifactPath, JSON.stringify(artifact), "utf8");

      callSpy.mockResolvedValue({
        service_id: "future-write",
        tool: "submit_inquiry",
        network: true,
        billing_action: false,
        side_effect: true,
        approval_required: true,
        approval_verified: true,
        result: { ok: true }
      });

      const approved = await capture([
        "service-call",
        "--service",
        "future-write",
        "--tool",
        "submit_inquiry",
        "--arguments",
        JSON.stringify({ message: "hi" }),
        "--approval-artifact",
        artifactPath,
        "--json"
      ]);
      expect(approved.status).toBe(0);
      expect(JSON.parse(approved.stdout)).toMatchObject({
        ok: true,
        approval_required: true,
        approval_decision: "verified",
        side_effect: true
      });
    } finally {
      if (previous === undefined) delete process.env.TSUGITE_AGENT_SERVICES_REGISTRY;
      else process.env.TSUGITE_AGENT_SERVICES_REGISTRY = previous;
    }
  });

  it("never accepts arbitrary endpoint URL flags", async () => {
    const listed = await capture([
      "services",
      "--endpoint",
      "https://evil.example/mcp",
      "--json"
    ]);
    expect(listed.status).toBe(1);
    expect(JSON.parse(listed.stderr).issues[0].code).toBe("cli.option_unknown");
  });
});
