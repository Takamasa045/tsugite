import React, { useLayoutEffect, useRef } from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

export const MATRIX_CODE_FORM_PRESET = "matrix-code-form-9x16";

const h = React.createElement;

const GLYPHS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz<>[]{}|/\\*#@$%&+-_=;:.,!?ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝﾞﾟ";

const COLS = 60;

const BG = "#04150a";
const GREEN_DIM = [14, 58, 28];
const GREEN_MID = [36, 195, 78];
const GREEN_HOT = [230, 255, 235];
const GREEN_EDGE = [150, 255, 185];
const GREEN_BODY = [42, 210, 88];
const GREEN_ACCENT = [120, 245, 170];

/** Japanese message stages (lonely → connected). */
const STAGE_WORDS = {
  one: "私",
  two: "私たち",
  ring: ["私", "君", "皆", "絆"],
  bond: "絆"
};

export function MatrixCodeForm({ manifest }) {
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames } = useVideoConfig();
  const totalSeconds = durationInFrames / fps;
  const second = frame / fps;
  const title = manifest.presentation?.title ?? "CODE BOND";
  const draft = Boolean(manifest.presentation?.draft);

  return h(
    AbsoluteFill,
    {
      style: {
        backgroundColor: BG,
        overflow: "hidden",
        color: "#9dffb0",
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Hiragino Sans", monospace'
      }
    },
    h(MatrixCanvas, { frame, width, height, fps, totalSeconds }),
    h(Vignette),
    h(Scanlines, { frame }),
    h(Hud, { second, title, draft, totalSeconds })
  );
}

