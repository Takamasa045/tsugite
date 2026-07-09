import { normalizeError, readStdin, runPixverseVideo } from "../pixverse/pixverseCli.mjs";

try {
  const payload = JSON.parse(await readStdin());
  const model = payload.request?.model || "Kling V3";
  const result = runPixverseVideo(
    {
      ...payload,
      request: {
        ...payload.request,
        model
      }
    },
    { adapterName: "kling", defaultModel: model, route: "pixverse-cli" }
  );
  console.log(JSON.stringify(result));
} catch (error) {
  const normalized = normalizeError(error);
  console.error("Kling adapter command failed");
  process.exit(normalized.exitCode);
}
