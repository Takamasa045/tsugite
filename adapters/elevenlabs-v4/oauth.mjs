import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { billingDigest, validateConnectionBinding } from "../billing-contract.mjs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { startAuthorization, exchangeAuthorization, refreshAuthorization } from "../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js";

export const OAUTH = Object.freeze({
  resource: "https://api.us.elevenlabs.io/v1/mcp",
  resourceMetadata: "https://api.us.elevenlabs.io/.well-known/oauth-protected-resource/v1/mcp",
  metadata: "https://api.us.elevenlabs.io/.well-known/oauth-authorization-server",
  issuer: "https://api.us.elevenlabs.io",
  authorization: "https://elevenlabs.io/app/oauth/authorize",
  token: "https://api.us.elevenlabs.io/v1/oauth/token",
  redirect: "http://127.0.0.1:32145/elevenlabs/callback",
  scopes: "text_to_speech flows",
  clientName: "Tsugite ElevenLabs narration",
  keychainService: "io.tsugite.elevenlabs-v4.oauth.us",
  keychainAccount: "tsugite-narration",
  selector: "@tsugite-elevenlabs-v4-keychain"
});
export class ElevenOAuthError extends Error {
  constructor(code, exitCode = 30) { super(code); this.code = code; this.exitCode = exitCode; }
}
const fail = (code, exitCode) => { throw new ElevenOAuthError(code, exitCode); };
const sameScopes = (a, b = OAUTH.scopes) => typeof a === "string"
  && JSON.stringify([...new Set(a.split(/\s+/).filter(Boolean))].sort()) === JSON.stringify(b.split(" ").sort());
const secretString = (value) => typeof value === "string" && value.length > 0 && value.length <= 32768 && /^[\x21-\x7e]+$/.test(value);
const stringList = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");

async function publicJson(url, fetchImpl) {
  let response;
  try { response = await fetchImpl(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000) }); }
  catch { fail("oauth_discovery_failed", 20); }
  if (!response.ok) fail("oauth_discovery_failed", 20);
  const text = await response.text();
  if (text.length > 100_000) fail("oauth_metadata_invalid", 20);
  try { return JSON.parse(text); } catch { fail("oauth_metadata_invalid", 20); }
}

export async function discoverElevenOAuth(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resource = await publicJson(OAUTH.resourceMetadata, fetchImpl);
  if (!resource || typeof resource !== "object" || Array.isArray(resource)
    || resource.resource !== OAUTH.resource || !stringList(resource.authorization_servers) || resource.authorization_servers.length !== 1
    || resource.authorization_servers[0] !== OAUTH.issuer
    || !stringList(resource.scopes_supported)
    || !OAUTH.scopes.split(" ").every((scope) => resource.scopes_supported?.includes(scope))) {
    fail("oauth_resource_metadata_changed", 20);
  }
  const metadata = await publicJson(OAUTH.metadata, fetchImpl);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
    || metadata.issuer !== OAUTH.issuer || metadata.authorization_endpoint !== OAUTH.authorization
    || metadata.token_endpoint !== OAUTH.token || metadata.client_id_metadata_document_supported !== true
    || !["code_challenge_methods_supported", "token_endpoint_auth_methods_supported", "response_types_supported", "grant_types_supported", "scopes_supported"]
      .every((key) => stringList(metadata[key]))
    || !metadata.code_challenge_methods_supported?.includes("S256")
    || !metadata.token_endpoint_auth_methods_supported?.includes("none")
    || !metadata.response_types_supported?.includes("code")
    || !["authorization_code", "refresh_token"].every((grant) => metadata.grant_types_supported?.includes(grant))
    || metadata.authorization_response_iss_parameter_supported !== true
    || !OAUTH.scopes.split(" ").every((scope) => metadata.scopes_supported?.includes(scope))) {
    fail("oauth_authorization_metadata_changed", 20);
  }
  return { resource, metadata };
}

export function clientMetadata(clientId) {
  let url;
  try { url = new URL(clientId); } catch { fail("oauth_client_metadata_url_required", 40); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
    || url.pathname === "/" || url.hostname === "localhost" || url.hostname.endsWith(".localhost")
    || url.hostname.endsWith(".local") || !url.hostname.includes(".")
    || isIP(url.hostname.replace(/^\[|\]$/g, "")) || url.href !== clientId) {
    fail("oauth_client_metadata_url_required", 40);
  }
  return { client_id: clientId, client_name: OAUTH.clientName, redirect_uris: [OAUTH.redirect],
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    token_endpoint_auth_method: "none", scope: OAUTH.scopes };
}

