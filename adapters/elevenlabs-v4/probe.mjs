import { ElevenV4Error, probeElevenV4 } from "./client.mjs";

// Deliberately accepts only a model name, never prompt text or credentials.
try {
  const model = process.argv[2];
  if (process.argv.length !== 3) throw new ElevenV4Error("model_argument_required", 40);
  const result = await probeElevenV4(model);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.adapter_compatible) process.exitCode = 20;
} catch (error) {
  const failure = error instanceof ElevenV4Error ? error : new ElevenV4Error("probe_failed", 20);
  process.stderr.write(`ElevenLabs v4 probe: ${failure.code}\n`);
  process.exitCode = failure.exitCode;
}
