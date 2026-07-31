import {
  connectTopviewMcp,
  normalizeError,
  preflightTopviewRequest,
  readStdin
} from "./topviewMcp.mjs";

let requestId = "unknown";
let operation = "video";
let client;
try {
  const payload = JSON.parse(await readStdin());
  requestId = payload?.request?.id ?? requestId;
  operation = payload?.request?.operation ?? operation;
  client = await connectTopviewMcp();
  console.log(JSON.stringify(await preflightTopviewRequest(client, payload.request)));
} catch (error) {
  const normalized = normalizeError(error);
  const incompatible = Boolean(client) && normalized.exitCode === 40;
  console.log(JSON.stringify({
    request_id: requestId,
    status: incompatible ? "incompatible" : "unavailable",
    source: "topview-runtime-config",
    operation,
    issues: [{
      code: incompatible ? "models.incompatible" : "models.runtime_unavailable",
      message: incompatible
        ? "TopView runtime rejected the requested model or parameters"
        : "TopView runtime model configuration is unavailable"
    }]
  }));
} finally {
  await client?.close();
}
