// Dummy fixture record only; never invokes Keychain, browser, or a real endpoint.
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { keychainAccessToken, OAUTH } from "../../adapters/elevenlabs-v4/oauth.mjs";
const [root, checkpoint] = process.argv.slice(2);
const discovery = JSON.parse(await readFile(new URL("./elevenlabs-oauth-discovery.json", import.meta.url), "utf8"));
const options = { profileDirectory: root, store: { load: async () => JSON.parse(await readFile(join(root, "dummy-record.json"), "utf8")), save: async record => writeFile(join(root, "dummy-record.json"), JSON.stringify(record)) },
  fetchImpl: async url => {
    if (String(url) === OAUTH.resourceMetadata) return Response.json(discovery.resource);
    if (String(url) === OAUTH.metadata) return Response.json(discovery.metadata);
    if (String(url) !== OAUTH.token) throw new Error("fixture denied network");
    await appendFile(join(root, "refresh-trace.txt"), "refresh\n");
    if (checkpoint === "refresh") { process.send?.("refresh"); await new Promise(() => setInterval(() => {}, 1000)); }
    return Response.json({ access_token: "fixture-new", refresh_token: "fixture-rotated", token_type: "Bearer", expires_in: 3600, scope: OAUTH.scopes });
  } };
try { const token = await keychainAccessToken(options); console.log(JSON.stringify({ ok: true, expected_fixture_token: token === "fixture-new" })); }
catch (error) { console.log(JSON.stringify({ ok: false, code: error.code })); process.exitCode = error.exitCode ?? 1; }
finally { process.disconnect?.(); }
