import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import * as mcpClient from "../src/agentServices/mcpClient.js";
import * as registry from "../src/agentServices/registry.js";

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

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TSUGITE_AGENT_SERVICES_REGISTRY;
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
      network_attempted: false,
      billing_action: false,
      provider_usage_possible: true,
      remote_usage: false,
      secret_values_exposed: false
    });
    expect(payload.services).toHaveLength(4);
    expect(payload.services.map((service: { id: string }) => service.id)).toContain("itopan-search");
    expect(listSpy).not.toHaveBeenCalled();
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("ignores TSUGITE_AGENT_SERVICES_REGISTRY env overrides", async () => {
    process.env.TSUGITE_AGENT_SERVICES_REGISTRY = "/tmp/does-not-exist-agent-registry.yaml";
    const loadSpy = vi.spyOn(registry, "listAgentServices");
    const { status, stdout } = await capture(["services", "--json"]);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.services).toHaveLength(4);
    // CLI must call listAgentServices without a custom path (bundled only).
    expect(loadSpy).toHaveBeenCalledWith();
  });

  it("lists remote tools for a service with network=true", async () => {
    vi.spyOn(mcpClient, "listRemoteTools").mockResolvedValue({
      service_id: "itopan-search",
      network: true,
      network_attempted: true,
      billing_action: false,
      provider_usage_possible: true,
      remote_usage: true,
      observed_tools: [
        {
          name: "search",
          declared: true,
          callable: true,
          policy: { action: "read_public_data", approval: "none" }
        },
        {
          name: "submit_inquiry",
          declared: true,
          callable: false,
          policy: { action: "side_effect", approval: "required" }
        },
        { name: "hidden_admin", declared: false, callable: false }
      ],
      declared_tools: [
        { name: "search", policy: { action: "read_public_data", approval: "none" } },
        { name: "submit_inquiry", policy: { action: "side_effect", approval: "required" } }
      ],
      blocked_undeclared: ["hidden_admin"],
      blocked_by_policy: [{ name: "submit_inquiry", reason: "side_effect" }]
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
      network_attempted: true,
      billing_action: false,
      provider_usage_possible: true,
      remote_usage: true,
      service: "itopan-search",
      blocked_undeclared: ["hidden_admin"],
      blocked_by_policy: [{ name: "submit_inquiry", reason: "side_effect" }]
    });
  });

  it("calls an allowlisted read-only tool and rejects unknown options / missing required flags", async () => {
    vi.spyOn(mcpClient, "callRemoteTool").mockImplementation(async (options) => ({
      service_id: options.service.id,
      tool: options.toolName,
      network: true,
      network_attempted: true,
      billing_action: false,
      provider_usage_possible: true,
      remote_usage: true,
      side_effect: false,
      human_gate: "not_required",
      result: { content: [{ type: "text", text: "ok" }] }
    }));

    const missing = await capture(["service-call", "--json"]);
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stderr)).toMatchObject({
      network: false,
      network_attempted: false
    });

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
      network_attempted: true,
      billing_action: false,
      provider_usage_possible: true,
      remote_usage: true,
      side_effect: false,
      human_gate: "not_required",
      service: "itopan-search",
      tool: "search"
    });
  });

  it("help lists agent service commands without approval-artifact unlock option", async () => {
    const { status, stdout } = await capture(["help", "--json"]);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout);
    const names = payload.commands.map((command: { name: string }) => command.name);
    expect(names).toEqual(expect.arrayContaining(["services", "service-tools", "service-call"]));

    const callHelp = await capture(["help", "service-call", "--json"]);
    expect(callHelp.status).toBe(0);
    const help = JSON.parse(callHelp.stdout);
    const optionNames = help.command_help.options.map((option: { name: string }) => option.name);
    expect(optionNames).toEqual(
      expect.arrayContaining(["--service", "--tool", "--arguments", "--json"])
    );
    expect(optionNames).not.toContain("--approval-artifact");
  });

  it("rejects side_effect tools with network_attempted=false and no unlock option", async () => {
    const sideEffectService = {
      id: "future-write",
      display_name: "Future Write",
      type: "mcp-remote" as const,
      transport: "streamable-http" as const,
      endpoint: "https://example.com/mcp",
      auth_kind: "none" as const,
      capabilities: ["inquiry.submit"],
      tools: [
        {
          name: "submit_inquiry",
          policy: { action: "side_effect" as const, approval: "required" as const }
        }
      ],
      endpoint_validated: {
        href: "https://example.com/mcp",
        origin: "https://example.com",
        host: "example.com",
        hostname: "example.com",
        port: "443",
        pathname: "/mcp",
        canonical: "https://example.com/mcp"
      }
    };

    vi.spyOn(registry, "resolveAgentService").mockResolvedValue(sideEffectService);
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
    const payload = JSON.parse(missing.stderr);
    expect(payload).toMatchObject({
      ok: false,
      command: "service-call",
      network: false,
      network_attempted: false,
      issues: [
        expect.objectContaining({
          code: expect.stringMatching(
            /agent_service\.(side_effect_blocked|human_gate_required|tool_write_like_blocked)/
          )
        })
      ]
    });
    // callRemoteTool may be invoked (policy inside) but must not connect; spy records call.
    if (callSpy.mock.calls.length > 0) {
      await expect(callSpy.mock.results[0]?.value).rejects.toBeTruthy();
    }

    const withArtifact = await capture([
      "service-call",
      "--service",
      "future-write",
      "--tool",
      "submit_inquiry",
      "--arguments",
      JSON.stringify({ message: "hi" }),
      "--approval-artifact",
      "/tmp/fake-approval.json",
      "--json"
    ]);
    expect(withArtifact.status).toBe(1);
    expect(JSON.parse(withArtifact.stderr).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "cli.option_unknown", path: "--approval-artifact" })
      ])
    );
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
