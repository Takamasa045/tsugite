import { describe, expect, it } from "vitest";
// @ts-expect-error backend modules are plain ESM without type declarations
import {
  ARTICLE_DIALOGUE_CLAUDE_THEME,
  ARTICLE_DIALOGUE_DEFAULT_THEME,
  resolveArticleDialogueTheme
} from "../backends/remotion/presentation.mjs";

describe("article dialogue theme", () => {
  it("keeps the existing palette when no theme is declared", () => {
    expect(resolveArticleDialogueTheme(undefined)).toBe(ARTICLE_DIALOGUE_DEFAULT_THEME);
    expect(resolveArticleDialogueTheme({})).toBe(ARTICLE_DIALOGUE_DEFAULT_THEME);
    expect(resolveArticleDialogueTheme({ presentation: { preset: "article-dialogue-16x9" } })).toBe(
      ARTICLE_DIALOGUE_DEFAULT_THEME
    );

    expect(ARTICLE_DIALOGUE_DEFAULT_THEME.background).toContain("#f4efe6");
    expect(ARTICLE_DIALOGUE_DEFAULT_THEME.stepActive).toBe("#df7b37");
    expect(ARTICLE_DIALOGUE_DEFAULT_THEME.progress).toBe("linear-gradient(90deg, #df7b37, #3972b8)");
    expect(ARTICLE_DIALOGUE_DEFAULT_THEME.cardRadius).toBe(36);
  });

  it("resolves the Anthropic-leaning claude palette when requested", () => {
    const theme = resolveArticleDialogueTheme({ presentation: { preset: "article-dialogue-16x9", theme: "claude" } });

    expect(theme).toBe(ARTICLE_DIALOGUE_CLAUDE_THEME);
    expect(theme.background).toBe("#F0EEE6");
    expect(theme.stepActive).toBe("#D97757");
    expect(theme.progress).toBe("#D97757");
    expect(theme.cardRadius).toBe(16);
    expect(theme.cardShadow).toBe("none");
  });

  it("keeps dialogue body text sans-serif in every theme and only styles the headline", () => {
    for (const theme of [ARTICLE_DIALOGUE_DEFAULT_THEME, ARTICLE_DIALOGUE_CLAUDE_THEME]) {
      expect(theme.bodyFontFamily).toContain("Hiragino Sans");
      expect(theme.bodyFontFamily).not.toContain("Mincho");
    }

    expect(ARTICLE_DIALOGUE_DEFAULT_THEME.headlineFontFamily).toBe(ARTICLE_DIALOGUE_DEFAULT_THEME.bodyFontFamily);
    expect(ARTICLE_DIALOGUE_CLAUDE_THEME.headlineFontFamily).toContain("Mincho");
  });

  it("falls back to the default palette for an unknown theme id", () => {
    expect(resolveArticleDialogueTheme({ presentation: { theme: "does-not-exist" } })).toBe(
      ARTICLE_DIALOGUE_DEFAULT_THEME
    );
  });

  it("declares every token the composition reads so a theme cannot be partially defined", () => {
    const tokens = Object.keys(ARTICLE_DIALOGUE_DEFAULT_THEME).sort();
    expect(Object.keys(ARTICLE_DIALOGUE_CLAUDE_THEME).sort()).toEqual(tokens);
  });
});
