import { ElevenV4Error, generateElevenV4 } from "./client.mjs";

try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1_000_000) throw new ElevenV4Error("input_too_large", 40);
  }
  const payload = JSON.parse(input);
  process.stdout.write(`${JSON.stringify(await generateElevenV4(payload))}\n`);
} catch (error) {
  const failure = error instanceof ElevenV4Error ? error : new ElevenV4Error("adapter_failed", 20);
  process.stderr.write(`ElevenLabs v4 adapter: ${failure.code}\n`);
  process.exitCode = failure.exitCode;
}
