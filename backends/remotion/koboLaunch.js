import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";

const h = React.createElement;

export const KOBO_LAUNCH_PRESET = "kobo-launch-16x9";

// Everything is authored on a 1920x1080 stage in 30 fps "design frames" and
// scaled to the render size, so 12 fps review previews sample the same motion.
const W = 1920;
const H = 1080;
const CX = 960;
const CY = 540;

const PAPER = "#f2ede4";
const INK = "#141311";
const SHU = "#e8432a";
const AI = "#2541a8";
const AI_LIGHT = "#8a9dff";
const MUTED = "#857f74";

const JP = '"Zen Kaku Gothic New", "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif';
const SERIF = '"Shippori Mincho B1", "Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif';
const EN = '"Space Grotesk", "Helvetica Neue", Arial, sans-serif';
const DISPLAY = '"Anton", Impact, "Helvetica Neue", sans-serif';
const MONO = '"JetBrains Mono", "SFMono-Regular", Consolas, monospace';

const DEFAULT_COPY = Object.freeze({
  price: "2,480",
  regular_price: "3,480",
  deadline: "10.5",
  url: "lab.azumimusuhi.jp/kobo",
  seats_total: 30,
  seats_taken: 20,
  seats_note: "あと約1/3"
});

// ---------------------------------------------------------------- math

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const prog = (f, start, duration) => clamp01((f - start) / duration);
const lerp = (a, b, t) => a + (b - a) * t;
const E = {
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inExpo: (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inOutExpo: (t) =>
    t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
  outBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }
};

function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function mixColor(a, b, t) {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const k = clamp01(t);
  return `rgb(${Math.round(lerp(ar, br, k))}, ${Math.round(lerp(ag, bg, k))}, ${Math.round(lerp(ab, bb, k))})`;
}

function alpha(hex, opacity) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

// ---------------------------------------------------------------- shapes
// ◯△□ share one radial parametrisation so any pair can morph smoothly.

const MORPH_N = 96;
const TRI_NORMALS = [Math.PI / 2, Math.PI / 2 + (2 * Math.PI) / 3, Math.PI / 2 + (4 * Math.PI) / 3];

function unitRadius(kind, theta) {
  if (kind === "square") {
    return 0.84 / Math.max(Math.abs(Math.cos(theta)), Math.abs(Math.sin(theta)));
  }
  if (kind === "triangle") {
    let best = Infinity;
    for (const normal of TRI_NORMALS) {
      const d = Math.cos(theta - normal);
      if (d > 1e-4) best = Math.min(best, 0.62 / d);
    }
    return best;
  }
  return 1;
}

export function shapePoints({ kind, to = kind, t = 0, R, cx = CX, cy = CY, rot = 0 }) {
  const points = [];
  for (let i = 0; i < MORPH_N; i += 1) {
    const theta = -Math.PI / 2 + (i / MORPH_N) * Math.PI * 2;
    const r = lerp(unitRadius(kind, theta), unitRadius(to, theta), t) * Math.max(0, R);
    const a = theta + rot;
    points.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return points;
}

const svgPoints = (points) => points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
const clipPolygon = (points) => `polygon(${points.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(", ")})`;

function Shape({ kind, to, t, R, cx, cy, rot, fill = "none", stroke, strokeWidth, opacity = 1, dash }) {
  if (R <= 0.01) return null;
  return h("polygon", {
    points: svgPoints(shapePoints({ kind, to, t, R, cx, cy, rot })),
    fill,
    stroke,
    strokeWidth,
    strokeDasharray: dash,
    strokeLinejoin: "round",
    opacity
  });
}

function Stage({ children, style }) {
  return h(
    "svg",
    { width: W, height: H, viewBox: `0 0 ${W} ${H}`, style: { position: "absolute", left: 0, top: 0, overflow: "visible", ...style } },
    children
  );
}

// ---------------------------------------------------------------- type

function Rise({ text, f, at, stagger = 1.5, duration = 14, exitAt, exitDuration = 8, style, charStyle }) {
  const chars = Array.from(text);
  return h(
    "span",
    { style: { display: "inline-block", whiteSpace: "pre", ...style } },
    chars.map((char, index) => {
      const enter = E.outExpo(prog(f, at + index * stagger, duration));
      const leave = exitAt === undefined ? 0 : E.inExpo(prog(f, exitAt + index * stagger * 0.4, exitDuration));
      const y = (1 - enter) * 135 - leave * 140;
      const extra = typeof charStyle === "function" ? charStyle(char, index) : undefined;
      return h(
        "span",
        {
          key: index,
          style: { display: "inline-block", overflow: "hidden", verticalAlign: "top", padding: "0.12em 0.02em", margin: "-0.12em -0.02em" }
        },
        h("span", { style: { display: "inline-block", transform: `translateY(${y.toFixed(2)}%)`, ...extra } }, char)
      );
    })
  );
}

function Fade({ f, at, duration = 10, dy = 24, children, style }) {
  const p = E.outExpo(prog(f, at, duration));
  return h("div", { style: { opacity: p, transform: `translateY(${((1 - p) * dy).toFixed(2)}px)`, ...style } }, children);
}

function Abs({ x, y, children, style }) {
  return h("div", { style: { position: "absolute", left: x, top: y, ...style } }, children);
}

function Bg({ color }) {
  return h("div", { style: { position: "absolute", left: -48, top: -48, right: -48, bottom: -48, background: color } });
}

function Grid({ color, opacity = 0.07 }) {
  const line = alpha(color, opacity);
  return h("div", {
    style: {
      position: "absolute",
      inset: 0,
      backgroundImage: `linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px)`,
      backgroundSize: "120px 120px",
      backgroundPosition: "0 0"
    }
  });
}

function Scene({ clip, children }) {
  return h("div", { style: { position: "absolute", inset: 0, clipPath: clip ?? "none" } }, children);
}

const inWindow = (f, start, end) => f >= start && f < end;

function irisClip(f, start, duration, x = CX, y = CY, max = 1250) {
  if (f >= start + duration) return undefined;
  const r = lerp(0, max, E.inOutCubic(prog(f, start, duration)));
  return `circle(${r.toFixed(1)}px at ${x}px ${y}px)`;
}

// ---------------------------------------------------------------- composition

// Review previews render one shot at a time with a timeline offset and 12 fps.
export function koboDesignFrame(frame, fps, presentation) {
  const offset = Number(presentation?.timeline_offset_seconds ?? 0) || 0;
  return (frame / fps + offset) * 30;
}

export function KoboLaunch({ manifest }) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const f = koboDesignFrame(frame, fps, manifest?.presentation);
  const copy = resolveKoboCopy(manifest?.presentation?.copy);
  const scale = Math.min(width / W, height / H);
  const shake = cameraShake(f);

  return h(
    AbsoluteFill,
    { style: { backgroundColor: INK, overflow: "hidden" } },
    h(
      "div",
      {
        style: {
          position: "absolute",
          left: (width - W * scale) / 2,
          top: (height - H * scale) / 2,
          width: W,
          height: H,
          overflow: "hidden",
          transform: `scale(${scale})`,
          transformOrigin: "0 0"
        }
      },
      h(
        "div",
        { style: { position: "absolute", inset: 0, transform: `translate(${shake.x.toFixed(2)}px, ${shake.y.toFixed(2)}px)` } },
        inWindow(f, 0, 124) && h(SceneHook, { f }),
        inWindow(f, 116, 244) && h(Scene, { clip: irisClip(f, 116, 10) }, h(SceneManifesto, { f })),
        inWindow(f, 226, 364) && h(Scene, { clip: irisClip(f, 226, 14) }, h(SceneTitle, { f })),
        inWindow(f, 346, 559) && h(Scene, { clip: slatClip(f, 346, 14) }, h(SceneSeats, { f })),
        inWindow(f, 543, 664) && h(Scene, { clip: diagonalClip(f, 543, 12) }, h(SceneMonth, { f })),
        inWindow(f, 650, 754) && h(Scene, { clip: riseClip(f, 650, 12) }, h(SceneOmachi, { f })),
        inWindow(f, 750, 829) && h(ScenePrice, { f, copy }),
        f >= 819 && h(Scene, { clip: irisClip(f, 819, 12, 1500, 862, 2200) }, h(SceneLockup, { f, copy }))
      ),
      h(Hud, { f }),
      h(Finish, { f })
    )
  );
}

