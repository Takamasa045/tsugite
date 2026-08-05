/**
 * HTML document generation for the HyperFrames backend.
 *
 * Kept separate from `render.mjs` because that file runs its pipeline on import
 * and therefore cannot be exercised by tests.
 *
 * Two modes:
 *   - no `presentation.theme`: the historical plain document (video + subtitle bar).
 *   - a known theme: article-explainer layers driven by `captions[].visual`.
 *
 * Every element the runtime must schedule carries `data-start`, `data-duration`
 * and `data-track-index`, and nothing is loaded from an external URL.
 */

import { resolveArticleDialogueTheme } from "../articleThemes.mjs";
import { buildTimelineProgram, renderTimelineRuntime } from "./timeline.mjs";
import { resolveOutputDimensions } from "../outputDimensions.mjs";

export const LOCAL_TIMELINE_RUNTIME = "tsugite-gsap-runtime.js";

/**
 * Motion is only wired up for themed documents; a plain manifest keeps the inert
 * runtime it has always had, so nothing moves that did not move before.
 */
export function renderRuntimeSource(manifest) {
  return renderTimelineRuntime(isThemed(manifest) ? buildTimelineProgram(manifest) : []);
}

const VISUAL_TRACK_BASE = 40;
const CAST_TRACK_BASE = 100;