async function validatePublishedClient(clientId, options) {
  const expected = clientMetadata(clientId);
  const document = await publicJson(clientId, options.fetchImpl ?? fetch);
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(document[key]) !== JSON.stringify(value)) fail("oauth_client_metadata_mismatch", 20);
  }
  if (document.client_secret || document.jwks || document.jwks_uri) fail("oauth_client_metadata_mismatch", 20);
  return expected;
}

export async function planElevenOAuth(clientId, options = {}) {
  const discovered = await discoverElevenOAuth(options);
  if (clientId) await validatePublishedClient(clientId, options);
  return { issuer: OAUTH.issuer, resource: OAUTH.resource, authorization_endpoint: OAUTH.authorization,
    token_endpoint: OAUTH.token, requested_scopes: OAUTH.scopes.split(" "),
    supported_scopes: discovered.resource.scopes_supported, tool_scope_mapping_verified: false,
    client_id: clientId ?? null, client_metadata_required: !clientId,
    client_id_metadata_document_supported: true, dynamic_registration_used: false,
    registration_endpoint_advertised: Boolean(discovered.metadata.registration_endpoint),
    redirect_uri: OAUTH.redirect, pkce: "S256", token_endpoint_auth_method: "none",
    storage: { kind: "macOS Keychain only", service: OAUTH.keychainService, account: OAUTH.keychainAccount },
    authentication_started: false, credentials_read_or_written: false };
}