export function resolveKoboCopy(source) {
  const copy = { ...DEFAULT_COPY };
  if (source && typeof source === "object") {
    for (const key of Object.keys(DEFAULT_COPY)) {
      if (typeof source[key] === typeof DEFAULT_COPY[key]) copy[key] = source[key];
    }
  }
  copy.seats_total = Math.max(1, Math.min(48, Math.round(copy.seats_total)));
  copy.seats_taken = Math.max(0, Math.min(copy.seats_total, Math.round(copy.seats_taken)));
  return copy;
}

const IMPACTS = [
  { at: 120, amp: 9 },
  { at: 750, amp: 15 },
  { at: 794, amp: 11 }
];

function cameraShake(f) {
  let x = 0;
  let y = 0;
  IMPACTS.forEach((impact, index) => {
    const d = f - impact.at;
    if (d < 0 || d > 18) return;
    const decay = impact.amp * Math.exp(-d / 3.6);
    x += decay * Math.sin(d * 2.3 + index);
    y += decay * 0.7 * Math.cos(d * 2.9 + index * 2);
  });
  return { x, y };
}

function slatClip(f, start, duration) {
  if (f >= start + duration + 8) return undefined;
  const slats = 8;
  const width = W / slats;
  const points = [];
  for (let i = 0; i < slats; i += 1) {
    const reach = H * E.outExpo(prog(f, start + i, duration));
    const x0 = i * width;
    const x1 = (i + 1) * width + 0.5;
    if (i % 2 === 0) {
      points.push(`${x0}px 0px`, `${x0}px ${reach}px`, `${x1}px ${reach}px`, `${x1}px 0px`);
    } else {
      points.push(`${x0}px 0px`, `${x0}px ${H - reach}px`, `${x0}px ${H}px`, `${x1}px ${H}px`, `${x1}px ${H - reach}px`, `${x1}px 0px`);
    }
  }
  // Odd slats grow from the bottom; the zero-width spines along y=0 keep it one polygon.
  return `polygon(${points.join(", ")})`;
}

function diagonalClip(f, start, duration) {
  if (f >= start + duration) return undefined;
  const x = lerp(W + 380, -380, E.inOutExpo(prog(f, start, duration)));
  return `polygon(${x}px -60px, ${W + 60}px -60px, ${W + 60}px ${H + 60}px, ${x - 320}px ${H + 60}px)`;
}

function riseClip(f, start, duration) {
  if (f >= start + duration) return undefined;
  const top = lerp(H, 0, E.outExpo(prog(f, start, duration)));
  return `inset(${top.toFixed(1)}px 0px 0px 0px)`;
}

// ---------------------------------------------------------------- 01 hook

const HOOK_WORDS = [
  "AGENT", "生成AI", "MCP", "新モデル", "AEO", "アップデート", "LLM", "自動化", "PROMPT", "速報",
  "RAG", "ワークフロー", "VIBE CODING", "比較まとめ", "API", "エージェント", "NEW", "β版", "SDK", "最新",
  "BOT", "ベンチマーク", "v2.0", "リリース", "TOOLS", "無料枠", "CONTEXT", "マルチモーダル"
];

function SceneHook({ f }) {
  const collapse = E.inExpo(prog(f, 100, 13));
  const jitter = f > 86 && f < 104 ? (hash(Math.floor(f)) - 0.5) * 12 : 0;
  return h(
    "div",
    { style: { position: "absolute", inset: 0 } },
    h(Bg, { color: INK }),
    h(
      "div",
      {
        style: {
          position: "absolute",
          inset: 0,
          transform: `translate(${jitter}px, ${jitter * 0.4}px) scale(${Math.max(0.0001, 1 - collapse)}) rotate(${-collapse * 10}deg)`,
          transformOrigin: `${CX}px ${CY}px`,
          opacity: f >= 113 ? 0 : 1
        }
      },
      h(Marquee, { f }),
      h(HookHeadline, { f })
    ),
    f >= 109 && h(Stage, null, h("circle", { cx: CX, cy: CY, r: 20 * E.outBack(prog(f, 109, 6)), fill: SHU }))
  );
}

function Marquee({ f }) {
  const rows = [];
  const blur = 2.6 * prog(f, 84, 20);
  for (let i = 0; i < 9; i += 1) {
    const dir = i % 2 === 0 ? -1 : 1;
    const speed = 3.2 + (i % 3) * 2.1;
    const accel = 0.42 + (i % 2) * 0.18;
    const travel = speed * f + accel * Math.pow(Math.max(0, f - 40), 2);
    const base = dir > 0 ? -7600 - i * 90 : -260 - i * 137;
    const words = [];
    for (let j = 0; j < 60; j += 1) {
      const word = HOOK_WORDS[(j + i * 5) % HOOK_WORDS.length];
      const latin = /^[\x20-\x7e]+$/.test(word);
      const hot = hash(i * 71 + j * 13) > 0.935;
      words.push(
        h(
          "span",
          {
            key: j,
            style: {
              display: "inline-block",
              marginRight: 64,
              fontFamily: latin ? DISPLAY : JP,
              fontWeight: latin ? 400 : 900,
              fontSize: latin ? 104 : 86,
              letterSpacing: latin ? "0.01em" : "-0.02em",
              color: hot ? SHU : alpha(PAPER, latin ? 0.2 : 0.15)
            }
          },
          word
        )
      );
    }
    rows.push(
      h(
        "div",
        {
          key: i,
          style: {
            position: "absolute",
            left: 0,
            top: -34 + i * 124,
            height: 124,
            lineHeight: "124px",
            whiteSpace: "nowrap",
            opacity: prog(f, i * 1.5, 8),
            transform: `translateX(${(base + dir * travel).toFixed(1)}px)`,
            filter: blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : undefined
          }
        },
        words
      )
    );
  }
  return h("div", { style: { position: "absolute", inset: 0 } }, rows);
}

function HookHeadline({ f }) {
  const open = E.outExpo(prog(f, 18, 12));
  const glitch = prog(f, 86, 4) * (1 - prog(f, 108, 4));
  const count = Math.floor(4 * f + 0.075 * f * f);
  const line = (color, dx, dy, opacity) =>
    h(
      "div",
      { style: { position: "absolute", left: 0, right: 0, top: 150, textAlign: "center", transform: `translate(${dx}px, ${dy}px)`, opacity } },
      h(Rise, {
        text: "追いかけるだけ？",
        f,
        at: 32,
        stagger: 2.4,
        style: { fontFamily: JP, fontWeight: 900, fontSize: 172, letterSpacing: "-0.03em", lineHeight: 1, color },
        charStyle: (char) => (char === "？" && color === PAPER ? { color: SHU } : undefined)
      })
    );
  const g = (seed) => (hash(Math.floor(f) * 3 + seed) - 0.5) * 22 * glitch;
  return h(
    "div",
    { style: { position: "absolute", left: 300, top: 318, width: 1320, height: 444 } },
    h("div", {
      style: {
        position: "absolute",
        inset: 0,
        background: INK,
        border: `2px solid ${alpha(PAPER, 0.16)}`,
        transform: `scaleX(${open})`,
        boxShadow: "0 40px 120px rgba(0,0,0,.55)"
      }
    }),
    h(Abs, { x: 0, y: -46 }, h(Fade, { f, at: 22, dy: 10 }, h("span", { style: { fontFamily: MONO, fontWeight: 700, fontSize: 22, letterSpacing: "0.18em", color: SHU } }, "Q.01 — INPUT OVERLOAD"))),
    h(
      "div",
      { style: { position: "absolute", left: 0, right: 0, top: 56, textAlign: "center" } },
      h(Rise, { text: "新しいAI、", f, at: 24, stagger: 1.6, style: { fontFamily: JP, fontWeight: 700, fontSize: 84, color: PAPER, lineHeight: 1 } })
    ),
    glitch > 0 && line(SHU, g(1), g(2) * 0.3, 0.85),
    glitch > 0 && line(AI_LIGHT, g(3), g(4) * 0.3, 0.85),
    line(PAPER, glitch > 0 ? g(5) * 0.3 : 0, 0, 1),
    h(
      Abs,
      { x: 0, y: 372, style: { width: 1280, textAlign: "right" } },
      h(Fade, { f, at: 40, dy: 8 }, h("span", { style: { fontFamily: MONO, fontWeight: 500, fontSize: 24, letterSpacing: "0.12em", color: alpha(PAPER, 0.55) } }, `NEW TODAY  +${count.toLocaleString("en-US")}`))
    )
  );
}

