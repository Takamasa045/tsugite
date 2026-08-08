import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client";
import { afterEach, describe, expect, it } from "vitest";

import { authorizeOnly, type AgentServiceDefinition } from "../src/agentServices/index.js";
import * as agentServicesPublic from "../src/agentServices/index.js";
import { AGENT_SERVICE_ISSUE_CODES } from "../src/agentServices/errors.js";
// Internal resolver hooks: not part of the public agentServices surface.
import { resolveMcpClientSiblingModuleUrl } from "../src/agentServices/mcpClient.js";

const ROOT = resolve(import.meta.dirname, "..");
const MCP_CLIENT_SOURCE = resolve(ROOT, "src/agentServices/mcpClient.ts");
const BUILT_MCP_CLIENT = resolve(ROOT, "build/agentServices/mcpClient.js");

/** Exact public package export used by production code (not a "./*" subpath). */
const MCP_CLIENT_PUBLIC_EXPORT = "@modelcontextprotocol/sdk/client";
/** Sibling transport basename next to the resolved client entry. */
const MCP_STREAMABLE_HTTP_SIBLING = "streamableHttp.js";

/** Temp roots created by this file; cleaned in afterEach only. */
const tempRootsToClean: string[] = [];

afterEach(() => {
  while (tempRootsToClean.length > 0) {
    const root = tempRootsToClean.pop();
    if (!root) continue;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort; do not fail the suite on cleanup races
    }
  }
});

/**
 * Bounded fixture whose package-resolution path contains a literal "*".
 * Symlinks the repo node_modules so raw Node + --preserve-symlinks keeps the
 * star path (without it, Node realpaths out of the fixture).
 */
