import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv, spawnOwned, stopOwned, waitExit } from "./processGroup.mjs";
import { missingRuntimeMessage, resolveEditframeCli } from "./runtimePath.mjs";

const ALLOWED_COMMANDS = new Set(["preview", "render", "help", "version"]);
const DENIED_COMMANDS = new Set([
  "auth",
  "sync",
  "cloud-render",
  "transcribe",
  "webhook",
  "process",
  "process-file",
  "dev-server"
]);

function collectUrlFlags(tokens) {
  const urls = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--url") {
      urls.push(tokens[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (token.startsWith("--url=")) {
      urls.push(token.slice("--url=".length));
    }
  }
  return urls;
}

function assertLoopbackUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "Editframe --url is invalid" };
  }
  if (parsed.protocol !== "http:" || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")) {
    return { ok: false, reason: "Editframe --url must be an http loopback URL" };
  }
  return { ok: true };
}

export function inspectCliArgs(argv) {
  const tokens = argv.filter((token) => token.length > 0);
  const command = tokens.find((token) => !token.startsWith("-")) ?? "";
  if (DENIED_COMMANDS.has(command) || (command && !ALLOWED_COMMANDS.has(command))) {
    return { ok: false, reason: `Editframe command '${command || tokens[0]}' is not allowed` };
  }
  const urls = collectUrlFlags(tokens);
  if (urls.length > 1) {
    return { ok: false, reason: "Editframe --url must not be repeated" };
  }
  if (urls.length === 1) {
    const check = assertLoopbackUrl(urls[0]);
    if (!check.ok) return check;
  }
  return { ok: true, command };
}

async function main(argv) {
  const inspection = inspectCliArgs(argv);
  if (!inspection.ok) {
    console.error(`${inspection.reason}. Allowed: --version, help, preview, render.`);
    process.exitCode = 1;
    return;
  }
  if (inspection.command === "preview") {
    const preview = await import("./preview.mjs");
    await preview.runPreviewCli(argv.filter((token) => token !== "preview"));
    return;
  }
  const runtime = resolveEditframeCli();
  if (!runtime.ok) {
    console.error(runtime.message ?? missingRuntimeMessage());
    process.exitCode = 1;
    return;
  }
  const handle = spawnOwned([process.execPath, runtime.cliPath, ...argv], {
    cwd: process.cwd(),
    env: childEnv(),
    stdio: "inherit"
  });
  const stop = async (code = 143) => {
    try {
      await stopOwned(handle);
    } catch {
      // still exit
    }
    process.exit(code);
  };
  process.on("SIGINT", () => {
    void stop(130);
  });
  process.on("SIGTERM", () => {
    void stop(143);
  });
  try {
    const code = await waitExit(handle, 10 * 60 * 1000);
    try {
      await stopOwned(handle);
    } catch {
      // descendants already gone
    }
    process.exitCode = code;
  } catch (error) {
    await stop(1);
    console.error(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main(process.argv.slice(2));
}
