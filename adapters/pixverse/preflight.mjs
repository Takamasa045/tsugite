import { normalizeError, preflightPixverseRequest, readStdin } from "./pixverseCli.mjs";

let requestId = "unknown";
try {
  const payload = JSON.parse(await readStdin());
  requestId = payload?.request?.id ?? requestId;
  console.log(JSON.stringify(preflightPixverseRequest(payload.request)));
} catch (error) {
  const normalized = normalizeError(error);
  console.log(JSON.stringify({
    request_id: requestId,
    status: normalized.exitCode === 40 ? "incompatible" : "unavailable",
    source: "pixverse-cli-runtime",
    operation: "video",
    issues: [{
      code: normalized.exitCode === 40 ? "models.incompatible" : "models.runtime_unavailable",
      message: normalized.exitCode === 40
        ? "PixVerse request is incompatible with the adapter contract"
        : "PixVerse CLI runtime is unavailable"
    }]
  }));
}
