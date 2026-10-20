import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readUserConfigLang } from "./userConfig.js";

export const SUPPORTED_LANGUAGES = ["ja", "en"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: SupportedLanguage = "ja";

export type Catalog = { [key: string]: string | Catalog };
export type TranslateParams = Record<string, string | number>;
export type LanguageSource = "cli" | "env" | "user" | "project" | "default";

export type LanguageSources = {
  cliLang?: string | null;
  envLang?: string | null;
  userConfigLang?: string | null;
  projectLang?: string | null;
};

export type LanguageResolution = {
  language: SupportedLanguage;
  source: LanguageSource;
};

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "locales");
const catalogCache = new Map<SupportedLanguage, Record<string, string>>();

export function localesDir(): string {
  return LOCALES_DIR;
}

export function normalizeLanguage(value: unknown): SupportedLanguage | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "ja" || trimmed === "en") return trimmed;
  const primary = trimmed.split(/[-_]/)[0];
  if (primary === "ja" || primary === "en") return primary;
  return undefined;
}

export function flattenCatalog(value: unknown, prefix = ""): Record<string, string> {
  if (typeof value === "string") return prefix ? { [prefix]: value } : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${key}` : key;
    Object.assign(out, flattenCatalog(child, next));
  }
  return out;
}

export function loadCatalog(language: SupportedLanguage): Record<string, string> {
  const cached = catalogCache.get(language);
  if (cached) return cached;
  const parsed: unknown = JSON.parse(readFileSync(join(LOCALES_DIR, `${language}.json`), "utf8"));
  const flattened = flattenCatalog(parsed);
  catalogCache.set(language, flattened);
  return flattened;
}

export function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, name: string) => (
    Object.hasOwn(params, name) ? String(params[name]) : match
  ));
}

/**
 * Look up a UI string. Default language is ja.
 * Missing keys in the requested language fall back to ja, then to the key itself.
 * This function does not read env or user config; callers pass a resolved language.
 */
export function t(
  key: string,
  params?: TranslateParams,
  lang: SupportedLanguage = DEFAULT_LANGUAGE
): string {
  const requested = loadCatalog(lang)[key];
  const fallback = lang === DEFAULT_LANGUAGE ? undefined : loadCatalog(DEFAULT_LANGUAGE)[key];
  return interpolate(requested ?? fallback ?? key, params);
}

export function createTranslator(lang: SupportedLanguage = DEFAULT_LANGUAGE) {
  return (key: string, params?: TranslateParams): string => t(key, params, lang);
}

export function resolveLanguage(
  sources: LanguageSources,
  fallback: SupportedLanguage = DEFAULT_LANGUAGE
): LanguageResolution {
  const candidates: Array<[LanguageSource, string | null | undefined]> = [
    ["cli", sources.cliLang],
    ["env", sources.envLang],
    ["user", sources.userConfigLang],
    ["project", sources.projectLang]
  ];
  for (const [source, value] of candidates) {
    const language = normalizeLanguage(value);
    if (language) return { language, source };
  }
  return { language: fallback, source: "default" };
}

export function resolveLanguageFromEnvironment(options: {
  cliLang?: string | null;
  projectLang?: string | null;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fallback?: SupportedLanguage;
} = {}): LanguageResolution {
  const env = options.env ?? process.env;
  return resolveLanguage({
    cliLang: options.cliLang,
    envLang: env.TSUGITE_LANG,
    userConfigLang: readUserConfigLang({ env, homeDir: options.homeDir }),
    projectLang: options.projectLang
  }, options.fallback ?? DEFAULT_LANGUAGE);
}

export function missingEnglishKeys(
  ja: Record<string, string> = loadCatalog("ja"),
  en: Record<string, string> = loadCatalog("en")
): string[] {
  return Object.keys(ja).filter((key) => !Object.hasOwn(en, key)).sort();
}

export function catalogKeyList(language: SupportedLanguage = DEFAULT_LANGUAGE): string[] {
  return Object.keys(loadCatalog(language)).sort();
}

/** Test-only: drop cached catalogs after writing temporary locale files. */
export function resetCatalogCache(): void {
  catalogCache.clear();
}
