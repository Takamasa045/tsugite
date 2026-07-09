import { normalizeError, readStdin, runPixverseVideo } from "./pixverseCli.mjs";

try {
  const payload = JSON.parse(await readStdin());
  console.log(JSON.stringify(runPixverseVideo(payload, { adapterName: "pixverse" })));
} catch (error) {
  const normalized = normalizeError(error);
  console.error(normalized.message);
  process.exit(normalized.exitCode);
}