function MatrixCanvas({ frame, width, height, fps, totalSeconds }) {
  const canvasRef = useRef(null);
  const masksRef = useRef(null);
  const cell = width / COLS;
  const rows = Math.max(1, Math.ceil(height / cell));

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Rasterize Japanese once per size (real font → binary mask).
    if (!masksRef.current || masksRef.current.key !== `${width}x${height}`) {
      masksRef.current = {
        key: `${width}x${height}`,
        one: rasterizeCenteredWord(STAGE_WORDS.one, width, height, 0.48),
        two: rasterizeCenteredWord(STAGE_WORDS.two, width, height, 0.3),
        ring: rasterizeWordDiamond(STAGE_WORDS.ring, width, height),
        bond: rasterizeCenteredWord(STAGE_WORDS.bond, width, height, 0.52)
      };
    }
    const masks = masksRef.current;

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, width, height);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.max(9, Math.floor(cell * 0.78))}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;

    const t = frame / fps;
    const phase = bondPhases(t, totalSeconds);

    const solid = new Float32Array(COLS * rows);
    const material = new Uint8Array(COLS * rows);
    const settling = new Float32Array(COLS * rows);

    for (let col = 0; col < COLS; col += 1) {
      for (let row = 0; row < rows; row += 1) {
        const nx = (col + 0.5) / COLS;
        const ny = (row + 0.5) / rows;
        const stackOrder = clamp01((1 - ny) * 0.82 + hash01(col, row, 17) * 0.18);

        const candidates = [
          { s: sampleMask(masks.one, nx, ny), form: phase.oneForm },
          { s: sampleMask(masks.two, nx, ny), form: phase.twoForm },
          { s: sampleMask(masks.ring, nx, ny), form: phase.circleForm },
          { s: sampleMask(masks.bond, nx, ny), form: phase.coreForm }
        ];

        let best = 0;
        let mat = 0;
        let settle = 0;
        for (const entry of candidates) {
          if (entry.s.v < 0.5) continue;
          if (!cellStacked(stackOrder, entry.form.build, entry.form.dissolve)) continue;
          const v = entry.s.v * entry.form.presence;
          if (v > best) {
            best = v;
            mat = entry.s.mat;
            settle = clamp01(1 - Math.abs(stackOrder - entry.form.build) * 4);
          }
        }
        if (best >= 0.5) {
          solid[row * COLS + col] = best;
          material[row * COLS + col] = mat;
          settling[row * COLS + col] = settle;
        }
      }
    }

    for (let col = 0; col < COLS; col += 1) {
      const assembleBoost = 0.55 + phase.building * 0.9;
      const speed = (0.5 + hash01(col, 7, 11) * 1.35) * assembleBoost;
      const trail = 10 + Math.floor(hash01(col, 3, 19) * 16);
      const headRow = Math.floor(((t * speed * rows) + hash01(col, 1, 5) * rows * 4) % (rows + trail));

      for (let row = 0; row < rows; row += 1) {
        const idx = row * COLS + col;
        const shape = solid[idx];
        const mat = material[idx];
        const inShape = shape > 0;
        const onEdge = inShape && isEdgeCell(solid, col, row, COLS, rows);
        const justStacked = settling[idx];

        const distFromHead = headRow - row;
        let rain = 0;
        if (distFromHead >= 0 && distFromHead < trail) {
          rain = 1 - distFromHead / trail;
          if (distFromHead === 0) rain = 1.35;
        }
        const rainGate = 1 - phase.lock * 0.35;
        const ambient = (0.14 + 0.16 * hash01(col, row, Math.floor(frame / 2))) * (0.7 + phase.building * 0.5);
        rain = Math.max(rain * rainGate, ambient * (0.55 + rainGate * 0.45));

        const nx = (col + 0.5) / COLS;
        const ny = (row + 0.5) / rows;
        const stackOrder = clamp01((1 - ny) * 0.82 + hash01(col, row, 17) * 0.18);
        const pouring =
          phase.building *
          Math.max(
            pourIntensity(stackOrder, phase.oneForm, sampleMask(masks.one, nx, ny)),
            pourIntensity(stackOrder, phase.twoForm, sampleMask(masks.two, nx, ny)),
            pourIntensity(stackOrder, phase.circleForm, sampleMask(masks.ring, nx, ny)),
            pourIntensity(stackOrder, phase.coreForm, sampleMask(masks.bond, nx, ny))
          );
        rain = Math.max(rain, pouring * 1.15);

        let brightness;
        if (inShape) {
          const base = mat === 4 ? 1.1 : 0.9;
          brightness =
            onEdge || justStacked > 0.55
              ? 1.35
              : base + shape * 0.08 * phase.glow + rain * 0.05 + justStacked * 0.25;
        } else {
          brightness = rain;
        }
        if (brightness < 0.04) continue;

        const seed = Math.floor(frame / (inShape && justStacked < 0.35 ? (onEdge ? 5 : 14) : 2));
        const glyph = GLYPHS[hashInt(col, row, seed) % GLYPHS.length];
        const isRainHead = !inShape && distFromHead === 0 && rain > 0.95;

        let rgb;
        if (isRainHead || onEdge || justStacked > 0.7) {
          rgb = GREEN_HOT;
        } else if (inShape) {
          rgb = mat === 4
            ? mixRgb(GREEN_ACCENT, GREEN_HOT, 0.55)
            : mixRgb(GREEN_BODY, GREEN_EDGE, clamp01((brightness - 0.7) / 0.4));
        } else if (brightness > 0.75) {
          rgb = mixRgb(GREEN_MID, GREEN_HOT, (brightness - 0.75) / 0.35);
        } else {
          rgb = mixRgb(GREEN_DIM, GREEN_MID, brightness / 0.75);
        }

        const [r, g, b] = rgb;
        const alpha = inShape
          ? onEdge
            ? 0.98
            : 0.72 + brightness * 0.28
          : 0.12 + brightness * 0.72;

        const x = col * cell + cell * 0.5;
        const y = row * cell + cell * 0.5;

        if (inShape) {
          if (onEdge || justStacked > 0.5) {
            ctx.fillStyle = `rgba(${GREEN_EDGE[0]},${GREEN_EDGE[1]},${GREEN_EDGE[2]},${0.22 + 0.16 * phase.glow})`;
            ctx.fillRect(col * cell - 1, row * cell - 1, cell + 2, cell + 2);
          }
          const plateA = mat === 4 ? 0.58 : onEdge ? 0.52 : 0.38 + justStacked * 0.15;
          ctx.fillStyle = `rgba(${r},${g},${b},${plateA})`;
          ctx.fillRect(col * cell + 0.5, row * cell + 0.5, cell - 1, cell - 1);
        }

        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.fillText(glyph, x, y);
      }
    }
  }, [frame, width, height, fps, totalSeconds, cell, rows]);

  return h("canvas", {
    ref: canvasRef,
    width,
    height,
    style: { width: "100%", height: "100%", display: "block" }
  });
}

// ─── Japanese text → binary mask (real system fonts) ────────────────────────

const JP_FONT =
  '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans CJK JP", "Noto Sans JP", "Yu Gothic", "YuGothic", "Meiryo", sans-serif';

/**
 * Draw a centered Japanese word onto the matrix grid mask.
 * scale ≈ fraction of mask height for font size (worked well at ~0.4–0.5).
 */