// ---------------------------------------------------------------- 02 manifesto

const MANIFESTO = [
  { text: "作って、", at: 12, exit: 39, label: "01 — MAKE / 作る" },
  { text: "試して、", at: 42, exit: 69, label: "02 — TRY / 試す" },
  { text: "遊ぶ。", at: 72, exit: undefined, label: "03 — PLAY / 遊ぶ" }
];

function manifestoShape(l) {
  if (l < 6) {
    return { kind: "circle", to: "circle", t: 0, R: 20 + 6 * E.outBack(prog(l, 0, 6)), rot: 0, color: SHU };
  }
  if (l < 41) {
    const p = prog(l, 6, 12);
    return {
      kind: "circle",
      to: "square",
      t: E.inOutCubic(p),
      R: lerp(26, 300, E.outExpo(p)) + 6 * Math.sin(Math.max(0, l - 18) / 5) * Math.exp(-Math.max(0, l - 18) / 12),
      rot: lerp(-Math.PI * 0.75, 0, E.outBack(p)),
      color: mixColor(SHU, INK, E.outCubic(p))
    };
  }
  if (l < 71) {
    const p = prog(l, 41, 9);
    return {
      kind: "square",
      to: "triangle",
      t: E.inOutCubic(p),
      R: 300 + 34 * Math.sin(Math.PI * p),
      rot: lerp(0, (Math.PI * 2) / 3, E.outBack(p)),
      color: mixColor(INK, AI, p)
    };
  }
  const p = prog(l, 71, 9);
  const settle = Math.max(0, l - 80);
  return {
    kind: "triangle",
    to: "circle",
    t: E.inOutCubic(p),
    R: (l < 80 ? 300 + 30 * Math.sin(Math.PI * p) : 300) + 26 * Math.exp(-settle / 5) * Math.sin(settle / 1.4),
    rot: (Math.PI * 2) / 3,
    color: mixColor(AI, SHU, p)
  };
}

