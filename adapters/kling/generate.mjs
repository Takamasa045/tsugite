import { normalizeError, readStdin, runKlingMedia } from "./klingCli.mjs";

try {
  const payload = JSON.parse(await readStdin());
  const result = await runKlingMedia(payload);
  console.log(JSON.stringify(result));
} catch (error) {
  const normalized = normalizeError(error);
  console.error("Kling adapter command failed");
  process.exit(normalized.exitCode);
}