function rasterizeCenteredWord(word, width, height, scale) {
  const gw = COLS;
  const gh = Math.max(1, Math.ceil(height / (width / COLS)));
  const c = document.createElement("canvas");
  c.width = gw;
  c.height = gh;
  const g = c.getContext("2d");
  g.fillStyle = "#000";
  g.fillRect(0, 0, gw, gh);
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  const fontPx = Math.max(10, Math.floor(gh * scale));
  g.font = `900 ${fontPx}px ${JP_FONT}`;
  g.fillText(word, gw / 2, gh / 2 + fontPx * 0.04);
  return imageDataToMask(g.getImageData(0, 0, gw, gh), gw, gh);
}

/** Four short words at top / right / bottom / left. */
function rasterizeWordDiamond(words, width, height) {
  const gw = COLS;
  const gh = Math.max(1, Math.ceil(height / (width / COLS)));
  const c = document.createElement("canvas");
  c.width = gw;
  c.height = gh;
  const g = c.getContext("2d");
  g.fillStyle = "#000";
  g.fillRect(0, 0, gw, gh);
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  const fontPx = Math.max(9, Math.floor(gh * 0.14));
  g.font = `900 ${fontPx}px ${JP_FONT}`;

  const positions = [
    { t: words[0], x: 0.5, y: 0.2 },
    { t: words[1], x: 0.78, y: 0.5 },
    { t: words[2], x: 0.5, y: 0.8 },
    { t: words[3], x: 0.22, y: 0.5 }
  ];
  for (const p of positions) {
    g.fillText(p.t, gw * p.x, gh * p.y);
  }
  return imageDataToMask(g.getImageData(0, 0, gw, gh), gw, gh);
}

function imageDataToMask(imageData, gw, gh) {
  const data = imageData.data;
  const occ = new Uint8Array(gw * gh);
  for (let i = 0; i < gw * gh; i += 1) {
    occ[i] = data[i * 4] > 30 ? 1 : 0;
  }
  const mat = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y += 1) {
    for (let x = 0; x < gw; x += 1) {
      const i = y * gw + x;
      if (!occ[i]) continue;
      let edge = false;
      for (let dy = -1; dy <= 1 && !edge; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh || !occ[ny * gw + nx]) {
            edge = true;
            break;
          }
        }
      }
      mat[i] = edge ? 4 : 3;
    }
  }
  return { occ, mat, gw, gh };
}

function sampleMask(mask, nx, ny) {
  if (!mask) return { v: 0, mat: 0 };
  const x = Math.min(mask.gw - 1, Math.max(0, Math.floor(nx * mask.gw)));
  const y = Math.min(mask.gh - 1, Math.max(0, Math.floor(ny * mask.gh)));
  const i = y * mask.gw + x;
  if (!mask.occ[i]) return { v: 0, mat: 0 };
  return { v: 1, mat: mask.mat[i] || 3 };
}

function isEdgeCell(solid, col, row, cols, rows) {
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const c = col + dx;
      const r = row + dy;
      if (c < 0 || c >= cols || r < 0 || r >= rows) return true;
      if (solid[r * cols + c] <= 0) return true;
    }
  }
  return false;
}

function bondPhases(t, totalSeconds) {
  const scale = totalSeconds > 0 ? 30 / totalSeconds : 1;
  const s = t * scale;

  const oneForm = formEnvelope(s, 2.2, 6.8, 9.0, 11.0);
  const twoForm = formEnvelope(s, 9.2, 13.8, 16.4, 18.4);
  const circleForm = formEnvelope(s, 16.8, 21.6, 24.6, 26.6);
  const coreForm = formEnvelope(s, 25.4, 28.0, 29.4, 30.0);

  const building = Math.max(
    oneForm.build > 0 && oneForm.build < 1 ? 1 : 0,
    twoForm.build > 0 && twoForm.build < 1 ? 1 : 0,
    circleForm.build > 0 && circleForm.build < 1 ? 1 : 0,
    coreForm.build > 0 && coreForm.build < 1 ? 1 : 0,
    oneForm.dissolve > 0 && oneForm.dissolve < 1 ? 0.6 : 0,
    twoForm.dissolve > 0 && twoForm.dissolve < 1 ? 0.6 : 0,
    circleForm.dissolve > 0 && circleForm.dissolve < 1 ? 0.6 : 0
  );

  const lock = Math.max(oneForm.presence, twoForm.presence, circleForm.presence, coreForm.presence);
  const glow =
    0.72 +
    0.28 * Math.sin(s * Math.PI * 0.65) * lock +
    0.25 * smoothstep(26, 29.5, s);

  return { oneForm, twoForm, circleForm, coreForm, building, lock, glow: clamp01(glow) };
}

