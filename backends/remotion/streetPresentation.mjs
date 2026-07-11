export const STREET_DIALOGUE_PRESET = "street-dialogue-16x9";

export const STREET_THEME = {
  paper: "#f6efe3",
  ink: "#26222b",
  cream: "#fffaf1",
  accentLeft: "#ff8a3d",
  accentRight: "#3ec6b8",
  lilac: "#c9b8f4",
  lemon: "#ffd95e",
  alert: "#e5484d"
};

const IDLE_AMPLITUDE_PX = 6;
const IDLE_CYCLES_PER_SECOND = 0.6;
const BOUNCE_AMPLITUDE_PX = 26;
const BOUNCE_DECAY_PER_SECOND = 5;
const BOUNCE_CYCLES_PER_SECOND = 2.2;
const POP_DURATION_SECONDS = 0.35;
const POP_OVERSHOOT = 1.70158;

export function idleBob(frame, fps, phase = 0) {
  const second = frame / fps;
  return Math.sin(second * 2 * Math.PI * IDLE_CYCLES_PER_SECOND + phase) * IDLE_AMPLITUDE_PX;
}

export function activeBounce(localFrame, fps) {
  const second = Math.max(0, localFrame) / fps;
  return (
    Math.exp(-BOUNCE_DECAY_PER_SECOND * second) *
    Math.cos(second * 2 * Math.PI * BOUNCE_CYCLES_PER_SECOND) *
    BOUNCE_AMPLITUDE_PX
  );
}

export function popIn(localFrame, fps, durationSeconds = POP_DURATION_SECONDS) {
  const progress = Math.max(0, localFrame) / fps / durationSeconds;
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  const settled = progress - 1;
  return 1 + (POP_OVERSHOOT + 1) * settled * settled * settled + POP_OVERSHOOT * settled * settled;
}

export function stickyVisualAt(captions, second) {
  let visual;
  for (const caption of captions ?? []) {
    if (caption.start > second) break;
    if (caption.visual) visual = caption.visual;
  }
  return visual;
}

export function chapterAt(chapters, second) {
  return (chapters ?? []).find((chapter) => second >= chapter.start && second < chapter.end);
}

export function centerAt(captions, second) {
  const caption = activeCenterCaption(captions, second);
  return caption?.center;
}

function activeCenterCaption(captions, second) {
  return (captions ?? []).find((caption) => second >= caption.start && second < caption.end);
}

export const MOUTH_LEVEL_RATE = 20;

const MOUTH_OPEN_THRESHOLD = 0.5;
const MOUTH_HALF_THRESHOLD = 0.15;

// Reads the per-caption amplitude envelope (mouth_levels sampled at
// mouth_rate Hz from the narration audio). Returns undefined when the
// caption has no envelope so callers can fall back to timed cycling.
export function mouthLevelAt(caption, second) {
  const levels = caption?.mouth_levels;
  if (!levels || levels.length === 0) return undefined;
  const rate = caption.mouth_rate ?? MOUTH_LEVEL_RATE;
  const index = Math.floor((second - caption.start) * rate);
  if (index < 0 || index >= levels.length) return 0;
  return levels[index];
}

// Quantizes a normalized RMS envelope (0..1) into closed/half/open levels
// and removes single-sample closures that would read as flicker.
export function quantizeMouthLevels(rms) {
  const levels = rms.map((value) =>
    value >= MOUTH_OPEN_THRESHOLD ? 2 : value >= MOUTH_HALF_THRESHOLD ? 1 : 0
  );
  return levels.map((level, index) => {
    const previous = levels[index - 1] ?? 0;
    const next = levels[index + 1] ?? 0;
    if (level === 0 && previous > 0 && next > 0) return 1;
    return level;
  });
}

const SWAP_WINDOW_START = 0.42;
const SWAP_WINDOW_LENGTH = 0.16;

export function swapPhase(progress, from, to) {
  const flip = Math.min(1, Math.max(0, (progress - SWAP_WINDOW_START) / SWAP_WINDOW_LENGTH));
  return {
    label: flip < 0.5 ? from : to,
    scaleX: Math.abs(1 - 2 * flip)
  };
}
