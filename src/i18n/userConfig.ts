import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parse } from "yaml";

export type UserConfigReadOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

function configHome(options: UserConfigReadOptions): string {
  const home = options.homeDir ?? homedir();
  // Pinning homeDir isolates from ambient XDG unless the caller also passed env.
  const env = options.env ?? (options.homeDir ? {} : process.env);
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return xdg && isAbsolute(xdg) ? xdg : join(home, ".config");
}

export function userConfigCandidates(options: UserConfigReadOptions = {}): string[] {
  const base = join(configHome(options), "tsugite");
  return [
    base,
    join(base, "config.yaml"),
    join(base, "config.yml"),
    join(base, "config.json"),
    join(base, "config")
  ];
}

function parseConfig(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  return parse(trimmed, { maxAliasCount: 0 });
}

function langFromParsed(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const lang = (value as { lang?: unknown }).lang;
  return typeof lang === "string" ? lang : undefined;
}

/**
 * Read `lang` from the user config at ~/.config/tsugite (or $XDG_CONFIG_HOME/tsugite).
 * Missing, unreadable, or malformed files are ignored.
 */
export function readUserConfigLang(options: UserConfigReadOptions = {}): string | undefined {
  for (const candidate of userConfigCandidates(options)) {
    try {
      const stat = statSync(candidate);
      if (!stat.isFile()) continue;
      const parsed = parseConfig(readFileSync(candidate, "utf8"));
      const lang = langFromParsed(parsed);
      if (lang !== undefined) return lang;
    } catch {
      continue;
    }
  }
  return undefined;
}
