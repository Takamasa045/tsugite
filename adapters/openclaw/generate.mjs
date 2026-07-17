import crossSpawn from "cross-spawn";

const spawnSync = crossSpawn.sync;

const command = process.env.TSUGITE_OPENCLAW_GENERATE_COMMAND;

class AdapterError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

try {
  const input = await readStdin();
  const payload = JSON.parse(input);
  if (!payload.request?.id || !payload.run_id || !payload.run_dir) {
    throw new AdapterError("missing request, run_id, or run_dir", 40);
  }

  if (!command) {
    throw new AdapterError("TSUGITE_OPENCLAW_GENERATE_COMMAND is required for the optional OpenClaw adapter", 40);
  }

  const bridge = parseBridgeCommand(command);
  const result = spawnSync(bridge.executable, bridge.args, {
    input: `${JSON.stringify(payload)}\n`,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20
  });

  if (result.error) {
    throw new AdapterError(result.error.message, 20);
  }

  if (result.status !== 0) {
    process.stderr.write("OpenClaw bridge command failed");
    process.exit(result.status ?? 1);
  }

  process.stdout.write(result.stdout);
} catch (error) {
  const normalized = normalizeError(error);
  console.error(normalized.message);
  process.exit(normalized.exitCode);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function normalizeError(error) {
  if (error instanceof AdapterError) return { message: error.message, exitCode: error.exitCode };
  if (error instanceof SyntaxError) return { message: error.message, exitCode: 40 };
  return { message: error instanceof Error ? error.message : String(error), exitCode: 1 };
}

function parseBridgeCommand(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AdapterError("TSUGITE_OPENCLAW_GENERATE_COMMAND must be a JSON array command", 40);
  }

  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((part) => typeof part === "string" && part.length > 0)) {
    throw new AdapterError("TSUGITE_OPENCLAW_GENERATE_COMMAND must be a non-empty JSON array of strings", 40);
  }

  const [executable, ...args] = parsed;
  return { executable, args };
}
