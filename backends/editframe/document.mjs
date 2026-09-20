import { fastEditClient } from "./fastEdit.mjs";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveOutputDimensions } from "../outputDimensions.mjs";

export function canonicalPath(value) {
  const resolved = resolve(value);
  try {
    return existsSync(resolved) ? realpathSync(resolved) : resolved;
  } catch {
    return resolved;
  }
}

export function publicMediaUrl(fileName) {
  return `/media/${fileName}`;
}

export function assertSupportedManifest(manifest) {
  const aspect = manifest?.meta?.aspect;
  const fps = manifest?.meta?.fps;
  if (aspect !== "16:9" && !(manifest.fast_edit && aspect === "9:16")) {
    throw new Error("Editframe backend currently supports 16:9 only");
  }
  if (fps !== 30) {
    throw new Error("Editframe backend currently supports fps 30 only");
  }
  if (manifest?.presentation?.preset) {
    throw new Error(`Editframe backend does not support presentation preset '${manifest.presentation.preset}'`);
  }
  if (Array.isArray(manifest?.transitions) && manifest.transitions.length > 0) {
    throw new Error("Editframe backend does not support transitions");
  }
  const audio = manifest?.audio ?? {};
  const extra =
    (audio.bgm?.length ?? 0) + (audio.narration?.length ?? 0) + (audio.sfx?.length ?? 0);
  if (extra > 0 && !manifest.fast_edit) {
    throw new Error("Editframe backend does not support concurrent audio_mix tracks");
  }
  if (!Array.isArray(manifest?.clips) || manifest.clips.length < 1) {
    throw new Error("Editframe backend requires at least one local clip");
  }
  const clipIds = new Set();
  for (const clip of manifest.clips) {
    if (clipIds.has(clip.id)) {
      throw new Error(`Editframe backend does not allow duplicate clip id '${clip.id}'`);
    }
    clipIds.add(clip.id);
  }
  if (Array.isArray(manifest?.images) && manifest.images.length > 0) {
    throw new Error("Editframe backend does not support image overlays");
  }
  for (const clip of manifest.clips) {
    if (clip?.motion !== undefined) {
      throw new Error(`Editframe backend does not support clip.motion on '${clip.id}'`);
    }
  }
  for (const caption of manifest.captions ?? []) {
    if (caption?.visual !== undefined) {
      throw new Error("Editframe backend does not support caption.visual");
    }
    if (caption?.pose !== undefined) {
      throw new Error("Editframe backend does not support caption.pose");
    }
    if (Array.isArray(caption?.emphasis) && caption.emphasis.length > 0) {
      throw new Error("Editframe backend does not support caption.emphasis");
    }
  }
}

export function renderIndexHtml(manifest, options = {}) {
  assertSupportedManifest(manifest);
  const size = resolveOutputDimensions(manifest);
  const mediaByClipId = options.mediaByClipId ?? Object.create(null);
  const clips = manifest.clips
    .map((clip, index) => renderClip(clip, mediaByClipId[clip.id], index, manifest.fast_edit ? [] : captionsForClip(manifest, index)))
    .join("\n");
  return `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(manifest.meta?.slug ?? "tsugite-editframe")}</title>
    <script type="module" src="./src/index.js"></script>
    <link rel="stylesheet" href="./src/styles.css" />
  </head>
  <body>
    <ef-timegroup id="root" ${manifest.fast_edit ? 'style="background:#000"' : ""} mode="contain" fps="${escapeAttr(String(manifest.meta.fps))}" class="stage">
      <ef-timegroup mode="sequence" class="fill">
${clips}
      </ef-timegroup>
      ${manifest.fast_edit ? '<div id="fe-overlay" style="position:absolute;inset:0;pointer-events:none"></div>' : ""}
    </ef-timegroup>
  </body>
</html>
`;
}

export function renderClientScript(elementsCss, manifest) {
  const cssImport = elementsCss ? `import ${JSON.stringify(elementsCss)};\n` : "";
  return `import "@editframe/elements";
${cssImport}import "./styles.css";
${manifest?.fast_edit ? fastEditClient(manifest) : ""}
`;
}

