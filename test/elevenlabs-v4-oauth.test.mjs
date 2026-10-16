import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { OAUTH, clientMetadata, discoverElevenOAuth, planElevenOAuth, createKeychainStore,
  keychainAccessToken, elevenOAuthStatus, validateOAuthCallback, validateCallbackRequest, loginElevenOAuth } from "../adapters/elevenlabs-v4/oauth.mjs";
import { probeElevenV4 } from "../adapters/elevenlabs-v4/client.mjs";
import { creativeSpeechTool, creativeStatusTool } from "./fixtures/elevenlabs-v4-mcp.mjs";
const fixture = JSON.parse(await readFile(new URL("./fixtures/elevenlabs-oauth-discovery.json", import.meta.url), "utf8"));
const CLIENT = "https://client.example/tsugite-elevenlabs.json";
const freshTokens = { access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 3600, scope: OAUTH.scopes };
const record = (expires = 9999999) => ({ version: 1, issuer: OAUTH.issuer, resource: OAUTH.resource,
  client_id: CLIENT, scope: OAUTH.scopes, expires_at: expires, tokens: { ...freshTokens } });
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function harness(changes = {}) {
  let callback;
  const received = new Promise((resolve) => { callback = resolve; });
  const store = { load: vi.fn(async () => undefined), save: vi.fn(async () => {}) };
  const close = vi.fn(async () => {});
  let authorizationUrl;
  const fetchImpl = vi.fn(async (url, init) => {
    if (String(url) === OAUTH.resourceMetadata) return reply(changes.resource ?? fixture.resource);
    if (String(url) === OAUTH.metadata) return reply(changes.metadata ?? fixture.metadata);
    if (String(url) === CLIENT) return reply(changes.client ?? clientMetadata(CLIENT));
    if (String(url) === OAUTH.token) {
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("error");
      return reply(changes.tokens ?? freshTokens);
    }
    throw new Error("fixture forbids unexpected request");
  });
  const openBrowser = vi.fn(async (url) => {
    authorizationUrl = url;
    const query = new URLSearchParams({ code: "fixture-code", state: url.searchParams.get("state"), iss: OAUTH.issuer, ...changes.callback });
    callback({ callbackUrl: OAUTH.redirect + "?" + query });
  });
  return { store, close, fetchImpl, openBrowser, get authorizationUrl() { return authorizationUrl; },
    options: { platform: "darwin", store, fetchImpl, openBrowser, now: () => 1000,
      receiver: () => ({ ready: Promise.resolve(), code: received, close }),
      allowAuthorization: true, allowKeychainWrite: true } };
}

