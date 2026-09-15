#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const result = spawnSync(process.execPath, [
  "--import",
  "tsx",
  fileURLToPath(new URL("./productionCliMain.mjs", import.meta.url)),
  ...process.argv.slice(2)
], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
