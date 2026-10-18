import { minimaxCommand } from "./runtimePath.mjs";
import { forwardCli } from "../pinnedCli.mjs";
// MiniMax integration remains preflight-only; this entry cannot submit requests.
const args = process.argv.slice(2);
if (!(args.length === 1 && ["--version", "--help"].includes(args[0]))
    && args.join(" ") !== "video generate --help") {
  console.error("MiniMax is preflight-only. Only --version, --help and video generate --help are allowed.");
  process.exitCode = 3;
} else {
  try { forwardCli(minimaxCommand(), args); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
