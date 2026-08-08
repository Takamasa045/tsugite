/**
 * MiniMax direct CLI helpers (Phase A: preflight / dry-run argv only).
 *
 * Official evidence (2026-08-08):
 * - CLI: https://github.com/MiniMax-AI/cli — `mmx video generate`
 * - Help: MiniMax-H3 supports `--last-frame` alone; SEF legacy still pairs `--image`+`--last-frame`.
 * - Subcommand is `video generate` (not bare `video`).
 *
 * Never reads/prints secret values. Never submits generation in this module.
 */

export const MINIMAX_H3_IR_MODEL = "minimax-h3";
export const MINIMAX_H3_PROVIDER_MODEL = "MiniMax-H3";
export const MINIMAX_MIN_CLI_VERSION = "1.0.19";
export const MINIMAX_SECRET_ENV_NAMES = Object.freeze(["MINIMAX_API_KEY"]);

/**
 * Explicit IR → provider model mapping. No fuzzy conversion.
 * @param {string} irModel
 * @returns {string}
 */
export function resolveMinimaxProviderModel(irModel) {
  if (irModel === MINIMAX_H3_IR_MODEL) return MINIMAX_H3_PROVIDER_MODEL;
  const error = new Error(
    `H3-C009 provider model mapping missing for ir model '${irModel}'`
  );
  error.code = "H3-C009";
  throw error;
}

/**
 * Compare dotted numeric versions (major.minor.patch). Returns -1/0/1.
 * @param {string} left
 * @param {string} right
 */
export function compareSemver(left, right) {
  const parse = (value) =>
    String(value)
      .replace(/^v/i, "")
      .split(/[^\d]+/)
      .filter(Boolean)
      .map((part) => Number.parseInt(part, 10));
  const a = parse(left);
  const b = parse(right);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

/**
 * Build argv for `mmx` after the executable name.
 * Always includes `--dry-run`. Never shell-concatenates.
 *
 * @param {{
 *   providerModel: string,
 *   prompt: string,
 *   lastFramePath?: string,
 *   firstFramePath?: string,
 *   duration?: number,
 *   ratio?: string
 * }} options
 * @returns {string[]}
 */
export function buildMinimaxDryRunArgv(options) {
  const argv = [
    "video",
    "generate",
    "--model",
    options.providerModel,
    "--prompt",
    options.prompt,
    "--dry-run"
  ];
  if (options.lastFramePath) {
    argv.push("--last-frame", options.lastFramePath);
  }
  if (options.firstFramePath) {
    argv.push("--image", options.firstFramePath);
  }
  if (options.duration !== undefined) {
    argv.push("--duration", String(options.duration));
  }
  if (options.ratio) {
    // Official CLI uses --ratio for H3 aspect.
    argv.push("--ratio", options.ratio === "auto" ? "adaptive" : options.ratio);
  }
  return argv;
}

/**
 * @param {{
 *   commandExists: (command: string) => Promise<boolean>,
 *   environment?: NodeJS.ProcessEnv,
 *   resolveVersion?: () => Promise<string | null>,
 *   generationIntegrated?: boolean
 * }} options
 */
export async function preflightMinimaxConnection(options) {
  const environment = options.environment ?? {};
  const generationIntegrated = options.generationIntegrated ?? false;
  const issues = [];
  const secretEnvNames = [...MINIMAX_SECRET_ENV_NAMES];

  const exists = await options.commandExists("mmx");
  if (!exists) {
    return {
      status: "needs-setup",
      billing_action: false,
      generation_submitted: false,
      min_cli_version: MINIMAX_MIN_CLI_VERSION,
      secret_env_names: secretEnvNames,
      provider_model: MINIMAX_H3_PROVIDER_MODEL,
      generation_route: generationIntegrated ? "integrated" : "preflight-only",
      issues: [{
        code: "adapter.cli.missing",
        message: "mmx CLI is not available on PATH"
      }]
    };
  }

  const version = options.resolveVersion ? await options.resolveVersion() : null;
  if (version && compareSemver(version, MINIMAX_MIN_CLI_VERSION) < 0) {
    issues.push({
      code: "adapter.cli.version_unsupported",
      message: `mmx ${version} is below required ${MINIMAX_MIN_CLI_VERSION}`
    });
    return {
      status: "needs-setup",
      billing_action: false,
      generation_submitted: false,
      min_cli_version: MINIMAX_MIN_CLI_VERSION,
      detected_cli_version: version,
      secret_env_names: secretEnvNames,
      provider_model: MINIMAX_H3_PROVIDER_MODEL,
      generation_route: "preflight-only",
      issues
    };
  }

  // Never mark ready for generation in Phase A.
  const status = generationIntegrated ? "needs-verification" : "not-integrated";
  // Touch env keys by name only — do not copy values into the result.
  const configuredSecrets = secretEnvNames.filter((name) => {
    const value = environment[name];
    return typeof value === "string" && value.trim().length > 0;
  });

  return {
    status,
    billing_action: false,
    generation_submitted: false,
    min_cli_version: MINIMAX_MIN_CLI_VERSION,
    detected_cli_version: version ?? undefined,
    secret_env_names: secretEnvNames,
    secret_env_configured: configuredSecrets,
    provider_model: MINIMAX_H3_PROVIDER_MODEL,
    generation_route: generationIntegrated ? "integrated" : "preflight-only",
    issues
  };
}
