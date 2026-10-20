import { klingCommand } from "./runtimePath.mjs";
import { forwardCli } from "../pinnedCli.mjs";
try { forwardCli(klingCommand(), process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