function SceneManifesto({ f }) {
  const l = f - 120;
  const shape = manifestoShape(l);
  const points = shapePoints({ kind: shape.kind, to: shape.to, t: shape.t, R: shape.R, rot: shape.rot });
  const words = (color) =>
    h(
      "div",
      { style: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" } },
      MANIFESTO.map((word) =>
        h(
          "div",
          { key: word.text, style: { position: "absolute", left: 0, right: 0, top: 384, textAlign: "center" } },
          h(Rise, {
            text: word.text,
            f: l,
            at: word.at,
            exitAt: word.exit,
            stagger: 2,
            duration: 12,
            style: { fontFamily: JP, fontWeight: 900, fontSize: 300, lineHeight: 1, letterSpacing: "-0.05em", color }
          })
        )
      )
    );
  const ring = "AI AGENT WORKSHOP ◯ ONLINE KOBO △ 作って、試して、遊ぶ。 □ ".repeat(3);
  return h(
    "div",
    { style: { position: "absolute", inset: 0 } },
    h(Bg, { color: PAPER }),
    h(Grid, { color: INK, opacity: 0.06 }),
    h(
      Stage,
      null,
      h("line", { x1: 0, y1: CY, x2: W, y2: CY, stroke: alpha(INK, 0.14), strokeWidth: 1 }),
      h("line", { x1: CX, y1: 0, x2: CX, y2: H, stroke: alpha(INK, 0.14), strokeWidth: 1 }),
      h("defs", null, h("path", { id: "kobo-ring", d: `M ${CX - 430} ${CY} a 430 430 0 1 1 860 0 a 430 430 0 1 1 -860 0` })),
      h(
        "g",
        { transform: `rotate(${(l * 0.55).toFixed(2)} ${CX} ${CY})`, opacity: prog(l, 8, 12) },
        h("text", { style: { fontFamily: EN, fontWeight: 500, fontSize: 19, letterSpacing: "0.32em" }, fill: alpha(INK, 0.5) }, h("textPath", { href: "#kobo-ring" }, ring))
      ),
      h("polygon", { points: svgPoints(points), fill: shape.color })
    ),
    words(INK),
    h("div", { style: { position: "absolute", inset: 0, clipPath: clipPolygon(points) } }, words(PAPER)),
    h(
      Abs,
      { x: 120, y: 112 },
      MANIFESTO.map((word) =>
        h(
          "div",
          { key: word.label, style: { position: "absolute", left: 0, top: 0, whiteSpace: "nowrap" } },
          h(Rise, {
            text: word.label,
            f: l,
            at: word.at - 2,
            exitAt: word.exit,
            stagger: 0.5,
            duration: 10,
            style: { fontFamily: EN, fontWeight: 700, fontSize: 24, letterSpacing: "0.3em", color: INK }
          })
        )
      )
    ),
    h(
      Abs,
      { x: 1500, y: 112, style: { width: 300, textAlign: "right" } },
      h(Fade, { f: l, at: 4, dy: 8 }, h("span", { style: { fontFamily: MONO, fontWeight: 500, fontSize: 20, letterSpacing: "0.16em", color: alpha(INK, 0.55) } }, "MANIFESTO"))
    )
  );
}

// ---------------------------------------------------------------- 03 title

const CATEGORIES = [
  { text: "AIエージェント", kind: "circle", color: SHU },
  { text: "映像", kind: "triangle", color: AI_LIGHT },
  { text: "音楽", kind: "square", color: PAPER },
  { text: "Web", kind: "circle", color: SHU },
  { text: "アプリ", kind: "triangle", color: AI_LIGHT }
];

function SceneTitle({ f }) {
  const l = f - 240;
  return h(
    "div",
    { style: { position: "absolute", inset: 0 } },
    h(Bg, { color: INK }),
    h(
      "div",
      {
        style: {
          position: "absolute",
          left: 150 - l * 1.4,
          bottom: -210,
          whiteSpace: "nowrap",
          fontFamily: DISPLAY,
          fontSize: 900,
          lineHeight: 1,
          color: "transparent",
          WebkitTextStroke: `3px ${alpha(PAPER, 0.17)}`
        }
      },
      h(Rise, { text: "KOBO", f: l, at: -8, stagger: 3, duration: 18 })
    ),
    h(
      Abs,
      { x: 150, y: 146, style: { display: "flex", alignItems: "center", gap: 22, width: 1440 } },
      h("div", { style: { width: 14, height: 14, background: SHU, transform: `scale(${E.outBack(prog(l, 0, 10))})` } }),
      h(Rise, { text: "AI AGENT WORKSHOP / ONLINE KOBO", f: l, at: 1, stagger: 0.4, duration: 10, style: { fontFamily: EN, fontWeight: 700, fontSize: 25, letterSpacing: "0.32em", color: PAPER } }),
      h("div", { style: { flex: 1, height: 2, background: alpha(PAPER, 0.3), transform: `scaleX(${E.outExpo(prog(l, 4, 20))})`, transformOrigin: "left" } })
    ),
    h(Abs, { x: 150, y: 292 }, h(Rise, { text: "AIエージェント創作開発ラボ", f: l, at: 1, stagger: 1, style: { fontFamily: SERIF, fontWeight: 800, fontSize: 68, color: PAPER, lineHeight: 1 } })),
    h(
      Abs,
      { x: 142, y: 388 },
      h(Rise, {
        text: "オンライン工房",
        f: l,
        at: 5,
        stagger: 2.4,
        duration: 16,
        style: { fontFamily: JP, fontWeight: 900, fontSize: 236, letterSpacing: "-0.04em", color: PAPER, lineHeight: 1 },
        charStyle: (char) => (char === "工" || char === "房" ? { color: SHU } : undefined)
      })
    ),
    h(Abs, { x: 152, y: 686 }, h(Rise, { text: "いとぱんが開く、AI創作ラボ。", f: l, at: 20, stagger: 0.9, style: { fontFamily: JP, fontWeight: 500, fontSize: 50, color: alpha(PAPER, 0.88), lineHeight: 1 } })),
    h(
      Abs,
      { x: 150, y: 846, style: { display: "flex", gap: 18 } },
      CATEGORIES.map((chip, index) => {
        const p = prog(l, 36 + index * 6, 12);
        return h(
          "div",
          {
            key: chip.text,
            style: {
              display: "flex",
              alignItems: "center",
              gap: 14,
              padding: "14px 30px 16px 22px",
              border: `2px solid ${alpha(PAPER, 0.42)}`,
              borderRadius: 999,
              opacity: clamp01(p * 3),
              transform: `translateY(${(1 - E.outBack(p)) * 40}px) scale(${lerp(0.7, 1, E.outBack(p))})`,
              fontFamily: JP,
              fontWeight: 700,
              fontSize: 38,
              color: PAPER,
              lineHeight: 1
            }
          },
          h(
            "svg",
            { width: 30, height: 30, viewBox: "0 0 30 30" },
            h(Shape, { kind: chip.kind, R: chip.kind === "triangle" ? 11 : 12, cx: 15, cy: chip.kind === "triangle" ? 17 : 15, fill: chip.color })
          ),
          chip.text
        );
      })
    ),
    h(TrioMark, { x: 1660, y: 152, size: 34, f: l, at: 6, colors: [SHU, AI_LIGHT, PAPER] })
  );
}

function TrioMark({ x, y, size, f, at, colors, gap = 2.6 }) {
  const kinds = ["circle", "triangle", "square"];
  return h(
    Stage,
    null,
    kinds.map((kind, index) => {
      const p = E.outBack(prog(f, at + index * 3, 12));
      return h(Shape, {
        key: kind,
        kind,
        R: size * p * (kind === "triangle" ? 0.95 : 1),
        cx: x + index * size * gap,
        cy: y + (kind === "triangle" ? size * 0.16 : 0),
        rot: (1 - p) * Math.PI,
        fill: colors[index]
      });
    })
  );
}

// ---------------------------------------------------------------- 04 seats

function SceneSeats({ f }) {
  const l = f - 360;
  return h(
    "div",
    { style: { position: "absolute", inset: 0 } },
    l < 45 && h(SeatWatch, { l }),
    inWindow(l, 37, 90) && h(Scene, { clip: shapeCover(l, 37, 8, "triangle", 2900, 0) }, h(SeatTry, { l })),
    inWindow(l, 82, 135) && h(Scene, { clip: shapeCover(l, 82, 8, "square", 2300, Math.PI / 4) }, h(SeatMake, { l })),
    l >= 127 && h(Scene, { clip: riseClip(l, 127, 10) }, h(SeatPick, { l }))
  );
}

function shapeCover(l, start, duration, kind, max, spin) {
  if (l >= start + duration) return undefined;
  const p = E.inOutCubic(prog(l, start, duration));
  return clipPolygon(shapePoints({ kind, R: lerp(0, max, p), cx: 1380, cy: 540, rot: spin * (1 - p) }));
}

function SeatCopy({ l, at, index, en, word, sub, color, labelColor }) {
  return h(
    React.Fragment,
    null,
    h(Abs, { x: 150, y: 286 }, h(Rise, { text: `0${index} — ${en}`, f: l, at, stagger: 0.6, duration: 10, style: { fontFamily: EN, fontWeight: 700, fontSize: 26, letterSpacing: "0.32em", color: labelColor } })),
    h(Abs, { x: 136, y: 330 }, h(Rise, { text: word, f: l, at: at + 2, stagger: 3, duration: 14, style: { fontFamily: JP, fontWeight: 900, fontSize: 340, letterSpacing: "-0.04em", lineHeight: 1, color } })),
    h(Abs, { x: 150, y: 724 }, h(Rise, { text: sub, f: l, at: at + 9, stagger: 0.7, duration: 12, style: { fontFamily: JP, fontWeight: 700, fontSize: 58, lineHeight: 1, color } }))
  );
}

function SeatWatch({ l }) {
  const pop = E.outBack(prog(l, -8, 16));
  const look = Math.sin(l / 6.5) * 72;
  const eye = E.outBack(prog(l, 2, 10));
  return h(
    "div",
    { style: { position: "absolute", inset: 0 } },
    h(Bg, { color: PAPER }),
    h(Grid, { color: INK, opacity: 0.05 }),
    h(
      Stage,
      null,
      h("circle", { cx: 1380, cy: 540, r: 455, fill: "none", stroke: alpha(INK, 0.35), strokeWidth: 2, strokeDasharray: "3 15", transform: `rotate(${l * 0.8} 1380 540)`, opacity: pop }),
      h("circle", { cx: 1380, cy: 540, r: 400 * pop, fill: SHU }),
      h("circle", { cx: 1380 + look * 0.55, cy: 540, r: 158 * eye, fill: PAPER }),
      h("circle", { cx: 1380 + look * 1.05, cy: 540, r: 66 * eye, fill: INK })
    ),
    h(SeatCopy, { l, at: -6, index: 1, en: "WATCH", word: "見る", sub: "実演を、見るだけでもいい。", color: INK, labelColor: SHU })
  );
}

function SeatTry({ l }) {
  const turn = E.outBack(prog(l, 50, 10));
  const press = prog(l, 60, 3);
  const pulse = 1 - 0.08 * Math.sin(Math.PI * prog(l, 60, 6));
  const run = E.inOutCubic(prog(l, 62, 22));
  return h(
    "div",
    { style: { position: "absolute", inset: 0 } },
    h(Bg, { color: AI }),
    h(Grid, { color: PAPER, opacity: 0.06 }),
    h(
      Stage,
      null,
      h(
        "g",
        { transform: `translate(1380 540) scale(${pulse}) translate(-1380 -540)` },
        h(Shape, { kind: "triangle", R: 300, cx: 1380, cy: 540, rot: (Math.PI / 2) * turn, fill: alpha(PAPER, press), stroke: PAPER, strokeWidth: 10 })
      ),
      h("rect", { x: 1150, y: 930, width: 560, height: 6, fill: alpha(PAPER, 0.22) }),
      h("rect", { x: 1150, y: 930, width: 560 * run, height: 6, fill: PAPER })
    ),
    h(
      Abs,
      { x: 1150, y: 956, style: { width: 560, display: "flex", justifyContent: "space-between", fontFamily: MONO, fontWeight: 500, fontSize: 20, letterSpacing: "0.14em", color: alpha(PAPER, 0.75), opacity: prog(l, 58, 6) } },
      h("span", null, "RUN TEMPLATE"),
      h("span", null, `${Math.round(run * 100)}%`)
    ),
    h(SeatCopy, { l, at: 41, index: 2, en: "TRY", word: "試す", sub: "テンプレートを、そのまま動かす。", color: PAPER, labelColor: alpha(PAPER, 0.7) })
  );
}

const SWAPS = [
  [1, 6],
  [9, 14],
  [3, 12]
];

function SeatMake({ l }) {
  const size = 112;
  const gap = 14;
  const origin = 1380 - (4 * size + 3 * gap) / 2;
  const top = 540 - (4 * size + 3 * gap) / 2;
  const swap = E.outExpo(prog(l, 112, 9));
  const cellOf = (index) => [origin + (index % 4) * (size + gap), top + Math.floor(index / 4) * (size + gap)];
  const blocks = [];
  for (let i = 0; i < 16; i += 1) {
    const assemble = E.outExpo(prog(l, 86 + i * 0.8, 16));
    let [x, y] = cellOf(i);
    for (const [a, b] of SWAPS) {
      const partner = i === a ? b : i === b ? a : undefined;
      if (partner !== undefined) {
        const [px, py] = cellOf(partner);
        x = lerp(x, px, swap);
        y = lerp(y, py, swap);
      }
    }
    const sx = (hash(i * 3.1) * 2 - 1) * 620 * (1 - assemble);
    const sy = (hash(i * 7.7) * 2 - 1) * 420 * (1 - assemble);
    const spin = (hash(i * 5.3) * 2 - 1) * 200 * (1 - assemble) + (i === 15 ? 45 * E.outBack(prog(l, 120, 10)) : 0);
    const fill = i === 6 && l >= 112 ? mixColor(PAPER, SHU, prog(l, 112, 4)) : i === 9 && l >= 117 ? mixColor(PAPER, AI_LIGHT, prog(l, 117, 4)) : PAPER;
    blocks.push(
      h("rect", {
        key: i,
        x: x + sx,
        y: y + sy,
        width: size,
        height: size,
        fill,
        opacity: clamp01(assemble * 1.6),
        transform: `rotate(${spin.toFixed(2)} ${x + sx + size / 2} ${y + sy + size / 2})`
      })
    );
  }
  return h(
    "div",
    { style: { position: "absolute", inset: 0 } },
    h(Bg, { color: INK }),
    h(Grid, { color: PAPER, opacity: 0.05 }),
    h(Stage, null, blocks),
    h(SeatCopy, { l, at: 86, index: 3, en: "MAKE", word: "作る", sub: "自分向けに、改造する。", color: PAPER, labelColor: SHU })
  );
}

const SEATS = [
  { kind: "circle", color: SHU, x: 560, jp: "見る", en: "WATCH" },
  { kind: "triangle", color: AI, x: 960, jp: "試す", en: "TRY" },
  { kind: "square", color: INK, x: 1360, jp: "作る", en: "MAKE" }
];
const HOPS = [146, 157, 168];

function SeatPick({ l }) {
  let selected = 0;
  HOPS.forEach((hop, index) => {
    if (l >= hop) selected = index;
  });
  const fromX = SEATS[Math.max(0, selected - 1)].x;
  const toX = SEATS[selected].x;
  const cursorX = selected === 0 ? toX : lerp(fromX, toX, E.outExpo(prog(l, HOPS[selected], 7)));
  const cursorIn = E.outBack(prog(l, HOPS[0], 9));
  return h(
    "div",
    { style: { position: "absolute", inset: 0 } },
    h(Bg, { color: PAPER }),
    h(Grid, { color: INK, opacity: 0.05 }),
    h(
      "div",
      { style: { position: "absolute", left: 0, right: 0, top: 168, textAlign: "center" } },
      h(Rise, {
        text: "今日は、どの席から？",
        f: l,
        at: 128,
        stagger: 1.4,
        style: { fontFamily: JP, fontWeight: 900, fontSize: 122, letterSpacing: "-0.03em", lineHeight: 1, color: INK },
        charStyle: (char) => (char === "？" ? { color: SHU } : undefined)
      })
    ),
    h(
      Stage,
      null,
      SEATS.map((seat, index) => {
        const pop = E.outBack(prog(l, 136 + index * 3, 12));
        const kick = index === selected && l >= HOPS[index] ? 0.14 * Math.exp(-(l - HOPS[index]) / 4) : 0;
        return h(Shape, {
          key: seat.jp,
          kind: seat.kind,
          R: 118 * pop * (1 + kick) * (seat.kind === "triangle" ? 1.02 : 1),
          cx: seat.x,
          cy: seat.kind === "triangle" ? 582 : 556,
          rot: (1 - pop) * -Math.PI,
          fill: seat.color
        });
      }),
      cursorIn > 0.001 &&
        h(
          "g",
          { transform: `translate(${cursorX} 556) scale(${lerp(1.35, 1, cursorIn)})`, opacity: clamp01(cursorIn * 2) },
          [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1]
          ].map(([sx, sy], index) =>
            h("path", { key: index, d: `M ${sx * 172} ${sy * 120} L ${sx * 172} ${sy * 172} L ${sx * 120} ${sy * 172}`, fill: "none", stroke: SHU, strokeWidth: 7, strokeLinecap: "square" })
          )
        )
    ),
    SEATS.map((seat, index) =>
      h(
        "div",
        { key: seat.en, style: { position: "absolute", left: seat.x - 200, width: 400, top: 752, textAlign: "center" } },
        h(Rise, { text: seat.jp, f: l, at: 140 + index * 3, stagger: 2, style: { fontFamily: JP, fontWeight: 900, fontSize: 62, lineHeight: 1, color: INK } }),
        h("div", { style: { marginTop: 18, fontFamily: EN, fontWeight: 700, fontSize: 20, letterSpacing: "0.34em", color: MUTED, opacity: prog(l, 144 + index * 3, 8) } }, seat.en)
      )
    ),
    h(
      "div",
      { style: { position: "absolute", left: 0, right: 0, top: 924, textAlign: "center" } },
      h(Rise, { text: "見るだけでも、手を動かしても。", f: l, at: 150, stagger: 0.7, style: { fontFamily: JP, fontWeight: 500, fontSize: 40, lineHeight: 1, color: MUTED } })
    )
  );
}

