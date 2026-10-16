import { ElevenOAuthError, OAUTH, clientMetadata, planElevenOAuth, loginElevenOAuth, elevenOAuthStatus } from "./oauth.mjs";

try {
  const [command, ...args] = process.argv.slice(2);
  let clientId;
  let allowAuthorization = false;
  let allowKeychainWrite = false;
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (seen.has(key)) throw new ElevenOAuthError("oauth_arguments_invalid", 40);
    seen.add(key);
    if (key === "--client-metadata-url") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new ElevenOAuthError("oauth_arguments_invalid", 40);
      clientId = args[++i];
    }
    else if (key === "--approve-oauth") allowAuthorization = true;
    else if (key === "--approve-keychain") allowKeychainWrite = true;
    else throw new ElevenOAuthError("oauth_arguments_invalid", 40);
  }
  let result;
  if (command === "metadata" && !allowAuthorization && !allowKeychainWrite) result = clientMetadata(clientId);
  else if ((command === "plan" || command === "discover") && !allowAuthorization && !allowKeychainWrite) {
    result = await planElevenOAuth(clientId);
  } else if (command === "status" && args.length === 0) result = await elevenOAuthStatus();
  else if (command === "login") {
    result = await loginElevenOAuth(clientId, { allowAuthorization, allowKeychainWrite });
    result.connection_selector = `ELEVENLABS_MCP_ACCESS_TOKEN=${OAUTH.selector}`;
  } else throw new ElevenOAuthError("oauth_arguments_invalid", 40);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const failure = error instanceof ElevenOAuthError ? error : new ElevenOAuthError("oauth_operation_failed");
  process.stderr.write(`ElevenLabs OAuth: ${failure.code}\n`);
  process.exitCode = failure.exitCode;
}
