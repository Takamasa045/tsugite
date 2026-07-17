import { normalizeError, readStdin, runTopviewVideo } from "./topviewCli.mjs";

try {
  const payload = JSON.parse(await readStdin());
  console.log(JSON.stringify(runTopviewVideo(payload)));
} catch (error) {
  const normalized = normalizeError(error);
  console.error("Topview adapter command failed");
  process.exit(normalized.exitCode);
}