describe("dedicated ElevenLabs OAuth binding (all credentials and OS operations mocked)", () => {
  it("plans only GET discovery and requires a client-owned CIMD instead of inventing registration", async () => {
    const h = harness();
    const plan = await planElevenOAuth(undefined, h.options);
    expect(plan).toMatchObject({ issuer: OAUTH.issuer, authentication_started: false,
      credentials_read_or_written: false, client_metadata_required: true, registration_endpoint_advertised: false,
      requested_scopes: ["text_to_speech", "flows"], tool_scope_mapping_verified: false });
    expect(h.fetchImpl.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
    expect(h.openBrowser).not.toHaveBeenCalled();
    expect(h.store.load).not.toHaveBeenCalled();
    expect(h.store.save).not.toHaveBeenCalled();
  });

  it("refuses changed issuer, token endpoint, missing S256, or unavailable requested scope", async () => {
    for (const changes of [
      { metadata: { ...fixture.metadata, issuer: "https://attacker.example" } },
      { metadata: { ...fixture.metadata, token_endpoint: "https://attacker.example/token" } },
      { metadata: { ...fixture.metadata, code_challenge_methods_supported: ["plain"] } },
      { metadata: { ...fixture.metadata, scopes_supported: OAUTH.scopes } },
      { resource: { ...fixture.resource, scopes_supported: ["convai_write"] } }
    ]) {
      const h = harness(changes);
      await expect(discoverElevenOAuth(h.options)).rejects.toThrow(/oauth_.*metadata_changed/);
      expect(h.store.save).not.toHaveBeenCalled();
    }
  });

  it("rejects unsafe or missing client metadata URLs and metadata for a different client", async () => {
    for (const url of [undefined, "http://client.example/a.json", "https://127.0.0.1/a.json", "https://[::1]/a.json",
      "https://localhost/a.json", "https://client.example/", "https://client.example/a.json?secret=x"]) {
      expect(() => clientMetadata(url)).toThrow("oauth_client_metadata_url_required");
    }
    const h = harness({ client: { ...clientMetadata(CLIENT), redirect_uris: ["https://attacker.example/callback"] } });
    await expect(planElevenOAuth(CLIENT, h.options)).rejects.toThrow("oauth_client_metadata_mismatch");
  });

  it("requires both execution approvals before discovery, browser, listener, or Keychain operations", async () => {
    for (const flag of ["allowAuthorization", "allowKeychainWrite"]) {
      const h = harness();
      await expect(loginElevenOAuth(CLIENT, { ...h.options, [flag]: false })).rejects.toThrow("oauth_execution_approval_required");
      expect(h.fetchImpl).not.toHaveBeenCalled();
      expect(h.openBrowser).not.toHaveBeenCalled();
      expect(h.store.save).not.toHaveBeenCalled();
    }
    const r = spawnSync(process.execPath, ["adapters/elevenlabs-v4/auth.mjs", "login"], { encoding: "utf8" });
    expect(r.status).toBe(40);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("ElevenLabs OAuth: oauth_execution_approval_required\n");
  });

  it("binds PKCE, state, issuer, resource, public client and exactly the approved scopes", async () => {
    const h = harness();
    const result = await loginElevenOAuth(CLIENT, h.options);
    const auth = h.authorizationUrl;
    expect(auth.origin + auth.pathname).toBe(OAUTH.authorization);
    expect(auth.searchParams.get("scope")).toBe(OAUTH.scopes);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("resource")).toBe(OAUTH.resource);
    expect(auth.searchParams.get("redirect_uri")).toBe(OAUTH.redirect);
    expect(auth.searchParams.get("client_id")).toBe(CLIENT);
    const tokenCalls = h.fetchImpl.mock.calls.filter(([url]) => String(url) === OAUTH.token);
    expect(tokenCalls).toHaveLength(1);
    const params = new URLSearchParams(tokenCalls[0][1].body);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("fixture-code");
    expect(params.get("resource")).toBe(OAUTH.resource);
    expect(params.has("client_secret")).toBe(false);
    expect(createHash("sha256").update(params.get("code_verifier")).digest("base64url"))
      .toBe(auth.searchParams.get("code_challenge"));
    expect(h.store.save).toHaveBeenCalledTimes(1);
    expect(h.store.save.mock.calls[0][0].tokens.access_token).toBe("fixture-access");
    expect(JSON.stringify(result)).not.toContain("fixture-");
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("rejects wrong state, wrong/missing issuer, duplicate parameters, denial and callback paths before exchange", async () => {
    for (const callback of [{ state: "wrong" }, { iss: "https://attacker.example" }, { iss: "" }, { error: "access_denied" }]) {
      const h = harness({ callback });
      await expect(loginElevenOAuth(CLIENT, h.options)).rejects.toThrow(/oauth_(callback_rejected|authorization_denied)/);
      expect(h.fetchImpl.mock.calls.some(([url]) => String(url) === OAUTH.token)).toBe(false);
      expect(h.store.save).not.toHaveBeenCalled();
      expect(h.close).toHaveBeenCalledTimes(1);
    }
    expect(() => validateOAuthCallback(OAUTH.redirect + "?state=x&state=x&iss=" + OAUTH.issuer + "&code=c", "x"))
      .toThrow("oauth_callback_rejected");
    expect(() => validateOAuthCallback("http://attacker.example/callback?state=x", "x"))
      .toThrow("oauth_callback_rejected");
  });

  it("rejects scope elevation or malformed tokens before Keychain saving", async () => {
    for (const tokens of [{ ...freshTokens, scope: "text_to_speech flows convai_write" },
      { ...freshTokens, access_token: "bad\nheader" }, { ...freshTokens, access_token: "non-ascii-認証" },
      { ...freshTokens, token_type: 42 }, { ...freshTokens, expires_in: undefined }]) {
      const h = harness({ tokens });
      // The SDK can reject a malformed token before our stricter scope/header validator.
      await expect(loginElevenOAuth(CLIENT, h.options)).rejects.toThrow(/oauth_(token_response_rejected|login_failed)/);
      expect(h.store.save).not.toHaveBeenCalled();
    }
  });

  it("accepts callbacks only on the exact loopback Host, path, method, state and issuer", () => {
    const request = { method: "GET", headers: { host: "127.0.0.1:32145" },
      url: "/elevenlabs/callback?" + new URLSearchParams({ code: "fixture-code", state: "fixture-state", iss: OAUTH.issuer }) };
    expect(validateCallbackRequest(request, "fixture-state")).toBe("fixture-code");
    for (const changed of [{ method: "POST" }, { headers: { host: "attacker.example" } },
      { url: request.url.replace("/elevenlabs/callback", "/other") }, { url: request.url + "#fragment" }]) {
      expect(() => validateCallbackRequest({ ...request, ...changed }, "fixture-state")).toThrow("oauth_callback_rejected");
    }
  });

  it("reads only its own Keychain item and puts secrets on stdin, not process argv", async () => {
    const commands = [];
    const expected = record();
    const run = vi.fn(async (args, input) => {
      commands.push({ args, input });
      return { status: 0, stdout: args[0] === "find-generic-password" ? Buffer.from(JSON.stringify(expected)).toString("base64url") : "", stderr: "" };
    });
    const store = createKeychainStore({ platform: "darwin", run });
    await store.save(expected);
    expect(commands[0].args).toEqual(["-i"]);
    expect(commands[0].input).toContain(OAUTH.keychainService);
    expect(JSON.stringify(commands.map((x) => x.args))).not.toContain("fixture-access");
    const encoded = commands[0].input.trim().split(" ").at(-1);
    expect(JSON.parse(Buffer.from(encoded, "base64url").toString())).toEqual(expected);
    expect(await store.load()).toEqual(expected);
    expect(commands[1].args).toEqual(["find-generic-password", "-s", OAUTH.keychainService, "-a", OAUTH.keychainAccount, "-w"]);
  });

  it("fails closed on unavailable Keychain or storage error without plaintext fallback", async () => {
    const run = vi.fn(async () => ({ status: 1, stdout: "fixture-private", stderr: "error: fixture-private" }));
    await expect(createKeychainStore({ platform: "linux", run }).save(record())).rejects.toThrow("oauth_keychain_unavailable");
    expect(run).not.toHaveBeenCalled();
    await expect(createKeychainStore({ platform: "darwin", run }).save(record())).rejects.toThrow("oauth_keychain_failed");
    const missing = createKeychainStore({ platform: "darwin", run: async () => ({ status: 44 }) });
    expect(await missing.load()).toBeUndefined();
  });

  it("status reports configuration without refreshing, saving, browser or secret output", async () => {
    const store = { load: vi.fn(async () => record(1)), save: vi.fn() };
    const r = await elevenOAuthStatus({ store, now: () => 1000 });
    expect(r).toMatchObject({ configured: true, expired: true });
    expect(JSON.stringify(r)).not.toContain("fixture-access");
    expect(store.save).not.toHaveBeenCalled();
  });

  it("returns a fresh own token without discovery or refresh and rejects foreign records", async () => {
    const h = harness();
    h.store.load.mockResolvedValue(record());
    expect(await keychainAccessToken(h.options)).toBe("fixture-access");
    expect(h.fetchImpl).not.toHaveBeenCalled();
    h.store.load.mockResolvedValue({ ...record(), issuer: "https://another.example" });
    await expect(keychainAccessToken(h.options)).rejects.toThrow("oauth_keychain_record_invalid");
  });

  it("refreshes only its own expired grant at the pinned endpoint, preserving a nonrotated refresh token", async () => {
    const h = harness({ tokens: { ...freshTokens, access_token: "fixture-new", refresh_token: undefined } });
    h.store.load.mockResolvedValue(record(1));
    expect(await keychainAccessToken(h.options)).toBe("fixture-new");
    const request = h.fetchImpl.mock.calls.find(([url]) => String(url) === OAUTH.token);
    const params = new URLSearchParams(request[1].body);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("fixture-refresh");
    expect(params.get("resource")).toBe(OAUTH.resource);
    expect(h.store.save.mock.calls[0][0].tokens.refresh_token).toBe("fixture-refresh");
    expect(h.openBrowser).not.toHaveBeenCalled();
  });

  it("does not redirect to login, register a client, expose provider errors or save tokens after failed refresh", async () => {
    const h = harness();
    const baseFetch = h.options.fetchImpl;
    h.options.fetchImpl = vi.fn(async (url, init) => String(url) === OAUTH.token
      ? reply({ error: "invalid_grant", error_description: "fixture-private-response" }, 400) : baseFetch(url, init));
    h.store.load.mockResolvedValue(record(1));
    await expect(keychainAccessToken(h.options)).rejects.toMatchObject({ message: "oauth_refresh_failed" });
    expect(h.store.save).not.toHaveBeenCalled();
    expect(h.openBrowser).not.toHaveBeenCalled();
    expect(h.options.fetchImpl.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });

  it("connects the actual narration probe to the selected Keychain binding without exposing its token", async () => {
    const client = { listTools: vi.fn(async () => ({ tools: [creativeSpeechTool, creativeStatusTool] })), close: vi.fn(async () => {}) };
    const connectMcp = vi.fn(async () => client);
    const result = await probeElevenV4("eleven_v4", { environment: { ELEVENLABS_MCP_ACCESS_TOKEN: OAUTH.selector },
      authOptions: { store: { load: async () => record() }, now: () => 1000 }, connectMcp });
    expect(connectMcp).toHaveBeenCalledWith("fixture-access");
    expect(result.adapter_compatible).toBe(true);
    expect(JSON.stringify(result)).not.toContain("fixture-access");
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
