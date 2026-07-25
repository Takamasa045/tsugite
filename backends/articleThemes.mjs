/**
 * Palette tokens for the article-explainer look, shared by every editing backend.
 * Engine-specific rendering stays in the backend directories; only the design data lives here.
 */

const SANS = '"Hiragino Sans", "Yu Gothic", "Noto Sans JP", sans-serif';
const SERIF = '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif';

/** Palette shipped with the preset. Manifests without `presentation.theme` keep rendering exactly this. */
export const ARTICLE_DIALOGUE_DEFAULT_THEME = Object.freeze({
  id: "default",
  background:
    "radial-gradient(circle at 18% 12%, rgba(238, 153, 82, 0.14), transparent 30%), radial-gradient(circle at 82% 10%, rgba(57, 108, 177, 0.14), transparent 32%), #f4efe6",
  ink: "#241f1a",
  bodyFontFamily: SANS,
  headlineFontFamily: SANS,
  headlineWeight: 900,
  headlineLetterSpacing: "-0.03em",
  label: "#8a7a68",
  kicker: "#9b6a33",
  kickerBackground: "rgba(255,255,255,0.9)",
  detail: "#64584e",
  cardBackground: "rgba(255, 255, 255, 0.88)",
  cardBorder: "2px solid rgba(54, 44, 36, 0.1)",
  cardRadius: 36,
  cardShadow: "0 20px 60px rgba(75, 58, 43, 0.12)",
  imagePlaceholder: "#efe7db",
  stepActive: "#df7b37",
  stepIdle: "#d7cdc0",
  stepBackground: "#f3ebe0",
  stepInk: "#3c342c",
  badgeBackground: "#efe5d5",
  badgeInk: "#5d5145",
  badgeRadius: 999,
  progressTrack: "rgba(36,31,26,0.08)",
  progress: "linear-gradient(90deg, #df7b37, #3972b8)",
  characterBackground: "white",
  nameIdle: "#7a7168",
  characterRadius: "50% 50% 42% 42%",
  captionBackground: "rgba(27, 25, 23, 0.92)",
  captionInk: "white",
  captionEmphasis: null,
  captionRadius: 26,
  captionShadow: "0 14px 40px rgba(27,25,23,0.22)",
  draftBorder: "#b87928",
  draftInk: "#8a5b1f",
  draftBackground: "rgba(255,255,255,0.72)"
});

/**
 * Anthropic-leaning palette: warm paper ground, one clay accent, serif display.
 * Depth stays soft (no neon, no multi-hue chrome) so it still reads as Claude UI.
 * The serif is scoped to the centre headline; dialogue captions stay sans for legibility.
 */
export const ARTICLE_DIALOGUE_CLAUDE_THEME = Object.freeze({
  id: "claude",
  background:
    "radial-gradient(ellipse 70% 55% at 12% 18%, rgba(217, 119, 87, 0.14), transparent 55%), radial-gradient(ellipse 55% 50% at 88% 12%, rgba(120, 140, 160, 0.10), transparent 50%), radial-gradient(ellipse 80% 60% at 50% 100%, rgba(217, 119, 87, 0.07), transparent 55%), #F0EEE6",
  ink: "#191919",
  bodyFontFamily: SANS,
  headlineFontFamily: SERIF,
  headlineWeight: 700,
  headlineLetterSpacing: "-0.01em",
  label: "#6A6A63",
  kicker: "#D97757",
  kickerBackground: "rgba(217, 119, 87, 0.12)",
  detail: "#3D3D3A",
  cardBackground: "linear-gradient(180deg, #FFFEFA 0%, #FAF9F5 100%)",
  cardBorder: "1px solid rgba(25, 25, 25, 0.08)",
  cardRadius: 22,
  cardShadow: "0 28px 70px rgba(25, 25, 25, 0.08), 0 4px 14px rgba(25, 25, 25, 0.04)",
  imagePlaceholder: "#E8E5DC",
  stepActive: "#D97757",
  stepIdle: "#CFCCC0",
  stepBackground: "rgba(240, 238, 230, 0.92)",
  stepInk: "#3D3D3A",
  badgeBackground: "rgba(232, 229, 220, 0.95)",
  badgeInk: "#5A5A54",
  badgeRadius: 999,
  progressTrack: "rgba(25,25,25,0.08)",
  progress: "linear-gradient(90deg, #E8A090 0%, #D97757 55%, #C45D3E 100%)",
  characterBackground: "#FAF9F5",
  nameIdle: "#6A6A63",
  characterRadius: "50%",
  captionBackground: "rgba(31, 30, 29, 0.94)",
  captionInk: "#F0EEE6",
  captionEmphasis: "#D97757",
  captionRadius: 18,
  captionShadow: "0 18px 48px rgba(25, 25, 25, 0.22)",
  draftBorder: "#D97757",
  draftInk: "#B4573A",
  draftBackground: "rgba(250,249,245,0.92)"
});

const ARTICLE_DIALOGUE_THEMES = new Map([
  [ARTICLE_DIALOGUE_DEFAULT_THEME.id, ARTICLE_DIALOGUE_DEFAULT_THEME],
  [ARTICLE_DIALOGUE_CLAUDE_THEME.id, ARTICLE_DIALOGUE_CLAUDE_THEME]
]);

export function resolveArticleDialogueTheme(manifest) {
  return ARTICLE_DIALOGUE_THEMES.get(manifest?.presentation?.theme) ?? ARTICLE_DIALOGUE_DEFAULT_THEME;
}

/**
 * Speaker art comes in two shapes. Opaque face closeups are cropped into the
 * circular avatar; alpha cutouts are full-body art, so cropping them to a circle
 * would cut the head off — render those as a standing figure instead.
 */
