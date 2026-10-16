// Test-only preload: retain the production CLI, gates, adapter and renderer.
// Only MCP/MP3 transport and the selected bearer are fixtures. Never read Keychain.
import fs from "node:fs";
import net from "node:net";
import dns from "node:dns";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { creativeSpeechTool, creativeStatusTool, pending, completed } from "./elevenlabs-v4-mcp.mjs";

const root = process.env.TSUGITE_CLI_FIXTURE_ROOT;
if (process.env.NODE_ENV !== "test" || !root || !fs.existsSync(join(root, "owned-fixture"))
  || process.env.ELEVENLABS_MCP_ACCESS_TOKEN !== "fixture-nonsecret") throw new Error("fixture isolation missing");
const trace = (entry) => fs.appendFileSync(join(root, "calls.jsonl"), `${JSON.stringify(entry)}\n`);
const denied = (kind) => { trace({ denied: kind }); throw new Error(`fixture denied ${kind}`); };
const local = (host) => [undefined, "localhost", "127.0.0.1", "::1"].includes(host);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const arg = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof arg === "object" && !local(arg.host)) denied("network");
  if (typeof arg === "number" && typeof args[1] === "string" && !local(args[1])) denied("network");
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (host, ...args) {
  // Remotion tests wildcard bind addresses; these numeric literals do not do DNS.
  if (!local(host) && !["0.0.0.0", "::"].includes(host)) denied("dns");
  return lookup.call(this, host, ...args);
};
const spawnSync = childProcess.spawnSync;
childProcess.spawnSync = function (command, ...args) {
  if (/(^|\/)security$/.test(command)) denied("keychain");
  return spawnSync.call(this, command, ...args);
};
syncBuiltinESMExports();
let request;
globalThis.fetch = async (input, options = {}) => {
  const url = typeof input === "string" ? input : input.url ?? String(input);
  if (url === "https://api.us.elevenlabs.io/v1/mcp") {
    if (!/adapters\/elevenlabs-v4\/(?:quote|generate|probe)\.mjs$/.test(process.argv[1] ?? "")) denied("implicit-provider-call");
    if (options.method === "GET") return new Response(null, { status: 405 });
    const rpc = JSON.parse(options.body);
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    let result;
    if (rpc.method === "initialize") result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "offline-fixture", version: "1" } };
    else if (rpc.method === "tools/list") result = { tools: [creativeSpeechTool, creativeStatusTool] };
    else if (rpc.method === "tools/call") {
      const { name, arguments: args } = rpc.params;
      trace({ name, arguments: args });
      if (name === "creative_generate_speech") {
        if (args.generations_count !== 1 || args.model_id !== "eleven_v4") denied("unexpected-submit");
        if (args.estimate_only === true) result = { content: [], structuredContent: { estimate: { credits: 16, price_cents: 0.3168, currency: "usd", generations_count: 1 }, flow_created: true } };
        else if (args.estimate_only === false) {
          request = { model: args.model_id, prompt: args.prompt, params: { voice_id: args.voice_id } };
          result = { content: [], structuredContent: pending };
        } else denied("unexpected-submit");
      } else if (name === "creative_get_flow_run_status" && request) result = { content: [], structuredContent: completed(request) };
      else denied("unexpected-tool");
    } else denied("unexpected-rpc");
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
  }
  if (url === "https://storage.googleapis.com/xi-backend/database/workspace/fixture/content_generation/fixture-session/fixture-generation/content.mp3") {
    trace({ name: "download" });
    return new Response(fs.readFileSync(join(root, "voice.mp3")), { headers: { "content-type": "audio/mpeg" } });
  }
  denied("fetch");
};
