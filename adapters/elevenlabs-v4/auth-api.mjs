import { ElevenOAuthError, OAUTH, planElevenOAuth, loginElevenOAuth, elevenOAuthStatus, cachedProfileStatus } from "./oauth.mjs";
import { probeElevenV4 } from "./client.mjs";
export async function executeAuthAction(payload, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || Object.keys(payload).some(k => !["action", "model", "client_metadata_url", "approve_oauth", "approve_keychain"].includes(k))
    || !["plan", "status", "login", "probe", "cached"].includes(payload.action)) throw new ElevenOAuthError("oauth_arguments_invalid", 40);
  if (payload.action !== "login" && (payload.approve_oauth || payload.approve_keychain)) throw new ElevenOAuthError("oauth_arguments_invalid", 40);
  if (!["plan", "login"].includes(payload.action) && payload.client_metadata_url !== undefined) throw new ElevenOAuthError("oauth_arguments_invalid", 40);
  if (payload.action !== "probe" && payload.model !== undefined) throw new ElevenOAuthError("oauth_arguments_invalid", 40);
  let result;
  if (payload.action === "plan") result = await planElevenOAuth(payload.client_metadata_url, options);
  else if (payload.action === "status") result = await elevenOAuthStatus(options);
  else if (payload.action === "cached") result = await cachedProfileStatus(options);
  else if (payload.action === "probe") result = await probeElevenV4(payload.model, { ...options.probeOptions, authOptions: options });
  else {
    result = await loginElevenOAuth(payload.client_metadata_url, { ...options, allowAuthorization: payload.approve_oauth === true, allowKeychainWrite: payload.approve_keychain === true });
    result.connection_selector = `ELEVENLABS_MCP_ACCESS_TOKEN=${OAUTH.selector}`;
  }
  return { schema_version: 1, kind: "tsugite.connection-auth", action: payload.action, ...result, generated: false };
}
