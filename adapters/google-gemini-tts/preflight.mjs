import { buildGeminiTtsRequest } from "./geminiTts.mjs";

let requestId = "unknown";
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  requestId = payload?.request?.id ?? requestId;
  buildGeminiTtsRequest(payload.request);
  console.log(JSON.stringify({
    request_id: requestId,
    status: "provider-validation-required",
    source: "google-gemini-tts-local-contract",
    operation: "voice",
    model: payload.request.model,
    checked_parameters: ["model", "prompt", "voice", "speakers", "turn_styles"]
  }));
} catch {
  console.log(JSON.stringify({
    request_id: requestId,
    status: "incompatible",
    source: "google-gemini-tts-local-contract",
    operation: "voice",
    issues: [{ code: "models.incompatible", message: "Gemini TTS request is incompatible with the adapter contract" }]
  }));
}
