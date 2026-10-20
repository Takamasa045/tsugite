import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGE,
  catalogKeyList,
  createTranslator,
  flattenCatalog,
  interpolate,
  localesDir,
  missingEnglishKeys,
  normalizeLanguage,
  resetCatalogCache,
  resolveLanguage,
  resolveLanguageFromEnvironment,
  t
} from "../src/i18n/index.js";
import { nextNonGlobalIndex } from "../src/i18n/cliLang.js";
import { readUserConfigLang, userConfigCandidates } from "../src/i18n/userConfig.js";
import { projectSchema } from "../src/project/schema.js";

const originalLang = process.env.TSUGITE_LANG;

afterEach(() => {
  if (originalLang === undefined) delete process.env.TSUGITE_LANG;
  else process.env.TSUGITE_LANG = originalLang;
});

describe("i18n catalog", () => {
  it("pins t() to Japanese by default", () => {
    process.env.TSUGITE_LANG = "en";
    expect(DEFAULT_LANGUAGE).toBe("ja");
    expect(t("meta.language_name")).toBe("日本語");
    expect(t("meta.product")).toBe("継手");
    expect(createTranslator()("cli.lang_summary")).toBe("表示言語（ja または en）");
  });

  it("interpolates named params and leaves unknown placeholders", () => {
    expect(interpolate("絵コンテ尺 {storyboard} と目標尺 {target}", {
      storyboard: "10秒",
      target: "12秒"
    })).toBe("絵コンテ尺 10秒 と目標尺 12秒");
    expect(interpolate("id {id}", {})).toBe("id {id}");
  });

  it("falls back to ja when the English key is missing", () => {
    const ja = { "review.only_ja": "日本語だけ" };
    const en = { "review.shared": "Shared" };
    expect(missingEnglishKeys(ja, en)).toEqual(["review.only_ja"]);
    expect(t("meta.language_name", undefined, "en")).toBe("English");
    expect(t("i18n.missing.key", undefined, "en")).toBe("i18n.missing.key");
  });

  it("flattens nested catalogs", () => {
    expect(flattenCatalog({ review: { title: "確認ポイント" } })).toEqual({
      "review.title": "確認ポイント"
    });
    expect(flattenCatalog("bare")).toEqual({});
    expect(flattenCatalog(["x"])).toEqual({});
    expect(localesDir()).toMatch(/locales$/);
    resetCatalogCache();
    expect(t("meta.product", undefined, "ja")).toBe("継手");
  });
});

describe("language resolution", () => {
  it("uses CLI --lang, then env, user config, project, then ja", () => {
    expect(resolveLanguage({
      cliLang: "en",
      envLang: "ja",
      userConfigLang: "ja",
      projectLang: "ja"
    })).toEqual({ language: "en", source: "cli" });
    expect(resolveLanguage({
      envLang: "en",
      userConfigLang: "ja",
      projectLang: "ja"
    })).toEqual({ language: "en", source: "env" });
    expect(resolveLanguage({
      userConfigLang: "en",
      projectLang: "ja"
    })).toEqual({ language: "en", source: "user" });
    expect(resolveLanguage({ projectLang: "en" })).toEqual({ language: "en", source: "project" });
    expect(resolveLanguage({})).toEqual({ language: "ja", source: "default" });
  });

  it("skips --json and --lang when finding the CLI command", () => {
    expect(nextNonGlobalIndex(["--json", "--lang", "en", "review", "--config", "p.yaml"])).toBe(3);
    expect(nextNonGlobalIndex(["review", "--lang", "ja"])).toBe(0);
  });

  it("skips invalid values and accepts ja-JP / en-US", () => {
    expect(normalizeLanguage("ja-JP")).toBe("ja");
    expect(normalizeLanguage("en_US")).toBe("en");
    expect(normalizeLanguage("fr")).toBeUndefined();
    expect(resolveLanguage({
      cliLang: "fr",
      envLang: "de",
      userConfigLang: "en-US"
    })).toEqual({ language: "en", source: "user" });
  });

  it("reads user config lang from XDG tsugite config", async () => {
    const home = await mkdtemp(join(tmpdir(), "tsugite-i18n-"));
    const xdg = join(home, "xdg-config");
    await mkdir(join(xdg, "tsugite"), { recursive: true });
    await writeFile(join(xdg, "tsugite", "config.yaml"), "lang: en\n", "utf8");

    expect(userConfigCandidates({ env: { XDG_CONFIG_HOME: xdg }, homeDir: home })[0])
      .toBe(join(xdg, "tsugite"));
    expect(readUserConfigLang({ env: { XDG_CONFIG_HOME: xdg }, homeDir: home })).toBe("en");
    expect(resolveLanguageFromEnvironment({
      env: { XDG_CONFIG_HOME: xdg },
      homeDir: home
    })).toEqual({ language: "en", source: "user" });
  });

  it("lets TSUGITE_LANG beat user config and project lang", async () => {
    const home = await mkdtemp(join(tmpdir(), "tsugite-i18n-env-"));
    await mkdir(join(home, ".config", "tsugite"), { recursive: true });
    await writeFile(join(home, ".config", "tsugite", "config.json"), "{\"lang\":\"ja\"}\n", "utf8");

    expect(resolveLanguageFromEnvironment({
      env: { TSUGITE_LANG: "en" },
      homeDir: home,
      projectLang: "ja"
    })).toEqual({ language: "en", source: "env" });
  });

  it("ignores missing or malformed user config", async () => {
    const home = await mkdtemp(join(tmpdir(), "tsugite-i18n-empty-"));
    expect(readUserConfigLang({ homeDir: home })).toBeUndefined();
    await mkdir(join(home, ".config", "tsugite"), { recursive: true });
    await writeFile(join(home, ".config", "tsugite", "config.yaml"), "lang: [broken", "utf8");
    expect(readUserConfigLang({ homeDir: home })).toBeUndefined();
    expect(normalizeLanguage(1)).toBeUndefined();
    expect(resolveLanguageFromEnvironment({
      cliLang: "EN",
      env: { TSUGITE_LANG: "ja", XDG_CONFIG_HOME: "relative-xdg" },
      homeDir: home,
      projectLang: "ja"
    })).toEqual({ language: "en", source: "cli" });
  });

  it("reads lang from a file at ~/.config/tsugite", async () => {
    const home = await mkdtemp(join(tmpdir(), "tsugite-i18n-file-"));
    await mkdir(join(home, ".config"), { recursive: true });
    await writeFile(join(home, ".config", "tsugite"), "lang: ja\n", "utf8");
    expect(readUserConfigLang({ homeDir: home })).toBe("ja");
  });
});

describe("project.yaml lang", () => {
  it("accepts optional ja or en and rejects other values", () => {
    const base = {
      slug: "i18n-project",
      name: "言語検証",
      manifest: "manifest.json",
      edit: { backend: "remotion" }
    };
    expect(projectSchema.safeParse(base).success).toBe(true);
    expect(projectSchema.safeParse({ ...base, lang: "en" }).success).toBe(true);
    expect(projectSchema.safeParse({ ...base, lang: "ja" }).success).toBe(true);
    expect(projectSchema.safeParse({ ...base, lang: "fr" }).success).toBe(false);
  });
});

describe("English catalog completeness", () => {
  it("fails when ja keys are missing from en", () => {
    expect(missingEnglishKeys()).toEqual([]);
    expect(catalogKeyList("ja")).toEqual(catalogKeyList("en"));
  });
});