function createLiteralStarPackageFixture(): { fixtureRoot: string; projectDir: string } {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "tsugite-mcp-star-"));
  tempRootsToClean.push(fixtureRoot);

  // Segment name forces a literal "*" into every resolved package URL under this tree.
  const projectDir = join(fixtureRoot, "host*path");
  mkdirSync(projectDir, { recursive: true });

  const realNodeModules = realpathSync(join(ROOT, "node_modules"));
  symlinkSync(realNodeModules, join(projectDir, "node_modules"), "dir");

  if (!projectDir.includes("*")) {
    throw new Error("fixture project path must contain a literal *");
  }
  return { fixtureRoot, projectDir };
}

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
  it("does not expand the public agentServices API with internal resolver hooks", () => {
    expect(agentServicesPublic).not.toHaveProperty("resolveMcpClientSiblingModuleUrl");
    expect(agentServicesPublic).not.toHaveProperty("MCP_CLIENT_PUBLIC_EXPORT");
    expect(agentServicesPublic).not.toHaveProperty("MCP_STREAMABLE_HTTP_SIBLING");
  });

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
    expect(source).toContain("fileURLToPath");
  });

  it("resolves the streamableHttp sibling from the exact public ./client export", () => {
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
      ".hidden.js",
      "streamableHttp.js?",
      "streamableHttp.js#x",
      "streamableHttp%2ejs"
    ];
    for (const name of rejected) {
      expect(() => resolveMcpClientSiblingModuleUrl(name), name).toThrow(
        /invalid MCP client sibling/i
      );
    }
  });

  it("raw Node: literal-* package path corrupts wildcard imports; exact client + sibling succeeds", () => {
    const { projectDir } = createLiteralStarPackageFixture();
    // Corruption signature for host*path + client/streamableHttp.js substitution.
    // Node replaces "*" with the exports subpath segment.
    const corruptedFragment = "hostclient/streamableHttp.jspath";

    const probeScript = `
      const wildcards = [
        "@modelcontextprotocol/sdk/client/index.js",
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      ];
      const failures = [];
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
          failures.push(String(error?.message ?? error));
        }
      }
      const joined = failures.join("\\n");
      if (!joined.includes(${JSON.stringify(corruptedFragment)})) {
        console.error("MISSING_CORRUPTION_SIGNATURE", joined.slice(0, 800));
        process.exit(6);
      }
      console.log("WILDCARD_CORRUPTED_OK");

      const clientUrl = import.meta.resolve(${JSON.stringify(MCP_CLIENT_PUBLIC_EXPORT)});
      if (!clientUrl.startsWith("file:")) {
        console.error("CLIENT_NOT_FILE", clientUrl);
        process.exit(7);
      }
      const decodedClient = decodeURIComponent(new URL(clientUrl).pathname);
      if (!decodedClient.includes("*")) {
        console.error("CLIENT_PATH_LOST_STAR", decodedClient);
        process.exit(8);
      }
      if (!decodedClient.includes("/@modelcontextprotocol/sdk/") || !decodedClient.endsWith("/client/index.js")) {
        console.error("CLIENT_UNEXPECTED", decodedClient);
        process.exit(9);
      }

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
    `;

    // --preserve-symlinks keeps package URLs under the fixture's literal-* path.
    const nodeProbe = spawnSync(
      process.execPath,
      ["--preserve-symlinks", "--input-type=module", "-e", probeScript],
      { cwd: projectDir, encoding: "utf8", timeout: 20_000 }
    );
    expect(nodeProbe.status, nodeProbe.stderr || nodeProbe.stdout).toBe(0);
    expect(nodeProbe.stdout).toContain("WILDCARD_CORRUPTED_OK");
    expect(nodeProbe.stdout).toContain("NODE_MCP_IMPORT_OK");
  });

  it("raw Node: Tsugite resolver loads Client + StreamableHTTP without wildcard subpaths", () => {
    // Prefer built runtime when present; otherwise load TS via tsx (focused runs before build).
    const useBuilt = existsSync(BUILT_MCP_CLIENT);
    const importTarget = useBuilt
      ? pathToFileURL(BUILT_MCP_CLIENT).href
      : pathToFileURL(resolve(ROOT, "src/agentServices/mcpClient.ts")).href;
    const nodeArgs = useBuilt
      ? ["--input-type=module", "-e"]
      : ["--import", "tsx", "--input-type=module", "-e"];

    const probeScript = `
      const mod = await import(${JSON.stringify(importTarget)});
      if (typeof mod.resolveMcpClientSiblingModuleUrl !== "function") {
        console.error("MISSING_RESOLVER");
        process.exit(2);
      }
      const transportUrl = mod.resolveMcpClientSiblingModuleUrl(${JSON.stringify(MCP_STREAMABLE_HTTP_SIBLING)});
      if (!transportUrl.startsWith("file:") || !transportUrl.includes("streamableHttp.js")) {
        console.error("BAD_TRANSPORT_URL", transportUrl);
        process.exit(3);
      }
      if (!/\\/@modelcontextprotocol\\/sdk\\/.+\\/client\\/streamableHttp\\.js$/.test(decodeURIComponent(new URL(transportUrl).pathname))) {
        console.error("TRANSPORT_NOT_UNDER_SDK_CLIENT", transportUrl);
        process.exit(6);
      }
      const transportMod = await import(transportUrl);
      if (typeof transportMod.StreamableHTTPClientTransport !== "function") process.exit(4);
      const { Client } = await import(${JSON.stringify(MCP_CLIENT_PUBLIC_EXPORT)});
      if (typeof Client !== "function") process.exit(5);
      const client = new Client({ name: "tsugite-raw-node", version: "0.0.0" });
      const transport = new transportMod.StreamableHTTPClientTransport(new URL("https://example.com/mcp"));
      await transport.close();
      await client.close();
      console.log("TSUGITE_MCP_RUNTIME_OK", ${JSON.stringify(useBuilt ? "built" : "tsx")});
    `;

    const nodeProbe = spawnSync(process.execPath, [...nodeArgs, probeScript], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, NO_COLOR: "1" }
    });
    expect(nodeProbe.status, nodeProbe.stderr || nodeProbe.stdout).toBe(0);
    expect(nodeProbe.stdout).toContain("TSUGITE_MCP_RUNTIME_OK");
  });

  it("loads real Client + StreamableHTTP transport via the sibling resolver", async () => {
    expect(typeof Client).toBe("function");

    const transportUrl = resolveMcpClientSiblingModuleUrl(MCP_STREAMABLE_HTTP_SIBLING);
    const mod = (await import(transportUrl)) as {
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