// Credentials go through stdin, never command argv. No plaintext-file fallback.
async function securityProcess(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new ElevenOAuthError("oauth_keychain_failed")); }, 15_000);
    child.stdout.on("data", (data) => { stdout += data; if (stdout.length > 150_000) child.kill("SIGTERM"); });
    child.stderr.on("data", (data) => { stderr += data; if (stderr.length > 150_000) child.kill("SIGTERM"); });
    child.on("error", () => { clearTimeout(timer); reject(new ElevenOAuthError("oauth_keychain_failed")); });
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}
export function createKeychainStore(options = {}) {
  const run = options.run ?? securityProcess;
  const checkPlatform = () => { if ((options.platform ?? process.platform) !== "darwin") fail("oauth_keychain_unavailable"); };
  return {
    async load() {
      checkPlatform();
      const r = await run(["find-generic-password", "-s", OAUTH.keychainService, "-a", OAUTH.keychainAccount, "-w"]);
      if (r.status === 44) return undefined;
      if (r.status !== 0) fail("oauth_keychain_failed");
      try { return JSON.parse(Buffer.from(r.stdout.trim(), "base64url").toString("utf8")); }
      catch { fail("oauth_keychain_record_invalid"); }
    },
    async save(record) {
      checkPlatform();
      const encoded = Buffer.from(JSON.stringify(record)).toString("base64url");
      if (encoded.length > 130_000) fail("oauth_keychain_record_invalid");
      const command = `add-generic-password -U -s ${OAUTH.keychainService} -a ${OAUTH.keychainAccount} -w ${encoded}\n`;
      const r = await run(["-i"], command);
      if (r.status !== 0 || /SecKeychain|error:|failed/i.test(r.stderr ?? "")) fail("oauth_keychain_failed");
      const stored = await run(["find-generic-password", "-s", OAUTH.keychainService, "-a", OAUTH.keychainAccount, "-w"]);
      const actual = Buffer.from(stored.stdout?.trim() ?? "");
      const expected = Buffer.from(encoded);
      if (stored.status !== 0 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail("oauth_keychain_failed");
    }
  };
}

function validateRecord(record) {
  if (!record || record.version !== 1 || record.issuer !== OAUTH.issuer || record.resource !== OAUTH.resource
    || !sameScopes(record.scope) || !sameScopes(record.tokens?.scope)
    || !secretString(record.tokens?.access_token) || typeof record.tokens.token_type !== "string" || record.tokens.token_type.toLowerCase() !== "bearer"
    || (record.tokens.refresh_token !== undefined && !secretString(record.tokens.refresh_token))
    || !Number.isFinite(record.expires_at)
    || (record.grant_epoch !== undefined && (typeof record.grant_epoch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.grant_epoch)))) fail("oauth_keychain_record_invalid");
  clientMetadata(record.client_id);
  return record;
}
function tokenRecord(tokens, clientId, now, previous) {
  if (!secretString(tokens?.access_token) || typeof tokens.token_type !== "string" || tokens.token_type.toLowerCase() !== "bearer"
    || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0
    || (tokens.refresh_token !== undefined && !secretString(tokens.refresh_token))
    || (tokens.scope !== undefined && !sameScopes(tokens.scope))) fail("oauth_token_response_rejected");
  return validateRecord({ version: 1, issuer: OAUTH.issuer, resource: OAUTH.resource,
    client_id: clientId, scope: OAUTH.scopes,
    ...(previous ? (previous.grant_epoch ? { grant_epoch: previous.grant_epoch } : {}) : { grant_epoch: randomUUID() }),
    expires_at: now + tokens.expires_in * 1000,
    tokens: { ...tokens, scope: tokens.scope ?? OAUTH.scopes,
      ...(tokens.refresh_token === undefined && previous?.tokens.refresh_token ? { refresh_token: previous.tokens.refresh_token } : {}) } });
}
function tokenFetch(options) {
  return async (url, init) => {
    if (String(url) !== OAUTH.token || init?.method !== "POST") fail("oauth_token_endpoint_rejected");
    const response = await (options.fetchImpl ?? fetch)(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (response.status >= 300 && response.status < 400) fail("oauth_token_endpoint_rejected");
    return response;
  };
}

export async function keychainAccessToken(options = {}) {
  const store = options.store ?? createKeychainStore();
  const loaded = await store.load();
  if (loaded === undefined) fail("oauth_login_required");
  const record = validateRecord(loaded);
  const now = (options.now ?? Date.now)();
  if (record.expires_at > now + 60_000) return record.tokens.access_token;
  if (!record.tokens.refresh_token) fail("oauth_login_required");
  const { metadata } = await discoverElevenOAuth(options);
  try {
    const tokens = await refreshAuthorization(new URL(OAUTH.issuer), { metadata,
      clientInformation: { client_id: record.client_id }, refreshToken: record.tokens.refresh_token,
      resource: new URL(OAUTH.resource), fetchFn: tokenFetch(options) });
    const next = tokenRecord(tokens, record.client_id, now, record);
    await store.save(next);
    return next.tokens.access_token;
  } catch (error) {
    if (error instanceof ElevenOAuthError) throw error;
    fail("oauth_refresh_failed");
  }
}

export async function elevenOAuthStatus(options = {}) {
  const loaded = await (options.store ?? createKeychainStore()).load();
  if (loaded === undefined) return { configured: false, storage: "macOS Keychain", service: OAUTH.keychainService };
  const record = validateRecord(loaded);
  return { configured: true, expired: record.expires_at <= (options.now ?? Date.now)(),
    issuer: record.issuer, client_id: record.client_id, scopes: record.scope.split(" "), grant_epoch: record.grant_epoch ?? null,
    storage: "macOS Keychain", service: OAUTH.keychainService, account: OAUTH.keychainAccount };
}

// Non-secret binding. Never hash access/refresh token bytes into an approval.
export async function elevenCredentialBinding(options = {}) {
  const environment = options.environment ?? process.env;
  const selected = environment.ELEVENLABS_MCP_ACCESS_TOKEN;
  let binding;
  if (selected === OAUTH.selector) {
    const loaded = await (options.store ?? createKeychainStore()).load();
    if (loaded === undefined) fail("oauth_login_required");
    const record = validateRecord(loaded);
    binding = { connection: "elevenlabs", source: "keychain", profile_id: "tsugite-narration-us", grant_epoch: record.grant_epoch,
      contract_digest: billingDigest({ issuer: record.issuer, resource: record.resource, scope: record.scope, client_id: record.client_id }) };
  } else {
    // Existing externally managed bearer stays supported. Its operator supplies
    // a non-secret epoch and changes it whenever replacing that grant.
    if (typeof selected !== "string" || !selected.trim()) fail("credential_missing");
    binding = { connection: "elevenlabs", source: "operator-attested-environment",
      profile_id: environment.TSUGITE_ELEVENLABS_PROFILE_ID ?? "environment",
      grant_epoch: environment.TSUGITE_ELEVENLABS_GRANT_EPOCH,
      contract_digest: billingDigest({ issuer: OAUTH.issuer, resource: OAUTH.resource, scope: OAUTH.scopes }) };
  }
  try { return validateConnectionBinding(binding); } catch { fail("billing_connection_unverified"); }
}

export function validateOAuthCallback(rawUrl, expectedState) {
  let url;
  try { url = new URL(rawUrl, OAUTH.redirect); } catch { fail("oauth_callback_rejected"); }
  if (url.origin + url.pathname !== OAUTH.redirect || url.username || url.password || url.hash
    || String(rawUrl).length > 8192) fail("oauth_callback_rejected");
  for (const key of ["state", "code", "iss", "error"]) {
    if (url.searchParams.getAll(key).length > 1) fail("oauth_callback_rejected");
  }
  const state = url.searchParams.get("state") ?? "";
  const a = Buffer.from(state); const b = Buffer.from(expectedState);
  if (a.length !== b.length || !timingSafeEqual(a, b) || url.searchParams.get("iss") !== OAUTH.issuer) {
    fail("oauth_callback_rejected");
  }
  if (url.searchParams.has("error")) fail("oauth_authorization_denied");
  const code = url.searchParams.get("code");
  if (!secretString(code)) fail("oauth_callback_rejected");
  return code;
}

export function validateCallbackRequest(request, state) {
  if (request.method !== "GET" || request.headers?.host !== "127.0.0.1:32145" || typeof request.url !== "string") {
    fail("oauth_callback_rejected");
  }
  return validateOAuthCallback(request.url, state);
}

function loopbackReceiver(state) {
  let resolveCode; let rejectCode; let server;
  const code = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  code.catch(() => {});
  const timer = setTimeout(() => rejectCode(new ElevenOAuthError("oauth_callback_timeout")), 180_000);
  server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    try {
      validateCallbackRequest(request, state);
      response.writeHead(200, { "Content-Type": "text/plain" }).end("Tsugite authorization received. You may close this tab.");
      resolveCode({ callbackUrl: request.url });
    } catch (error) {
      response.writeHead(400).end("Invalid callback");
      if (error.code === "oauth_authorization_denied") rejectCode(error);
    }
  });
  const ready = new Promise((resolve, reject) => {
    server.once("error", () => reject(new ElevenOAuthError("oauth_callback_listener_failed")));
    server.listen(32145, "127.0.0.1", resolve);
  });
  return { ready, code, close: async () => { clearTimeout(timer); server.closeAllConnections(); if (server.listening) await new Promise((resolve) => server.close(resolve)); } };
}
async function browserOpen(url) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/open", [String(url)], { shell: false, stdio: "ignore" });
    child.once("error", () => reject(new ElevenOAuthError("oauth_browser_failed")));
    child.once("exit", (status) => status === 0 ? resolve() : reject(new ElevenOAuthError("oauth_browser_failed")));
  });
}