// ---------------------------------------------------------------- 05 month

const MONTH_ITEMS = [
  { at: 12, icon: "circle", color: SHU, tag: "MONTHLY", title: "月例工房", sub: "月1回以上・60〜90分" },
  { at: 27, icon: "triangle", color: AI_LIGHT, tag: "LIVE", title: "作業場ライブ", sub: "いま触っているAIを、画面共有で" },
  { at: 42, icon: "dots", color: PAPER, tag: "DAILY", title: "Discordの工房", sub: "途中経過・相談・配布が毎日流れる" },
  { at: 57, icon: "play", color: PAPER, tag: "ARCHIVE", title: "録画・資料", sub: "途中参加でも、あとから見返せる" }
];
const CAL = { x: 1046, y: 262, cell: 96, gap: 12, cols: 7, rows: 5 };
const LIVE_CELLS = [9, 16, 31];
const MONTHLY_CELL = 20;

function SceneMonth({ f }) {
  const l = f - 555;
  const cells = [];
  const markers = [];
  for (let index = 0; index < CAL.cols * CAL.rows; index += 1) {
    const col = index % CAL.cols;
    const row = Math.floor(index / CAL.cols);
    const x = CAL.x + col * (CAL.cell + CAL.gap);
    const y = CAL.y + row * (CAL.cell + CAL.gap);
    const p = E.outBack(prog(l, -8 + (col + row) * 1.2, 10));
    const c = CAL.cell / 2;
    cells.push(
      h("rect", {
        key: `cell-${index}`,
        x: x + c * (1 - p),
        y: y + c * (1 - p),
        width: CAL.cell * p,
        height: CAL.cell * p,
        rx: 6,
        fill: alpha(PAPER, 0.035),
        stroke: alpha(PAPER, 0.22),
        strokeWidth: 1.5
      })
    );
    const dot = prog(l, 42 + index * 0.28, 6);
    if (dot > 0) markers.push(h("circle", { key: `dot-${index}`, cx: x + CAL.cell - 18, cy: y + CAL.cell - 18, r: 7 * E.outBack(dot), fill: alpha(PAPER, 0.75) }));
    if (index === MONTHLY_CELL) {
      const m = prog(l, 12, 10);
      const ripple = prog(l, 12, 20);
      markers.push(
        h("circle", { key: "monthly-ripple", cx: x + c, cy: y + c, r: lerp(34, 92, E.outCubic(ripple)), fill: "none", stroke: SHU, strokeWidth: 3, opacity: m > 0 ? 1 - ripple : 0 }),
        h("circle", { key: "monthly", cx: x + c, cy: y + c, r: 34 * E.outBack(m), fill: SHU })
      );
    }
    const live = LIVE_CELLS.indexOf(index);
    if (live >= 0) {
      const p2 = E.outBack(prog(l, 27 + live * 2, 10));
      markers.push(h(Shape, { key: `live-${index}`, kind: "triangle", R: 30 * p2, cx: x + c, cy: y + c + 5, rot: (1 - p2) * Math.PI, fill: AI_LIGHT }));
    }
  }
  const scrub = E.inOutCubic(prog(l, 57, 46));
  const seconds = Math.round(scrub * 6960);
  const clock = `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const barWidth = CAL.cols * CAL.cell + (CAL.cols - 1) * CAL.gap;
  return h(
    "div",
    { style: { position: "absolute", inset: 0 } },
    h(Bg, { color: INK }),
    h(Grid, { color: PAPER, opacity: 0.04 }),
    h(Abs, { x: 150, y: 164 }, h(Rise, { text: "HOW A MONTH FEELS", f: l, at: -6, stagger: 0.5, duration: 10, style: { fontFamily: EN, fontWeight: 700, fontSize: 25, letterSpacing: "0.32em", color: SHU } })),
    h(Abs, { x: 144, y: 206 }, h(Rise, { text: "月の過ごし方", f: l, at: -4, stagger: 2, style: { fontFamily: JP, fontWeight: 900, fontSize: 118, letterSpacing: "-0.03em", lineHeight: 1, color: PAPER } })),
    MONTH_ITEMS.map((item, index) => {
      const p = E.outExpo(prog(l, item.at, 12));
      return h(
        "div",
        {
          key: item.tag,
          style: {
            position: "absolute",
            left: 150,
            top: 418 + index * 120,
            display: "flex",
            alignItems: "flex-start",
            gap: 26,
            opacity: p,
            transform: `translateX(${(1 - p) * -60}px)`
          }
        },
        h("svg", { width: 54, height: 54, viewBox: "0 0 54 54", style: { marginTop: 6 } }, monthIcon(item)),
        h(
          "div",
          null,
          h(
            "div",
            { style: { display: "flex", alignItems: "baseline", gap: 18 } },
            h("span", { style: { fontFamily: MONO, fontWeight: 700, fontSize: 20, letterSpacing: "0.16em", color: item.color === PAPER ? alpha(PAPER, 0.6) : item.color, width: 130 } }, item.tag),
            h("span", { style: { fontFamily: JP, fontWeight: 900, fontSize: 46, lineHeight: 1, color: PAPER } }, item.title)
          ),
          h("div", { style: { marginTop: 12, marginLeft: 148, fontFamily: JP, fontWeight: 500, fontSize: 27, color: alpha(PAPER, 0.62) } }, item.sub)
        )
      );
    }),
    h(
      Abs,
      { x: CAL.x, y: CAL.y - 42, style: { width: barWidth, display: "flex", fontFamily: MONO, fontWeight: 500, fontSize: 17, letterSpacing: "0.1em", color: alpha(PAPER, 0.38), opacity: prog(l, -4, 10) } },
      ["S", "M", "T", "W", "T", "F", "S"].map((day, index) => h("span", { key: index, style: { width: CAL.cell + CAL.gap } }, day))
    ),
    h(
      Stage,
      null,
      cells,
      markers,
      h("rect", { x: CAL.x, y: 832, width: barWidth, height: 4, fill: alpha(PAPER, 0.18), opacity: prog(l, 55, 6) }),
      h("rect", { x: CAL.x, y: 832, width: barWidth * scrub, height: 4, fill: PAPER }),
      l >= 57 && h("circle", { cx: CAL.x + barWidth * scrub, cy: 834, r: 11 * E.outBack(prog(l, 57, 8)), fill: SHU })
    ),
    h(
      Abs,
      { x: CAL.x, y: 858, style: { width: barWidth, display: "flex", justifyContent: "space-between", fontFamily: MONO, fontWeight: 500, fontSize: 20, letterSpacing: "0.14em", color: alpha(PAPER, 0.7), opacity: prog(l, 57, 6) } },
      h("span", null, "▶ ARCHIVE"),
      h("span", null, clock)
    )
  );
}

function monthIcon(item) {
  if (item.icon === "circle") return h("circle", { cx: 27, cy: 27, r: 20, fill: item.color });
  if (item.icon === "triangle") return h(Shape, { kind: "triangle", R: 19, cx: 27, cy: 30, fill: item.color });
  if (item.icon === "play") return h(Shape, { kind: "triangle", R: 18, cx: 25, cy: 27, rot: Math.PI / 2, fill: "none", stroke: item.color, strokeWidth: 3 });
  return h(
    "g",
    null,
    [0, 1, 2].map((i) => h("circle", { key: i, cx: 9 + i * 18, cy: 27, r: 6, fill: item.color }))
  );
}

// ---------------------------------------------------------------- 06 omachi

const NEAR_RIDGE = [
  [-40, 880], [120, 828], [220, 796], [300, 808], [380, 752], [470, 772], [560, 702], [640, 728], [720, 664],
  [800, 700], [880, 650], [960, 706], [1040, 616], [1110, 562], [1160, 604], [1212, 548], [1272, 612], [1340, 664],
  [1420, 634], [1500, 684], [1580, 652], [1680, 722], [1780, 700], [1960, 770]
];
const FAR_RIDGE = [
  [-40, 770], [200, 712], [400, 734], [600, 650], [800, 672], [1000, 606], [1200, 650], [1400, 590], [1600, 630], [1800, 604], [1960, 650]
];
const SEASONS = [
  { char: "春", color: "#e7a1b6" },
  { char: "夏", color: "#3f9a5f" },
  { char: "秋", color: SHU },
  { char: "冬", color: "#5f7fa8" }
];

function ridgePath(points, closed) {
  const d = points.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x} ${y}`).join(" ");
  return closed ? `${d} L 1960 1140 L -40 1140 Z` : d;
}

