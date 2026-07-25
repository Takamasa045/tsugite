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
${renderCaptions(manifest.captions, themed)}
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
    /* The plate sits under an opaque ground and only carries duration. */
    video {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      opacity: 0;
    }
    .header {
      position: absolute;
      top: ${round(36 * scale)}px;
      left: ${round(56 * scale)}px;
      right: ${round(56 * scale)}px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: ${round(24 * scale)}px;
      z-index: 5;
    }
    .header .label {
      font-size: ${round(20 * scale)}px;
      font-weight: 800;
      letter-spacing: 0.14em;
      color: ${theme.label};
    }
    .header .title {
      font-size: ${round(30 * scale)}px;
      font-weight: 800;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .header .draft {
      flex: 0 0 auto;
      border: ${round(2 * scale)}px solid ${theme.draftBorder};
      border-radius: 999px;
      color: ${theme.draftInk};
      background: ${theme.draftBackground};
      font-size: ${round(20 * scale)}px;
      font-weight: 800;
      padding: ${round(8 * scale)}px ${round(16 * scale)}px;
    }
    /* The card hugs its content and stays centred in the space above the caption bar. */
    .visual {
      position: absolute;
      top: ${round(96 * scale)}px;
      left: ${round((vertical ? 80 : 340) * scale)}px;
      right: ${round((vertical ? 80 : 340) * scale)}px;
      height: ${round((vertical ? 560 : 700) * scale)}px;
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
    }
    /* The visible panel is the inner block, so it can shrink to the copy it holds. */
    .visual > .panel {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: ${round(18 * scale)}px;
      width: 100%;
      padding: ${round(48 * scale)}px ${round(56 * scale)}px;
      border-radius: ${round(theme.cardRadius * scale)}px;
      border: ${theme.cardBorder};
      background: ${theme.cardBackground};
      box-shadow: ${theme.cardShadow};
    }
    .visual [data-role="kicker"] {
      color: ${theme.kicker};
      font-size: ${round(24 * scale)}px;
      font-weight: 900;
      letter-spacing: 0.14em;
    }
    .visual [data-role="headline"] {
      max-width: ${round(1200 * scale)}px;
      font-family: ${theme.headlineFontFamily};
      font-size: ${round(64 * scale)}px;
      font-weight: ${theme.headlineWeight};
      letter-spacing: ${theme.headlineLetterSpacing};
      line-height: 1.18;
      white-space: pre-line;
    }
    .visual [data-role="detail"] {
      max-width: ${round(1000 * scale)}px;
      color: ${theme.detail};
      font-size: ${round(34 * scale)}px;
      font-weight: 650;
      line-height: 1.45;
      white-space: pre-line;
    }
    .visual [data-role="steps"] {
      display: flex;
      flex-direction: column;
      gap: ${round(10 * scale)}px;
      width: 100%;
      max-width: ${round(1200 * scale)}px;
    }
    .visual [data-role="step"] {
      display: flex;
      align-items: center;
      gap: ${round(12 * scale)}px;
      text-align: left;
    }
    .visual [data-role="step"] .index {
      flex: 0 0 auto;
      width: ${round(34 * scale)}px;
      height: ${round(34 * scale)}px;
      border-radius: 999px;
      background: ${theme.stepActive};
      color: #ffffff;
      font-size: ${round(18 * scale)}px;
      font-weight: 900;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .visual [data-role="step"] .body {
      flex: 1;
      border-radius: ${round(Math.max(8, theme.cardRadius - 4) * scale)}px;
      background: ${theme.stepBackground};
      color: ${theme.stepInk};
      font-size: ${round(26 * scale)}px;
      font-weight: 750;
      padding: ${round(12 * scale)}px ${round(16 * scale)}px;
    }
    .visual [data-role="badges"] {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: ${round(10 * scale)}px;
    }
    .visual [data-role="badge"] {
      border-radius: ${round(theme.badgeRadius * scale)}px;
      background: ${theme.badgeBackground};
      color: ${theme.badgeInk};
      font-size: ${round(24 * scale)}px;
      font-weight: 800;
      padding: ${round(10 * scale)}px ${round(16 * scale)}px;
    }
    /* Cast: full-body cutouts standing either side of the card. */
    .cast {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    .cast .figure {
      position: absolute;
      bottom: ${round(180 * scale)}px;
      width: ${round(300 * scale)}px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: ${round(10 * scale)}px;
    }
    .cast .figure[data-side="left"] { left: ${round(24 * scale)}px; }
    .cast .figure[data-side="right"] { right: ${round(24 * scale)}px; }
    .cast .figure[data-active="true"] { opacity: 1; }
    .cast .figure[data-active="false"] { opacity: 0.5; }
    .cast .figure[data-active="false"] .portrait { transform: scale(0.9); transform-origin: center bottom; }
    .cast .figure[data-active="false"] .portrait img { filter: saturate(0.72); }
    .cast .portrait {
      width: 100%;
      height: ${round(380 * scale)}px;
      display: flex;
      align-items: flex-end;
      justify-content: center;
    }
    .cast .portrait img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      object-position: center bottom;
    }
    .cast .name {
      border-radius: 999px;
      padding: ${round(8 * scale)}px ${round(18 * scale)}px;
      font-size: ${round(24 * scale)}px;
      font-weight: 900;
      color: #ffffff;
      background: ${theme.nameIdle};
    }
    .cast .figure[data-active="true"] .name { background: var(--accent); }
    .caption {
      position: absolute;
      left: ${round((vertical ? 80 : 360) * scale)}px;
      right: ${round((vertical ? 80 : 360) * scale)}px;
      bottom: ${round(36 * scale)}px;
      min-height: ${round(96 * scale)}px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: ${round(18 * scale)}px ${round(28 * scale)}px;
      border-radius: ${round(theme.captionRadius * scale)}px;
      background: ${theme.captionBackground};
      color: ${theme.captionInk};
      box-shadow: ${theme.captionShadow};
      font-size: ${round(40 * scale)}px;
      font-weight: 800;
      line-height: 1.35;
      letter-spacing: -0.02em;
      text-align: center;
      text-wrap: balance;
    }
    .caption .line {
      display: block;
    }
    .caption .emphasis {
      font-style: normal;
      color: ${theme.captionEmphasis ?? theme.kicker};
    }`;
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
  for (const [track, entries] of tracks) {
    for (const [index, entry] of entries.entries()) {
      if (!entry.src) continue;
      const start = entry.start ?? 0;
      const duration = entry.end && entry.end > start ? entry.end - start : undefined;
      elements.push(
        `    <audio id="${escapeAttr(entry.id ?? `${track}-${index + 1}`)}" class="clip" data-start="${start}"${duration ? ` data-duration="${duration}"` : ""} data-track-index="${index + 2}"${entry.volume === undefined ? "" : ` data-volume="${entry.volume}"`} src="${escapeAttr(entry.src)}"></audio>`
      );
    }
  }
  return elements.join("\n");
}

function renderVisualLayers(manifest) {
  const presentation = manifest.presentation ?? {};
  const header = [
    '    <div class="header">',
    "      <div>",
    `        <div class="label">${escapeHtml(presentation.label ?? "ARTICLE")}</div>`,
    `        <div class="title">${escapeHtml(presentation.title ?? presentation.source_title ?? "")}</div>`,
    "      </div>",
    presentation.draft ? '      <div class="draft">SILENT DRAFT</div>' : "",
    "    </div>"
  ].filter(Boolean);

  const cards = (manifest.captions ?? [])
    .map((caption, index) => renderVisualCard(caption, index))
    .filter(Boolean);
  const cast = renderCast(manifest);

  return [...header, ...cards, ...cast].join("\n");
}

/**
 * Both speakers stay on stage for the whole line; only `data-active` moves.
 * One layer per line keeps the staging in data attributes, so it needs no runtime logic.
 */
function renderCast(manifest) {
  const speakers = manifest.speakers ?? [];
  if (speakers.length === 0) return [];
  const images = manifest.images ?? [];

  return (manifest.captions ?? []).map((caption, index) => {
    const duration = Math.max(0.01, caption.end - caption.start);
    const figures = speakers.map((speaker) => {
      const active = caption.speaker === speaker.id;
      const image = resolveSpeakerPose(speaker, active ? caption.pose : undefined, images);
      const portrait = image
        ? `<img src="${escapeAttr(image.src)}" alt="${escapeAttr(image.alt ?? speaker.display_name)}">`
        : "";
      return [
        `      <div class="figure" data-speaker="${escapeAttr(speaker.id)}" data-side="${escapeAttr(speaker.side)}" data-active="${active}" style="--accent: ${escapeAttr(speaker.accent)}">`,
        `        <div class="portrait">${portrait}</div>`,
        `        <div class="name">${escapeHtml(speaker.display_name)}</div>`,
        "      </div>"
      ].join("\n");
    });

    return [
      `    <div id="${escapeAttr(`${caption.id ?? `cast-${index + 1}`}-cast`)}" class="clip cast" data-start="${caption.start}" data-duration="${duration}" data-track-index="${CAST_TRACK_BASE + index}">`,
      ...figures,
      "    </div>"
    ].join("\n");
  });
}

function resolveSpeakerPose(speaker, pose, images) {
  const imageId =
    (pose ? speaker.poses?.[pose] : undefined) ??
    speaker.poses?.neutral ??
    Object.values(speaker.poses ?? {})[0];
  return images.find((image) => image.id === imageId);
}

function renderVisualCard(caption, index) {
  const visual = caption.visual;
  if (!visual?.headline) return "";
  const duration = Math.max(0.01, caption.end - caption.start);
  const id = escapeAttr(`${caption.id ?? `visual-${index + 1}`}-visual`);
  const parts = [];

  if (visual.kicker) parts.push(`      <div data-role="kicker">${escapeHtml(visual.kicker)}</div>`);
  parts.push(`      <div data-role="headline">${escapeHtml(visual.headline)}</div>`);
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

  return [
    `    <div id="${id}" class="clip visual" data-start="${caption.start}" data-duration="${duration}" data-track-index="${VISUAL_TRACK_BASE + index}">`,
    '      <div class="panel">',
    ...parts.map((part) => `  ${part}`),
    "      </div>",
    "    </div>"
  ].join("\n");
}

export function renderCaptions(captions, themed = false) {
  return (captions ?? [])
    .map((caption, index) => {
      const duration = Math.max(0.01, caption.end - caption.start);
      const body = themed
        ? `<span class="line">${emphasizedHtml(caption.text, caption.emphasis)}</span>`
        : escapeHtml(caption.text);
      return `    <div id="${escapeAttr(caption.id ?? `caption-${index + 1}`)}" class="clip caption" data-start="${caption.start}" data-duration="${duration}" data-track-index="${index + 20}">${body}</div>`;
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