export function renderStyles(size) {
  return `html, body {
  margin: 0;
  width: 100%;
  height: 100%;
  background: #111;
}
.stage, .fill {
  position: relative;
  display: block;
  width: ${size.width}px;
  height: ${size.height}px;
  overflow: hidden;
}
.fill-media {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  z-index: 0;
}
ef-text.caps,
.caps {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 48px;
  z-index: 5;
  display: block;
  text-align: center;
  color: #fff8ef;
  font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;
  font-size: 48px;
  font-weight: 700;
  line-height: 1.2;
  text-shadow: 0 4px 16px rgba(0,0,0,0.55);
  pointer-events: none;
}
`;
}

export function renderViteConfig({ port, compositionDir, runtimeRoot }) {
  const root = canonicalPath(compositionDir);
  const runtime = canonicalPath(runtimeRoot);
  return `import path from "node:path";
import { defineConfig } from "vite";
import { vitePluginEditframe } from "@editframe/vite-plugin";

export default defineConfig({
  root: ${JSON.stringify(root)},
  publicDir: ${JSON.stringify(join(root, "public"))},
  resolve: {
    alias: {
      "@editframe/elements": path.join(${JSON.stringify(runtime)}, "node_modules/@editframe/elements/dist/index.js")
    }
  },
  server: {
    host: "127.0.0.1",
    port: ${Number(port)},
    strictPort: true,
    open: false,
    fs: {
      allow: [
        ${JSON.stringify(root)},
        ${JSON.stringify(runtime)}
      ]
    }
  },
  plugins: [
    vitePluginEditframe({
      root: path.join(${JSON.stringify(root)}, "src"),
      cacheRoot: path.join(${JSON.stringify(root)}, "cache")
    })
  ]
});
`;
}

function captionsForClip(manifest, clipIndex) {
  let start = 0;
  for (let i = 0; i < clipIndex; i += 1) start += Number(manifest.clips[i].duration);
  const end = start + Number(manifest.clips[clipIndex].duration);
  const hits = [];
  for (const caption of manifest.captions ?? []) {
    const capStart = Number(caption.start);
    const capEnd = Number(caption.end);
    const overlapStart = Math.max(start, capStart);
    const overlapEnd = Math.min(end, capEnd);
    if (!(overlapEnd > overlapStart)) continue;
    hits.push({
      text: caption.text,
      localStart: overlapStart - start,
      localDuration: overlapEnd - overlapStart
    });
  }
  return hits;
}

function renderCaption(caption) {
  const offset =
    caption.localStart > 0 ? ` offset="${escapeAttr(formatCssTime(caption.localStart))}"` : "";
  return `          <ef-text class="caps"${offset} duration="${escapeAttr(formatCssTime(caption.localDuration))}">${escapeHtml(String(caption.text ?? ""))}</ef-text>`;
}

function renderClip(clip, media, index, captions) {
  const url = media?.publicUrl;
  if (typeof url !== "string" || !url.startsWith("/media/")) {
    throw new Error(`clip '${clip.id}' is missing a public /media URL`);
  }
  const duration = Number(clip.duration);
  const sourceIn = formatCssTime(clip.in);
  const sourceOut = formatCssTime(clip.out);
  const mute = clip.audio === false ? " mute" : "";
  const texts = (captions ?? []).map(renderCaption).join("\n");
  return `        <ef-timegroup mode="fixed" duration="${escapeAttr(formatCssTime(duration))}" class="fill">
          <ef-video
            id="${escapeAttr(`clip-${index}`)}"
            src="${escapeAttr(url)}"
            sourcein="${escapeAttr(sourceIn)}"
            sourceout="${escapeAttr(sourceOut)}"
            class="fill-media"${mute}
          ></ef-video>
${texts}
        </ef-timegroup>`;
}

function formatCssTime(value) {
  if (Number.isInteger(value)) return `${value}s`;
  return `${value}s`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}
