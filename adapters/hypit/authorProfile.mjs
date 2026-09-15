/**
 * Fixed safe authoring-agent profile.
 * Flags come from `codex-cli 0.153.2` `codex exec --help` and `codex features list`.
 * Users do not set TSUGITE_AUTHORING_AGENT_ARGV. Browser cannot choose argv.
 */
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CODEX_BIN_NAME = "codex";
export const CODEX_CLI_VERSION = "0.153.2";

/** `codex features list` names disabled so user MCP/hooks/plugins are not loaded. */
export const AUTHOR_DISABLE_FEATURES = Object.freeze([
  "hooks",
  "plugins",
  "enable_mcp_apps",
  "browser_use",
  "computer_use",
  "image_generation",
  "multi_agent"
]);

export const DEFAULT_SCHEMA_PATH = fileURLToPath(new URL("./author-output.schema.json", import.meta.url));

export function authorSandboxDir(workspace) {
  return join(workspace, ".author-sandbox");
}

export function pathDelimiter(platform = process.platform) {
  return platform === "win32" ? ";" : ":";
}

function parentAbsolutePathDirs(pathValue, platform) {
  if (typeof pathValue !== "string" || pathValue.length === 0) return [];
  const dirs = [];
  for (const part of pathValue.split(pathDelimiter(platform))) {
    if (part.length === 0) continue;
    if (part.includes("\0")) continue;
    if (!isAbsolute(part)) continue;
    dirs.push(part);
  }
  return dirs;
}

function isLaunchableFile(path) {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return false;
  if (st.isFile()) return true;
  if (st.isSymbolicLink()) return existsSync(path);
  return false;
}

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * Resolve Codex from parent PATH absolute entries only.
 * Empty and project-relative PATH entries are ignored (never resolved against cwd).
 * Windows `.cmd` / `.bat` wrappers need a shell and are unsupported.
 */
export function resolveCodexExecutable(source = process.env, options = {}) {
  const platform = options.platform ?? process.platform;
  const envPath = typeof source?.PATH === "string"
    ? source.PATH
    : (platform === "win32" && typeof source?.Path === "string" ? source.Path : "");
  const dirs = parentAbsolutePathDirs(envPath, platform);
  let sawCmdWrapper = false;
  const name = platform === "win32" ? "codex.exe" : CODEX_BIN_NAME;

  for (const dir of dirs) {
    if (platform === "win32") {
      if (existsSync(join(dir, "codex.cmd")) || existsSync(join(dir, "codex.bat"))) {
        sawCmdWrapper = true;
      }
    }
    const candidate = join(dir, name);
    if (!isAbsolute(candidate) || !isLaunchableFile(candidate)) continue;
    return {
      command: candidate,
      argsPrefix: [],
      executable: candidate,
      kind: "direct",
      platform
    };
  }

  if (platform === "win32" && sawCmdWrapper) {
    throw coded(
      "Codex .cmd/.bat wrappers are unsupported: they require a shell. Author launch uses shell:false only.",
      "AUTHOR_AGENT_UNSUPPORTED"
    );
  }
  throw coded(
    "Codex CLI was not found as an absolute executable on PATH. Relative and empty PATH entries are ignored.",
    "AUTHOR_AGENT_MISSING"
  );
}

export function defaultCodexExecArgv(input) {
  const resolved = input.resolved ?? resolveCodexExecutable(input.env ?? process.env, input.resolve ?? {});
  const workspace = input.workspace;
  const schemaPath = input.schemaPath ?? DEFAULT_SCHEMA_PATH;
  const lastMessagePath = input.lastMessagePath ?? join(authorSandboxDir(workspace), "last-message.txt");
  const disable = AUTHOR_DISABLE_FEATURES.flatMap((name) => ["--disable", name]);
  return [
    resolved.command,
    ...(resolved.argsPrefix ?? []),
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    "workspace-write",
    "-c",
    "sandbox_workspace_write.network_access=false",
    ...disable,
    "-C",
    workspace,
    "--output-schema",
    schemaPath,
    "--output-last-message",
    lastMessagePath,
    "--json",
    "--color",
    "never",
    "-"
  ];
}

/**
 * Isolated HOME/TMPDIR. Auth still uses CODEX_HOME (Codex help: ignore-user-config
 * does not load config.toml; auth still uses CODEX_HOME). Do not log this env.
 */
export function authorChildEnv(source = process.env, input) {
  mkdirSync(input.home, { recursive: true });
  mkdirSync(input.tmpdir, { recursive: true });
  const env = {
    HOME: input.home,
    TMPDIR: input.tmpdir,
    PATH: typeof source.PATH === "string" && source.PATH.length > 0
      ? source.PATH
      : "/opt/homebrew/bin:/usr/bin:/bin",
    NO_COLOR: "1"
  };
  if (typeof source.LANG === "string" && source.LANG.length > 0) env.LANG = source.LANG;
  if (typeof source.LC_ALL === "string" && source.LC_ALL.length > 0) env.LC_ALL = source.LC_ALL;
  if (typeof source.TZ === "string" && source.TZ.length > 0) env.TZ = source.TZ;
  if (typeof source.CODEX_HOME === "string" && source.CODEX_HOME.length > 0) {
    env.CODEX_HOME = source.CODEX_HOME;
  } else if (typeof source.HOME === "string" && source.HOME.length > 0) {
    env.CODEX_HOME = join(source.HOME, ".codex");
  } else {
    env.CODEX_HOME = join(homedir(), ".codex");
  }
  return env;
}

export function assertCodexBinAvailable(source = process.env, options = {}) {
  return resolveCodexExecutable(source, options);
}

export function parentAuthorCommand(productionRoot) {
  return `npm run hypit:production -- author --production ${productionRoot}`;
}
