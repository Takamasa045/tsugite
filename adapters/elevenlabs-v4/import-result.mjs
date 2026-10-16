import { readFile } from "node:fs/promises";
import { ElevenV4Error, importElevenV4Result } from "./client.mjs";

// Explicit completed-result import, never a generation fallback.
try {
  if (process.argv.length !== 3) throw new ElevenV4Error("result_file_argument_required", 40);
  const resultText = await readFile(process.argv[2], "utf8");
  if (resultText.length > 1_000_000) throw new ElevenV4Error("input_too_large", 40);
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1_000_000) throw new ElevenV4Error("input_too_large", 40);
  }
  const payload = JSON.parse(input);
  const result = JSON.parse(resultText);
  process.stdout.write(`${JSON.stringify(await importElevenV4Result({ ...payload, result }))}\n`);
} catch (error) {
  const failure = error instanceof ElevenV4Error ? error : new ElevenV4Error("import_failed", 20);
  process.stderr.write(`ElevenLabs v4 import: ${failure.code}\n`);
  process.exitCode = failure.exitCode;
}