export function renderIndexHtml(manifest) {
  const size = compositionSize(manifest);
  const duration = manifest.meta.target_duration_seconds;
  const themed = isThemed(manifest);
  const theme = resolveArticleDialogueTheme(manifest);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=${size.width},height=${size.height},initial-scale=1">
  <style>
${themed ? themedStyles(manifest, size, theme) : plainStyles(manifest, size)}
  </style>
  <script src="./${LOCAL_TIMELINE_RUNTIME}"></script>
</head>
<body>
  <div id="tsugite-render" data-composition-id="tsugite-render" data-start="0" data-duration="${duration}" data-width="${size.width}" data-height="${size.height}">
${renderClips(manifest.clips)}
${renderAudio(manifest.audio)}
${themed ? renderVisualLayers(manifest) : ""}
${renderCaptions(manifest.captions, themed, manifest.speakers)}
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    window.__timelines["tsugite-render"] = gsap.timeline({ paused: true });
  </script>
</body>
</html>
`;
}

function isThemed(manifest) {
  return typeof manifest.presentation?.theme === "string" && manifest.presentation.theme.length > 0;
}

function plainStyles(manifest, size) {
  return `    html, body {
      margin: 0;
      width: ${size.width}px;
      height: ${size.height}px;
      overflow: hidden;
      background: #050505;
      font-family: Arial, sans-serif;
    }
    #tsugite-render {
      position: relative;
      width: ${size.width}px;
      height: ${size.height}px;
      overflow: hidden;
      background: #050505;
    }
    video {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      background: #050505;
    }
    .caption {
      position: absolute;
      left: 7%;
      right: 7%;
      bottom: 8%;
      padding: 24px 32px;
      color: #ffffff;
      background: rgba(0, 0, 0, 0.68);
      border-radius: 8px;
      font-size: ${manifest.meta.aspect === "9:16" ? 48 : 36}px;
      line-height: 1.28;
      text-align: center;
      text-wrap: balance;
    }`;
}

const GENERIC_FAMILIES = new Set(["sans-serif", "serif", "monospace", "cursive", "fantasy", "system-ui"]);

/**
 * HyperFrames renders in headless Chrome and fails lint on families it cannot resolve.
 * These are OS-bundled fonts with no downloadable file, so `local()` is the declaration it wants.
 */
export function fontFaceDeclarations(...stacks) {
  const families = [];
  for (const stack of stacks) {
    for (const raw of String(stack ?? "").split(",")) {
      const family = raw.trim().replace(/^["']|["']$/g, "");
      if (!family || GENERIC_FAMILIES.has(family.toLowerCase()) || families.includes(family)) continue;
      families.push(family);
    }
  }
  return families.map((family) => `    @font-face { font-family: "${family}"; src: local("${family}"); }`).join("\n");
}

function themedStyles(manifest, size, theme) {
  const vertical = manifest.meta.aspect === "9:16";
  const scale = Math.min(size.width / 1920, size.height / 1080);
  const isClaude = theme.id === "claude";
  const photoFirst = manifest.presentation?.photo_first === true;
  return `${fontFaceDeclarations(theme.bodyFontFamily, theme.headlineFontFamily)}
    html, body {
      margin: 0;
      width: ${size.width}px;
      height: ${size.height}px;
      overflow: hidden;
      background: ${theme.background};
      color: ${theme.ink};
      font-family: ${theme.bodyFontFamily};
    }
    #tsugite-render {
      position: relative;
      width: ${size.width}px;
      height: ${size.height}px;
      overflow: hidden;
      background: ${theme.background};
    }
    /* Soft paper atmosphere — static, so frame-by-frame capture stays deterministic. */
    .ambient {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 0;
      overflow: hidden;
    }
    .ambient .blob {
      position: absolute;
      border-radius: 50%;
      filter: blur(${round(40 * scale)}px);
      opacity: ${isClaude ? 1 : 0.7};
    }
    .ambient .blob-a {
      width: ${round(620 * scale)}px;
      height: ${round(620 * scale)}px;
      left: ${round(-120 * scale)}px;
      top: ${round(-80 * scale)}px;
      background: radial-gradient(circle, rgba(217, 119, 87, 0.22) 0%, rgba(217, 119, 87, 0) 70%);
    }
    .ambient .blob-b {
      width: ${round(540 * scale)}px;
      height: ${round(540 * scale)}px;
      right: ${round(-100 * scale)}px;
      top: ${round(40 * scale)}px;
      background: radial-gradient(circle, rgba(120, 140, 160, 0.16) 0%, rgba(120, 140, 160, 0) 70%);
    }
    .ambient .blob-c {
      width: ${round(760 * scale)}px;
      height: ${round(420 * scale)}px;
      left: 50%;
      bottom: ${round(-120 * scale)}px;
      transform: translateX(-50%);
      background: radial-gradient(ellipse, rgba(217, 119, 87, 0.12) 0%, rgba(217, 119, 87, 0) 70%);
    }
    .ambient .vignette {
      position: absolute;
      inset: 0;
      background: radial-gradient(ellipse 78% 70% at 50% 42%, transparent 40%, rgba(25, 25, 25, 0.045) 100%);
    }
    .progress-track {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: ${round(5 * scale)}px;
      background: ${theme.progressTrack};
      z-index: 8;
      overflow: hidden;
    }
    .progress-fill {
      width: 100%;
      height: 100%;
      background: ${theme.progress};
      transform-origin: left center;
      transform: scaleX(0);
    }
    /* A photo-first presentation keeps the edited source visible; the legacy
       article stage intentionally leaves its plate hidden under the theme. */
    video {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      opacity: ${photoFirst ? 1 : 0};
      z-index: ${photoFirst ? 0 : "auto"};
    }
    .header {
      position: absolute;
      top: ${round(28 * scale)}px;
      left: ${round(56 * scale)}px;
      right: ${round(56 * scale)}px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: ${round(24 * scale)}px;
      z-index: 5;
      padding-bottom: ${round(18 * scale)}px;
      border-bottom: ${round(1 * scale)}px solid rgba(25, 25, 25, 0.08);
    }
    .header .label {
      font-size: ${round(18 * scale)}px;
      font-weight: 800;
      letter-spacing: 0.16em;
      color: ${theme.label};
    }
    .header .title {
      margin-top: ${round(4 * scale)}px;
      font-size: ${round(28 * scale)}px;
      font-weight: 800;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .header .draft {
      flex: 0 0 auto;
      border: ${round(1.5 * scale)}px solid ${theme.draftBorder};
      border-radius: 999px;
      color: ${theme.draftInk};
      background: ${theme.draftBackground};
      font-size: ${round(18 * scale)}px;
      font-weight: 800;
      letter-spacing: 0.04em;
      padding: ${round(8 * scale)}px ${round(16 * scale)}px;
      box-shadow: 0 ${round(6 * scale)}px ${round(18 * scale)}px rgba(217, 119, 87, 0.12);
    }
    /* The card hugs its content and stays centred in the space above the caption bar. */
    .visual {
      position: absolute;
      top: ${round(108 * scale)}px;
      left: ${round((vertical ? 80 : 340) * scale)}px;
      right: ${round((vertical ? 80 : 340) * scale)}px;
      height: ${round((vertical ? 540 : 680) * scale)}px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      gap: ${round(18 * scale)}px;
      padding: 0;
      border: none;
      background: none;
      box-shadow: none;
      text-align: center;
      z-index: 3;
    }
    .visual[data-has-media="true"] {
      display: grid;
      grid-template-columns: 1.05fr 0.95fr;
      align-items: center;
      gap: ${round(28 * scale)}px;
    }
    .visual .visual-media {
      width: 100%;
      height: 100%;
      max-height: ${round(620 * scale)}px;
      border-radius: ${round(theme.cardRadius * scale)}px;
      overflow: hidden;
      background: ${theme.imagePlaceholder};
      box-shadow: ${theme.cardShadow};
    }
    .visual .visual-media img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    /* A photo-first panel stays translucent so the source remains the hero. */
    .visual > .panel {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: ${round(20 * scale)}px;
      width: 100%;
      padding: ${round(52 * scale)}px ${round(60 * scale)}px ${round(48 * scale)}px;
      border-radius: ${round(theme.cardRadius * scale)}px;
      border: ${photoFirst ? `${round(1 * scale)}px solid rgba(255, 255, 255, 0.34)` : theme.cardBorder};
      background: ${photoFirst ? "rgba(11, 20, 30, 0.68)" : theme.cardBackground};
      color: ${photoFirst ? "#ffffff" : theme.ink};
      box-shadow: ${photoFirst ? `0 ${round(18 * scale)}px ${round(48 * scale)}px rgba(3, 8, 14, 0.26)` : theme.cardShadow};
      overflow: hidden;
    }
    .visual > .panel::before {
      content: "";
      position: absolute;
      top: 0;
      left: ${round(48 * scale)}px;
      right: ${round(48 * scale)}px;
      height: ${round(3 * scale)}px;
      border-radius: 999px;
      background: linear-gradient(90deg, transparent, ${theme.kicker} 20%, ${theme.kicker} 80%, transparent);
      opacity: 0.9;
    }
    .visual [data-role="kicker"] {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: ${photoFirst ? "#ffffff" : theme.kicker};
      background: ${photoFirst ? "rgba(217, 119, 87, 0.86)" : theme.kickerBackground};
      border: ${round(1 * scale)}px solid ${photoFirst ? "rgba(255, 255, 255, 0.32)" : "rgba(217, 119, 87, 0.22)"};
      border-radius: 999px;
      font-size: ${round(20 * scale)}px;
      font-weight: 900;
      letter-spacing: 0.14em;
      padding: ${round(8 * scale)}px ${round(18 * scale)}px;
    }
    .visual [data-role="headline"] {
      max-width: ${round(1180 * scale)}px;
      font-family: ${theme.headlineFontFamily};
      font-size: ${round(62 * scale)}px;
      font-weight: ${theme.headlineWeight};
      letter-spacing: ${theme.headlineLetterSpacing};
      line-height: 1.14;
      white-space: pre-line;
      color: ${photoFirst ? "#ffffff" : theme.ink};
      text-shadow: ${photoFirst ? `0 ${round(3 * scale)}px ${round(12 * scale)}px rgba(0, 0, 0, 0.34)` : "none"};
    }
    /* Impact cards: pull a stat into a poster-size number for dialogue punch. */
    .visual[data-impact="true"] > .panel {
      gap: ${round(14 * scale)}px;
      padding: ${round(40 * scale)}px ${round(48 * scale)}px ${round(44 * scale)}px;
      box-shadow:
        0 ${round(36 * scale)}px ${round(90 * scale)}px rgba(25, 25, 25, 0.12),
        0 0 0 ${round(1 * scale)}px rgba(217, 119, 87, 0.18),
        0 ${round(4 * scale)}px ${round(18 * scale)}px rgba(217, 119, 87, 0.12);
    }
    .visual[data-impact="true"] [data-role="stat"] {
      font-family: ${theme.headlineFontFamily};
      font-size: ${round(148 * scale)}px;
      font-weight: 800;
      line-height: 0.92;
      letter-spacing: -0.04em;
      color: ${theme.kicker};
      text-shadow: 0 ${round(12 * scale)}px ${round(40 * scale)}px rgba(217, 119, 87, 0.22);
    }
    .visual[data-impact="true"] [data-role="stat-label"] {
      max-width: ${round(980 * scale)}px;
      font-family: ${theme.headlineFontFamily};
      font-size: ${round(40 * scale)}px;
      font-weight: 700;
      line-height: 1.25;
      white-space: pre-line;
      color: ${photoFirst ? "#ffffff" : theme.ink};
    }
    .visual[data-mood="myth"] > .panel {
      background: ${photoFirst ? "rgba(11, 20, 30, 0.68)" : "linear-gradient(180deg, #FFFEFA 0%, #F3F1EA 100%)"};
      border: ${round(1 * scale)}px ${photoFirst ? "dashed rgba(255, 255, 255, 0.36)" : "dashed rgba(25, 25, 25, 0.18)"};
    }
    .visual[data-mood="myth"] [data-role="kicker"] {
      color: ${photoFirst ? "#ffffff" : "#6A6A63"};
      background: ${photoFirst ? "rgba(106, 106, 99, 0.82)" : "rgba(25, 25, 25, 0.06)"};
      border-color: ${photoFirst ? "rgba(255, 255, 255, 0.28)" : "rgba(25, 25, 25, 0.1)"};
    }
    .visual[data-mood="now"] > .panel,
    .visual[data-mood="proof"] > .panel {
      border: ${round(1.5 * scale)}px solid rgba(217, 119, 87, 0.28);
    }
    .visual[data-mood="next"] > .panel {
      background: ${photoFirst ? "rgba(11, 20, 30, 0.72)" : "linear-gradient(165deg, #FFF8F4 0%, #FAF9F5 55%, #F0EEE6 100%)"};
      box-shadow:
        0 ${round(32 * scale)}px ${round(80 * scale)}px ${photoFirst ? "rgba(3, 8, 14, 0.3)" : "rgba(217, 119, 87, 0.14)"},
        0 ${round(4 * scale)}px ${round(14 * scale)}px ${photoFirst ? "rgba(3, 8, 14, 0.18)" : "rgba(25, 25, 25, 0.04)"};
    }
    .visual[data-mood="turn"] [data-role="headline"] {
      font-size: ${round(56 * scale)}px;
    }
    .visual [data-role="detail"] {
      max-width: ${round(1000 * scale)}px;
      color: ${photoFirst ? "rgba(255, 255, 255, 0.9)" : theme.detail};
      font-size: ${round(30 * scale)}px;
      font-weight: 650;
      line-height: 1.5;
      white-space: pre-line;
    }
    .visual [data-role="steps"] {
      display: flex;
      flex-direction: column;
      gap: ${round(12 * scale)}px;
      width: 100%;
      max-width: ${round(1200 * scale)}px;
    }
    .visual [data-role="step"] {
      display: flex;
      align-items: center;
      gap: ${round(14 * scale)}px;
      text-align: left;
    }
    .visual [data-role="step"] .index {
      flex: 0 0 auto;
      width: ${round(40 * scale)}px;
      height: ${round(40 * scale)}px;
      border-radius: 999px;
      background: ${theme.stepActive};
      color: #ffffff;
      font-size: ${round(20 * scale)}px;
      font-weight: 900;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 ${round(8 * scale)}px ${round(18 * scale)}px rgba(217, 119, 87, 0.32);
    }
    .visual [data-role="step"] .body {
      flex: 1;
      border-radius: ${round(Math.max(10, theme.cardRadius - 6) * scale)}px;
      background: ${photoFirst ? "rgba(255, 255, 255, 0.14)" : theme.stepBackground};
      color: ${photoFirst ? "#ffffff" : theme.stepInk};
      font-size: ${round(26 * scale)}px;
      font-weight: 750;
      padding: ${round(14 * scale)}px ${round(18 * scale)}px;
      border: ${round(1 * scale)}px solid ${photoFirst ? "rgba(255, 255, 255, 0.18)" : "rgba(25, 25, 25, 0.05)"};
    }
    .visual [data-role="badges"] {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: ${round(10 * scale)}px;
    }
    .visual [data-role="badge"] {
      border-radius: ${round(theme.badgeRadius * scale)}px;
      background: ${photoFirst ? "rgba(255, 255, 255, 0.16)" : theme.badgeBackground};
      color: ${photoFirst ? "#ffffff" : theme.badgeInk};
      font-size: ${round(22 * scale)}px;
      font-weight: 800;
      padding: ${round(10 * scale)}px ${round(18 * scale)}px;
      border: ${round(1 * scale)}px solid ${photoFirst ? "rgba(255, 255, 255, 0.18)" : "rgba(25, 25, 25, 0.06)"};
    }
    /* Cast: dialogue energy — active speaker steps forward, idle steps back. */
    .cast {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 2;
    }
    .cast .side-glow {
      position: absolute;
      top: ${round(120 * scale)}px;
      bottom: ${round(140 * scale)}px;
      width: ${round(420 * scale)}px;
      opacity: 0;
      pointer-events: none;
      z-index: 0;
    }
    .cast .side-glow[data-side="left"] {
      left: 0;
      background: radial-gradient(ellipse at 20% 55%, rgba(217, 119, 87, 0.2) 0%, rgba(217, 119, 87, 0) 68%);
    }
    .cast .side-glow[data-side="right"] {
      right: 0;
      background: radial-gradient(ellipse at 80% 55%, rgba(217, 119, 87, 0.22) 0%, rgba(217, 119, 87, 0) 68%);
    }
    .cast .side-glow[data-active="true"] { opacity: 1; }
    .cast .figure {
      position: absolute;
      bottom: ${round(150 * scale)}px;
      width: ${round(360 * scale)}px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: ${round(6 * scale)}px;
      z-index: 1;
    }
    .cast .figure[data-side="left"] { left: ${round(8 * scale)}px; }
    .cast .figure[data-side="right"] { right: ${round(8 * scale)}px; }
    .cast .figure[data-active="true"] { opacity: 1; z-index: 3; }
    .cast .figure[data-active="false"] { opacity: 0.38; z-index: 1; }
    .cast .figure[data-active="false"] .portrait { transform: scale(0.78) translateY(${round(18 * scale)}px); transform-origin: center bottom; }
    .cast .figure[data-active="false"] .portrait img { filter: saturate(0.55) brightness(0.94); }
    .cast .figure[data-active="true"] .portrait { transform: scale(1.08); transform-origin: center bottom; }
    .cast .stage-disc {
      width: ${round(220 * scale)}px;
      height: ${round(34 * scale)}px;
      border-radius: 50%;
      background: radial-gradient(ellipse, rgba(25, 25, 25, 0.14) 0%, rgba(25, 25, 25, 0) 72%);
      margin-bottom: ${round(-4 * scale)}px;
      order: 3;
    }
    .cast .figure[data-active="true"] .stage-disc {
      width: ${round(250 * scale)}px;
      background: radial-gradient(ellipse, rgba(217, 119, 87, 0.3) 0%, rgba(217, 119, 87, 0) 72%);
    }
    .cast .portrait {
      position: relative;
      width: 100%;
      height: ${round(440 * scale)}px;
      display: flex;
      align-items: flex-end;
      justify-content: center;
      order: 1;
    }
    .cast .portrait img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      object-position: center bottom;
      filter: drop-shadow(0 ${round(18 * scale)}px ${round(36 * scale)}px rgba(25, 25, 25, 0.16));
    }
    /* Mouth frames stack in one box; the timeline runtime flips opacity by time. */
    .cast .portrait[data-mouth-sync="true"] img {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      margin: 0 auto;
      width: 100%;
      height: 100%;
    }
    .cast .name {
      order: 2;
      border-radius: 999px;
      padding: ${round(10 * scale)}px ${round(22 * scale)}px;
      font-size: ${round(24 * scale)}px;
      font-weight: 900;
      color: #ffffff;
      background: ${theme.nameIdle};
      box-shadow: 0 ${round(8 * scale)}px ${round(18 * scale)}px rgba(25, 25, 25, 0.12);
    }
    .cast .figure[data-active="true"] .name {
      background: var(--accent);
      transform: scale(1.06);
      box-shadow: 0 ${round(12 * scale)}px ${round(28 * scale)}px color-mix(in srgb, var(--accent) 40%, transparent);
    }
    /* Caption reads as a dialogue balloon, rimmed with the active speaker accent. */
    .caption {
      position: absolute;
      left: ${round((vertical ? 72 : 300) * scale)}px;
      right: ${round((vertical ? 72 : 300) * scale)}px;
      bottom: ${round(28 * scale)}px;
      min-height: ${round(108 * scale)}px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: ${round(18 * scale)}px;
      padding: ${round(22 * scale)}px ${round(34 * scale)}px;
      border-radius: ${round(theme.captionRadius * scale)}px;
      background: ${theme.captionBackground};
      color: ${theme.captionInk};
      box-shadow: ${theme.captionShadow}, 0 0 0 ${round(1 * scale)}px rgba(255,255,255,0.04);
      border: ${round(2 * scale)}px solid color-mix(in srgb, var(--speaker-accent, ${theme.kicker}) 55%, transparent);
      font-size: ${round(40 * scale)}px;
      font-weight: 800;
      line-height: 1.32;
      letter-spacing: -0.02em;
      text-align: center;
      text-wrap: balance;
      z-index: 6;
    }
    .caption .speaker-chip {
      flex: 0 0 auto;
      border-radius: 999px;
      padding: ${round(8 * scale)}px ${round(16 * scale)}px;
      font-size: ${round(20 * scale)}px;
      font-weight: 900;
      color: #ffffff;
      background: var(--speaker-accent, ${theme.kicker});
      letter-spacing: 0.02em;
    }
    .caption .line {
      display: block;
      flex: 1;
    }
    .caption .emphasis {
      font-style: normal;
      color: ${theme.captionEmphasis ?? theme.kicker};
      text-shadow: 0 0 ${round(18 * scale)}px rgba(217, 119, 87, 0.35);
    }
