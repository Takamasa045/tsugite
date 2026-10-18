import { pixverseCommand } from "./runtimePath.mjs";
import { forwardCli } from "../pinnedCli.mjs";
try { forwardCli(pixverseCommand(), ["--version"]); }
catch (error) { console.error(error.message); process.exitCode = 1; }
