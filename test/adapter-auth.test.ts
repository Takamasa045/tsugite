import { afterEach, describe, expect, it, vi } from "vitest";
import * as processApi from "../src/platform/process.js";
import { runAdapterAuth, readAdapterAuthCache, withConnectionCaches } from "../src/adapters/auth.js";
import { loadAdapterDefinition } from "../src/adapters/registry.js";
import { adapterErrorEnvelope } from "../adapters/error-envelope.mjs";
import { main } from "../src/cli.js";
afterEach(() => vi.restoreAllMocks());
async function capture(args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {}), error = vi.spyOn(console, "error").mockImplementation(() => {});
  try { const status = await main(args); return { status, stdout: log.mock.calls.map(c => String(c[0])).join("\n"), stderr: error.mock.calls.map(c => String(c[0])).join("\n") }; }
  finally { log.mockRestore(); error.mockRestore(); }
}
const child = (stdout = "", stderr = "", status: number | null = 0) => ({ stdout, stderr, status, signal: null, error: undefined, pid: 1, output: [null, stdout, stderr] });
describe("provider-neutral public auth wrapper", () => {
  it("rejects unsupported adapters and invalid child JSON without reflecting output", async () => {
    const adapter = await loadAdapterDefinition("elevenlabs-v4");
    expect(runAdapterAuth({ ...adapter, auth: undefined }, { action: "status" }).ok).toBe(false);
    vi.spyOn(processApi, "spawnCommandSync").mockReturnValue(child("private raw provider body") as never);
    expect(runAdapterAuth(adapter, { action: "status" })).toMatchObject({ ok: false, issues: [{ code: "auth.invalid_result" }] });
    expect(JSON.stringify(runAdapterAuth(adapter, { action: "status" }))).not.toContain("private raw");
  });
  it("rejects accidental credential fields even in an otherwise successful result", async () => {
    const adapter = await loadAdapterDefinition("elevenlabs-v4");
    vi.spyOn(processApi, "spawnCommandSync").mockReturnValue(child(JSON.stringify({ schema_version: 1, kind: "tsugite.connection-auth", action: "status", generated: false, nested: { access_token: "fixture-never-display" } })) as never);
    const result = runAdapterAuth(adapter, { action: "status" });
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain("fixture-never-display");
  });
  it("keeps structured failures bounded and ignores untrusted stderr", async () => {
    const adapter = await loadAdapterDefinition("elevenlabs-v4"), spawn = vi.spyOn(processApi, "spawnCommandSync");
    spawn.mockReturnValue(child("", JSON.stringify(adapterErrorEnvelope("oauth_refresh_uncertain")), 30) as never);
    expect(runAdapterAuth(adapter, { action: "probe" })).toMatchObject({ ok: false, issues: [{ code: "auth.oauth_refresh_uncertain" }] });
    spawn.mockReturnValue(child("", "secret signed URL /Users/private", 30) as never);
    expect(JSON.stringify(runAdapterAuth(adapter, { action: "probe" }))).not.toMatch(/secret|signed|Users/);
    expect(readAdapterAuthCache(adapter)).toMatchObject({ configured: null, cache_only: true });
  });
  it("uses only cached summaries and rejects mismatched command results", async () => {
    const adapter = await loadAdapterDefinition("elevenlabs-v4"), spawn = vi.spyOn(processApi, "spawnCommandSync");
    spawn.mockReturnValue(child(JSON.stringify({ schema_version: 1, kind: "tsugite.connection-auth", action: "cached", generated: false, configured: true, checked_at: "2026-10-16T00:00:00Z", expired: true })) as never);
    expect(readAdapterAuthCache(adapter)).toMatchObject({ configured: true, expired: true, cache_only: true });
    expect(JSON.parse(String(spawn.mock.calls[0][2]?.input))).toEqual({ action: "cached" });
    expect(runAdapterAuth(adapter, { action: "status" }).ok).toBe(false);
    expect((await withConnectionCaches([{ adapter: "elevenlabs-v4" }, {}, { adapter: "not-present" }]))[0]).toHaveProperty("connectionStatus");
  });
  it("validates public arguments and requires Coordinator for login", async () => {
    expect((await capture(["auth", "--json"])).status).toBe(1);
    expect((await capture(["auth", "--connection", "elevenlabs", "--action", "invalid", "--json"])).status).toBe(1);
    expect((await capture(["auth", "--connection", "elevenlabs", "--action", "login", "--approve-oauth", "--approve-keychain", "--json"])).status).toBe(1);
    expect((await capture(["auth", "--connection", "not-present", "--action", "status", "--json"])).status).toBe(1);
  });
  it("passes the explicit action and approvals to the declared adapter command", async () => {
    const spawn = vi.spyOn(processApi, "spawnCommandSync").mockImplementation((_command, _args, options) => {
      const input = JSON.parse(String(options?.input));
      return child(JSON.stringify({ schema_version: 1, kind: "tsugite.connection-auth", action: input.action, generated: false, configured: false })) as never;
    });
    const result = await capture(["auth", "--connection", "elevenlabs", "--action", "login", "--client-metadata-url", "https://client.example/tsugite.json", "--approve-oauth", "--approve-keychain", "--actor", "coordinator", "--json"]);
    expect(result.status).toBe(0);
    const input = JSON.parse(String(spawn.mock.calls.at(-1)?.[2]?.input));
    expect(input).toMatchObject({ action: "login", approve_oauth: true, approve_keychain: true, client_metadata_url: "https://client.example/tsugite.json" });
  });
});
