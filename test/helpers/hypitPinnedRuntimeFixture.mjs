import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hypitEntry } from "../../adapters/hypit/runtimeAdapter.mjs";

const PRODUCTION_ADAPTER = fileURLToPath(new URL("../../adapters/hypit/", import.meta.url));

/**
 * Isolated adapter root for unit tests. Copies committed pin/allowlist and
 * writes a dummy Hypit entry that must not run. Production defaults stay on
 * adapters/hypit; optional runtime/node_modules is not required.
 */
export function writePinnedRuntimeFixture(adapterRoot, options = {}) {
  const withEntry = options.withEntry !== false;
  writeFileSync(join(adapterRoot, "pin.json"), readFileSync(join(PRODUCTION_ADAPTER, "pin.json")));
  writeFileSync(
    join(adapterRoot, "allowlist.json"),
    readFileSync(join(PRODUCTION_ADAPTER, "allowlist.json"))
  );
  const entry = hypitEntry(adapterRoot);
  if (withEntry) {
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(
      entry,
      "throw new Error(\"test fixture Hypit entry must not execute; inject spawnCli\");\n"
    );
  }
  return { adapterRoot, entry };
}
