import { validateElevenV4Request } from "./client.mjs";

let requestId = "unknown";
let requestModel;
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1_000_000) throw new Error("input too large");
  }
  const payload = JSON.parse(input);
  requestId = payload?.request?.id ?? requestId;
  requestModel = payload?.request?.model;
  const request = validateElevenV4Request(payload?.request);
  process.stdout.write(`${JSON.stringify({
    request_id: requestId,
    status: "provider-validation-required",
    source: "elevenlabs-v4-local-contract",
    model: request.model,
    operation: "voice",
    required_parameters: ["params.voice_id"],
    checked_parameters: ["operation", "model", "prompt", "params.voice_id"],
    issues: []
  })}\n`);
} catch {
  process.stdout.write(`${JSON.stringify({
    request_id: requestId,
    status: "incompatible",
    source: "elevenlabs-v4-local-contract",
    model: requestModel,
    operation: "voice",
    issues: [{ code: "models.incompatible", message: "Eleven v4 request is outside this adapter's supported contract" }]
  })}\n`);
}
