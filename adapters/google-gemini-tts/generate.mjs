import { GeminiTtsError, runGeminiTts } from "./geminiTts.mjs";

try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 128 * 1024) throw new GeminiTtsError("TTS request is too large");
    chunks.push(chunk);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  process.stdout.write(`${JSON.stringify(await runGeminiTts(payload))}\n`);
} catch (error) {
  // Do not print request text, provider errors, or credentials.
  process.stderr.write("Google Gemini TTS adapter failed\n");
  process.exit(error instanceof GeminiTtsError ? error.exitCode : 50);
}
