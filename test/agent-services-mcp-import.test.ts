import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client";
import { describe, expect, it } from "vitest";

import {
  MCP_CLIENT_PUBLIC_EXPORT,
  MCP_STREAMABLE_HTTP_SIBLING,
  authorizeOnly,
  resolveMcpClientSiblingModuleUrl,
  type AgentServiceDefinition
} from "../src/agentServices/index.js";
import { AGENT_SERVICE_ISSUE_CODES } from "../src/agentServices/errors.js";

const ROOT = resolve(import.meta.dirname, "..");
const MCP_CLIENT_SOURCE = resolve(ROOT, "src/agentServices/mcpClient.ts");

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

describe("agent service MCP SDK import resolution (literal-* path safe)", () => {
  it("rejects reintroduction of wildcard package subpaths and relative node_modules internals", async () => {
    const source = await readFile(MCP_CLIENT_SOURCE, "utf8");

    // Root-cause imports: package exports "./*" corrupts a literal "*" in the host path.
    expect(source).not.toMatch(/@modelcontextprotocol\/sdk\/client\/index\.js/);
    expect(source).not.toMatch(/@modelcontextprotocol\/sdk\/client\/streamableHttp\.js/);
    expect(source).not.toMatch(/@modelcontextprotocol\/sdk\/client\/[A-Za-z0-9_./-]+/);

    // Package-manager layout must not be hardcoded (npm/pnpm/yarn path differences).
    expect(source).not.toMatch(/from\s+["'][^"']*node_modules[^"']*["']/);
    expect(source).not.toMatch(/from\s+["']\.\.?\/[^"']*@modelcontextprotocol[^"']*["']/);
    expect(source).not.toMatch(/dist\/esm\/client\/streamableHttp/);

    // Required: exact public Client export (not the wildcard subpath).
    expect(source).toMatch(/from\s+["']@modelcontextprotocol\/sdk\/client["']/);
    expect(source).toContain("import.meta.resolve");
    expect(source).toContain(MCP_STREAMABLE_HTTP_SIBLING);
  });

  it("resolves the streamableHttp sibling from the exact public ./client export", () => {
    expect(process.cwd(), "tests must run from the literal-* primary repo path").toContain("*");
    expect(MCP_CLIENT_PUBLIC_EXPORT).toBe("@modelcontextprotocol/sdk/client");
    expect(MCP_STREAMABLE_HTTP_SIBLING).toBe("streamableHttp.js");

    const clientUrl = import.meta.resolve(MCP_CLIENT_PUBLIC_EXPORT);
    expect(clientUrl.startsWith("file:")).toBe(true);
    expect(decodeURIComponent(new URL(clientUrl).pathname)).toMatch(
      /@modelcontextprotocol\/sdk\/.+\/client\/index\.js$/
    );

    const transportUrl = resolveMcpClientSiblingModuleUrl(MCP_STREAMABLE_HTTP_SIBLING);
    expect(transportUrl.startsWith("file:")).toBe(true);
    expect(decodeURIComponent(new URL(transportUrl).pathname)).toMatch(
      /@modelcontextprotocol\/sdk\/.+\/client\/streamableHttp\.js$/
    );
    // Sibling must stay next to the resolved client entry (same directory).
    expect(new URL("./", clientUrl).href).toBe(new URL("./", transportUrl).href);
  });

  it("fail-closes invalid sibling names before any import", () => {
    const rejected = [
      "",
      "streamableHttp.ts",
      "streamableHttp",
      "../streamableHttp.js",
      "foo/bar.js",
      "streamableHttp.js/../evil.js",
      "streamableHttp.js\0",
      "/absolute.js",
      ".hidden.js"
    ];
    for (const name of rejected) {
      expect(() => resolveMcpClientSiblingModuleUrl(name), name).toThrow(/invalid MCP client sibling/i);
    }
  });

  it("loads real Client + StreamableHTTP transport from this literal-* repo path", async () => {
    expect(process.cwd()).toContain("*");
    expect(typeof Client).toBe("function");

    // Vitest/Vite can mask package-export wildcards; prove the Node runtime failure
    // on this literal-* host path, plus exact-export + sibling URL success.
    const nodeProbe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          const wildcards = [
            "@modelcontextprotocol/sdk/client/index.js",
            "@modelcontextprotocol/sdk/client/streamableHttp.js"
          ];
          for (const spec of wildcards) {
            try {
              await import(spec);
              console.error("UNEXPECTED_OK", spec);
              process.exit(2);
            } catch (error) {
              if (error?.code !== "ERR_MODULE_NOT_FOUND") {
                console.error("UNEXPECTED_ERR", spec, error?.code, error?.message);
                process.exit(3);
              }
            }
          }
          const clientUrl = import.meta.resolve(${JSON.stringify(MCP_CLIENT_PUBLIC_EXPORT)});
          const transportUrl = new URL("./${MCP_STREAMABLE_HTTP_SIBLING}", clientUrl).href;
          const [{ Client }, transportMod] = await Promise.all([
            import(${JSON.stringify(MCP_CLIENT_PUBLIC_EXPORT)}),
            import(transportUrl)
          ]);
          if (typeof Client !== "function") process.exit(4);
          if (typeof transportMod.StreamableHTTPClientTransport !== "function") process.exit(5);
          const transport = new transportMod.StreamableHTTPClientTransport(new URL("https://example.com/mcp"));
          await transport.close();
          console.log("NODE_MCP_IMPORT_OK");
        `
      ],
      { cwd: ROOT, encoding: "utf8", timeout: 15_000 }
    );
    expect(nodeProbe.status, nodeProbe.stderr || nodeProbe.stdout).toBe(0);
    expect(nodeProbe.stdout).toContain("NODE_MCP_IMPORT_OK");

    const transportUrl = resolveMcpClientSiblingModuleUrl(MCP_STREAMABLE_HTTP_SIBLING);
    const mod = await import(transportUrl) as {
      StreamableHTTPClientTransport: new (url: URL) => { close(): Promise<void> };
    };
    expect(typeof mod.StreamableHTTPClientTransport).toBe("function");

    const client = new Client({ name: "tsugite-import-regression", version: "0.0.0" });
    const transport = new mod.StreamableHTTPClientTransport(new URL("https://example.com/mcp"));
    expect(client).toBeTruthy();
    expect(transport).toBeTruthy();
    await transport.close();
    await client.close();
  });

  it("preserves agent-service policy fail-closed boundaries without opening a session", () => {
    expect(() =>
      authorizeOnly({
        service: readOnlyService(),
        toolName: "undeclared_admin",
        arguments: {}
      })
    ).toThrow(
      expect.objectContaining({
        issues: [
          expect.objectContaining({
            code: AGENT_SERVICE_ISSUE_CODES.toolUndeclared
          })
        ]
      })
    );

    expect(() =>
      authorizeOnly({
        service: {
          ...readOnlyService(),
          tools: [
            {
              name: "submit_inquiry",
              policy: { action: "side_effect", approval: "required" }
            }
          ]
        },
        toolName: "submit_inquiry",
        arguments: {}
      })
    ).toThrow(
      expect.objectContaining({
        issues: [
          expect.objectContaining({
            code: AGENT_SERVICE_ISSUE_CODES.sideEffectBlocked
          })
        ]
      })
    );
  });
});
