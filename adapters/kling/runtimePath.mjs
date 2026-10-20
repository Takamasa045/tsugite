import { fileURLToPath } from "node:url";
import { pinnedCli } from "../pinnedCli.mjs";
export const KLING_CLI_VERSION = "0.2.3";
export function klingCommand(env = process.env) {
  if (env.KLING_CLI) return { executable: env.KLING_CLI, prefix: [] };
  return pinnedCli(fileURLToPath(new URL("./runtime", import.meta.url)), "@klingai/cli-global", KLING_CLI_VERSION, "dist/cli.js", "kling:install");
}
