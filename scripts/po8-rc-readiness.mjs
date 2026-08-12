#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(root, "build", "productionControl", "rc", "readinessCli.js");
if (!existsSync(built)) {
  process.stderr.write(JSON.stringify({
    ok: false,
    error: "build/productionControl/rc/readinessCli.js missing; run npm run build first"
  }) + "\n");
  process.exit(2);
}
const { runReadinessCli } = await import(pathToFileURL(built).href);
process.exit(await runReadinessCli(process.argv.slice(2)));
