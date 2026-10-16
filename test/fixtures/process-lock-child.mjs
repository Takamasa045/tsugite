import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { withProcessLock } from "../../adapters/process-lock.mjs";
const [root] = process.argv.slice(2);
try {
  await withProcessLock(root, "shared.lock", async () => {
    await appendFile(join(root, "trace"), `enter ${process.pid}\n`);
    let value = 0;
    try { value = Number(await readFile(join(root, "count"), "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(join(root, "count"), String(value + 1));
    await appendFile(join(root, "trace"), `exit ${process.pid}\n`);
  });
} catch (error) { process.stderr.write(error.code ?? "failed"); process.exitCode = 1; }
