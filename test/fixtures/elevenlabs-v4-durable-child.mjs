// Process-interruption fixture. No network or credential store is used.
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { generateElevenV4 as generateWithRealBilling } from "../../adapters/elevenlabs-v4/client.mjs";
import { fixturePermit } from "./elevenlabs-v4-authority.mjs";
const generateElevenV4 = (payload, options = {}) => generateWithRealBilling(payload, { authorizeSubmission: async () => fixturePermit(payload.request), ...options });
import { creativeSpeechTool, creativeStatusTool, pending, completed } from "./elevenlabs-v4-mcp.mjs";
const [root, trace, stopAt] = process.argv.slice(2);
const request = { id: "durability-test", operation: "voice", model: "eleven_v4", prompt: "Connection test.", params: { voice_id: "fixture-voice" } };
const outputDir = join(root, "assets", "elevenlabs-v4");
let markerOpened = false;
const checkpoint = async (phase) => {
  if (phase !== stopAt) return;
  process.send?.({ phase });
  await new Promise(() => { setInterval(() => {}, 1000); });
};
const filesystem = {
  mkdir: fs.mkdir,
  open: async (path, flags, mode) => {
    const handle = await fs.open(path, flags, mode);
    if (flags === "wx") markerOpened = true;
    return {
      stat: () => handle.stat(), close: () => handle.close(),
      sync: async () => {
        await handle.sync();
        if (markerOpened && path === outputDir) await checkpoint("before-submit");
      },
      writeFile: async (data) => {
        await handle.writeFile(data);
        if (String(data).includes('"phase":"accepted"')) await checkpoint("accepted-after-record");
      }
    };
  }
};
const client = {
  listTools: async () => ({ tools: [creativeSpeechTool, creativeStatusTool] }),
  callTool: async ({ name }) => {
    if (name === "creative_generate_speech") {
      await fs.appendFile(trace, "submit\n");
      await checkpoint("accepted-before-record");
      return { structuredContent: pending };
    }
    return { structuredContent: completed(request) };
  }
};
try {
  await generateElevenV4({ request, run_dir: root }, { client, filesystem, sleep: async () => {},
    fetchImpl: async () => { await checkpoint("download"); return new Response(Buffer.from("ID3fixture"), { headers: { "content-type": "audio/mpeg" } }); } });
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code }));
  process.exitCode = error.exitCode ?? 1;
} finally { process.disconnect?.(); }