export async function loginElevenOAuth(clientId, options = {}) {
  // Guards run before discovery, Keychain, listener, browser, or token operations.
  if (options.allowAuthorization !== true || options.allowKeychainWrite !== true) fail("oauth_execution_approval_required", 40);
  if ((options.platform ?? process.platform) !== "darwin") fail("oauth_keychain_unavailable");
  const { metadata } = await discoverElevenOAuth(options);
  await validatePublishedClient(clientId, options);
  const state = randomBytes(32).toString("base64url");
  const { authorizationUrl, codeVerifier } = await startAuthorization(new URL(OAUTH.issuer), {
    metadata, clientInformation: { client_id: clientId }, redirectUrl: new URL(OAUTH.redirect),
    scope: OAUTH.scopes, state, resource: new URL(OAUTH.resource)
  });
  const receiver = (options.receiver ?? loopbackReceiver)(state);
  try {
    await receiver.ready;
    await (options.openBrowser ?? browserOpen)(authorizationUrl);
    // Validate state and issuer again at the token-exchange boundary.
    const received = await receiver.code;
    if (typeof received?.callbackUrl !== "string") fail("oauth_callback_rejected");
    const code = validateOAuthCallback(received.callbackUrl, state);
    const tokens = await exchangeAuthorization(new URL(OAUTH.issuer), { metadata,
      clientInformation: { client_id: clientId }, authorizationCode: code, codeVerifier,
      redirectUri: OAUTH.redirect, resource: new URL(OAUTH.resource), fetchFn: tokenFetch(options) });
    const record = tokenRecord(tokens, clientId, (options.now ?? Date.now)());
    await (options.store ?? createKeychainStore()).save(record);
    return { authenticated: true, issuer: OAUTH.issuer, scopes: OAUTH.scopes.split(" "), grant_epoch: record.grant_epoch,
      storage: "macOS Keychain", service: OAUTH.keychainService, account: OAUTH.keychainAccount };
  } catch (error) {
    if (error instanceof ElevenOAuthError) throw error;
    fail("oauth_login_failed");
  } finally { await receiver.close(); }
}
