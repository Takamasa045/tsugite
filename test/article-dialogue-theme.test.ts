import { describe, expect, it } from "vitest";
// @ts-expect-error backend modules are plain ESM without type declarations
import {
  ARTICLE_DIALOGUE_CLAUDE_THEME,
  ARTICLE_DIALOGUE_DEFAULT_THEME,
  resolveArticleDialogueTheme,
  resolveCharacterFrame
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
    expect(theme.background).toContain("#F0EEE6");
    expect(theme.background).toContain("radial-gradient");
    expect(theme.stepActive).toBe("#D97757");
    expect(theme.progress).toContain("#D97757");
    expect(theme.cardRadius).toBe(22);
    expect(theme.cardShadow).not.toBe("none");
    expect(theme.captionShadow).not.toBe("none");
  });

  it("keeps dialogue body text sans-serif in every theme and only styles the headline", () => {
    for (const theme of [ARTICLE_DIALOGUE_DEFAULT_THEME, ARTICLE_DIALOGUE_CLAUDE_THEME]) {
      expect(theme.bodyFontFamily).toContain("Hiragino Sans");
      expect(theme.bodyFontFamily).not.toContain("Mincho");
    }

    expect(ARTICLE_DIALOGUE_DEFAULT_THEME.headlineFontFamily).toBe(ARTICLE_DIALOGUE_DEFAULT_THEME.bodyFontFamily);
    expect(ARTICLE_DIALOGUE_CLAUDE_THEME.headlineFontFamily).toContain("Mincho");
  });

  it("brightens caption emphasis on the dark bar instead of dimming it", () => {
    // Default keeps the historical behaviour: emphasis takes the speaker accent.
    expect(ARTICLE_DIALOGUE_DEFAULT_THEME.captionEmphasis).toBeNull();
    // Claude's neutral speaker accent is darker than the caption ink, so emphasis
    // would read as de-emphasis. Pin it to the clay accent instead.
    expect(ARTICLE_DIALOGUE_CLAUDE_THEME.captionEmphasis).toBe("#D97757");
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

describe("character frame", () => {
  it("keeps opaque face art in the circular avatar frame", () => {
    expect(resolveCharacterFrame({ id: "a", src: "media/a.png" })).toBe("circle");
    expect(resolveCharacterFrame({ id: "a", src: "media/a.png", alpha_required: false })).toBe("circle");
  });

  it("renders alpha cutout art as a standing figure instead of cropping it to a circle", () => {
    expect(resolveCharacterFrame({ id: "a", src: "media/a.png", alpha_required: true })).toBe("cutout");
  });

  it("falls back to the circular frame when the image is missing", () => {
    expect(resolveCharacterFrame(undefined)).toBe("circle");
  });
});
