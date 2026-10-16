import { ElevenV4Error, resumeElevenV4 } from "./client.mjs";
import { adapterErrorEnvelope } from "../error-envelope.mjs";

let requestId;
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1_000_000) throw new ElevenV4Error("input_too_large", 40);
  }
  const payload = JSON.parse(input);
  requestId = payload?.request?.id;
  process.stdout.write(`${JSON.stringify(await resumeElevenV4(payload))}\n`);
} catch (error) {
  const failure = error instanceof ElevenV4Error ? error : new ElevenV4Error("adapter_failed", 20);
  process.stderr.write(`${JSON.stringify(adapterErrorEnvelope(failure.code, requestId))}\n`);
  process.exitCode = failure.exitCode;
}