function ridgeLength(points) {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return length;
}

const NEAR_LENGTH = ridgeLength(NEAR_RIDGE);

function SceneOmachi({ f }) {
  const l = f - 660;
  const draw = E.outCubic(prog(l, -6, 30));
  const fill = prog(l, 4, 22);
  const sunY = lerp(800, 420, E.outCubic(prog(l, 0, 34)));
  let active = -1;
  [30, 45, 60, 75].forEach((at, index) => {
    if (l >= at) active = index;
  });
  return h(
    "div",
    { style: { position: "absolute", inset: 0 } },
    h(Bg, { color: PAPER }),
    h(Grid, { color: INK, opacity: 0.05 }),
    h(
      Stage,
      null,
      h("defs", null, h("linearGradient", { id: "kobo-ridge", x1: 0, y1: 0, x2: 0, y2: 1 }, h("stop", { offset: "0%", stopColor: AI }), h("stop", { offset: "100%", stopColor: "#16255e" }))),
      h("circle", { cx: 1500, cy: sunY, r: 122, fill: SHU }),
      h("path", { d: ridgePath(FAR_RIDGE, true), fill: AI, opacity: 0.26 * fill }),
      h("path", { d: ridgePath(NEAR_RIDGE, true), fill: "url(#kobo-ridge)", opacity: fill }),
      h("path", { d: ridgePath(NEAR_RIDGE, false), fill: "none", stroke: INK, strokeWidth: 4, strokeLinejoin: "round", strokeDasharray: NEAR_LENGTH, strokeDashoffset: NEAR_LENGTH * (1 - draw) })
    ),
    h(
      Abs,
      { x: 150, y: 160, style: { display: "flex", alignItems: "baseline", gap: 16 } },
      h(Rise, { text: "NATURE VIBE CODING", f: l, at: 0, stagger: 0.5, duration: 10, style: { fontFamily: EN, fontWeight: 700, fontSize: 25, letterSpacing: "0.32em", color: SHU } }),
      h(Rise, { text: "／ 四季に一度", f: l, at: 6, stagger: 0.8, duration: 10, style: { fontFamily: JP, fontWeight: 700, fontSize: 27, color: alpha(INK, 0.7) } })
    ),
    h(Abs, { x: 142, y: 214 }, h(Rise, { text: "長野県大町から。", f: l, at: 3, stagger: 2, duration: 16, style: { fontFamily: SERIF, fontWeight: 800, fontSize: 134, letterSpacing: "-0.02em", lineHeight: 1, color: INK } })),
    h(Abs, { x: 150, y: 398 }, h(Rise, { text: "ときどき、画面の外へ。", f: l, at: 13, stagger: 1, style: { fontFamily: JP, fontWeight: 700, fontSize: 58, lineHeight: 1, color: alpha(INK, 0.86) } })),
    h(
      Abs,
      { x: 150, y: 506, style: { display: "flex", gap: 14 } },
      SEASONS.map((season, index) => {
        const p = E.outBack(prog(l, 18 + index * 2, 10));
        const on = index === active;
        const hit = on ? Math.exp(-(l - [30, 45, 60, 75][index]) / 4) : 0;
        return h(
          "div",
          {
            key: season.char,
            style: {
              width: 92,
              height: 92,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: SERIF,
              fontWeight: 800,
              fontSize: 58,
              lineHeight: 1,
              border: `2px solid ${on ? season.color : alpha(INK, 0.22)}`,
              background: on ? season.color : "transparent",
              color: on ? PAPER : alpha(INK, 0.55),
              opacity: clamp01(p * 2),
              transform: `scale(${(lerp(0.6, 1, p) * (1 + 0.12 * hit)).toFixed(3)})`
            }
          },
          season.char
        );
      })
    )
  );
}

