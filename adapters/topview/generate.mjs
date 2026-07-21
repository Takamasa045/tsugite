import { normalizeError, readStdin, runTopviewMcpMedia } from "./topviewMcp.mjs";

try {
  const payload = JSON.parse(await readStdin());
  console.log(JSON.stringify(await runTopviewMcpMedia(payload)));
} catch (error) {
  const normalized = normalizeError(error);
  console.error("TopView MCP adapter command failed");
  process.exit(normalized.exitCode);
}
