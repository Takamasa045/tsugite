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
const requestPath = join(root, "accepted-request.json");
globalThis.fetch = async (input, options = {}) => {
  const url = typeof input === "string" ? input : input.url ?? String(input);
  if (url === "https://api.us.elevenlabs.io/v1/mcp") {
    if (!/adapters\/elevenlabs-v4\/(?:quote|generate|probe|resume)\.mjs$/.test(process.argv[1] ?? "")) denied("implicit-provider-call");
    if (options.method === "GET") return new Response(null, { status: 405 });
    const rpc = JSON.parse(options.body);
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    let result;
    if (rpc.method === "initialize") result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "offline-fixture", version: "1" } };
    else if (rpc.method === "tools/list") {
      if (process.env.TSUGITE_FIXTURE_SECOND_FAILURE === "unsubmitted" && /generate\.mjs$/.test(process.argv[1] ?? "")
        && fs.existsSync(requestPath) && !fs.existsSync(join(root, "second-failed"))) {
        fs.writeFileSync(join(root, "second-failed"), "once"); throw new Error("fixture discovery disconnected before second submit");
      }
      result = { tools: [creativeSpeechTool, creativeStatusTool] };
    }
    else if (rpc.method === "tools/call") {
      const { name, arguments: args } = rpc.params;
      trace({ name, arguments: args });
      if (name === "creative_generate_speech") {
        if (args.generations_count !== 1 || args.model_id !== "eleven_v4") denied("unexpected-submit");
        if (args.estimate_only === true) result = { content: [], structuredContent: { estimate: { credits: 16, price_cents: 0.3168, currency: "usd", generations_count: 1 }, flow_created: true } };
        else if (args.estimate_only === false) {
          request = { model: args.model_id, prompt: args.prompt, params: { voice_id: args.voice_id } };
          const jobs = fs.existsSync(requestPath) ? JSON.parse(fs.readFileSync(requestPath, "utf8")) : {};
          const suffix = Object.keys(jobs).length ? `-${Object.keys(jobs).length + 1}` : "";
          const job = { ...pending, flow_id: `fixture-flow${suffix}`, session_ids: [`fixture-session${suffix}`] };
          jobs[job.flow_id] = { request, job, generation_id: `fixture-generation${suffix}` };
          fs.writeFileSync(requestPath, JSON.stringify(jobs));
          if (suffix && process.env.TSUGITE_FIXTURE_SECOND_FAILURE === "unknown") throw new Error("fixture lost second submit response");
          result = { content: [], structuredContent: job };
        } else denied("unexpected-submit");
      } else if (name === "creative_get_flow_run_status") {
        const saved = fs.existsSync(requestPath) ? JSON.parse(fs.readFileSync(requestPath, "utf8"))[args.flow_id] : undefined;
        if (!saved || JSON.stringify(saved.job.session_ids) !== JSON.stringify(args.session_ids)) denied("missing-job");
        request = saved.request;
        if ((process.env.TSUGITE_FIXTURE_STATUS_FAILURE === "once" || (process.env.TSUGITE_FIXTURE_SECOND_FAILURE === "accepted" && args.flow_id.endsWith("-2"))) && !fs.existsSync(join(root, "status-failed"))) {
          fs.writeFileSync(join(root, "status-failed"), "once"); throw new Error("fixture disconnected after accepted response");
        }
        const body = completed(request);
        body.flow_id = saved.job.flow_id; body.session_ids = saved.job.session_ids;
        body.generations[0].id = saved.generation_id; body.media[0].generation_id = saved.generation_id;
        body.generations[0].content_url = `https://storage.googleapis.com/xi-backend/database/workspace/fixture/content_generation/${saved.job.session_ids[0]}/${saved.generation_id}/content.mp3`;
        result = { content: [], structuredContent: body };
      }
      else denied("unexpected-tool");
    } else denied("unexpected-rpc");
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
  }
  if (/^https:\/\/storage\.googleapis\.com\/xi-backend\/database\/workspace\/fixture\/content_generation\/fixture-session(?:-2)?\/fixture-generation(?:-2)?\/content\.mp3$/.test(url)) {
    trace({ name: "download" });
    return new Response(fs.readFileSync(join(root, "voice.mp3")), { headers: { "content-type": "audio/mpeg" } });
  }
  denied("fetch");
};
