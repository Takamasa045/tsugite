import { normalizeError, readStdin, runPixverseMedia } from "./pixverseCli.mjs";

try {
  const payload = JSON.parse(await readStdin());
  console.log(JSON.stringify(runPixverseMedia(payload, { adapterName: "pixverse" })));
} catch (error) {
  const normalized = normalizeError(error);
  console.error("PixVerse adapter command failed");
  process.exit(normalized.exitCode);
}