// ---------------------------------------------------------------- 07 price

function ScenePrice({ f, copy }) {
  const l = f - 750;
  const punch = 1 + 0.07 * (1 - E.outExpo(prog(l, 0, 10)));
  const cols = 6;
  const total = copy.seats_total;
  const seats = [];
  for (let index = 0; index < total; index += 1) {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const cx = 1270 + col * 84;
    const cy = 330 + row * 84;
    const ring = E.outBack(prog(l, 4 + index * 0.45, 8));
    const taken = index < copy.seats_taken;
    const fill = taken ? E.outBack(prog(l, 14 + index * 1.05, 6)) : 0;
    const blink = !taken && l > 40 ? 0.55 + 0.45 * Math.cos((l - 40) / 3 + index) : 1;
    seats.push(
      h("circle", { key: `ring-${index}`, cx, cy, r: 30 * ring, fill: "none", stroke: PAPER, strokeWidth: 4, opacity: blink }),
      fill > 0 && h("circle", { key: `fill-${index}`, cx, cy, r: 32 * fill, fill: INK })
    );
  }
  const stamp = prog(l, 44, 7);
  return h(
    "div",
    { style: { position: "absolute", inset: 0, transform: `scale(${punch})`, transformOrigin: `${CX}px ${CY}px` } },
    h(Bg, { color: SHU }),
    h(Grid, { color: INK, opacity: 0.07 }),
    h(
      Abs,
      { x: 150, y: 146, style: { display: "flex", alignItems: "baseline", gap: 18 } },
      h(Rise, { text: "FOUNDING MEMBERS", f: l, at: 0, stagger: 0.5, duration: 10, style: { fontFamily: EN, fontWeight: 700, fontSize: 25, letterSpacing: "0.32em", color: PAPER } }),
      h(Rise, { text: "／ 創設メンバー募集中", f: l, at: 4, stagger: 0.8, duration: 10, style: { fontFamily: JP, fontWeight: 900, fontSize: 30, color: INK } })
    ),
    h(Abs, { x: 156, y: 268 }, h(Rise, { text: "月額", f: l, at: 2, stagger: 2, style: { fontFamily: JP, fontWeight: 900, fontSize: 66, lineHeight: 1, color: PAPER } })),
    h(
      Abs,
      { x: 140, y: 330, style: { display: "flex", alignItems: "flex-end" } },
      h(RollingNumber, { text: copy.price, f: l, at: 2, size: 392 }),
      h("span", { style: { fontFamily: JP, fontWeight: 900, fontSize: 124, lineHeight: 1, color: PAPER, marginLeft: 12, marginBottom: 24, opacity: prog(l, 10, 6) } }, "円")
    ),
    h(
      Abs,
      { x: 156, y: 772, style: { fontFamily: JP, fontWeight: 700, fontSize: 46, lineHeight: 1, color: alpha(PAPER, 0.9), opacity: prog(l, 20, 6) } },
      h(
        "span",
        { style: { position: "relative", display: "inline-block" } },
        `通常 ${copy.regular_price}円`,
        h("span", { style: { position: "absolute", left: -8, right: -8, top: "52%", height: 6, background: INK, transform: `scaleX(${E.outExpo(prog(l, 24, 8))})`, transformOrigin: "left" } })
      )
    ),
    h(Abs, { x: 156, y: 852 }, h(Rise, { text: "継続中は、据え置き。", f: l, at: 30, stagger: 1, style: { fontFamily: JP, fontWeight: 900, fontSize: 54, lineHeight: 1, color: INK } })),
    h(
      Abs,
      { x: 1240, y: 206, style: { display: "flex", alignItems: "center", gap: 22, opacity: prog(l, 6, 8) } },
      h("span", { style: { fontFamily: JP, fontWeight: 900, fontSize: 40, color: PAPER } }, "創設の席"),
      h("span", { style: { fontFamily: DISPLAY, fontSize: 64, lineHeight: 1, color: PAPER } }, String(copy.seats_total)),
      h(
        "span",
        {
          style: {
            fontFamily: JP,
            fontWeight: 900,
            fontSize: 30,
            color: PAPER,
            background: INK,
            padding: "8px 18px 10px",
            opacity: prog(l, 38, 4),
            transform: `scale(${lerp(0.6, 1, E.outBack(prog(l, 38, 8)))})`
          }
        },
        copy.seats_note
      )
    ),
    h(Stage, null, seats),
    stamp > 0 &&
      h(
        "div",
        {
          style: {
            position: "absolute",
            left: 1236,
            top: 790,
            display: "flex",
            alignItems: "center",
            gap: 22,
            padding: "18px 34px 20px",
            background: INK,
            color: PAPER,
            opacity: clamp01(stamp * 3),
            transform: `rotate(-5deg) scale(${lerp(2.3, 1, E.outExpo(stamp))})`,
            transformOrigin: "center",
            boxShadow: "0 18px 50px rgba(0,0,0,.25)"
          }
        },
        h("span", { style: { fontFamily: DISPLAY, fontSize: 108, lineHeight: 1 } }, copy.deadline),
        h("span", { style: { fontFamily: JP, fontWeight: 900, fontSize: 56, lineHeight: 1 } }, "一旦締切")
      )
  );
}

function RollingNumber({ text, f, at, size }) {
  const lineHeight = size * 1.02;
  let digitIndex = 0;
  return h(
    "div",
    { style: { display: "flex", fontFamily: DISPLAY, fontSize: size, lineHeight: `${lineHeight}px`, color: PAPER } },
    Array.from(text).map((char, index) => {
      if (!/[0-9]/.test(char)) {
        return h("span", { key: index, style: { opacity: prog(f, at + 6, 4) } }, char);
      }
      const target = Number(char);
      const p = E.outExpo(prog(f, at + digitIndex * 2.4, 20));
      digitIndex += 1;
      const position = lerp(0, 10 + target, p);
      return h(
        "span",
        { key: index, style: { display: "inline-block", height: lineHeight, overflow: "hidden" } },
        h(
          "span",
          { style: { display: "flex", flexDirection: "column", transform: `translateY(${(-position * lineHeight).toFixed(1)}px)` } },
          Array.from({ length: 20 }, (_, n) => h("span", { key: n, style: { height: lineHeight } }, String(n % 10)))
        )
      );
    })
  );
}

// ---------------------------------------------------------------- 07 lockup

