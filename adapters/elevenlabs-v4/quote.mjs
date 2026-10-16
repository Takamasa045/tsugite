import { ElevenV4Error, quoteElevenV4 } from "./client.mjs";
import { adapterErrorEnvelope } from "../error-envelope.mjs";
import { ElevenOAuthError } from "./oauth.mjs";
let requestId;
try {
  let text = "";
  for await (const chunk of process.stdin) { text += chunk; if (text.length > 1_000_000) throw new ElevenV4Error("input_too_large", 40); }
  const payload = JSON.parse(text); requestId = payload?.request?.id;
  process.stdout.write(`${JSON.stringify(await quoteElevenV4(payload))}\n`);
} catch (error) {
  const failure = error instanceof ElevenV4Error || error instanceof ElevenOAuthError ? error : new ElevenV4Error("billing_quote_failed", 20);
  process.stderr.write(`${JSON.stringify(adapterErrorEnvelope(failure.code, requestId))}\n`);
  process.exitCode = failure.exitCode;
}
