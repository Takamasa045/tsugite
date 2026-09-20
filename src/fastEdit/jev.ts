import { Client } from "@modelcontextprotocol/sdk/client";
import { resolveMcpClientSiblingModuleUrl } from "../agentServices/mcpClient.js";
import type { JevAsk } from "./artifacts.js";

// The existing pinned Jev MCP, local npx cache only. No alternate model/provider,
// prompt agent, generated code, key file, install or fallback in the fast path.
export const askJev: JevAsk = async (request) => {
  const { StdioClientTransport, getDefaultEnvironment } = await import(
    resolveMcpClientSiblingModuleUrl("stdio.js")
  );
  const client = new Client({ name: "tsugite-fast-edit", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["--no-install", "--package=jev-mcp@0.4.0", "jev-mcp"],
    stderr: "pipe",
    env: {
      ...getDefaultEnvironment(),
      // MCP defaults to 64. Our validated beat contract requires 7N+5; set only
      // this child process to the exact request size, without relaxing confidence.
      JEV_MAX_QUESTIONS: String(request.questions.length),
    },
  });
  try {
    await client.connect(transport);
    const result = await client.callTool(
      { name: "jev_ask", arguments: request },
      undefined,
      { timeout: 120000 },
    );
    if (result.isError) throw new Error("Jev MCP returned an error");
    if (result.structuredContent) return result.structuredContent;
    const text = (
      result.content as Array<{ type: string; text?: string }>
    ).find((c) => c.type === "text")?.text;
    if (!text) throw new Error("Jev MCP returned no decision payload");
    return JSON.parse(text);
  } finally {
    await client.close();
    await transport.close();
  }
};