function SceneLockup({ f, copy }) {
  const l = f - 825;
  const typed = Math.floor(copy.url.length * prog(l, 16, 20));
  const caret = l < 46 && Math.floor(l / 8) % 2 === 0;
  const button = E.outBack(prog(l, 32, 10));
  const click = prog(l, 54, 8);
  const cursor = E.inOutCubic(prog(l, 40, 13));
  const cursorX = lerp(1640, 1268, cursor);
  const cursorY = lerp(980, 752, cursor);
  const marks = [
    { kind: "circle", color: SHU, x: 846, from: [-260, 300] },
    { kind: "triangle", color: AI, x: 960, from: [960, -240] },
    { kind: "square", color: INK, x: 1074, from: [2180, 300] }
  ];
  return h(
    "div",
    { style: { position: "absolute", inset: 0 } },
    h(Bg, { color: PAPER }),
    h(Grid, { color: INK, opacity: 0.05 }),
    h(
      Stage,
      null,
      marks.map((mark, index) => {
        const p = E.outBack(prog(l, -4 + index * 2.5, 14));
        return h(Shape, {
          key: mark.kind,
          kind: mark.kind,
          R: 44,
          cx: lerp(mark.from[0], mark.x, p),
          cy: lerp(mark.from[1], 300, p) + (mark.kind === "triangle" ? 7 : 0),
          rot: (1 - p) * Math.PI * 1.5,
          fill: mark.color
        });
      })
    ),
    h("div", { style: { position: "absolute", left: 0, right: 0, top: 388, textAlign: "center" } }, h(Rise, { text: "AIエージェント創作開発ラボ", f: l, at: 3, stagger: 0.8, style: { fontFamily: SERIF, fontWeight: 800, fontSize: 58, lineHeight: 1, color: INK } })),
    h(
      "div",
      { style: { position: "absolute", left: 0, right: 0, top: 466, textAlign: "center" } },
      h(Rise, {
        text: "オンライン工房",
        f: l,
        at: 7,
        stagger: 2,
        duration: 16,
        style: { fontFamily: JP, fontWeight: 900, fontSize: 178, letterSpacing: "-0.04em", lineHeight: 1, color: INK },
        charStyle: (char) => (char === "工" || char === "房" ? { color: SHU } : undefined)
      })
    ),
    h(
      "div",
      {
        style: {
          position: "absolute",
          left: 530,
          top: 704,
          width: 860,
          height: 96,
          borderRadius: 48,
          border: `3px solid ${INK}`,
          background: PAPER,
          display: "flex",
          alignItems: "center",
          paddingLeft: 44,
          boxSizing: "border-box",
          opacity: prog(l, 12, 6),
          transform: `scaleX(${lerp(0.4, 1, E.outExpo(prog(l, 12, 12)))})`
        }
      },
      h("span", { style: { fontFamily: EN, fontWeight: 500, fontSize: 42, color: INK, letterSpacing: "0.01em", whiteSpace: "pre" } }, copy.url.slice(0, typed)),
      h("span", { style: { width: 4, height: 46, background: SHU, marginLeft: 4, opacity: caret ? 1 : 0 } }),
      h(
        "div",
        {
          style: {
            position: "absolute",
            right: 9,
            top: 9,
            height: 72,
            padding: "0 34px 0 38px",
            borderRadius: 36,
            background: SHU,
            color: PAPER,
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontFamily: JP,
            fontWeight: 900,
            fontSize: 34,
            transform: `scale(${(button * (1 - 0.08 * Math.sin(Math.PI * click))).toFixed(3)})`
          }
        },
        "申し込む",
        h("span", { style: { fontFamily: EN, fontWeight: 700 } }, "→")
      )
    ),
    l >= 54 && h(Stage, null, h("circle", { cx: 1268, cy: 752, r: lerp(20, 120, E.outCubic(click)), fill: "none", stroke: SHU, strokeWidth: 4, opacity: 1 - click })),
    l >= 38 &&
      h(
        Stage,
        null,
        h("path", {
          d: "M 0 0 L 0 46 L 12 35 L 21 56 L 30 52 L 21 32 L 37 31 Z",
          transform: `translate(${cursorX} ${cursorY}) scale(${1 - 0.1 * Math.sin(Math.PI * click)})`,
          fill: INK,
          stroke: PAPER,
          strokeWidth: 3,
          strokeLinejoin: "round",
          opacity: prog(l, 38, 4)
        })
      ),
    h(
      "div",
      { style: { position: "absolute", left: 0, right: 0, top: 846, textAlign: "center" } },
      h(Rise, { text: `創設メンバー受付中｜${copy.deadline} 一旦締切`, f: l, at: 24, stagger: 0.6, style: { fontFamily: JP, fontWeight: 700, fontSize: 32, lineHeight: 1, color: alpha(INK, 0.78) } })
    ),
    h(
      "div",
      { style: { position: "absolute", left: 0, right: 0, top: 970, display: "flex", justifyContent: "center", alignItems: "baseline", gap: 20, opacity: prog(l, 30, 10) } },
      h("span", { style: { fontFamily: SERIF, fontWeight: 800, fontSize: 28, color: INK } }, "安曇むすひ"),
      h("span", { style: { fontFamily: EN, fontWeight: 700, fontSize: 17, letterSpacing: "0.34em", color: MUTED } }, "AZUMI MUSUHI")
    )
  );
}

// ---------------------------------------------------------------- overlays

// Nominal scene boundaries in design frames; transitions overlap these by a few frames.
export const KOBO_SCENES = Object.freeze([
  { id: "s01-signal", start: 0, end: 120, hud: "01 / 07 — SIGNAL" },
  { id: "s02-manifesto", start: 120, end: 240, hud: "02 / 07 — MANIFESTO" },
  { id: "s03-online-kobo", start: 240, end: 360, hud: "03 / 07 — ONLINE KOBO" },
  { id: "s04-seats", start: 360, end: 555, hud: "04 / 07 — SEATS" },
  { id: "s05-month", start: 555, end: 660, hud: "05 / 07 — MONTH" },
  { id: "s06-omachi", start: 660, end: 750, hud: "06 / 07 — 36.50°N 137.85°E" },
  { id: "s07-price", start: 750, end: 825, hud: "07 / 07 — JOIN" },
  { id: "s08-lockup", start: 825, end: 900, hud: "07 / 07 — JOIN" }
]);
const DARK_RANGES = [
  [0, 120],
  [234, 362],
  [405, 495],
  [549, 822]
];

function Hud({ f }) {
  const dark = DARK_RANGES.some(([a, b]) => f >= a && f < b);
  const color = dark ? alpha(PAPER, 0.62) : alpha(INK, 0.55);
  const section = [...KOBO_SCENES].reverse().find((entry) => f >= entry.start) ?? KOBO_SCENES[0];
  const whole = Math.floor(f);
  const tc = `00:${String(Math.floor(whole / 30)).padStart(2, "0")}:${String(whole % 30).padStart(2, "0")}`;
  const marks = [
    [56, 56, 1, 1],
    [W - 56, 56, -1, 1],
    [56, H - 56, 1, -1],
    [W - 56, H - 56, -1, -1]
  ];
  const show = prog(f, 2, 8);
  return h(
    "div",
    { style: { position: "absolute", inset: 0, pointerEvents: "none", opacity: show } },
    h(
      Stage,
      null,
      marks.map(([x, y, sx, sy], index) => h("path", { key: index, d: `M ${x} ${y + sy * 26} L ${x} ${y} L ${x + sx * 26} ${y}`, fill: "none", stroke: color, strokeWidth: 2 }))
    ),
    h(Abs, { x: 88, y: H - 78, style: { fontFamily: MONO, fontWeight: 500, fontSize: 17, letterSpacing: "0.16em", color } }, `KOBO ▸ ${tc}`),
    h(Abs, { x: W - 688, y: H - 78, style: { width: 600, textAlign: "right", fontFamily: MONO, fontWeight: 500, fontSize: 17, letterSpacing: "0.16em", color } }, section.hud)
  );
}

function Finish({ f }) {
  const seed = Math.floor(f / 2) % 9;
  return h(
    React.Fragment,
    null,
    h("div", { style: { position: "absolute", inset: 0, pointerEvents: "none", background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 58%, rgba(0,0,0,.14) 100%)" } }),
    h(
      "svg",
      { width: W, height: H, style: { position: "absolute", left: 0, top: 0, pointerEvents: "none", mixBlendMode: "overlay", opacity: 0.2 } },
      h(
        "filter",
        { id: "kobo-grain", x: 0, y: 0, width: "100%", height: "100%" },
        h("feTurbulence", { type: "fractalNoise", baseFrequency: 0.9, numOctaves: 2, seed, stitchTiles: "stitch" }),
        h("feColorMatrix", { type: "saturate", values: 0 })
      ),
      h("rect", { width: W, height: H, filter: "url(#kobo-grain)" })
    )
  );
}