function formEnvelope(s, buildStart, buildEnd, holdEnd, dissolveEnd) {
  const build = smoothstep(buildStart, buildEnd, s);
  const dissolve = s < holdEnd ? 0 : smoothstep(holdEnd, dissolveEnd, s);
  const presence = clamp01(build * (1 - dissolve * 0.92));
  return { build, dissolve, presence };
}

function cellStacked(stackOrder, build, dissolve) {
  if (build <= 0.001) return false;
  if (stackOrder > build) return false;
  if (dissolve > 0.001 && stackOrder < dissolve) return false;
  return true;
}

function pourIntensity(stackOrder, form, sample) {
  if (sample.v < 0.5) return 0;
  if (form.build <= 0.001 || form.build >= 1) return 0;
  if (stackOrder > form.build) {
    const ahead = stackOrder - form.build;
    return clamp01(1.1 - ahead * 2.2);
  }
  const under = form.build - stackOrder;
  return under < 0.12 ? 0.55 : 0;
}

function Hud({ second, title, draft, totalSeconds }) {
  const scale = totalSeconds > 0 ? 30 / totalSeconds : 1;
  const s = second * scale;
  const phaseLabel =
    s < 2.5
      ? "起源 // 雨"
      : s < 9.5
        ? "01 // 私"
        : s < 16.8
          ? "02 // 私たち"
          : s < 25.4
            ? "03 // みんな"
            : "04 // 絆";

  const fadeIn = Math.min(0.4, totalSeconds * 0.2);
  const fadeOutStart = Math.max(fadeIn + 0.05, totalSeconds - Math.min(1.2, totalSeconds * 0.25));
  const opacity = interpolate(
    second,
    [0, fadeIn, fadeOutStart, Math.max(fadeOutStart + 0.01, totalSeconds)],
    [0, 1, 1, 0.55],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return h(
    AbsoluteFill,
    {
      style: {
        pointerEvents: "none",
        opacity,
        padding: "5.5% 6%",
        justifyContent: "space-between"
      }
    },
    h(
      "div",
      {
        style: {
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          fontSize: 15,
          letterSpacing: "0.12em",
          color: "rgba(160,255,188,0.72)",
          textShadow: "0 0 12px rgba(40,220,100,0.4)"
        }
      },
      h("div", null, title),
      h("div", null, phaseLabel)
    ),
    h(
      "div",
      {
        style: {
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          fontSize: 13,
          letterSpacing: "0.08em",
          color: "rgba(140,240,170,0.5)"
        }
      },
      h("div", null, draft ? "下書き · 日本語" : "日本語"),
      h("div", null, formatTimecode(second, totalSeconds))
    )
  );
}

function Vignette() {
  return h("div", {
    style: {
      position: "absolute",
      inset: 0,
      pointerEvents: "none",
      background:
        "radial-gradient(ellipse at 50% 42%, transparent 60%, rgba(0,0,0,0.12) 90%, rgba(0,0,0,0.28) 100%)"
    }
  });
}

function Scanlines({ frame }) {
  const shift = (frame % 4) * 0.4;
  return h("div", {
    style: {
      position: "absolute",
      inset: 0,
      pointerEvents: "none",
      opacity: 0.06,
      backgroundImage:
        "repeating-linear-gradient(0deg, rgba(0,0,0,0.5) 0 1px, transparent 1px 2px)",
      backgroundPosition: `0 ${shift}px`,
      mixBlendMode: "multiply"
    }
  });
}

function formatTimecode(second, totalSeconds) {
  const s = Math.min(totalSeconds, Math.max(0, second));
  const whole = Math.floor(s);
  const frac = Math.floor((s - whole) * 30);
  return `${String(whole).padStart(2, "0")}:${String(frac).padStart(2, "0")} / ${String(
    Math.floor(totalSeconds)
  ).padStart(2, "0")}:00`;
}

function mixRgb(a, b, t) {
  const k = clamp01(t);
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k)
  ];
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1));
  return t * t * (3 - 2 * t);
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function hashInt(a, b, c) {
  let n = (a * 374761393 + b * 668265263 + c * 1274126177) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  return (n ^ (n >>> 16)) >>> 0;
}

function hash01(a, b, c) {
  return hashInt(a, b, c) / 4294967295;
}
