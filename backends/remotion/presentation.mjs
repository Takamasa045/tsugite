export const ARTICLE_DIALOGUE_PRESET = "article-dialogue-16x9";

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
  captionRadius: 26,
  captionShadow: "0 14px 40px rgba(27,25,23,0.22)",
  draftBorder: "#b87928",
  draftInk: "#8a5b1f",
  draftBackground: "rgba(255,255,255,0.72)"
});

/**
 * Anthropic-leaning palette: flat paper ground, one clay accent, serif display.
 * The serif is scoped to the centre headline; dialogue captions stay sans for legibility.
 */
export const ARTICLE_DIALOGUE_CLAUDE_THEME = Object.freeze({
  id: "claude",
  background: "#F0EEE6",
  ink: "#191919",
  bodyFontFamily: SANS,
  headlineFontFamily: SERIF,
  headlineWeight: 700,
  headlineLetterSpacing: "-0.01em",
  label: "#6A6A63",
  kicker: "#D97757",
  kickerBackground: "rgba(250,249,245,0.94)",
  detail: "#3D3D3A",
  cardBackground: "#FAF9F5",
  cardBorder: "1px solid rgba(25, 25, 25, 0.12)",
  cardRadius: 16,
  cardShadow: "none",
  imagePlaceholder: "#E8E5DC",
  stepActive: "#D97757",
  stepIdle: "#CFCCC0",
  stepBackground: "#F0EEE6",
  stepInk: "#3D3D3A",
  badgeBackground: "#E8E5DC",
  badgeInk: "#6A6A63",
  badgeRadius: 8,
  progressTrack: "rgba(25,25,25,0.08)",
  progress: "#D97757",
  characterBackground: "#FAF9F5",
  nameIdle: "#6A6A63",
  characterRadius: "50%",
  captionBackground: "#1F1E1D",
  captionInk: "#F0EEE6",
  captionRadius: 14,
  captionShadow: "none",
  draftBorder: "#D97757",
  draftInk: "#B4573A",
  draftBackground: "rgba(250,249,245,0.9)"
});

const ARTICLE_DIALOGUE_THEMES = new Map([
  [ARTICLE_DIALOGUE_DEFAULT_THEME.id, ARTICLE_DIALOGUE_DEFAULT_THEME],
  [ARTICLE_DIALOGUE_CLAUDE_THEME.id, ARTICLE_DIALOGUE_CLAUDE_THEME]
]);

export function resolveArticleDialogueTheme(manifest) {
  return ARTICLE_DIALOGUE_THEMES.get(manifest?.presentation?.theme) ?? ARTICLE_DIALOGUE_DEFAULT_THEME;
}

export function designScale(width, height) {
  return Math.min(width / 1920, height / 1080);
}

export function activeCaptionAt(captions, second) {
  return (captions ?? []).find((caption) => second >= caption.start && second < caption.end);
}

const MOUTH_PATTERN = [0, 1, 2, 1];

export function mouthFrameIndex(localFrame, fps, mouthFps = 8) {
  const framesPerMouthState = Math.max(1, Math.round(fps / mouthFps));
  return MOUTH_PATTERN[Math.floor(Math.max(0, localFrame) / framesPerMouthState) % MOUTH_PATTERN.length];
}

export function resolveSpeakerImage(speaker, caption, images, frame = 0, fps = 30, mouthFps = 8) {
  if (!speaker) return undefined;
  const isActive = caption?.speaker === speaker.id;
  const requestedPose = isActive ? caption.pose : undefined;
  const localFrame = isActive ? Math.max(0, frame - Math.round((caption?.start ?? 0) * fps)) : 0;
  const imageId =
    (isActive && speaker.mouth_frames?.length === 3
      ? speaker.mouth_frames[mouthFrameIndex(localFrame, fps, mouthFps)]
      : undefined) ??
    (requestedPose ? speaker.poses?.[requestedPose] : undefined) ??
    speaker.poses?.neutral ??
    Object.values(speaker.poses ?? {})[0];
  return (images ?? []).find((image) => image.id === imageId);
}

export function emphasizedTextParts(text, emphasis = []) {
  const terms = [...new Set(emphasis.filter((term) => term.length > 0))].sort((left, right) => right.length - left.length);
  if (terms.length === 0) return [{ text, emphasized: false }];
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "g");
  return text
    .split(pattern)
    .filter(Boolean)
    .map((part) => ({ text: part, emphasized: terms.includes(part) }));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
