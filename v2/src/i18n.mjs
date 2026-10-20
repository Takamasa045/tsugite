import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { fail } from './files.mjs';

export const SUPPORTED_LANGUAGES = ['en', 'ja'];
export const DEFAULT_LANGUAGE = 'en';

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'locales');
const catalogCache = new Map();

export function localesDir() {
  return LOCALES_DIR;
}

export function normalizeLanguage(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'ja' || trimmed === 'en') return trimmed;
  const primary = trimmed.split(/[-_]/)[0];
  if (primary === 'ja' || primary === 'en') return primary;
  return undefined;
}

export function flattenCatalog(value, prefix = '') {
  if (typeof value === 'string') return prefix ? { [prefix]: value } : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    Object.assign(out, flattenCatalog(child, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

export function loadCatalog(language) {
  const cached = catalogCache.get(language);
  if (cached) return cached;
  const parsed = JSON.parse(readFileSync(join(LOCALES_DIR, `${language}.json`), 'utf8'));
  const flattened = flattenCatalog(parsed);
  catalogCache.set(language, flattened);
  return flattened;
}

export function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, name) => (
    Object.hasOwn(params, name) ? String(params[name]) : match
  ));
}

/**
 * Look up a UI string. v2 default is en to keep the current English review page.
 * Missing keys fall back to en, then to the key itself.
 * This function does not read env or user config.
 */
export function t(key, params, lang = DEFAULT_LANGUAGE) {
  const requested = loadCatalog(lang)[key];
  const fallback = lang === DEFAULT_LANGUAGE ? undefined : loadCatalog(DEFAULT_LANGUAGE)[key];
  return interpolate(requested ?? fallback ?? key, params);
}

export function createTranslator(lang = DEFAULT_LANGUAGE) {
  return (key, params) => t(key, params, lang);
}

export function resolveLanguage(sources, fallback = DEFAULT_LANGUAGE) {
  const candidates = [
    ['cli', sources.cliLang],
    ['env', sources.envLang],
    ['user', sources.userConfigLang],
    ['project', sources.projectLang]
  ];
  for (const [source, value] of candidates) {
    const language = normalizeLanguage(value);
    if (language) return { language, source };
  }
  return { language: fallback, source: 'default' };
}

function configHome(options = {}) {
  const home = options.homeDir ?? homedir();
  const env = options.env ?? (options.homeDir ? {} : process.env);
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return xdg && isAbsolute(xdg) ? xdg : join(home, '.config');
}

function parseConfig(text) {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  return parse(trimmed, { maxAliasCount: 0 });
}

export function readUserConfigLang(options = {}) {
  const base = join(configHome(options), 'tsugite');
  const candidates = [base, join(base, 'config.yaml'), join(base, 'config.yml'), join(base, 'config.json'), join(base, 'config')];
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      const parsed = parseConfig(readFileSync(candidate, 'utf8'));
      const lang = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.lang : undefined;
      if (typeof lang === 'string') return lang;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function resolveLanguageFromEnvironment(options = {}) {
  const env = options.env ?? process.env;
  return resolveLanguage({
    cliLang: options.cliLang,
    envLang: env.TSUGITE_LANG,
    userConfigLang: readUserConfigLang({ env, homeDir: options.homeDir }),
    projectLang: options.projectLang
  }, options.fallback ?? DEFAULT_LANGUAGE);
}

export function extractLangOption(argv) {
  const rest = [];
  let lang;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--lang') {
      rest.push(argv[index]);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) fail(t('cli.lang_unsupported'));
    lang = value;
    index += 1;
  }
  return { argv: rest, lang };
}

export function missingCatalogKeys(source = loadCatalog('en'), target = loadCatalog('ja')) {
  return Object.keys(source).filter((key) => !Object.hasOwn(target, key)).sort();
}

export function resetCatalogCache() {
  catalogCache.clear();
}