`;
}
function round(value) {
  return Math.round(value * 100) / 100;
}

export function renderClips(clips) {
  let start = 0;
  return (clips ?? [])
    .flatMap((clip) => {
      const duration = clip.out - clip.in;
      const id = escapeAttr(clip.id);
      const src = escapeAttr(clip.src);
      const elements = [
        `    <video id="${id}" class="clip" data-start="${start}" data-duration="${duration}" data-track-index="0" data-media-start="${clip.in}" src="${src}" muted playsinline></video>`
      ];
      if (clip.audio) {
        elements.push(
          `    <audio id="${id}-audio" class="clip" data-start="${start}" data-duration="${duration}" data-track-index="1" data-media-start="${clip.in}" data-volume="1" src="${src}"></audio>`
        );
      }
      start += duration;
      return elements;
    })
    .join("\n");
}

export function renderAudio(audio) {
  const tracks = [
    ["bgm", audio?.bgm ?? []],
    ["narration", audio?.narration ?? []],
    ["sfx", audio?.sfx ?? []]
  ];
  const elements = [];
  // HyperFrames forbids overlapping clips on the same data-track-index, so every
  // audio element — BGM, each narration line, SFX — gets its own track.
  let trackIndex = 2;
  for (const [track, entries] of tracks) {
    for (const [index, entry] of entries.entries()) {
      if (!entry.src) continue;
      const start = entry.start ?? 0;
      const duration = entry.end && entry.end > start ? entry.end - start : undefined;
      elements.push(
        `    <audio id="${escapeAttr(entry.id ?? `${track}-${index + 1}`)}" class="clip" data-start="${start}"${duration ? ` data-duration="${duration}"` : ""} data-track-index="${trackIndex}"${entry.volume === undefined ? "" : ` data-volume="${entry.volume}"`} src="${escapeAttr(entry.src)}"></audio>`
      );
      trackIndex += 1;
    }
  }
  return elements.join("\n");
}

function renderVisualLayers(manifest) {
  const presentation = manifest.presentation ?? {};
  const ambient = [
    '    <div class="ambient" aria-hidden="true">',
    '      <div class="blob blob-a"></div>',
    '      <div class="blob blob-b"></div>',
    '      <div class="blob blob-c"></div>',
    '      <div class="vignette"></div>',
    "    </div>",
    '    <div class="progress-track" aria-hidden="true"><div id="progress-fill" class="progress-fill"></div></div>'
  ];
  const header = [
    '    <div class="header">',
    "      <div>",
    `        <div class="label">${escapeHtml(presentation.label ?? "ARTICLE")}</div>`,
    `        <div class="title">${escapeHtml(presentation.title ?? presentation.source_title ?? "")}</div>`,
    "      </div>",
    presentation.draft ? '      <div class="draft">SILENT DRAFT</div>' : "",
    "    </div>"
  ].filter(Boolean);

  const images = manifest.images ?? [];
  const cards = (manifest.captions ?? [])
    .map((caption, index) => renderVisualCard(caption, index, images))
    .filter(Boolean);
  const cast = renderCast(manifest);

  return [...ambient, ...header, ...cards, ...cast].join("\n");
}

/**
 * Both speakers stay on stage for the whole line; only `data-active` moves.
 * The active speaker with three `mouth_frames` stacks closed/half/open images so the
 * timeline runtime can flip opacity as a pure function of seek time.
 */
function renderCast(manifest) {
  const speakers = manifest.speakers ?? [];
  if (speakers.length === 0) return [];
  const images = manifest.images ?? [];

  return (manifest.captions ?? []).map((caption, index) => {
    const duration = Math.max(0.01, caption.end - caption.start);
    const glows = speakers.map((speaker) => {
      const active = caption.speaker === speaker.id;
      return `      <div class="side-glow" data-side="${escapeAttr(speaker.side)}" data-active="${active}" aria-hidden="true"></div>`;
    });
    const figures = speakers.map((speaker) => {
      const active = caption.speaker === speaker.id;
      const portrait = renderPortrait(speaker, active, caption.pose, images);
      return [
        `      <div class="figure" data-speaker="${escapeAttr(speaker.id)}" data-side="${escapeAttr(speaker.side)}" data-active="${active}" style="--accent: ${escapeAttr(speaker.accent)}">`,
        `        <div class="portrait"${portrait.mouthSync ? ' data-mouth-sync="true"' : ""}>${portrait.html}</div>`,
        `        <div class="name">${escapeHtml(speaker.display_name)}</div>`,
        '        <div class="stage-disc" aria-hidden="true"></div>',
        "      </div>"
      ].join("\n");
    });

    return [
      `    <div id="${escapeAttr(`${caption.id ?? `cast-${index + 1}`}-cast`)}" class="clip cast" data-start="${caption.start}" data-duration="${duration}" data-track-index="${CAST_TRACK_BASE + index}">`,
      ...glows,
      ...figures,
      "    </div>"
    ].join("\n");
  });
}

function renderPortrait(speaker, active, pose, images) {
  const mouthFrames = speaker.mouth_frames;
  if (active && Array.isArray(mouthFrames) && mouthFrames.length === 3) {
    const frames = mouthFrames
      .map((imageId, mouthIndex) => {
        const image = images.find((entry) => entry.id === imageId);
        if (!image) return "";
        // Start on closed (index 0); the runtime owns later frames.
        const opacity = mouthIndex === 0 ? 1 : 0;
        return `<img data-mouth-index="${mouthIndex}" src="${escapeAttr(image.src)}" alt="${escapeAttr(image.alt ?? speaker.display_name)}" style="opacity: ${opacity}">`;
      })
      .filter(Boolean)
      .join("");
    if (frames) return { html: frames, mouthSync: true };
  }

  const image = resolveSpeakerPose(speaker, active ? pose : undefined, images);
  if (!image) return { html: "", mouthSync: false };
  return {
    html: `<img src="${escapeAttr(image.src)}" alt="${escapeAttr(image.alt ?? speaker.display_name)}">`,
    mouthSync: false
  };
}

function resolveSpeakerPose(speaker, pose, images) {
  const imageId =
    (pose ? speaker.poses?.[pose] : undefined) ??
    speaker.poses?.neutral ??
    Object.values(speaker.poses ?? {})[0];
  return images.find((image) => image.id === imageId);
}

function renderVisualCard(caption, index, images = []) {
  const visual = caption.visual;
  if (!visual?.headline) return "";
  const duration = Math.max(0.01, caption.end - caption.start);
  const id = escapeAttr(`${caption.id ?? `visual-${index + 1}`}-visual`);
  const mood = resolveVisualMood(visual.kicker);
  const impact = splitImpactHeadline(visual.headline);
  const media = visual.image_id
    ? images.find((image) => image.id === visual.image_id)
    : undefined;
  const parts = [];

  if (visual.kicker) parts.push(`      <div data-role="kicker">${escapeHtml(visual.kicker)}</div>`);
  if (impact) {
    parts.push(`      <div data-role="stat">${escapeHtml(impact.stat)}</div>`);
    if (impact.label) parts.push(`      <div data-role="stat-label">${escapeHtml(impact.label)}</div>`);
  } else {
    parts.push(`      <div data-role="headline">${escapeHtml(visual.headline)}</div>`);
  }
  if (visual.detail) parts.push(`      <div data-role="detail">${escapeHtml(visual.detail)}</div>`);

  const steps = Array.isArray(visual.steps) ? visual.steps : [];
  if (steps.length > 0) {
    parts.push('      <div data-role="steps">');
    steps.forEach((step, stepIndex) => {
      parts.push(
        `        <div data-role="step" data-step-index="${stepIndex}"><span class="index">${stepIndex + 1}</span><span class="body">${escapeHtml(step)}</span></div>`
      );
    });
    parts.push("      </div>");
  }

  const badges = Array.isArray(visual.badges) ? visual.badges : [];
  if (badges.length > 0) {
    parts.push('      <div data-role="badges">');
    for (const badge of badges) {
      parts.push(`        <div data-role="badge">${escapeHtml(badge)}</div>`);
    }
    parts.push("      </div>");
  }

  const mediaBlock = media
    ? [
        '      <div class="visual-media">',
        `        <img src="${escapeAttr(media.src)}" alt="${escapeAttr(media.alt ?? visual.headline)}">`,
        "      </div>"
      ]
    : [];

  return [
    `    <div id="${id}" class="clip visual" data-start="${caption.start}" data-duration="${duration}" data-track-index="${VISUAL_TRACK_BASE + index}" data-mood="${escapeAttr(mood)}" data-impact="${impact ? "true" : "false"}"${media ? ' data-has-media="true"' : ""}>`,
    ...mediaBlock,
    '      <div class="panel">',
    ...parts.map((part) => `  ${part}`),
    "      </div>",
    "    </div>"
  ].join("\n");
}

/**
 * Poster-style stats for dialogue punch. Matches numbers that carry the claim
 * (80%, 8割) without rewriting the authored Japanese copy wholesale.
 */
export function splitImpactHeadline(headline) {
  const text = String(headline ?? "");
  const match = text.match(/(80%以上|80%|\d+\s*%|\d+割|8割)/);
  if (!match) return null;
  const stat = match[1].replace(/\s+/g, "");
  // Pull the stat out, then scrub commas/spaces left behind on either side of the hole.
  const label = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`
    .replace(/[、,，]\s*$/gm, "")
    .replace(/^\s*[、,，]/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return { stat, label: label || null };
}

