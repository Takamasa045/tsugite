import { normalizeError, runTopviewCommand } from "./topviewCli.mjs";

try {
  const result = runTopviewCommand(["list-models", "--type", "i2v", "--json"]);
  const models = JSON.parse(result.stdout);
  if (!models || typeof models !== "object" || Object.keys(models).length === 0) process.exit(40);
  process.stdout.write("topview-video-gen ready\n");
} catch (error) {
  const normalized = normalizeError(error);
  process.exit(normalized.exitCode);
}
