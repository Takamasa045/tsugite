import { normalizeError, readStdin, runPixverseVideo } from "./pixverseCli.mjs";

try {
  const payload = JSON.parse(await readStdin());
  console.log(JSON.stringify(runPixverseVideo(payload, { adapterName: "pixverse" })));
} catch (error) {
  const normalized = normalizeError(error);
  console.error("PixVerse adapter command failed");
  process.exit(normalized.exitCode);
}