export function resolveVisualMood(kicker) {
  const key = String(kicker ?? "").toUpperCase();
  if (key.includes("MYTH") || key.includes("前提") || key.includes("よくある")) return "myth";
  if (key.includes("NOW") || key.includes("新システム")) return "now";
  if (key.includes("TURN") || key.includes("転換") || key.includes("THEN")) return "turn";
  if (key.includes("EVIDENCE") || key.includes("証拠")) return "evidence";
  if (key.includes("NEXT") || key.includes("次")) return "next";
  if (key.includes("ANTHROPIC") || key.includes("公式")) return "proof";
  return "default";
}

export function renderCaptions(captions, themed = false, speakers = []) {
  const speakerList = speakers ?? [];
  const speakerById = new Map(speakerList.map((speaker) => [speaker.id, speaker]));
  const dialogueMode = themed && speakerList.length > 0;
  return (captions ?? [])
    .map((caption, index) => {
      const duration = Math.max(0.01, caption.end - caption.start);
      const speaker = speakerById.get(caption.speaker);
      const accent = speaker?.accent ?? "#D97757";
      const chip =
        dialogueMode && speaker
          ? `<span class="speaker-chip">${escapeHtml(speaker.display_name)}</span>`
          : "";
      const body = themed
        ? `${chip}<span class="line">${emphasizedHtml(caption.text, caption.emphasis)}</span>`
        : escapeHtml(caption.text);
      const style = dialogueMode ? ` style="--speaker-accent: ${escapeAttr(accent)}"` : "";
      const speakerAttr = dialogueMode ? ` data-speaker="${escapeAttr(caption.speaker ?? "")}"` : "";
      return `    <div id="${escapeAttr(caption.id ?? `caption-${index + 1}`)}" class="clip caption" data-start="${caption.start}" data-duration="${duration}" data-track-index="${index + 20}"${speakerAttr}${style}>${body}</div>`;
    })
    .join("\n");
}

/** Wrap emphasised terms so the caption bar can highlight them without inline styles. */
export function emphasizedHtml(text, emphasis = []) {
  const terms = [...new Set((emphasis ?? []).filter((term) => typeof term === "string" && term.length > 0))].sort(
    (left, right) => right.length - left.length
  );
  if (terms.length === 0) return escapeHtml(text ?? "");
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "g");
  return String(text ?? "")
    .split(pattern)
    .filter(Boolean)
    .map((part) => (terms.includes(part) ? `<em class="emphasis">${escapeHtml(part)}</em>` : escapeHtml(part)))
    .join("");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compositionSize(manifest) {
  return resolveOutputDimensions(manifest);
}

export function escapeAttr(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
