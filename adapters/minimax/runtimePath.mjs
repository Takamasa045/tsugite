import { fileURLToPath } from "node:url";
import { pinnedCli } from "../pinnedCli.mjs";
export const MINIMAX_CLI_VERSION = "1.0.28";
export function minimaxCommand() {
  return pinnedCli(fileURLToPath(new URL("./runtime", import.meta.url)), "mmx-cli", MINIMAX_CLI_VERSION, "dist/mmx.mjs", "minimax:install");
}
