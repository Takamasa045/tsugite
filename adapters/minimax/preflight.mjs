/**
 * MiniMax model preflight (Phase A).
 * Never submits generation. Never prints secret values.
 *
 * Official subcommand evidence: `mmx video generate --help` (2026-08-08)
 * supports `--model MiniMax-H3` and `--last-frame` alone for H3.
 */
import {
  buildMinimaxDryRunArgv,
  MINIMAX_H3_PROVIDER_MODEL,
  MINIMAX_MIN_CLI_VERSION,
  MINIMAX_SECRET_ENV_NAMES,
  preflightMinimaxConnection,
  resolveMinimaxProviderModel
} from "./minimaxCli.mjs";

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(chunks.join("")));
    process.stdin.on("error", reject);
  });
}

function commandExists(command) {
  return new Promise((resolve) => {
    import("node:child_process").then(({ spawn }) => {
      const child = spawn(command, ["--version"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0 || code === null));
    }).catch(() => resolve(false));
  });
}

async function resolveVersion() {
  try {
    const { spawn } = await import("node:child_process");
    return await new Promise((resolve) => {
      const child = spawn("mmx", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
      });
      child.on("error", () => resolve(null));
      child.on("exit", () => {
        const match = out.match(/(\d+\.\d+\.\d+)/);
        resolve(match?.[1] ?? null);
      });
    });
  } catch {
    return null;
  }
}

let requestId = "unknown";
try {
  const raw = await readStdin();
  const payload = raw ? JSON.parse(raw) : {};
  const request = payload.request ?? {};
  requestId = request.id ?? requestId;

  const connection = await preflightMinimaxConnection({
    commandExists,
    environment: process.env,
    resolveVersion,
    generationIntegrated: false
  });

  let providerModel = MINIMAX_H3_PROVIDER_MODEL;
  try {
    if (request.model) providerModel = resolveMinimaxProviderModel(request.model);
  } catch (error) {
    connection.issues.push({
      code: error.code ?? "H3-C009",
      message: error.message
    });
  }

  const dryRunArgv = request.last_frame
    ? buildMinimaxDryRunArgv({
      providerModel,
      prompt: request.prompt ?? "",
      lastFramePath: request.last_frame,
      firstFramePath: request.first_frame,
      duration: request.duration,
      ratio: request.aspect
    })
    : undefined;

  // Fail closed if an unhandled media field appears for last-frame-only.
  const unhandled = [];
  if (request.input_mode === "last-frame-to-video") {
    if (request.first_frame) unhandled.push("first_frame");
    if (request.input_images?.length) unhandled.push("input_images");
    if (request.reference_images?.length) unhandled.push("reference_images");
  }
  if (unhandled.length > 0) {
    connection.issues.push({
      code: "adapter.media_field.unhandled",
      message: `MiniMax last-frame-to-video does not handle: ${unhandled.join(", ")}`
    });
  }

  console.log(JSON.stringify({
    request_id: requestId,
    status: connection.status === "needs-setup" ? "unavailable" : "preflight-only",
    source: "minimax-mmx-cli",
    operation: request.operation ?? "video",
    input_mode: request.input_mode,
    provider_model: providerModel,
    min_cli_version: MINIMAX_MIN_CLI_VERSION,
    secret_env_names: MINIMAX_SECRET_ENV_NAMES,
    billing_action: false,
    generation_submitted: false,
    dry_run_argv: dryRunArgv,
    issues: connection.issues
  }));
} catch (error) {
  console.log(JSON.stringify({
    request_id: requestId,
    status: "unavailable",
    source: "minimax-mmx-cli",
    billing_action: false,
    generation_submitted: false,
    issues: [{
      code: "models.runtime_unavailable",
      message: error instanceof Error ? error.message : "MiniMax preflight failed"
    }]
  }));
}
