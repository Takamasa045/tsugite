import { fileURLToPath } from "node:url";
import { pinnedCli } from "../pinnedCli.mjs";
export const PIXVERSE_CLI_VERSION = "1.4.9";
export function pixverseCommand(env = process.env) {
  if (env.PIXVERSE_CLI) return { executable: env.PIXVERSE_CLI, prefix: [] };
  return pinnedCli(fileURLToPath(new URL("./runtime", import.meta.url)), "pixverse", PIXVERSE_CLI_VERSION, "dist/index.js", "pixverse:install");
}
