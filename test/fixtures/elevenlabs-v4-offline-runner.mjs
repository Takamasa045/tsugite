// Test-only CLI shim: real generation logic with the remote MCP/fetch boundaries replaced.
import { readFile, appendFile } from "node:fs/promises";
import { generateElevenV4 } from "../../adapters/elevenlabs-v4/client.mjs";
import { creativeSpeechTool, creativeStatusTool, pending, completed } from "./elevenlabs-v4-mcp.mjs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input);
const client = {
  listTools: async () => ({ tools: [creativeSpeechTool, creativeStatusTool] }),
  callTool: async ({ name, arguments: args }) => {
    await appendFile(process.argv[3], `${JSON.stringify({ name, arguments: args })}\n`);
    if (name === "creative_generate_speech") {
      if (args.generations_count !== 1 || args.estimate_only !== false || args.model_id !== "eleven_v4") {
        throw new Error("fixture refused unexpected generation parameters");
      }
      return { structuredContent: pending };
    }
    if (name === "creative_get_flow_run_status") return { structuredContent: completed(payload.request) };
    throw new Error("fixture refused unexpected tool");
  }
};
const output = await generateElevenV4(payload, {
  client, sleep: async () => {},
  fetchImpl: async () => new Response(await readFile(process.argv[2]), { headers: { "content-type": "audio/mpeg" } })
});
process.stdout.write(`${JSON.stringify(output)}\n`);
